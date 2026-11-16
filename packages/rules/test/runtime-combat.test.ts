/** M9.2：战斗时序、先攻、行动经济、状态 tick、回合上限。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RulePack, RuleRuntime } from '../src/index.ts';
import {
  addActor,
  collectEvents,
  createRuntime,
  expectErr,
  expectOk,
  makeCard,
  makeScript,
  withPack,
} from './runtime-helpers.ts';

function addPair(runtime: RuleRuntime) {
  addActor(runtime, makeCard({ cardId: 'card_a', name: '甲', dex: 16 }), { team: 'player' });
  addActor(runtime, makeCard({ cardId: 'card_b', name: '乙', dex: 8, hp: 30, hpMax: 30 }), { team: 'enemy' });
}

// ---------------------------------------------------------------------------
// 先攻
// ---------------------------------------------------------------------------

test('战斗：先攻顺序由种子骰 + 公式决定，同种子完全一致', () => {
  const first = createRuntime({ roomSeed: 31415 });
  const second = createRuntime({ roomSeed: 31415 });
  addPair(first);
  addPair(second);
  const a = expectOk(first.startCombat({}));
  const b = expectOk(second.startCombat({}));
  assert.deepEqual(a.view.order.map((entry) => entry.actorId), b.view.order.map((entry) => entry.actorId));
  assert.deepEqual(a.rolls, b.rolls);
  assert.equal(a.view.round, 1);
  assert.equal(a.view.maxRounds, 10);
  assert.equal(a.view.active, true);
});

test('战斗：不同房间种子的先攻骰面不同', () => {
  const totals = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5]) {
    const runtime = createRuntime({ roomSeed: seed });
    addPair(runtime);
    const started = expectOk(runtime.startCombat({}));
    totals.add(JSON.stringify(started.rolls.map((roll) => roll.dice)));
  }
  assert.ok(totals.size >= 4, `不同种子应产生不同先攻，实际只有 ${totals.size} 种`);
});

test('战斗：先攻按总值降序排列并写入 actor.initiative', () => {
  const runtime = createRuntime({ roomSeed: 9 });
  addPair(runtime);
  const view = expectOk(runtime.startCombat({})).view;
  const totals = view.order.map((entry) => entry.initiative);
  for (let index = 1; index < totals.length; index += 1) {
    assert.ok((totals[index - 1] as number) >= (totals[index] as number));
  }
  for (const entry of view.order) {
    assert.equal(typeof entry.roll, 'number');
    assert.equal(entry.roll >= 1 && entry.roll <= 20, true);
  }
});

test('战斗：开战广播 combat/start + round/start + turn/start', () => {
  const runtime = createRuntime({ roomSeed: 3 });
  addPair(runtime);
  const collector = collectEvents(runtime);
  expectOk(runtime.startCombat({}));
  const kinds = collector.kinds();
  assert.ok(kinds.includes('combat/start'));
  assert.ok(kinds.includes('round/start'));
  assert.ok(kinds.includes('turn/start'));
  const turnStart = collector.of('turn/start')[0]!;
  assert.equal(typeof turnStart.data.actorId, 'string');
});

// ---------------------------------------------------------------------------
// 回合推进
// ---------------------------------------------------------------------------

test('战斗：endTurn 轮到下一个行动者', () => {
  const runtime = createRuntime({ roomSeed: 21 });
  addPair(runtime);
  const view = expectOk(runtime.startCombat({})).view;
  const first = view.activeActorId;
  const next = expectOk(runtime.endTurn({})).view.activeActorId;
  assert.notEqual(next, first);
  assert.equal(next, view.order.find((entry) => entry.actorId !== first)?.actorId);
});

test('战斗：跨轮自动 round/end → round/start 并递增轮数', () => {
  const runtime = createRuntime({ roomSeed: 22 });
  addPair(runtime);
  collectEvents(runtime);
  expectOk(runtime.startCombat({}));
  expectOk(runtime.endTurn({}));
  const collector = collectEvents(runtime);
  const wrapped = expectOk(runtime.endTurn({}));
  assert.equal(wrapped.view.round, 2);
  assert.ok(collector.kinds().includes('round/end'));
  assert.ok(collector.kinds().includes('round/start'));
  assert.equal(collector.of('round/start')[0]!.data.round, 2);
});

test('战斗：非当前行动者不能结算（锁 4）', () => {
  const runtime = createRuntime({ roomSeed: 23 });
  addPair(runtime);
  const view = expectOk(runtime.startCombat({})).view;
  const inactive = view.order.find((entry) => entry.actorId !== view.activeActorId)!.actorId;
  const error = expectErr(runtime.endTurn({ actorId: inactive }));
  assert.equal(error.code, 'not_active');
});

test('战斗：战斗中重复开战被拒绝', () => {
  const runtime = createRuntime({ roomSeed: 24 });
  addPair(runtime);
  expectOk(runtime.startCombat({}));
  assert.equal(expectErr(runtime.startCombat({})).code, 'combat_active');
});

// ---------------------------------------------------------------------------
// 行动经济
// ---------------------------------------------------------------------------

test('行动经济：动作消耗后同回合不能再动，结束回合回满', () => {
  const runtime = createRuntime({ roomSeed: 30 });
  addPair(runtime);
  const view = expectOk(runtime.startCombat({})).view;
  const actorId = view.activeActorId ?? '';
  const targetId = view.order.find((entry) => entry.actorId !== actorId)!.actorId;
  const first = expectOk(runtime.useAction({ actorId, actionId: 'attack.melee', targetId }));
  assert.deepEqual(first.cost.turn, { action: 1 });
  const second = runtime.useAction({ actorId, actionId: 'attack.melee', targetId });
  assert.equal(expectErr(second).code, 'insufficient_turn_resource');
  // 结束两回合（一轮）回到该角色 → 动作回满
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  const third = expectOk(runtime.useAction({ actorId, actionId: 'attack.melee', targetId }));
  assert.equal(third.actorId, actorId);
});

test('行动经济：3 点行动力风格（turn.resources 只计数，语义在规则包）', () => {
  const pack: RulePack = withPack((current) => {
    current.turn = { refill: 'turnStart', resources: [{ id: 'ap', name: '行动点', count: 3 }] };
    current.actions = [{
      actionId: 'attack.ap',
      name: '连击',
      kind: 'attack',
      cost: { ap: 1 },
      targeting: { type: 'single', range: 'engaged', sides: 'enemy' },
      damage: { dice: '1d4' },
      description: '测试用连击',
    }];
  });
  const runtime = createRuntime({ rules: pack, roomSeed: 31 });
  addPair(runtime);
  const view = expectOk(runtime.startCombat({})).view;
  const actorId = view.activeActorId ?? '';
  const targetId = view.order.find((entry) => entry.actorId !== actorId)!.actorId;
  for (let index = 0; index < 3; index += 1) {
    expectOk(runtime.useAction({ actorId, actionId: 'attack.ap', targetId }));
  }
  assert.equal(expectErr(runtime.useAction({ actorId, actionId: 'attack.ap', targetId })).code, 'insufficient_turn_resource');
});

test('行动经济：移动力按地形消耗，不足时报错', () => {
  const runtime = createRuntime({ roomSeed: 32 });
  addActor(runtime, makeCard({ cardId: 'card_solo' }), { position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  const first = expectOk(runtime.move({ actorId: 'card_solo', to: { cell: { x: 2, y: 3 } } }));
  assert.equal(first.cost, 1);
  assert.equal(first.remaining, 5);
  // 连续移动到耗尽：移动到远处（Bresenham 斜向多格），6 点移动力不够
  expectOk(runtime.move({ actorId: 'card_solo', to: { cell: { x: 2, y: 2 } } }));
  expectOk(runtime.move({ actorId: 'card_solo', to: { cell: { x: 2, y: 1 } } }));
  const costly = runtime.move({ actorId: 'card_solo', to: { cell: { x: 6, y: 1 } } });
  assert.equal(expectErr(costly).code, 'insufficient_turn_resource');
});

// ---------------------------------------------------------------------------
// 状态 / 效果 tick 与叠加
// ---------------------------------------------------------------------------

const applyStatusScript = (body: string) => makeScript(
  'events.js',
  `module.exports = {
    onEvent: function (ctx, event) {
      if (event.kind !== "round/start") return {};
      ${body}
      return {};
    }
  };`,
);

test('状态：时长按回合 tick，归零移除并广播 status/tick', () => {
  const script = applyStatusScript(
    'if (event.data.round === 1) ctx.effects.apply({ statusId: "poisoned", duration: 2, targetActorId: "card_a" });',
  );
  const runtime = createRuntime({ roomSeed: 40, scripts: [script] });
  addPair(runtime);
  const collector = collectEvents(runtime);
  expectOk(runtime.startCombat({}));
  const activeId = expectOk(runtime.getActor('card_a')).actor.actorId;
  void activeId;
  // 一轮结束：poisoned 2 → 1
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  const ticks = collector.of('status/tick');
  assert.ok(ticks.some((event) => event.data.remaining === 1 && event.data.removed === false));
  // 第二轮结束：1 → 0 移除
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  assert.ok(collector.of('status/tick').some((event) => event.data.removed === true));
  const actors = runtime.listActors();
  assert.ok(actors.every((actor) => actor.effects.every((effect) => effect.statusId !== 'poisoned')));
  assert.ok(actors.every((actor) => actor.card.statuses.every((status) => status.id !== 'poisoned')));
});

test('状态：refresh 叠法刷新时长、层数取高', () => {
  const script = applyStatusScript(
    'if (event.data.round === 1 || event.data.round === 2) ctx.effects.apply({ statusId: "poisoned", duration: 3, targetActorId: "card_a" });',
  );
  const runtime = createRuntime({ roomSeed: 41, scripts: [script] });
  addPair(runtime);
  expectOk(runtime.startCombat({}));
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  const actor = runtime.listActors().find((entry) => entry.effects.some((effect) => effect.statusId === 'poisoned'));
  assert.ok(actor !== undefined);
  const effect = actor.effects.find((entry) => entry.statusId === 'poisoned')!;
  assert.equal(effect.stacks, 1);
  assert.equal(effect.remaining, 3);
});

test('状态：stack 叠法叠加层数', () => {
  const pack: RulePack = withPack((current) => {
    const def = current.sheet.statuses.find((status) => status.id === 'poisoned');
    if (def !== undefined) def.stacking = 'stack';
  });
  const script = applyStatusScript(
    'if (event.data.round === 1 || event.data.round === 2) ctx.effects.apply({ statusId: "poisoned", duration: 3, targetActorId: "card_a" });',
  );
  const runtime = createRuntime({ rules: pack, roomSeed: 42, scripts: [script] });
  addPair(runtime);
  expectOk(runtime.startCombat({}));
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  const actor = runtime.listActors().find((entry) => entry.effects.some((effect) => effect.statusId === 'poisoned'));
  const effect = actor!.effects.find((entry) => entry.statusId === 'poisoned')!;
  assert.equal(effect.stacks, 2);
});

// ---------------------------------------------------------------------------
// 回合上限 → onRoundLimit
// ---------------------------------------------------------------------------

function twoRoundPack(): RulePack {
  return withPack((current) => {
    current.time = { model: 'round', durationUnit: 'round', defaultMaxRounds: 2, onRoundLimit: 'end' };
  });
}

function runToLimit(runtime: RuleRuntime): void {
  // 2 个行动者：每 2 次 endTurn 推进一轮
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({})); // 轮 1 结束 → 轮 2
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({})); // 轮 2 结束 → 触发上限
}

test('回合上限：无钩子时按 time.onRoundLimit=end 收场', () => {
  const runtime = createRuntime({ rules: twoRoundPack(), roomSeed: 50 });
  addPair(runtime);
  const collector = collectEvents(runtime);
  expectOk(runtime.startCombat({}));
  runToLimit(runtime);
  const limit = collector.of('round/limit')[0];
  assert.ok(limit !== undefined);
  assert.equal(limit.data.action, 'end');
  assert.equal(limit.data.maxRounds, 2);
  assert.ok(collector.kinds().includes('combat/end'));
  const view = runtime.getCombat();
  assert.equal(view.active, false);
  assert.equal(view.limitAction, 'end');
  assert.equal(view.endedReason, 'round_limit');
});

test('回合上限：onRoundLimit 返回 draw → 平局收场', () => {
  const script = makeScript('time.js', 'module.exports = { onRoundLimit: function () { return { action: "draw", log: "平局" }; } };');
  const runtime = createRuntime({ rules: twoRoundPack(), roomSeed: 51, scripts: [script] });
  addPair(runtime);
  expectOk(runtime.startCombat({}));
  runToLimit(runtime);
  const view = runtime.getCombat();
  assert.equal(view.active, false);
  assert.equal(view.limitAction, 'draw');
  assert.equal(view.endedReason, 'draw');
});

test('回合上限：onRoundLimit 返回 overtime → 继续并标记，不再重复触发', () => {
  const script = makeScript('time.js', 'module.exports = { onRoundLimit: function () { return { action: "overtime" }; } };');
  const runtime = createRuntime({ rules: twoRoundPack(), roomSeed: 52, scripts: [script] });
  addPair(runtime);
  const collector = collectEvents(runtime);
  expectOk(runtime.startCombat({}));
  runToLimit(runtime);
  let view = runtime.getCombat();
  assert.equal(view.active, true);
  assert.equal(view.overtime, true);
  assert.equal(view.limitAction, 'overtime');
  assert.equal(view.round, 3);
  assert.equal(collector.of('round/limit').length, 1);
  // 继续推进一轮也不会再触发上限
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  view = runtime.getCombat();
  assert.equal(view.active, true);
  assert.equal(collector.of('round/limit').length, 1);
});

// ---------------------------------------------------------------------------
// 死亡 / 收场
// ---------------------------------------------------------------------------

test('战斗：倒下的角色被跳过', () => {
  const runtime = createRuntime({ roomSeed: 60 });
  addActor(runtime, makeCard({ cardId: 'card_a', name: '甲' }), { team: 'player' });
  addActor(runtime, makeCard({ cardId: 'card_b', name: '乙' }), { team: 'enemy' });
  addActor(runtime, makeCard({ cardId: 'card_c', name: '丙', hp: 1, hpMax: 1 }), { team: 'enemy' });
  const view = expectOk(runtime.startCombat({})).view;
  // 杀掉丙（非当前行动者）
  expectOk(runtime.applyDamage({ targetId: 'card_c', amount: 50 }));
  assert.equal(expectOk(runtime.getActor('card_c')).actor.dead, true);
  const collector = collectEvents(runtime);
  // 连续结束回合，turn/start 不应再出现丙
  for (let index = 0; index < 6; index += 1) {
    const status = runtime.getCombat();
    if (!status.active) break;
    expectOk(runtime.endTurn({}));
  }
  const startedIds = collector.of('turn/start').map((event) => event.data.actorId);
  assert.equal(startedIds.includes('card_c'), false);
  void view;
});

test('战斗：全员倒下自动收场；手动 endCombat 也可收场', () => {
  const runtime = createRuntime({ roomSeed: 61 });
  addPair(runtime);
  const collector = collectEvents(runtime);
  expectOk(runtime.startCombat({}));
  expectOk(runtime.applyDamage({ targetId: 'card_a', amount: 99 }));
  expectOk(runtime.applyDamage({ targetId: 'card_b', amount: 99 }));
  // 当前行动者已倒下，endTurn 会找到... 没有活人 → 自动收场
  expectOk(runtime.endTurn({}));
  assert.equal(runtime.getCombat().active, false);
  assert.ok(collector.kinds().includes('death'));
  assert.ok(collector.kinds().includes('combat/end'));

  const second = createRuntime({ roomSeed: 62 });
  addPair(second);
  expectOk(second.startCombat({}));
  const closed = expectOk(second.endCombat({ reason: 'gm' }));
  assert.equal(closed.view.active, false);
  assert.equal(closed.view.endedReason, 'gm');
});

test('战斗：startCombat({mapId}) 激活战斗地图，非法 mapId 报错', () => {
  const runtime = createRuntime({ roomSeed: 63 });
  addPair(runtime);
  const started = expectOk(runtime.startCombat({ mapId: 'map_cave' }));
  assert.equal(started.view.active, true);
  const state = runtime.exportState();
  assert.equal(state.space.mapId, 'map_cave');

  const second = createRuntime({ roomSeed: 64 });
  addPair(second);
  const error = expectErr(second.startCombat({ mapId: 'map_nope' }));
  assert.equal(error.code, 'unknown_map');
});
