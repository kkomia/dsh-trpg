/** M9.2：纯 JSON 快照与复现（同 roomSeed + 同命令序列 → 骰面/结果一致）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_STATE_SCHEMA_VERSION,
  validateSnapshot,
  type RuleRuntime,
  type RuntimeSnapshot,
} from '../src/index.ts';
import {
  addActor,
  collectEvents,
  createRuntime,
  expectErr,
  expectOk,
  hpOf,
  makeCard,
  makeScript,
  setupDuel,
} from './runtime-helpers.ts';

function runSequence(runtime: RuleRuntime, actorId: string): string[] {
  const lines: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = expectOk(runtime.rollCheck({ actorId, dc: 12 }));
    lines.push(`${result.d20}/${result.total}/${result.success}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 快照形状
// ---------------------------------------------------------------------------

test('快照：是纯 JSON（JSON 往返不丢信息）', () => {
  const runtime = createRuntime({ roomSeed: 9001 });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const snapshot = runtime.exportState();
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.equal(snapshot.schemaVersion, RUNTIME_STATE_SCHEMA_VERSION);
  assert.equal(snapshot.rulesId, 'd20-mini');
  assert.equal(snapshot.roomSeed, 9001);
});

test('快照：含 rng 计数 / eventSeq / 回合 / 位置 / 效果 / HP', () => {
  const script = makeScript(
    'events.js',
    `module.exports = {
      onEvent: function (ctx, event) {
        if (event.kind === "round/start" && event.data.round === 1) {
          ctx.effects.apply({ statusId: "poisoned", duration: 3, targetActorId: "card_a" });
        }
        return {};
      }
    };`,
  );
  const runtime = createRuntime({ roomSeed: 9002, scripts: [script] });
  addActor(runtime, makeCard({ cardId: 'card_a', hp: 12, hpMax: 20 }), {
    team: 'player',
    position: { zoneId: 'cave', cell: { x: 1, y: 3 } },
  });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { team: 'enemy', position: { zoneId: 'cave', cell: { x: 2, y: 3 } } });
  expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  expectOk(runtime.startCombat({}));
  expectOk(runtime.applyDamage({ targetId: 'card_a', amount: 3 }));
  const snapshot = runtime.exportState();
  assert.ok(snapshot.eventSeq > 0);
  assert.ok(snapshot.rollCallSeq > 0);
  assert.equal(snapshot.time.round, 1);
  assert.equal(snapshot.combat.active, true);
  assert.equal(snapshot.combat.order.length, 2);
  const actor = snapshot.actors.card_a!;
  assert.equal(actor.position.zoneId, 'cave');
  assert.deepEqual(actor.position.cell, { x: 1, y: 3 });
  assert.equal(actor.card.resources.hp?.current, 9);
  assert.ok(actor.effects.some((effect) => effect.statusId === 'poisoned'));
});

// ---------------------------------------------------------------------------
// 确定性
// ---------------------------------------------------------------------------

test('复现：同 roomSeed + 同命令序列 → 骰面与结果逐项一致', () => {
  const first = createRuntime({ roomSeed: 9100 });
  const second = createRuntime({ roomSeed: 9100 });
  addActor(first, makeCard({ cardId: 'card_a' }));
  addActor(second, makeCard({ cardId: 'card_a' }));
  assert.deepEqual(runSequence(first, 'card_a'), runSequence(second, 'card_a'));
});

test('复现：不同 roomSeed → 骰面序列不同', () => {
  const first = createRuntime({ roomSeed: 9101 });
  const second = createRuntime({ roomSeed: 9102 });
  addActor(first, makeCard({ cardId: 'card_a' }));
  addActor(second, makeCard({ cardId: 'card_a' }));
  assert.notDeepEqual(runSequence(first, 'card_a'), runSequence(second, 'card_a'));
});

test('复现：同一动作链（先攻 + 攻击 + 伤害）完全一致', () => {
  const results: string[] = [];
  for (const seed of [9200, 9200]) {
    const duel = setupDuel({ roomSeed: seed });
    const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
    const result = expectOk(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.melee', targetId: target }));
    results.push(JSON.stringify({
      order: duel.view.order.map((entry) => `${entry.actorId}:${entry.initiative}`),
      hit: result.hit,
      damage: result.damage?.amount ?? null,
      hp: result.damage?.hpAfter ?? null,
      rolls: result.rolls,
    }));
  }
  assert.equal(results[0], results[1]);
});

// ---------------------------------------------------------------------------
// 导入 / 续算
// ---------------------------------------------------------------------------

test('快照：导入后继续同一命令序列，结果与原运行时一致', () => {
  const original = createRuntime({ roomSeed: 9300 });
  addActor(original, makeCard({ cardId: 'card_a' }));
  const firstHalf = runSequence(original, 'card_a');
  assert.equal(firstHalf.length, 4);
  const snapshot: RuntimeSnapshot = original.exportState();
  const expectedTail = runSequence(original, 'card_a');

  const restored = createRuntime({ roomSeed: 1 });
  expectOk(restored.importState(snapshot));
  assert.equal(restored.roomSeed, 9300);
  assert.deepEqual(runSequence(restored, 'card_a'), expectedTail);

  // 二次快照导入（幂等）
  const snapshot2 = restored.exportState();
  const third = createRuntime({ roomSeed: 2 });
  expectOk(third.importState(snapshot2));
  assert.deepEqual(runSequence(third, 'card_a'), runSequence(restored, 'card_a'));
});

test('快照：位置 / 效果 / HP / 回合完整恢复，战斗可继续推进', () => {
  const duel = setupDuel({ roomSeed: 9400 });
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  expectOk(duel.runtime.applyDamage({ targetId: target, amount: 4 }));
  expectOk(duel.runtime.move({ actorId: duel.activeId, to: { cell: { x: 2, y: 2 } } }));
  const snapshot = duel.runtime.exportState();

  const restored = createRuntime({ roomSeed: 99 });
  expectOk(restored.importState(snapshot));
  const actor = expectOk(restored.getActor(duel.activeId)).actor;
  assert.deepEqual(actor.position, { zoneId: 'cave', cell: { x: 2, y: 2 } });
  assert.equal(hpOf(restored, target), hpOf(duel.runtime, target));
  assert.equal(restored.getCombat().active, true);
  assert.equal(restored.getCombat().round, duel.runtime.getCombat().round);

  // 继续推进回合，事件 seq 从快照继续递增
  const seqBefore = restored.exportState().eventSeq;
  const collector = collectEvents(restored);
  expectOk(restored.endTurn({}));
  assert.ok(collector.events.length > 0);
  assert.ok(collector.events[0]!.seq > seqBefore);
});

test('快照：恢复后随机流继续（后续检定骰面一致）', () => {
  const original = createRuntime({ roomSeed: 9500 });
  addActor(original, makeCard({ cardId: 'card_a' }));
  runSequence(original, 'card_a');
  const snapshot = original.exportState();
  const restored = createRuntime({ roomSeed: 9501 });
  expectOk(restored.importState(snapshot));
  assert.deepEqual(runSequence(restored, 'card_a'), runSequence(original, 'card_a'));
});

// ---------------------------------------------------------------------------
// 校验拒绝
// ---------------------------------------------------------------------------

test('快照：rulesId / rulesVersion 不一致时拒绝导入', () => {
  const runtime = createRuntime({ roomSeed: 9600 });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const snapshot = runtime.exportState();
  const wrongId = { ...snapshot, rulesId: 'other-rules' };
  const result = runtime.importState(wrongId);
  assert.equal(expectErr(result).code, 'invalid_snapshot');
  assert.match(expectErr(result).messageZh, /rulesId/);

  const wrongVersion = { ...snapshot, rulesVersion: '9.9.9' };
  const versionResult = runtime.importState(wrongVersion);
  assert.equal(expectErr(versionResult).code, 'invalid_snapshot');
});

test('快照：schema 版本 / 结构非法时给出可读错误', () => {
  const runtime = createRuntime({ roomSeed: 9601 });
  assert.equal(expectErr(runtime.importState({})).code, 'invalid_snapshot');
  const errors = validateSnapshot({ schemaVersion: 'x' }, runtime.rules);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((line) => line.includes('schemaVersion')));
  assert.ok(expectErr(runtime.importState(null)).messageZh.includes('快照'));
});

test('快照：导入失败不破坏当前状态', () => {
  const runtime = createRuntime({ roomSeed: 9602 });
  addActor(runtime, makeCard({ cardId: 'card_a', hp: 11, hpMax: 20 }));
  expectErr(runtime.importState({ schemaVersion: 'bad' }));
  assert.equal(hpOf(runtime, 'card_a'), 11);
  assert.equal(runtime.listActors().length, 1);
});
