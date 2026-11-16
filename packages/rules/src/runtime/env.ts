/**
 * 运行时内部依赖接口（模块之间只依赖这里的抽象，实现见 `index.ts` 的 `RuleRuntimeCore`）。
 *
 * 这样 combat/resolve/time/space 都只 `import type`，不产生运行时循环依赖。
 */
import type { FormulaContext } from '../formula.ts';
import type { RulePack, SheetProjection } from '../types.ts';
import type { HookDispatcher } from './hooks.ts';
import type { RngSession } from './rng.ts';
import type { SpaceRuntime } from './space.ts';
import type {
  ActorState,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeLogLevel,
  RuntimeLogSource,
  RuntimeState,
} from './types.ts';

export interface EngineLogInput {
  source: RuntimeLogSource;
  level: RuntimeLogLevel;
  text: string;
  hook?: string;
  actorId?: string;
}

/** 各结算模块共享的运行时能力。 */
export interface RuntimeEnv {
  readonly rules: RulePack;
  readonly state: RuntimeState;
  readonly config: RuntimeConfig;
  readonly hooks: HookDispatcher;
  readonly space: SpaceRuntime;

  /** 广播事件（内部会驱动 onEvent 钩子）。 */
  emit(kind: RuntimeEventKind, data: Record<string, unknown>): RuntimeEvent;
  /** 开始一次种子随机 session（递增持久化计数器）。 */
  beginRoll(scope: string): RngSession;

  /** 查找角色（不存在返回 undefined）。 */
  findActor(actorId: string): ActorState | undefined;
  requireActor(actorId: string): ActorState;
  /** 已算好的派生值（缺失/过期由调用方先 refreshDerived）。 */
  derivedOf(actorId: string): Record<string, number | string>;
  /** 跑 computeDerived 钩子（缺省 {}）并缓存到 actor.derived。 */
  refreshDerived(actorId: string): Record<string, number | string>;
  /** 主机权威卡面投影（M9.4 直接复用）。 */
  projectSheet(actorId: string): SheetProjection;
  /** 公式上下文（attr/derived/equip/skill/resource/sheet/level/proficiency/space/time）。 */
  formulaContext(actorId: string, extra?: FormulaContext): FormulaContext;
  /** 求命名公式；缺公式/求值失败抛 RuleRuntimeError。 */
  evalNamedFormula(actorId: string, name: string, extra?: FormulaContext): number;
  /** 求命名公式（不抛错）。 */
  tryEvalNamedFormula(
    actorId: string,
    name: string,
    extra?: FormulaContext,
  ): { ok: true; value: number } | { ok: false; error: string };

  log(entry: EngineLogInput): void;
  /** 卡被写后通知（清派生值缓存/重算）。 */
  onCardMutated(actorId: string): void;
  /** 是否战斗内且轮到这个角色行动；战斗外恒 true。 */
  isActiveActor(actorId: string): boolean;
  /** 当前回合序号（战斗内用战斗轮，非战斗用时间轮）。 */
  currentRound(): number;
}
