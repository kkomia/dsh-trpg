/**
 * 快照与复现（docs/RULES-MODEL §9）。
 *
 * 快照 = 纯 JSON 的运行状态：房间种子、rng 计数器（eventSeq / rollCallSeq / effectSeq）、
 * 时间轮、回合、先攻、位置、效果栈、卡（HP/资源 current）、行动经济。
 * `rulesId/rulesVersion` 只用于校验复现环境一致，不参与随机。
 *
 * 复现保证：同一 roomSeed + 同一命令序列 → `eventSeq/rollCallSeq` 推进一致 → 派生随机一致 →
 * 骰面与结果逐项一致；从任意快照导入后可继续复现。
 */
import type { RulePack } from '../types.ts';
import { RUNTIME_STATE_SCHEMA_VERSION, RuleRuntimeError, type RuntimeSnapshot, type RuntimeState } from './types.ts';
import { isInteger, isRecord, toPlainJson } from './util.ts';

function nonNegativeInteger(value: unknown): boolean {
  return isInteger(value) && value >= 0;
}

/** 导出快照（纯 JSON；可直接 `JSON.stringify` 落盘）。 */
export function exportSnapshot(state: RuntimeState, rules: RulePack): RuntimeSnapshot {
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    roomSeed: state.roomSeed,
    eventSeq: state.eventSeq,
    rollCallSeq: state.rollCallSeq,
    effectSeq: state.effectSeq,
    hookCallCount: state.hookCallCount,
    hookFailures: { ...state.hookFailures },
    disabledHooks: [...state.disabledHooks],
    time: { ...state.time },
    combat: toPlainJson(state.combat),
    space: toPlainJson(state.space),
    actors: toPlainJson(state.actors),
    events: toPlainJson(state.events),
  };
}

export interface ImportSnapshotResult {
  ok: boolean;
  errors: string[];
}

/** 校验快照（不修改状态）。 */
export function validateSnapshot(snapshot: unknown, rules: RulePack): string[] {
  const errors: string[] = [];
  if (!isRecord(snapshot)) return ['快照必须是对象'];
  if (snapshot.schemaVersion !== RUNTIME_STATE_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 "${RUNTIME_STATE_SCHEMA_VERSION}"（收到 ${String(snapshot.schemaVersion)}）`);
  }
  if (snapshot.rulesId !== rules.rulesId) {
    errors.push(`快照的 rulesId（${String(snapshot.rulesId)}）与当前规则包（${rules.rulesId}）不一致，禁止直接续团`);
  }
  if (snapshot.rulesVersion !== rules.rulesVersion) {
    errors.push(`快照的 rulesVersion（${String(snapshot.rulesVersion)}）与当前规则包（${rules.rulesVersion}）不一致，禁止热切换规则`);
  }
  if (!nonNegativeInteger(snapshot.roomSeed)) errors.push('roomSeed 必须是非负整数');
  if (!nonNegativeInteger(snapshot.eventSeq)) errors.push('eventSeq 必须是非负整数');
  if (!nonNegativeInteger(snapshot.rollCallSeq)) errors.push('rollCallSeq 必须是非负整数');
  if (!nonNegativeInteger(snapshot.effectSeq)) errors.push('effectSeq 必须是非负整数');
  const time = snapshot.time;
  if (!isRecord(time) || !nonNegativeInteger(time.round)) errors.push('time.round 必须是非负整数');
  const combat = snapshot.combat;
  if (!isRecord(combat)) {
    errors.push('combat 必须是对象');
  } else {
    if (typeof combat.active !== 'boolean') errors.push('combat.active 必须是布尔值');
    if (!Array.isArray(combat.order)) errors.push('combat.order 必须是数组');
    if (!nonNegativeInteger(combat.activeIndex)) errors.push('combat.activeIndex 必须是非负整数');
  }
  const space = snapshot.space;
  if (!isRecord(space)) errors.push('space 必须是对象');
  const actors = snapshot.actors;
  if (!isRecord(actors)) {
    errors.push('actors 必须是对象（actorId → 角色状态）');
  } else {
    for (const [actorId, actor] of Object.entries(actors)) {
      if (!isRecord(actor)) {
        errors.push(`actors.${actorId} 必须是对象`);
        continue;
      }
      if (actor.actorId !== actorId) errors.push(`actors.${actorId}.actorId 必须与键名一致`);
      if (!isRecord(actor.card)) errors.push(`actors.${actorId}.card 必须是卡实例对象`);
      if (!isRecord(actor.position)) errors.push(`actors.${actorId}.position 必须是对象`);
      if (!Array.isArray(actor.effects)) errors.push(`actors.${actorId}.effects 必须是数组`);
      if (!isRecord(actor.turn)) errors.push(`actors.${actorId}.turn 必须是对象`);
      if (!isRecord(actor.derived)) errors.push(`actors.${actorId}.derived 必须是对象`);
    }
  }
  if (!Array.isArray(snapshot.events)) errors.push('events 必须是数组');
  return errors;
}

/**
 * 导入快照：校验后**原地**替换运行时状态（房间种子也采用快照里的值，便于跨进程续团）。
 * 返回中文错误清单（空 = 成功）。
 */
export function importSnapshot(state: RuntimeState, snapshot: unknown, rules: RulePack): ImportSnapshotResult {
  const errors = validateSnapshot(snapshot, rules);
  if (errors.length > 0) return { ok: false, errors };
  const data = snapshot as RuntimeSnapshot;
  state.roomSeed = data.roomSeed;
  state.eventSeq = data.eventSeq;
  state.rollCallSeq = data.rollCallSeq;
  state.effectSeq = data.effectSeq;
  state.hookCallCount = data.hookCallCount;
  state.hookFailures = { ...data.hookFailures };
  state.disabledHooks = [...data.disabledHooks];
  state.time = { ...data.time };
  state.combat = toPlainJson(data.combat);
  state.space = toPlainJson(data.space);
  state.actors = toPlainJson(data.actors);
  state.events = toPlainJson(data.events);
  return { ok: true, errors: [] };
}

/** 便捷：从快照恢复并校验规则一致；不一致抛 RuleRuntimeError。 */
export function importSnapshotOrThrow(state: RuntimeState, snapshot: unknown, rules: RulePack): void {
  const result = importSnapshot(state, snapshot, rules);
  if (!result.ok) {
    throw new RuleRuntimeError('invalid_snapshot', `快照无法导入：${result.errors.join('；')}`);
  }
}
