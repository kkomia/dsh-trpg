/** M9.2：检定、动作、伤害、等级与掉落结算。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionResultData, RulePack, RuleRuntime } from '../src/index.ts';
import {
  addActor,
  collectEvents,
  createRuntime,
  expectErr,
  expectOk,
  hpOf,
  makeCard,
  setupDuel,
  withPack,
} from './runtime-helpers.ts';

function formulaPack(overrides: Record<string, string>): RulePack {
  return withPack((pack) => {
    for (const [name, source] of Object.entries(overrides)) pack.formulas[name] = source;
  });
}

// ---------------------------------------------------------------------------
// rollCheck：优势 / 劣势 / 加值
// ---------------------------------------------------------------------------

test('检定：优势掷 2d20 取高，劣势取低，普通掷 1d20', () => {
  const runtime = createRuntime({ roomSeed: 100 });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const normal = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(normal.mode, 'normal');
  assert.equal(normal.rolls[0]!.dice.length, 1);
  const advantage = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10, mode: 'advantage' }));
  assert.equal(advantage.rolls[0]!.dice.length, 2);
  assert.equal(advantage.d20, Math.max(...advantage.rolls[0]!.dice));
  const disadvantage = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10, mode: 'disadvantage' }));
  assert.equal(disadvantage.d20, Math.min(...disadvantage.rolls[0]!.dice));
});

test('检定：属性加值来自 derived.mod.<attr>', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a', str: 17 }));
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', attributeId: 'str', dc: 10, mods: 2 }));
  assert.equal(result.modifier, 0);
  assert.equal(result.total, (result.d20 ?? 0) + 2);
});

test('检定：技能总加值走 formulas.check（含熟练/属性调整）', () => {
  const runtime = createRuntime({
    rules: formulaPack({ check: 'derived.mod + skill.proficient * proficiency + skill.bonus' }),
  });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  // 卡上没有熟练状态 → check = 0 + 0*2 + 0 = 0
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', skillId: 'athletics', dc: 10 }));
  assert.equal(result.modifier, 0);
  const actor = expectOk(runtime.getActor('card_a')).actor;
  void actor;
});

test('检定：DC 越界被拒绝', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  assert.equal(expectErr(runtime.rollCheck({ actorId: 'card_a', dc: 99 })).code, 'invalid_request');
  assert.equal(expectErr(runtime.rollCheck({ actorId: 'card_none', dc: 10 })).code, 'unknown_actor');
});

test('检定：可复现（同一 roomSeed + 同一调用序列骰面一致）', () => {
  const results: string[] = [];
  for (const seed of [200, 200]) {
    const runtime = createRuntime({ roomSeed: seed });
    addActor(runtime, makeCard({ cardId: 'card_a' }));
    const parts: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 12 }));
      parts.push(JSON.stringify({ d20: result.d20, total: result.total }));
    }
    results.push(parts.join('|'));
  }
  assert.equal(results[0], results[1]);
});

// ---------------------------------------------------------------------------
// useAction：命中 / 伤害 / 事件
// ---------------------------------------------------------------------------

test('动作：命中后按 damage 骰 + 公式结算并写回 HP', () => {
  const duel = setupDuel({ rules: formulaPack({ attack: '100', defense: '10', damage: '5' }), roomSeed: 300 });
  const collector = collectEvents(duel.runtime);
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  const result = expectOk(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.melee', targetId: target }));
  assert.equal(result.hit, true);
  assert.ok(result.damage !== undefined);
  assert.equal(result.damage!.amount, result.damage!.hpBefore - result.damage!.hpAfter);
  assert.ok(result.damage!.amount >= 6, `1d8+5 至少 6，实际 ${result.damage!.amount}`);
  assert.equal(hpOf(duel.runtime, target), result.damage!.hpAfter);
  assert.ok(collector.kinds().includes('action/before'));
  assert.ok(collector.kinds().includes('action/after'));
  assert.ok(collector.kinds().includes('damage/after'));
  // trace 里有骰面与公式中间值
  assert.ok(result.trace.lines.length > 0);
  assert.ok(result.trace.data.attack !== undefined);
});

test('动作：未命中不损失目标 HP，仍消耗动作', () => {
  const duel = setupDuel({ rules: formulaPack({ attack: '-100', defense: '10' }), roomSeed: 301 });
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  const hpBefore = hpOf(duel.runtime, target);
  const result = expectOk(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.melee', targetId: target }));
  assert.equal(result.hit, false);
  assert.equal(hpOf(duel.runtime, target), hpBefore);
  assert.equal(result.cost.turn.action, 1);
});

test('动作：暴击时伤害骰掷两次（骰子加倍）', () => {
  const pack = formulaPack({ attack: '100', defense: '10', damage: '0' });
  let foundResult: ActionResultData | undefined;
  for (let seed = 1; seed <= 200 && foundResult === undefined; seed += 1) {
    const duel = setupDuel({ rules: pack, roomSeed: seed });
    const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
    const result = expectOk(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.melee', targetId: target }));
    if (result.crit === true) foundResult = result;
  }
  assert.ok(foundResult !== undefined, '200 个种子里应至少出现一次暴击');
  const damageRolls = foundResult.rolls.filter((roll) => roll.expr === '1d8');
  assert.equal(damageRolls.length, 2);
  assert.equal(foundResult.damage!.amount, damageRolls[0]!.total + damageRolls[1]!.total);
});

test('动作：未知动作 / 敌方目标校验 / 未轮到的角色', () => {
  const duel = setupDuel({ roomSeed: 302 });
  assert.equal(expectErr(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.nope' })).code, 'unknown_action');
  assert.equal(expectErr(duel.runtime.useAction({ actorId: duel.otherId, actionId: 'attack.melee', targetId: duel.activeId })).code, 'not_active');
  // 攻击动作缺目标
  assert.equal(expectErr(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.melee' })).code, 'invalid_target');
});

test('动作：友方目标被拒绝（阵营校验）', () => {
  const runtime = createRuntime({ roomSeed: 303 });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { team: 'player' });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { team: 'player' });
  const view = expectOk(runtime.startCombat({})).view;
  const targetId = view.order.find((entry) => entry.actorId !== view.activeActorId)!.actorId;
  const error = expectErr(runtime.useAction({ actorId: view.activeActorId ?? '', actionId: 'attack.melee', targetId }));
  assert.equal(error.code, 'invalid_target');
});

test('动作：超出射程被拒绝', () => {
  const runtime = createRuntime({ roomSeed: 304 });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { team: 'player', position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { team: 'enemy', position: { zoneId: 'cave', cell: { x: 5, y: 1 } } });
  const view = expectOk(runtime.startCombat({})).view;
  const actorId = view.activeActorId ?? '';
  const targetId = view.order.find((entry) => entry.actorId !== actorId)!.actorId;
  const error = expectErr(runtime.useAction({ actorId, actionId: 'attack.melee', targetId }));
  assert.equal(error.code, 'out_of_range');
});

test('动作：角色资源花费（cost.resource）被扣减', () => {
  const pack = withPack((current) => {
    current.actions = [
      ...current.actions,
      {
        actionId: 'skill.sacrifice',
        name: '献祭',
        kind: 'custom',
        cost: { resource: { id: 'hp', amount: 2 } },
        targeting: { type: 'self', range: 'engaged', sides: 'self' },
        description: '花 2 点生命',
      },
    ];
  });
  const runtime = createRuntime({ rules: pack, roomSeed: 305 });
  addActor(runtime, makeCard({ cardId: 'card_a', hp: 7, hpMax: 20 }));
  const result = expectOk(runtime.useAction({ actorId: 'card_a', actionId: 'skill.sacrifice' }));
  assert.deepEqual(result.cost.resource, { id: 'hp', amount: 2 });
  assert.equal(hpOf(runtime, 'card_a'), 5);
  // 再成功两次后只剩 1 点，付不起第 4 次
  expectOk(runtime.useAction({ actorId: 'card_a', actionId: 'skill.sacrifice' }));
  expectOk(runtime.useAction({ actorId: 'card_a', actionId: 'skill.sacrifice' }));
  assert.equal(hpOf(runtime, 'card_a'), 1);
  const error = expectErr(runtime.useAction({ actorId: 'card_a', actionId: 'skill.sacrifice' }));
  assert.equal(error.code, 'insufficient_turn_resource');
});

test('动作：战斗外可自由使用（turn 段仍计数但不限制轮次）', () => {
  const runtime = createRuntime({ roomSeed: 306 });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { team: 'player' });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { team: 'enemy' });
  // 直接攻击（无战斗，无行动者限制）
  const result = expectOk(runtime.useAction({ actorId: 'card_a', actionId: 'attack.melee', targetId: 'card_b' }));
  assert.equal(result.actorId, 'card_a');
});

// ---------------------------------------------------------------------------
// applyDamage
// ---------------------------------------------------------------------------

test('伤害：临时 HP 先吸收，再扣 HP', () => {
  const runtime = createRuntime({ roomSeed: 400 });
  addActor(runtime, makeCard({ cardId: 'card_a', hp: 20, hpMax: 20 }));
  const snapshot = runtime.exportState();
  snapshot.actors.card_a!.tempHp = 5;
  expectOk(runtime.importState(snapshot));
  const result = expectOk(runtime.applyDamage({ targetId: 'card_a', amount: 8, type: 'fire' }));
  assert.equal(result.absorbedByTempHp, 5);
  assert.equal(result.amount, 8);
  assert.equal(result.hpBefore, 20);
  assert.equal(result.hpAfter, 17);
  assert.equal(expectOk(runtime.getActor('card_a')).actor.tempHp, 0);
});

test('伤害：HP 归零触发 death 事件并标记倒下', () => {
  const runtime = createRuntime({ roomSeed: 401 });
  addActor(runtime, makeCard({ cardId: 'card_a', hp: 5, hpMax: 5 }));
  const collector = collectEvents(runtime);
  const result = expectOk(runtime.applyDamage({ targetId: 'card_a', amount: 9 }));
  assert.equal(result.hpAfter, 0);
  assert.equal(result.dead, true);
  const death = collector.of('death');
  assert.equal(death.length, 1);
  assert.equal(death[0]!.data.actorId, 'card_a');
  // 二次伤害不重复发 death
  expectOk(runtime.applyDamage({ targetId: 'card_a', amount: 1 }));
  assert.equal(collector.of('death').length, 1);
});

test('伤害：非法数值被拒绝', () => {
  const runtime = createRuntime({ roomSeed: 402 });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  assert.equal(expectErr(runtime.applyDamage({ targetId: 'card_a', amount: -3 })).code, 'invalid_request');
  assert.equal(expectErr(runtime.applyDamage({ targetId: 'card_none', amount: 3 })).code, 'unknown_actor');
});

// ---------------------------------------------------------------------------
// 成长 / 掉落
// ---------------------------------------------------------------------------

test('成长：xpTable 升级并受 maxLevel 限制', () => {
  const runtime = createRuntime({ roomSeed: 500 });
  addActor(runtime, makeCard({ cardId: 'card_a', level: 1 }));
  const result = expectOk(runtime.levelUp({ actorId: 'card_a', xpGain: 5000 }));
  assert.equal(result.level, 5); // progression.maxLevel = 5
  assert.equal(expectOk(runtime.getActor('card_a')).actor.card.fields.level, 5);
});

test('成长：目标等级低于当前被拒绝；targetLevel 直接生效', () => {
  const runtime = createRuntime({ roomSeed: 501 });
  addActor(runtime, makeCard({ cardId: 'card_a', level: 3 }));
  assert.equal(expectErr(runtime.levelUp({ actorId: 'card_a', targetLevel: 1 })).code, 'invalid_request');
  const result = expectOk(runtime.levelUp({ actorId: 'card_a', targetLevel: 4 }));
  assert.equal(result.level, 4);
  // 3 → 4 之间没有 progression.grants
  assert.equal(result.gains.length, 0);
  assert.equal(expectOk(runtime.getActor('card_a')).actor.card.fields.level, 4);
});

test('掉落：count 控制数量且物品实例 id 唯一', () => {
  const runtime = createRuntime({ roomSeed: 502 });
  const result = expectOk(runtime.resolveLoot({ tableId: 'loot.common', count: 3 }));
  assert.equal(result.items.length, 3);
  const ids = new Set(result.items.map((item) => item.instanceId));
  assert.equal(ids.size, 3);
  assert.ok(result.rolls.length >= 3);
  assert.ok(result.trace.lines.length > 0);
});

test('掉落：数量越过上限被拒绝', () => {
  const runtime = createRuntime({ roomSeed: 503 });
  assert.equal(expectErr(runtime.resolveLoot({ count: 99 })).code, 'invalid_request');
});
