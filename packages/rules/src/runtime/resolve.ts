/**
 * 检定与战斗动作结算（M9.2，docs/RULES-MODEL §6/§7）。
 *
 * 所有结算都由种子骰驱动，输出结构化 trace（骰面/公式/中间值）供 GM 与复盘：
 * - `rollCheck`：d20 + 技能总加值/属性调整 + mods vs DC；优势/劣势掷 2d20 取高/低；
 * - `useAction`：校验轮次/行动经济/目标/距离 → 扣 cost → `resolveAttack` → `resolveDamage` → 写回；
 * - `applyDamage`：`resolveDamage` 钩子（抗性/护盾）→ 临时 HP → HP → death 事件；
 * - `moveActor`：边界/障碍/连通性/地形消耗/移动力 → `onMove` 钩子 → 区域进出钩子 → move 事件；
 * - `computeCover` / `resolveLoot` / `levelUp`：数据 + 钩子缺省。
 */
import { LEVEL_FIELD_ID, type ActionDef, type RangeBand, type RulePack } from '../types.ts';
import type { RuntimeEnv } from './env.ts';
import { removeEffect, writeCardPath, type HookRollScope } from './hooks.ts';
import {
  assertCanAct,
  autoEndTurnIfExhausted,
  canAffordCost,
  ensureTurnResources,
  movementResourceId,
  parseActionCost,
  payActionCost,
  setMovementRemaining,
} from './combat.ts';
import { cardLevel } from '../sheet.ts';
import { describePosition, normalizePosition, runZoneTransition } from './space.ts';
import {
  type ActionResultData,
  type ActionCostSpent,
  type ActorState,
  type AdvanceTimeRequest,
  type ApplyDamageRequest,
  type CellPoint,
  type CheckMode,
  type CheckResultData,
  type CombatView,
  type CoverRequest,
  type CoverResultData,
  type DamageResultData,
  type DiceRollRecord,
  type DistanceRequest,
  type DistanceResultData,
  type LevelUpRequest,
  type LevelUpResultData,
  type LootItemInstance,
  type LootRequest,
  type LootResultData,
  type MoveRequest,
  type MoveResultData,
  type PositionState,
  type RollCheckRequest,
  RuleRuntimeError,
  type RuntimeTrace,
  type TimeResultData,
  type UseActionRequest,
} from './types.ts';
import { isFiniteNumber, isNonEmptyString, isRecord, toPlainJson } from './util.ts';

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function diceRecord(roll: { expr: string; dice: number[]; modifier: number; total: number }): DiceRollRecord {
  return { expr: roll.expr, dice: [...roll.dice], modifier: roll.modifier, total: roll.total };
}

function trace(lines: string[], data: Record<string, unknown>): RuntimeTrace {
  return { lines, data };
}

/** HP 资源 id 约定：优先 `hp`，否则第一个资源。 */
export function hitPointsResourceId(rules: RulePack): string | undefined {
  const resources = rules.sheet.resources;
  if (resources.length === 0) return undefined;
  return resources.find((resource) => resource.id === 'hp')?.id ?? resources[0]?.id;
}

function hpOf(actor: ActorState, rules: RulePack): { id: string; current: number; max?: number } | undefined {
  const id = hitPointsResourceId(rules);
  if (id === undefined) return undefined;
  const resource = actor.card.resources[id];
  if (resource === undefined) return undefined;
  return { id, current: resource.current, ...(isFiniteNumber(resource.max) ? { max: resource.max } : {}) };
}

/** 公式变量 `space.cells/meters/hops` 的取值：场地实时距离。 */
export function spaceFormulaContext(env: RuntimeEnv, actor: ActorState, target?: ActorState): Record<string, number> {
  const state = env.state;
  const from = actor.position;
  const to = target?.position;
  const resolved = to === undefined ? env.space.distanceOf(from, from) : env.space.distanceOf(from, to);
  return {
    cells: resolved.basis === 'cells' ? resolved.distance : resolved.basis === 'zones' ? resolved.distance : 0,
    hops: resolved.basis === 'zones' ? resolved.distance : 0,
    meters: resolved.basis === 'cells' ? env.space.metersOf(resolved.distance) : env.space.metersOf(resolved.distance),
  };
}

/** 角色摘要（传给钩子的只读数据）。 */
export function summarizeActor(actor: ActorState): Record<string, unknown> {
  return toPlainJson({
    actorId: actor.actorId,
    name: actor.name,
    team: actor.team,
    dead: actor.dead,
    tempHp: actor.tempHp,
    position: actor.position,
    turn: actor.turn,
    effects: actor.effects,
    derived: actor.derived,
    card: actor.card,
  });
}

/** 属性调整值：`derived.mod.<id>` > `derived.mod` > 0。 */
export function attrModifier(env: RuntimeEnv, actor: ActorState, attributeId: string): { value: number; source: string } {
  const derived = env.derivedOf(actor.actorId);
  const specific = derived[`mod.${attributeId}`];
  if (isFiniteNumber(specific)) return { value: specific, source: `derived.mod.${attributeId}` };
  const generic = derived.mod;
  if (isFiniteNumber(generic)) return { value: generic, source: 'derived.mod' };
  void attributeId;
  return { value: 0, source: '缺省 0（规则包未提供 computeDerived）' };
}

// ---------------------------------------------------------------------------
// 检定
// ---------------------------------------------------------------------------

export interface CheckModifierResult {
  modifier: number;
  source: string;
  skillTotal?: number;
  attributeId?: string;
  skillId?: string;
}

/** 计算检定加值（技能查投影总加值；属性查派生调整值）。 */
export function checkModifier(env: RuntimeEnv, actor: ActorState, request: RollCheckRequest): CheckModifierResult {
  if (request.skillId !== undefined) {
    const projection = env.projectSheet(actor.actorId);
    const skill = projection.skills.find((entry) => entry.id === request.skillId);
    if (skill === undefined) {
      throw new RuleRuntimeError('invalid_request', `规则包没有声明技能「${request.skillId}」`);
    }
    return {
      modifier: skill.total,
      source: `技能「${skill.name}」总加值`,
      skillTotal: skill.total,
      skillId: request.skillId,
    };
  }
  if (request.attributeId !== undefined) {
    const attribute = actor.card.attributes[request.attributeId];
    if (!isFiniteNumber(attribute)) {
      throw new RuleRuntimeError('invalid_request', `角色没有属性「${request.attributeId}」`);
    }
    const mod = attrModifier(env, actor, request.attributeId);
    return { modifier: mod.value, source: `属性「${request.attributeId}」调整值（${mod.source}）`, attributeId: request.attributeId };
  }
  const generic = attrModifier(env, actor, '');
  return { modifier: generic.value, source: generic.source };
}

function pickD20(scope: HookRollScope, mode: CheckMode): { roll: DiceRollRecord; d20: number; rolls: DiceRollRecord[] } {
  if (mode === 'normal') {
    const roll = scope.roll('d20');
    return { roll: diceRecord(roll), d20: roll.dice[0] ?? 0, rolls: [diceRecord(roll)] };
  }
  const roll = scope.roll('2d20');
  const dice = roll.dice;
  const d20 = mode === 'advantage' ? Math.max(...dice) : Math.min(...dice);
  return { roll: diceRecord(roll), d20, rolls: [diceRecord(roll)] };
}

/** 检定（`trpg_roll_check` 的底座）。 */
export function rollCheck(env: RuntimeEnv, request: RollCheckRequest): CheckResultData {
  const actor = env.requireActor(request.actorId);
  if (actor.dead) throw new RuleRuntimeError('actor_dead', `${actor.name} 已经倒下，不能检定`);
  env.refreshDerived(actor.actorId);
  const target = request.targetId === undefined ? undefined : env.requireActor(request.targetId);
  const mode: CheckMode = request.mode === 'advantage' || request.mode === 'disadvantage' ? request.mode : 'normal';
  const dcRaw = request.dc === undefined ? 10 : request.dc;
  if (!isFiniteNumber(dcRaw) || !Number.isInteger(dcRaw) || dcRaw < 0 || dcRaw > 60) {
    throw new RuleRuntimeError('invalid_request', `DC 必须是 0–60 的整数（收到 ${String(dcRaw)}）`);
  }
  const dc = dcRaw;
  const mods = isFiniteNumber(request.mods) ? request.mods : 0;
  const computed = checkModifier(env, actor, request);
  const kind = request.kind ?? (request.skillId !== undefined ? 'skill' : request.attributeId !== undefined ? 'attribute' : 'custom');
  const derived = env.derivedOf(actor.actorId);
  const hookRequest: Record<string, unknown> = {
    kind,
    actorId: actor.actorId,
    actor: summarizeActor(actor),
    modifier: computed.modifier + mods,
    mods,
    dc,
    mode,
    ...(request.skillId !== undefined ? { skillId: request.skillId } : {}),
    ...(request.attributeId !== undefined ? { attributeId: request.attributeId } : {}),
    ...(request.targetId !== undefined ? { targetId: request.targetId } : {}),
    ...(target !== undefined ? { target: summarizeActor(target) } : {}),
    derived,
  };
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'resolveCheck',
    actorId: actor.actorId,
    ...(request.targetId !== undefined ? { targetId: request.targetId } : {}),
    args: [hookRequest],
    inputSummary: { kind, actorId: actor.actorId, targetId: request.targetId ?? null, dc, mode, mods },
    default: (scope) => {
      const { d20, rolls } = pickD20(scope, mode);
      const total = d20 + computed.modifier + mods;
      const crit = d20 === 20;
      const fumble = d20 === 1;
      const success = !fumble && (crit || total >= dc);
      return {
        total,
        success,
        crit,
        degree: crit ? 'crit' : fumble ? 'fumble' : success ? 'success' : 'fail',
        d20,
        rolls,
        log: `检定 d20=${d20}${computed.modifier + mods >= 0 ? '+' : ''}${computed.modifier + mods} = ${total} vs DC ${dc} → ${success ? (crit ? '暴击成功' : '成功') : fumble ? '大失败' : '失败'}`,
      };
    },
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  const total = isFiniteNumber(value.total) ? value.total : 0;
  const success = value.success === true;
  const crit = value.crit === true;
  const fumble = value.degree === 'fumble';
  const degreeRaw = typeof value.degree === 'string' ? value.degree : undefined;
  const degree: CheckResultData['degree'] = degreeRaw === 'crit' || degreeRaw === 'success' || degreeRaw === 'fail' || degreeRaw === 'fumble'
    ? degreeRaw
    : crit
      ? 'crit'
      : fumble
        ? 'fumble'
        : success
          ? 'success'
          : 'fail';
  const d20 = isFiniteNumber(value.d20) ? value.d20 : null;
  const rolls = Array.isArray(value.rolls)
    ? (value.rolls as unknown[]).filter(isRecord).map((roll) => ({
        expr: typeof roll.expr === 'string' ? roll.expr : 'd20',
        dice: Array.isArray(roll.dice) ? roll.dice.filter((die): die is number => isFiniteNumber(die)) : [],
        modifier: isFiniteNumber(roll.modifier) ? roll.modifier : 0,
        total: isFiniteNumber(roll.total) ? roll.total : 0,
      }))
    : outcome.rolls.map(diceRecord);
  const lines = typeof value.log === 'string' ? [value.log] : Array.isArray(value.log) ? value.log.filter((line): line is string => typeof line === 'string') : [];
  const traceOut = trace(
    lines.length > 0
      ? lines
      : [`${actor.name} ${kind}检定：d20=${d20 ?? '?'} + ${computed.modifier + mods} = ${total} vs DC ${dc} → ${success ? '成功' : '失败'}`],
    {
      kind,
      actorId: actor.actorId,
      targetId: request.targetId ?? null,
      dc,
      mode,
      modifier: computed.modifier,
      mods,
      modifierSource: computed.source,
      total,
      success,
      crit,
      degree,
      d20,
      rolls,
      usedHook: outcome.usedHook,
    },
  );
  env.emit('check', {
    actorId: actor.actorId,
    targetId: request.targetId ?? null,
    kind,
    dc,
    mode,
    total,
    success,
    crit,
    degree,
    d20,
    rolls,
    usedHook: outcome.usedHook,
  });
  return {
    actorId: actor.actorId,
    kind,
    dc,
    mode,
    rolls,
    d20,
    modifier: computed.modifier,
    total,
    success,
    crit,
    fumble,
    degree,
    usedHook: outcome.usedHook,
    trace: traceOut,
    ...(request.targetId !== undefined ? { targetId: request.targetId } : {}),
    ...(request.skillId !== undefined ? { skillId: request.skillId } : {}),
    ...(request.attributeId !== undefined ? { attributeId: request.attributeId } : {}),
  };
}

// ---------------------------------------------------------------------------
// 伤害
// ---------------------------------------------------------------------------

/** 伤害落账（`resolveDamage` 钩子 → 临时 HP → HP → death 事件）。 */
export function applyDamage(env: RuntimeEnv, request: ApplyDamageRequest): DamageResultData {
  const target = env.requireActor(request.targetId);
  if (!isFiniteNumber(request.amount) || request.amount < 0) {
    throw new RuleRuntimeError('invalid_request', `伤害值必须是非负数值（收到 ${String(request.amount)}）`);
  }
  const amount = Math.floor(request.amount);
  const hp = hpOf(target, env.rules);
  if (hp === undefined) {
    throw new RuleRuntimeError('invalid_rules', '规则包没有声明 HP 资源，无法结算伤害', '在 sheet.resources 里声明 id=hp 的资源');
  }
  const sourceActor = request.sourceActorId === undefined ? undefined : env.findActor(request.sourceActorId);
  const hookEvent: Record<string, unknown> = {
    targetId: target.actorId,
    target: summarizeActor(target),
    amount,
    type: request.type ?? 'untyped',
    crit: request.crit === true,
    source: sourceActor === undefined
      ? { actorId: request.sourceActorId ?? null }
      : { actorId: sourceActor.actorId, name: sourceActor.name },
    effects: toPlainJson(target.effects),
  };
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'resolveDamage',
    actorId: target.actorId,
    ...(request.sourceActorId !== undefined ? { targetId: request.sourceActorId } : {}),
    args: [hookEvent],
    inputSummary: { targetId: target.actorId, amount, type: request.type ?? 'untyped', sourceActorId: request.sourceActorId ?? null },
    default: () => ({ amount, consumedEffects: [] }),
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  let adjusted = isFiniteNumber(value.amount) ? Math.max(0, Math.floor(value.amount)) : amount;
  const consumedEffects = Array.isArray(value.consumedEffects)
    ? value.consumedEffects.filter((item): item is string => typeof item === 'string')
    : [];
  // 重新取一次（钩子可能整体回滚过，引用会失效）
  const liveTarget = env.requireActor(target.actorId);
  for (const effectId of consumedEffects) removeEffect(env, liveTarget, effectId);
  const hpBefore = hpOf(liveTarget, env.rules)?.current ?? 0;
  let absorbedByTempHp = 0;
  if (liveTarget.tempHp > 0) {
    absorbedByTempHp = Math.min(liveTarget.tempHp, adjusted);
    liveTarget.tempHp -= absorbedByTempHp;
    adjusted -= absorbedByTempHp;
  }
  const resource = liveTarget.card.resources[hp.id];
  if (resource !== undefined) {
    resource.current = Math.max(0, resource.current - adjusted);
  }
  env.onCardMutated(liveTarget.actorId);
  const hpAfter = resource?.current ?? 0;
  const becameDead = hpAfter <= 0 && !liveTarget.dead;
  if (becameDead) liveTarget.dead = true;
  const lines = [
    `${liveTarget.name} 受到 ${adjusted + absorbedByTempHp} 点伤害${absorbedByTempHp > 0 ? `（临时 HP 吸收 ${absorbedByTempHp}）` : ''}：HP ${hpBefore} → ${hpAfter}${becameDead ? '（倒下）' : ''}`,
  ];
  env.emit('damage/after', {
    targetId: liveTarget.actorId,
    sourceActorId: request.sourceActorId ?? null,
    type: request.type ?? 'untyped',
    amount: adjusted + absorbedByTempHp,
    absorbedByTempHp,
    hpBefore,
    hpAfter,
    dead: liveTarget.dead,
    crit: request.crit === true,
    consumedEffects,
    usedHook: outcome.usedHook,
  });
  if (becameDead) {
    env.emit('death', {
      actorId: liveTarget.actorId,
      sourceActorId: request.sourceActorId ?? null,
      type: request.type ?? 'untyped',
      round: env.state.combat.active ? env.state.combat.round : env.state.time.round,
    });
  }
  return {
    targetId: liveTarget.actorId,
    amount: adjusted + absorbedByTempHp,
    absorbedByTempHp,
    hpBefore,
    hpAfter,
    dead: liveTarget.dead,
    consumedEffects,
    usedHook: outcome.usedHook,
    trace: trace(lines, {
      targetId: liveTarget.actorId,
      inputAmount: amount,
      amount: adjusted + absorbedByTempHp,
      absorbedByTempHp,
      hpBefore,
      hpAfter,
      dead: liveTarget.dead,
      consumedEffects,
      usedHook: outcome.usedHook,
    }),
  };
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

interface AttackResolution {
  hit: boolean;
  crit: boolean;
  damage: number;
  detail: Record<string, unknown>;
  rolls: DiceRollRecord[];
  usedHook: boolean;
}

function critRangeOf(env: RuntimeEnv, actor: ActorState): number {
  const projection = env.projectSheet(actor.actorId);
  const value = projection.equipment.statValues['暴击范围'];
  if (isFiniteNumber(value) && value >= 2 && value <= 20) return Math.floor(value);
  return 20;
}

function damageBonusFormula(
  env: RuntimeEnv,
  actor: ActorState,
  action: ActionDef,
  spaceContext: Record<string, number>,
): { value: number; source: string } {
  const extra = { space: spaceContext };
  const named = action.damage?.formula;
  if (named !== undefined) {
    const result = env.tryEvalNamedFormula(actor.actorId, named, extra);
    if (result.ok) return { value: result.value, source: `公式 ${named}` };
    return { value: 0, source: `公式 ${named} 求值失败：${result.error}` };
  }
  const fallback = env.tryEvalNamedFormula(actor.actorId, 'damage', extra);
  if (fallback.ok) return { value: fallback.value, source: '公式 damage' };
  const mod = attrModifier(env, actor, '');
  return { value: mod.value, source: mod.source };
}

function rollDamageAmount(
  env: RuntimeEnv,
  actor: ActorState,
  action: ActionDef,
  critical: boolean,
  scope: HookRollScope,
  spaceContext: Record<string, number>,
): { amount: number; rolls: DiceRollRecord[]; detail: Record<string, unknown> } {
  const expression = action.damage?.dice;
  const rolls: DiceRollRecord[] = [];
  let diceTotal = 0;
  if (expression !== undefined) {
    const first = scope.roll(expression);
    rolls.push(diceRecord(first));
    diceTotal = first.total;
    if (critical) {
      const second = scope.roll(expression);
      rolls.push(diceRecord(second));
      diceTotal += second.total;
    }
  }
  const bonus = damageBonusFormula(env, actor, action, spaceContext);
  const amount = Math.max(0, Math.floor(diceTotal + bonus.value));
  return {
    amount,
    rolls,
    detail: {
      dice: expression ?? null,
      diceTotal,
      bonus: bonus.value,
      bonusSource: bonus.source,
      critical,
      amount,
    },
  };
}

function resolveAttackAction(
  env: RuntimeEnv,
  actor: ActorState,
  target: ActorState,
  action: ActionDef,
  request: UseActionRequest,
): AttackResolution {
  const mods = isFiniteNumber(request.options?.mods) ? request.options?.mods ?? 0 : 0;
  const mode: CheckMode = request.options?.mode === 'advantage' || request.options?.mode === 'disadvantage'
    ? request.options.mode
    : 'normal';
  const spaceContext = spaceFormulaContext(env, actor, target);
  let attackBonus = 0;
  let attackSource = '缺省 0';
  if (action.toHit !== undefined) {
    attackBonus = env.evalNamedFormula(actor.actorId, action.toHit, { space: spaceContext });
    attackSource = `公式 ${action.toHit}`;
  } else if (env.rules.formulas.attack !== undefined) {
    const result = env.tryEvalNamedFormula(actor.actorId, 'attack', { space: spaceContext });
    if (result.ok) {
      attackBonus = result.value;
      attackSource = '公式 attack';
    }
  } else {
    const mod = attrModifier(env, actor, '');
    attackBonus = mod.value;
    attackSource = mod.source;
  }
  let defense = 10;
  let defenseSource = '缺省 10';
  if (env.rules.formulas.defense !== undefined) {
    const result = env.tryEvalNamedFormula(target.actorId, 'defense');
    if (result.ok) {
      defense = result.value;
      defenseSource = '公式 defense';
    }
  } else {
    const derivedDefense = env.derivedOf(target.actorId).defense;
    if (isFiniteNumber(derivedDefense)) {
      defense = derivedDefense;
      defenseSource = 'derived.defense';
    } else {
      const mod = attrModifier(env, target, '');
      defense = 10 + mod.value;
      defenseSource = `10 + ${mod.source}`;
    }
  }
  const critRange = critRangeOf(env, actor);
  const hookRequest: Record<string, unknown> = {
    actorId: actor.actorId,
    actor: summarizeActor(actor),
    targetId: target.actorId,
    target: summarizeActor(target),
    actionId: action.actionId,
    action: toPlainJson({
      actionId: action.actionId,
      name: action.name,
      kind: action.kind,
      toHit: action.toHit ?? null,
      damage: action.damage ?? null,
    }),
    range: action.targeting.range,
    mods,
    mode,
    attackBonus,
    defense,
    critRange,
  };
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'resolveAttack',
    actorId: actor.actorId,
    targetId: target.actorId,
    args: [hookRequest],
    inputSummary: { actorId: actor.actorId, targetId: target.actorId, actionId: action.actionId, mods, mode },
    default: (scope) => {
      const { d20, rolls } = pickD20(scope, mode);
      const critical = d20 >= critRange;
      const fumble = d20 === 1;
      const total = d20 + attackBonus + mods;
      const hit = !fumble && (critical || total >= defense);
      let damage = 0;
      let damageDetail: Record<string, unknown> = { dice: null, diceTotal: 0, bonus: 0, critical, amount: 0 };
      if (hit) {
        const computedDamage = rollDamageAmount(env, actor, action, critical, scope, spaceContext);
        damage = computedDamage.amount;
        damageDetail = computedDamage.detail;
        for (const record of computedDamage.rolls) rolls.push(record);
      }
      return {
        hit,
        crit: critical,
        damage,
        d20,
        total,
        defense,
        attackBonus,
        rolls,
        detail: damageDetail,
        log: `${actor.name} 用「${action.name}」攻击 ${target.name}：d20=${d20}${mode !== 'normal' ? `（${mode === 'advantage' ? '优势' : '劣势'}）` : ''}${attackBonus + mods >= 0 ? '+' : ''}${attackBonus + mods} = ${total} vs 防御 ${defense} → ${hit ? (critical ? '暴击命中' : '命中') : '未命中'}${hit ? `，伤害 ${damage}` : ''}`,
      };
    },
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  const hit = value.hit === true;
  const crit = value.crit === true;
  const damage = isFiniteNumber(value.damage) ? Math.max(0, Math.floor(value.damage)) : 0;
  const detail: Record<string, unknown> = isRecord(value.detail)
    ? value.detail
    : {
        attackBonus,
        defense,
        attackSource,
        defenseSource,
        critRange,
        d20: isFiniteNumber(value.d20) ? value.d20 : null,
        total: isFiniteNumber(value.total) ? value.total : null,
      };
  const rolls = Array.isArray(value.rolls)
    ? (value.rolls as unknown[]).filter(isRecord).map((roll) => ({
        expr: typeof roll.expr === 'string' ? roll.expr : 'd20',
        dice: Array.isArray(roll.dice) ? roll.dice.filter((die): die is number => isFiniteNumber(die)) : [],
        modifier: isFiniteNumber(roll.modifier) ? roll.modifier : 0,
        total: isFiniteNumber(roll.total) ? roll.total : 0,
      }))
    : outcome.rolls.map(diceRecord);
  return { hit, crit, damage, detail, rolls, usedHook: outcome.usedHook };
}

interface RangeCheck {
  distance: number;
  band: RangeBand | null;
  basis: string;
}

function checkActionRange(env: RuntimeEnv, actor: ActorState, action: ActionDef, target: ActorState | undefined, request: UseActionRequest): RangeCheck | null {
  if (env.space.model === 'none') return null;
  if (target === undefined) return null;
  if (request.options?.distance !== undefined) {
    return { distance: request.options.distance, band: env.space.distanceOf(actor.position, target.position).band, basis: 'override' };
  }
  const from = actor.position;
  const to = target.position;
  if (from.cell === undefined && to.cell === undefined && from.zoneId === undefined && to.zoneId === undefined) return null;
  const resolved = env.space.distanceOf(from, to);
  const targetingRange = action.targeting.range;
  if (typeof targetingRange === 'number') {
    if (resolved.basis === 'cells' && resolved.distance > targetingRange) {
      throw new RuleRuntimeError(
        'out_of_range',
        `目标超出射程（距离 ${resolved.distance} 格 > 射程 ${targetingRange} 格）`,
        '先靠近目标（move）再使用该动作',
      );
    }
  } else if (resolved.band !== null) {
    const order: RangeBand[] = ['engaged', 'near', 'far'];
    if (order.indexOf(resolved.band) > order.indexOf(targetingRange)) {
      throw new RuleRuntimeError(
        'out_of_range',
        `目标超出射程（当前 ${resolved.band === 'engaged' ? '接触' : resolved.band === 'near' ? '近距' : '远距'}，射程 ${targetingRange}）`,
        '先靠近目标（move）再使用该动作',
      );
    }
  }
  return { distance: resolved.distance, band: resolved.band, basis: resolved.basis };
}

function validateTargetSide(actor: ActorState, action: ActionDef, target: ActorState | undefined): void {
  const targeting = action.targeting;
  if (target === undefined) {
    if (
      targeting.sides === 'self' ||
      targeting.sides === 'all' ||
      targeting.type === 'all' ||
      targeting.type === 'area' ||
      targeting.type === 'none'
    ) {
      return;
    }
    throw new RuleRuntimeError('invalid_target', `动作「${action.name}」需要指定目标`);
  }
  if (targeting.sides === 'enemy' && target.team === actor.team) {
    throw new RuleRuntimeError('invalid_target', `动作「${action.name}」只能对敌方使用（${target.name} 与 ${actor.name} 同阵营）`);
  }
  if (targeting.sides === 'ally' && target.team !== actor.team) {
    throw new RuleRuntimeError('invalid_target', `动作「${action.name}」只能对友方使用（${target.name} 是敌方）`);
  }
  if (targeting.sides === 'self' && target.actorId !== actor.actorId) {
    throw new RuleRuntimeError('invalid_target', `动作「${action.name}」只能对自己使用`);
  }
}

/** 使用一个规则包动作（`trpg_use_action` 的底座）。 */
export function useAction(env: RuntimeEnv, request: UseActionRequest): ActionResultData {
  const actor = assertCanAct(env, request.actorId);
  env.refreshDerived(actor.actorId);
  ensureTurnResources(env, actor);
  const action = env.rules.actions.find((entry) => entry.actionId === request.actionId);
  if (action === undefined) {
    throw new RuleRuntimeError(
      'unknown_action',
      `规则包没有动作「${request.actionId}」`,
      `可用动作：${env.rules.actions.map((entry) => entry.actionId).join(' / ') || '无'}`,
    );
  }
  const target = request.targetId === undefined ? undefined : env.requireActor(request.targetId);
  if (target !== undefined && target.dead && action.kind === 'attack') {
    throw new RuleRuntimeError('actor_dead', `${target.name} 已经倒下，不能再攻击`);
  }
  validateTargetSide(actor, action, target);
  const rangeCheck = checkActionRange(env, actor, action, target, request);
  const spent = parseActionCost(action);
  const afford = canAffordCost(env, actor, spent);
  if (afford !== null) {
    throw new RuleRuntimeError('insufficient_turn_resource', `${actor.name} ${afford}`, '结束回合后行动经济会回满');
  }
  const events: ActionResultData['events'] = ['action/before'];
  env.emit('action/before', {
    actorId: actor.actorId,
    actionId: action.actionId,
    actionName: action.name,
    kind: action.kind,
    targetId: request.targetId ?? null,
    cost: toPlainJson(spent),
    distance: rangeCheck?.distance ?? null,
  });
  payActionCost(env, actor, spent);
  const liveActor = env.requireActor(actor.actorId);
  const liveTarget = request.targetId === undefined ? undefined : env.requireActor(request.targetId);

  const rolls: DiceRollRecord[] = [];
  const traceLines: string[] = [
    `${liveActor.name} 使用「${action.name}」${liveTarget !== undefined ? ` → ${liveTarget.name}` : ''}（花费 ${JSON.stringify(spent)}）`,
  ];
  const traceData: Record<string, unknown> = {
    actorId: liveActor.actorId,
    actionId: action.actionId,
    targetId: request.targetId ?? null,
    cost: spent,
    range: rangeCheck,
  };

  let check: CheckResultData | undefined;
  let hit: boolean | undefined;
  let crit: boolean | undefined;
  let damageResult: DamageResultData | undefined;
  let usedHook = false;
  const isAttack = action.kind === 'attack' || action.toHit !== undefined || action.damage !== undefined;
  if (isAttack) {
    if (liveTarget === undefined) {
      throw new RuleRuntimeError('invalid_target', `攻击动作「${action.name}」需要指定目标`);
    }
    const resolution = resolveAttackAction(env, liveActor, liveTarget, action, request);
    hit = resolution.hit;
    crit = resolution.crit;
    usedHook = resolution.usedHook;
    rolls.push(...resolution.rolls);
    traceLines.push(
      `命中判定：${resolution.hit ? (resolution.crit ? '暴击命中' : '命中') : '未命中'}`,
    );
    traceData.attack = { hit: resolution.hit, crit: resolution.crit, damage: resolution.damage, ...resolution.detail, usedHook: resolution.usedHook };
    if (resolution.hit && resolution.damage > 0) {
      damageResult = applyDamage(env, {
        targetId: liveTarget.actorId,
        amount: resolution.damage,
        type: 'weapon',
        sourceActorId: liveActor.actorId,
        crit: resolution.crit,
      });
      traceLines.push(`伤害 ${damageResult.amount}：${liveTarget.name} HP ${damageResult.hpBefore} → ${damageResult.hpAfter}${damageResult.dead ? '（倒下）' : ''}`);
      traceData.damage = {
        amount: damageResult.amount,
        absorbedByTempHp: damageResult.absorbedByTempHp,
        hpBefore: damageResult.hpBefore,
        hpAfter: damageResult.hpAfter,
        dead: damageResult.dead,
        consumedEffects: damageResult.consumedEffects,
        usedHook: damageResult.usedHook,
      };
    }
  } else if (action.kind === 'skill' || request.options?.dc !== undefined) {
    check = rollCheck(env, {
      actorId: liveActor.actorId,
      kind: action.kind === 'skill' ? 'skill' : 'custom',
      dc: request.options?.dc ?? 10,
      ...(liveTarget !== undefined ? { targetId: liveTarget.actorId } : {}),
      ...(request.options?.skillId !== undefined ? { skillId: request.options.skillId } : {}),
      ...(request.options?.mods !== undefined ? { mods: request.options.mods } : {}),
      ...(request.options?.mode !== undefined ? { mode: request.options.mode } : {}),
    });
    rolls.push(...check.rolls);
    traceLines.push(...check.trace.lines);
    traceData.check = { total: check.total, dc: check.dc, success: check.success, degree: check.degree, usedHook: check.usedHook };
  }

  const autoEnded = autoEndTurnIfExhausted(env, liveActor);
  if (autoEnded.length > 0) events.push(...autoEnded);
  events.push('action/after');
  env.emit('action/after', {
    actorId: liveActor.actorId,
    actionId: action.actionId,
    actionName: action.name,
    kind: action.kind,
    targetId: request.targetId ?? null,
    hit: hit ?? null,
    crit: crit ?? null,
    damage: damageResult?.amount ?? null,
    targetHp: liveTarget === undefined ? null : hpOf(env.requireActor(liveTarget.actorId), env.rules)?.current ?? null,
    usedHook,
  });
  const result: ActionResultData = {
    actorId: liveActor.actorId,
    actionId: action.actionId,
    actionName: action.name,
    kind: action.kind,
    cost: spent,
    turn: { ...liveActor.turn },
    autoEndedTurn: autoEnded.length > 0,
    rolls,
    events,
    usedHook,
    trace: trace(traceLines, traceData),
    ...(request.targetId !== undefined ? { targetId: request.targetId } : {}),
    ...(hit !== undefined ? { hit } : {}),
    ...(crit !== undefined ? { crit } : {}),
    ...(check !== undefined ? { check } : {}),
    ...(damageResult !== undefined ? { damage: damageResult } : {}),
  };
  return result;
}

// ---------------------------------------------------------------------------
// 移动
// ---------------------------------------------------------------------------

function zoneTransitionOf(env: RuntimeEnv, actor: ActorState, to: PositionState): void {
  runZoneTransition(env, { actor, from: actor.position, to, via: 'move' });
}

/** 移动（边界/障碍/连通性/地形消耗/移动力；`onMove` 钩子可接管）。 */
export function moveActor(env: RuntimeEnv, request: MoveRequest): MoveResultData {
  const actor = assertCanAct(env, request.actorId);
  ensureTurnResources(env, actor);
  const from = toPlainJson(actor.position);
  const to = normalizePosition(request.to);
  const via = request.via ?? 'move';
  if (to.cell === undefined && to.zoneId === undefined) {
    throw new RuleRuntimeError('invalid_request', '移动目标必须是 { zoneId } 或 { cell: {x,y} }');
  }
  // 区域连通性（zone-grid / zone）
  if (from.zoneId !== undefined && to.zoneId !== undefined && from.zoneId !== to.zoneId) {
    const hops = env.space.zoneHops(from.zoneId, to.zoneId);
    if (hops === undefined) {
      throw new RuleRuntimeError(
        'blocked',
        `区域「${from.zoneId}」与「${to.zoneId}」之间没有连通路径`,
        '沿 zones[].connections 声明的路线走',
      );
    }
  }
  let cost = 0;
  let path: CellPoint[] = [];
  let distanceInfo: Record<string, unknown> = {};
  if (to.cell !== undefined) {
    const map = env.space.resolveMapFor(env.state.space, from);
    if (map === undefined) {
      if (env.space.model === 'none') {
        cost = 0;
      } else {
        throw new RuleRuntimeError('unknown_map', '没有可用于格子移动的战斗地图', '先用 startCombat({mapId}) 激活地图');
      }
    } else {
      if (env.state.space.mapId === undefined) env.state.space.mapId = map.mapId;
      const startCell = from.cell ?? { x: to.cell.x, y: to.cell.y };
      const plan = env.space.planPath(map, startCell, to.cell);
      if (!plan.ok) {
        throw new RuleRuntimeError('blocked', plan.reason ?? '无法移动到目标格', '换一条路线或结束回合');
      }
      cost = plan.cost;
      path = plan.path;
      if (to.zoneId === undefined) {
        if (from.zoneId !== undefined) to.zoneId = from.zoneId;
        else if (typeof map.zoneId === 'string') to.zoneId = map.zoneId;
      }
    }
  } else {
    // 只有区域变化：距离/跳数交给 computeDistance 钩子（缺省按 connections BFS）
    const resolved = computeDistanceFor(env, { actorId: actor.actorId, from, to, kind: 'move' });
    cost = resolved.distance > 0 ? Math.ceil(resolved.distance) : 1;
    distanceInfo = { distance: resolved.distance, band: resolved.band, distanceUsedHook: resolved.usedHook };
  }
  const movementId = movementResourceId(env.rules);
  const remainingBefore = movementId === undefined ? null : actor.turn[movementId] ?? 0;
  if (remainingBefore !== null && remainingBefore < cost) {
    throw new RuleRuntimeError(
      'insufficient_turn_resource',
      `${actor.name} 移动力不足（需要 ${cost}，剩余 ${remainingBefore}）`,
      '可以改用更短的路线或结束回合',
    );
  }
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'onMove',
    actorId: actor.actorId,
    args: [{ actorId: actor.actorId, from, to, cost, path, via }],
    inputSummary: { actorId: actor.actorId, from, to, cost },
    default: () => ({ ok: true, ...(remainingBefore !== null ? { remaining: remainingBefore - cost } : {}) }),
    sideEffects: true,
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  if (value.ok === false) {
    const reason = typeof value.reason === 'string' ? value.reason : '移动被规则拒绝';
    throw new RuleRuntimeError('blocked', reason);
  }
  const liveActor = env.requireActor(actor.actorId);
  zoneTransitionOf(env, liveActor, to);
  liveActor.position = to;
  let remaining: number | null = remainingBefore === null ? null : remainingBefore - cost;
  if (remaining !== null) {
    if (isFiniteNumber(value.remaining)) remaining = Math.max(0, Math.floor(value.remaining));
    setMovementRemaining(env, liveActor, remaining);
  }
  env.emit('move', {
    actorId: liveActor.actorId,
    from,
    to,
    cost,
    remaining,
    path,
    via,
    usedHook: outcome.usedHook,
  });
  return {
    actorId: liveActor.actorId,
    from,
    to,
    cost,
    remaining,
    path,
    usedHook: outcome.usedHook,
    trace: trace(
      [`${liveActor.name} 移动 ${describePosition(from)} → ${describePosition(to)}（消耗 ${cost}${remaining !== null ? `，剩余 ${remaining}` : ''}）`],
      { from, to, cost, remaining, path, usedHook: outcome.usedHook, ...distanceInfo },
    ),
  };
}

// ---------------------------------------------------------------------------
// 距离 / 掩体
// ---------------------------------------------------------------------------

export interface DistanceResolution {
  distance: number;
  band: RangeBand | null;
  from: PositionState;
  to: PositionState;
  usedHook: boolean;
  rolls: DiceRollRecord[];
}

function defaultDistance(env: RuntimeEnv, from: PositionState, to: PositionState): { distance: number; band: RangeBand | null; basis: string } {
  const resolved = env.space.distanceOf(from, to);
  return { distance: resolved.distance, band: resolved.band, basis: resolved.basis };
}

/** 距离结算（`computeDistance` 钩子优先）。 */
export function computeDistanceFor(env: RuntimeEnv, request: DistanceRequest): DistanceResultData {
  const actor = request.actorId === undefined ? undefined : env.requireActor(request.actorId);
  const target = request.targetId === undefined ? undefined : env.requireActor(request.targetId);
  const from = request.from ?? actor?.position ?? {};
  const to = request.to ?? target?.position ?? {};
  const base = defaultDistance(env, from, to);
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'computeDistance',
    ...(actor !== undefined ? { actorId: actor.actorId } : {}),
    ...(target !== undefined ? { targetId: target.actorId } : {}),
    args: [{
      kind: request.kind ?? 'targeting',
      actorId: actor?.actorId ?? null,
      targetId: target?.actorId ?? null,
      from,
      to,
      distance: base.distance,
      band: base.band,
      basis: base.basis,
      actor: actor === undefined ? null : summarizeActor(actor),
      target: target === undefined ? null : summarizeActor(target),
    }],
    inputSummary: { actorId: actor?.actorId ?? null, targetId: target?.actorId ?? null, kind: request.kind ?? 'targeting' },
    default: () => ({ distance: base.distance, band: base.band }),
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  const distance = isFiniteNumber(value.distance) ? value.distance : base.distance;
  const bandRaw = typeof value.band === 'string' ? value.band : base.band;
  const band: RangeBand | null = bandRaw === 'engaged' || bandRaw === 'near' || bandRaw === 'far' ? bandRaw : null;
  return {
    distance,
    band,
    from: toPlainJson(from),
    to: toPlainJson(to),
    usedHook: outcome.usedHook,
    trace: trace([`距离 ${distance}${band !== null ? `（${band}）` : ''}`], {
      distance,
      band,
      basis: base.basis,
      from,
      to,
      usedHook: outcome.usedHook,
    }),
  };
}

/** 掩体（`computeCover` 钩子优先；缺省按 space.covers + obstacles 匹配）。 */
export function computeCoverFor(env: RuntimeEnv, request: CoverRequest): CoverResultData {
  const attacker = env.requireActor(request.actorId);
  const target = env.requireActor(request.targetId);
  const map = env.space.resolveMapFor(env.state.space, target.position);
  const cell = target.position.cell;
  const base = cell === undefined ? { defenseBonus: 0, tags: [] } : env.space.coverAt(map, cell);
  const outcome = env.hooks.call<Record<string, unknown>>({
    hook: 'computeCover',
    actorId: attacker.actorId,
    targetId: target.actorId,
    args: [{
      attackerId: attacker.actorId,
      targetId: target.actorId,
      targetZone: request.targetZone ?? target.position.zoneId ?? null,
      defenseBonus: base.defenseBonus,
      tags: base.tags,
      attacker: summarizeActor(attacker),
      target: summarizeActor(target),
    }],
    inputSummary: { attackerId: attacker.actorId, targetId: target.actorId },
    default: () => ({ defenseBonus: base.defenseBonus, tags: base.tags }),
  });
  const value = isRecord(outcome.value) ? outcome.value : {};
  const defenseBonus = isFiniteNumber(value.defenseBonus) ? value.defenseBonus : base.defenseBonus;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : base.tags;
  return {
    defenseBonus,
    tags,
    ...(base.coverId !== undefined ? { coverId: base.coverId } : {}),
    usedHook: outcome.usedHook,
    trace: trace([`掩体加成 +${defenseBonus}${tags.length > 0 ? `（${tags.join('/')}）` : ''}`], { defenseBonus, tags, usedHook: outcome.usedHook }),
  };
}

// ---------------------------------------------------------------------------
// 掉落
// ---------------------------------------------------------------------------

function normalizeLootItems(rules: RulePack, raw: unknown, prefix: string): LootItemInstance[] {
  if (!Array.isArray(raw)) return [];
  const items: LootItemInstance[] = [];
  raw.forEach((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const itemId = isNonEmptyString(record.itemId) ? record.itemId : `loot_${index + 1}`;
    const def = rules.items?.find((item) => item.itemId === itemId);
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string')
      : def?.tags ?? [];
    const stats: Record<string, number> = {};
    if (isRecord(record.stats)) {
      for (const [key, value] of Object.entries(record.stats)) if (isFiniteNumber(value)) stats[key] = value;
    } else if (def?.stats !== undefined) {
      for (const [key, value] of Object.entries(def.stats)) if (isFiniteNumber(value)) stats[key] = value;
    }
    const item: LootItemInstance = {
      instanceId: `${prefix}_${index + 1}`,
      itemId,
      name: isNonEmptyString(record.name) ? record.name : def?.name ?? itemId,
      tags,
      stats,
    };
    if (isNonEmptyString(record.note)) item.note = record.note;
    items.push(item);
  });
  return items;
}

/** 掉落（`generateLoot` 钩子优先；缺省按 tables 掷表）。 */
export function resolveLootFor(env: RuntimeEnv, request: LootRequest = {}): LootResultData {
  const count = request.count === undefined ? 1 : Math.max(1, Math.floor(request.count));
  if (count > 20) throw new RuleRuntimeError('invalid_request', '单次掉落数量不能超过 20');
  const tableId = request.tableId ?? env.rules.tables?.[0]?.tableId;
  const hookRequest: Record<string, unknown> = {
    tableId: tableId ?? null,
    encounterId: request.encounterId ?? null,
    level: request.level ?? null,
    count,
  };
  const outcome = env.hooks.call<unknown[]>({
    hook: 'generateLoot',
    args: [hookRequest],
    inputSummary: { tableId: tableId ?? null, encounterId: request.encounterId ?? null, level: request.level ?? null, count },
    validate: (value) => {
      if (!Array.isArray(value)) return 'generateLoot 必须返回物品实例数组';
      return null;
    },
    default: (scope) => {
      const items: LootItemInstance[] = [];
      if (tableId === undefined) return items;
      for (let index = 0; index < count; index += 1) {
        const table = env.rules.tables?.find((entry) => entry.tableId === tableId);
        if (table === undefined) {
          throw new RuleRuntimeError('unknown_table', `规则包没有掉落表「${tableId}」`);
        }
        const roll = scope.roll(table.roll);
        const hit = table.entries.find((item) => roll.total >= item.min && roll.total <= item.max);
        if (hit?.itemId !== undefined) {
          const def = env.rules.items?.find((item) => item.itemId === hit.itemId);
          items.push({
            instanceId: `loot_${env.state.eventSeq}_${index + 1}`,
            itemId: hit.itemId,
            name: def?.name ?? hit.itemId,
            tags: def?.tags === undefined ? [] : [...def.tags],
            stats: def?.stats === undefined ? {} : { ...def.stats },
          });
        }
      }
      return items;
    },
  });
  const prefix = `loot_${env.state.eventSeq}_${env.state.rollCallSeq}`;
  const items = normalizeLootItems(env.rules, outcome.value, prefix);
  env.emit('loot', {
    tableId: tableId ?? null,
    encounterId: request.encounterId ?? null,
    itemIds: items.map((item) => item.itemId),
    usedHook: outcome.usedHook,
  });
  return {
    items,
    ...(tableId !== undefined ? { tableId } : {}),
    rolls: outcome.rolls.map(diceRecord),
    usedHook: outcome.usedHook,
    trace: trace(
      [`掉落 ${items.length} 件：${items.map((item) => item.name).join('、') || '无'}`],
      { tableId: tableId ?? null, items, rolls: outcome.rolls.map(diceRecord), usedHook: outcome.usedHook },
    ),
  };
}

// ---------------------------------------------------------------------------
// 校验 / 成长
// ---------------------------------------------------------------------------

export interface ValidateSheetOutcome {
  errors: string[];
  usedHook: boolean;
}

/** 跑 `validateSheet` 钩子（缺省 []；schema 校验由调用方叠加）。 */
export function runValidateSheetHook(env: RuntimeEnv, actor: ActorState): ValidateSheetOutcome {
  const sheet = toPlainJson(actor.card);
  const outcome = env.hooks.call<string[]>({
    hook: 'validateSheet',
    actorId: actor.actorId,
    args: [sheet],
    inputSummary: { cardId: actor.card.cardId },
    default: () => [],
    validate: (value) => {
      if (!Array.isArray(value)) return 'validateSheet 必须返回 string[]';
      return null;
    },
  });
  return {
    errors: Array.isArray(outcome.value) ? outcome.value.filter((line): line is string => typeof line === 'string') : [],
    usedHook: outcome.usedHook,
  };
}

function xpOf(actor: ActorState): number {
  const value = actor.card.fields?.xp;
  return isFiniteNumber(value) ? value : 0;
}

function levelForXp(rules: RulePack, xp: number): number {
  const table = rules.progression?.xpTable ?? [];
  let level = 1;
  for (let index = 0; index < table.length; index += 1) {
    const threshold = table[index];
    if (threshold !== undefined && xp >= threshold) level = index + 1;
  }
  const maxLevel = rules.progression?.maxLevel;
  if (isFiniteNumber(maxLevel) && maxLevel > 0) level = Math.min(level, maxLevel);
  return level;
}

/** 升级（`onLevelUp` 钩子优先；缺省按 progression.grants 发点数 + 写 level）。 */
export function levelUpActor(env: RuntimeEnv, request: LevelUpRequest): LevelUpResultData {
  const actor = env.requireActor(request.actorId);
  const fromLevel = cardLevel(actor.card);
  const currentXp = xpOf(actor);
  const xp = currentXp + (isFiniteNumber(request.xpGain) ? Math.floor(request.xpGain) : 0);
  let level = request.targetLevel !== undefined ? Math.floor(request.targetLevel) : levelForXp(env.rules, xp);
  const maxLevel = env.rules.progression?.maxLevel;
  if (isFiniteNumber(maxLevel) && maxLevel > 0) level = Math.min(level, maxLevel);
  if (level < fromLevel) {
    throw new RuleRuntimeError('invalid_request', `目标等级 ${level} 低于当前等级 ${fromLevel}`);
  }
  const gains = (env.rules.progression?.grants ?? []).filter((grant) => grant.atLevel > fromLevel && grant.atLevel <= level);
  const hookRequest: Record<string, unknown> = {
    actorId: actor.actorId,
    actor: summarizeActor(actor),
    level,
    fromLevel,
    xp,
    gains: toPlainJson(gains),
  };
  const patchOutcome = env.hooks.call<Record<string, unknown>>({
    hook: 'onLevelUp',
    actorId: actor.actorId,
    args: [hookRequest],
    inputSummary: { actorId: actor.actorId, fromLevel, level, xp },
    sheetSetAllowed: true,
    default: () => ({ [LEVEL_FIELD_ID]: level }),
  });
  const patch = isRecord(patchOutcome.value) ? patchOutcome.value : {};
  const liveActor = env.requireActor(actor.actorId);
  const appliedPaths: string[] = [];
  for (const [path, value] of Object.entries(patch)) {
    // 允许 `level`、`fields.level` 等卡路径简写
    const target = path === LEVEL_FIELD_ID ? 'level' : path;
    try {
      writeCardPath(env.rules, liveActor.card, target, value);
      appliedPaths.push(target);
    } catch (error) {
      throw new RuleRuntimeError('invalid_sheet', `升级 patch 无法写入「${target}」：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (appliedPaths.length === 0 && level !== fromLevel) {
    writeCardPath(env.rules, liveActor.card, 'level', level);
    appliedPaths.push('level');
  }
  if (isFiniteNumber(request.xpGain) && env.rules.sheet.fields.some((field) => field.id === 'xp')) {
    if (!appliedPaths.includes('fields.xp')) writeCardPath(env.rules, liveActor.card, 'fields.xp', xp);
  }
  env.onCardMutated(liveActor.actorId);
  const validation = runValidateSheetHook(env, liveActor);
  env.refreshDerived(liveActor.actorId);
  env.emit('level/up', {
    actorId: liveActor.actorId,
    fromLevel,
    level,
    xp,
    gains: toPlainJson(gains),
    patch: toPlainJson(patch),
    usedHook: patchOutcome.usedHook,
  });
  return {
    actorId: liveActor.actorId,
    fromLevel,
    level,
    xp,
    gains,
    patch: toPlainJson(patch),
    validation: validation.errors,
    usedHook: patchOutcome.usedHook,
    trace: trace(
      [`${liveActor.name} 升到 ${level} 级（${fromLevel} → ${level}），获得 ${gains.length} 项成长`],
      { fromLevel, level, xp, gains, patch, validation: validation.errors },
    ),
  };
}

// ---------------------------------------------------------------------------
// 对外类型汇总（index 复用）
// ---------------------------------------------------------------------------

export type { ActionCostSpent, ActorState, CombatView, TimeResultData, AdvanceTimeRequest };
