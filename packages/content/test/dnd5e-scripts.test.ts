/**
 * dnd5e-lite 四个规则脚本（`rules/scripts/*.js`）的钩子行为测试（M9.3）。
 *
 * 与 `dnd5e-rules-parity.test.ts` 的分工：parity 只做「旧 engine vs 新规则包」的数值对照；
 * 本文件验证钩子本身的行为（加载/校验/派生/检定/攻击/伤害/事件/升级/掉落/turn 数据/错误边界）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuleRuntime, type ActorView, type CheckResultData, type RuleResult, type RuleRuntime } from '@dsh-trpg/rules/runtime';
import type { CardInstance } from '../src/rules-bridge.ts';
import { DND5E_LITE_RULES, DND5E_LITE_SCRIPT_SOURCES } from '../src/rules-pack/index.ts';
import { PRESET_HEROES, engineCard, toRulesCard } from './dnd5e-fixtures.ts';

const SEED = 20261116;

function newRuntime(seed = SEED): RuleRuntime {
  return createRuleRuntime({ rules: DND5E_LITE_RULES, roomSeed: seed, scripts: DND5E_LITE_SCRIPT_SOURCES });
}

/** 断言 `RuleResult` 成功并取出载荷（失败时把中文错误带进断言信息）。 */
function expectOk<T>(result: RuleResult<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  return result as unknown as T;
}

function heroOf(index: number): { engineCard: (typeof PRESET_HEROES)[number]['engine']; rulesCard: CardInstance } {
  const hero = PRESET_HEROES[index] as (typeof PRESET_HEROES)[number];
  return { engineCard: hero.engine, rulesCard: hero.rules };
}

/** 加一名预置角色，返回 actorId。 */
function addHero(runtime: RuleRuntime, index = 0, team: 'player' | 'enemy' = 'player'): string {
  const { rulesCard } = heroOf(index);
  expectOk(runtime.addActor({ card: rulesCard, team }));
  return rulesCard.cardId;
}

function hpOf(runtime: RuleRuntime, actorId: string): number {
  const projection = expectOk(runtime.getSheet(actorId)).projection;
  return projection.resources.find((resource) => resource.id === 'hp')?.current ?? -1;
}

// ---------------------------------------------------------------------------
// 脚本加载
// ---------------------------------------------------------------------------

test('脚本：运行时加载 8 个核心钩子（4 个脚本文件全部通过完整性校验）', () => {
  const runtime = newRuntime();
  assert.deepEqual(runtime.listHooks().sort(), [
    'computeDerived',
    'generateLoot',
    'onEvent',
    'onLevelUp',
    'resolveAttack',
    'resolveCheck',
    'resolveDamage',
    'validateSheet',
  ]);
  assert.equal(runtime.scriptReports.length, 4);
  for (const report of runtime.scriptReports) {
    assert.equal(report.ok, true, `${report.file} 应加载成功`);
    assert.equal(report.missingHooks, undefined, `${report.file} 声明的钩子应全部导出`);
    assert.match(report.sha256, /^[a-f0-9]{64}$/u);
  }
});

test('脚本：sha256 与清单不符 → 拒绝创建运行时（script_integrity）', () => {
  const tampered = DND5E_LITE_SCRIPT_SOURCES.map((source) =>
    source.file.endsWith('combat.js') ? { ...source, sha256: 'a'.repeat(64) } : source,
  );
  assert.throws(
    () => createRuleRuntime({ rules: DND5E_LITE_RULES, roomSeed: SEED, scripts: tampered }),
    (error: unknown) => error instanceof Error && /sha256/u.test(error.message),
  );
});

test('脚本：缺少声明文件 → 拒绝创建运行时', () => {
  const missing = DND5E_LITE_SCRIPT_SOURCES.filter((source) => !source.file.endsWith('events.js'));
  assert.throws(
    () => createRuleRuntime({ rules: DND5E_LITE_RULES, roomSeed: SEED, scripts: missing }),
    (error: unknown) => error instanceof Error && /未提供|拒绝加载/u.test(error.message),
  );
});

test('脚本：规则包没有 scripts 声明时，运行时退回缺省行为（不用规则脚本也能跑）', () => {
  const rulesWithoutScripts = { ...DND5E_LITE_RULES, scripts: undefined };
  const runtime = createRuleRuntime({ rules: rulesWithoutScripts, roomSeed: SEED });
  assert.deepEqual(runtime.listHooks(), []);
  const heroId = addHero(runtime);
  const result = expectOk(runtime.rollCheck({ actorId: heroId, dc: 5 }));
  assert.equal(result.usedHook, false, '无脚本时应走内核缺省检定');
  assert.ok(result.total > 0);
});

// ---------------------------------------------------------------------------
// validateSheet / computeDerived
// ---------------------------------------------------------------------------

test('脚本：computeDerived 产出六属性调整值 / HP 上限 / 两环法术位上限', () => {
  const runtime = newRuntime();
  const { engineCard: engine, rulesCard } = heroOf(3); // 苏九：2 级术士，两环法术位都有
  expectOk(runtime.addActor({ card: rulesCard }));
  const derived = expectOk(runtime.getDerived(rulesCard.cardId)).derived;
  assert.equal(derived['mod.str'], Math.floor((engine.abilities.str - 10) / 2));
  assert.equal(derived['mod.cha'], Math.floor((engine.abilities.cha - 10) / 2));
  assert.equal(derived.hpMax, engine.combat.hpMax, 'HP 上限口径应与旧卡一致');
  assert.equal(derived.slot1Max, engine.spells?.slots['1'], '一环法术位上限');
  assert.equal(derived.slot2Max, engine.spells?.slots['2'], '二环法术位上限');
});

test('脚本：validateSheet 拒绝等级越界的卡（1–20）', () => {
  const runtime = newRuntime();
  const { rulesCard } = heroOf(0);
  const broken: CardInstance = { ...rulesCard, fields: { ...rulesCard.fields, level: 25 } };
  const result = runtime.addActor({ card: broken });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.messageZh, /等级/u);
  assert.equal(runtime.listActors().length, 0, '校验失败的卡不应留在运行时');
});

test('脚本：validateSheet 接受合法卡（4 张预置卡全部落座成功）', () => {
  const runtime = newRuntime();
  for (let index = 0; index < PRESET_HEROES.length; index += 1) {
    const { rulesCard } = heroOf(index);
    const added = runtime.addActor({ card: rulesCard, team: 'player' });
    assert.equal(added.ok, true, added.ok ? '' : JSON.stringify(added.error));
  }
  assert.equal(runtime.listActors().length, 4);
});

// ---------------------------------------------------------------------------
// 检定 / 攻击 / 伤害 / turn
// ---------------------------------------------------------------------------

test('脚本：resolveCheck 在 DC 高于总值时判失败并给出 degree=fail', () => {
  const runtime = newRuntime(4321);
  const heroId = addHero(runtime);
  let failed: CheckResultData | undefined;
  for (let attempt = 0; attempt < 100 && failed === undefined; attempt += 1) {
    const result = expectOk(runtime.rollCheck({ actorId: heroId, skillId: 'athletics', dc: 30 }));
    assert.equal(result.usedHook, true);
    if (!result.success) failed = result;
  }
  assert.ok(failed, 'DC 30 应能掷出失败');
  assert.equal(failed.degree, 'fail');
});

test('脚本：resolveAttack 命中后产生伤害，本回合再用动作被行动经济拒绝', () => {
  const runtime = newRuntime(123456);
  const heroId = addHero(runtime);
  const dummyEngine = engineCard({
    id: 'dummy',
    name: '木桩',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hpMax: 60,
    ac: 5,
  });
  const dummy = toRulesCard(dummyEngine, {
    fields: { hitDie: 10 },
    resources: { hp: { current: 60 }, slot1: { current: 0 }, slot2: { current: 0 } },
    skills: [],
  });
  expectOk(runtime.addActor({ card: dummy, actorId: 'dummy', team: 'enemy' }));
  const actorBefore = expectOk(runtime.getActor(heroId)).actor as ActorView;
  assert.equal(actorBefore.turn.action, 1, '战斗外动作资源应已回满');

  const result = expectOk(runtime.useAction({ actorId: heroId, actionId: 'attack.melee', targetId: 'dummy' }));
  assert.equal(result.usedHook, true, 'resolveAttack 钩子应生效');
  assert.ok(result.rolls.length >= 1, '应记录攻击骰');
  if (result.hit === true) {
    assert.ok((result.damage?.amount ?? 0) > 0, '命中应产生伤害');
  } else {
    assert.equal(result.damage, undefined, '未命中不应结算伤害');
  }

  const second = runtime.useAction({ actorId: heroId, actionId: 'attack.melee', targetId: 'dummy' });
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error.messageZh, /动作不足|已经用过动作/u);
});

test('脚本：resolveDamage 默认不做减伤（伤害原样落账）', () => {
  const runtime = newRuntime(7);
  const heroId = addHero(runtime);
  const result = expectOk(runtime.applyDamage({ targetId: heroId, amount: 4 }));
  assert.equal(result.amount, 4);
  assert.deepEqual(result.consumedEffects, []);
  assert.equal(result.usedHook, true, 'resolveDamage 钩子应生效');
});

test('脚本：turn 数据生效（每回合动作/附赠/反应各 1 次、移动力 6 格）', () => {
  const runtime = newRuntime(29);
  const heroId = addHero(runtime);
  const actor = expectOk(runtime.getActor(heroId)).actor as ActorView;
  assert.deepEqual(actor.turn, { action: 1, bonus: 1, reaction: 1, movement: 6 });
});

// ---------------------------------------------------------------------------
// onEvent（状态 tick / 倒地）
// ---------------------------------------------------------------------------

test('脚本：onEvent 在回合开始结算中毒（1 点毒伤）', () => {
  const runtime = newRuntime(9);
  const { rulesCard } = heroOf(0);
  const poisoned: CardInstance = { ...rulesCard, statuses: [{ id: 'poisoned', stacks: 1, remaining: 3 }] };
  expectOk(runtime.addActor({ card: poisoned, actorId: 'poisoned_hero', team: 'player' }));
  expectOk(runtime.addActor({ card: heroOf(1).rulesCard, actorId: 'other', team: 'enemy' }));
  const hpBefore = hpOf(runtime, 'poisoned_hero');
  expectOk(runtime.startCombat({}));
  for (let step = 0; step < 10 && runtime.getCombat().activeActorId !== 'poisoned_hero'; step += 1) {
    runtime.endTurn({});
  }
  assert.equal(runtime.getCombat().activeActorId, 'poisoned_hero', '应轮到中毒角色');
  const turnEvents = runtime.recentEvents(60).filter((event) => event.kind === 'turn/start');
  assert.ok(
    turnEvents.some((event) => event.data.actorId === 'poisoned_hero'),
    '应收到中毒角色的回合开始事件',
  );
  assert.equal(hpOf(runtime, 'poisoned_hero'), hpBefore - 1, '中毒回合开始应受 1 点毒伤');
});

test('脚本：onEvent 在 HP 归零时挂「倒地/失能」永久状态', () => {
  const runtime = newRuntime(11);
  const { rulesCard } = heroOf(0);
  expectOk(runtime.addActor({ card: rulesCard }));
  expectOk(runtime.applyDamage({ targetId: rulesCard.cardId, amount: 999 }));
  const actor = expectOk(runtime.getActor(rulesCard.cardId)).actor;
  const prone = actor.effects.find((effect) => effect.statusId === 'prone');
  const incapacitated = actor.effects.find((effect) => effect.statusId === 'incapacitated');
  assert.ok(prone, '应挂倒地');
  assert.ok(incapacitated, '应挂失能');
  assert.equal(prone?.remaining, -1, '倒地应为永久（-1 不 tick）');
  assert.equal(incapacitated?.remaining, -1);
});

// ---------------------------------------------------------------------------
// onLevelUp / generateLoot
// ---------------------------------------------------------------------------

test('脚本：onLevelUp 写等级并累加技能点（按 progression.grants）', () => {
  const runtime = newRuntime(13);
  const heroId = addHero(runtime);
  const result = expectOk(runtime.levelUp({ actorId: heroId, xpGain: 1000 }));
  assert.equal(result.level, 5, '1000 XP 对应 5 级');
  assert.equal(result.usedHook, true);
  assert.equal(result.patch['level'], 5);
  assert.equal(result.patch['fields.skillPoints'], 4, '2/3 级各 1 点、5 级 2 点 → 共 4 点');
  const actor = expectOk(runtime.getActor(heroId)).actor;
  assert.equal(actor.card.fields.level, 5);
  assert.equal(actor.card.fields.skillPoints, 4);
});

test('脚本：onLevelUp 不超过 progression.maxLevel（10 级封顶）', () => {
  const runtime = newRuntime(17);
  const heroId = addHero(runtime);
  const result = expectOk(runtime.levelUp({ actorId: heroId, xpGain: 999999 }));
  assert.equal(result.level, 10);
});

test('脚本：generateLoot 按掉落表产出物品实例（名称由 rules.items[] 补全）', () => {
  const runtime = newRuntime(19);
  const loot = expectOk(runtime.resolveLoot({ tableId: 'loot.common', count: 2 }));
  assert.equal(loot.usedHook, true, 'generateLoot 钩子应生效');
  assert.equal(loot.tableId, 'loot.common');
  assert.equal(loot.items.length, 2);
  for (const item of loot.items) {
    assert.ok(item.instanceId.length > 0);
    const def = (DND5E_LITE_RULES.items ?? []).find((entry) => entry.itemId === item.itemId);
    assert.ok(def, `掉落物品 ${item.itemId} 应在 rules.items[] 中`);
    assert.equal(item.name, def.name);
  }
});

test('脚本：generateLoot 用房间种子掷表，同 seed 结果可复现', () => {
  const first = expectOk(newRuntime(23).resolveLoot({ count: 3 }));
  const second = expectOk(newRuntime(23).resolveLoot({ count: 3 }));
  assert.deepEqual(
    second.items.map((item) => item.itemId),
    first.items.map((item) => item.itemId),
  );
});
