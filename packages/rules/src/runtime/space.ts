/**
 * 场地（space）：zone-grid 规则下的位置状态、距离、视线、地形/障碍/出生点。
 *
 * 只做「谁在哪、隔多远、有没有掩体、能不能走过去」（docs/RULES-MODEL §3 space），
 * **不渲染、不管 UI**。结构数据（terrain/obstacles/spawns）是权威，底图只是皮肤。
 *
 * 距离四模式（`space.distanceMode`）：
 * - `chebyshev`：八方向同耗 → max(dx,dy)
 * - `manhattan`：四方向 → dx+dy
 * - `dnd5e`：斜向 5-10-5 交替 → max(dx,dy)+floor(min(dx,dy)/2)
 * - `euclid`：斜向按 √2 → round(√(dx²+dy²))
 */
import type { BattleMapDef, CoverDef, DistanceMode, RangeBand, RulePack, SpaceModel, TerrainDef, ZoneDef } from '../types.ts';
import type { RuntimeEnv } from './env.ts';
import type { ActorState, CellPoint, PositionState } from './types.ts';
import { RuleRuntimeError } from './types.ts';
import { isFiniteNumber, isRecord } from './util.ts';

// ---------------------------------------------------------------------------
// 距离 / 视线（纯函数）
// ---------------------------------------------------------------------------

/** 两点格距离（按 space.distanceMode）。 */
export function distanceBetween(a: CellPoint, b: CellPoint, mode: DistanceMode): number {
  const dx = Math.abs(Math.trunc(a.x) - Math.trunc(b.x));
  const dy = Math.abs(Math.trunc(a.y) - Math.trunc(b.y));
  const max = Math.max(dx, dy);
  const min = Math.min(dx, dy);
  switch (mode) {
    case 'manhattan':
      return dx + dy;
    case 'dnd5e':
      return max + Math.floor(min / 2);
    case 'euclid':
      return Math.round(Math.sqrt(dx * dx + dy * dy));
    case 'chebyshev':
    default:
      return max;
  }
}

/** 格子距离 → 距离档位（≤1 接触 / ≤5 近距 / 更远）。 */
export function bandForCellsDistance(distance: number): RangeBand {
  if (distance <= 1) return 'engaged';
  if (distance <= 5) return 'near';
  return 'far';
}

/** 区域跳数 → 距离档位（同区接触 / 一跳近距 / 更远）。 */
export function bandForZoneHops(hops: number): RangeBand {
  if (hops <= 0) return 'engaged';
  if (hops <= 1) return 'near';
  return 'far';
}

/** Bresenham 直线（含两端点，按 x 主轴或 y 主轴都能正确走）。 */
export function bresenhamLine(from: CellPoint, to: CellPoint): CellPoint[] {
  const x0 = Math.trunc(from.x);
  const y0 = Math.trunc(from.y);
  const x1 = Math.trunc(to.x);
  const y1 = Math.trunc(to.y);
  const cells: CellPoint[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    cells.push({ x, y });
    if (x === x1 && y === y1) break;
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubled < dx) {
      error += dx;
      y += sy;
    }
    if (cells.length > 4096) break;
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 移动计划
// ---------------------------------------------------------------------------

export interface MovePlan {
  ok: boolean;
  /** 消耗移动力（地形 moveCost 之和，目标格计入、起点不计）。 */
  cost: number;
  /** 走过的格子（不含起点，含终点）。 */
  path: CellPoint[];
  reason?: string;
  blockedAt?: CellPoint;
}

// ---------------------------------------------------------------------------
// SpaceRuntime
// ---------------------------------------------------------------------------

export class SpaceRuntime {
  private readonly rules: RulePack;
  private readonly maps = new Map<string, BattleMapDef>();
  private readonly terrainDefs = new Map<string, TerrainDef>();
  private readonly zones = new Map<string, ZoneDef>();
  private readonly coverDefs = new Map<string, CoverDef>();

  readonly model: SpaceModel;
  readonly distanceMode: DistanceMode;
  readonly cellMeters: number;

  constructor(rules: RulePack) {
    this.rules = rules;
    const space = rules.space;
    this.model = space?.model ?? 'none';
    this.distanceMode = space?.distanceMode ?? 'chebyshev';
    const gridCell = space?.grid?.cellMeters;
    const units = space?.units;
    const unitCell = isRecord(units) && isFiniteNumber(units.cell) ? units.cell : undefined;
    this.cellMeters = isFiniteNumber(gridCell) ? gridCell : unitCell ?? 1;
    for (const map of space?.battleMaps ?? []) this.maps.set(map.mapId, map);
    for (const terrain of space?.terrains ?? []) this.terrainDefs.set(terrain.id, terrain);
    for (const zone of space?.zones ?? []) this.zones.set(zone.zoneId, zone);
    for (const cover of space?.covers ?? []) this.coverDefs.set(cover.id, cover);
  }

  get rulesRef(): RulePack {
    return this.rules;
  }

  hasMaps(): boolean {
    return this.maps.size > 0;
  }

  get zoneIds(): string[] {
    return [...this.zones.keys()];
  }

  getZone(zoneId: string): ZoneDef | undefined {
    return this.zones.get(zoneId);
  }

  getMap(mapId: string): BattleMapDef | undefined {
    return this.maps.get(mapId);
  }

  firstMapId(): string | undefined {
    return this.maps.keys().next().value;
  }

  mapIdForZone(zoneId: string | undefined): string | undefined {
    if (zoneId === undefined) return undefined;
    const zone = this.zones.get(zoneId);
    if (zone?.battleMapId !== undefined && zone.battleMapId !== null) return zone.battleMapId;
    for (const map of this.maps.values()) if (map.zoneId === zoneId) return map.mapId;
    return undefined;
  }

  /** 激活战斗地图（写入 state.space.mapId）；不存在抛 RuleRuntimeError。 */
  activateMap(state: { mapId?: string }, mapId: string): BattleMapDef {
    const map = this.maps.get(mapId);
    if (map === undefined) {
      throw new RuleRuntimeError('unknown_map', `规则包没有战斗地图「${mapId}」`, `已有地图：${[...this.maps.keys()].join(' / ') || '无'}`);
    }
    state.mapId = mapId;
    return map;
  }

  /** 解析当前地图：state.space.mapId > 角色所在区域的 battleMapId > 第一张图。 */
  resolveMapFor(state: { mapId?: string }, position: PositionState | undefined): BattleMapDef | undefined {
    if (state.mapId !== undefined) return this.maps.get(state.mapId);
    const byZone = this.mapIdForZone(position?.zoneId);
    if (byZone !== undefined) return this.maps.get(byZone);
    const first = this.firstMapId();
    return first === undefined ? undefined : this.maps.get(first);
  }

  inBounds(map: BattleMapDef, cell: CellPoint): boolean {
    return cell.x >= 0 && cell.y >= 0 && cell.x < map.cols && cell.y < map.rows;
  }

  obstacleAt(map: BattleMapDef, cell: CellPoint): { coverId?: string; terrain?: string; kind?: string } | undefined {
    for (const obstacle of map.obstacles ?? []) {
      const w = obstacle.w ?? 1;
      const h = obstacle.h ?? 1;
      if (cell.x >= obstacle.x && cell.x < obstacle.x + w && cell.y >= obstacle.y && cell.y < obstacle.y + h) {
        return obstacle;
      }
    }
    return undefined;
  }

  terrainIdAt(map: BattleMapDef, cell: CellPoint): string | undefined {
    if (!this.inBounds(map, cell)) return undefined;
    const row = map.terrain?.[cell.y];
    return row === undefined ? undefined : row[cell.x];
  }

  terrainAt(map: BattleMapDef, cell: CellPoint): TerrainDef | undefined {
    const terrainId = this.terrainIdAt(map, cell);
    return terrainId === undefined ? undefined : this.terrainDefs.get(terrainId);
  }

  isBlocked(map: BattleMapDef, cell: CellPoint): boolean {
    if (!this.inBounds(map, cell)) return true;
    const obstacle = this.obstacleAt(map, cell);
    if (obstacle !== undefined) return true;
    const terrain = this.terrainAt(map, cell);
    return terrain?.blocksMove === true;
  }

  /** 单格移动力消耗（地形 moveCost，缺省 1）。 */
  moveCostAt(map: BattleMapDef, cell: CellPoint): number {
    const terrain = this.terrainAt(map, cell);
    const cost = terrain?.moveCost;
    if (!isFiniteNumber(cost) || cost < 0) return 1;
    return cost;
  }

  /** 规划一次格子移动（边界/障碍/Bresenham 路径/地形消耗）。 */
  planPath(map: BattleMapDef | undefined, from: CellPoint, to: CellPoint): MovePlan {
    if (map === undefined) {
      return { ok: false, cost: 0, path: [], reason: '没有激活的战斗地图' };
    }
    if (!this.inBounds(map, to)) {
      return { ok: false, cost: 0, path: [], reason: `目标格 (${to.x},${to.y}) 越界（地图 ${map.cols}×${map.rows}）` };
    }
    if (!this.inBounds(map, from)) {
      return { ok: false, cost: 0, path: [], reason: `起点格 (${from.x},${from.y}) 越界（地图 ${map.cols}×${map.rows}）` };
    }
    if (from.x === to.x && from.y === to.y) return { ok: true, cost: 0, path: [] };
    const line = bresenhamLine(from, to);
    const path = line.slice(1);
    let cost = 0;
    for (const cell of path) {
      if (this.isBlocked(map, cell)) {
        const obstacle = this.obstacleAt(map, cell);
        const terrain = this.terrainAt(map, cell);
        const reason = obstacle !== undefined
          ? `路径被障碍物挡住（${cell.x},${cell.y}${obstacle.coverId !== undefined ? `，掩体 ${obstacle.coverId}` : ''}）`
          : `路径被地形挡住（${cell.x},${cell.y}${terrain !== undefined ? `，${terrain.name}` : ''}）`;
        return { ok: false, cost, path, reason, blockedAt: cell };
      }
      cost += this.moveCostAt(map, cell);
    }
    return { ok: true, cost, path };
  }

  /** Bresenham 视线：中间格 terrain.blocksSight 或阻挡性障碍则不可见。 */
  lineOfSight(map: BattleMapDef | undefined, from: CellPoint, to: CellPoint): { visible: boolean; blockedAt?: CellPoint } {
    if (map === undefined) return { visible: true };
    const line = bresenhamLine(from, to);
    for (let index = 1; index < line.length - 1; index += 1) {
      const cell = line[index] as CellPoint;
      const terrain = this.terrainAt(map, cell);
      if (terrain?.blocksSight === true) return { visible: false, blockedAt: cell };
      const obstacle = this.obstacleAt(map, cell);
      if (obstacle !== undefined) {
        const obstacleTerrain = obstacle.terrain === undefined ? undefined : this.terrainDefs.get(obstacle.terrain);
        if (obstacleTerrain?.blocksSight === true || obstacle.kind === 'wall') {
          return { visible: false, blockedAt: cell };
        }
      }
    }
    return { visible: true };
  }

  /** 地图出生点（按阵营展开成格子）。 */
  spawnCells(mapId: string | undefined, side: 'player' | 'enemy' | 'neutral'): CellPoint[] {
    const map = mapId === undefined ? undefined : this.maps.get(mapId);
    if (map === undefined) return [];
    const cells: CellPoint[] = [];
    for (const spawn of map.spawns ?? []) {
      const spawnSide = spawn.team ?? spawn.side ?? 'neutral';
      if (spawnSide !== side) continue;
      for (const cell of spawn.cells ?? []) cells.push({ x: cell[0], y: cell[1] });
      if (spawn.cells === undefined && spawn.x !== undefined && spawn.y !== undefined) {
        cells.push({ x: spawn.x, y: spawn.y });
      }
    }
    return cells;
  }

  /** 指定格（或相邻）的掩体加成。 */
  coverAt(map: BattleMapDef | undefined, cell: CellPoint): { coverId?: string; defenseBonus: number; tags: string[] } {
    if (map === undefined) return { defenseBonus: 0, tags: [] };
    const nearby: CellPoint[] = [{ x: cell.x, y: cell.y }];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        nearby.push({ x: cell.x + dx, y: cell.y + dy });
      }
    }
    let best: { coverId?: string; defenseBonus: number; tags: string[] } = { defenseBonus: 0, tags: [] };
    for (const candidate of nearby) {
      const obstacle = this.obstacleAt(map, candidate);
      if (obstacle?.coverId === undefined) continue;
      const cover = this.coverDefs.get(obstacle.coverId);
      const bonus = cover?.defenseBonus ?? 0;
      if (bonus > best.defenseBonus) {
        best = {
          coverId: obstacle.coverId,
          defenseBonus: bonus,
          tags: cover?.tags === undefined ? [] : [...cover.tags],
        };
      }
    }
    return best;
  }

  /** 区域跳数（沿有向 connections BFS；同区 0；不可达 undefined）。 */
  zoneHops(fromZoneId: string, toZoneId: string): number | undefined {
    if (fromZoneId === toZoneId) return 0;
    const visited = new Set<string>([fromZoneId]);
    let frontier: Array<{ zoneId: string; hops: number }> = [{ zoneId: fromZoneId, hops: 0 }];
    while (frontier.length > 0) {
      const next: Array<{ zoneId: string; hops: number }> = [];
      for (const node of frontier) {
        const zone = this.zones.get(node.zoneId);
        for (const connection of zone?.connections ?? []) {
          if (connection.to === toZoneId) return node.hops + 1;
          if (visited.has(connection.to)) continue;
          visited.add(connection.to);
          next.push({ zoneId: connection.to, hops: node.hops + 1 });
        }
      }
      frontier = next;
    }
    return undefined;
  }

  /** 两位置的距离（格子优先；跨区用区域跳数）；无场地返回 null。 */
  distanceOf(
    from: PositionState,
    to: PositionState,
  ): { distance: number; band: RangeBand | null; basis: 'cells' | 'zones' | 'none' } {
    if (this.model === 'none') return { distance: 0, band: null, basis: 'none' };
    if (from.cell !== undefined && to.cell !== undefined) {
      const sameZone = from.zoneId === undefined || to.zoneId === undefined || from.zoneId === to.zoneId;
      if (sameZone) {
        const distance = distanceBetween(from.cell, to.cell, this.distanceMode);
        return { distance, band: bandForCellsDistance(distance), basis: 'cells' };
      }
    }
    if (from.zoneId !== undefined && to.zoneId !== undefined) {
      const hops = this.zoneHops(from.zoneId, to.zoneId);
      if (hops !== undefined) return { distance: hops, band: bandForZoneHops(hops), basis: 'zones' };
    }
    if (from.cell !== undefined && to.cell !== undefined) {
      const distance = distanceBetween(from.cell, to.cell, this.distanceMode);
      return { distance, band: bandForCellsDistance(distance), basis: 'cells' };
    }
    return { distance: 0, band: bandForZoneHops(0), basis: 'zones' };
  }

  /** 米数（展示单位换算；无 cellMeters 时按 1）。 */
  metersOf(cells: number): number {
    return cells * this.cellMeters;
  }
}

// ---------------------------------------------------------------------------
// 区域进出钩子（docs/RULES-MODEL §6：专用钩子先于事件总线）
// ---------------------------------------------------------------------------

export interface ZoneTransitionRequest {
  actor: ActorState;
  from: PositionState;
  to: PositionState;
  via: string;
}

/** 执行区域离开/进入（先钩子后事件）；同区不触发。 */
export function runZoneTransition(env: RuntimeEnv, request: ZoneTransitionRequest): void {
  const fromZone = request.from.zoneId;
  const toZone = request.to.zoneId;
  if (fromZone === toZone) return;
  const actorId = request.actor.actorId;
  if (fromZone !== undefined) {
    env.hooks.call({
      hook: 'onLeaveZone',
      actorId,
      args: [{ actorId, zoneId: fromZone, toZone: toZone ?? null, via: request.via }],
      inputSummary: { fromZone, toZone, via: request.via },
      default: () => ({}),
      sideEffects: true,
    });
    env.emit('zone/leave', { actorId, zoneId: fromZone, toZone: toZone ?? null, via: request.via });
  }
  if (toZone !== undefined) {
    env.hooks.call({
      hook: 'onEnterZone',
      actorId,
      args: [{ actorId, zoneId: toZone, fromZone: fromZone ?? null, via: request.via }],
      inputSummary: { fromZone, toZone, via: request.via },
      default: () => ({}),
      sideEffects: true,
    });
    env.emit('zone/enter', { actorId, zoneId: toZone, fromZone: fromZone ?? null, via: request.via });
  }
}

/** 校验位置形状（供 move/初始化用）。 */
export function normalizePosition(raw: unknown): PositionState {
  if (!isRecord(raw)) return {};
  const position: PositionState = {};
  if (typeof raw.zoneId === 'string' && raw.zoneId.length > 0) position.zoneId = raw.zoneId;
  if (isRecord(raw.cell) && isFiniteNumber(raw.cell.x) && isFiniteNumber(raw.cell.y)) {
    position.cell = { x: Math.trunc(raw.cell.x), y: Math.trunc(raw.cell.y) };
  }
  return position;
}

/** 位置展示文本。 */
export function describePosition(position: PositionState): string {
  const parts: string[] = [];
  if (position.zoneId !== undefined) parts.push(`区域 ${position.zoneId}`);
  if (position.cell !== undefined) parts.push(`(${position.cell.x},${position.cell.y})`);
  return parts.length === 0 ? '未定位' : parts.join(' ');
}
