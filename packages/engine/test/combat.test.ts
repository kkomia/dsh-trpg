import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeCombatant,
  addCondition,
  advanceTurn,
  applyDamage,
  attack,
  attackModeFor,
  effectiveAc,
  getCombatant,
  heal,
  rollDeathSave,
  startCombat,
} from '../src/index.ts';
import { makeMonster, makePc, stubRng } from './helpers.ts';

test('startCombat: rolls initiative and orders highest first', () => {
  const pc = makePc('pc1', { initiativeBonus: 5 });
  const mob = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([pc, mob], stubRng([10, 5]));
  assert.deepEqual(state.order, ['pc1', 'mob1']);
  assert.equal(activeCombatant(state).id, 'pc1');
  assert.equal(state.round, 1);
  assert.ok(state.log.some((entry) => entry.kind === 'initiative'));
});

test('attack: only the active combatant may resolve an attack', () => {
  const pc = makePc('pc1', { initiativeBonus: 10 });
  const mob = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([pc, mob], stubRng([15, 0]));
  assert.equal(activeCombatant(state).id, 'pc1');
  assert.throws(() => attack(state, { attackerId: 'mob1', targetId: 'pc1' }, stubRng([10])), /轮到/);
});

test('attack: natural 20 is a critical and doubles damage dice', () => {
  const pc = makePc('pc1', { initiativeBonus: 10 });
  const mob = makeMonster('mob1', { initiativeBonus: 0, ac: 13 });
  const state = startCombat([pc, mob], stubRng([15, 0]));
  const result = attack(state, { attackerId: 'pc1', targetId: 'mob1' }, stubRng([19, 0]));
  assert.equal(result.critical, true);
  assert.equal(result.hit, true);
  assert.equal(result.damage, 5);
  assert.equal(result.targetHp, 12 - 5);
  assert.equal(state.economy.action, true);
});

test('attack: using the action twice in one turn is rejected', () => {
  const pc = makePc('pc1', { initiativeBonus: 10 });
  const mob = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([pc, mob], stubRng([15, 0]));
  attack(state, { attackerId: 'pc1', targetId: 'mob1' }, stubRng([10]));
  assert.throws(() => attack(state, { attackerId: 'pc1', targetId: 'mob1' }, stubRng([10])), /动作/);
});

test('damage: temp HP absorbs first, then 0 HP downs a PC and kills a monster', () => {
  const pc = makePc('pc1', { hp: { max: 20, current: 20, temp: 5 } });
  applyDamage(pc, 3);
  assert.equal(pc.hp.temp, 2);
  assert.equal(pc.hp.current, 20);
  applyDamage(pc, 50);
  assert.equal(pc.hp.current, 0);
  assert.equal(pc.downed, true);
  assert.ok(pc.conditions.includes('incapacitated'));

  const mob = makeMonster('mob1');
  applyDamage(mob, 99);
  assert.equal(mob.dead, true);
});

test('heal: revives a downed player character and clears incapacitated/prone', () => {
  const pc = makePc('pc1');
  applyDamage(pc, 99);
  assert.equal(pc.downed, true);
  const healed = heal(pc, 7);
  assert.equal(healed, 7);
  assert.equal(pc.downed, false);
  assert.ok(!pc.conditions.includes('incapacitated'));
  assert.ok(!pc.conditions.includes('prone'));
});

test('advanceTurn: wraps to the next round and ticks condition durations', () => {
  const a = makePc('pc1', { initiativeBonus: 10 });
  const b = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([a, b], stubRng([15, 0]));
  addCondition(a, 'poisoned', 1);
  advanceTurn(state);
  assert.equal(activeCombatant(state).id, 'mob1');
  assert.equal(state.round, 1);
  advanceTurn(state);
  assert.equal(state.round, 2);
  assert.equal(activeCombatant(state).id, 'pc1');
  assert.ok(!a.conditions.includes('poisoned'), '1 回合的中毒应在跨轮后解除');
});

test('attackModeFor: poisoned attacker has disadvantage; one advantage and one disadvantage cancel out', () => {
  const attacker = makePc('pc1');
  const target = makeMonster('mob1');
  const melee = { name: '横刀', ability: 'str' as const, proficient: true, damage: '1d8', range: 'engaged' as const };
  assert.equal(attackModeFor(attacker, target, melee).mode, 'normal');
  addCondition(attacker, 'poisoned');
  assert.equal(attackModeFor(attacker, target, melee).mode, 'disadvantage');
  addCondition(target, 'prone');
  assert.equal(attackModeFor(attacker, target, melee).mode, 'normal', '优势与劣势互相抵消');
});

test('effectiveAc: hasted adds 2', () => {
  const pc = makePc('pc1');
  assert.equal(effectiveAc(pc), 16);
  addCondition(pc, 'hasted');
  assert.equal(effectiveAc(pc), 18);
});

test('rollDeathSave: three failures kill the character', () => {
  const pc = makePc('pc1');
  applyDamage(pc, 99);
  const rng = stubRng([0, 0, 0]);
  assert.equal(rollDeathSave(pc, rng).dead, false);
  assert.equal(rollDeathSave(pc, rng).dead, false);
  const third = rollDeathSave(pc, rng);
  assert.equal(third.failures, 3);
  assert.equal(third.dead, true);
});

test('getCombatant: unknown id throws', () => {
  const state = startCombat([makePc('pc1'), makeMonster('mob1')], stubRng([10, 5]));
  assert.throws(() => getCombatant(state, 'nobody'), /unknown combatant/);
});
