/**
 * 房间规则运行时（M9.4）：一个房间一个 `RuleRuntime`，生命周期与房间绑定。
 *
 * 职责（docs/RULES-MODEL §7/§8/§9）：
 * - 用「roomId + 启动盐」派生的 `roomSeed` 建运行时（种子写进快照，续团可复现）；
 * - 落座/换座把玩家卡实例化进运行时：新卡（`trpg.card/1`）直接用，旧 engine 卡走 `migrateLegacyCard`；
 * - 为协议层提供 `actorId ↔ playerId` 映射与视图数据（不把 RuleRuntime 暴露给协议层）；
 * - 运行态快照 `exportState()` / `importState()`；规则不存在/版本漂移/快照不兼容时降级（`degraded` + warnings）；
 * - 未装备物品的 host 侧背包（`bagByActor`）：规则模型的装备实例必须落在已声明槽位里，
 *   所以「卸下」的物品由 host 暂存，随房间快照一起保存（`ruleBags`），续团不丢物品。
 */
import { createHash } from 'node:crypto';
import {
  CARD_SCHEMA_VERSION,
  createRuleRuntime,
  migrateLegacyCard,
  type CardInstance,
  type EquipmentInstanceDef,
  type RulePack,
  type RuleRuntime,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type SpawnSide,
} from '@dsh-trpg/rules';
import type { PlayerId } from '@dsh-trpg/protocol';

/** 宿主导入的一条规则脚本（内容包 `rules/scripts/*.js` 的源码 + 清单 sha256）。 */
export interface RoomRuleScript {
  file: string;
  code: string;
  sha256: string;
}

/** host 注入的规则解析结果（只读：规则数据 + 脚本源码 + 指纹）。 */
export interface RoomRulesInput {
  rules: RulePack;
  scripts?: readonly RoomRuleScript[];
  /**
   * 规则数据 + 脚本 sha256 的规范化指纹（续团漂移检测；不进随机流）。
   * 缺省由 rooms 自己按 `hashRules()` 算。
   */
  rulesHash?: string;
}

/** 规则解析器：host 的 pack registry 实现（rooms 包不依赖 content 包）。 */
export interface RoomRulesResolver {
  resolveRules(packId: string, moduleId?: string): RoomRulesInput | undefined;
}

export interface RoomRulePosition {
  zoneId?: string;
  cell: { x: number; y: number };
}

export interface RoomRuleSeatInput {
  playerId: PlayerId;
  name: string;
  /** 旧 engine 卡（schemaVersion: 1）或新卡实例（trpg.card/1）。 */
  card: unknown;
}

export interface RoomRuleSeatResult {
  actorId?: string;
  /** 迁移/校验过程中的提示（人话中文）。 */
  warnings: string[];
  /** 有值 = 这张卡没能进入运行时（房间其余功能照常）。 */
  error?: string;
}

export interface RoomRulesRoomOptions {
  roomId: string;
  rules: RulePack;
  scripts?: readonly RoomRuleScript[];
  rulesSeed: number;
  rulesHash?: string;
  onEvent?: (event: RuntimeEvent) => void;
  warnings?: readonly string[];
}

/** 规则数据 + 脚本的稳定指纹（JSON 序列化 + 脚本清单排序；profile 内稳定）。 */
export function hashRules(rules: RulePack, scripts?: readonly RoomRuleScript[]): string {
  const scriptPart = [...(scripts ?? [])]
    .map((script) => `${script.file}:${script.sha256}`)
    .sort()
    .join('|');
  return createHash('sha256')
    .update(JSON.stringify(rules))
    .update('|')
    .update(scriptPart)
    .digest('hex');
}

/** 由 roomId + 启动盐派生规则运行时种子（非负 32 位整数；写进快照后固定）。 */
export function deriveRulesSeed(roomId: string, salt: string): number {
  const digest = createHash('sha256').update(`rules:${salt}:${roomId}`).digest();
  return digest.readUInt32BE(0);
}

/** 旧卡 / 新卡 → 卡实例（不合法时给 error + warnings，不抛）。 */
export function toCardInstance(
  rules: RulePack,
  raw: unknown,
): { card?: CardInstance; warnings: string[]; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { warnings: [], error: '角色卡必须是对象' };
  }
  const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion === CARD_SCHEMA_VERSION) {
    const card = structuredClone(raw) as CardInstance;
    if (typeof card.rulesId !== 'string' || card.rulesId.length === 0) {
      return { warnings: [], error: '角色卡缺少 rulesId' };
    }
    if (card.rulesId !== rules.rulesId) {
      return { warnings: [], error: `角色卡规则「${card.rulesId}」与房间规则「${rules.rulesId}」不一致，未进入规则运行时` };
    }
    return { card, warnings: [] };
  }
  const migrated = migrateLegacyCard(raw, rules);
  if (!migrated.ok || migrated.card === undefined) {
    return { warnings: migrated.warnings, error: `旧卡迁移失败：${migrated.errors.join('；')}` };
  }
  return { card: migrated.card, warnings: migrated.warnings };
}

/** 地图出生点单元格（按地图声明顺序；`team` 缺省取 `side`）。 */
function spawnCellsOf(rules: RulePack, mapId: string | undefined, side: SpawnSide): Array<{ x: number; y: number }> {
  const maps = rules.space?.battleMaps ?? [];
  const map = mapId === undefined ? maps[0] : maps.find((candidate) => candidate.mapId === mapId);
  const cells: Array<{ x: number; y: number }> = [];
  for (const spawn of map?.spawns ?? []) {
    const spawnSide = spawn.team ?? spawn.side ?? 'neutral';
    if (spawnSide !== side) continue;
    for (const cell of spawn.cells ?? []) cells.push({ x: cell[0], y: cell[1] });
    if (spawn.cells === undefined && spawn.x !== undefined && spawn.y !== undefined) {
      cells.push({ x: spawn.x, y: spawn.y });
    }
  }
  return cells;
}

/**
 * 一个房间的规则运行时容器。
 *
 * 构造可能抛 `RuleRuntimeError`（脚本 sha256 不符 / 脚本加载失败）——调用方（RoomService）
 * 捕获后把房间标记为规则降级，房间照常开局/续团。
 */
export class RoomRulesRoom {
  readonly runtime: RuleRuntime;
  readonly rules: RulePack;
  readonly rulesHash: string;
  readonly rulesSeed: number;
  /** 规则不可用/快照不兼容时的降级标记（房间仍可玩，规则命令报中文错误）。 */
  degraded = false;
  readonly warnings: string[];

  private readonly roomId: string;
  private readonly onEvent?: (event: RuntimeEvent) => void;
  private readonly actorByPlayer = new Map<PlayerId, string>();
  private readonly playerByActor = new Map<string, PlayerId>();
  private readonly bagByActor = new Map<string, EquipmentInstanceDef[]>();
  private readonly unsubscribe: () => void;

  constructor(options: RoomRulesRoomOptions) {
    this.roomId = options.roomId;
    this.rules = options.rules;
    this.rulesSeed = options.rulesSeed;
    this.rulesHash = options.rulesHash ?? hashRules(options.rules, options.scripts);
    this.warnings = [...(options.warnings ?? [])];
    this.onEvent = options.onEvent;
    this.runtime = createRuleRuntime({
      rules: options.rules,
      roomSeed: this.rulesSeed,
      ...(options.scripts !== undefined && options.scripts.length > 0
        ? { scripts: options.scripts.map((script) => ({ file: script.file, code: script.code, sha256: script.sha256 })) }
        : {}),
    });
    this.unsubscribe = this.runtime.subscribe((event) => {
      try {
        this.onEvent?.(event);
      } catch {
        /* 广播异常不影响运行时 */
      }
    });
  }

  get roomIdRef(): string {
    return this.roomId;
  }

  get rulesId(): string {
    return this.rules.rulesId;
  }

  get rulesVersion(): string {
    return this.rules.rulesVersion;
  }

  isCombatActive(): boolean {
    return this.runtime.getCombat().active;
  }

  actorIdOfPlayer(playerId: PlayerId): string | undefined {
    return this.actorByPlayer.get(playerId);
  }

  playerIdOfActor(actorId: string): PlayerId | undefined {
    return this.playerByActor.get(actorId);
  }

  /** 已落座的玩家（playerId → actorId）。 */
  playerActors(): Array<{ playerId: PlayerId; actorId: string }> {
    return [...this.actorByPlayer.entries()].map(([playerId, actorId]) => ({ playerId, actorId }));
  }

  hasActor(actorId: string): boolean {
    return this.runtime.getActor(actorId).ok;
  }

  /** 旧卡/新卡 → 卡实例（host 加敌人等场景用；不写运行时）。 */
  prepareCard(raw: unknown): { card?: CardInstance; warnings: string[]; error?: string } {
    return toCardInstance(this.rules, raw);
  }

  nextNpcActorId(): string {
    for (let index = 1; index <= 999; index += 1) {
      const candidate = `npc:${index}`;
      if (!this.hasActor(candidate)) return candidate;
    }
    return `npc:${Date.now()}`;
  }

  /** 玩家出生格（按已落座顺序分派；规则包没有战斗地图时 undefined）。 */
  playerSpawnCell(seatIndex: number): RoomRulePosition | undefined {
    const maps = this.rules.space?.battleMaps ?? [];
    for (const map of maps) {
      const cells = spawnCellsOf(this.rules, map.mapId, 'player');
      if (cells.length === 0) continue;
      const cell = cells[seatIndex % cells.length] as { x: number; y: number };
      return { cell: { x: cell.x, y: cell.y }, ...(typeof map.zoneId === 'string' ? { zoneId: map.zoneId } : {}) };
    }
    return undefined;
  }

  /** 敌人出生格（指定战斗地图；缺省第一张图）。 */
  enemySpawnCell(mapId: string | undefined, index: number): RoomRulePosition | undefined {
    const cells = spawnCellsOf(this.rules, mapId, 'enemy');
    if (cells.length === 0) return undefined;
    const cell = cells[index % cells.length] as { x: number; y: number };
    const map = mapId === undefined
      ? (this.rules.space?.battleMaps ?? [])[0]
      : (this.rules.space?.battleMaps ?? []).find((candidate) => candidate.mapId === mapId);
    return { cell: { x: cell.x, y: cell.y }, ...(typeof map?.zoneId === 'string' ? { zoneId: map.zoneId } : {}) };
  }

  /** 把一张卡实例化进运行时（同一玩家换卡 = 先移除旧行动者，战斗中拒绝）。 */
  addPlayer(input: RoomRuleSeatInput): RoomRuleSeatResult {
    const converted = toCardInstance(this.rules, input.card);
    const warnings = [...converted.warnings];
    if (converted.card === undefined) {
      return { warnings, error: converted.error ?? '角色卡无法转换为规则卡实例' };
    }
    const existing = this.actorByPlayer.get(input.playerId);
    if (existing !== undefined) {
      if (this.isCombatActive()) {
        return { warnings, error: '战斗进行中，不能更换角色卡（先结束战斗再换卡）' };
      }
      const removed = this.runtime.removeActor(existing);
      if (!removed.ok) return { warnings, error: `移除旧行动者失败：${removed.error.messageZh}` };
      this.actorByPlayer.delete(input.playerId);
      this.playerByActor.delete(existing);
      this.bagByActor.delete(existing);
    }
    const actorId = `pc:${input.playerId}`;
    const spawn = this.playerSpawnCell(this.actorByPlayer.size);
    const added = this.runtime.addActor({
      card: converted.card,
      actorId,
      name: input.name,
      team: 'player',
      ...(spawn !== undefined ? { position: { cell: spawn.cell, ...(spawn.zoneId !== undefined ? { zoneId: spawn.zoneId } : {}) } } : {}),
    });
    if (!added.ok) {
      return { warnings, error: `角色卡未通过规则校验：${added.error.messageZh}` };
    }
    this.actorByPlayer.set(input.playerId, actorId);
    this.playerByActor.set(actorId, input.playerId);
    if (!this.bagByActor.has(actorId)) this.bagByActor.set(actorId, []);
    this.noteWarnings(warnings);
    return { actorId, warnings };
  }

  /** 玩家离开/被踢：移出运行时（战斗中保留行动者，避免破坏先攻表）。 */
  removePlayer(playerId: PlayerId): { removed: boolean; error?: string } {
    const actorId = this.actorByPlayer.get(playerId);
    if (actorId === undefined) return { removed: false };
    if (this.isCombatActive()) return { removed: false, error: '战斗进行中，行动者保留到战斗结束' };
    const removed = this.runtime.removeActor(actorId);
    if (!removed.ok) return { removed: false, error: removed.error.messageZh };
    this.actorByPlayer.delete(playerId);
    this.playerByActor.delete(actorId);
    this.bagByActor.delete(actorId);
    return { removed: true };
  }

  /**
   * 快照恢复后对齐座位：补上缺失的玩家行动者，清掉已不在座位的玩家行动者（战斗外）。
   * 已导入的运行态（含 HP/资源/行动经济）保持不动；`pc:<playerId>` 约定用于从运行态恢复映射。
   */
  syncPlayers(players: ReadonlyArray<{ playerId: PlayerId; name: string; card?: unknown }>): string[] {
    const warnings: string[] = [];
    const seated = new Set(players.map((player) => player.playerId));
    // 1) 已导入的运行态里已有行动者：按 actorId 约定恢复 playerId ↔ actorId 映射
    if (this.actorByPlayer.size === 0) {
      for (const actor of this.runtime.listActors()) {
        if (!actor.actorId.startsWith('pc:')) continue;
        const playerId = actor.actorId.slice('pc:'.length);
        if (!seated.has(playerId)) continue;
        if (this.actorByPlayer.has(playerId)) continue;
        this.actorByPlayer.set(playerId, actor.actorId);
        this.playerByActor.set(actor.actorId, playerId);
        if (!this.bagByActor.has(actor.actorId)) this.bagByActor.set(actor.actorId, []);
      }
    }
    if (!this.isCombatActive()) {
      for (const [playerId, actorId] of [...this.actorByPlayer.entries()]) {
        if (seated.has(playerId)) continue;
        const removed = this.runtime.removeActor(actorId);
        if (!removed.ok) continue;
        this.actorByPlayer.delete(playerId);
        this.playerByActor.delete(actorId);
        this.bagByActor.delete(actorId);
      }
    }
    for (const player of players) {
      if (player.card === undefined) continue;
      if (this.actorByPlayer.has(player.playerId)) continue;
      const added = this.addPlayer({ playerId: player.playerId, name: player.name, card: player.card });
      if (added.error !== undefined) warnings.push(`${player.name}：${added.error}`);
    }
    return warnings;
  }

  /** 运行态快照（纯 JSON）。 */
  exportRuleState(): RuntimeSnapshot {
    return this.runtime.exportState();
  }

  /** 导入运行态快照；不兼容（rulesId/rulesVersion/结构）时返回中文错误，由调用方降级。 */
  importRuleState(state: unknown): { ok: boolean; errors: string[] } {
    const result = this.runtime.importState(state);
    if (result.ok) return { ok: true, errors: [] };
    return { ok: false, errors: [result.error.messageZh] };
  }

  bagOf(actorId: string): readonly EquipmentInstanceDef[] {
    return this.bagByActor.get(actorId) ?? [];
  }

  addToBag(actorId: string, item: EquipmentInstanceDef): void {
    const bag = this.bagByActor.get(actorId) ?? [];
    bag.push(structuredClone(item));
    this.bagByActor.set(actorId, bag);
  }

  removeFromBag(actorId: string, instanceId: string): EquipmentInstanceDef | undefined {
    const bag = this.bagByActor.get(actorId) ?? [];
    const index = bag.findIndex((item) => item.instanceId === instanceId);
    if (index < 0) return undefined;
    const [removed] = bag.splice(index, 1);
    this.bagByActor.set(actorId, bag);
    return removed;
  }

  exportBags(): Record<string, EquipmentInstanceDef[]> {
    const output: Record<string, EquipmentInstanceDef[]> = {};
    for (const [actorId, bag] of this.bagByActor.entries()) {
      if (bag.length === 0) continue;
      output[actorId] = structuredClone(bag);
    }
    return output;
  }

  importBags(raw: unknown): void {
    this.bagByActor.clear();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    for (const [actorId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const items: EquipmentInstanceDef[] = [];
      for (const item of value) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.instanceId !== 'string' || record.instanceId.length === 0) continue;
        items.push(structuredClone(record) as unknown as EquipmentInstanceDef);
      }
      if (items.length > 0) this.bagByActor.set(actorId, items);
    }
  }

  noteWarnings(warnings: readonly string[]): void {
    for (const warning of warnings) {
      if (this.warnings.length >= 20) break;
      this.warnings.push(warning);
    }
  }

  dispose(): void {
    try {
      this.unsubscribe();
    } catch {
      /* ignore */
    }
    this.runtime.dispose();
  }
}

/** 规则卡实例是不是「新卡」（供 host 侧判定是否需要迁移）。 */
export function isTrpgCardInstance(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { schemaVersion?: unknown }).schemaVersion === CARD_SCHEMA_VERSION;
}
