/**
 * 战斗与回合推进（M9.2，docs/RULES-MODEL §3 time/turn、§6 回合钩子、§7 调用链）。
 *
 * - 先攻：d20 + `formulas.initiative`（缺省 0），按总值降序、dex 降序、actorId 升序；
 * - 回合：`endTurn` 自动找下一个存活行动者；跨轮自动 `round/end → tick → onRoundEnd → round/limit?
 *   → onRoundStart → round/start`；
 * - 行动经济：`turn.resources[]` 每回合回满（`count` / `perTurnFormula`），移动力是资源的一种；
 * - 回合上限：`maxRounds`（房间覆盖 > `time.defaultMaxRounds`）到点触发 `onRoundLimit`，
 *   返回 `end | draw | overtime`（无钩子按 `time.onRoundLimit`）。
 */
import type { ActionCost, ActionDef, RulePack } from '../types.ts';
import type { RuntimeEnv } from './env.ts';
import { rollDice, type DiceRoll } from './dice.ts';
import { tickAllEffects } from './time.ts';
import {
  type ActionCostSpent,
  type ActorState,
  type CombatOrderView,
  type CombatView,
  type EndCombatRequest,
  type EndTurnRequest,
  type RuntimeEventKind,
  type StartCombatRequest,
  RuleRuntimeError,
} from './types.ts';
import { isFiniteNumber, isPositiveInteger, isRecord } from './util.ts';

// ---------------------------------------------------------------------------
// 行动经济
// ---------------------------------------------------------------------------

/** 移动力资源 id（`turn.movement.id`）。 */
export function movementResourceId(rules: RulePack): string | undefined {
  return rules.turn.movement?.id;
}

/** 把动作花费拆成「行动经济消耗」+「角色资源消耗」。 */
export function parseActionCost(action: ActionDef): ActionCostSpent {
  const spent: ActionCostSpent = { turn: {} };
  const cost: ActionCost | undefined = action.cost;
  if (cost === undefined) return spent;
  for (const [key, value] of Object.entries(cost)) {
    if (value === undefined) continue;
    if (key === 'resource') {
      if (typeof value === 'string') {
        spent.resource = { id: value, amount: 1 };
      } else if (isRecord(value) && typeof value.id === 'string') {
        spent.resource = { id: value.id, amount: isFiniteNumber(value.amount) ? value.amount : 1 };
      }
      continue;
    }
    if (isFiniteNumber(value)) spent.turn[key] = value;
  }
  return spent;
}

/** 每回合回满行动经济资源（含移动力）。 */
export function refillTurnResources(env: RuntimeEnv, actor: ActorState): void {
  const rules = env.rules;
  const values: Record<string, number> = {};
  for (const resource of rules.turn.resources) {
    let count = resource.count ?? 1;
    if (resource.perTurnFormula !== undefined) {
      const result = env.tryEvalNamedFormula(actor.actorId, resource.perTurnFormula);
      if (result.ok) count = result.value;
    }
    values[resource.id] = Math.max(0, Math.floor(count));
  }
  const movement = rules.turn.movement;
  if (movement !== undefined) {
    let cells = movement.cells ?? 0;
    if (movement.perTurnFormula !== undefined) {
      const result = env.tryEvalNamedFormula(actor.actorId, movement.perTurnFormula);
      if (result.ok) cells = result.value;
    }
    if (movement.meters !== undefined && movement.cells === undefined) {
      cells = Math.floor(movement.meters / env.space.cellMeters);
    }
    values[movement.id] = Math.max(0, Math.floor(cells));
  }
  actor.turn = values;
}

/** 检查能不能付得起（返回中文原因，null = 付得起）。 */
export function canAffordCost(env: RuntimeEnv, actor: ActorState, spent: ActionCostSpent): string | null {
  for (const [key, amount] of Object.entries(spent.turn)) {
    const remaining = actor.turn[key] ?? 0;
    if (remaining < amount) {
      const resource = env.rules.turn.resources.find((item) => item.id === key);
      return `${resource?.name ?? key}不足（需要 ${amount}，剩余 ${remaining}）`;
    }
  }
  if (spent.resource !== undefined) {
    const resource = actor.card.resources[spent.resource.id];
    if (resource === undefined) return `缺少资源「${spent.resource.id}」`;
    if (resource.current < spent.resource.amount) {
      const def = env.rules.sheet.resources.find((item) => item.id === spent.resource?.id);
      return `${def?.name ?? spent.resource.id}不足（需要 ${spent.resource.amount}，当前 ${resource.current}）`;
    }
  }
  return null;
}

/** 扣行动经济 + 角色资源（原子：先整体校验再扣）。 */
export function payActionCost(env: RuntimeEnv, actor: ActorState, spent: ActionCostSpent): void {
  const reason = canAffordCost(env, actor, spent);
  if (reason !== null) {
    throw new RuleRuntimeError('insufficient_turn_resource', `${actor.name} ${reason}`, '换个动作或结束回合');
  }
  for (const [key, amount] of Object.entries(spent.turn)) {
    actor.turn[key] = Math.max(0, (actor.turn[key] ?? 0) - amount);
  }
  if (spent.resource !== undefined) {
    const resource = actor.card.resources[spent.resource.id];
    if (resource !== undefined) resource.current -= spent.resource.amount;
    env.onCardMutated(actor.actorId);
  }
}

/** 扣移动力（move 用）。 */
export function spendMovement(env: RuntimeEnv, actor: ActorState, cost: number): number | null {
  const movementId = movementResourceId(env.rules);
  if (movementId === undefined) return null;
  const remaining = actor.turn[movementId] ?? 0;
  if (remaining < cost) {
    throw new RuleRuntimeError(
      'insufficient_turn_resource',
      `${actor.name} 移动力不足（需要 ${cost}，剩余 ${remaining}）`,
      '可以改用更短的路线或结束回合',
    );
  }
  actor.turn[movementId] = remaining - cost;
  return actor.turn[movementId] as number;
}

/** 设置移动力剩余（onMove 钩子接管时用）。 */
export function setMovementRemaining(env: RuntimeEnv, actor: ActorState, remaining: number): void {
  const movementId = movementResourceId(env.rules);
  if (movementId === undefined) return;
  actor.turn[movementId] = Math.max(0, Math.floor(remaining));
}

/** 回合行动经济是否耗尽（`turn.endTurn.trigger = "auto"` 用；移动力不计）。 */
export function isTurnExhausted(env: RuntimeEnv, actor: ActorState): boolean {
  const resources = env.rules.turn.resources;
  if (resources.length === 0) return false;
  for (const resource of resources) {
    if ((actor.turn[resource.id] ?? 0) > 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 先攻
// ---------------------------------------------------------------------------

/** 先攻加值：`formulas.initiative` > `derived.initiative` > 0。 */
export function initiativeBonus(env: RuntimeEnv, actor: ActorState): number {
  const named = env.tryEvalNamedFormula(actor.actorId, 'initiative');
  if (named.ok) return Math.trunc(named.value);
  const derived = actor.derived.initiative;
  if (isFiniteNumber(derived)) return Math.trunc(derived);
  return 0;
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export function combatView(env: RuntimeEnv): CombatView {
  const combat = env.state.combat;
  const order: CombatOrderView[] = [];
  for (const actorId of combat.order) {
    const actor = env.state.actors[actorId];
    if (actor === undefined) continue;
    order.push({
      actorId: actor.actorId,
      name: actor.name,
      team: actor.team,
      initiative: actor.initiative ?? 0,
      roll: actor.initiativeRoll ?? 0,
      dead: actor.dead,
    });
  }
  const activeId = combat.active ? combat.order[combat.activeIndex] : undefined;
  return {
    active: combat.active,
    round: combat.active ? combat.round : env.state.time.round,
    maxRounds: combat.maxRounds,
    order,
    activeActorId: activeId ?? null,
    overtime: combat.overtime,
    ...(combat.limitAction !== undefined ? { limitAction: combat.limitAction } : {}),
    ...(combat.endedReason !== undefined ? { endedReason: combat.endedReason } : {}),
    ...(combat.reason !== undefined ? { reason: combat.reason } : {}),
  };
}

function currentActorId(env: RuntimeEnv): string | undefined {
  const combat = env.state.combat;
  if (!combat.active) return undefined;
  return combat.order[combat.activeIndex];
}

/** 战斗内校验「轮到谁行动」；战斗外恒通过。 */
export function assertCanAct(env: RuntimeEnv, actorId: string): ActorState {
  const actor = env.requireActor(actorId);
  if (actor.dead) {
    throw new RuleRuntimeError('actor_dead', `${actor.name} 已经倒下，不能行动`);
  }
  const combat = env.state.combat;
  if (!combat.active) return actor;
  const active = currentActorId(env);
  if (active !== actorId) {
    const activeName = active === undefined ? '未知' : env.state.actors[active]?.name ?? active;
    throw new RuleRuntimeError('not_active', `当前轮到 ${activeName} 行动，${actor.name} 不能抢先结算`, '先结束当前角色的回合');
  }
  return actor;
}

// ---------------------------------------------------------------------------
// 开始 / 结束战斗
// ---------------------------------------------------------------------------

export interface StartCombatResult {
  view: CombatView;
  rolls: DiceRoll[];
}

export function startCombat(env: RuntimeEnv, request: StartCombatRequest = {}): StartCombatResult {
  const state = env.state;
  if (state.combat.active) {
    throw new RuleRuntimeError('combat_active', `战斗已在进行（第 ${state.combat.round} 轮），不能重复开战`);
  }
  const ids = request.actorIds === undefined
    ? Object.keys(state.actors).filter((actorId) => state.actors[actorId]?.dead !== true)
    : request.actorIds;
  if (ids.length === 0) {
    throw new RuleRuntimeError('invalid_request', '没有可以参战的角色', '先把角色加入运行时（addActor）');
  }
  const combatants: ActorState[] = [];
  for (const actorId of ids) {
    const actor = env.requireActor(actorId);
    if (actor.dead) throw new RuleRuntimeError('actor_dead', `${actor.name} 已经倒下，不能参战`);
    if (!combatants.includes(actor)) combatants.push(actor);
  }
  const requestedMax = request.maxRounds;
  let maxRounds = 0;
  if (requestedMax !== undefined) {
    if (!isPositiveInteger(requestedMax)) throw new RuleRuntimeError('invalid_request', 'maxRounds 必须是正整数');
    maxRounds = requestedMax;
  } else if (isPositiveInteger(env.rules.time?.defaultMaxRounds)) {
    maxRounds = env.rules.time?.defaultMaxRounds as number;
  }
  const session = env.beginRoll('initiative');
  const rolls: DiceRoll[] = [];
  const entries = combatants.map((actor) => {
    const roll = rollDice('d20', session);
    rolls.push(roll);
    const bonus = initiativeBonus(env, actor);
    actor.initiativeRoll = roll.total;
    actor.initiative = roll.total + bonus;
    return { actor, total: actor.initiative, dex: dexOf(actor), roll: roll.total, bonus };
  });
  entries.sort((a, b) => b.total - a.total || b.dex - a.dex || a.actor.actorId.localeCompare(b.actor.actorId));
  const combat = state.combat;
  combat.active = true;
  combat.order = entries.map((entry) => entry.actor.actorId);
  combat.activeIndex = 0;
  combat.round = Math.max(1, state.time.round);
  combat.maxRounds = maxRounds;
  combat.overtime = false;
  combat.limitAction = undefined;
  combat.endedReason = undefined;
  combat.startedSeq = state.eventSeq;
  if (request.reason !== undefined) combat.reason = request.reason;
  state.time.round = combat.round;
  if (request.mapId !== undefined) env.space.activateMap(state.space, request.mapId);
  else if (state.space.mapId === undefined && env.space.hasMaps()) {
    const firstMap = env.space.firstMapId();
    if (firstMap !== undefined) state.space.mapId = firstMap;
  }
  for (const actor of combatants) refillTurnResources(env, actor);
  env.emit('combat/start', {
    round: combat.round,
    maxRounds: combat.maxRounds,
    order: [...combat.order],
    reason: request.reason ?? null,
  });
  env.hooks.call({
    hook: 'onRoundStart',
    args: [{ round: combat.round, order: [...combat.order], phase: 'start' }],
    inputSummary: { round: combat.round, order: [...combat.order] },
    default: () => ({}),
    sideEffects: true,
  });
  env.emit('round/start', { round: combat.round, order: [...combat.order] });
  const first = combat.order[0];
  if (first !== undefined) {
    env.emit('turn/start', { actorId: first, round: combat.round, order: [...combat.order] });
  }
  return { view: combatView(env), rolls };
}

function dexOf(actor: ActorState): number {
  const dex = actor.card.attributes.dex;
  return isFiniteNumber(dex) ? dex : 0;
}

function endCombatInternal(env: RuntimeEnv, reason: string): void {
  const combat = env.state.combat;
  combat.active = false;
  combat.endedReason = reason;
  combat.activeIndex = 0;
  env.emit('combat/end', { reason, round: combat.round, order: [...combat.order] });
}

export function endCombat(env: RuntimeEnv, request: EndCombatRequest = {}): CombatView {
  if (!env.state.combat.active) {
    throw new RuleRuntimeError('no_combat', '当前没有进行中的战斗');
  }
  endCombatInternal(env, request.reason ?? 'manual');
  return combatView(env);
}

// ---------------------------------------------------------------------------
// 回合推进
// ---------------------------------------------------------------------------

/** 找下一个还能行动的角色；返回 null = 全员倒下。 */
function findNextIndex(env: RuntimeEnv): { index: number; wrapped: boolean } | null {
  const combat = env.state.combat;
  const total = combat.order.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (combat.activeIndex + step) % total;
    const actorId = combat.order[index];
    const actor = actorId === undefined ? undefined : env.state.actors[actorId];
    if (actor === undefined || actor.dead) continue;
    return { index, wrapped: index <= combat.activeIndex };
  }
  return null;
}

/** 当前行动者结束回合（跨轮时自动走完回合边界）。 */
export function endTurn(env: RuntimeEnv, request: EndTurnRequest = {}): CombatView {
  const state = env.state;
  const combat = state.combat;
  if (!combat.active) {
    throw new RuleRuntimeError('no_combat', '当前没有进行中的战斗，不能结束回合');
  }
  const activeId = combat.order[combat.activeIndex];
  if (request.actorId !== undefined && request.actorId !== activeId) {
    const activeName = activeId === undefined ? '未知' : state.actors[activeId]?.name ?? activeId;
    throw new RuleRuntimeError('not_active', `当前轮到 ${activeName} 行动，不能结束别人的回合`);
  }
  const endingActor = activeId === undefined ? undefined : state.actors[activeId];
  void endingActor;
  env.emit('turn/end', {
    actorId: activeId ?? null,
    round: combat.round,
    order: [...combat.order],
  });

  const next = findNextIndex(env);
  if (next === null) {
    endCombatInternal(env, 'all_down');
    return combatView(env);
  }

  if (next.wrapped) {
    const roundNow = combat.round;
    // 1) 内核 tick 持续效果（§3 time：状态统一按回合 tick）
    tickAllEffects(env);
    // 2) onRoundEnd（专用钩子先于事件总线）
    env.hooks.call({
      hook: 'onRoundEnd',
      args: [{ round: roundNow, order: [...combat.order], phase: 'end' }],
      inputSummary: { round: roundNow, order: [...combat.order] },
      default: () => ({}),
      sideEffects: true,
    });
    env.emit('round/end', { round: roundNow, order: [...combat.order] });
    const nextRound = roundNow + 1;
    // 3) 回合上限
    if (combat.maxRounds > 0 && roundNow >= combat.maxRounds && combat.limitAction === undefined) {
      const limit = resolveRoundLimit(env, roundNow);
      combat.limitAction = limit.action;
      env.emit('round/limit', { round: roundNow, maxRounds: combat.maxRounds, action: limit.action });
      if (limit.action === 'end' || limit.action === 'draw') {
        state.time.round = nextRound;
        combat.round = nextRound;
        endCombatInternal(env, limit.action === 'draw' ? 'draw' : 'round_limit');
        return combatView(env);
      }
      combat.overtime = true;
    }
    state.time.round = nextRound;
    combat.round = nextRound;
    // 4) onRoundStart + round/start
    env.hooks.call({
      hook: 'onRoundStart',
      args: [{ round: nextRound, order: [...combat.order], phase: 'start' }],
      inputSummary: { round: nextRound, order: [...combat.order] },
      default: () => ({}),
      sideEffects: true,
    });
    env.emit('round/start', { round: nextRound, order: [...combat.order] });
  }

  combat.activeIndex = next.index;
  const nextActorId = combat.order[next.index];
  const nextActor = nextActorId === undefined ? undefined : state.actors[nextActorId];
  if (nextActor !== undefined) {
    refillTurnResources(env, nextActor);
    env.emit('turn/start', { actorId: nextActor.actorId, round: combat.round, order: [...combat.order] });
  }
  return combatView(env);
}

interface RoundLimitResolution {
  action: 'end' | 'draw' | 'overtime';
  usedHook: boolean;
}

function resolveRoundLimit(env: RuntimeEnv, round: number): RoundLimitResolution {
  const defaultAction = env.rules.time?.onRoundLimit ?? 'end';
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'onRoundLimit',
    args: [{ round, maxRounds: env.state.combat.maxRounds, order: [...env.state.combat.order] }],
    inputSummary: { round, maxRounds: env.state.combat.maxRounds },
    default: () => ({ action: defaultAction }),
    sideEffects: true,
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  const action = value.action === 'draw' || value.action === 'overtime' ? value.action : value.action === 'end' ? 'end' : defaultAction;
  return { action, usedHook: outcome.usedHook };
}

/** `turn.endTurn.trigger = "auto"`：打完最后一个行动经济资源自动结束回合。 */
export function autoEndTurnIfExhausted(env: RuntimeEnv, actor: ActorState): RuntimeEventKind[] {
  const state = env.state;
  if (!state.combat.active) return [];
  if (env.rules.turn.endTurn?.trigger !== 'auto') return [];
  if (!isTurnExhausted(env, actor)) return [];
  if (currentActorId(env) !== actor.actorId) return [];
  endTurn(env, {});
  return ['turn/end', 'turn/start'];
}

/** 战斗开始时各角色行动经济初始化（供 addActor / 战斗外动作使用）。 */
export function ensureTurnResources(env: RuntimeEnv, actor: ActorState): void {
  if (Object.keys(actor.turn).length === 0) refillTurnResources(env, actor);
}
