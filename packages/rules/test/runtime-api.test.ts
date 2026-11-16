/** M9.2：运行时公共 API 杂项（时钟只做展示、事件订阅、调用上限、完整性报告、换装）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuleRuntime,
  type RulePack,
} from '../src/index.ts';
import {
  addActor,
  attachScripts,
  collectEvents,
  createRuntime,
  expectErr,
  expectOk,
  makeCard,
  makeScript,
  withPack,
} from './runtime-helpers.ts';

test('API：roomSeed 可读，clock 只写事件 at、不影响骰面', () => {
  const clocked = createRuleRuntime({ rules: withPack(() => undefined), roomSeed: 777, clock: () => 1234 });
  assert.equal(clocked.roomSeed, 777);
  addActor(clocked, makeCard({ cardId: 'card_a' }));
  const collector = collectEvents(clocked);
  expectOk(clocked.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.ok(collector.events.length > 0);
  assert.equal(collector.events[0]!.at, 1234);

  // 不带 clock 的事件没有 at 字段；时钟不影响骰面（同 roomSeed 同调用序列）
  const plain = createRuntime({ roomSeed: 777 });
  addActor(plain, makeCard({ cardId: 'card_a' }));
  const plainCollector = collectEvents(plain);
  const plainRoll = expectOk(plain.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(plainCollector.events[0]!.at, undefined);

  const clockedAgain = createRuleRuntime({ rules: withPack(() => undefined), roomSeed: 777, clock: () => 999 });
  addActor(clockedAgain, makeCard({ cardId: 'card_a' }));
  const clockedRoll = expectOk(clockedAgain.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(clockedRoll.total, plainRoll.total);
  assert.equal(clockedRoll.d20, plainRoll.d20);
});

test('API：subscribe 返回退订函数，退订后不再收事件', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const received: number[] = [];
  const unsubscribe = runtime.subscribe((event) => received.push(event.seq));
  expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  const count = received.length;
  assert.ok(count > 0);
  unsubscribe();
  expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(received.length, count);
  // recentEvents 可回看
  assert.ok(runtime.recentEvents(100).length > count);
  assert.equal(runtime.recentEvents(2).length, 2);
});

test('API：单场钩子调用上限生效（超限走缺省 + rules/error limit）', () => {
  const script = makeScript(
    'combat.js',
    'module.exports = { resolveCheck: function () { return { total: 99, success: true }; } };',
  );
  const runtime = createRuntime({ scripts: [script], maxHookCalls: 1 });
  const collector = collectEvents(runtime);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const first = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(first.usedHook, true);
  assert.equal(first.total, 99);
  const second = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(second.usedHook, false);
  const limit = collector.of('rules/error').find((event) => event.data.kind === 'limit');
  assert.ok(limit !== undefined);
  assert.match(String(limit.data.message), /上限/);
});

test('完整性：规则包声明了某钩子但脚本未导出 → 报告 missingHooks 且走缺省', () => {
  const script = makeScript(
    'sheet.js',
    'module.exports = { validateSheet: function () { return []; } };',
  );
  const pack: RulePack = withPack((current) => {
    attachScripts(current, script, ['validateSheet', 'computeDerived']);
  });
  const runtime = createRuntime({ rules: pack, scripts: [script] });
  const report = runtime.scriptReports[0]!;
  assert.equal(report.ok, true);
  assert.deepEqual(report.hooks, ['validateSheet']);
  assert.deepEqual(report.missingHooks, ['computeDerived']);
  assert.equal(runtime.listHooks().includes('computeDerived'), false);
  // computeDerived 缺省 {}
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  assert.deepEqual(expectOk(runtime.getDerived('card_a')).derived, {});
});

test('完整性：清单外的脚本钩子不生效（只认 rules.scripts 声明）', () => {
  const declared = makeScript(
    'sheet.js',
    'module.exports = { validateSheet: function () { return []; } };',
  );
  const extra = makeScript(
    'extra.js',
    'module.exports = { resolveCheck: function () { return { total: 99, success: true }; } };',
  );
  const pack: RulePack = withPack((current) => {
    attachScripts(current, declared, ['validateSheet']);
  });
  const runtime = createRuntime({ rules: pack, scripts: [declared, extra] });
  assert.equal(runtime.listHooks().includes('resolveCheck'), false);
  assert.equal(runtime.listHooks().includes('validateSheet'), true);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  assert.equal(result.usedHook, false);
});

test('API：ctx.tables.pick 记录 table/roll 事件', () => {
  const script = makeScript(
    'loot.js',
    `module.exports = {
      generateLoot: function (ctx) {
        var pick = ctx.tables.pick("loot.common");
        return [{ itemId: "hengdao", name: "表 " + pick.roll.total }];
      }
    };`,
  );
  const runtime = createRuntime({ scripts: [script] });
  const collector = collectEvents(runtime);
  const loot = expectOk(runtime.resolveLoot({ tableId: 'loot.common' }));
  assert.equal(loot.usedHook, true);
  const tableEvents = collector.of('table/roll');
  assert.equal(tableEvents.length, 1);
  assert.equal(tableEvents[0]!.data.tableId, 'loot.common');
  assert.equal(typeof tableEvents[0]!.data.total, 'number');
});

test('API：换装成功 → 派生重算并广播 equip/change；非法装备被拒绝且不改卡', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const collector = collectEvents(runtime);
  const result = expectOk(runtime.changeEquipment({
    actorId: 'card_a',
    equipmentInstances: [
      { instanceId: 'ins_1', slot: 'mainHand', name: '横刀', tags: ['weapon:melee'], stats: { 攻击: 2 } },
    ],
  }));
  assert.equal(result.actor.card.equipmentInstances.length, 1);
  const events = collector.of('equip/change');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.data.instanceIds, ['ins_1']);

  // 非法槽位：整体拒绝且卡保持原样
  const bad = runtime.changeEquipment({
    actorId: 'card_a',
    equipmentInstances: [
      { instanceId: 'ins_2', slot: 'nowhere', name: '怪东西', tags: [], stats: {} },
    ],
  });
  assert.equal(expectErr(bad).code, 'invalid_sheet');
  const actor = expectOk(runtime.getActor('card_a')).actor;
  assert.equal(actor.card.equipmentInstances.length, 1);
  assert.equal(actor.card.equipmentInstances[0]!.instanceId, 'ins_1');
});

test('API：addActor 重复 / getActor 不存在 / removeActor 语义', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  assert.equal(expectErr(runtime.addActor({ card: makeCard({ cardId: 'card_a' }) })).code, 'invalid_request');
  assert.equal(expectErr(runtime.getActor('card_x')).code, 'unknown_actor');
  expectOk(runtime.removeActor('card_a'));
  assert.equal(expectErr(runtime.removeActor('card_a')).code, 'unknown_actor');
  assert.equal(runtime.listActors().length, 0);
});

test('API：dispose 幂等且之后仍可安全读取状态', () => {
  const runtime = createRuntime({ scripts: [makeScript('x.js', 'module.exports = { onEvent: function () { return {}; } };')] });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  runtime.dispose();
  runtime.dispose();
  assert.equal(runtime.listActors().length, 1);
  assert.equal(runtime.listHooks().length, 0);
});
