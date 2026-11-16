/**
 * M9.2 核心运行时的状态、事件、日志与公共 API 类型。
 *
 * 设计口径（docs/RULES-MODEL §6/§7/§9/§10）：
 * - 运行状态是**纯 JSON**：快照 = 状态本身，不含函数/类实例/undefined；
 * - 骰面由 `roomSeed + eventSeq + 钩子名 + 调用序号` 派生（见 rng.ts），快照记录计数器即可复现；
 * - 事件总线只广播 JSON 事件；钩子日志另走 RuntimeLogSink（GM 提示），不参与结算。
 */
import type {
  CardInstance,
  DistanceMode,
  HookName,
  RangeBand,
  RoundLimitAction,
  RulePack,
  SheetProjection,
  SpaceModel,
  SpawnSide,
  StatusStackingMode,
} from '../types.ts';

// ---------------------------------------------------------------------------
// schema / 基础工具
// ---------------------------------------------------------------------------

export const RUNTIME_STATE_SCHEMA_VERSION = 'trpg.runtime-state/1' as const;

/** 事件 kind（前 12 个是 docs/RULES-MODEL §4/§6 明确要求的总线事件，其余为运行时辅助事件）。 */
export const RUNTIME_EVENT_KINDS = [
  'turn/start',
  'turn/end',
  'round/start',
  'round/end',
  'round/limit',
  'action/before',
  'action/after',
  'damage/after',
  'death',
  'equip/change',
  'status/tick',
  'time/advance',
  'move',
  'zone/enter',
  'zone/leave',
  'check',
  'loot',
  'table/roll',
  'level/up',
  'combat/start',
  'combat/end',
  'rules/error',
] as const;
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export interface RuntimeEvent {
  /** 单调递增事件序号（房间事件流里的 `seq`）。 */
  seq: number;
  kind: RuntimeEventKind;
  data: Record<string, unknown>;
  /** 宿主时钟读数，仅日志展示用；**永不参与结算/随机**（确定性要求）。 */
  at?: number;
}

export type RuntimeLogLevel = 'info' | 'warn' | 'error';
export type RuntimeLogSource = 'script' | 'hook' | 'engine';

export interface RuntimeLogEntry {
  seq: number;
  source: RuntimeLogSource;
  level: RuntimeLogLevel;
  text: string;
  hook?: string;
  actorId?: string;
}

export type RuntimeLogSink = (entry: RuntimeLogEntry) => void;

/** `onEvent` 等钩子返回的 `effects` 项（由内核入效果栈）。 */
export interface EffectInput {
  /** 显式效果 id；缺省按 statusId 或自增 id。 */
  effectId?: string;
  /** 规则包 `sheet.statuses[].id`。 */
  statusId?: string;
  /** 展示名；缺省取状态定义名或 statusId。 */
  name?: string;
  kind?: 'status' | 'effect';
  stacks?: number;
  /** 持续回合数；0/负数 = 永久。 */
  duration?: number;
  remaining?: number;
  data?: Record<string, number | string>;
  /** 目标角色；缺省 = 当前钩子的行动者（onEvent 等无行动者钩子必须显式给）。 */
  targetActorId?: string;
  sourceActorId?: string;
  /** 展示用叠法（钩子可覆盖状态定义里的 stacking）。 */
  stacking?: StatusStackingMode | string;
}

// ---------------------------------------------------------------------------
// 结算追踪（骰面/公式/中间值，供 GM 与复盘）
// ---------------------------------------------------------------------------

export interface RuntimeTrace {
  /** 中文人话行（GM 提示/日志）。 */
  lines: string[];
  /** 结构化中间值（骰面、公式、加值、DC……）。 */
  data: Record<string, unknown>;
}

export interface DiceRollRecord {
  expr: string;
  dice: number[];
  modifier: number;
  total: number;
}

// ---------------------------------------------------------------------------
// 运行状态（纯 JSON）
// ---------------------------------------------------------------------------

export interface CellPoint {
  x: number;
  y: number;
}

export interface PositionState {
  /** 大区域 id（zone-grid / zone 模型）。 */
  zoneId?: string;
  /** 战棋格坐标（grid / zone-grid 模型）。 */
  cell?: CellPoint;
}

/** 状态/效果栈条目：剩余时长按回合计（`-1` = 永久）。 */
export interface ActiveEffectState {
  effectId: string;
  kind: 'status' | 'effect';
  statusId?: string;
  name: string;
  stacks: number;
  /** 剩余回合数；-1 = 永久（不 tick）。 */
  remaining: number;
  data?: Record<string, number | string>;
  sourceActorId?: string;
}

export interface ActorState {
  actorId: string;
  name: string;
  team: SpawnSide;
  /** 卡实例（唯一权威数据；HP/资源 current 存在这里）。 */
  card: CardInstance;
  position: PositionState;
  effects: ActiveEffectState[];
  /** 本回合行动经济剩余：`turn.resources[].id` / `turn.movement.id` → 剩余次数。 */
  turn: Record<string, number>;
  dead: boolean;
  /** 临时 HP（先扣临时再扣 HP；不在卡 schema 里，属运行态）。 */
  tempHp: number;
  /** `computeDerived` 钩子产出（投影/公式用）。 */
  derived: Record<string, number | string>;
  /** 先攻掷骰结果（战斗内有效）。 */
  initiative?: number;
  initiativeRoll?: number;
}

export interface CombatState {
  active: boolean;
  round: number;
  /** 0 = 无上限。 */
  maxRounds: number;
  order: string[];
  activeIndex: number;
  overtime: boolean;
  reason?: string;
  /** 已触发的回合上限动作（缺省 = 未触发）。 */
  limitAction?: RoundLimitAction;
  endedReason?: string;
  startedSeq?: number;
}

export interface TimeState {
  round: number;
  segment: number;
  day: number;
}

export interface SpaceState {
  model: SpaceModel;
  distanceMode: DistanceMode;
  /** 当前激活的战斗地图（grid / zone-grid）。 */
  mapId?: string;
}

/** 运行时全部状态（可 JSON 序列化；快照即它的深拷贝）。 */
export interface RuntimeState {
  roomSeed: number;
  /** 已广播事件数（下一个事件 = +1）。 */
  eventSeq: number;
  /** 随机调用序号（每个钩子/缺省结算一个 session）。 */
  rollCallSeq: number;
  /** 效果 id 自增序号。 */
  effectSeq: number;
  /** 钩子总调用次数（单场上限，见 §6）。 */
  hookCallCount: number;
  /** 钩子连续失败次数。 */
  hookFailures: Record<string, number>;
  /** 因连续失败被降级的钩子。 */
  disabledHooks: string[];
  time: TimeState;
  combat: CombatState;
  space: SpaceState;
  actors: Record<string, ActorState>;
  /** 最近事件（有上限，用于复盘/工具返回）。 */
  events: RuntimeEvent[];
}

/** 编辑状态快照的旧接口保留名（等价 `exportState()` 的产物）。 */
export interface RuntimeSnapshot {
  schemaVersion: typeof RUNTIME_STATE_SCHEMA_VERSION;
  rulesId: string;
  rulesVersion: string;
  roomSeed: number;
  eventSeq: number;
  rollCallSeq: number;
  effectSeq: number;
  hookCallCount: number;
  hookFailures: Record<string, number>;
  disabledHooks: string[];
  time: TimeState;
  combat: CombatState;
  space: SpaceState;
  actors: Record<string, ActorState>;
  events: RuntimeEvent[];
}

// ---------------------------------------------------------------------------
// 错误（公共 API 统一返回 `RuleResult`）
// ---------------------------------------------------------------------------

export type RuleErrorCode =
  | 'invalid_request'
  | 'invalid_rules'
  | 'invalid_sheet'
  | 'script_integrity'
  | 'script_load'
  | 'unknown_actor'
  | 'unknown_action'
  | 'unknown_table'
  | 'unknown_map'
  | 'combat_active'
  | 'no_combat'
  | 'not_active'
  | 'actor_dead'
  | 'insufficient_resource'
  | 'insufficient_turn_resource'
  | 'invalid_target'
  | 'out_of_range'
  | 'blocked'
  | 'formula_missing'
  | 'formula_error'
  | 'invalid_snapshot'
  | 'internal';

export interface RuleRuntimeErrorInfo {
  code: RuleErrorCode;
  messageZh: string;
  hint?: string;
}

export class RuleRuntimeError extends Error {
  code: RuleErrorCode;
  hint?: string;

  constructor(code: RuleErrorCode, messageZh: string, hint?: string) {
    super(messageZh);
    this.name = 'RuleRuntimeError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export type RuleResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: RuleRuntimeErrorInfo };

// ---------------------------------------------------------------------------
// 钩子错误事件负载（rules/error）
// ---------------------------------------------------------------------------

export type HookFailureKind = 'throw' | 'timeout' | 'shape' | 'integrity' | 'syntax' | 'limit';

export interface RulesErrorEventData {
  hook: string;
  kind: HookFailureKind;
  message: string;
  /** 入参摘要（JSON 字符串，截断到 512 字符）。 */
  inputSummary: string;
  /** 堆栈前 5 行。 */
  stack: string[];
  /** 连续失败触发降级。 */
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  /** 单次钩子执行超时（默认 200ms，§6）。 */
  timeoutMs: number;
  /** 单场钩子调用次数上限（默认 10000，§10）。 */
  maxHookCalls: number;
  /** 同一钩子连续失败多少次后降级（默认 3，§6）。 */
  failureThreshold: number;
  /** 内存事件环上限。 */
  maxEvents: number;
}

// ---------------------------------------------------------------------------
// 公共 API 入参/出参
// ---------------------------------------------------------------------------

/** 脚本来源：宿主读文件后传入；运行时用 sha256 校验内容完整。 */
export interface ScriptSourceInput {
  file: string;
  code: string;
  sha256: string;
}

export interface AddActorInput {
  card: CardInstance;
  actorId?: string;
  name?: string;
  team?: SpawnSide;
  position?: PositionState;
}

export interface ChangeEquipmentRequest {
  actorId: string;
  /** 新的装备实例数组（整体替换；校验失败不改卡）。 */
  equipmentInstances: CardInstance['equipmentInstances'];
}

export interface ActorView {
  actorId: string;
  name: string;
  team: SpawnSide;
  card: CardInstance;
  position: PositionState;
  effects: ActiveEffectState[];
  turn: Record<string, number>;
  dead: boolean;
  tempHp: number;
  derived: Record<string, number | string>;
  initiative?: number;
}

export interface CombatOrderView {
  actorId: string;
  name: string;
  team: SpawnSide;
  initiative: number;
  roll: number;
  dead: boolean;
}

export interface CombatView {
  active: boolean;
  round: number;
  maxRounds: number;
  order: CombatOrderView[];
  activeActorId: string | null;
  overtime: boolean;
  limitAction?: RoundLimitAction;
  endedReason?: string;
  reason?: string;
}

export interface StartCombatRequest {
  actorIds?: string[];
  maxRounds?: number;
  mapId?: string;
  reason?: string;
}

export interface EndTurnRequest {
  actorId?: string;
}

export interface EndCombatRequest {
  reason?: string;
}

export type CheckMode = 'normal' | 'advantage' | 'disadvantage';

export interface RollCheckRequest {
  actorId: string;
  targetId?: string;
  /** 技能 id（`sheet.skills[].id`）。 */
  skillId?: string;
  /** 属性 id（`sheet.attributes[].id`）。 */
  attributeId?: string;
  kind?: 'attribute' | 'skill' | 'save' | 'opposed' | 'custom' | string;
  dc?: number;
  mods?: number;
  mode?: CheckMode;
  reason?: string;
}

export interface CheckResultData {
  actorId: string;
  targetId?: string;
  kind: string;
  skillId?: string;
  attributeId?: string;
  dc: number;
  mode: CheckMode;
  rolls: DiceRollRecord[];
  d20: number | null;
  modifier: number;
  total: number;
  success: boolean;
  crit: boolean;
  fumble: boolean;
  degree: 'crit' | 'success' | 'fail' | 'fumble';
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface UseActionRequest {
  actorId: string;
  actionId: string;
  targetId?: string;
  options?: {
    mods?: number;
    mode?: CheckMode;
    dc?: number;
    skillId?: string;
    /** 显式覆盖距离判定（格子数）；不传按场地实时算。 */
    distance?: number;
  };
}

export interface ActionCostSpent {
  /** 行动经济消耗：`turn.resources[].id` → 次数。 */
  turn: Record<string, number>;
  /** 角色资源消耗。 */
  resource?: { id: string; amount: number };
}

export interface DamageResultData {
  targetId: string;
  amount: number;
  absorbedByTempHp: number;
  hpBefore: number;
  hpAfter: number;
  dead: boolean;
  consumedEffects: string[];
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface ActionResultData {
  actorId: string;
  actionId: string;
  actionName: string;
  kind: string;
  targetId?: string;
  hit?: boolean;
  crit?: boolean;
  check?: CheckResultData;
  damage?: DamageResultData;
  cost: ActionCostSpent;
  turn: Record<string, number>;
  autoEndedTurn: boolean;
  rolls: DiceRollRecord[];
  events: RuntimeEventKind[];
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface ApplyDamageRequest {
  targetId: string;
  amount: number;
  type?: string;
  sourceActorId?: string;
  crit?: boolean;
}

export interface MoveRequest {
  actorId: string;
  to: PositionState;
  /** 进入/离开区域的来源说明（`move` / `teleport` / `gm`）。 */
  via?: string;
}

export interface MoveResultData {
  actorId: string;
  from: PositionState;
  to: PositionState;
  cost: number;
  remaining: number | null;
  path: CellPoint[];
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface DistanceRequest {
  actorId?: string;
  targetId?: string;
  from?: PositionState;
  to?: PositionState;
  kind?: string;
}

export interface DistanceResultData {
  distance: number;
  band: RangeBand | null;
  from: PositionState;
  to: PositionState;
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface CoverRequest {
  actorId: string;
  targetId: string;
  targetZone?: string;
}

export interface CoverResultData {
  defenseBonus: number;
  tags: string[];
  coverId?: string;
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface LootRequest {
  tableId?: string;
  encounterId?: string;
  level?: number;
  count?: number;
}

export interface LootItemInstance {
  instanceId: string;
  itemId: string;
  name: string;
  tags: string[];
  stats: Record<string, number>;
  note?: string;
}

export interface LootResultData {
  items: LootItemInstance[];
  tableId?: string;
  rolls: DiceRollRecord[];
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface LevelUpRequest {
  actorId: string;
  xpGain?: number;
  targetLevel?: number;
}

export interface LevelUpResultData {
  actorId: string;
  fromLevel: number;
  level: number;
  xp: number;
  gains: Array<{ atLevel: number; skillPoints?: number; note?: string }>;
  patch: Record<string, unknown>;
  validation: string[];
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface AdvanceTimeRequest {
  rounds?: number;
  cause?: string;
}

export interface TimeResultData {
  from: number;
  to: number;
  round: number;
  usedHook: boolean;
  trace: RuntimeTrace;
}

export interface ValidateSheetResultData {
  actorId: string;
  errors: string[];
  usedHook: boolean;
}

export interface DerivedResultData {
  actorId: string;
  derived: Record<string, number | string>;
}

export interface SheetProjectionResultData {
  actorId: string;
  projection: SheetProjection;
}

/** 脚本加载报告（createRuleRuntime 后可通过 `runtime.scriptReports` 查阅）。 */
export interface ScriptLoadReportView {
  file: string;
  sha256: string;
  ok: boolean;
  hooks: string[];
  error?: string;
  /** 规则包声明了该 hook 但文件未导出。 */
  missingHooks?: string[];
}

// ---------------------------------------------------------------------------
// 运行时对外接口
// ---------------------------------------------------------------------------

export type RuleEventListener = (event: RuntimeEvent) => void;

export interface CreateRuleRuntimeOptions {
  rules: RulePack;
  roomSeed: number;
  /** 规则脚本（宿主读文件后传入）；规则包 `scripts` 声明的文件必须全部提供且 sha256 一致。 */
  scripts?: readonly ScriptSourceInput[];
  /** 脚本/钩子日志落点（GM 提示用；不影响结算）。 */
  log?: RuntimeLogSink;
  /** 单次钩子执行超时（默认 200ms）。 */
  timeoutMs?: number;
  /** 单场钩子调用上限（默认 10000）。 */
  maxHookCalls?: number;
  /** 连续失败降级阈值（默认 3；0 = 不降级）。 */
  failureThreshold?: number;
  /**
   * 宿主时钟：**只**写进事件 `at` 字段供展示，永不参与随机/结算。
   * 不传则事件不带 `at`。
   */
  clock?: () => number;
}

/** 钩子名到脚本文件的声明（便于 M9.3 传脚本时交叉校验）。 */
export interface RuleRuntimeOptionsSnapshot {
  rulesId: string;
  rulesVersion: string;
  roomSeed: number;
  hookNames: readonly HookName[];
}
