/** M9.2：种子化随机与骰子表达式。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSeededRng,
  deriveRngBytes,
  hashToUnitInterval,
  normalizeRoomSeed,
  parseDiceExpression,
  rollDice,
  isDiceExpression,
  DICE_LIMITS,
} from '../src/index.ts';
import { addActor, createRuntime, makeCard, expectOk } from './runtime-helpers.ts';

const BASE_SEED = { roomSeed: 123456, eventSeq: 7, hook: 'resolveCheck', callIndex: 3 };

// ---------------------------------------------------------------------------
// rng：确定性
// ---------------------------------------------------------------------------

test('rng：同样的种子分量得到同样的序列', () => {
  const a = createSeededRng(BASE_SEED);
  const b = createSeededRng(BASE_SEED);
  const sequenceA = Array.from({ length: 8 }, () => a.nextUint32());
  const sequenceB = Array.from({ length: 8 }, () => b.nextUint32());
  assert.deepEqual(sequenceA, sequenceB);
});

test('rng：不同房间种子得到不同序列', () => {
  const a = createSeededRng({ ...BASE_SEED, roomSeed: 1 });
  const b = createSeededRng({ ...BASE_SEED, roomSeed: 2 });
  assert.notDeepEqual(
    Array.from({ length: 4 }, () => a.nextUint32()),
    Array.from({ length: 4 }, () => b.nextUint32()),
  );
});

test('rng：eventSeq 不同则序列不同', () => {
  const a = createSeededRng({ ...BASE_SEED, eventSeq: 1 });
  const b = createSeededRng({ ...BASE_SEED, eventSeq: 2 });
  assert.notEqual(a.nextUint32(), b.nextUint32());
});

test('rng：钩子名不同则序列不同', () => {
  const a = createSeededRng({ ...BASE_SEED, hook: 'resolveCheck' });
  const b = createSeededRng({ ...BASE_SEED, hook: 'resolveAttack' });
  assert.notEqual(a.nextUint32(), b.nextUint32());
});

test('rng：调用序号不同则序列不同', () => {
  const a = createSeededRng({ ...BASE_SEED, callIndex: 1 });
  const b = createSeededRng({ ...BASE_SEED, callIndex: 2 });
  assert.notEqual(a.nextUint32(), b.nextUint32());
});

test('rng：nextFloat 落在 [0,1) 且 counter 递增', () => {
  const rng = createSeededRng(BASE_SEED);
  const values = Array.from({ length: 50 }, () => rng.nextFloat());
  for (const value of values) {
    assert.ok(value >= 0 && value < 1, `越界：${value}`);
  }
  assert.equal(rng.counter(), 50);
  const state = rng.state();
  assert.equal(state.counter, 50);
  assert.equal(state.roomSeed, BASE_SEED.roomSeed);
  assert.equal(state.eventSeq, BASE_SEED.eventSeq);
  assert.equal(state.hook, BASE_SEED.hook);
  assert.equal(state.callIndex, BASE_SEED.callIndex);
});

test('rng：nextInt 落在 [0,maxExclusive) 且覆盖充分', () => {
  const rng = createSeededRng({ ...BASE_SEED, callIndex: 99 });
  const seen = new Set<number>();
  for (let index = 0; index < 500; index += 1) {
    const value = rng.nextInt(6);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 6);
    seen.add(value);
  }
  assert.equal(seen.size, 6);
  assert.throws(() => rng.nextInt(0), RangeError);
});

test('rng：从快照 counter 续算与连续取数一致', () => {
  const full = createSeededRng(BASE_SEED);
  const first = Array.from({ length: 5 }, () => full.nextUint32());
  const resumed = createSeededRng(BASE_SEED, 5);
  const rest = Array.from({ length: 5 }, () => resumed.nextUint32());
  const expected = Array.from({ length: 5 }, () => full.nextUint32());
  assert.deepEqual(rest, expected);
  void first;
});

test('rng：sha256 → [0,1) 归一化与 deriveRngBytes 同源', () => {
  const unit = hashToUnitInterval(BASE_SEED, 0);
  const bytes = deriveRngBytes(BASE_SEED, 0);
  assert.equal(bytes.length, 32);
  assert.equal(unit, bytes.readUIntBE(0, 6) / 281474976710656);
  assert.ok(unit >= 0 && unit < 1);
  assert.notEqual(hashToUnitInterval(BASE_SEED, 0), hashToUnitInterval(BASE_SEED, 1));
});

test('rng：房间种子归一化为 uint32，非法值抛错', () => {
  assert.equal(normalizeRoomSeed(42), 42);
  assert.equal(normalizeRoomSeed(-1), 4294967295);
  assert.equal(normalizeRoomSeed(12.9), 12);
  assert.throws(() => normalizeRoomSeed(Number.NaN), RangeError);
  assert.throws(() => normalizeRoomSeed('42'), RangeError);
});

test('rng：运行时结算不依赖 Math.random', () => {
  const original = Math.random;
  Math.random = () => {
    throw new Error('Math.random 被调用了（确定性被破坏）');
  };
  try {
    const runtime = createRuntime();
    addActor(runtime, makeCard({ cardId: 'card_a', str: 14 }));
    const result = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
    assert.ok(result.total > 0);
  } finally {
    Math.random = original;
  }
});

// ---------------------------------------------------------------------------
// 骰子表达式解析
// ---------------------------------------------------------------------------

test('骰子：d20 解析（省略个数按 1）', () => {
  const parsed = parseDiceExpression('d20');
  assert.deepEqual(parsed.terms, [{ count: 1, sides: 20 }]);
  assert.equal(parsed.modifier, 0);
  assert.equal(parsed.source, 'd20');
});

test('骰子：2d6+3 解析', () => {
  const parsed = parseDiceExpression('2d6+3');
  assert.deepEqual(parsed.terms, [{ count: 2, sides: 6 }]);
  assert.equal(parsed.modifier, 3);
});

test('骰子：允许空格与减号 1d8 - 2', () => {
  const parsed = parseDiceExpression(' 1d8 - 2 ');
  assert.deepEqual(parsed.terms, [{ count: 1, sides: 8 }]);
  assert.equal(parsed.modifier, -2);
  assert.equal(parsed.source, '1d8 - 2');
});

test('骰子：纯加值与负加值', () => {
  assert.deepEqual(parseDiceExpression('3').terms, []);
  assert.equal(parseDiceExpression('3').modifier, 3);
  assert.equal(parseDiceExpression('-2').modifier, -2);
  assert.equal(parseDiceExpression('+5').modifier, 5);
});

test('骰子：多项相加 1d8+1d6+2', () => {
  const parsed = parseDiceExpression('1d8+1d6+2');
  assert.deepEqual(parsed.terms, [
    { count: 1, sides: 8 },
    { count: 1, sides: 6 },
  ]);
  assert.equal(parsed.modifier, 2);
});

test('骰子：非法表达式被拒绝且信息可读', () => {
  for (const bad of ['', '  ', '0d6', '1d1', '1d8+', '+', 'abc', '1d8*2', '1d8 2', 'd']) {
    assert.equal(isDiceExpression(bad), false, `应拒绝 "${bad}"`);
    assert.throws(() => parseDiceExpression(bad), RangeError, `应抛错 "${bad}"`);
  }
});

test('骰子：个数/面数/长度上限生效', () => {
  assert.throws(() => parseDiceExpression(`${DICE_LIMITS.maxCount + 1}d6`), RangeError);
  assert.throws(() => parseDiceExpression(`1d${DICE_LIMITS.maxSides + 1}`), RangeError);
  assert.throws(() => parseDiceExpression('1'.repeat(DICE_LIMITS.maxLength + 1)), RangeError);
});

test('骰子：掷骰面数在合法范围且 total 自洽', () => {
  const rng = createSeededRng({ ...BASE_SEED, hook: 'damage' });
  const roll = rollDice('2d6+3', rng);
  assert.equal(roll.dice.length, 2);
  for (const die of roll.dice) assert.ok(die >= 1 && die <= 6);
  assert.equal(roll.total, roll.dice[0]! + roll.dice[1]! + 3);
  assert.equal(roll.expr, '2d6+3');
  assert.equal(roll.modifier, 3);
});

test('骰子：同种子掷骰结果完全一致', () => {
  const a = rollDice('3d8+1', createSeededRng(BASE_SEED));
  const b = rollDice('3d8+1', createSeededRng(BASE_SEED));
  assert.deepEqual(a, b);
});
