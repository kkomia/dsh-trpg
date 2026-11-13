/**
 * 战斗状态机：先攻、行动经济、攻击结算、伤害/治疗、状态、回合推进。
 *
 * 这是「行动状态异常」的五道锁之一（锁 4）：只有 `activeCombatant` 能行动，
 * 非当前行动者的调用会被显式拒绝，而不是靠 AI 记住谁在行动。
 */
import { abilityMod, attackBonus } from './checks.ts';
import { rollCheck, rollDice } from './dice.ts';
import type {
  AttackProfile,
  Combatant,
  Condition,
  RangeBand,
  ActiveEffect,
} from './types.ts';

const BAND_ORDER: Record<RangeBand, number> = { engaged: 0, near: 1, far: 2 };

export type CombatLogKind =
  | 'initiative'
  | 'turn'
  | 'attack'
  | 'damage'
  | 'heal'
  | 'condition'
  | 'move'
  | 'down'
  | 'death-save';

export interface CombatLogEntry {
  seq: number;
  kind: CombatLogKind;
  text: string;
  data?: Record<string, unknown>;
}

export interface TurnEconomy {
  action: boolean;
  bonus: boolean;
  reaction: boolean;
  /** 本回合已移动的档位数（0 或 1）。 */
  movement: number;
}

export interface CombatState {
  participants: Combatant[];
  /** 先攻顺序（combatant id）。倒地的角色保留在顺序里但会被跳过。 */
  order: string[];
  activeIndex: number;
  round: number;
  range: RangeBand;
  economy: TurnEconomy;
  log: CombatLogEntry[];
  seed: number;
  rollIndex: number;
}

export type RngLike = { nextInt(maxExclusive: number): number };

function resetEconomy(): TurnEconomy {
  return { action: false, bonus: false, reaction: false, movement: 0 };
}

export function logEntry(state: CombatState, kind: CombatLogKind, text: string, data?: Record<string, unknown>): CombatLogEntry {
  const entry: CombatLogEntry = { seq: state.log.length + 1, kind, text };
  if (data) entry.data = data;
  state.log.push(entry);
  return entry;
}

export function startCombat(
  participants: Combatant[],
  rng: RngLike,
  options: { seed?: number; range?: RangeBand } = {},
): CombatState {
  if (participants.length < 2) throw new RangeError('combat needs at least two participants');
  const state: CombatState = {
    participants,
    order: [],
    activeIndex: 0,
    round: 1,
    range: options.range ?? 'near',
    economy: resetEconomy(),
    log: [],
    seed: options.seed ?? 0,
    rollIndex: 0,
  };

  const initiatives = participants.map((participant) => {
    const roll = rng.nextInt(20) + 1;
    const total = roll + participant.initiativeBonus;
    return { id: participant.id, total, dex: participant.abilities.dex, roll };
  });
  initiatives.sort((a, b) => b.total - a.total || b.dex - a.dex || a.id.localeCompare(b.id));
  state.order = initiatives.map((entry) => entry.id);
  for (const entry of initiatives) {
    logEntry(state, 'initiative', `${who(state, entry.id)} 先攻 ${entry.roll}+${entry.total - entry.roll}=${entry.total}`, entry);
  }
  logEntry(state, 'turn', `第 1 轮开始，${who(state, state.order[0] as string)} 先行动`);
  return state;
}

export function who(state: CombatState, id: string): string {
  const combatant = state.participants.find((entry) => entry.id === id);
  return combatant ? combatant.name : id;
}

export function getCombatant(state: CombatState, id: string): Combatant {
  const combatant = state.participants.find((entry) => entry.id === id);
  if (!combatant) throw new Error(`unknown combatant: ${id}`);
  return combatant;
}

export function activeCombatant(state: CombatState): Combatant {
  const id = state.order[state.activeIndex];
  if (!id) throw new Error('combat has no active combatant');
  return getCombatant(state, id);
}

export function isAlive(combatant: Combatant): boolean {
  return !combatant.dead && combatant.hp.current > 0;
}

export function canAct(combatant: Combatant): boolean {
  return isAlive(combatant) && !combatant.downed && !combatant.conditions.includes('incapacitated');
}

function assertActing(state: CombatState, actorId: string): Combatant {
  const actor = getCombatant(state, actorId);
  const active = activeCombatant(state);
  if (active.id !== actorId) {
    throw new Error(`当前轮到 ${active.name} 行动，${actor.name} 不能抢先结算`);
  }
  if (!canAct(actor)) throw new Error(`${actor.name} 现在无法行动（失能/倒地）`);
  return actor;
}

export function effectiveAc(combatant: Combatant): number {
  return combatant.ac + (combatant.conditions.includes('hasted') ? 2 : 0);
}

/**
 * 条件对攻击的影响：返回攻击者的优势/劣势来源。
 * 只做 v1 八种状态的简化判定，规则细节写在 DESIGN.md。
 */
export function attackModeFor(attacker: Combatant, target: Combatant, profile: AttackProfile): {
  mode: 'normal' | 'advantage' | 'disadvantage';
  reasons: string[];
} {
  let advantage = 0;
  let disadvantage = 0;
  const reasons: string[] = [];

  if (attacker.conditions.includes('poisoned')) (disadvantage += 1), reasons.push('攻击者中毒');
  if (attacker.conditions.includes('blinded')) (disadvantage += 1), reasons.push('攻击者目盲');
  if (attacker.conditions.includes('frightened')) (disadvantage += 1), reasons.push('攻击者恐惧');
  if (attacker.conditions.includes('restrained')) (disadvantage += 1), reasons.push('攻击者被束缚');
  if (target.conditions.includes('invisible')) (disadvantage += 1), reasons.push('目标隐身');
  if (target.conditions.includes('prone')) {
    if (BAND_ORDER[profile.range] === BAND_ORDER.engaged) {
      advantage += 1;
      reasons.push('目标倒地（近战优势）');
    } else {
      disadvantage += 1;
      reasons.push('目标倒地（远程劣势）');
    }
  }
  if (target.conditions.includes('restrained')) (advantage += 1), reasons.push('目标被束缚');
  if (target.conditions.includes('blinded')) (advantage += 1), reasons.push('目标目盲');

  const mode = advantage > 0 && disadvantage === 0
    ? 'advantage'
    : disadvantage > 0 && advantage === 0
      ? 'disadvantage'
      : 'normal';
  return { mode, reasons };
}

export function pickAttackProfile(combatant: Combatant, name?: string): AttackProfile {
  const profile = name
    ? combatant.attacks.find((entry) => entry.name === name)
    : combatant.attacks[0];
  if (!profile) throw new Error(`${combatant.name} 没有可用攻击${name ? `：${name}` : ''}`);
  return profile;
}

export interface AttackInput {
  attackerId: string;
  targetId: string;
  attackName?: string;
  /** 手动指定优势/劣势（GM 裁定场景）；不传则按条件推导。 */
  mode?: 'normal' | 'advantage' | 'disadvantage';
}

export interface AttackResult {
  ok: true;
  attackerId: string;
  targetId: string;
  attackName: string;
  mode: 'normal' | 'advantage' | 'disadvantage';
  reasons: string[];
  d20: number;
  attackRolls: number[];
  attackBonus: number;
  total: number;
  targetAc: number;
  hit: boolean;
  critical: boolean;
  fumble: boolean;
  damage: number;
  targetHp: number;
  downed: boolean;
  log: CombatLogEntry[];
}

export function attack(state: CombatState, input: AttackInput, rng: RngLike): AttackResult {
  const attacker = assertActing(state, input.attackerId);
  if (state.economy.action) throw new Error(`${attacker.name} 本回合已经用过动作`);
  if (state.range === 'far' && BAND_ORDER[(pickAttackProfile(attacker, input.attackName)).range] < 2) {
    throw new Error('目标在远距，近战武器够不到');
  }
  const target = getCombatant(state, input.targetId);
  if (!isAlive(target)) throw new Error(`${target.name} 已经倒下`);

  const profile = pickAttackProfile(attacker, input.attackName);
  const derived = attackModeFor(attacker, target, profile);
  const mode = input.mode ?? derived.mode;
  const bonus = attackBonus(attacker.abilities, attacker.proficiency, profile.ability, profile.proficient);
  const roll = rollCheck({ modifier: bonus, dc: effectiveAc(target), mode }, rng);
  const fumble = roll.d20 === 1;
  const hit = !fumble && (roll.d20 === 20 || roll.total >= effectiveAc(target));
  const critical = roll.d20 === 20;

  let damage = 0;
  if (hit) {
    const base = rollDice(profile.damage, rng);
    const times = critical ? 2 : 1;
    const diceTotal = base.dice.reduce((sum, die) => sum + die, 0) * times;
    damage = diceTotal + base.modifier * times + abilityMod(attacker.abilities[profile.ability]);
    damage = Math.max(0, damage);
    applyDamage(target, damage, `${attacker.name} 的${profile.name}`);
  }

  state.economy.action = true;
  const lines = logEntry(
    state,
    'attack',
    `${attacker.name} 用${profile.name}攻击${target.name}：d20=${roll.d20}${mode !== 'normal' ? `（${mode === 'advantage' ? '优势' : '劣势'}）` : ''} +${bonus} = ${roll.total} vs AC ${effectiveAc(target)} → ${hit ? (critical ? '暴击' : '命中') : '未命中'}${damage > 0 ? `，伤害 ${damage}` : ''}`,
    { attackerId: attacker.id, targetId: target.id, attackName: profile.name, total: roll.total, dc: effectiveAc(target), hit, critical, damage },
  );

  return {
    ok: true,
    attackerId: attacker.id,
    targetId: target.id,
    attackName: profile.name,
    mode,
    reasons: derived.reasons,
    d20: roll.d20,
    attackRolls: roll.rolls,
    attackBonus: bonus,
    total: roll.total,
    targetAc: effectiveAc(target),
    hit,
    critical,
    fumble,
    damage,
    targetHp: target.hp.current,
    downed: target.downed,
    log: [lines],
  };
}

export function applyDamage(target: Combatant, amount: number, source?: string): number {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`damage must be >= 0, got ${amount}`);
  let remaining = Math.floor(amount);
  if (target.hp.temp > 0) {
    const absorbed = Math.min(target.hp.temp, remaining);
    target.hp.temp -= absorbed;
    remaining -= absorbed;
  }
  target.hp.current = Math.max(0, target.hp.current - remaining);
  if (target.hp.current === 0 && !target.downed) {
    target.downed = true;
    addCondition(target, 'incapacitated', -1);
    addCondition(target, 'prone', -1);
    if (target.kind === 'monster') {
      target.dead = true;
    }
  }
  void source;
  return target.hp.current;
}

export function heal(target: Combatant, amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`heal must be >= 0, got ${amount}`);
  const before = target.hp.current;
  target.hp.current = Math.min(target.hp.max, target.hp.current + Math.floor(amount));
  if (target.hp.current > 0 && target.downed) {
    target.downed = false;
    target.dead = false;
    removeCondition(target, 'incapacitated');
    removeCondition(target, 'prone');
  }
  return target.hp.current - before;
}

export function addCondition(target: Combatant, condition: Condition, rounds = -1): void {
  if (!target.conditions.includes(condition)) target.conditions.push(condition);
  const existing = target.effects.find((effect) => effect.condition === condition);
  if (existing) {
    existing.roundsLeft = rounds;
    return;
  }
  const effect: ActiveEffect = { condition, roundsLeft: rounds };
  target.effects.push(effect);
}

export function removeCondition(target: Combatant, condition: Condition): void {
  target.conditions = target.conditions.filter((entry) => entry !== condition);
  target.effects = target.effects.filter((entry) => entry.condition !== condition);
}

export function move(state: CombatState, actorId: string, band: RangeBand): void {
  const actor = assertActing(state, actorId);
  if (state.economy.movement >= 1) throw new Error(`${actor.name} 本回合已经移动过`);
  state.range = band;
  state.economy.movement += 1;
  logEntry(state, 'move', `${actor.name} 移动到${band === 'engaged' ? '接触' : band === 'near' ? '近距' : '远距'}`);
}

/** 推进到下一个可行动者；跳过已倒下的；跨轮时结算持续状态并开始新一轮。 */
export function advanceTurn(state: CombatState): Combatant {
  const total = state.order.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (state.activeIndex + step) % total;
    const candidate = getCombatant(state, state.order[index] as string);
    if (!isAlive(candidate) || candidate.downed) continue;
    const wrapped = index <= state.activeIndex;
    state.activeIndex = index;
    state.economy = resetEconomy();
    if (wrapped) {
      state.round += 1;
      tickEffects(state);
      logEntry(state, 'turn', `第 ${state.round} 轮开始，轮到 ${candidate.name}`);
    } else {
      logEntry(state, 'turn', `轮到 ${candidate.name} 行动`);
    }
    return candidate;
  }
  throw new Error('没有还能行动的参与者');
}

function tickEffects(state: CombatState): void {
  for (const participant of state.participants) {
    if (!participant.effects.length) continue;
    participant.effects = participant.effects.filter((effect) => {
      if (effect.roundsLeft < 0) return true;
      effect.roundsLeft -= 1;
      if (effect.roundsLeft > 0) return true;
      participant.conditions = participant.conditions.filter((entry) => entry !== effect.condition);
      return false;
    });
  }
}

/** 死亡豁免：10+ 成功，3 成功稳定，3 失败死亡。 */
export function rollDeathSave(target: Combatant, rng: RngLike): { roll: number; successes: number; failures: number; dead: boolean; stable: boolean } {
  if (!target.downed || target.kind !== 'pc') throw new Error('只有倒地的玩家角色需要死亡豁免');
  const saves = target.deathSaves ?? { successes: 0, failures: 0 };
  target.deathSaves = saves;
  const roll = rng.nextInt(20) + 1;
  if (roll === 20) {
    target.hp.current = 1;
    target.downed = false;
    removeCondition(target, 'incapacitated');
    removeCondition(target, 'prone');
  } else if (roll >= 10) {
    saves.successes += 1;
  } else {
    saves.failures += 1;
  }
  if (saves.failures >= 3) target.dead = true;
  return {
    roll,
    successes: saves.successes,
    failures: saves.failures,
    dead: target.dead,
    stable: saves.successes >= 3,
  };
}
