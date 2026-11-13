import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abilityModifier,
  createRng,
  deriveRollSeed,
  parseDiceExpression,
  rollCheck,
  rollDice,
} from '../src/index.ts';

test('parse: d20 / 1d8 / 2d6+3 / 1d8 - 1', () => {
  assert.deepEqual(parseDiceExpression('d20'), { count: 1, sides: 20, modifier: 0, source: 'd20' });
  assert.deepEqual(parseDiceExpression('1d8'), { count: 1, sides: 8, modifier: 0, source: '1d8' });
  assert.deepEqual(parseDiceExpression('2d6+3'), { count: 2, sides: 6, modifier: 3, source: '2d6+3' });
  assert.deepEqual(parseDiceExpression('1d8 - 1'), { count: 1, sides: 8, modifier: -1, source: '1d8 - 1' });
});

test('parse: rejects malformed expressions', () => {
  assert.throws(() => parseDiceExpression('20'), SyntaxError);
  assert.throws(() => parseDiceExpression('d'), SyntaxError);
  assert.throws(() => parseDiceExpression('1d6+2d8'), SyntaxError);
  assert.throws(() => parseDiceExpression('101d6'), RangeError);
  assert.throws(() => parseDiceExpression('1d1001'), RangeError);
});

test('roll: dice count, bounds and modifier', () => {
  const rng = createRng(42);
  const result = rollDice('3d6+2', rng);
  assert.equal(result.dice.length, 3);
  for (const die of result.dice) assert.ok(die >= 1 && die <= 6, `die out of range: ${die}`);
  assert.equal(result.total, result.dice.reduce((a, b) => a + b, 0) + 2);
  assert.equal(result.modifier, 2);
});

test('rng: same seed replays the same sequence', () => {
  const a = createRng(20261113);
  const b = createRng(20261113);
  const seqA = Array.from({ length: 20 }, () => a.nextInt(20) + 1);
  const seqB = Array.from({ length: 20 }, () => b.nextInt(20) + 1);
  assert.deepEqual(seqA, seqB);
});

test('deriveRollSeed: stable per (roomSeed, rollIndex) and distinct across indexes', () => {
  assert.equal(deriveRollSeed(7, 0), deriveRollSeed(7, 0));
  const seeds = new Set([0, 1, 2, 3, 4].map((i) => deriveRollSeed(7, i)));
  assert.equal(seeds.size, 5);
});

test('check: normal mode single d20, success boundary is total >= dc', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const result = rollCheck({ modifier: 5, dc: 15 }, createRng(seed));
    assert.equal(result.rolls.length, 1);
    assert.equal(result.total, result.d20 + 5);
    assert.equal(result.success, result.total >= 15);
  }
});

test('check: advantage takes the higher of two d20, disadvantage the lower', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const adv = rollCheck({ modifier: 0, dc: 10, mode: 'advantage' }, createRng(seed));
    const dis = rollCheck({ modifier: 0, dc: 10, mode: 'disadvantage' }, createRng(seed));
    assert.equal(adv.rolls.length, 2);
    assert.equal(adv.d20, Math.max(...adv.rolls));
    assert.equal(dis.d20, Math.min(...dis.rolls));
    assert.ok(adv.total >= dis.total);
  }
});

test('abilityModifier: floor((score-10)/2)', () => {
  assert.equal(abilityModifier(8), -1);
  assert.equal(abilityModifier(10), 0);
  assert.equal(abilityModifier(11), 0);
  assert.equal(abilityModifier(15), 2);
  assert.equal(abilityModifier(20), 5);
  assert.throws(() => abilityModifier(10.5), RangeError);
});
