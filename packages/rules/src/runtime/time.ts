/**
 * 时间与持续效果（M9.2）。
 *
 * v1 时间**只按回合计数**（docs/RULES-MODEL §3 time）：不读系统时钟，没有分/时/日。
 * 状态/效果/冷却统一按回合 tick：每次轮结束（战斗内）或 `advanceTime` 推进时，
 * `remaining > 0` 的效果 -1，归零即移除并广播 `status/tick`；`-1` = 永久不 tick。
 */
import type { RuntimeEnv } from './env.ts';
import { removeEffect } from './hooks.ts';
import type { ActorState, AdvanceTimeRequest, TimeResultData } from './types.ts';
import { RuleRuntimeError } from './types.ts';
import { isFiniteNumber } from './util.ts';

export interface StatusTick {
  actorId: string;
  effectId: string;
  statusId?: string;
  name: string;
  stacks: number;
  remaining: number;
  removed: boolean;
}

/** 给单个角色 tick 一轮状态/效果（会广播 status/tick）。 */
export function tickActorEffects(env: RuntimeEnv, actor: ActorState): StatusTick[] {
  const ticks: StatusTick[] = [];
  const snapshot = [...actor.effects];
  for (const effect of snapshot) {
    if (effect.remaining < 0) continue;
    effect.remaining -= 1;
    if (effect.remaining <= 0) {
      removeEffect(env, actor, effect.effectId);
      ticks.push({
        actorId: actor.actorId,
        effectId: effect.effectId,
        name: effect.name,
        stacks: effect.stacks,
        remaining: 0,
        removed: true,
        ...(effect.statusId !== undefined ? { statusId: effect.statusId } : {}),
      });
      env.emit('status/tick', {
        actorId: actor.actorId,
        effectId: effect.effectId,
        statusId: effect.statusId ?? null,
        name: effect.name,
        remaining: 0,
        removed: true,
      });
      continue;
    }
    ticks.push({
      actorId: actor.actorId,
      effectId: effect.effectId,
      name: effect.name,
      stacks: effect.stacks,
      remaining: effect.remaining,
      removed: false,
      ...(effect.statusId !== undefined ? { statusId: effect.statusId } : {}),
    });
    env.emit('status/tick', {
      actorId: actor.actorId,
      effectId: effect.effectId,
      statusId: effect.statusId ?? null,
      name: effect.name,
      remaining: effect.remaining,
      removed: false,
    });
  }
  return ticks;
}

/** 给全桌 tick 一轮。 */
export function tickAllEffects(env: RuntimeEnv): StatusTick[] {
  const out: StatusTick[] = [];
  for (const actor of Object.values(env.state.actors)) {
    if (actor.dead) continue;
    for (const tick of tickActorEffects(env, actor)) out.push(tick);
  }
  return out;
}

/**
 * 推进时间（非战斗 GM 工具 `trpg_time_advance` 的底座；战斗内也可用来跳回合）。
 * 钩子 `onTimeAdvance({from,to,cause})`：缺省 = 逐回合 tick 状态；钩子存在时由钩子接管。
 */
export function advanceTime(env: RuntimeEnv, request: AdvanceTimeRequest = {}): TimeResultData {
  const state = env.state;
  const roundsRaw = request.rounds === undefined ? 1 : request.rounds;
  if (!isFiniteNumber(roundsRaw) || !Number.isInteger(roundsRaw) || roundsRaw < 1 || roundsRaw > 1000) {
    throw new RuleRuntimeError('invalid_request', `推进回合数必须是 1–1000 的整数（收到 ${String(roundsRaw)}）`);
  }
  const rounds = roundsRaw;
  const from = state.time.round;
  const to = from + rounds;
  const cause = request.cause ?? 'gm';
  const outcome = env.hooks.call({
    hook: 'onTimeAdvance',
    args: [{ from, to, cause, rounds }],
    inputSummary: { from, to, cause, rounds },
    default: () => {
      for (let index = 0; index < rounds; index += 1) tickAllEffects(env);
      return {};
    },
    sideEffects: true,
  });
  state.time.round = to;
  if (state.combat.active) state.combat.round = to;
  env.emit('time/advance', { from, to, cause, rounds });
  return {
    from,
    to,
    round: to,
    usedHook: outcome.usedHook,
    trace: { lines: [`时间推进 ${from} → ${to}（${cause}）`], data: { from, to, cause, rounds } },
  };
}
