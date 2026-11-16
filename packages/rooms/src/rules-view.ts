/**
 * 规则投影构建（M9.4）：把运行时状态翻译成协议层只读 DTO。
 *
 * 口径（docs/RULES-MODEL §8、docs/UI-CONTRACT §5/§6）：
 * - 客户端零规则计算：属性调整、资源上限、装备词条、动作可用性、先攻/行动经济、距离档位
 *   全部由这里按房间规则包算好；
 * - 视图只读：`build*View` 不修改运行时状态；命令（equip/useItem/combat.*）由 `index.ts`
 *   调 RuleRuntime 的写接口后再重新投影；
 * - 无空间模型（`space.model = "none"`）也返回稳定形状（cols/rows = 0、terrain 空）。
 */
import {
  hitPointsResourceId,
  type ActionResultData,
  type ActorState,
  type ActorView,
  type CardInstance,
  type CheckResultData,
  type CombatView as RuleCombatView,
  type EquipmentInstanceDef,
  type EquipmentProjection,
  type MoveResultData,
  type RulePack,
  type RulePackItemDef,
  type RuleRuntime,
  type RuntimeSnapshot,
  type SheetProjection,
} from '@dsh-trpg/rules';
import type {
  ActionOutcomeView,
  CheckView,
  CombatActionEconomyEntryView,
  CombatActionEconomyView,
  CombatHpView,
  CombatInitiativeView,
  CombatMoveResult,
  CombatObstacleView,
  CombatPositionView,
  CombatStartResult,
  CombatTerrainLegendView,
  CombatTokenView,
  CombatView,
  DiceRollView,
  EquipmentSlotView,
  EquipmentStatTotalView,
  EquipmentView,
  InventoryView,
  ItemCardView,
  MoveOutcomeView,
  PlayerId,
  SheetActionCostView,
  SheetActionView,
  SheetGetResult,
  SheetSkillView,
  SheetStatusView,
  SheetView,
  WorldMapView,
  WorldMapZoneView,
} from '@dsh-trpg/protocol';
import { roomErrorFromRule, type RoomError } from './errors.ts';

/** 视图构建需要的房间侧上下文（由 `RoomService` 按房间提供）。 */
export interface RuleViewOptions {
  rules: RulePack;
  runtime: RuleRuntime;
  /** actorId → playerId（敌人/中立行动者没有归属）。 */
  playerOf: (actorId: string) => PlayerId | undefined;
  /** 未装备物品（host 侧背包）。 */
  bagOf: (actorId: string) => readonly EquipmentInstanceDef[];
}

interface BattleMapLike {
  mapId: string;
  zoneId?: string | null;
  cols: number;
  rows: number;
  terrain?: string[][];
  obstacles?: Array<{ x: number; y: number; w?: number; h?: number; kind?: string; terrain?: string; coverId?: string }>;
  backgroundAssetId?: string;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 骰面记录 → 协议 DTO。 */
export function diceRollViewOf(roll: { expr: string; dice: number[]; modifier: number; total: number }): DiceRollView {
  return { expression: roll.expr, dice: [...roll.dice], modifier: roll.modifier, total: roll.total };
}

/** 检定结果 → 协议 DTO。 */
export function checkViewOf(result: CheckResultData): CheckView {
  return {
    actorId: result.actorId,
    ...(result.targetId !== undefined ? { targetId: result.targetId } : {}),
    kind: result.kind,
    ...(result.skillId !== undefined ? { skillId: result.skillId } : {}),
    ...(result.attributeId !== undefined ? { attributeId: result.attributeId } : {}),
    dc: result.dc,
    mode: result.mode,
    d20: result.d20,
    modifier: result.modifier,
    total: result.total,
    success: result.success,
    crit: result.crit,
    fumble: result.fumble,
    degree: result.degree,
    rolls: result.rolls.map(diceRollViewOf),
    trace: { lines: [...result.trace.lines], data: { ...result.trace.data } },
  };
}

/** 动作结算结果 → 协议 DTO。 */
export function actionOutcomeOf(result: ActionResultData): ActionOutcomeView {
  const cost: SheetActionCostView = {
    ...(Object.keys(result.cost.turn).length > 0 ? { turn: { ...result.cost.turn } } : {}),
    ...(result.cost.resource !== undefined ? { resource: { ...result.cost.resource } } : {}),
  };
  return {
    actorId: result.actorId,
    actionId: result.actionId,
    actionName: result.actionName,
    kind: result.kind,
    ...(result.targetId !== undefined ? { targetId: result.targetId } : {}),
    ...(result.hit !== undefined ? { hit: result.hit } : {}),
    ...(result.crit !== undefined ? { crit: result.crit } : {}),
    ...(result.damage !== undefined
      ? {
          damage: {
            amount: result.damage.amount,
            absorbedByTempHp: result.damage.absorbedByTempHp,
            hpBefore: result.damage.hpBefore,
            hpAfter: result.damage.hpAfter,
            dead: result.damage.dead,
          },
        }
      : {}),
    ...(result.check !== undefined ? { check: checkViewOf(result.check) } : {}),
    cost,
    turn: { ...result.turn },
    autoEndedTurn: result.autoEndedTurn,
    rolls: result.rolls.map(diceRollViewOf),
    events: [...result.events],
    trace: { lines: [...result.trace.lines], data: { ...result.trace.data } },
  };
}

/** 移动结算结果 → 协议 DTO。 */
export function moveOutcomeOf(result: MoveResultData): MoveOutcomeView {
  return {
    actorId: result.actorId,
    from: {
      ...(result.from.zoneId !== undefined ? { zoneId: result.from.zoneId } : {}),
      ...(result.from.cell !== undefined ? { cell: { x: result.from.cell.x, y: result.from.cell.y } } : {}),
    },
    to: {
      ...(result.to.zoneId !== undefined ? { zoneId: result.to.zoneId } : {}),
      ...(result.to.cell !== undefined ? { cell: { x: result.to.cell.x, y: result.to.cell.y } } : {}),
    },
    cost: result.cost,
    remaining: result.remaining,
    path: result.path.map((cell) => ({ x: cell.x, y: cell.y })),
    trace: { lines: [...result.trace.lines], data: { ...result.trace.data } },
  };
}

function requireActor(options: RuleViewOptions, actorId: string): ActorView {
  const result = options.runtime.getActor(actorId);
  if (!result.ok) throw roomErrorFromRule(result.error);
  return result.actor;
}

function requireProjection(options: RuleViewOptions, actorId: string): SheetProjection {
  const result = options.runtime.getSheet(actorId);
  if (!result.ok) throw roomErrorFromRule(result.error);
  return result.projection;
}

function resourceMaxOf(options: RuleViewOptions, actorId: string, resourceId: string): number | undefined {
  const result = options.runtime.getSheet(actorId);
  if (!result.ok) return undefined;
  return result.projection.resources.find((resource) => resource.id === resourceId)?.max;
}

function hpViewOf(options: RuleViewOptions, actor: ActorState): CombatHpView | undefined {
  const hpId = hitPointsResourceId(options.rules);
  if (hpId === undefined) return undefined;
  const state = actor.card.resources?.[hpId];
  if (state === undefined || typeof state.current !== 'number') return undefined;
  const max = resourceMaxOf(options, actor.actorId, hpId);
  return { current: state.current, ...(max !== undefined ? { max } : {}) };
}

function namesOf(options: RuleViewOptions): Map<string, string> {
  const names = new Map<string, string>();
  for (const actor of options.runtime.listActors()) names.set(actor.actorId, actor.name);
  return names;
}

// ---------------------------------------------------------------------------
// 物品 / 装备 / 背包
// ---------------------------------------------------------------------------

/** 物品定义查找：优先按实例名匹配规则包 `items[]`，其次按 instanceId 当 itemId。 */
export function findItemDef(rules: RulePack, instance: EquipmentInstanceDef): RulePackItemDef | undefined {
  const items = rules.items ?? [];
  if (typeof instance.name === 'string' && instance.name.length > 0) {
    const byName = items.find((item) => item.name === instance.name);
    if (byName !== undefined) return byName;
  }
  return items.find((item) => item.itemId === instance.instanceId);
}

function itemStatViews(
  rules: RulePack,
  stats: Record<string, number> | undefined,
): ItemCardView['stats'] {
  const output: ItemCardView['stats'] = [];
  for (const [statId, value] of Object.entries(stats ?? {})) {
    const def = rules.sheet.equipment.stats.find((stat) => stat.id === statId);
    output.push({
      statId,
      name: def?.name ?? statId,
      value,
      ...(def?.icon !== undefined ? { icon: def.icon } : {}),
    });
  }
  return output;
}

function itemView(rules: RulePack, instance: EquipmentInstanceDef, equippedSlot?: string): ItemCardView {
  const def = findItemDef(rules, instance);
  const rarityDef = def?.rarity === undefined
    ? undefined
    : (rules.ui?.rarities ?? []).find((rarity) => rarity.id === def.rarity);
  const description = def?.description ?? instance.note;
  return {
    instanceId: instance.instanceId,
    itemId: def?.itemId ?? instance.instanceId,
    name: instance.name ?? def?.name ?? instance.instanceId,
    ...(def?.icon !== undefined ? { icon: def.icon } : {}),
    ...(def?.rarity !== undefined ? { rarity: def.rarity } : {}),
    ...(rarityDef?.name !== undefined ? { rarityName: rarityDef.name } : {}),
    tags: [...(instance.tags ?? def?.tags ?? [])],
    stats: itemStatViews(rules, instance.stats),
    ...(description !== undefined ? { description } : {}),
    ...(equippedSlot !== undefined ? { equippedSlot } : {}),
    count: 1,
  };
}

function itemViewsOf(options: RuleViewOptions, card: CardInstance, bag: readonly EquipmentInstanceDef[]): ItemCardView[] {
  const items: ItemCardView[] = [];
  for (const instance of card.equipmentInstances ?? []) {
    items.push(itemView(options.rules, instance, instance.slot));
  }
  for (const instance of bag) {
    items.push(itemView(options.rules, instance));
  }
  return items;
}

function buildEquipmentView(
  rules: RulePack,
  projection: EquipmentProjection,
  items: ItemCardView[],
): EquipmentView {
  const slots: EquipmentSlotView[] = rules.sheet.equipment.slots.map((slot) => {
    const slotItems = items.filter((item) => item.equippedSlot === slot.id);
    return {
      slotId: slot.id,
      name: slot.name,
      accepts: [...slot.accepts],
      count: slotItems.length,
      capacity: slot.count ?? 1,
      ...(slot.icon !== undefined ? { icon: slot.icon } : {}),
      items: slotItems,
      ...(slotItems[0] !== undefined ? { item: slotItems[0] } : {}),
    };
  });
  const statTotals: EquipmentStatTotalView[] = projection.statTotals.map((total) => ({
    statId: total.statId,
    name: total.name,
    total: total.total,
    ...(total.icon !== undefined ? { icon: total.icon } : {}),
  }));
  const trace = projection.trace.map((entry) => ({
    statId: entry.statId,
    total: entry.total,
    parts: entry.parts.map((part) => ({ ...part })),
  }));
  return { slots, statTotals, items, trace };
}

/** 背包视图（v1 与装备共用物品实例；规则包没定义容量就不给容量条）。 */
export function buildInventoryView(options: RuleViewOptions, actorId: string): InventoryView {
  const actor = requireActor(options, actorId);
  const items = itemViewsOf(options, actor.card, options.bagOf(actorId));
  return { items };
}

// ---------------------------------------------------------------------------
// 人物卡面
// ---------------------------------------------------------------------------

function turnResourceName(rules: RulePack, id: string): string {
  const resource = rules.turn.resources.find((entry) => entry.id === id);
  if (resource !== undefined) return resource.name;
  const movement = rules.turn.movement;
  if (movement !== undefined && movement.id === id) return movement.name;
  return id;
}

function actionView(
  rules: RulePack,
  projection: SheetProjection,
  actor: ActorView,
  combat: RuleCombatView,
  activeName: string | undefined,
): SheetActionView[] {
  return projection.actions.map((action) => {
    const def = rules.actions.find((candidate) => candidate.actionId === action.actionId);
    let available = action.available;
    let reason = action.reason;
    if (actor.dead) {
      available = false;
      reason = '已经倒下，不能行动';
    } else if (combat.active && combat.activeActorId !== null && combat.activeActorId !== actor.actorId) {
      available = false;
      reason = `当前轮到「${activeName ?? '别人'}」行动`;
    } else if (action.cost?.turn !== undefined) {
      for (const [id, amount] of Object.entries(action.cost.turn)) {
        const remaining = actor.turn[id] ?? 0;
        if (remaining < amount) {
          available = false;
          reason = `${turnResourceName(rules, id)}不足（需要 ${amount}，剩余 ${remaining}）`;
          break;
        }
      }
    }
    const cost: SheetActionCostView = {
      ...(action.cost?.turn !== undefined ? { turn: { ...action.cost.turn } } : {}),
      ...(action.cost?.resource !== undefined ? { resource: { ...action.cost.resource } } : {}),
    };
    return {
      actionId: action.actionId,
      name: action.name,
      kind: action.kind,
      ...(action.icon !== undefined ? { icon: action.icon } : {}),
      available,
      ...(reason !== undefined ? { reason } : {}),
      cost,
      targeting: def?.targeting !== undefined
        ? { type: def.targeting.type, range: def.targeting.range, sides: def.targeting.sides }
        : { type: 'none', range: 0, sides: 'any' },
      ...(action.description !== undefined ? { description: action.description } : {}),
    };
  });
}

function statusViewsOf(options: RuleViewOptions, actor: ActorView): SheetStatusView[] {
  const defs = new Map(options.rules.sheet.statuses.map((status) => [status.id, status]));
  return actor.effects.map((effect) => {
    const def = effect.statusId === undefined ? undefined : defs.get(effect.statusId);
    const remaining = effect.remaining < 0 ? undefined : effect.remaining;
    return {
      id: effect.statusId ?? effect.effectId,
      name: def?.name ?? effect.name,
      stacks: effect.stacks,
      ...(remaining !== undefined ? { remaining } : {}),
      ...(def?.icon !== undefined ? { icon: def.icon } : {}),
    };
  });
}

/** 人物界面投影。 */
export function buildSheetView(options: RuleViewOptions, actorId: string): SheetView {
  const actor = requireActor(options, actorId);
  const projection = requireProjection(options, actorId);
  const combat = options.runtime.getCombat();
  const names = namesOf(options);
  const activeName = combat.activeActorId === null ? undefined : names.get(combat.activeActorId);
  const items = itemViewsOf(options, actor.card, options.bagOf(actorId));
  const ownerId = options.playerOf(actorId);
  const skills: SheetSkillView[] = projection.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    ...(skill.attribute !== undefined ? { attribute: skill.attribute } : {}),
    total: skill.total,
    proficient: skill.proficient,
    bonus: skill.bonus,
    ...(skill.icon !== undefined ? { icon: skill.icon } : {}),
  }));
  return {
    cardId: actor.card.cardId,
    playerId: ownerId ?? '',
    actorId: actor.actorId,
    rulesId: projection.rulesId,
    rulesVersion: projection.rulesVersion,
    identity: {
      name: projection.identity.name,
      level: projection.identity.level,
      ...(projection.identity.race !== undefined ? { race: projection.identity.race } : {}),
      ...(projection.identity.class !== undefined ? { class: projection.identity.class } : {}),
    },
    values: { attributes: { ...projection.values }, derived: { ...projection.derived } },
    resources: projection.resources.map((resource) => ({
      id: resource.id,
      name: resource.name,
      current: resource.current,
      max: resource.max,
      ...(resource.icon !== undefined ? { icon: resource.icon } : {}),
    })),
    fields: { ...projection.fields },
    equipment: buildEquipmentView(options.rules, projection.equipment, items),
    skills,
    statuses: statusViewsOf(options, actor),
    actions: actionView(options.rules, projection, actor, combat, activeName),
    items,
    warnings: [...projection.warnings],
  };
}

/** `sheet.get` 结果（卡面 + 背包）。 */
export function buildSheetResult(options: RuleViewOptions, actorId: string): SheetGetResult {
  const sheet = buildSheetView(options, actorId);
  return { sheet, inventory: { items: sheet.items } };
}

// ---------------------------------------------------------------------------
// 装备命令规划（纯函数：只算候选装备实例数组，不写运行时）
// ---------------------------------------------------------------------------

export type EquipPlan =
  | { ok: true; instances: EquipmentInstanceDef[]; fromBag: boolean }
  | { ok: false; error: string };

/** 规划一次装备：校验槽位/标签/件数，返回替换后的装备实例数组。 */
export function planEquip(
  rules: RulePack,
  card: CardInstance,
  bag: readonly EquipmentInstanceDef[],
  slotId: string,
  instanceId: string,
): EquipPlan {
  const slot = rules.sheet.equipment.slots.find((candidate) => candidate.id === slotId);
  if (slot === undefined) {
    return { ok: false, error: `规则包没有装备槽「${slotId}」（可用：${rules.sheet.equipment.slots.map((entry) => entry.id).join(' / ')}）` };
  }
  const equipped = (card.equipmentInstances ?? []).find((instance) => instance.instanceId === instanceId);
  const inBag = bag.find((instance) => instance.instanceId === instanceId);
  const instance = equipped ?? inBag;
  if (instance === undefined) {
    return { ok: false, error: `没有编号为「${instanceId}」的物品（既不在装备里也不在背包里）` };
  }
  const tags = Array.isArray(instance.tags) ? instance.tags : [];
  const matches = slot.accepts.includes('*') || tags.some((tag) => slot.accepts.includes(tag));
  if (!matches) {
    return {
      ok: false,
      error: `物品「${instance.name ?? instanceId}」不能放进「${slot.name}」（可接受标签：${slot.accepts.join(' / ')}）`,
    };
  }
  const limit = slot.count ?? 1;
  const used = (card.equipmentInstances ?? []).filter(
    (candidate) => candidate.slot === slotId && candidate.instanceId !== instanceId,
  ).length;
  if (used >= limit) {
    return { ok: false, error: `装备槽「${slot.name}」已满（容量 ${limit} 件）` };
  }
  const instances = (card.equipmentInstances ?? [])
    .filter((candidate) => candidate.instanceId !== instanceId)
    .map((candidate) => structuredClone(candidate));
  instances.push({ ...structuredClone(instance), slot: slotId });
  return { ok: true, instances, fromBag: inBag !== undefined };
}

export type UnequipPlan =
  | { ok: true; instances: EquipmentInstanceDef[]; removed: EquipmentInstanceDef }
  | { ok: false; error: string };

/** 规划一次卸下：把指定槽位里的物品移出装备（host 侧背包接管）。 */
export function planUnequip(
  rules: RulePack,
  card: CardInstance,
  slotId: string,
  instanceId: string,
): UnequipPlan {
  const slot = rules.sheet.equipment.slots.find((candidate) => candidate.id === slotId);
  if (slot === undefined) {
    return { ok: false, error: `规则包没有装备槽「${slotId}」` };
  }
  const equipped = (card.equipmentInstances ?? []).find((instance) => instance.instanceId === instanceId);
  if (equipped === undefined) {
    return { ok: false, error: `装备里没有编号为「${instanceId}」的物品` };
  }
  if (equipped.slot !== slotId) {
    return { ok: false, error: `物品「${equipped.name ?? instanceId}」不在「${slot.name}」里（当前在槽位「${equipped.slot}」）` };
  }
  const instances = (card.equipmentInstances ?? [])
    .filter((candidate) => candidate.instanceId !== instanceId)
    .map((candidate) => structuredClone(candidate));
  return { ok: true, instances, removed: structuredClone(equipped) };
}

// ---------------------------------------------------------------------------
// 战棋战斗视图
// ---------------------------------------------------------------------------

function resolveBattleMap(rules: RulePack, snapshot: RuntimeSnapshot): BattleMapLike | undefined {
  const maps = (rules.space?.battleMaps ?? []) as unknown as BattleMapLike[];
  const activeId = snapshot.space.mapId;
  if (activeId !== undefined) {
    const active = maps.find((map) => map.mapId === activeId);
    if (active !== undefined) return active;
  }
  for (const actor of Object.values(snapshot.actors)) {
    const zoneId = actor.position.zoneId;
    if (zoneId === undefined) continue;
    const zone = (rules.space?.zones ?? []).find((candidate) => candidate.zoneId === zoneId);
    const byZone = zone?.battleMapId;
    if (typeof byZone === 'string') {
      const found = maps.find((map) => map.mapId === byZone);
      if (found !== undefined) return found;
    }
    const byMapZone = maps.find((map) => map.zoneId === zoneId);
    if (byMapZone !== undefined) return byMapZone;
  }
  return maps[0];
}

function cellMetersOf(rules: RulePack): number {
  const gridCell = rules.space?.grid?.cellMeters;
  if (typeof gridCell === 'number' && Number.isFinite(gridCell) && gridCell > 0) return gridCell;
  const units = rules.space?.units;
  if (typeof units === 'object' && units !== null) {
    const cell = (units as { cell?: unknown }).cell;
    if (typeof cell === 'number' && Number.isFinite(cell) && cell > 0) return cell;
  }
  return 1;
}

function movementMaxOf(rules: RulePack, cellMeters: number): number {
  const movement = rules.turn.movement;
  if (movement === undefined) return 0;
  if (typeof movement.cells === 'number' && Number.isFinite(movement.cells)) return Math.max(0, Math.floor(movement.cells));
  if (typeof movement.meters === 'number' && Number.isFinite(movement.meters)) {
    return Math.max(0, Math.floor(movement.meters / cellMeters));
  }
  return 0;
}

function buildActionEconomy(
  rules: RulePack,
  activeActor: ActorState | undefined,
  cellMeters: number,
): CombatActionEconomyView {
  if (activeActor === undefined) return { actorId: null, remaining: [] };
  const remaining: CombatActionEconomyEntryView[] = [];
  for (const resource of rules.turn.resources) {
    const max = typeof resource.count === 'number' ? Math.max(0, Math.floor(resource.count)) : 1;
    remaining.push({
      id: resource.id,
      name: resource.name,
      current: activeActor.turn[resource.id] ?? 0,
      max,
      ...(resource.unit !== undefined ? { unit: resource.unit } : {}),
      ...(resource.icon !== undefined ? { icon: resource.icon } : {}),
    });
  }
  const movement = rules.turn.movement;
  if (movement !== undefined) {
    remaining.push({
      id: movement.id,
      name: movement.name,
      current: activeActor.turn[movement.id] ?? 0,
      max: movementMaxOf(rules, cellMeters),
      ...(movement.unit !== undefined ? { unit: movement.unit } : {}),
    });
  }
  return { actorId: activeActor.actorId, remaining };
}

/** 战棋战斗视图（含行动经济/先攻/位置/地形；无地图时给稳定空形状）。 */
export function buildCombatView(options: RuleViewOptions): CombatView {
  const snapshot = options.runtime.exportState();
  const map = resolveBattleMap(options.rules, snapshot);
  const cellMeters = cellMetersOf(options.rules);
  const names = namesOf(options);
  const activeActorId = snapshot.combat.active ? snapshot.combat.order[snapshot.combat.activeIndex] ?? null : null;
  const positions: Record<string, CombatPositionView> = {};
  const tokens: CombatTokenView[] = [];
  for (const actor of Object.values(snapshot.actors)) {
    const cell = actor.position.cell;
    const hp = hpViewOf(options, actor);
    const playerId = options.playerOf(actor.actorId);
    const zoneId = actor.position.zoneId;
    if (cell !== undefined) {
      positions[actor.actorId] = { x: cell.x, y: cell.y, ...(zoneId !== undefined ? { zoneId } : {}) };
    }
    tokens.push({
      actorId: actor.actorId,
      name: actor.name,
      team: actor.team,
      ...(playerId !== undefined ? { playerId } : {}),
      ...(cell !== undefined ? { x: cell.x, y: cell.y } : {}),
      ...(zoneId !== undefined ? { zoneId } : {}),
      ...(hp !== undefined ? { hp } : {}),
      dead: actor.dead,
      active: activeActorId === actor.actorId,
    });
  }
  const initiative: CombatInitiativeView[] = [];
  for (const actorId of snapshot.combat.order) {
    const actor = snapshot.actors[actorId];
    if (actor === undefined) continue;
    const hp = hpViewOf(options, actor);
    const playerId = options.playerOf(actorId);
    initiative.push({
      actorId,
      name: actor.name,
      team: actor.team,
      ...(playerId !== undefined ? { playerId } : {}),
      initiative: actor.initiative ?? 0,
      roll: actor.initiativeRoll ?? 0,
      ...(hp !== undefined ? { hp } : {}),
      dead: actor.dead,
      active: activeActorId === actorId,
    });
  }
  const activeActor = activeActorId !== null ? snapshot.actors[activeActorId] : undefined;
  const activePlayerId = activeActorId !== null ? options.playerOf(activeActorId) : undefined;
  const obstacles: CombatObstacleView[] = (map?.obstacles ?? []).map((obstacle) => ({
    x: obstacle.x,
    y: obstacle.y,
    w: obstacle.w ?? 1,
    h: obstacle.h ?? 1,
    ...(obstacle.terrain !== undefined ? { terrain: obstacle.terrain } : {}),
    ...(obstacle.kind !== undefined ? { kind: obstacle.kind } : {}),
    ...(obstacle.coverId !== undefined ? { coverId: obstacle.coverId } : {}),
  }));
  const terrainLegend: CombatTerrainLegendView[] = (options.rules.space?.terrains ?? []).map((terrain) => ({
    id: terrain.id,
    name: terrain.name,
    ...(terrain.icon !== undefined ? { icon: terrain.icon } : {}),
    ...(terrain.blocksMove !== undefined ? { blocksMove: terrain.blocksMove } : {}),
    ...(terrain.blocksSight !== undefined ? { blocksSight: terrain.blocksSight } : {}),
  }));
  const warnings: string[] = [];
  if (map === undefined && (options.rules.space?.model ?? 'none') !== 'none') {
    warnings.push('当前没有激活的战斗地图：战棋视图只显示先攻与行动经济');
  }
  const combat = snapshot.combat;
  return {
    active: combat.active,
    ...(map !== undefined ? { mapId: map.mapId } : snapshot.space.mapId !== undefined ? { mapId: snapshot.space.mapId } : {}),
    ...(map?.zoneId !== undefined && map.zoneId !== null ? { zoneId: map.zoneId } : {}),
    cols: map?.cols ?? 0,
    rows: map?.rows ?? 0,
    cellMeters,
    distanceMode: options.rules.space?.distanceMode ?? 'chebyshev',
    terrain: (map?.terrain ?? []).map((row) => [...row]),
    obstacles,
    positions,
    tokens,
    initiative,
    round: combat.active ? combat.round : snapshot.time.round,
    maxRounds: combat.maxRounds,
    activeActorId,
    ...(activePlayerId !== undefined ? { activePlayerId } : {}),
    actionEconomy: buildActionEconomy(options.rules, activeActor, cellMeters),
    time: { ...snapshot.time },
    terrainLegend,
    ...(combat.overtime ? { overtime: true } : {}),
    ...(combat.limitAction !== undefined ? { limitAction: combat.limitAction } : {}),
    ...(combat.endedReason !== undefined ? { endedReason: combat.endedReason } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** 开战回包（先攻骰面 + 战斗视图）。 */
export function buildCombatStartResult(
  options: RuleViewOptions,
  rolls: ReadonlyArray<{ expr: string; dice: number[]; modifier: number; total: number }>,
): CombatStartResult {
  return { combat: buildCombatView(options), rolls: rolls.map(diceRollViewOf) };
}

/** 移动回包。 */
export function buildCombatMoveResult(options: RuleViewOptions, move: MoveResultData): CombatMoveResult {
  return { combat: buildCombatView(options), move: moveOutcomeOf(move) };
}

// ---------------------------------------------------------------------------
// 世界地图视图
// ---------------------------------------------------------------------------

/** 世界地图页投影（zone 热点/连线/队伍位置；不参与格子级判定）。 */
export function buildWorldMapView(options: RuleViewOptions): WorldMapView {
  const snapshot = options.runtime.exportState();
  const actors = Object.values(snapshot.actors);
  const members = actors.map((actor) => {
    const playerId = options.playerOf(actor.actorId);
    const cell = actor.position.cell;
    const zoneId = actor.position.zoneId;
    return {
      actorId: actor.actorId,
      ...(playerId !== undefined ? { playerId } : {}),
      name: actor.name,
      ...(zoneId !== undefined ? { zoneId } : {}),
      ...(cell !== undefined ? { x: cell.x, y: cell.y } : {}),
    };
  });
  const currentZoneId = members.find((member) => member.zoneId !== undefined)?.zoneId;
  const zones: WorldMapZoneView[] = (options.rules.space?.zones ?? []).map((zone) => ({
    zoneId: zone.zoneId,
    name: zone.name,
    ...(typeof zone.parentZoneId === 'string' ? { parentZoneId: zone.parentZoneId } : {}),
    ...(zone.hotspot !== undefined ? { hotspot: { ...zone.hotspot } } : {}),
    connections: (zone.connections ?? []).map((connection) => ({ ...connection })),
    current: currentZoneId !== undefined && zone.zoneId === currentZoneId,
    ...(typeof zone.battleMapId === 'string' ? { battleMapId: zone.battleMapId } : {}),
    ...(zone.description !== undefined ? { description: zone.description } : {}),
    explored: true,
  }));
  const world = options.rules.space?.world;
  const warnings: string[] = [];
  if (zones.length === 0 && (options.rules.space?.model ?? 'none') !== 'none') {
    warnings.push('规则包没有声明 zone：世界地图页只显示队伍位置');
  }
  return {
    ...(world?.backgroundAssetId !== undefined ? { backgroundAssetId: world.backgroundAssetId } : {}),
    ...(world?.width !== undefined ? { width: world.width } : {}),
    ...(world?.height !== undefined ? { height: world.height } : {}),
    zones,
    partyPosition: {
      ...(currentZoneId !== undefined ? { zoneId: currentZoneId } : {}),
      members,
    },
    ...(currentZoneId !== undefined ? { currentZoneId } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// 杂兵卡（开战时 host 自动生成；卡数据来自规则包）
// ---------------------------------------------------------------------------

/**
 * 按规则包生成一张「杂兵」卡（开战时 `enemies[]` 没带卡时用）。
 * 属性取规则默认值、HP 当前值给 8（上限由公式算）、等级 1；不含装备/技能/状态。
 */
export function synthesizeEnemyCard(rules: RulePack, name: string, cardId: string): CardInstance {
  const attributes: Record<string, number> = {};
  for (const attribute of rules.sheet.attributes) attributes[attribute.id] = attribute.default;
  const resources: Record<string, { current: number; max?: number }> = {};
  for (const resource of rules.sheet.resources) {
    resources[resource.id] = { current: resource.id === 'hp' ? 8 : 0 };
  }
  const fields: Record<string, string | number> = { name };
  if (rules.sheet.fields.some((field) => field.id === 'level' && field.kind === 'number')) {
    fields.level = 1;
  }
  return {
    schemaVersion: 'trpg.card/1',
    cardId,
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    attributes,
    resources,
    fields,
    equipmentInstances: [],
    skills: [],
    statuses: [],
  };
}

/** 供调用方判断是否规则错误（避免依赖具体类）。 */
export function isRuleRoomError(error: unknown): error is RoomError {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'RoomError';
}
