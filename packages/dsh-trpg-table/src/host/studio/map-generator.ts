/**
 * M9.5e 地图/世界结构生成 + 校验（host 作者侧，docs/RULES-MODEL §3「战斗地图与世界地图生成」）。
 *
 * 管线固定为：**AI 文本草稿 → 程序校验 → 失败重试 ≤2 → 程序化兜底**。
 * 结构数据（`cols/rows/terrain/obstacles/spawns` 与 world 的热点/连线）是唯一权威，底图只是皮肤；
 * 因此本模块**不导出任何"先画再看"的产物**：所有结构在返回前都过了 `validateBattleStructure`
 * / `validateWorldStructure` 硬闸。
 *
 * 离线/无 AI 模式：`textGenerator` 缺省时直接走程序化生成；程序化生成用
 * `sha256(prompt + seed + 尺寸)` 驱动自带的 xorshift PRNG，**同一 prompt + 同 seed 结构逐字节一致**
 * （不读时钟、不用 Math.random）。程序化战棋图保证：外圈全墙、房间+走廊连通、出生点可站立且
 * 玩家出生点到每个敌方出生点 BFS 可达、障碍不堵死通路。
 */
import { createHash } from 'node:crypto';
import {
  BATTLE_SPAWN_SIDES,
  BATTLE_STRUCTURE_LIMITS,
  BATTLE_TERRAIN_CHARS,
  BATTLE_TERRAIN_LEGEND,
  WORLD_STRUCTURE_LIMITS,
  isWorldZoneId,
  type BattleSpawnSide,
  type BattleStructure,
  type BattleStructureObstacle,
  type BattleStructureSpawn,
  type MapGenerateMethod,
  type MapGenerateStyle,
  type WorldGenerateStyle,
  type WorldStructure,
  type WorldZoneConnection,
  type WorldZoneHotspot,
  type WorldZoneStructure,
} from '@dsh-trpg/protocol';

// ---------------------------------------------------------------------------
// 注入点与结果类型
// ---------------------------------------------------------------------------

/** AI 文本草稿请求（`kind` 决定提示词模板；`attempt` 用于把上一轮错误反馈回去）。 */
export interface StudioTextRequest {
  kind: 'battle-map' | 'world-map';
  system: string;
  prompt: string;
  attempt: number;
}

/** 可注入的文本生成器（生产 = OpenAI 兼容 chat/completions；单测 = mock；未配置 = undefined）。 */
export type StudioTextGenerator = (request: StudioTextRequest) => string | Promise<string>;

export interface BattleDraftInput {
  prompt: string;
  style: MapGenerateStyle;
  cols?: number;
  rows?: number;
  partySize?: number;
  seed?: number;
}

export interface WorldDraftInput {
  prompt: string;
  zoneCount?: number;
  style?: WorldGenerateStyle;
  seed?: number;
}

export interface BattleGenerationOutcome {
  structure: BattleStructure;
  warnings: string[];
  method: MapGenerateMethod;
  /** 实际调用了 AI 几次（0 = 未配置文本模型，直接程序化）。 */
  attempts: number;
}

export interface WorldGenerationOutcome {
  world: WorldStructure;
  warnings: string[];
  method: MapGenerateMethod;
  attempts: number;
}

export interface StructureValidationReport<T> {
  ok: boolean;
  errors: string[];
  warnings: string[];
  value?: T;
}

/** AI 草稿解析结果（解析失败给中文原因，交给重试循环反馈给模型）。 */
export interface DraftParseResult<T> {
  value?: T;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 确定性 PRNG（sha256 派生；同输入同输出）
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** xorshift32：由 sha256 前 8 字节播种（零状态换固定非零常量）。 */
export class SeededRng {
  private state: number;

  constructor(seedHex: string) {
    const parsed = Number.parseInt(seedHex.slice(0, 8), 16);
    this.state = Number.isFinite(parsed) && parsed !== 0 ? parsed >>> 0 : 0x9e3779b9;
  }

  /** 下一个 32 位无符号整数。 */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  /** 闭区间整数 [min, max]。 */
  nextInt(min: number, max: number): number {
    const span = Math.max(0, max - min + 1);
    return min + (this.next() % span);
  }

  /** [0, 1) 浮点。 */
  nextFloat(): number {
    return this.next() / 0x100000000;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const target = this.nextInt(0, index);
      const temporary = copy[index] as T;
      copy[index] = copy[target] as T;
      copy[target] = temporary;
    }
    return copy;
  }
}

function clampInteger(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.min(max, Math.max(min, rounded));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 地形：可站立 / 阻挡判定（校验器与生成器共用同一份口径）
// ---------------------------------------------------------------------------

/** 地形字符是否可通行；未知字符 = 不可通行（但校验器会先报"未知字符"错误）。 */
function terrainWalkable(char: string): boolean {
  const spec = BATTLE_TERRAIN_LEGEND[char];
  return spec !== undefined && spec.walkable;
}

/** 障碍矩形覆盖的格子里是否有阻挡地形（obstacles 覆盖 terrain 的优先级与 RULES-MODEL §3 一致）。 */
function obstacleBlocksAt(obstacles: readonly BattleStructureObstacle[], x: number, y: number): boolean {
  for (const obstacle of obstacles) {
    if (x < obstacle.x || y < obstacle.y || x >= obstacle.x + obstacle.w || y >= obstacle.y + obstacle.h) continue;
    if (obstacle.terrain !== undefined && !terrainWalkable(obstacle.terrain)) return true;
  }
  return false;
}

/** 格子是否可站立（地形可通行且没被阻挡型障碍覆盖）。 */
function cellStandable(structure: Pick<BattleStructure, 'terrain' | 'obstacles'>, x: number, y: number): boolean {
  const row = structure.terrain[y];
  const char = row?.[x];
  if (char === undefined || !terrainWalkable(char)) return false;
  return !obstacleBlocksAt(structure.obstacles, x, y);
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 从起点出发四方向 BFS，返回可达格集合（`x,y` → true）。 */
function bfsReachable(
  structure: Pick<BattleStructure, 'cols' | 'rows' | 'terrain' | 'obstacles'>,
  start: { x: number; y: number },
): Set<string> {
  const reachable = new Set<string>();
  if (!cellStandable(structure, start.x, start.y)) return reachable;
  const queue: Array<{ x: number; y: number }> = [start];
  reachable.add(`${start.x},${start.y}`);
  while (queue.length > 0) {
    const current = queue.shift() as { x: number; y: number };
    for (const [dx, dy] of NEIGHBORS) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < 0 || y < 0 || x >= structure.cols || y >= structure.rows) continue;
      const key = `${x},${y}`;
      if (reachable.has(key)) continue;
      if (!cellStandable(structure, x, y)) continue;
      reachable.add(key);
      queue.push({ x, y });
    }
  }
  return reachable;
}

// ---------------------------------------------------------------------------
// 战棋结构校验器（RULES-MODEL §3「校验器」表逐条落地）
// ---------------------------------------------------------------------------

function isIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function readSpawnSide(value: unknown): BattleSpawnSide | undefined {
  return typeof value === 'string' && (BATTLE_SPAWN_SIDES as readonly string[]).includes(value)
    ? (value as BattleSpawnSide)
    : undefined;
}

/**
 * 战棋结构硬校验：尺寸/行宽/地形字符/障碍与出生点越界重叠/出生点可站立/玩家→敌方 BFS 可达。
 * 任一硬约束失败即 `ok:false`（AI 草稿据此重生成）；软约束进 warnings（不阻断）。
 */
export function validateBattleStructure(input: unknown): StructureValidationReport<BattleStructure> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string): void => {
    errors.push(message);
  };

  if (!isRecord(input)) return { ok: false, errors: ['战棋结构必须是对象'], warnings };
  const cols = input.cols;
  const rows = input.rows;
  if (!isIntegerValue(cols) || cols < 1 || cols > BATTLE_STRUCTURE_LIMITS.maxCols) {
    fail(`cols 必须是 1–${BATTLE_STRUCTURE_LIMITS.maxCols} 的整数，收到 ${JSON.stringify(cols)}`);
  }
  if (!isIntegerValue(rows) || rows < 1 || rows > BATTLE_STRUCTURE_LIMITS.maxRows) {
    fail(`rows 必须是 1–${BATTLE_STRUCTURE_LIMITS.maxRows} 的整数，收到 ${JSON.stringify(rows)}`);
  }
  const rawTerrain = input.terrain;
  if (!Array.isArray(rawTerrain)) {
    fail('terrain 必须是二维字符矩阵（rows × cols）');
  }
  if (errors.length > 0 || !Array.isArray(rawTerrain) || typeof cols !== 'number' || typeof rows !== 'number') {
    return { ok: false, errors, warnings };
  }
  if (rawTerrain.length !== rows) {
    fail(`terrain 行数必须等于 rows：期望 ${rows} 行，实际 ${rawTerrain.length} 行`);
  }
  const terrain: string[][] = [];
  const allowed = new Set(BATTLE_TERRAIN_CHARS);
  for (let y = 0; y < Math.min(rows, rawTerrain.length); y += 1) {
    const rawRow = rawTerrain[y];
    if (!Array.isArray(rawRow)) {
      fail(`terrain[${y}] 必须是字符数组`);
      terrain.push([]);
      continue;
    }
    if (rawRow.length !== cols) {
      fail(`terrain[${y}] 行宽必须等于 cols：期望 ${cols} 列，实际 ${rawRow.length} 列`);
    }
    const row: string[] = [];
    for (let x = 0; x < rawRow.length; x += 1) {
      const cell = rawRow[x];
      if (typeof cell !== 'string' || cell.length !== 1 || !allowed.has(cell)) {
        fail(
          `terrain[${y}][${x}] 地形字符非法：${JSON.stringify(cell)}（合法字符：${BATTLE_TERRAIN_CHARS.join(' ')}）`,
        );
        row.push('w');
        continue;
      }
      row.push(cell);
    }
    terrain.push(row);
  }
  // 补足到 rows 行，避免后续越界（错误已记录）
  while (terrain.length < rows) terrain.push(new Array<string>(cols).fill('w'));

  // ---- 障碍 ----
  const rawObstacles = input.obstacles;
  const obstacles: BattleStructureObstacle[] = [];
  if (rawObstacles !== undefined && !Array.isArray(rawObstacles)) {
    fail('obstacles 必须是数组');
  } else if (Array.isArray(rawObstacles)) {
    rawObstacles.forEach((raw, index) => {
      const path = `obstacles[${index}]`;
      if (!isRecord(raw)) {
        fail(`${path} 必须是对象`);
        return;
      }
      const x = raw.x;
      const y = raw.y;
      const w = raw.w;
      const h = raw.h;
      if (!isIntegerValue(x) || !isIntegerValue(y) || !isIntegerValue(w) || !isIntegerValue(h)) {
        fail(`${path} 的 x/y/w/h 必须是整数`);
        return;
      }
      if (w < 1 || h < 1) {
        fail(`${path} 的 w/h 必须 ≥ 1`);
        return;
      }
      if (x < 0 || y < 0 || x + w > cols || y + h > rows) {
        fail(`${path} 越界：矩形 (${x},${y}) ${w}×${h} 超出 ${cols}×${rows}`);
        return;
      }
      let terrainChar: string | undefined;
      if (raw.terrain !== undefined) {
        if (typeof raw.terrain !== 'string' || raw.terrain.length !== 1 || !allowed.has(raw.terrain)) {
          fail(`${path}.terrain 地形字符非法：${JSON.stringify(raw.terrain)}`);
          return;
        }
        terrainChar = raw.terrain;
      }
      if (raw.coverId !== undefined && (typeof raw.coverId !== 'string' || raw.coverId.length === 0 || raw.coverId.length > 64)) {
        fail(`${path}.coverId 必须是非空字符串（最多 64 字符）`);
        return;
      }
      obstacles.push({
        x,
        y,
        w,
        h,
        ...(terrainChar !== undefined ? { terrain: terrainChar } : {}),
        ...(typeof raw.coverId === 'string' ? { coverId: raw.coverId } : {}),
      });
    });
    for (let left = 0; left < obstacles.length; left += 1) {
      for (let right = left + 1; right < obstacles.length; right += 1) {
        const a = obstacles[left] as BattleStructureObstacle;
        const b = obstacles[right] as BattleStructureObstacle;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          warnings.push(`障碍矩形重叠（不阻断）：obstacles[${left}] 与 obstacles[${right}]`);
        }
      }
    }
  }

  // ---- 出生点 ----
  const rawSpawns = input.spawns;
  const spawns: BattleStructureSpawn[] = [];
  if (!Array.isArray(rawSpawns)) {
    fail('spawns 必须是数组（至少各 1 个 player/enemy 出生点）');
  } else {
    if (rawSpawns.length > BATTLE_STRUCTURE_LIMITS.maxSpawns) {
      fail(`单图出生点最多 ${BATTLE_STRUCTURE_LIMITS.maxSpawns} 个（当前 ${rawSpawns.length} 个）`);
    }
    rawSpawns.forEach((raw, index) => {
      const path = `spawns[${index}]`;
      if (!isRecord(raw)) {
        fail(`${path} 必须是对象`);
        return;
      }
      const x = raw.x;
      const y = raw.y;
      if (!isIntegerValue(x) || !isIntegerValue(y)) {
        fail(`${path} 的 x/y 必须是整数`);
        return;
      }
      if (x < 0 || y < 0 || x >= cols || y >= rows) {
        fail(`${path} 越界：(${x},${y}) 不在 ${cols}×${rows} 内`);
        return;
      }
      const side = readSpawnSide(raw.side);
      if (side === undefined) {
        fail(`${path}.side 必须是 ${BATTLE_SPAWN_SIDES.join(' / ')} 之一`);
        return;
      }
      if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label.length > 40)) {
        fail(`${path}.label 必须是字符串（最多 40 字符）`);
        return;
      }
      if (raw.monsterId !== undefined && (typeof raw.monsterId !== 'string' || raw.monsterId.length === 0 || raw.monsterId.length > 64)) {
        fail(`${path}.monsterId 必须是非空字符串（最多 64 字符）`);
        return;
      }
      spawns.push({
        x,
        y,
        side,
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        ...(typeof raw.monsterId === 'string' ? { monsterId: raw.monsterId } : {}),
      });
    });
    const seenCells = new Map<string, number>();
    spawns.forEach((spawn, index) => {
      const key = `${spawn.x},${spawn.y}`;
      const existing = seenCells.get(key);
      if (existing !== undefined) {
        fail(`出生点重叠：spawns[${index}] 与 spawns[${existing}] 都在 (${spawn.x},${spawn.y})`);
      } else {
        seenCells.set(key, index);
      }
      const structure = { cols, rows, terrain, obstacles };
      if (!cellStandable(structure, spawn.x, spawn.y)) {
        fail(
          `出生点不可站立：spawns[${index}] (${spawn.x},${spawn.y}) 所在格是 ${JSON.stringify(
            terrain[spawn.y]?.[spawn.x] ?? '?',
          )}（必须是可通行地形且没有被阻挡型障碍覆盖）`,
        );
      }
    });
    const playerSpawns = spawns.filter((spawn) => spawn.side === 'player');
    const enemySpawns = spawns.filter((spawn) => spawn.side === 'enemy');
    if (playerSpawns.length === 0) fail('至少要有 1 个玩家（player）出生点');
    if (enemySpawns.length === 0) fail('至少要有 1 个敌方（enemy）出生点');
    if (playerSpawns.length > BATTLE_STRUCTURE_LIMITS.maxSpawnSide) {
      fail(`玩家出生点最多 ${BATTLE_STRUCTURE_LIMITS.maxSpawnSide} 个（当前 ${playerSpawns.length} 个）`);
    }
    if (enemySpawns.length > BATTLE_STRUCTURE_LIMITS.maxSpawnSide) {
      fail(`敌方出生点最多 ${BATTLE_STRUCTURE_LIMITS.maxSpawnSide} 个（当前 ${enemySpawns.length} 个）`);
    }

    // ---- 连通性：任一玩家出生点 BFS 到每个敌方出生点 ----
    if (errors.length === 0 && playerSpawns.length > 0 && enemySpawns.length > 0) {
      const structure = { cols, rows, terrain, obstacles };
      for (const start of playerSpawns) {
        const reachable = bfsReachable(structure, start);
        for (const enemy of enemySpawns) {
          if (!reachable.has(`${enemy.x},${enemy.y}`)) {
            fail(
              `出生点不连通：玩家出生点 (${start.x},${start.y}) 走不到敌方出生点 (${enemy.x},${enemy.y})（可通行地形/障碍把通路堵死了）`,
            );
          }
        }
      }
      // 软约束：玩家出生点之间互相可达（否则重生成更保险）
      const firstPlayer = playerSpawns[0] as BattleStructureSpawn;
      const firstReachable = bfsReachable(structure, firstPlayer);
      for (const other of playerSpawns.slice(1)) {
        if (!firstReachable.has(`${other.x},${other.y}`)) {
          warnings.push(`玩家出生点 (${other.x},${other.y}) 与 (${firstPlayer.x},${firstPlayer.y}) 不在同一连通区（不阻断，运行时会提示）`);
        }
      }
    }
  }

  // ---- 软约束：最外圈默认不可通行（RULES-MODEL §3） ----
  let borderWalkable = 0;
  for (let x = 0; x < cols; x += 1) {
    if (terrainWalkable(terrain[0]?.[x] ?? 'w')) borderWalkable += 1;
    if (rows > 1 && terrainWalkable(terrain[rows - 1]?.[x] ?? 'w')) borderWalkable += 1;
  }
  for (let y = 0; y < rows; y += 1) {
    if (terrainWalkable(terrain[y]?.[0] ?? 'w')) borderWalkable += 1;
    if (cols > 1 && terrainWalkable(terrain[y]?.[cols - 1] ?? 'w')) borderWalkable += 1;
  }
  if (borderWalkable > 0) {
    warnings.push(`最外圈有 ${borderWalkable} 个可通行格（RULES-MODEL §3 约定外圈默认不可通行，建议改为墙/水）`);
  }

  // ---- 软约束：至少一种可站立地形（有出生点即已满足，这里防御空图） ----
  const walkableCells = terrain.some((row) => row.some((char) => terrainWalkable(char)));
  if (!walkableCells) fail('图上没有任何可通行地形（至少要有一种可站立地形）');

  if (errors.length > 0) return { ok: false, errors, warnings };
  return {
    ok: true,
    errors: [],
    warnings,
    value: { cols, rows, terrain, obstacles, spawns },
  };
}

// ---------------------------------------------------------------------------
// 世界地图结构校验器（热点/连线/双向边）
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hotspotArea(hotspot: WorldZoneHotspot): number {
  return Math.max(0, hotspot.w) * Math.max(0, hotspot.h);
}

/** 两个归一化热点是否"实质重叠"（允许贴边；面积交集 > 1e-9 即重叠）。 */
function hotspotsOverlap(left: WorldZoneHotspot, right: WorldZoneHotspot): boolean {
  const overlapX = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const overlapY = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return overlapX > 1e-9 && overlapY > 1e-9;
}

/**
 * 世界地图硬校验：zoneId 唯一/合法、`connections.to` 都有对应 zone、连线双向存在、
 * 热点在 0..1 内且互不重叠、宽高在合理区间。任一失败 → `ok:false`。
 */
export function validateWorldStructure(input: unknown): StructureValidationReport<WorldStructure> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string): void => {
    errors.push(message);
  };

  if (!isRecord(input)) return { ok: false, errors: ['世界地图结构必须是对象'], warnings };
  if (input.background !== undefined && input.background !== null) {
    fail('world.background 在结构生成阶段必须为 null（底图由背景生图 / pack.assetPut 另行落盘）');
  }
  const rawZones = input.zones;
  if (!Array.isArray(rawZones)) return { ok: false, errors: ['world.zones 必须是数组'], warnings };
  if (rawZones.length < 2) fail(`world.zones 至少要有 2 个区域（当前 ${rawZones.length} 个）`);
  if (rawZones.length > WORLD_STRUCTURE_LIMITS.maxZones) {
    fail(`world.zones 最多 ${WORLD_STRUCTURE_LIMITS.maxZones} 个区域（当前 ${rawZones.length} 个）`);
  }

  const zones: WorldZoneStructure[] = [];
  const zoneIds = new Set<string>();
  rawZones.forEach((raw, index) => {
    const path = `zones[${index}]`;
    if (!isRecord(raw)) {
      fail(`${path} 必须是对象`);
      return;
    }
    if (!isWorldZoneId(raw.zoneId)) {
      fail(`${path}.zoneId 非法（字母/数字/下划线/中文开头，可含 . 与 -，最多 64 字符）`);
      return;
    }
    const zoneId = raw.zoneId;
    if (zoneIds.has(zoneId)) {
      fail(`zoneId 重复：${zoneId}（${path}）`);
      return;
    }
    zoneIds.add(zoneId);
    if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 60) {
      fail(`${path}.name 必须是非空字符串（最多 60 字符）`);
      return;
    }
    if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) {
      fail(`${path}.description 必须是字符串（最多 500 字符）`);
      return;
    }
    const rawHotspot = raw.hotspot;
    if (!isRecord(rawHotspot)) {
      fail(`${path}.hotspot 必须是对象 {x,y,w,h}（归一化 0..1）`);
      return;
    }
    const { x, y, w, h } = rawHotspot;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) {
      fail(`${path}.hotspot 的 x/y/w/h 必须是数字`);
      return;
    }
    if (x < 0 || y < 0 || x + w > 1 + 1e-9 || y + h > 1 + 1e-9) {
      fail(`${path}.hotspot 越界：(${x},${y}) ${w}×${h} 必须完全落在 0..1 内`);
      return;
    }
    if (w < WORLD_STRUCTURE_LIMITS.minHotspotSize || h < WORLD_STRUCTURE_LIMITS.minHotspotSize) {
      fail(`${path}.hotspot 太小（宽高至少 ${WORLD_STRUCTURE_LIMITS.minHotspotSize}）`);
      return;
    }
    if (w > WORLD_STRUCTURE_LIMITS.maxHotspotSize || h > WORLD_STRUCTURE_LIMITS.maxHotspotSize) {
      fail(`${path}.hotspot 太大（宽高最多 ${WORLD_STRUCTURE_LIMITS.maxHotspotSize}）`);
      return;
    }
    const rawConnections = raw.connections;
    if (!Array.isArray(rawConnections)) {
      fail(`${path}.connections 必须是数组`);
      return;
    }
    const connections: WorldZoneConnection[] = [];
    for (let connectionIndex = 0; connectionIndex < rawConnections.length; connectionIndex += 1) {
      const rawConnection = rawConnections[connectionIndex];
      const connectionPath = `${path}.connections[${connectionIndex}]`;
      if (!isRecord(rawConnection)) {
        fail(`${connectionPath} 必须是对象 {to, kind?}`);
        continue;
      }
      if (typeof rawConnection.to !== 'string' || rawConnection.to.length === 0) {
        fail(`${connectionPath}.to 必须是非空字符串`);
        continue;
      }
      if (rawConnection.kind !== undefined && (typeof rawConnection.kind !== 'string' || rawConnection.kind.length > 32)) {
        fail(`${connectionPath}.kind 必须是字符串（最多 32 字符）`);
        continue;
      }
      connections.push({
        to: rawConnection.to,
        ...(typeof rawConnection.kind === 'string' ? { kind: rawConnection.kind } : {}),
      });
    }
    zones.push({
      zoneId,
      name: raw.name,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      hotspot: { x, y, w, h },
      connections,
    });
  });

  // ---- 连线引用 + 双向存在 ----
  const byId = new Map(zones.map((zone) => [zone.zoneId, zone]));
  for (const zone of zones) {
    const seen = new Set<string>();
    for (const connection of zone.connections) {
      if (connection.to === zone.zoneId) {
        fail(`区域 ${zone.zoneId} 的连接指向自己（connections.to 不能是自身）`);
        continue;
      }
      const target = byId.get(connection.to);
      if (target === undefined) {
        fail(`区域 ${zone.zoneId} 的连线指向不存在的区域：${connection.to}`);
        continue;
      }
      if (seen.has(connection.to)) {
        warnings.push(`区域 ${zone.zoneId} 到 ${connection.to} 的连线重复（不阻断，渲染时去重）`);
        continue;
      }
      seen.add(connection.to);
      const reverse = target.connections.find((candidate) => candidate.to === zone.zoneId);
      if (reverse === undefined) {
        fail(`连线不是双向的：${zone.zoneId} → ${connection.to} 缺少反向连线 ${connection.to} → ${zone.zoneId}`);
      } else if ((reverse.kind ?? '') !== (connection.kind ?? '')) {
        warnings.push(`区域 ${zone.zoneId} ↔ ${connection.to} 两向 kind 不一致（不阻断，渲染按各自 kind）`);
      }
    }
  }

  // ---- 热点互不重叠 + 覆盖合理性（软约束） ----
  for (let left = 0; left < zones.length; left += 1) {
    for (let right = left + 1; right < zones.length; right += 1) {
      const a = zones[left] as WorldZoneStructure;
      const b = zones[right] as WorldZoneStructure;
      if (hotspotsOverlap(a.hotspot, b.hotspot)) {
        fail(
          `热点重叠：${a.zoneId} 与 ${b.zoneId} 的热点矩形相交（请挪开热点；世界地图热点不能叠在一起）`,
        );
      }
    }
  }
  const covered = zones.reduce((total, zone) => total + hotspotArea(zone.hotspot), 0);
  if (covered > 0.6) {
    warnings.push(`热点总覆盖面积 ${(covered * 100).toFixed(0)}% 偏大（>60%），世界地图留白会很少（不阻断）`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors: [], warnings, value: { zones, background: null } };
}

// ---------------------------------------------------------------------------
// AI 草稿解析：JSON（首选，提示词要求）与 RULES-MODEL 的 ASCII 文本草稿（兼容）
// ---------------------------------------------------------------------------

function stripCodeFences(text: string): string {
  const fenced = text.match(/```[^\n]*\n([\s\S]*?)\n?```/);
  if (fenced !== null) return (fenced[1] as string).trim();
  return text.trim();
}

/** 从自由文本里抠出第一个 JSON 对象（容忍前后废话与 ```json 围栏）。 */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** 地形词 → 图例字符（AI 常把 terrain 写成 `wall` / `floor` / `草地`）。 */
function terrainCharFromToken(raw: string): string | undefined {
  const token = raw.trim().toLowerCase().replace(/^["'`]+|["'`]+$/g, '');
  if (token.length === 0) return undefined;
  if (token.length === 1 && BATTLE_TERRAIN_CHARS.includes(token)) return token;
  if (token.length === 1) return undefined;
  const table: ReadonlyArray<readonly [RegExp, string]> = [
    [/^(wall|rock|stone|cliff|blocked|block|岩|墙|石壁|障碍)$/u, 'w'],
    [/^(floor|ground|grass|dirt|open|草地|地面|地板|平地)$/u, 'g'],
    [/^(rubble|debris|ruin|gravel|碎石|废墟|瓦砾)$/u, 'r'],
    [/^(tree|forest|wood|树木|树|森林|灌木)$/u, 't'],
    [/^(water|river|lake|sea|water|水域|水|河|湖)$/u, '~'],
    [/^(door|gate|entrance|门|入口|台阶)$/u, '+'],
  ];
  for (const [pattern, char] of table) {
    if (pattern.test(token)) return char;
  }
  return undefined;
}

/** 解析 `LEGEND # wall | . floor | ~ rubble`（也接受 `legend` JSON 对象/数组）。 */
function parseLegend(value: unknown): DraftParseResult<Map<string, string>> {
  const mapping = new Map<string, string>();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (value === undefined) return { value: mapping, errors, warnings };
  if (typeof value === 'string') {
    for (const part of value.split('|')) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const match = trimmed.match(/^(\S)\s+(.+)$/u);
      if (match === null) {
        const char = terrainCharFromToken(trimmed);
        if (char !== undefined) mapping.set(char, char);
        else errors.push(`LEGEND 无法识别：${JSON.stringify(trimmed)}`);
        continue;
      }
      const source = match[1] as string;
      const char = terrainCharFromToken(match[2] as string);
      if (char === undefined) {
        errors.push(`LEGEND 无法识别地形「${match[2] ?? ''}」（请用 floor/wall/rubble/tree/water 等词）`);
        continue;
      }
      mapping.set(source, char);
    }
    return { value: mapping, errors, warnings };
  }
  if (isRecord(value)) {
    for (const [source, token] of Object.entries(value)) {
      if (typeof token !== 'string') {
        errors.push(`legend 的 ${JSON.stringify(source)} 必须是地形字符串`);
        continue;
      }
      const char = terrainCharFromToken(token);
      if (char === undefined) errors.push(`legend 无法识别地形：${JSON.stringify(token)}`);
      else mapping.set(source, char);
    }
    return { value: mapping, errors, warnings };
  }
  errors.push('legend 必须是字符串（如 "# wall | . floor"）或对象');
  return { errors, warnings };
}

/** 把 AI 给的一行地形（字符或 terrain 词数组）转换成图例字符数组。 */
function mapTerrainRow(
  rawRow: unknown,
  cols: number,
  legend: Map<string, string>,
  path: string,
): { row: string[]; errors: string[] } {
  const errors: string[] = [];
  let cells: unknown[];
  if (Array.isArray(rawRow)) cells = rawRow;
  else if (typeof rawRow === 'string') {
    // 容忍 "wwww...." 这种整行字符串；把多字符地形词按空白/逗号切开
    const pieces = rawRow.trim().includes(' ') || rawRow.includes(',')
      ? rawRow.split(/[\s,]+/u).filter((piece) => piece.length > 0)
      : [...rawRow.trim()];
    cells = pieces;
  } else {
    return { row: [], errors: [`${path} 必须是字符串行或字符数组`] };
  }
  const row: string[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    let char: string | undefined;
    if (typeof cell === 'string') {
      char = legend.get(cell) ?? terrainCharFromToken(cell);
      if (char === undefined && cell.length === 1) {
        errors.push(`${path}[${index}] 未知地形字符：${JSON.stringify(cell)}（不静默当墙，请改用图例里的字符）`);
        char = 'w';
      } else if (char === undefined) {
        errors.push(`${path}[${index}] 未知地形：${JSON.stringify(cell)}`);
        char = 'w';
      }
    } else {
      errors.push(`${path}[${index}] 地形必须是字符串`);
      char = 'w';
    }
    row.push(char);
  }
  if (row.length !== cols) {
    errors.push(`${path} 行宽必须等于 cols：期望 ${cols}，实际 ${row.length}`);
  }
  return { row, errors };
}

function parseObstacles(raw: unknown): DraftParseResult<BattleStructureObstacle[]> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw === undefined) return { value: [], errors, warnings };
  if (!Array.isArray(raw)) return { errors: ['obstacles 必须是数组'], warnings };
  const obstacles: BattleStructureObstacle[] = [];
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`obstacles[${index}] 必须是对象 {x,y,w,h,terrain?,coverId?}`);
      return;
    }
    const x = item.x;
    const y = item.y;
    const w = item.w ?? 1;
    const h = item.h ?? 1;
    if (!isIntegerValue(x) || !isIntegerValue(y) || !isIntegerValue(w) || !isIntegerValue(h)) {
      errors.push(`obstacles[${index}] 的 x/y/w/h 必须是整数`);
      return;
    }
    let terrain: string | undefined;
    if (item.terrain !== undefined) {
      terrain = typeof item.terrain === 'string' ? terrainCharFromToken(item.terrain) : undefined;
      if (terrain === undefined) {
        errors.push(`obstacles[${index}].terrain 无法识别：${JSON.stringify(item.terrain)}`);
        return;
      }
    }
    obstacles.push({
      x,
      y,
      w,
      h,
      ...(terrain !== undefined ? { terrain } : {}),
      ...(typeof item.coverId === 'string' ? { coverId: item.coverId } : {}),
    });
  });
  return { value: obstacles, errors, warnings };
}

/** 出生点：JSON 数组或 RULES-MODEL 的 `spawns: player 1,6 | enemy 10,2` 行。 */
function parseSpawns(raw: unknown): DraftParseResult<BattleStructureSpawn[]> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const spawns: BattleStructureSpawn[] = [];
  if (raw === undefined) return { value: spawns, errors: ['缺少出生点（spawns 不能为空）'], warnings };
  if (typeof raw === 'string') {
    for (const part of raw.split('|')) {
      const match = part.trim().match(/^(player|enemy|neutral)\s+(\d+)\s*,\s*(\d+)$/i);
      if (match === null) {
        errors.push(`spawns 段无法识别：${JSON.stringify(part.trim())}（格式 player 1,6 | enemy 10,2）`);
        continue;
      }
      spawns.push({
        x: Number.parseInt(match[2] as string, 10),
        y: Number.parseInt(match[3] as string, 10),
        side: (match[1] as string).toLowerCase() as BattleSpawnSide,
      });
    }
    return { value: spawns, errors, warnings };
  }
  if (!Array.isArray(raw)) return { value: spawns, errors: ['spawns 必须是数组或字符串'], warnings };
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`spawns[${index}] 必须是对象 {x,y,side}`);
      return;
    }
    const x = item.x;
    const y = item.y;
    const side = readSpawnSide(item.side);
    if (!isIntegerValue(x) || !isIntegerValue(y)) {
      errors.push(`spawns[${index}] 的 x/y 必须是整数`);
      return;
    }
    if (side === undefined) {
      errors.push(`spawns[${index}].side 必须是 ${BATTLE_SPAWN_SIDES.join(' / ')} 之一`);
      return;
    }
    spawns.push({
      x,
      y,
      side,
      ...(typeof item.label === 'string' ? { label: item.label } : {}),
      ...(typeof item.monsterId === 'string' ? { monsterId: item.monsterId } : {}),
    });
  });
  return { value: spawns, errors, warnings };
}

/**
 * 解析 AI 战棋草稿：优先 JSON（提示词要求的格式），不行再按 RULES-MODEL §3 的
 * `SIZE` / `LEGEND` / ASCII 行 / `spawns:` 文本草稿解析。返回结构后仍需过校验器。
 */
export function parseBattleDraft(text: string): DraftParseResult<BattleStructure> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleaned = stripCodeFences(text);
  if (cleaned.length === 0) return { errors: ['AI 返回了空草稿'], warnings };
  const json = extractJsonObject(cleaned);
  if (isRecord(json)) {
    return parseBattleJson(json);
  }

  // ---- 文本草稿（RULES-MODEL §3 示例） ----
  const lines = cleaned.split(/\r?\n/u).map((line) => line.trimEnd());
  let cols: number | undefined;
  let rows: number | undefined;
  let legend: Map<string, string> = new Map();
  const terrainRows: string[] = [];
  let spawnsLine: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const size = trimmed.match(/^SIZE\s+(\d+)\s*x\s*(\d+)$/i);
    if (size !== null) {
      cols = Number.parseInt(size[1] as string, 10);
      rows = Number.parseInt(size[2] as string, 10);
      continue;
    }
    const legendMatch = trimmed.match(/^LEGEND\s+(.+)$/i);
    if (legendMatch !== null) {
      const parsedLegend = parseLegend(legendMatch[1] as string);
      for (const error of parsedLegend.errors) errors.push(error);
      warnings.push(...parsedLegend.warnings);
      legend = parsedLegend.value ?? new Map();
      continue;
    }
    const spawnsMatch = trimmed.match(/^spawns\s*:\s*(.+)$/i);
    if (spawnsMatch !== null) {
      spawnsLine = spawnsMatch[1] as string;
      continue;
    }
    if (/^[#.\-|a-zA-Z0-9~+*:/_ ]+$/u.test(trimmed) && !trimmed.includes(' ')) {
      terrainRows.push(trimmed);
    } else {
      errors.push(`无法识别的草稿行：${JSON.stringify(trimmed)}`);
    }
  }
  if (terrainRows.length === 0) {
    errors.push('草稿里没有地形行（需要一个 SIZE 头 + 若干 ASCII 行 + spawns 行）');
  }
  if (cols === undefined || rows === undefined) {
    rows = rows ?? terrainRows.length;
    cols = cols ?? (terrainRows[0]?.length ?? 0);
    warnings.push(`草稿缺少 SIZE 行，按实际地形行推断为 ${cols}×${rows}`);
  }
  if (terrainRows.length !== rows) {
    errors.push(`地形行数必须等于 rows：期望 ${rows} 行，实际 ${terrainRows.length} 行`);
  }
  const terrain: string[][] = [];
  for (let index = 0; index < terrainRows.length; index += 1) {
    const mapped = mapTerrainRow(terrainRows[index] as string, cols ?? 0, legend, `terrain[${index}]`);
    for (const error of mapped.errors) errors.push(error);
    terrain.push(mapped.row);
  }
  const parsedSpawns = parseSpawns(spawnsLine);
  for (const error of parsedSpawns.errors) errors.push(error);
  if (parsedSpawns.value === undefined || parsedSpawns.value.length === 0) {
    errors.push('草稿缺少 spawns 行（格式：spawns: player 1,6 | enemy 10,2）');
  }
  const structure: BattleStructure = {
    cols: cols ?? 0,
    rows: rows ?? 0,
    terrain,
    obstacles: [],
    spawns: parsedSpawns.value ?? [],
  };
  if (errors.length > 0) return { errors, warnings };
  return { value: structure, errors: [], warnings };
}

function parseBattleJson(json: Record<string, unknown>): DraftParseResult<BattleStructure> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsedLegend = parseLegend(json.legend);
  for (const error of parsedLegend.errors) errors.push(error);
  warnings.push(...parsedLegend.warnings);
  const legend = parsedLegend.value ?? new Map<string, string>();

  let cols = isIntegerValue(json.cols) ? json.cols : undefined;
  let rows = isIntegerValue(json.rows) ? json.rows : undefined;
  if (typeof json.size === 'string') {
    const match = json.size.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
    if (match !== null) {
      cols = cols ?? Number.parseInt(match[1] as string, 10);
      rows = rows ?? Number.parseInt(match[2] as string, 10);
    }
  }
  // 地形行字段：`terrain` / `ascii` 优先；兼容 AI 把 `rows` 直接当行数组/整串返回的写法。
  const rawRows =
    json.terrain ?? json.ascii ?? (Array.isArray(json.rows) || typeof json.rows === 'string' ? json.rows : undefined);
  let terrainRows: unknown[] = [];
  if (Array.isArray(rawRows)) terrainRows = rawRows;
  else if (typeof rawRows === 'string') terrainRows = rawRows.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  else errors.push('缺少地形行（terrain / ascii 字段，或 rows 直接给行数组）');

  rows = rows ?? terrainRows.length;
  cols = cols ?? (Array.isArray(terrainRows[0]) ? (terrainRows[0] as unknown[]).length : String(terrainRows[0] ?? '').trim().length);
  if (terrainRows.length !== rows) {
    errors.push(`地形行数必须等于 rows：期望 ${rows} 行，实际 ${terrainRows.length} 行`);
  }
  const terrain: string[][] = [];
  for (let index = 0; index < terrainRows.length; index += 1) {
    const mapped = mapTerrainRow(terrainRows[index], cols ?? 0, legend, `terrain[${index}]`);
    for (const error of mapped.errors) errors.push(error);
    terrain.push(mapped.row);
  }
  const parsedObstacles = parseObstacles(json.obstacles);
  for (const error of parsedObstacles.errors) errors.push(error);
  const parsedSpawns = parseSpawns(json.spawns);
  for (const error of parsedSpawns.errors) errors.push(error);
  if (errors.length > 0) return { errors, warnings };
  return {
    value: {
      cols: cols ?? 0,
      rows: rows ?? 0,
      terrain,
      obstacles: parsedObstacles.value ?? [],
      spawns: parsedSpawns.value ?? [],
    },
    errors: [],
    warnings,
  };
}

/** 解析 AI 世界草稿（JSON：`{zones:[{zoneId,name,description?,hotspot{x,y,w,h},connections[{to,kind?}]}]}`）。 */
export function parseWorldDraft(text: string): DraftParseResult<WorldStructure> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleaned = stripCodeFences(text);
  if (cleaned.length === 0) return { errors: ['AI 返回了空草稿'], warnings };
  const json = extractJsonObject(cleaned);
  if (!isRecord(json)) return { errors: ['世界草稿必须是 JSON 对象 { zones: [...] }'], warnings };
  const rawZones = Array.isArray(json.zones) ? json.zones : undefined;
  if (rawZones === undefined) return { errors: ['世界草稿缺少 zones 数组'], warnings };
  const zones: WorldZoneStructure[] = [];
  rawZones.forEach((raw, index) => {
    if (!isRecord(raw)) {
      errors.push(`zones[${index}] 必须是对象`);
      return;
    }
    const zoneId = typeof raw.zoneId === 'string' && raw.zoneId.trim().length > 0 ? raw.zoneId.trim() : undefined;
    if (zoneId === undefined) {
      errors.push(`zones[${index}].zoneId 必须是非空字符串`);
      return;
    }
    const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : undefined;
    if (name === undefined) {
      errors.push(`zones[${index}].name 必须是非空字符串`);
      return;
    }
    const rawHotspot = raw.hotspot;
    let hotspot: WorldZoneHotspot | undefined;
    if (isRecord(rawHotspot)) {
      const x = rawHotspot.x;
      const y = rawHotspot.y;
      const w = rawHotspot.w ?? rawHotspot.width;
      const h = rawHotspot.h ?? rawHotspot.height;
      if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(w) && isFiniteNumber(h)) {
        hotspot = { x, y, w, h };
      }
    }
    if (hotspot === undefined) {
      errors.push(`zones[${index}].hotspot 必须是对象 {x,y,w,h}（0..1 归一化矩形）`);
      return;
    }
    const connections: WorldZoneConnection[] = [];
    if (raw.connections !== undefined) {
      if (!Array.isArray(raw.connections)) {
        errors.push(`zones[${index}].connections 必须是数组`);
        return;
      }
      for (let connectionIndex = 0; connectionIndex < raw.connections.length; connectionIndex += 1) {
        const item = raw.connections[connectionIndex];
        if (typeof item === 'string') {
          connections.push({ to: item });
          continue;
        }
        if (!isRecord(item) || typeof item.to !== 'string' || item.to.length === 0) {
          errors.push(`zones[${index}].connections[${connectionIndex}] 必须是 {to,kind?} 或区域 id 字符串`);
          continue;
        }
        connections.push({
          to: item.to,
          ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
        });
      }
    }
    zones.push({
      zoneId,
      name,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      hotspot,
      connections,
    });
  });
  if (errors.length > 0) return { errors, warnings };
  return { value: { zones, background: null }, errors: [], warnings };
}

// ---------------------------------------------------------------------------
// AI 提示词
// ---------------------------------------------------------------------------

const BATTLE_SYSTEM_PROMPT = `你是战棋 TRPG 的地图结构设计师。你只输出 JSON，不输出解释、不输出 Markdown 代码块。
输出格式（严格）：
{"cols":16,"rows":10,"legend":"g floor | w wall | r rubble | t tree | ~ water","terrain":["wwww...","wggg..."],"obstacles":[{"x":3,"y":4,"w":2,"h":1,"terrain":"r","coverId":"half"}],"spawns":[{"x":2,"y":8,"side":"player"},{"x":13,"y":2,"side":"enemy"}]}
字段说明：cols/rows 是画布尺寸；terrain 是 rows 条字符串（每条 cols 个单字符）；legend 说明每个字符的地形含义。
硬约束（违反任一即被校验器拒绝并重试）：
1. cols/rows 是整数，4..32；terrain 数组必须正好 rows 条、每条正好 cols 个单字符地形。
2. 地形字符只能取 legend 里出现过的单字符（g/. 地面可走，r 碎石可走，t 树/水/墙不可走）。
3. 最外圈默认是墙（w）；出生点不能落在墙/水/树或外圈上。
4. 至少 1 个 player 出生点和 1 个 enemy 出生点；出生点互不重叠；总数 ≤ 20。
5. 玩家出生点必须能四方向走到每个敌方出生点（不许把通路堵死）。
6. 障碍矩形 (x,y,w,h) 必须在图内，不得覆盖出生点；terrain 用 legend 字符，coverId 可选 half。`;

const WORLD_SYSTEM_PROMPT = `你是 TRPG 世界地图的区域规划师。你只输出 JSON，不输出解释、不输出 Markdown 代码块。
输出格式（严格）：
{"zones":[{"zoneId":"zone_1","name":"青石镇","description":"一句话描述","hotspot":{"x":0.1,"y":0.2,"w":0.16,"h":0.14},"connections":[{"to":"zone_2","kind":"road"}]}]}
硬约束（违反任一即被校验器拒绝并重试）：
1. zones 3..8 个；zoneId 唯一，用字母/数字/下划线（可含 - .），不要用空格。
2. hotspot 是 0..1 归一化矩形 {x,y,w,h}：x+w ≤ 1、y+h ≤ 1，宽高 0.02..0.6，任意两个热点不得重叠。
3. connections.to 必须指向同列表里的 zoneId；每条连线都必须在目标区域里有一条反向连线（A→B 与 B→A 同时存在）。
4. connections.kind 用 road/river/stairs/path 之一（渲染样式：道路实线、河流蓝、楼梯虚线）。`;

function promptKeyword(prompt: string, limit = 24): string {
  return prompt.replace(/\s+/gu, ' ').trim().slice(0, limit);
}

/** 战棋草稿提示词（第 2/3 次重试时把上一轮校验错误反馈给模型）。 */
export function buildBattleDraftPrompt(input: BattleDraftInput, attempt = 0, previousError?: string): string {
  const partySize = clampInteger(input.partySize ?? 4, 1, BATTLE_STRUCTURE_LIMITS.maxPartySize);
  const cols = input.cols ?? 12 + partySize;
  const rows = input.rows ?? 8 + Math.ceil(partySize / 2);
  const styleHint =
    input.style === 'pixel-topdown'
      ? '像素风俯视 2D（直角房间、规整走廊）'
      : '俯视 2D（自然洞穴/废墟，地形有变化但通路清晰）';
  const lines = [
    `场景描述：${promptKeyword(input.prompt, 400)}`,
    `画布：${cols} 列 × ${rows} 行（cols=横轴 x，rows=纵轴 y，行优先）；玩家 ${partySize} 人。`,
    `风格：${styleHint}。`,
    attempt > 0
      ? `上一轮草稿没通过程序校验，请修正后重新输出完整 JSON：${previousError ?? '格式或校验失败'}`
      : '请直接输出 JSON。',
    '记住：四周留墙、房间之间用走廊连通、玩家出生点放左侧、敌方出生点放右侧。',
  ];
  return lines.join('\n');
}

/** 世界草稿提示词。 */
export function buildWorldDraftPrompt(input: WorldDraftInput, attempt = 0, previousError?: string): string {
  const zoneCount = clampInteger(input.zoneCount ?? 5, WORLD_STRUCTURE_LIMITS.minZones, WORLD_STRUCTURE_LIMITS.maxZones);
  const lines = [
    `世界/区域氛围：${promptKeyword(input.prompt, 400)}`,
    `区域数量：${zoneCount}`,
    '热点按大致网格铺开（互不重叠），相邻区域连起来，连线必须双向。',
    attempt > 0
      ? `上一轮草稿没通过程序校验，请修正后重新输出完整 JSON：${previousError ?? '格式或校验失败'}`
      : '请直接输出 JSON。',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 程序化兜底：战棋图
// ---------------------------------------------------------------------------

interface BattleRoom {
  x: number;
  y: number;
  w: number;
  h: number;
}

function roomsOverlap(left: BattleRoom, right: BattleRoom): boolean {
  return (
    left.x - 1 < right.x + right.w &&
    right.x - 1 < left.x + left.w &&
    left.y - 1 < right.y + right.h &&
    right.y - 1 < left.y + left.h
  );
}

/** 房间 + 走廊挖洞：保证所有可走格在同一连通区（程序化兜底的地基）。 */
function carveRoomsAndCorridors(rng: SeededRng, cols: number, rows: number): string[][] {
  const grid: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill('w'));
  const carve = (x: number, y: number): void => {
    if (x <= 0 || y <= 0 || x >= cols - 1 || y >= rows - 1) return;
    const row = grid[y];
    if (row !== undefined) row[x] = 'g';
  };
  const rooms: BattleRoom[] = [];
  const maxWidth = Math.max(3, Math.min(9, cols - 4));
  const maxHeight = Math.max(2, Math.min(6, rows - 4));
  for (let attempt = 0; attempt < 80 && rooms.length < 5; attempt += 1) {
    const w = rng.nextInt(3, maxWidth);
    const h = rng.nextInt(2, maxHeight);
    const x = rng.nextInt(1, Math.max(1, cols - w - 1));
    const y = rng.nextInt(1, Math.max(1, rows - h - 1));
    if (x + w > cols - 1 || y + h > rows - 1) continue;
    const candidate: BattleRoom = { x, y, w, h };
    if (rooms.some((room) => roomsOverlap(room, candidate))) continue;
    rooms.push(candidate);
  }
  // 兜底：至少两个房间（左/右各一个），保证出生点分居两侧
  if (rooms.length < 2) {
    rooms.length = 0;
    const h = Math.max(2, Math.min(rows - 2, Math.floor(rows / 2)));
    rooms.push({ x: 1, y: 1, w: Math.max(3, Math.floor(cols / 3)), h });
    rooms.push({
      x: Math.max(2, cols - 1 - Math.floor(cols / 3)),
      y: Math.max(1, rows - 1 - h),
      w: Math.max(3, Math.floor(cols / 3)),
      h,
    });
  }
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y += 1) {
      for (let x = room.x; x < room.x + room.w; x += 1) carve(x, y);
    }
  }
  // 按 x 排序后相邻房间用 L 形走廊连起来（水平再垂直；保证连通）
  const ordered = [...rooms].sort((left, right) => left.x - right.x || left.y - right.y);
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1] as BattleRoom;
    const to = ordered[index] as BattleRoom;
    const fromX = from.x + Math.floor(from.w / 2);
    const fromY = from.y + Math.floor(from.h / 2);
    const toX = to.x + Math.floor(to.w / 2);
    const toY = to.y + Math.floor(to.h / 2);
    const stepX = fromX <= toX ? 1 : -1;
    for (let x = fromX; x !== toX + stepX; x += stepX) carve(x, fromY);
    const stepY = fromY <= toY ? 1 : -1;
    for (let y = fromY; y !== toY + stepY; y += stepY) carve(toX, y);
  }
  // 首尾也连一下（环形），避免长条形地图只有一个走廊
  if (ordered.length > 2) {
    const first = ordered[0] as BattleRoom;
    const last = ordered[ordered.length - 1] as BattleRoom;
    const y = first.y + Math.floor(first.h / 2);
    for (let x = first.x; x <= last.x + Math.floor(last.w / 2); x += 1) carve(x, y);
  }
  return grid;
}

/** 可走格总数；用于判定"所有可走格是否连通"（防树枝把地图劈成两半）。 */
function walkableCells(grid: string[][]): Array<{ x: number; y: number }> {
  const cells: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < grid.length; y += 1) {
    const row = grid[y] as string[];
    for (let x = 0; x < row.length; x += 1) {
      if (terrainWalkable(row[x] as string)) cells.push({ x, y });
    }
  }
  return cells;
}

/** 从任一可走格出发，所有可走格是否都在同一连通区。 */
function isFullyConnected(grid: string[][]): boolean {
  const cells = walkableCells(grid);
  if (cells.length <= 1) return true;
  const structure = {
    cols: (grid[0] as string[]).length,
    rows: grid.length,
    terrain: grid,
    obstacles: [] as BattleStructureObstacle[],
  };
  const start = cells[0] as { x: number; y: number };
  const reachable = bfsReachable(structure, start);
  return reachable.size === cells.length;
}

/** 程序化战棋结构（确定性兜底；AI 不可用/连续失败时使用）。 */
export function proceduralBattleStructure(input: BattleDraftInput): BattleStructure {
  const partySize = clampInteger(input.partySize ?? 4, 1, BATTLE_STRUCTURE_LIMITS.maxPartySize);
  const cols = clampInteger(input.cols ?? 12 + partySize, 4, BATTLE_STRUCTURE_LIMITS.maxCols);
  const rows = clampInteger(input.rows ?? 8 + Math.ceil(partySize / 2), 4, BATTLE_STRUCTURE_LIMITS.maxRows);
  const rng = new SeededRng(
    sha256Hex(`battle|${input.prompt}|${input.seed ?? 0}|${cols}x${rows}|${partySize}|${input.style}`),
  );
  const grid = carveRoomsAndCorridors(rng, cols, rows);

  // ---- 装饰/障碍：碎石（可走，moveCost 2）与树丛（不可走，但只在连通性不变时放） ----
  const cells = walkableCells(grid);
  const rubbleCells: Array<{ x: number; y: number }> = [];
  const rubbleTarget = clampInteger(Math.floor(cells.length / 10), 2, 12);
  for (let placed = 0; placed < rubbleTarget * 3 && rubbleCells.length < rubbleTarget; placed += 1) {
    const cell = rng.pick(cells);
    if ((grid[cell.y] as string[])[cell.x] !== 'g') continue;
    (grid[cell.y] as string[])[cell.x] = 'r';
    rubbleCells.push(cell);
  }
  const treeCells: Array<{ x: number; y: number }> = [];
  for (let attempt = 0; attempt < 24 && treeCells.length < 3; attempt += 1) {
    const cell = rng.pick(cells);
    const row = grid[cell.y] as string[];
    if (row[cell.x] !== 'g') continue;
    row[cell.x] = 't';
    if (!isFullyConnected(grid)) {
      row[cell.x] = 'g'; // 会堵死通路就撤销
      continue;
    }
    treeCells.push(cell);
  }

  // ---- 障碍矩形：碎石 1×1/2×1（可走+掩体），树丛 1×1（阻挡，纯装饰） ----
  const obstacles: BattleStructureObstacle[] = [];
  for (const cell of rubbleCells.slice(0, 4)) {
    const canBePair = cell.x + 1 < cols && (grid[cell.y] as string[])[cell.x + 1] === 'r';
    obstacles.push({
      x: cell.x,
      y: cell.y,
      w: canBePair && rng.nextFloat() < 0.5 ? 2 : 1,
      h: 1,
      terrain: 'r',
      coverId: 'half',
    });
  }
  for (const cell of treeCells) {
    obstacles.push({ x: cell.x, y: cell.y, w: 1, h: 1, terrain: 't' });
  }

  // ---- 出生点：左侧（玩家）/ 右侧（敌方）；只用可站立格（地面/碎石），互不重叠 ----
  // 极端小图（4×4 + 8 人）可站格可能不够：先补足 2 个可站格，再按容量收缩出生点数量
  //（校验器只要求两侧各有 ≥1；大图正常按队伍人数铺）。
  if (walkableCells(grid).length < 2) {
    (grid[1] as string[])[Math.min(1, cols - 2)] = 'g';
    (grid[rows - 2] as string[])[Math.min(2, cols - 2)] = 'g';
  }
  const standable = walkableCells(grid);
  const capacity = standable.length;
  const playerCount = Math.max(1, Math.min(partySize, capacity - 1));
  const desiredEnemyCount = Math.max(1, Math.min(4, 1 + Math.floor(partySize / 3)));
  const enemyCount = Math.max(1, Math.min(desiredEnemyCount, capacity - playerCount));
  const sortedByX = [...standable].sort((left, right) => left.x - right.x || left.y - right.y);
  const playerSpawns: BattleStructureSpawn[] = [];
  const used = new Set<string>();
  for (const cell of sortedByX) {
    if (playerSpawns.length >= playerCount) break;
    const key = `${cell.x},${cell.y}`;
    if (used.has(key)) continue;
    used.add(key);
    playerSpawns.push({ x: cell.x, y: cell.y, side: 'player', label: '入口' });
  }
  const enemySpawns: BattleStructureSpawn[] = [];
  for (const cell of [...sortedByX].reverse()) {
    if (enemySpawns.length >= enemyCount) break;
    const key = `${cell.x},${cell.y}`;
    if (used.has(key)) continue;
    used.add(key);
    enemySpawns.push({ x: cell.x, y: cell.y, side: 'enemy', label: '敌方' });
  }
  const spawns = [...playerSpawns, ...enemySpawns];
  // 障碍与出生点不得重叠：出生点先定，再丢掉压到出生点的障碍矩形（地形本身保留）。
  const spawnCells = new Set(spawns.map((spawn) => `${spawn.x},${spawn.y}`));
  const finalObstacles = obstacles.filter((obstacle) => {
    for (let y = obstacle.y; y < obstacle.y + obstacle.h; y += 1) {
      for (let x = obstacle.x; x < obstacle.x + obstacle.w; x += 1) {
        if (spawnCells.has(`${x},${y}`)) return false;
      }
    }
    return true;
  });

  return { cols, rows, terrain: grid, obstacles: finalObstacles, spawns };
}

// ---------------------------------------------------------------------------
// 程序化兜底：世界地图（网格布局 + 中文命名 + 双向连线）
// ---------------------------------------------------------------------------

const WORLD_NAME_WORDS = [
  '青石',
  '枯木',
  '寒潭',
  '荒祠',
  '古道',
  '幽林',
  '断崖',
  '血泉',
  '雾谷',
  '残垣',
  '赤枫',
  '寂水',
  '灰烬',
  '苔径',
] as const;

const WORLD_NAME_SUFFIXES = ['镇', '口', '林', '崖', '洞', '潭', '道', '祠', '谷', '坡'] as const;

const WORLD_EDGE_KINDS = ['road', 'path', 'river', 'stairs'] as const;

const WORLD_SCENE_HINTS = [
  '常年雾气不散，是附近猎人歇脚的地方。',
  '石缝里渗着微光，夜里能听见低语。',
  '旧路早已荒废，只剩车辙与断裂的石碑。',
  '水面倒映着天空，却看不见自己的影子。',
  '传闻这里曾有祭坛，如今只剩焦土。',
] as const;

/** 程序化世界结构（deterministic：网格热点互不重叠 + 环形/对角双向连线）。 */
export function proceduralWorldStructure(input: WorldDraftInput): WorldStructure {
  const zoneCount = clampInteger(
    input.zoneCount ?? 5,
    WORLD_STRUCTURE_LIMITS.minZones,
    WORLD_STRUCTURE_LIMITS.maxZones,
  );
  const rng = new SeededRng(sha256Hex(`world|${input.prompt}|${input.seed ?? 0}|${zoneCount}|${input.style ?? ''}`));
  const gridCols = Math.ceil(Math.sqrt(zoneCount));
  const gridRows = Math.ceil(zoneCount / gridCols);
  const cellW = 1 / gridCols;
  const cellH = 1 / gridRows;
  const words = rng.shuffle(WORLD_NAME_WORDS);
  const suffixes = rng.shuffle(WORLD_NAME_SUFFIXES);
  const hotspotW = Math.max(
    WORLD_STRUCTURE_LIMITS.minHotspotSize,
    Math.min(WORLD_STRUCTURE_LIMITS.maxHotspotSize, cellW * 0.62),
  );
  const hotspotH = Math.max(
    WORLD_STRUCTURE_LIMITS.minHotspotSize,
    Math.min(WORLD_STRUCTURE_LIMITS.maxHotspotSize, cellH * 0.62),
  );

  interface Provisional {
    zoneId: string;
    name: string;
    description: string;
    hotspot: WorldZoneHotspot;
    connections: WorldZoneConnection[];
  }
  const provisional: Provisional[] = [];
  for (let index = 0; index < zoneCount; index += 1) {
    const column = index % gridCols;
    const row = Math.floor(index / gridCols);
    const w = Math.min(hotspotW, 1 - WORLD_STRUCTURE_LIMITS.minHotspotSize);
    const h = Math.min(hotspotH, 1 - WORLD_STRUCTURE_LIMITS.minHotspotSize);
    const x = Math.min(
      1 - w,
      column * cellW + (cellW - w) / 2 + (rng.nextFloat() - 0.5) * cellW * 0.08,
    );
    const y = Math.min(
      1 - h,
      row * cellH + (cellH - h) / 2 + (rng.nextFloat() - 0.5) * cellH * 0.08,
    );
    const word = (words[index % words.length] as string) ?? '无名';
    const suffix = (suffixes[index % suffixes.length] as string) ?? '地';
    provisional.push({
      zoneId: `zone_${index + 1}`,
      name: `${word}${suffix}`,
      description: `${input.prompt.trim().slice(0, 20) ? `靠近「${input.prompt.trim().slice(0, 20)}」的` : ''}${word}${suffix}：${rng.pick(WORLD_SCENE_HINTS)}`,
      hotspot: { x: Math.max(0, x), y: Math.max(0, y), w, h },
      connections: [],
    });
  }

  const addEdge = (from: number, to: number, kind: string): void => {
    const source = provisional[from];
    const target = provisional[to];
    if (source === undefined || target === undefined) return;
    if (!source.connections.some((connection) => connection.to === target.zoneId)) {
      source.connections.push({ to: target.zoneId, kind });
    }
    if (!target.connections.some((connection) => connection.to === source.zoneId)) {
      target.connections.push({ to: source.zoneId, kind });
    }
  };
  // 环：0-1-2-...-n-1-0
  for (let index = 0; index < zoneCount; index += 1) {
    addEdge(index, (index + 1) % zoneCount, rng.pick(WORLD_EDGE_KINDS));
  }
  // 对角捷径：每个区域连到隔一个的区域（n≥4 才有意义），让世界地图不是一条链
  if (zoneCount >= 4) {
    for (let index = 0; index < zoneCount; index += 2) {
      addEdge(index, (index + 2) % zoneCount, rng.pick(WORLD_EDGE_KINDS));
    }
  }

  const zones: WorldZoneStructure[] = provisional.map((zone) => ({
    zoneId: zone.zoneId,
    name: zone.name,
    description: zone.description,
    hotspot: zone.hotspot,
    connections: zone.connections,
  }));
  return { zones, background: null };
}

// ---------------------------------------------------------------------------
// 顶层生成入口（AI 优先 + 重试 ≤2 + 程序化兜底）
// ---------------------------------------------------------------------------

const MAX_AI_ATTEMPTS = 3;

export interface BattleGenerateOptions extends BattleDraftInput {
  textGenerator?: StudioTextGenerator;
}

export interface WorldGenerateOptions extends WorldDraftInput {
  textGenerator?: StudioTextGenerator;
}

/**
 * 生成战棋结构：AI 草稿（最多 3 次：首次 + 2 次重试）→ 校验 → 失败回退程序化。
 * 程序化结构同样过校验器；校验器 + 生成器共用同一份 `BATTLE_TERRAIN_LEGEND` 约束。
 */
export async function generateBattleMap(input: BattleGenerateOptions): Promise<BattleGenerationOutcome> {
  const warnings: string[] = [];
  const { textGenerator, ...draftInput } = input;
  if (textGenerator !== undefined) {
    let previousError = '';
    for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt += 1) {
      let raw: string;
      try {
        raw = await textGenerator({
          kind: 'battle-map',
          system: BATTLE_SYSTEM_PROMPT,
          prompt: buildBattleDraftPrompt(draftInput, attempt, previousError),
          attempt,
        });
      } catch (error) {
        previousError = error instanceof Error ? error.message : String(error);
        warnings.push(`AI 结构草稿第 ${attempt + 1} 次调用失败：${previousError}`);
        continue;
      }
      const parsed = parseBattleDraft(raw);
      if (parsed.value === undefined) {
        previousError = parsed.errors.slice(0, 4).join('；') || '解析失败';
        warnings.push(`AI 结构草稿第 ${attempt + 1} 次无法解析：${previousError}`);
        continue;
      }
      const report = validateBattleStructure(parsed.value);
      if (report.ok && report.value !== undefined) {
        warnings.push(...parsed.warnings, ...report.warnings);
        return { structure: report.value, warnings, method: 'ai', attempts: attempt + 1 };
      }
      previousError = report.errors.slice(0, 4).join('；') || '校验失败';
      warnings.push(`AI 结构草稿第 ${attempt + 1} 次未通过校验：${previousError}`);
    }
    warnings.push(`AI 结构草稿连续 ${MAX_AI_ATTEMPTS} 次不可用，已回退程序化生成（同一 prompt+seed 结果固定）`);
  } else {
    warnings.push('未配置文本模型（AI 结构草稿不可用），使用程序化结构生成');
  }

  const structure = proceduralBattleStructure(draftInput);
  const report = validateBattleStructure(structure);
  if (!report.ok || report.value === undefined) {
    throw new Error(`程序化战棋结构未通过自校验（内部错误）：${report.errors.join('；')}`);
  }
  warnings.push(...report.warnings);
  return { structure: report.value, warnings, method: 'procedural', attempts: 0 };
}

/** 生成世界地图结构：AI 草稿（最多 3 次）→ 校验 → 失败回退程序化网格布局。 */
export async function generateWorldMap(input: WorldGenerateOptions): Promise<WorldGenerationOutcome> {
  const warnings: string[] = [];
  const { textGenerator, ...draftInput } = input;
  if (textGenerator !== undefined) {
    let previousError = '';
    for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt += 1) {
      let raw: string;
      try {
        raw = await textGenerator({
          kind: 'world-map',
          system: WORLD_SYSTEM_PROMPT,
          prompt: buildWorldDraftPrompt(draftInput, attempt, previousError),
          attempt,
        });
      } catch (error) {
        previousError = error instanceof Error ? error.message : String(error);
        warnings.push(`AI 世界草稿第 ${attempt + 1} 次调用失败：${previousError}`);
        continue;
      }
      const parsed = parseWorldDraft(raw);
      if (parsed.value === undefined) {
        previousError = parsed.errors.slice(0, 4).join('；') || '解析失败';
        warnings.push(`AI 世界草稿第 ${attempt + 1} 次无法解析：${previousError}`);
        continue;
      }
      const report = validateWorldStructure(parsed.value);
      if (report.ok && report.value !== undefined) {
        warnings.push(...parsed.warnings, ...report.warnings);
        return { world: report.value, warnings, method: 'ai', attempts: attempt + 1 };
      }
      previousError = report.errors.slice(0, 4).join('；') || '校验失败';
      warnings.push(`AI 世界草稿第 ${attempt + 1} 次未通过校验：${previousError}`);
    }
    warnings.push(`AI 世界草稿连续 ${MAX_AI_ATTEMPTS} 次不可用，已回退程序化生成（同一 prompt+seed 结果固定）`);
  } else {
    warnings.push('未配置文本模型（AI 世界草稿不可用），使用程序化结构与命名');
  }

  const world = proceduralWorldStructure(draftInput);
  const report = validateWorldStructure(world);
  if (!report.ok || report.value === undefined) {
    throw new Error(`程序化世界结构未通过自校验（内部错误）：${report.errors.join('；')}`);
  }
  warnings.push(...report.warnings);
  return { world: report.value, warnings, method: 'procedural', attempts: 0 };
}

/** 战棋结构摘要（塞进底图生图提示词，让底图与结构大致对应）。 */
export function summarizeBattleStructure(structure: BattleStructure): string {
  const counts = new Map<string, number>();
  for (const row of structure.terrain) {
    for (const char of row) {
      const spec = BATTLE_TERRAIN_LEGEND[char];
      if (spec === undefined) continue;
      counts.set(spec.name, (counts.get(spec.name) ?? 0) + 1);
    }
  }
  const terrain = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
  const players = structure.spawns.filter((spawn) => spawn.side === 'player').length;
  const enemies = structure.spawns.filter((spawn) => spawn.side === 'enemy').length;
  return `${structure.cols}×${structure.rows} 格；地形：${terrain}；玩家出生点 ${players} 个、敌方出生点 ${enemies} 个`;
}

/** 世界结构摘要（塞进底图生图提示词）。 */
export function summarizeWorldStructure(world: WorldStructure): string {
  const names = world.zones.map((zone) => zone.name).join('、');
  return `${world.zones.length} 个区域：${names}`;
}
