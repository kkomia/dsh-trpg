import { test } from 'node:test';
import assert from 'node:assert/strict';
import { castSpell, startCombat, applyDamage, getCombatant } from '../src/index.ts';
import type { SpellDef } from '../src/index.ts';
import { makeMonster, makePc, stubRng } from './helpers.ts';

const healWord: SpellDef = {
  id: 'heal_word',
  name: '治愈真言',
  level: 1,
  school: '医术',
  castingTime: 'bonus',
  range: 'near',
  effect: { kind: 'heal', dice: '1d4', addCastingMod: true },
  desc: '恢复少量生命',
};

const fireBolt: SpellDef = {
  id: 'fire_bolt',
  name: '引火术',
  level: 0,
  school: '咒术',
  castingTime: 'action',
  range: 'far',
  effect: { kind: 'damage', dice: '1d10', saveAbility: 'dex', halfOnSave: false },
  desc: '远程火焰伤害',
};

const thunder: SpellDef = {
  id: 'thunder',
  name: '震地术',
  level: 1,
  school: '道术',
  castingTime: 'action',
  range: 'engaged',
  effect: { kind: 'damage', dice: '2d6', saveAbility: 'con', halfOnSave: true },
  desc: '接触范围震击',
};

function makeCaster(id = 'pc1', known: string[] = ['heal_word', 'fire_bolt', 'thunder']) {
  return makePc(id, {
    initiativeBonus: 10,
    spellcasting: {
      ability: 'cha',
      slots: { max: { 1: 2 }, current: { 1: 2 } },
      known,
    },
  });
}

test('castSpell: healing spends a slot and uses the bonus action', () => {
  const caster = makeCaster();
  const ally = makePc('pc2');
  const state = startCombat([caster, makeMonster('mob1', { initiativeBonus: 0 })], stubRng([15, 0]));
  applyDamage(ally, 8);
  state.participants.push(ally);
  const result = castSpell(state, { casterId: 'pc1', spell: healWord, targetIds: ['pc2'] }, stubRng([0]));
  assert.equal(result.results[0]?.healed, 1, '1d4=1 + 魅力调整 0');
  assert.equal(caster.spellcasting?.slots.current[1], 1);
  assert.equal(state.economy.bonus, true);
  assert.equal(state.economy.action, false);
});

test('castSpell: a second bonus-action spell in the same turn is rejected', () => {
  const caster = makeCaster();
  const ally = makePc('pc2');
  const state = startCombat([caster, makeMonster('mob1', { initiativeBonus: 0 })], stubRng([15, 0]));
  state.participants.push(ally);
  castSpell(state, { casterId: 'pc1', spell: healWord, targetIds: ['pc2'] }, stubRng([0]));
  assert.throws(
    () => castSpell(state, { casterId: 'pc1', spell: healWord, targetIds: ['pc2'] }, stubRng([0])),
    /附赠动作/,
  );
});

test('castSpell: cantrip consumes no slot; failed save takes full damage', () => {
  const caster = makeCaster();
  const target = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([caster, target], stubRng([15, 0]));
  // 目标豁免 d20=0→1（失败），伤害 1d10=1
  const result = castSpell(state, { casterId: 'pc1', spell: fireBolt, targetIds: ['mob1'] }, stubRng([0, 0]));
  assert.equal(result.results[0]?.saved, false);
  assert.equal(result.results[0]?.damage, 1);
  assert.equal(caster.spellcasting?.slots.current[1], 2, '法术戏法不消耗法术位');
});

test('castSpell: successful save halves damage when the spell allows it', () => {
  const caster = makeCaster();
  const target = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([caster, target], stubRng([15, 0]), { range: 'engaged' });
  // 豁免 d20=19→20 成功；2d6 伤害骰各 1 → 2，减半 → 1
  const result = castSpell(state, { casterId: 'pc1', spell: thunder, targetIds: ['mob1'] }, stubRng([19, 0, 0]));
  assert.equal(result.results[0]?.saved, true);
  assert.equal(result.results[0]?.damage, 1);
  assert.equal(getCombatant(state, 'mob1').hp.current, 11);
});

test('castSpell: range check rejects a touch spell at far range', () => {
  const caster = makeCaster();
  const target = makeMonster('mob1', { initiativeBonus: 0 });
  const state = startCombat([caster, target], stubRng([15, 0]), { range: 'far' });
  assert.throws(
    () => castSpell(state, { casterId: 'pc1', spell: thunder, targetIds: ['mob1'] }, stubRng([0])),
    /射程/,
  );
});

test('castSpell: unknown spell and missing slot are rejected', () => {
  const caster = makeCaster('pc1', ['fire_bolt']);
  const state = startCombat([caster, makeMonster('mob1', { initiativeBonus: 0 })], stubRng([15, 0]));
  assert.throws(
    () => castSpell(state, { casterId: 'pc1', spell: healWord, targetIds: ['mob1'] }, stubRng([0])),
    /没有掌握/,
  );
});

test('castSpell: non-active caster is rejected', () => {
  const caster = makeCaster();
  const target = makeMonster('mob1', { initiativeBonus: 20 });
  const state = startCombat([caster, target], stubRng([0, 19]));
  assert.equal(state.order[0], 'mob1');
  assert.throws(
    () => castSpell(state, { casterId: 'pc1', spell: fireBolt, targetIds: ['mob1'] }, stubRng([0])),
    /轮到/,
  );
});
