/**
 * 钩子调度与事务（M9.2）。
 *
 * 语义（docs/RULES-MODEL §6）：
 * - 钩子全部可选：没有脚本/该钩子未导出 → 走调用点提供的「缺省行为」（数据 + 公式）；
 * - 每次调用先给游戏状态拍快照（structuredClone），脚本可经 `ctx` 原子地改状态；
 *   抛错 / 超时 / 返回值形状非法 → **整体回滚**，广播 `rules/error`，然后退回缺省行为（房间不崩）；
 * - 同一钩子连续失败达到阈值（默认 3）→ 标记降级并停用该钩子（后续直接走缺省行为）；
 * - 单场钩子调用次数上限（默认 10000，§10）；
 * - `ctx` 能力按 §6 给：roll/rng/attr/derived/sheet/equipment/effects/resource/tables/log/turn/space；
 *   `ctx.sheet.set` 仅 onEvent / onLevelUp / migrateSheet 可用。
 */
import { LEVEL_FIELD_ID, type CardInstance, type CardStatusState, type HookName, type RollTableEntryDef, type RulePack, type StatusStackingMode } from '../types.ts';
import { HOOK_NAMES, ROUND_LIMIT_ACTIONS } from '../types.ts';
import { aggregateEquipmentStats } from '../sheet.ts';
import { rollDice, type DiceRoll } from './dice.ts';
import type { RngSession } from './rng.ts';
import {
  type ActorState,
  type ActiveEffectState,
  type CombatState,
  type EffectInput,
  type HookFailureKind,
  type RulesErrorEventData,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeLogLevel,
  type RuntimeLogSource,
  type RuntimeState,
  type SpaceState,
  type TimeState,
} from './types.ts';
import { type SandboxBridge, type ScriptLoadReport, type ScriptSandbox, type ScriptSource } from './sandbox.ts';
import { errorMessage, isFiniteNumber, isNonEmptyString, isRecord, toPlainJson } from './util.ts';

// ---------------------------------------------------------------------------
// 宿主接口
// ---------------------------------------------------------------------------

export interface HookLogInput {
  source: RuntimeLogSource;
  level: RuntimeLogLevel;
  text: string;
  hook?: string;
  actorId?: string;
}

/** 钩子调度依赖的宿主能力（由运行时实现；本文件不反向依赖运行时）。 */
export interface HookHost {
  readonly rules: RulePack;
  readonly state: RuntimeState;
  readonly config: RuntimeConfig;
  /** 开始一次随机 session（由宿主持久化计数器）。 */
  beginRoll(scope: string): RngSession;
  /** 查找角色（不存在返回 undefined）。 */
  findActor(actorId: string): ActorState | undefined;
  /** 广播事件（`rules/error` 也走这里；宿主会跳过 onEvent 防递归）。 */
  emit(kind: RuntimeEventKind, data: Record<string, unknown>): RuntimeEvent;
  log(entry: HookLogInput): void;
  /** 卡被钩子改写后的通知（宿主用于标记派生值重算）。 */
  onCardMutated(actorId: string): void;
}

// ---------------------------------------------------------------------------
// 事务：游戏状态快照
// ---------------------------------------------------------------------------

export interface GameplaySnapshot {
  actors: Record<string, ActorState>;
  combat: CombatState;
  space: SpaceState;
  time: TimeState;
  effectSeq: number;
}

export function takeGameplaySnapshot(state: RuntimeState): GameplaySnapshot {
  return structuredClone({
    actors: state.actors,
    combat: state.combat,
    space: state.space,
    time: state.time,
    effectSeq: state.effectSeq,
  });
}

/** 回滚游戏状态（事件流/计数器不回滚，保证 seq 单调、复现路径一致）。 */
export function restoreGameplaySnapshot(state: RuntimeState, snapshot: GameplaySnapshot): void {
  state.actors = structuredClone(snapshot.actors);
  state.combat = structuredClone(snapshot.combat);
  state.space = structuredClone(snapshot.space);
  state.time = structuredClone(snapshot.time);
  state.effectSeq = snapshot.effectSeq;
}

// ---------------------------------------------------------------------------
// 钩子调用定义
// ---------------------------------------------------------------------------

export interface HookRollScope {
  readonly session: RngSession;
  /** 本次调用里所有种子骰（缺省路径 + 钩子内 ctx.roll 都会记录）。 */
  readonly rolls: DiceRoll[];
  roll(expression: string): DiceRoll;
  nextFloat(): number;
}

export interface HookCtxData {
  /** `ctx.action`：当前动作定义摘要。 */
  action?: Record<string, unknown>;
  /** `ctx.target`：目标摘要。 */
  target?: Record<string, unknown>;
  /** `ctx.space` 附加数据（`{zoneId, cell, distance}`）。 */
  space?: Record<string, unknown>;
  /** `ctx.derived` 数据（缺省取行动者已算好的派生值）。 */
  derived?: Record<string, number | string>;
  /** 传给钩子的额外只读数据（`ctx.turn` 由内核补）。 */
  turn?: Record<string, unknown>;
}

export interface HookCallSpec {
  hook: HookName;
  /** 传给钩子的参数（ctx 之后的实参）。 */
  args?: readonly unknown[];
  /** 行动者（ctx.attr/sheet/effects 默认作用对象）。 */
  actorId?: string;
  targetId?: string;
  ctxData?: HookCtxData;
  /** 入参摘要（rules/error 事件用）。 */
  inputSummary?: unknown;
  /** 是否允许 `ctx.sheet.set`（仅 onEvent/onLevelUp/migrateSheet）。 */
  sheetSetAllowed?: boolean;
  /** 是否把返回值的 effects/sheetUpdates/log 落地（onEvent/回合/时间/场地钩子）。 */
  sideEffects?: boolean;
  /** 缺省行为（无钩子/钩子失败时执行；返回即结果）。 */
  default: (scope: HookRollScope) => unknown;
  /** 返回值形状校验：null = 合法，字符串 = 中文错误原因。 */
  validate?: (value: unknown) => string | null;
}

export interface HookCallOutcome<T = unknown> {
  value: T;
  usedHook: boolean;
  failed: boolean;
  rolls: DiceRoll[];
  error?: RulesErrorEventData;
}

// ---------------------------------------------------------------------------
// 返回值形状校验（docs/RULES-MODEL §6 契约）
// ---------------------------------------------------------------------------

function optionalLog(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return null;
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return null;
  return '`log` 必须是字符串或字符串数组';
}

function optionalEffects(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return '`effects` 必须是数组';
  return null;
}

function optionalSheetUpdates(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return '`sheetUpdates` 必须是 { actorId: { path: value } } 对象';
  return null;
}

function failShape(prefix: string, message: string): string {
  return `${prefix}${message}`;
}

/** 各钩子的返回值形状校验；返回中文原因或 null。 */
export function validateHookValue(hook: HookName, value: unknown): string | null {
  switch (hook) {
    case 'validateSheet': {
      if (!Array.isArray(value)) return 'validateSheet 必须返回 string[]';
      const bad = value.findIndex((item) => typeof item !== 'string');
      return bad >= 0 ? `validateSheet 第 ${bad + 1} 项不是字符串` : null;
    }
    case 'computeDerived': {
      if (!isRecord(value)) return 'computeDerived 必须返回 Record<string, number|string>';
      for (const [key, item] of Object.entries(value)) {
        if (isFiniteNumber(item)) continue;
        if (typeof item === 'string') continue;
        return `computeDerived 的 derived.${key} 必须是 number 或 string`;
      }
      return null;
    }
    case 'resolveCheck': {
      if (!isRecord(value)) return 'resolveCheck 必须返回对象 {total, success, crit?, degree?, log?}';
      if (!isFiniteNumber(value.total)) return 'resolveCheck 返回值缺少数值 total';
      if (typeof value.success !== 'boolean') return 'resolveCheck 返回值缺少布尔 success';
      if (value.crit !== undefined && typeof value.crit !== 'boolean') return 'resolveCheck 的 crit 必须是布尔值';
      if (value.degree !== undefined && typeof value.degree !== 'string') return 'resolveCheck 的 degree 必须是字符串';
      return optionalLog(value.log);
    }
    case 'resolveAttack': {
      if (!isRecord(value)) return 'resolveAttack 必须返回对象 {hit, crit, damage, reactions?, log?}';
      if (typeof value.hit !== 'boolean') return 'resolveAttack 返回值缺少布尔 hit';
      if (!isFiniteNumber(value.damage)) return 'resolveAttack 返回值缺少数值 damage';
      if (value.crit !== undefined && typeof value.crit !== 'boolean') return 'resolveAttack 的 crit 必须是布尔值';
      if (value.reactions !== undefined && !Array.isArray(value.reactions)) return 'resolveAttack 的 reactions 必须是数组';
      return optionalLog(value.log);
    }
    case 'resolveDamage': {
      if (!isRecord(value)) return 'resolveDamage 必须返回对象 {amount, consumedEffects?, notes?}';
      if (!isFiniteNumber(value.amount)) return 'resolveDamage 返回值缺少数值 amount';
      if (value.amount < 0) return 'resolveDamage 的 amount 不能为负（治疗请用（后续）heal 通道）';
      if (value.consumedEffects !== undefined) {
        if (!Array.isArray(value.consumedEffects)) return 'resolveDamage 的 consumedEffects 必须是字符串数组';
        if (!value.consumedEffects.every((item) => typeof item === 'string')) {
          return 'resolveDamage 的 consumedEffects 必须是字符串数组';
        }
      }
      if (value.notes !== undefined && typeof value.notes !== 'string') return 'resolveDamage 的 notes 必须是字符串';
      return null;
    }
    case 'onEvent': {
      if (!isRecord(value)) return 'onEvent 必须返回对象 {effects?, sheetUpdates?, log?}';
      return optionalEffects(value.effects) ?? optionalSheetUpdates(value.sheetUpdates) ?? optionalLog(value.log);
    }
    case 'onLevelUp': {
      if (!isRecord(value)) return 'onLevelUp 必须返回 sheet patch（{ 卡路径: 值 }）';
      for (const [key, item] of Object.entries(value)) {
        if (isFiniteNumber(item)) continue;
        if (typeof item === 'string') continue;
        return `onLevelUp 的 patch.${key} 必须是 number 或 string`;
      }
      return null;
    }
    case 'generateLoot': {
      if (!Array.isArray(value)) return 'generateLoot 必须返回物品实例数组';
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (!isRecord(item)) return `generateLoot 第 ${index + 1} 项必须是对象`;
        if (!isNonEmptyString(item.itemId) && !isNonEmptyString(item.name)) {
          return `generateLoot 第 ${index + 1} 项必须带 itemId 或 name`;
        }
      }
      return null;
    }
    case 'migrateSheet': {
      if (!isRecord(value)) return 'migrateSheet 必须返回新的 sheet 对象';
      return null;
    }
    case 'computeDistance': {
      if (!isRecord(value)) return 'computeDistance 必须返回 {distance, band?, path?}';
      if (!isFiniteNumber(value.distance)) return 'computeDistance 返回值缺少数值 distance';
      if (value.distance < 0) return 'computeDistance 的 distance 不能为负';
      if (value.band !== undefined && typeof value.band !== 'string') return 'computeDistance 的 band 必须是字符串';
      if (value.path !== undefined && !Array.isArray(value.path)) return 'computeDistance 的 path 必须是坐标数组';
      return null;
    }
    case 'onMove': {
      if (!isRecord(value)) return 'onMove 必须返回 {ok, remaining?, effects?, log?}';
      if (typeof value.ok !== 'boolean') return 'onMove 返回值缺少布尔 ok';
      if (value.remaining !== undefined && !isFiniteNumber(value.remaining)) return 'onMove 的 remaining 必须是数值';
      return optionalEffects(value.effects) ?? optionalLog(value.log);
    }
    case 'onEnterZone':
    case 'onLeaveZone': {
      if (!isRecord(value)) return `${hook} 必须返回 {effects?, log?}`;
      return optionalEffects(value.effects) ?? optionalLog(value.log);
    }
    case 'computeCover': {
      if (!isRecord(value)) return 'computeCover 必须返回 {defenseBonus, tags?}';
      if (!isFiniteNumber(value.defenseBonus)) return 'computeCover 返回值缺少数值 defenseBonus';
      if (value.tags !== undefined) {
        if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
          return 'computeCover 的 tags 必须是字符串数组';
        }
      }
      return null;
    }
    case 'onTimeAdvance': {
      if (!isRecord(value)) return 'onTimeAdvance 必须返回 {effects?, sheetUpdates?, log?}';
      return optionalEffects(value.effects) ?? optionalSheetUpdates(value.sheetUpdates) ?? optionalLog(value.log);
    }
    case 'onRoundStart':
    case 'onRoundEnd': {
      if (!isRecord(value)) return `${hook} 必须返回 {effects?, log?}`;
      return optionalEffects(value.effects) ?? optionalLog(value.log);
    }
    case 'onRoundLimit': {
      if (!isRecord(value)) return 'onRoundLimit 必须返回 {action, effects?, log?}';
      if (typeof value.action !== 'string' || !(ROUND_LIMIT_ACTIONS as readonly string[]).includes(value.action)) {
        return `onRoundLimit 的 action 必须是 ${ROUND_LIMIT_ACTIONS.join(' / ')} 之一`;
      }
      return optionalEffects(value.effects) ?? optionalLog(value.log);
    }
    default:
      return failShape('', `未知钩子 ${String(hook)}`);
  }
}

// ---------------------------------------------------------------------------
// 卡路径读写（ctx.sheet.get/set、onLevelUp patch、sheetUpdates）
// ---------------------------------------------------------------------------

const CARD_ROOTS = ['attributes', 'resources', 'fields', 'skills', 'statuses', 'equipmentInstances', 'notes'] as const;

function isCardRoot(value: string): boolean {
  return (CARD_ROOTS as readonly string[]).includes(value);
}

/** 读取卡上的点分路径（`level` 是 `fields.level` 的别名）。 */
export function readCardPath(card: CardInstance, path: string): unknown {
  if (path === LEVEL_FIELD_ID || path === 'level') return card.fields?.[LEVEL_FIELD_ID];
  const segments = path.split('.');
  const root = segments[0];
  if (root === undefined) return undefined;
  if (segments.length === 1) {
    if (isCardRoot(root)) return toPlainJson((card as unknown as Record<string, unknown>)[root]);
    return undefined;
  }
  let current: unknown = (card as unknown as Record<string, unknown>)[root];
  for (let index = 1; index < segments.length; index += 1) {
    const key = segments[index] as string;
    if (Array.isArray(current)) {
      const arrayIndex = Number.parseInt(key, 10);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.length) return undefined;
      current = current[arrayIndex];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current === undefined ? undefined : toPlainJson(current);
}

/**
 * 写卡（按规则包声明校验）：支持 `level`、`attributes.<id>`、`resources.<id>.current|max`、
 * `resources.<id>`（{current,max}）、`fields.<id>`、`notes`、`skills`/`statuses`/`equipmentInstances`（整体数组）。
 * 非法路径/值抛 Error（由钩子事务捕获并回滚）。
 */
export function writeCardPath(rules: RulePack, card: CardInstance, path: string, value: unknown): void {
  if (path === 'level' || path === LEVEL_FIELD_ID) {
    if (!isFiniteNumber(value) || value < 1) throw new Error(`字段「level」必须是 >=1 的数值`);
    card.fields = { ...card.fields, [LEVEL_FIELD_ID]: Math.floor(value) };
    return;
  }
  const segments = path.split('.');
  const root = segments[0];
  if (root === undefined || !isCardRoot(root)) {
    throw new Error(`不支持的卡路径「${path}」（可用：level / attributes.<id> / resources.<id>.current / fields.<id> / notes …）`);
  }
  if (root === 'attributes') {
    const attributeId = segments[1];
    if (attributeId === undefined || segments.length !== 2) throw new Error(`属性路径必须形如 attributes.<id>（收到「${path}」）`);
    const def = rules.sheet.attributes.find((attribute) => attribute.id === attributeId);
    if (def === undefined) throw new Error(`规则包没有声明属性「${attributeId}」`);
    if (!isFiniteNumber(value)) throw new Error(`属性「${attributeId}」必须是数值`);
    if (value < def.min || value > def.max) {
      throw new Error(`属性「${attributeId}」=${value} 超出规则范围 [${def.min}, ${def.max}]`);
    }
    card.attributes = { ...card.attributes, [attributeId]: value };
    return;
  }
  if (root === 'resources') {
    const resourceId = segments[1];
    if (resourceId === undefined) throw new Error(`资源路径必须形如 resources.<id>.current（收到「${path}」）`);
    const def = rules.sheet.resources.find((resource) => resource.id === resourceId);
    if (def === undefined) throw new Error(`规则包没有声明资源「${resourceId}」`);
    const state = card.resources[resourceId] ?? { current: 0 };
    if (segments.length === 2) {
      if (!isRecord(value)) throw new Error(`resources.${resourceId} 必须写成 { current, max? }`);
      const current = isFiniteNumber(value.current) ? value.current : state.current;
      if (current < 0) throw new Error(`资源「${resourceId}」的 current 不能为负`);
      const next: { current: number; max?: number } = { current };
      if (isFiniteNumber(value.max)) next.max = value.max;
      else if (isFiniteNumber(state.max)) next.max = state.max;
      card.resources = { ...card.resources, [resourceId]: next };
      return;
    }
    const field = segments[2];
    if (segments.length !== 3 || (field !== 'current' && field !== 'max')) {
      throw new Error(`资源路径只支持 resources.<id>.current / resources.<id>.max（收到「${path}」）`);
    }
    if (!isFiniteNumber(value)) throw new Error(`资源「${resourceId}」的 ${field} 必须是数值`);
    if (field === 'current' && value < 0) throw new Error(`资源「${resourceId}」的 current 不能为负`);
    const next: { current: number; max?: number } = {
      current: field === 'current' ? value : state.current,
    };
    const max = field === 'max' ? value : state.max;
    if (isFiniteNumber(max)) next.max = max;
    card.resources = { ...card.resources, [resourceId]: next };
    return;
  }
  if (root === 'fields') {
    const fieldId = segments[1];
    if (fieldId === undefined) throw new Error(`字段路径必须形如 fields.<id>（收到「${path}」）`);
    const def = rules.sheet.fields.find((field) => field.id === fieldId);
    if (def === undefined && fieldId !== LEVEL_FIELD_ID) throw new Error(`规则包没有声明字段「${fieldId}」`);
    if (def?.kind === 'number' || fieldId === LEVEL_FIELD_ID) {
      if (!isFiniteNumber(value)) throw new Error(`字段「${fieldId}」必须是数值`);
      card.fields = { ...card.fields, [fieldId]: value };
      return;
    }
    if (def?.kind === 'enum') {
      const options = def.options ?? [];
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new Error(`字段「${fieldId}」必须是枚举值之一：${options.join(' / ')}`);
      }
      card.fields = { ...card.fields, [fieldId]: value };
      return;
    }
    if (typeof value !== 'string') throw new Error(`字段「${fieldId}」必须是文本`);
    card.fields = { ...card.fields, [fieldId]: value };
    return;
  }
  if (root === 'notes') {
    if (typeof value !== 'string') throw new Error('notes 必须是字符串');
    card.notes = value;
    return;
  }
  // skills / statuses / equipmentInstances：整体数组替换（形状由 validateCard 兜底）
  if (!Array.isArray(value)) throw new Error(`${root} 必须是数组`);
  if (root === 'skills') card.skills = toPlainJson(value) as CardInstance['skills'];
  else if (root === 'statuses') card.statuses = toPlainJson(value) as CardStatusState[];
  else card.equipmentInstances = toPlainJson(value) as CardInstance['equipmentInstances'];
}

// ---------------------------------------------------------------------------
// 效果栈
// ---------------------------------------------------------------------------

interface NormalizedEffectInput {
  targetActorId: string;
  effectId?: string;
  statusId?: string;
  name: string;
  kind: 'status' | 'effect';
  stacks: number;
  remaining: number;
  stacking: string;
  data?: Record<string, number | string>;
  sourceActorId?: string;
}

function normalizeStacking(value: unknown, fallback: StatusStackingMode | string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  return fallback;
}

/** 把钩子/宿主给的 effect 输入规范化（校验失败抛 Error → 钩子事务回滚）。 */
export function normalizeEffectInput(
  rules: RulePack,
  raw: unknown,
  defaultActorId: string | undefined,
  defaultSourceActorId: string | undefined,
): NormalizedEffectInput {
  if (!isRecord(raw)) throw new Error('effects.apply 的参数必须是对象');
  const input = raw as EffectInput;
  const targetActorId = isNonEmptyString(input.targetActorId)
    ? input.targetActorId
    : defaultActorId;
  if (targetActorId === undefined) throw new Error('effects.apply 缺少 targetActorId（当前钩子没有行动者）');
  const statusId = isNonEmptyString(input.statusId) ? input.statusId : undefined;
  let statusDef: RulePack['sheet']['statuses'][number] | undefined;
  if (statusId !== undefined) {
    statusDef = rules.sheet.statuses.find((status) => status.id === statusId);
    if (statusDef === undefined) throw new Error(`规则包没有声明状态「${statusId}」`);
  }
  const durationRaw = input.remaining ?? input.duration ?? statusDef?.duration ?? 1;
  if (!isFiniteNumber(durationRaw)) throw new Error('effect 的 duration/remaining 必须是数值');
  const remaining = durationRaw > 0 ? Math.floor(durationRaw) : -1;
  const stacksRaw = input.stacks === undefined ? 1 : input.stacks;
  if (!isFiniteNumber(stacksRaw) || stacksRaw < 1) throw new Error('effect 的 stacks 必须是 >=1 的数值');
  const kind: 'status' | 'effect' = statusId !== undefined ? 'status' : input.kind === 'effect' ? 'effect' : input.kind === 'status' ? 'status' : 'effect';
  if (input.kind !== undefined && input.kind !== 'status' && input.kind !== 'effect') {
    throw new Error('effect 的 kind 必须是 "status" 或 "effect"');
  }
  const normalized: NormalizedEffectInput = {
    targetActorId,
    name: isNonEmptyString(input.name) ? input.name : statusDef?.name ?? statusId ?? '效果',
    kind,
    stacks: Math.floor(stacksRaw),
    remaining,
    stacking: normalizeStacking(input.stacking, statusDef?.stacking ?? 'refresh'),
    ...(isNonEmptyString(input.effectId) ? { effectId: input.effectId } : {}),
    ...(statusId !== undefined ? { statusId } : {}),
    ...(isNonEmptyString(defaultSourceActorId) ? { sourceActorId: defaultSourceActorId } : {}),
  };
  if (isRecord(input.data)) {
    const data: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(input.data)) {
      if (isFiniteNumber(value) || typeof value === 'string') data[key] = value;
    }
    normalized.data = data;
  }
  return normalized;
}

function effectMatches(effect: ActiveEffectState, input: NormalizedEffectInput): boolean {
  if (input.statusId !== undefined) return effect.statusId === input.statusId;
  if (input.effectId !== undefined) return effect.effectId === input.effectId;
  return effect.name === input.name;
}

/** 把状态栈同步回卡（卡 `statuses` 是投影/存档的读面；权威在内核效果栈）。 */
export function syncCardStatuses(actor: ActorState): void {
  const statuses: CardStatusState[] = [];
  for (const effect of actor.effects) {
    if (effect.kind !== 'status' || effect.statusId === undefined) continue;
    const state: CardStatusState = { id: effect.statusId, stacks: effect.stacks };
    if (effect.remaining >= 0) state.remaining = effect.remaining;
    statuses.push(state);
  }
  actor.card.statuses = statuses;
}

/** 施加效果（含叠加模式）；返回落栈后的效果。 */
export function applyEffect(
  host: HookHost,
  actor: ActorState,
  input: NormalizedEffectInput,
): ActiveEffectState {
  const existing = actor.effects.find((effect) => effectMatches(effect, input));
  if (existing === undefined) {
    host.state.effectSeq += 1;
    const effect: ActiveEffectState = {
      effectId: input.effectId ?? `eff_${host.state.effectSeq}`,
      kind: input.kind,
      name: input.name,
      stacks: input.stacks,
      remaining: input.remaining,
      ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
      ...(input.data !== undefined ? { data: { ...input.data } } : {}),
      ...(input.sourceActorId !== undefined ? { sourceActorId: input.sourceActorId } : {}),
    };
    actor.effects.push(effect);
    syncCardStatuses(actor);
    host.onCardMutated(actor.actorId);
    return effect;
  }
  const mode = input.stacking;
  if (mode === 'none') {
    syncCardStatuses(actor);
    return existing;
  }
  if (mode === 'stack') {
    existing.stacks += input.stacks;
    existing.remaining = combineRemaining(existing.remaining, input.remaining);
  } else if (mode === 'replace') {
    existing.stacks = input.stacks;
    existing.remaining = input.remaining;
    if (input.data !== undefined) existing.data = { ...input.data };
  } else {
    // refresh（默认）：刷新时长、层数取高
    existing.remaining = combineRemaining(existing.remaining, input.remaining);
    existing.stacks = Math.max(existing.stacks, input.stacks);
    if (input.data !== undefined) existing.data = { ...input.data };
  }
  syncCardStatuses(actor);
  host.onCardMutated(actor.actorId);
  return existing;
}

function combineRemaining(current: number, next: number): number {
  if (current < 0 || next < 0) return -1;
  return Math.max(current, next);
}

/** 卸下效果（按 effectId 或 statusId 匹配）。 */
export function removeEffect(host: HookHost, actor: ActorState, idOrStatusId: string): boolean {
  const before = actor.effects.length;
  actor.effects = actor.effects.filter(
    (effect) => effect.effectId !== idOrStatusId && effect.statusId !== idOrStatusId,
  );
  const removed = actor.effects.length !== before;
  if (removed) {
    syncCardStatuses(actor);
    host.onCardMutated(actor.actorId);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

export interface TablePickResult {
  tableId: string;
  roll: DiceRoll;
  entry: RollTableEntryDef | null;
}

/** 按种子掷表（`tables[].roll` + `{min,max}` 区间）。 */
export function pickFromTable(host: HookHost, tableId: string, session: RngSession): TablePickResult {
  const table = host.rules.tables?.find((entry) => entry.tableId === tableId);
  if (table === undefined) throw new Error(`规则包没有声明表格「${tableId}」`);
  const roll = rollDice(table.roll, session);
  const entry = table.entries.find((item) => roll.total >= item.min && roll.total <= item.max) ?? null;
  return { tableId, roll, entry };
}

// ---------------------------------------------------------------------------
// 调度器
// ---------------------------------------------------------------------------

export interface HookDispatcherOptions {
  sandbox?: ScriptSandbox | null;
  failureThreshold?: number;
  /**
   * 允许启用的钩子白名单（来自 `rules.scripts` 声明）。
   * 非空时，未声明的钩子即使脚本导出了也不会被调用（防止清单外的脚本偷偷接管结算）。
   * null/undefined = 不限制（宿主自带的临时脚本/测试场景）。
   */
  allowedHooks?: ReadonlySet<string> | null;
}

export class HookDispatcher {
  private readonly host: HookHost;
  private readonly sandbox: ScriptSandbox | null;
  private readonly failureThreshold: number;
  private readonly allowedHooks: ReadonlySet<string> | null;
  private limitReported = false;
  private readonly loadedReports: ScriptLoadReport[] = [];

  constructor(host: HookHost, options: HookDispatcherOptions = {}) {
    this.host = host;
    this.sandbox = options.sandbox ?? null;
    this.failureThreshold = options.failureThreshold ?? host.config.failureThreshold;
    this.allowedHooks = options.allowedHooks ?? null;
  }

  /** 加载规则脚本并返回报告；sha256 不符/加载失败的数量由运行时决定是否拒绝。 */
  loadScripts(sources: readonly ScriptSource[]): ScriptLoadReport[] {
    this.loadedReports.length = 0;
    if (this.sandbox === null) return this.loadedReports;
    for (const source of sources) {
      const report = this.sandbox.load(source);
      this.loadedReports.push(report);
    }
    return this.loadedReports;
  }

  get reports(): readonly ScriptLoadReport[] {
    return this.loadedReports;
  }

  has(hook: HookName): boolean {
    if (this.sandbox === null) return false;
    if (this.allowedHooks !== null && !this.allowedHooks.has(hook)) return false;
    if (this.host.state.disabledHooks.includes(hook)) return false;
    return this.sandbox.has(hook);
  }

  listHooks(): HookName[] {
    const hooks: HookName[] = [];
    for (const hook of HOOK_NAMES) if (this.has(hook)) hooks.push(hook);
    return hooks;
  }

  /** 调用钩子（含缺省行为/事务回滚/错误事件）。永不抛错。 */
  call<T = unknown>(spec: HookCallSpec): HookCallOutcome<T> {
    const fallback = (scope: HookRollScope): HookCallOutcome<T> => ({
      value: spec.default(scope) as T,
      usedHook: false,
      failed: false,
      rolls: scope.rolls,
    });

    // 1) 无钩子：直接缺省行为
    if (this.sandbox === null || !this.has(spec.hook)) {
      const session = this.host.beginRoll(spec.hook);
      return fallback(this.createScope(session));
    }

    // 2) 单场调用次数上限（§10）
    if (this.host.state.hookCallCount >= this.host.config.maxHookCalls) {
      if (!this.limitReported) {
        this.limitReported = true;
        this.reportFailure(
          spec,
          'limit',
          `钩子调用次数超过单场上限 ${this.host.config.maxHookCalls}，本场后续规则降级为缺省行为`,
          [],
          false,
        );
      }
      const session = this.host.beginRoll(spec.hook);
      return fallback(this.createScope(session));
    }
    this.host.state.hookCallCount += 1;

    // 3) 快照 → 执行 → 校验 → 失败回滚
    const snapshot = takeGameplaySnapshot(this.host.state);
    const session = this.host.beginRoll(spec.hook);
    const scope = this.createScope(session);
    const hookLogs: string[] = [];
    const bridge = this.buildBridge(spec, scope, hookLogs);
    const result = this.sandbox.call(spec.hook, spec.args ?? [], bridge);
    this.flushScriptLogs(spec, result.logs);
    this.flushHookLogs(spec, hookLogs);

    if (!result.ok) {
      restoreGameplaySnapshot(this.host.state, snapshot);
      const failure = result.failure ?? { kind: 'throw' as const, message: '未知脚本错误', stack: [] };
      const kind: HookFailureKind = failure.kind === 'timeout' ? 'timeout' : failure.kind === 'integrity' ? 'integrity' : 'throw';
      this.reportFailure(spec, kind, failure.message, failure.stack, true);
      return fallback(scope);
    }

    const validate = spec.validate ?? ((value: unknown) => validateHookValue(spec.hook, value));
    const shapeError = validate(result.value);
    if (shapeError !== null) {
      restoreGameplaySnapshot(this.host.state, snapshot);
      this.reportFailure(spec, 'shape', `返回值形状非法：${shapeError}`, [], true);
      return fallback(scope);
    }

    if (spec.sideEffects === true) {
      try {
        this.applySideEffects(spec, result.value);
      } catch (error) {
        restoreGameplaySnapshot(this.host.state, snapshot);
        this.reportFailure(spec, 'shape', `返回的 effects/sheetUpdates 无法落地：${errorMessage(error)}`, [], true);
        return fallback(scope);
      }
    }

    this.host.state.hookFailures[spec.hook] = 0;
    return { value: result.value as T, usedHook: true, failed: false, rolls: scope.rolls };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private createScope(session: RngSession): HookRollScope {
    const rolls: DiceRoll[] = [];
    const scope: HookRollScope = {
      session,
      rolls,
      roll(expression: string): DiceRoll {
        const result = rollDice(expression, session);
        rolls.push(result);
        return result;
      },
      nextFloat(): number {
        return session.nextFloat();
      },
    };
    return scope;
  }

  private buildBridge(spec: HookCallSpec, scope: HookRollScope, hookLogs: string[]): SandboxBridge {
    const host = this.host;
    const rules = host.rules;
    const actorId = spec.actorId;
    const requireCtxActor = (): ActorState => {
      if (actorId === undefined) throw new Error('当前钩子没有行动者上下文');
      const actor = host.findActor(actorId);
      if (actor === undefined) throw new Error(`找不到角色「${actorId}」`);
      return actor;
    };
    const ctxData = this.buildCtxData(spec);
    const bridge: SandboxBridge = {
      ctx: toPlainJson(ctxData),
      roll: (expression: unknown) => scope.roll(String(expression)),
      rng: () => scope.nextFloat(),
      attr: (id: unknown) => {
        const actor = requireCtxActor();
        const value = actor.card.attributes[String(id)];
        if (!isFiniteNumber(value)) throw new Error(`角色没有属性「${String(id)}」`);
        return value;
      },
      derived: (key: unknown) => {
        const data = (spec.ctxData?.derived ?? (actorId === undefined ? {} : host.findActor(actorId)?.derived ?? {})) as Record<string, unknown>;
        const value = data[String(key)];
        return value === undefined ? null : value;
      },
      resourceGet: (id: unknown) => {
        const actor = requireCtxActor();
        const resourceId = String(id);
        const resource = actor.card.resources[resourceId];
        if (resource === undefined) throw new Error(`角色没有资源「${resourceId}」`);
        return resource.current;
      },
      resourceSpend: (id: unknown, amount: unknown) => {
        const actor = requireCtxActor();
        const resourceId = String(id);
        if (!isFiniteNumber(amount) || amount < 0) throw new Error('resource.spend 的数量必须是非负数值');
        const resource = actor.card.resources[resourceId];
        if (resource === undefined) throw new Error(`角色没有资源「${resourceId}」`);
        if (resource.current < amount) {
          throw new Error(`资源「${resourceId}」不足（需要 ${amount}，当前 ${resource.current}）`);
        }
        resource.current -= amount;
        host.onCardMutated(actor.actorId);
        return resource.current;
      },
      sheetGet: (path: unknown) => {
        const actor = requireCtxActor();
        return readCardPath(actor.card, String(path)) ?? null;
      },
      sheetSet: (path: unknown, value: unknown) => {
        if (spec.sheetSetAllowed !== true) {
          throw new Error('ctx.sheet.set 仅在 onEvent / onLevelUp / migrateSheet 钩子中可用');
        }
        const actor = requireCtxActor();
        writeCardPath(rules, actor.card, String(path), value);
        host.onCardMutated(actor.actorId);
        return true;
      },
      equipmentList: () => {
        const actor = requireCtxActor();
        return toPlainJson(actor.card.equipmentInstances);
      },
      equipmentStats: (statId: unknown) => {
        const actor = requireCtxActor();
        const aggregate = aggregateEquipmentStats(rules, actor.card.equipmentInstances ?? []);
        return aggregate.statValues[String(statId)] ?? 0;
      },
      effectsApply: (effect: unknown) => {
        // 允许没有行动者上下文的钩子（如 onEvent 的 round/start）显式给 targetActorId
        const normalized = normalizeEffectInput(rules, effect, actorId, spec.actorId);
        const target = host.findActor(normalized.targetActorId);
        if (target === undefined) throw new Error(`找不到效果目标「${normalized.targetActorId}」`);
        const applied = applyEffect(host, target, normalized);
        return toPlainJson(applied);
      },
      effectsRemove: (id: unknown) => {
        const actor = requireCtxActor();
        return removeEffect(host, actor, String(id));
      },
      tablesPick: (tableId: unknown) => {
        const picked = pickFromTable(host, String(tableId), scope.session);
        const text = `掷表 ${picked.tableId}：${picked.roll.expr}=[${picked.roll.dice.join(',')}]${picked.roll.modifier >= 0 ? '+' : ''}${picked.roll.modifier} → ${picked.roll.total}${picked.entry?.itemId !== undefined ? `（${picked.entry.itemId}）` : ''}`;
        host.log({
          source: 'engine',
          level: 'info',
          text,
          ...(spec.actorId !== undefined ? { actorId: spec.actorId } : {}),
        });
        // 「记录进事件」（docs §6 ctx.tables.pick）：进事件总线供 onEvent/复盘看到
        host.emit('table/roll', {
          tableId: picked.tableId,
          expr: picked.roll.expr,
          dice: picked.roll.dice,
          total: picked.roll.total,
          itemId: picked.entry?.itemId ?? null,
          hook: spec.hook,
          actorId: spec.actorId ?? null,
        });
        return toPlainJson(picked);
      },
      log: (text: unknown) => {
        hookLogs.push(String(text));
      },
    };
    return bridge;
  }

  private buildCtxData(spec: HookCallSpec): Record<string, unknown> {
    const state = this.host.state;
    const actor = spec.actorId === undefined ? undefined : this.host.findActor(spec.actorId);
    const derived = spec.ctxData?.derived ?? actor?.derived ?? {};
    return {
      actorId: spec.actorId ?? null,
      targetId: spec.targetId ?? null,
      actor: actor === undefined ? null : this.summarizeActor(actor),
      action: spec.ctxData?.action ?? null,
      target: spec.ctxData?.target ?? null,
      space: spec.ctxData?.space ?? (actor?.position ?? null),
      derived,
      turn: {
        round: state.combat.active ? state.combat.round : state.time.round,
        maxRounds: state.combat.maxRounds,
        actorId: spec.actorId ?? null,
        seq: state.eventSeq,
      },
      ...(spec.ctxData?.turn ?? {}),
    };
  }

  private summarizeActor(actor: ActorState): Record<string, unknown> {
    return {
      actorId: actor.actorId,
      name: actor.name,
      team: actor.team,
      dead: actor.dead,
      position: toPlainJson(actor.position),
      turn: { ...actor.turn },
      effects: toPlainJson(actor.effects),
      derived: { ...actor.derived },
      card: toPlainJson(actor.card),
    };
  }

  private flushScriptLogs(spec: HookCallSpec, logs: ReadonlyArray<{ level: 'log' | 'warn' | 'error'; text: string }>): void {
    for (const entry of logs) {
      this.host.log({
        source: 'script',
        level: entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : 'info',
        text: entry.text,
        hook: spec.hook,
        ...(spec.actorId !== undefined ? { actorId: spec.actorId } : {}),
      });
    }
  }

  private flushHookLogs(spec: HookCallSpec, logs: readonly string[]): void {
    for (const text of logs) {
      this.host.log({
        source: 'hook',
        level: 'info',
        text: text.slice(0, 500),
        hook: spec.hook,
        ...(spec.actorId !== undefined ? { actorId: spec.actorId } : {}),
      });
    }
  }

  private applySideEffects(spec: HookCallSpec, value: unknown): void {
    if (!isRecord(value)) return;
    const host = this.host;
    const effects = value.effects;
    if (Array.isArray(effects)) {
      for (const raw of effects) {
        const normalized = normalizeEffectInput(host.rules, raw, spec.actorId, spec.actorId);
        const actor = host.findActor(normalized.targetActorId);
        if (actor === undefined) throw new Error(`effects 引用了不存在的角色「${normalized.targetActorId}」`);
        applyEffect(host, actor, normalized);
      }
    }
    const sheetUpdates = value.sheetUpdates;
    if (isRecord(sheetUpdates)) {
      for (const [targetId, patch] of Object.entries(sheetUpdates)) {
        const actor = host.findActor(targetId);
        if (actor === undefined) throw new Error(`sheetUpdates 引用了不存在的角色「${targetId}」`);
        if (!isRecord(patch)) throw new Error(`sheetUpdates.${targetId} 必须是 { 卡路径: 值 } 对象`);
        for (const [path, item] of Object.entries(patch)) {
          writeCardPath(host.rules, actor.card, path, item);
        }
        host.onCardMutated(targetId);
      }
    }
    const log = value.log;
    const lines = typeof log === 'string' ? [log] : Array.isArray(log) ? log.filter((line): line is string => typeof line === 'string') : [];
    for (const line of lines) {
      host.log({
        source: 'hook',
        level: 'info',
        text: line.slice(0, 500),
        hook: spec.hook,
        ...(spec.actorId !== undefined ? { actorId: spec.actorId } : {}),
      });
    }
  }

  private reportFailure(
    spec: HookCallSpec,
    kind: HookFailureKind,
    message: string,
    stack: string[],
    countFailure: boolean,
  ): RulesErrorEventData {
    const state = this.host.state;
    let degraded: boolean | undefined;
    if (countFailure) {
      const failures = (state.hookFailures[spec.hook] ?? 0) + 1;
      state.hookFailures[spec.hook] = failures;
      if (this.failureThreshold > 0 && failures >= this.failureThreshold && !state.disabledHooks.includes(spec.hook)) {
        state.disabledHooks.push(spec.hook);
        degraded = true;
      }
    }
    let inputSummary = '';
    try {
      inputSummary = JSON.stringify(spec.inputSummary ?? null).slice(0, 512);
    } catch {
      inputSummary = '[无法序列化]';
    }
    const payload: RulesErrorEventData = {
      hook: spec.hook,
      kind,
      message: message.slice(0, 500),
      inputSummary,
      stack: stack.slice(0, 5),
      ...(degraded === true ? { degraded } : {}),
    };
    this.host.emit('rules/error', payload as unknown as Record<string, unknown>);
    return payload;
  }
}
