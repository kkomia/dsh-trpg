/** M9.2：钩子调度、事务回滚、缺省行为与 ctx 能力。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuleRuntime,
  RuleRuntimeError,
  type RulePack,
  type RuntimeLogEntry,
} from '../src/index.ts';
import {
  addActor,
  attachScripts,
  collectEvents,
  createRuntime,
  expectErr,
  expectOk,
  hpOf,
  makeCard,
  makeScript,
  setupDuel,
  withPack,
} from './runtime-helpers.ts';

// ---------------------------------------------------------------------------
// validateSheet
// ---------------------------------------------------------------------------

test('钩子：无脚本时 validateSheet 只做 schema + 数值范围校验', () => {
  const runtime = createRuntime();
  const bad = makeCard({ cardId: 'card_bad', str: 99 });
  const result = runtime.addActor({ card: bad });
  const error = expectErr(result);
  assert.equal(error.code, 'invalid_sheet');
  assert.match(error.messageZh, /力量|属性/);
  void runtime;
});

test('钩子：validateSheet 脚本拒绝时 addActor 失败且角色不入场', () => {
  const script = makeScript(
    'sheet.js',
    'module.exports = { validateSheet: function (ctx, sheet) { return sheet.fields.name === "坏蛋" ? ["名字不能用坏蛋"] : []; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  const bad = runtime.addActor({ card: makeCard({ cardId: 'card_x', name: '坏蛋' }) });
  assert.equal(bad.ok, false);
  assert.match(expectErr(bad).messageZh, /名字不能用坏蛋/);
  assert.equal(runtime.getActor('card_x').ok, false);
  // 合法角色正常入场
  addActor(runtime, makeCard({ cardId: 'card_ok', name: '阿青' }));
});

// ---------------------------------------------------------------------------
// computeDerived
// ---------------------------------------------------------------------------

test('钩子：computeDerived 产出派生值并被公式/检定使用', () => {
  const script = makeScript(
    'sheet.js',
    'module.exports = { computeDerived: function (ctx, sheet) { return { mod: 3, "mod.str": 3, hpMax: 25, ac: 13 }; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  const card = makeCard({ cardId: 'card_a', str: 17 });
  card.skills = [{ id: 'athletics', proficient: true, bonus: 0 }];
  addActor(runtime, card);
  const derived = expectOk(runtime.getDerived('card_a')).derived;
  assert.equal(derived.mod, 3);
  assert.equal(derived.ac, 13);
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', skillId: 'athletics', dc: 5 }));
  // 技能总加值 = derived.mod(3) + 熟练(1)*proficiency(2) + bonus(0) = 5
  assert.equal(result.modifier, 5);
});

test('钩子：computeDerived 抛错 → rules/error + 回退缺省 {}，房间继续', () => {
  const script = makeScript('sheet.js', 'module.exports = { computeDerived: function () { throw new Error("派生炸了"); } };');
  const runtime = createRuntime({ scripts: [script] });
  const collector = collectEvents(runtime);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const errors = collector.of('rules/error');
  assert.ok(errors.length >= 1);
  const payload = errors[0]!.data as Record<string, unknown>;
  assert.equal(payload.hook, 'computeDerived');
  assert.equal(payload.kind, 'throw');
  assert.match(String(payload.message), /派生炸了/);
  assert.deepEqual(expectOk(runtime.getDerived('card_a')).derived, {});
});

// ---------------------------------------------------------------------------
// resolveCheck
// ---------------------------------------------------------------------------

test('钩子：resolveCheck 缺省为 d20 + 公式加值 vs DC（同种子可复现）', () => {
  const script = makeScript('sheet.js', 'module.exports = { computeDerived: function () { return { mod: 2 }; } };');
  const first = createRuntime({ roomSeed: 777, scripts: [script] });
  const second = createRuntime({ roomSeed: 777, scripts: [script] });
  addActor(first, makeCard({ cardId: 'card_a' }));
  addActor(second, makeCard({ cardId: 'card_a' }));
  const a = expectOk(first.rollCheck({ actorId: 'card_a', attributeId: 'str', dc: 10 }));
  const b = expectOk(second.rollCheck({ actorId: 'card_a', attributeId: 'str', dc: 10 }));
  assert.equal(a.total, b.total);
  assert.equal(a.d20, b.d20);
  assert.equal(a.total, (a.d20 ?? 0) + 2);
  assert.equal(a.usedHook, false);
});

test('钩子：resolveCheck 脚本接管 total/success/crit/degree', () => {
  const script = makeScript(
    'combat.js',
    `module.exports = {
      resolveCheck: function (ctx, req) {
        return { total: 31, success: true, crit: true, degree: "crit", log: "脚本判定暴击" };
      }
    };`,
  );
  const runtime = createRuntime({ scripts: [script] });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 25 }));
  assert.equal(result.usedHook, true);
  assert.equal(result.total, 31);
  assert.equal(result.success, true);
  assert.equal(result.crit, true);
  assert.equal(result.degree, 'crit');
  assert.deepEqual(result.trace.lines, ['脚本判定暴击']);
});

test('钩子：resolveCheck 返回形状非法 → rules/error + 回退缺省行为', () => {
  const script = makeScript(
    'combat.js',
    'module.exports = { resolveCheck: function () { return { total: "不是数字", success: true }; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  const collector = collectEvents(runtime);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 5 }));
  assert.equal(result.usedHook, false);
  assert.equal(typeof result.total, 'number');
  const shapeError = collector.of('rules/error').find((event) => event.data.kind === 'shape');
  assert.ok(shapeError !== undefined);
  assert.match(String(shapeError.data.message), /total/);
});

// ---------------------------------------------------------------------------
// resolveAttack / resolveDamage
// ---------------------------------------------------------------------------

test('钩子：resolveAttack 脚本接管命中与伤害', () => {
  const script = makeScript(
    'combat.js',
    'module.exports = { resolveAttack: function (ctx, req) { return { hit: true, crit: false, damage: 7 }; } };',
  );
  const duel = setupDuel({ scripts: [script] });
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  const result = expectOk(duel.runtime.useAction({ actorId: duel.activeId, actionId: 'attack.melee', targetId: target }));
  assert.equal(result.usedHook, true);
  assert.equal(result.hit, true);
  assert.equal(result.damage?.amount, 7);
  assert.equal(hpOf(duel.runtime, target), 18 - 7);
});

test('钩子：resolveDamage 脚本减伤（抗性）后落账', () => {
  const script = makeScript(
    'combat.js',
    'module.exports = { resolveDamage: function (ctx, evt) { return { amount: Math.floor(evt.amount / 2), notes: "抗性减半" }; } };',
  );
  const duel = setupDuel({ scripts: [script] });
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  // 直接结算 10 点伤害，钩子应减半为 5
  const result = expectOk(duel.runtime.applyDamage({ targetId: target, amount: 10, sourceActorId: duel.activeId }));
  assert.equal(result.usedHook, true);
  assert.equal(result.amount, 5);
  assert.equal(result.hpAfter, 18 - 5);
});

test('钩子：resolveDamage 抛错 → 回滚 + 缺省伤害照常落账', () => {
  const script = makeScript('combat.js', 'module.exports = { resolveDamage: function () { throw new Error("抗性脚本炸了"); } };');
  const duel = setupDuel({ scripts: [script] });
  const collector = collectEvents(duel.runtime);
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  const result = expectOk(duel.runtime.applyDamage({ targetId: target, amount: 6 }));
  assert.equal(result.amount, 6);
  assert.equal(result.hpAfter, 18 - 6);
  assert.ok(collector.of('rules/error').some((event) => event.data.hook === 'resolveDamage'));
});

// ---------------------------------------------------------------------------
// onEvent（通用事件总线钩子）
// ---------------------------------------------------------------------------

test('钩子：onEvent 收到事件并可写卡 / 挂效果（sheetUpdates + effects）', () => {
  const script = makeScript(
    'events.js',
    `module.exports = {
      onEvent: function (ctx, event) {
        if (event.kind !== "damage/after") return {};
        return {
          sheetUpdates: { "card_foe": { "fields.alignment": "混乱" } },
          effects: [{ statusId: "poisoned", targetActorId: "card_foe", duration: 2 }],
          log: "事件钩子生效"
        };
      }
    };`,
  );
  const duel = setupDuel({ scripts: [script] });
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  expectOk(duel.runtime.applyDamage({ targetId: target, amount: 3 }));
  const foe = expectOk(duel.runtime.getActor('card_foe')).actor;
  assert.equal(foe.card.fields.alignment, '混乱');
  assert.ok(foe.effects.some((effect) => effect.statusId === 'poisoned'));
  assert.ok(foe.card.statuses.some((status) => status.id === 'poisoned'));
});

test('钩子：onEvent 内 ctx.sheet.set 允许（并进入卡）', () => {
  const script = makeScript(
    'events.js',
    `module.exports = {
      onEvent: function (ctx, event) {
        if (event.kind === "turn/start") ctx.sheet.set("fields.alignment", "守序");
        return {};
      }
    };`,
  );
  const duel = setupDuel({ scripts: [script] });
  const active = expectOk(duel.runtime.getActor(duel.activeId)).actor;
  assert.equal(active.card.fields.alignment, '守序');
});

test('钩子：resolveCheck 内 ctx.sheet.set 被拒绝 → rules/error + 回退', () => {
  const script = makeScript(
    'combat.js',
    'module.exports = { resolveCheck: function (ctx) { ctx.sheet.set("fields.alignment", "守序"); return { total: 1, success: false }; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  const collector = collectEvents(runtime);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 10 }));
  const error = collector.of('rules/error')[0];
  assert.ok(error !== undefined);
  assert.match(String(error.data.message), /ctx\.sheet\.set 仅在/);
});

test('钩子：onEvent 抛错时该事件的副作用整体回滚（规则日志不进状态）', () => {
  const script = makeScript(
    'events.js',
    `module.exports = {
      onEvent: function (ctx, event) {
        if (event.kind !== "damage/after") return {};
        ctx.effects.apply({ statusId: "poisoned", targetActorId: "card_foe", duration: 3 });
        ctx.resource.spend; // 占位：resource 归属在行动者上下文
        throw new Error("事件处理失败");
      }
    };`,
  );
  const duel = setupDuel({ scripts: [script] });
  const target = duel.activeId === 'card_hero' ? 'card_foe' : 'card_hero';
  const before = expectOk(duel.runtime.getActor(target)).actor;
  const hpBefore = hpOf(duel.runtime, target);
  const result = expectOk(duel.runtime.applyDamage({ targetId: target, amount: 4 }));
  // 伤害本身在 onEvent 之外落账，钩子里的效果被回滚
  assert.equal(result.amount, 4);
  assert.equal(hpOf(duel.runtime, target), hpBefore - 4);
  const after = expectOk(duel.runtime.getActor(target)).actor;
  assert.equal(after.effects.length, before.effects.length);
});

// ---------------------------------------------------------------------------
// onLevelUp / generateLoot
// ---------------------------------------------------------------------------

test('钩子：onLevelUp 缺省按 progression 发等级（xpTable）', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a', level: 1 }));
  const result = expectOk(runtime.levelUp({ actorId: 'card_a', xpGain: 300 }));
  assert.equal(result.fromLevel, 1);
  assert.equal(result.level, 3);
  assert.ok(result.gains.some((gain) => gain.atLevel === 2 && gain.skillPoints === 1));
  const actor = expectOk(runtime.getActor('card_a')).actor;
  assert.equal(actor.card.fields.level, 3);
});

test('钩子：onLevelUp 脚本返回自定义 patch（含枚举字段）', () => {
  const script = makeScript(
    'progression.js',
    'module.exports = { onLevelUp: function (ctx, req) { return { "fields.level": 2, "fields.alignment": "守序" }; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const result = expectOk(runtime.levelUp({ actorId: 'card_a', targetLevel: 2 }));
  assert.equal(result.usedHook, true);
  const actor = expectOk(runtime.getActor('card_a')).actor;
  assert.equal(actor.card.fields.level, 2);
  assert.equal(actor.card.fields.alignment, '守序');
});

test('钩子：generateLoot 缺省按 tables 掷表（同种子一致）', () => {
  const first = createRuntime({ roomSeed: 4242 });
  const second = createRuntime({ roomSeed: 4242 });
  const a = expectOk(first.resolveLoot({ tableId: 'loot.common' }));
  const b = expectOk(second.resolveLoot({ tableId: 'loot.common' }));
  assert.equal(a.items.length, 1);
  assert.deepEqual(a.items, b.items);
  assert.ok(['hengdao', 'huozhezi'].includes(a.items[0]!.itemId));
  assert.equal(a.usedHook, false);
});

test('钩子：generateLoot 脚本接管掉落', () => {
  const script = makeScript(
    'progression.js',
    'module.exports = { generateLoot: function () { return [{ itemId: "hengdao", name: "断刀", tags: ["weapon:melee"], stats: { "攻击": 1 } }]; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  const result = expectOk(runtime.resolveLoot({ tableId: 'loot.common' }));
  assert.equal(result.usedHook, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.name, '断刀');
  assert.equal(result.items[0]!.stats['攻击'], 1);
});

// ---------------------------------------------------------------------------
// 场地 / 时间钩子
// ---------------------------------------------------------------------------

test('钩子：computeDistance 脚本覆盖距离与档位', () => {
  const script = makeScript(
    'space.js',
    'module.exports = { computeDistance: function () { return { distance: 99, band: "far" }; } };',
  );
  const duel = setupDuel({ scripts: [script] });
  const result = expectOk(duel.runtime.computeDistance({ actorId: 'card_hero', targetId: 'card_foe' }));
  assert.equal(result.usedHook, true);
  assert.equal(result.distance, 99);
  assert.equal(result.band, 'far');
});

test('钩子：onMove 脚本可以否决移动（整体不落位）', () => {
  const script = makeScript(
    'space.js',
    'module.exports = { onMove: function () { return { ok: false, log: "脚本否决" }; } };',
  );
  const duel = setupDuel({ scripts: [script], attackerPosition: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  const activeId = duel.view.activeActorId ?? '';
  const active = expectOk(duel.runtime.getActor(activeId)).actor;
  const targetCell = active.position.cell?.x === 1 ? { x: 2, y: 3 } : { x: 1, y: 3 };
  const result = duel.runtime.move({ actorId: activeId, to: { cell: targetCell } });
  const error = expectErr(result);
  assert.equal(error.code, 'blocked');
  const after = expectOk(duel.runtime.getActor(activeId)).actor.position;
  assert.deepEqual(after, active.position);
});

test('钩子：onMove 脚本可覆盖剩余移动力', () => {
  const script = makeScript(
    'space.js',
    'module.exports = { onMove: function () { return { ok: true, remaining: 0 }; } };',
  );
  const runtime = createRuntime({ scripts: [script] });
  addActor(runtime, makeCard({ cardId: 'card_solo' }), { position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  const result = expectOk(runtime.move({ actorId: 'card_solo', to: { cell: { x: 2, y: 3 } } }));
  assert.equal(result.usedHook, true);
  assert.equal(result.remaining, 0);
});

test('钩子：onEnterZone / onLeaveZone 在跨区域移动时触发并挂效果', () => {
  const script = makeScript(
    'space.js',
    `module.exports = {
      onLeaveZone: function () { return { log: "离开" }; },
      onEnterZone: function (ctx, evt) { return { effects: [{ statusId: "poisoned", duration: 2 }] }; }
    };`,
  );
  const runtime = createRuntime({ scripts: [script] });
  addActor(runtime, makeCard({ cardId: 'card_solo' }), { team: 'player', position: { zoneId: 'town' } });
  const collector = collectEvents(runtime);
  const result = expectOk(runtime.move({ actorId: 'card_solo', to: { zoneId: 'cave' } }));
  assert.equal(result.to.zoneId, 'cave');
  assert.ok(collector.kinds().includes('zone/leave'));
  assert.ok(collector.kinds().includes('zone/enter'));
  const actor = expectOk(runtime.getActor('card_solo')).actor;
  assert.ok(actor.effects.some((effect) => effect.statusId === 'poisoned'));
});

test('钩子：computeCover 脚本覆盖掩体加成', () => {
  const script = makeScript(
    'space.js',
    'module.exports = { computeCover: function () { return { defenseBonus: 4, tags: ["宝箱"] }; } };',
  );
  const duel = setupDuel({ scripts: [script] });
  const result = expectOk(duel.runtime.computeCover({ actorId: 'card_hero', targetId: 'card_foe' }));
  assert.equal(result.usedHook, true);
  assert.equal(result.defenseBonus, 4);
  assert.deepEqual(result.tags, ['宝箱']);
});

test('钩子：onTimeAdvance 脚本接管时间推进（日志进 sink）', () => {
  const logs: RuntimeLogEntry[] = [];
  const script = makeScript(
    'time.js',
    'module.exports = { onTimeAdvance: function (ctx, req) { return { log: "从 " + req.from + " 到 " + req.to }; } };',
  );
  const runtime = createRuntime({ scripts: [script], logs });
  const result = expectOk(runtime.advanceTime({ rounds: 2, cause: 'gm' }));
  assert.equal(result.usedHook, true);
  assert.equal(result.to, result.from + 2);
  assert.ok(logs.some((entry) => entry.hook === 'onTimeAdvance' && entry.text.includes('从 1 到 3')));
});

test('钩子：onRoundStart / onRoundEnd 收到回合上下文（开战时写入日志）', () => {
  const logs: RuntimeLogEntry[] = [];
  const script = makeScript(
    'time.js',
    `module.exports = {
      onRoundStart: function (ctx, evt) { ctx.log("回合开始 " + evt.round); return {}; },
      onRoundEnd: function (ctx, evt) { ctx.log("回合结束 " + evt.round); return {}; }
    };`,
  );
  const runtime = createRuntime({ scripts: [script], logs });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { team: 'player' });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { team: 'enemy' });
  expectOk(runtime.startCombat({}));
  expectOk(runtime.endTurn({}));
  expectOk(runtime.endTurn({}));
  assert.ok(logs.some((entry) => entry.text === '回合开始 1'));
  assert.ok(logs.some((entry) => entry.text === '回合结束 1'));
  assert.ok(logs.some((entry) => entry.text === '回合开始 2'));
});

// ---------------------------------------------------------------------------
// ctx 能力 / 连续失败降级 / 完整性 / 超时
// ---------------------------------------------------------------------------

test('钩子：ctx.attr / derived / resource / equipment / rng 能力齐备', () => {
  const script = makeScript(
    'ctx.js',
    `module.exports = {
      resolveCheck: function (ctx, req) {
        var first = ctx.roll("1d20");
        var second = ctx.roll("1d20");
        return {
          total: ctx.attr("str") + ctx.derived("mod.str") + ctx.resource.get("hp")
            + ctx.equipment.stats("攻击") + first.total + second.total,
          success: true,
          log: "rng=" + (ctx.rng() >= 0 && ctx.rng() < 1)
        };
      }
    };`,
  );
  const duel = setupDuel({ scripts: [script] });
  const result = expectOk(duel.runtime.rollCheck({ actorId: 'card_hero', dc: 1 }));
  assert.equal(result.usedHook, true);
  // 属性 17 + 无派生 0 + HP 20 + 装备攻击 0（卡无装备）+ 两掷 d20 合计
  assert.ok(result.total >= 17 + 20 + 2 && result.total <= 17 + 20 + 40);
  assert.ok(result.rolls.length >= 2);
  assert.match(result.trace.lines.join(' '), /rng=true/);
});

test('钩子：同一种子下 ctx.roll 骰面可复现', () => {
  const script = makeScript(
    'ctx.js',
    'module.exports = { resolveCheck: function (ctx) { var r = ctx.roll("2d6"); return { total: r.total, success: true, log: JSON.stringify(r.dice) }; } };',
  );
  const first = createRuntime({ roomSeed: 91, scripts: [script] });
  const second = createRuntime({ roomSeed: 91, scripts: [script] });
  addActor(first, makeCard({ cardId: 'card_a' }));
  addActor(second, makeCard({ cardId: 'card_a' }));
  const a = expectOk(first.rollCheck({ actorId: 'card_a', dc: 5 }));
  const b = expectOk(second.rollCheck({ actorId: 'card_a', dc: 5 }));
  assert.equal(a.total, b.total);
  assert.equal(a.trace.lines[0], b.trace.lines[0]);
});

test('钩子：连续 3 次失败后降级并停用该钩子', () => {
  const script = makeScript(
    'combat.js',
    'module.exports = { resolveCheck: function () { throw new Error("总是失败"); } };',
  );
  const runtime = createRuntime({ scripts: [script], failureThreshold: 3 });
  const collector = collectEvents(runtime);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  for (let index = 0; index < 3; index += 1) expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 5 }));
  const errors = collector.of('rules/error');
  const degraded = errors.find((event) => event.data.degraded === true);
  assert.ok(degraded !== undefined, '应产生 degraded 标记');
  assert.equal(runtime.listHooks().includes('resolveCheck'), false);
  // 降级后继续走缺省行为
  const after = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 5 }));
  assert.equal(after.usedHook, false);
});

test('完整性：规则包声明脚本但未提供 → 拒绝创建运行时', () => {
  const script = makeScript('combat.js', 'module.exports = { resolveCheck: function () { return { total: 1, success: true }; } };');
  const pack: RulePack = withPack((current) => attachScripts(current, script, ['resolveCheck']));
  assert.throws(
    () => createRuleRuntime({ rules: pack, roomSeed: 1, scripts: [] }),
    (error: unknown) => error instanceof RuleRuntimeError && error.code === 'script_integrity',
  );
});

test('完整性：脚本内容 sha256 与清单不符 → 拒绝创建运行时', () => {
  const script = makeScript('combat.js', 'module.exports = { resolveCheck: function () { return { total: 1, success: true }; } };');
  const pack: RulePack = withPack((current) => attachScripts(current, script, ['resolveCheck']));
  const tampered = { ...script, sha256: 'f'.repeat(64) };
  assert.throws(
    () => createRuleRuntime({ rules: pack, roomSeed: 1, scripts: [tampered] }),
    (error: unknown) => error instanceof RuleRuntimeError && error.code === 'script_integrity',
  );
});

test('超时：钩子死循环 → rules/error(timeout) + 回退缺省行为', () => {
  const script = makeScript('combat.js', 'module.exports = { resolveCheck: function () { while (true) {} } };');
  const runtime = createRuntime({ scripts: [script], timeoutMs: 50 });
  const collector = collectEvents(runtime);
  addActor(runtime, makeCard({ cardId: 'card_a' }));
  const result = expectOk(runtime.rollCheck({ actorId: 'card_a', dc: 5 }));
  assert.equal(result.usedHook, false);
  const timeout = collector.of('rules/error').find((event) => event.data.kind === 'timeout');
  assert.ok(timeout !== undefined);
  assert.match(String(timeout.data.message), /超时/);
});

test('钩子：ctx.effects.apply + remove 成对操作生效', () => {
  const script = makeScript(
    'events.js',
    `module.exports = {
      onEvent: function (ctx, event) {
        if (event.kind !== "turn/start") return {};
        ctx.effects.apply({ statusId: "poisoned", duration: 3 });
        ctx.effects.remove("poisoned");
        return {};
      }
    };`,
  );
  const duel = setupDuel({ scripts: [script] });
  const actor = expectOk(duel.runtime.getActor(duel.activeId)).actor;
  assert.equal(actor.effects.some((effect) => effect.statusId === 'poisoned'), false);
});

test('钩子：ctx.tables.pick 用种子掷表并可复现', () => {
  const script = makeScript(
    'loot.js',
    `module.exports = {
      generateLoot: function (ctx) {
        var pick = ctx.tables.pick("loot.common");
        return [{ itemId: "hengdao", name: "表结果 " + pick.roll.total }];
      }
    };`,
  );
  const first = createRuntime({ roomSeed: 55, scripts: [script] });
  const second = createRuntime({ roomSeed: 55, scripts: [script] });
  const a = expectOk(first.resolveLoot({ tableId: 'loot.common' }));
  const b = expectOk(second.resolveLoot({ tableId: 'loot.common' }));
  assert.equal(a.items[0]!.name, b.items[0]!.name);
  assert.match(a.items[0]!.name, /^表结果 \d+$/);
});
