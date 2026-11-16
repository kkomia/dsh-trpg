/**
 * M9.2 核心运行时入口：`createRuleRuntime({ rules, roomSeed, scripts?, log?, timeoutMs?, clock? })`。
 *
 * 纯 Node 库（零外部依赖）：不接 host/client/rooms、不做 UI。M9.3/M9.4 用它：
 * - 建卡前：`validateSheet`；
 * - 投影：`getSheet()` / `getDerived()`（主机权威）；
 * - 检定/动作/移动/伤害：`rollCheck` / `useAction` / `move` / `applyDamage`（骰面与 trace 随结果返回）；
 * - 战斗：`startCombat` / `endTurn` / `endCombat` / `getCombat`；
 * - 事件：`subscribe(listener)` 拿 `{seq, kind, data}` 事件流（重连按 seq 补发由 host 负责）；
 * - 复现：`exportState()` / `importState()` 纯 JSON 快照。
 */
import { compileFormula, evaluateFormula, type FormulaContext, type FormulaNode } from '../formula.ts';
import { buildSheetProjection, cardLevel, validateCard } from '../sheet.ts';
import type { CardInstance, HookName, RulePack, SheetProjection } from '../types.ts';
import { createSeededRng, normalizeRoomSeed, type RngSession } from './rng.ts';
import { createScriptSandbox, type ScriptSource } from './sandbox.ts';
import {
  applyEffect,
  HookDispatcher,
  normalizeEffectInput,
  validateHookValue,
  type HookHost,
  type HookLogInput,
} from './hooks.ts';
import { SpaceRuntime } from './space.ts';
import {
  combatView,
  endCombat as combatEndCombat,
  endTurn as combatEndTurn,
  refillTurnResources,
  startCombat as combatStart,
} from './combat.ts';
import { advanceTime as timeAdvance } from './time.ts';
import {
  applyDamage as resolveApplyDamage,
  computeCoverFor,
  computeDistanceFor,
  levelUpActor,
  moveActor,
  resolveLootFor,
  rollCheck as resolveRollCheck,
  runValidateSheetHook,
  useAction as resolveUseAction,
} from './resolve.ts';
import { exportSnapshot, importSnapshot } from './snapshot.ts';
import {
  RuleRuntimeError,
  type ActorState,
  type ActorView,
  type AddActorInput,
  type AdvanceTimeRequest,
  type ApplyDamageRequest,
  type ActionResultData,
  type ChangeEquipmentRequest,
  type CheckResultData,
  type CombatView,
  type CoverRequest,
  type CoverResultData,
  type CreateRuleRuntimeOptions,
  type DamageResultData,
  type DiceRollRecord,
  type DistanceRequest,
  type DistanceResultData,
  type EndCombatRequest,
  type EndTurnRequest,
  type LevelUpRequest,
  type LevelUpResultData,
  type LootRequest,
  type LootResultData,
  type MoveRequest,
  type MoveResultData,
  type PositionState,
  type RollCheckRequest,
  type RuleErrorCode,
  type RuleEventListener,
  type RuleResult,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeLogEntry,
  type RuntimeLogLevel,
  type RuntimeLogSink,
  type RuntimeLogSource,
  type RuntimeSnapshot,
  type RuntimeState,
  type ScriptLoadReportView,
  type SheetProjectionResultData,
  type StartCombatRequest,
  type TimeResultData,
  type UseActionRequest,
  type ValidateSheetResultData,
} from './types.ts';
import type { EngineLogInput, RuntimeEnv } from './env.ts';
import { isFiniteNumber, isInteger, isNonEmptyString, isRecord, toPlainJson } from './util.ts';

export type * from './types.ts';
export { RUNTIME_EVENT_KINDS, RUNTIME_STATE_SCHEMA_VERSION, RuleRuntimeError } from './types.ts';
export type { RuntimeEnv } from './env.ts';
export { createSeededRng, hashToUnitInterval, deriveRngBytes, normalizeRoomSeed } from './rng.ts';
export type { RngSeedParts, RngSession, RngState } from './rng.ts';
export { DICE_LIMITS, isDiceExpression, parseDiceExpression, rollDice } from './dice.ts';
export type { DiceRoll, DiceTerm, ParsedDiceExpression } from './dice.ts';
export {
  createScriptSandbox,
  sha256Hex,
  SANDBOX_DEFAULT_TIMEOUT_MS,
  SANDBOX_MAX_LOG_LINES,
  SANDBOX_MAX_RESULT_BYTES,
} from './sandbox.ts';
export type {
  SandboxBridge,
  SandboxCallResult,
  SandboxFailure,
  SandboxFailureKind,
  SandboxLogEntry,
  SandboxOptions,
  ScriptLoadReport,
  ScriptSandbox,
  ScriptSource,
} from './sandbox.ts';
export {
  applyEffect,
  HookDispatcher,
  normalizeEffectInput,
  pickFromTable,
  readCardPath,
  removeEffect,
  restoreGameplaySnapshot,
  syncCardStatuses,
  takeGameplaySnapshot,
  validateHookValue,
  writeCardPath,
} from './hooks.ts';
export type {
  GameplaySnapshot,
  HookCallOutcome,
  HookCallSpec,
  HookCtxData,
  HookHost,
  HookLogInput,
  HookRollScope,
  TablePickResult,
} from './hooks.ts';
export {
  bandForCellsDistance,
  bandForZoneHops,
  bresenhamLine,
  distanceBetween,
  normalizePosition,
  runZoneTransition,
  SpaceRuntime,
} from './space.ts';
export type { MovePlan, ZoneTransitionRequest } from './space.ts';
export {
  autoEndTurnIfExhausted,
  canAffordCost,
  combatView,
  endCombat,
  endTurn,
  ensureTurnResources,
  initiativeBonus,
  isTurnExhausted,
  movementResourceId,
  parseActionCost,
  payActionCost,
  refillTurnResources,
  setMovementRemaining,
  spendMovement,
  startCombat,
} from './combat.ts';
export { tickActorEffects, tickAllEffects, advanceTime } from './time.ts';
export type { StatusTick } from './time.ts';
export {
  applyDamage,
  attrModifier,
  checkModifier,
  computeCoverFor,
  computeDistanceFor,
  hitPointsResourceId,
  levelUpActor,
  moveActor,
  resolveLootFor,
  rollCheck,
  runValidateSheetHook,
  spaceFormulaContext,
  summarizeActor,
  useAction,
} from './resolve.ts';
export type { CheckModifierResult, DistanceResolution, ValidateSheetOutcome } from './resolve.ts';
export { exportSnapshot, importSnapshot, importSnapshotOrThrow, validateSnapshot } from './snapshot.ts';
export type { ImportSnapshotResult } from './snapshot.ts';

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/** 运行时对外接口（M9.3/M9.4 只依赖它）。 */
export interface RuleRuntime {
  readonly rules: RulePack;
  readonly roomSeed: number;
  readonly scriptReports: readonly ScriptLoadReportView[];
  /** 已启用的钩子名（脚本导出且未因连续失败降级）。 */
  listHooks(): HookName[];

  subscribe(listener: RuleEventListener): () => void;
  recentEvents(limit?: number): RuntimeEvent[];

  exportState(): RuntimeSnapshot;
  importState(snapshot: unknown): RuleResult<{ round: number }>;

  listActors(): ActorView[];
  getActor(actorId: string): RuleResult<{ actor: ActorView }>;
  addActor(input: AddActorInput): RuleResult<{ actor: ActorView; validation: string[] }>;
  removeActor(actorId: string): RuleResult<{ removed: boolean }>;
  /** 换装：整体替换装备实例 → 校验 → 重算派生 → 广播 equip/change。 */
  changeEquipment(request: ChangeEquipmentRequest): RuleResult<{ actor: ActorView; validation: string[] }>;
  validateSheet(actorId: string): RuleResult<ValidateSheetResultData>;
  getDerived(actorId: string): RuleResult<{ actorId: string; derived: Record<string, number | string> }>;
  getSheet(actorId: string): RuleResult<SheetProjectionResultData>;

  startCombat(request?: StartCombatRequest): RuleResult<{ view: CombatView; rolls: DiceRollRecord[] }>;
  getCombat(): CombatView;
  endTurn(request?: EndTurnRequest): RuleResult<{ view: CombatView }>;
  endCombat(request?: EndCombatRequest): RuleResult<{ view: CombatView }>;

  rollCheck(request: RollCheckRequest): RuleResult<CheckResultData>;
  useAction(request: UseActionRequest): RuleResult<ActionResultData>;
  applyDamage(request: ApplyDamageRequest): RuleResult<DamageResultData>;
  move(request: MoveRequest): RuleResult<MoveResultData>;
  computeDistance(request?: DistanceRequest): RuleResult<DistanceResultData>;
  computeCover(request: CoverRequest): RuleResult<CoverResultData>;
  resolveLoot(request?: LootRequest): RuleResult<LootResultData>;
  levelUp(request: LevelUpRequest): RuleResult<LevelUpResultData>;
  advanceTime(request?: AdvanceTimeRequest): RuleResult<TimeResultData>;

  dispose(): void;
}

// ---------------------------------------------------------------------------
// 初始状态 / 配置
// ---------------------------------------------------------------------------

function createInitialState(roomSeed: number, rules: RulePack): RuntimeState {
  return {
    roomSeed,
    eventSeq: 0,
    rollCallSeq: 0,
    effectSeq: 0,
    hookCallCount: 0,
    hookFailures: {},
    disabledHooks: [],
    time: { round: 1, segment: 0, day: 0 },
    combat: { active: false, round: 0, maxRounds: 0, order: [], activeIndex: 0, overtime: false },
    space: {
      model: rules.space?.model ?? 'none',
      distanceMode: rules.space?.distanceMode ?? 'chebyshev',
    },
    actors: {},
    events: [],
  };
}

function normalizeConfig(options: CreateRuleRuntimeOptions): RuntimeConfig {
  const timeout = options.timeoutMs;
  return {
    timeoutMs: typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 200,
    maxHookCalls: typeof options.maxHookCalls === 'number' && Number.isFinite(options.maxHookCalls) && options.maxHookCalls > 0
      ? Math.trunc(options.maxHookCalls)
      : 10000,
    failureThreshold: typeof options.failureThreshold === 'number' && Number.isFinite(options.failureThreshold) && options.failureThreshold >= 0
      ? Math.trunc(options.failureThreshold)
      : 3,
    maxEvents: 500,
  };
}

function actorView(actor: ActorState): ActorView {
  return toPlainJson({
    actorId: actor.actorId,
    name: actor.name,
    team: actor.team,
    card: actor.card,
    position: actor.position,
    effects: actor.effects,
    turn: actor.turn,
    dead: actor.dead,
    tempHp: actor.tempHp,
    derived: actor.derived,
    ...(actor.initiative !== undefined ? { initiative: actor.initiative } : {}),
  });
}

function errorInfo(error: unknown): { code: RuleErrorCode; messageZh: string; hint?: string } {
  if (error instanceof RuleRuntimeError) {
    return {
      code: error.code,
      messageZh: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    };
  }
  if (error instanceof Error) return { code: 'internal', messageZh: error.message };
  return { code: 'internal', messageZh: String(error) };
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

/** 规则运行时。一个房间一个实例；状态纯 JSON，可快照/恢复。 */
export class RuleRuntimeCore implements RuleRuntime, RuntimeEnv, HookHost {
  readonly rules: RulePack;
  readonly state: RuntimeState;
  readonly config: RuntimeConfig;
  readonly space: SpaceRuntime;
  hooks: HookDispatcher;

  /** 房间种子（快照/复现基准；导入快照后会被快照里的值替换）。 */
  get roomSeed(): number {
    return this.state.roomSeed;
  }

  private readonly options: CreateRuleRuntimeOptions;
  private readonly listeners = new Set<RuleEventListener>();
  private readonly clock: (() => number) | undefined;
  private readonly logSink: RuntimeLogSink | undefined;
  private readonly formulaCache = new Map<string, FormulaNode>();
  private sandbox: ReturnType<typeof createScriptSandbox> | null = null;
  private logSeq = 0;
  private eventDispatchDepth = 0;
  private disposed = false;
  private readonly reportView: ScriptLoadReportView[] = [];

  constructor(options: CreateRuleRuntimeOptions) {
    if (!isRecord(options) || !isRecord(options.rules)) {
      throw new RuleRuntimeError('invalid_rules', 'createRuleRuntime 需要 rules 规则包对象');
    }
    this.options = options;
    this.rules = options.rules;
    this.config = normalizeConfig(options);
    this.clock = typeof options.clock === 'function' ? options.clock : undefined;
    this.logSink = typeof options.log === 'function' ? options.log : undefined;
    this.state = createInitialState(normalizeRoomSeed(options.roomSeed), this.rules);
    this.space = new SpaceRuntime(this.rules);
    this.hooks = new HookDispatcher(this, { failureThreshold: this.config.failureThreshold });
    this.loadScripts(options.scripts ?? []);
  }

  // --- 脚本加载 -------------------------------------------------------------

  private loadScripts(input: readonly ScriptSource[]): void {
    const declared = this.rules.scripts ?? {};
    const declaredEntries = Object.entries(declared);
    const sources: ScriptSource[] = [];
    const byFile = new Map<string, ScriptSource>();
    for (const raw of input) {
      if (
        !isRecord(raw) ||
        !isNonEmptyString(raw.file) ||
        typeof raw.code !== 'string' ||
        !isNonEmptyString(raw.sha256)
      ) {
        throw new RuleRuntimeError('script_integrity', '脚本来源必须是 [{ file, code, sha256 }] 数组');
      }
      if (byFile.has(raw.file)) {
        throw new RuleRuntimeError('script_integrity', `同一脚本文件「${raw.file}」被重复提供`);
      }
      const source: ScriptSource = { file: raw.file, code: raw.code, sha256: raw.sha256 };
      byFile.set(source.file, source);
      sources.push(source);
    }
    if (sources.length > 32) {
      throw new RuleRuntimeError('script_integrity', `脚本数量 ${sources.length} 超过单包上限 32（§10）`);
    }
    // 规则包声明的脚本必须齐全且 sha256 一致，否则拒绝加载规则包（§6）
    for (const [hook, ref] of declaredEntries) {
      const source = byFile.get(ref.file);
      if (source === undefined) {
        throw new RuleRuntimeError(
          'script_integrity',
          `规则包引用的脚本「${ref.file}」（钩子 ${hook}）未提供，拒绝加载规则包`,
          '由内容加载器读取 rules/scripts 下的文件后随 scripts 一起传入',
        );
      }
      if (source.sha256 !== ref.sha256) {
        throw new RuleRuntimeError(
          'script_integrity',
          `脚本「${ref.file}」的 sha256 与规则包清单不符（清单 ${ref.sha256.slice(0, 12)}…，实际 ${source.sha256.slice(0, 12)}…），拒绝加载规则包`,
        );
      }
    }
    if (sources.length === 0) return;
    this.sandbox = createScriptSandbox({ timeoutMs: this.config.timeoutMs });
    // 规则包声明了 scripts 时，只有清单内的钩子才允许被调用（防止清单外脚本接管结算）
    const allowedHooks = declaredEntries.length > 0 ? new Set(declaredEntries.map(([hook]) => hook)) : null;
    this.hooks = new HookDispatcher(this, {
      sandbox: this.sandbox,
      failureThreshold: this.config.failureThreshold,
      allowedHooks,
    });
    const reports = this.hooks.loadScripts(sources);
    const failures = reports.filter((report) => !report.ok);
    if (failures.length > 0) {
      this.dispose();
      throw new RuleRuntimeError(
        'script_load',
        `规则脚本加载失败：${failures.map((report) => `${report.file}：${report.error?.message ?? '未知错误'}`).join('；')}`,
      );
    }
    const declaredHooksByFile = new Map<string, string[]>();
    for (const [hook, ref] of declaredEntries) {
      const list = declaredHooksByFile.get(ref.file) ?? [];
      list.push(hook);
      declaredHooksByFile.set(ref.file, list);
    }
    for (const report of reports) {
      const declaredHooks = declaredHooksByFile.get(report.file) ?? [];
      const missing = declaredHooks.filter((hook) => !report.hooks.includes(hook as HookName));
      this.reportView.push({
        file: report.file,
        sha256: report.sha256,
        ok: report.ok,
        hooks: report.hooks,
        ...(missing.length > 0 ? { missingHooks: missing } : {}),
      });
    }
  }

  get scriptReports(): readonly ScriptLoadReportView[] {
    return this.reportView;
  }

  listHooks(): HookName[] {
    return this.hooks.listHooks();
  }

  // --- 事件 / 日志 ----------------------------------------------------------

  emit(kind: RuntimeEventKind, data: Record<string, unknown>): RuntimeEvent {
    const event: RuntimeEvent = {
      seq: this.state.eventSeq + 1,
      kind,
      data: toPlainJson(data),
    };
    if (this.clock !== undefined) {
      try {
        event.at = this.clock();
      } catch {
        /* 时钟只做展示，失败忽略 */
      }
    }
    this.state.eventSeq = event.seq;
    this.state.events.push(event);
    if (this.state.events.length > this.config.maxEvents) {
      this.state.events.splice(0, this.state.events.length - this.config.maxEvents);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* 订阅者异常不影响运行时 */
      }
    }
    if (kind !== 'rules/error') this.dispatchOnEvent(event);
    return event;
  }

  private dispatchOnEvent(event: RuntimeEvent): void {
    if (this.eventDispatchDepth > 0) return;
    this.eventDispatchDepth += 1;
    try {
      // onEvent 没有显式行动者：从事件负载里取 actorId/targetId 作为 ctx 上下文，
      // 这样 onEvent 里的 ctx.sheet / ctx.attr 指向「事件的主角」。
      const actorId = typeof event.data.actorId === 'string' ? event.data.actorId : undefined;
      const targetId = typeof event.data.targetId === 'string' ? event.data.targetId : undefined;
      this.hooks.call({
        hook: 'onEvent',
        args: [toPlainJson(event)],
        inputSummary: { kind: event.kind, seq: event.seq },
        sheetSetAllowed: true,
        ...(actorId !== undefined ? { actorId } : {}),
        ...(targetId !== undefined ? { targetId } : {}),
        default: () => ({}),
        validate: (value) => validateHookValue('onEvent', value),
        sideEffects: true,
      });
    } finally {
      this.eventDispatchDepth -= 1;
    }
  }

  subscribe(listener: RuleEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  recentEvents(limit = 50): RuntimeEvent[] {
    if (limit <= 0) return [];
    return toPlainJson(this.state.events.slice(-Math.floor(limit)));
  }

  log(entry: HookLogInput | EngineLogInput): void {
    this.logSeq += 1;
    const logEntry: RuntimeLogEntry = {
      seq: this.logSeq,
      source: entry.source as RuntimeLogSource,
      level: entry.level as RuntimeLogLevel,
      text: entry.text,
      ...(entry.hook !== undefined ? { hook: entry.hook } : {}),
      ...(entry.actorId !== undefined ? { actorId: entry.actorId } : {}),
    };
    if (this.logSink !== undefined) {
      try {
        this.logSink(logEntry);
      } catch {
        /* 日志落点异常不影响运行时 */
      }
    }
  }

  // --- 随机 / 角色 ----------------------------------------------------------

  beginRoll(scope: string): RngSession {
    this.state.rollCallSeq += 1;
    return createSeededRng({
      roomSeed: this.state.roomSeed,
      eventSeq: this.state.eventSeq,
      hook: scope,
      callIndex: this.state.rollCallSeq,
    });
  }

  findActor(actorId: string): ActorState | undefined {
    return this.state.actors[actorId];
  }

  requireActor(actorId: string): ActorState {
    const actor = this.state.actors[actorId];
    if (actor === undefined) {
      throw new RuleRuntimeError('unknown_actor', `运行时里没有角色「${actorId}」`);
    }
    return actor;
  }

  onCardMutated(actorId: string): void {
    void actorId;
    // 派生值在每次结算入口重算（computeDerived），这里只做标记点，避免钩子内递归调用 computeDerived
  }

  isActiveActor(actorId: string): boolean {
    if (!this.state.combat.active) return true;
    return this.state.combat.order[this.state.combat.activeIndex] === actorId;
  }

  currentRound(): number {
    return this.state.combat.active ? this.state.combat.round : this.state.time.round;
  }

  // --- 派生值 / 公式 / 投影 -------------------------------------------------

  derivedOf(actorId: string): Record<string, number | string> {
    return { ...this.requireActor(actorId).derived };
  }

  refreshDerived(actorId: string): Record<string, number | string> {
    const actor = this.requireActor(actorId);
    const sheet = toPlainJson(actor.card);
    const outcome = this.hooks.call<Record<string, number | string>>({
      hook: 'computeDerived',
      actorId,
      args: [sheet],
      ctxData: { derived: { ...actor.derived } },
      inputSummary: { cardId: actor.card.cardId },
      default: () => ({}),
      validate: (value) => validateHookValue('computeDerived', value),
    });
    const derived: Record<string, number | string> = {};
    const value: unknown = outcome.value;
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (isFiniteNumber(item) || typeof item === 'string') derived[key] = item;
      }
    }
    const liveActor = this.requireActor(actorId);
    liveActor.derived = derived;
    return { ...derived };
  }

  projectSheet(actorId: string): SheetProjection {
    const actor = this.requireActor(actorId);
    return buildSheetProjection(this.rules, actor.card, actor.derived);
  }

  formulaContext(actorId: string, extra?: FormulaContext): FormulaContext {
    const actor = this.requireActor(actorId);
    const projection = this.projectSheet(actorId);
    const numericFields: Record<string, number> = {};
    for (const [key, value] of Object.entries(projection.fields)) {
      if (isFiniteNumber(value)) numericFields[key] = value;
    }
    const resourceMax: Record<string, number> = {};
    for (const resource of projection.resources) resourceMax[resource.id] = resource.max;
    const skillTotals: Record<string, number> = {};
    for (const skill of projection.skills) skillTotals[skill.id] = skill.total;
    const base: FormulaContext = {
      attr: { ...actor.card.attributes },
      derived: { ...projection.derived },
      equip: { ...projection.equipment.statValues },
      skill: skillTotals,
      sheet: numericFields,
      resource: resourceMax,
      space: {},
      time: { round: this.currentRound(), segment: this.state.time.segment, day: this.state.time.day },
      level: cardLevel(actor.card),
    };
    base.proficiency = this.proficiencyOf(base, projection.derived);
    if (extra === undefined) return base;
    return {
      ...base,
      ...(extra.attr !== undefined ? { attr: { ...base.attr, ...extra.attr } } : {}),
      ...(extra.derived !== undefined ? { derived: { ...base.derived, ...extra.derived } } : {}),
      ...(extra.equip !== undefined ? { equip: { ...base.equip, ...extra.equip } } : {}),
      ...(extra.skill !== undefined ? { skill: { ...base.skill, ...extra.skill } } : {}),
      ...(extra.sheet !== undefined ? { sheet: { ...base.sheet, ...extra.sheet } } : {}),
      ...(extra.resource !== undefined ? { resource: { ...base.resource, ...extra.resource } } : {}),
      ...(extra.space !== undefined ? { space: { ...base.space, ...extra.space } } : {}),
      ...(extra.time !== undefined ? { time: { ...base.time, ...extra.time } } : {}),
      ...(extra.level !== undefined ? { level: extra.level } : {}),
      ...(extra.proficiency !== undefined ? { proficiency: extra.proficiency } : {}),
    };
  }

  private proficiencyOf(base: FormulaContext, derived: Record<string, number | string>): number {
    const source = this.rules.formulas.proficiency;
    if (source !== undefined) {
      const compiled = compileFormula(source, formulaScopeOf(this.rules));
      if (compiled.ok) {
        const result = evaluateFormula(compiled.ast, base);
        if (result.ok) return result.value;
      }
    }
    const fromDerived = derived.proficiency;
    if (isFiniteNumber(fromDerived)) return fromDerived;
    return 2;
  }

  private compiledFormula(name: string): FormulaNode {
    const cached = this.formulaCache.get(name);
    if (cached !== undefined) return cached;
    const source = this.rules.formulas[name];
    if (source === undefined) {
      throw new RuleRuntimeError('formula_missing', `规则包没有定义公式「${name}」`);
    }
    const compiled = compileFormula(source, formulaScopeOf(this.rules));
    if (!compiled.ok) {
      throw new RuleRuntimeError(
        'formula_error',
        `公式「${name}」编译失败：${compiled.errors.map((issue) => `第 ${issue.position} 列 ${issue.message}`).join('；')}`,
      );
    }
    this.formulaCache.set(name, compiled.ast);
    return compiled.ast;
  }

  evalNamedFormula(actorId: string, name: string, extra?: FormulaContext): number {
    const ast = this.compiledFormula(name);
    const context = this.formulaContext(actorId, extra);
    const result = evaluateFormula(ast, context);
    if (!result.ok) {
      throw new RuleRuntimeError('formula_error', `公式「${name}」求值失败：${result.error}`);
    }
    return result.value;
  }

  tryEvalNamedFormula(
    actorId: string,
    name: string,
    extra?: FormulaContext,
  ): { ok: true; value: number } | { ok: false; error: string } {
    try {
      return { ok: true, value: this.evalNamedFormula(actorId, name, extra) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- 公共 API：角色 -------------------------------------------------------

  private guarded<T>(fn: () => T): RuleResult<T> {
    try {
      return { ok: true, ...fn() } as RuleResult<T>;
    } catch (error) {
      return { ok: false, error: errorInfo(error) };
    }
  }

  listActors(): ActorView[] {
    return Object.values(this.state.actors).map(actorView);
  }

  getActor(actorId: string): RuleResult<{ actor: ActorView }> {
    return this.guarded(() => ({ actor: actorView(this.requireActor(actorId)) }));
  }

  addActor(input: AddActorInput): RuleResult<{ actor: ActorView; validation: string[] }> {
    return this.guarded(() => this.addActorOrThrow(input));
  }

  private addActorOrThrow(input: AddActorInput): { actor: ActorView; validation: string[] } {
    if (!isRecord(input) || !isRecord(input.card)) {
      throw new RuleRuntimeError('invalid_request', 'addActor 需要 { card } 卡实例对象');
    }
    const card = toPlainJson(input.card) as CardInstance;
    const schemaErrors = validateCard(this.rules, card);
    const actorId = isNonEmptyString(input.actorId) ? input.actorId : card.cardId;
    if (!isNonEmptyString(actorId)) throw new RuleRuntimeError('invalid_request', '角色卡缺少 cardId');
    if (this.state.actors[actorId] !== undefined) {
      throw new RuleRuntimeError('invalid_request', `角色「${actorId}」已在运行时里，不能重复加入`);
    }
    const name = isNonEmptyString(input.name)
      ? input.name
      : typeof card.fields.name === 'string'
        ? card.fields.name
        : card.cardId;
    const actor: ActorState = {
      actorId,
      name,
      team: input.team ?? 'player',
      card,
      position: normalizePositionOf(input.position),
      effects: [],
      turn: {},
      dead: false,
      tempHp: 0,
      derived: {},
    };
    // 卡上既有状态 → 效果栈（权威在内核，卡 statuses 是投影读面）
    for (const status of Array.isArray(card.statuses) ? card.statuses : []) {
      const normalized = normalizeEffectInput(
        this.rules,
        {
          statusId: status.id,
          stacks: status.stacks ?? 1,
          ...(status.remaining !== undefined ? { remaining: status.remaining } : {}),
        },
        actorId,
        undefined,
      );
      applyEffect(this, actor, normalized);
    }
    this.state.actors[actorId] = actor;
    refillTurnResources(this, actor);
    this.refreshDerived(actorId);
    const hookValidation = runValidateSheetHook(this, this.requireActor(actorId));
    const errors = [...schemaErrors, ...hookValidation.errors];
    if (errors.length > 0) {
      delete this.state.actors[actorId];
      throw new RuleRuntimeError(
        'invalid_sheet',
        `角色卡校验失败：${errors.join('；')}`,
        '修正卡数据或 validateSheet 钩子返回的问题后重试',
      );
    }
    return { actor: actorView(this.requireActor(actorId)), validation: hookValidation.errors };
  }

  removeActor(actorId: string): RuleResult<{ removed: boolean }> {
    return this.guarded(() => {
      if (this.state.combat.active) {
        throw new RuleRuntimeError('combat_active', '战斗中不能移除角色，请先结束战斗');
      }
      if (this.state.actors[actorId] === undefined) {
        throw new RuleRuntimeError('unknown_actor', `运行时里没有角色「${actorId}」`);
      }
      delete this.state.actors[actorId];
      return { removed: true };
    });
  }

  changeEquipment(request: ChangeEquipmentRequest): RuleResult<{ actor: ActorView; validation: string[] }> {
    return this.guarded(() => {
      if (!isRecord(request) || !isNonEmptyString(request.actorId) || !Array.isArray(request.equipmentInstances)) {
        throw new RuleRuntimeError('invalid_request', 'changeEquipment 需要 { actorId, equipmentInstances[] }');
      }
      const actor = this.requireActor(request.actorId);
      const previous = toPlainJson(actor.card.equipmentInstances ?? []);
      const candidate = toPlainJson(actor.card);
      candidate.equipmentInstances = toPlainJson(request.equipmentInstances);
      const errors = validateCard(this.rules, candidate);
      if (errors.length > 0) {
        throw new RuleRuntimeError('invalid_sheet', `换装校验失败：${errors.join('；')}`);
      }
      actor.card.equipmentInstances = candidate.equipmentInstances;
      this.refreshDerived(actor.actorId);
      const validation = runValidateSheetHook(this, actor);
      if (validation.errors.length > 0) {
        actor.card.equipmentInstances = previous;
        this.refreshDerived(actor.actorId);
        throw new RuleRuntimeError('invalid_sheet', `换装校验失败：${validation.errors.join('；')}`);
      }
      this.emit('equip/change', {
        actorId: actor.actorId,
        instanceIds: actor.card.equipmentInstances.map((instance) => instance.instanceId),
        usedHook: validation.usedHook,
      });
      return { actor: actorView(this.requireActor(actor.actorId)), validation: [] };
    });
  }

  validateSheet(actorId: string): RuleResult<ValidateSheetResultData> {
    return this.guarded(() => {
      const actor = this.requireActor(actorId);
      const schemaErrors = validateCard(this.rules, actor.card);
      const hook = runValidateSheetHook(this, actor);
      return {
        actorId,
        errors: [...schemaErrors, ...hook.errors],
        usedHook: hook.usedHook,
      };
    });
  }

  getDerived(actorId: string): RuleResult<{ actorId: string; derived: Record<string, number | string> }> {
    return this.guarded(() => ({ actorId, derived: this.derivedOf(actorId) }));
  }

  getSheet(actorId: string): RuleResult<SheetProjectionResultData> {
    return this.guarded(() => ({ actorId, projection: this.projectSheet(actorId) }));
  }

  // --- 公共 API：战斗 -------------------------------------------------------

  startCombat(request: StartCombatRequest = {}): RuleResult<{ view: CombatView; rolls: DiceRollRecord[] }> {
    return this.guarded(() => {
      const result = combatStart(this, request);
      return { view: result.view, rolls: result.rolls.map((roll) => ({ expr: roll.expr, dice: [...roll.dice], modifier: roll.modifier, total: roll.total })) };
    });
  }

  getCombat(): CombatView {
    return combatView(this);
  }

  endTurn(request: EndTurnRequest = {}): RuleResult<{ view: CombatView }> {
    return this.guarded(() => ({ view: combatEndTurn(this, request) }));
  }

  endCombat(request: EndCombatRequest = {}): RuleResult<{ view: CombatView }> {
    return this.guarded(() => ({ view: combatEndCombat(this, request) }));
  }

  // --- 公共 API：结算 -------------------------------------------------------

  rollCheck(request: RollCheckRequest): RuleResult<CheckResultData> {
    return this.guarded(() => resolveRollCheck(this, request));
  }

  useAction(request: UseActionRequest): RuleResult<ActionResultData> {
    return this.guarded(() => resolveUseAction(this, request));
  }

  applyDamage(request: ApplyDamageRequest): RuleResult<DamageResultData> {
    return this.guarded(() => resolveApplyDamage(this, request));
  }

  move(request: MoveRequest): RuleResult<MoveResultData> {
    return this.guarded(() => moveActor(this, request));
  }

  computeDistance(request: DistanceRequest = {}): RuleResult<DistanceResultData> {
    return this.guarded(() => computeDistanceFor(this, request));
  }

  computeCover(request: CoverRequest): RuleResult<CoverResultData> {
    return this.guarded(() => computeCoverFor(this, request));
  }

  resolveLoot(request: LootRequest = {}): RuleResult<LootResultData> {
    return this.guarded(() => resolveLootFor(this, request));
  }

  levelUp(request: LevelUpRequest): RuleResult<LevelUpResultData> {
    return this.guarded(() => levelUpActor(this, request));
  }

  advanceTime(request: AdvanceTimeRequest = {}): RuleResult<TimeResultData> {
    return this.guarded(() => timeAdvance(this, request));
  }

  // --- 公共 API：快照 -------------------------------------------------------

  exportState(): RuntimeSnapshot {
    return exportSnapshot(this.state, this.rules);
  }

  importState(snapshot: unknown): RuleResult<{ round: number }> {
    return this.guarded(() => {
      const result = importSnapshot(this.state, snapshot, this.rules);
      if (!result.ok) {
        throw new RuleRuntimeError('invalid_snapshot', `快照无法导入：${result.errors.join('；')}`);
      }
      return { round: this.currentRound() };
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    if (this.sandbox !== null) {
      this.sandbox.dispose();
      this.sandbox = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function normalizePositionOf(raw: unknown): PositionState {
  if (!isRecord(raw)) return {};
  const position: PositionState = {};
  if (isNonEmptyString(raw.zoneId)) position.zoneId = raw.zoneId;
  if (isRecord(raw.cell) && isFiniteNumber(raw.cell.x) && isFiniteNumber(raw.cell.y) && isInteger(raw.cell.x) && isInteger(raw.cell.y)) {
    position.cell = { x: raw.cell.x, y: raw.cell.y };
  }
  return position;
}

function formulaScopeOf(rules: RulePack) {
  return {
    attributes: rules.sheet.attributes.map((attribute) => attribute.id),
    resources: rules.sheet.resources.map((resource) => resource.id),
    fields: rules.sheet.fields.filter((field) => field.kind === 'number').map((field) => field.id),
    stats: rules.sheet.equipment.stats.map((stat) => stat.id),
    skills: rules.sheet.skills.map((skill) => skill.id),
  };
}

export const RUNTIME_API_VERSION = 'trpg.runtime/1' as const;

/**
 * 创建规则运行时（M9.3/M9.4 的唯一入口）。
 *
 * 抛错场景（宿主应转成可读中文提示）：
 * - 规则包脚本 sha256 与 `rules.scripts` 清单不符 / 缺失 → `RuleRuntimeError(script_integrity)`；
 * - 脚本语法错误 / 加载期抛错 / 超时 → `RuleRuntimeError(script_load)`。
 *
 * 其余运行期错误都通过返回值 `{ ok:false, error:{code,messageZh,hint?} }` 或 `rules/error` 事件给出，
 * 不崩运行时。
 */
export function createRuleRuntime(options: CreateRuleRuntimeOptions): RuleRuntime {
  return new RuleRuntimeCore(options);
}
