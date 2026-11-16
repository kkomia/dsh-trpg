/**
 * dnd5e-lite 数值对照测试：**旧 `@dsh-trpg/engine` 实现 vs 新规则包（`@dsh-trpg/rules` 运行时）**。
 *
 * 对照方法（docs/RULES-MODEL §11.1「每实现一个就把对应旧 engine 测试改为经规则包执行，断言不变」）：
 * 1. **非随机部分逐项相等**：属性调整值 / 熟练加值 / 技能总加值 / HP 上限 / 法术位上限 / AC / 先攻加值，
 *    一侧用 `@dsh-trpg/engine` 的导出函数（`abilityMod` / `proficiencyBonus` / `skillBonus` …）+ 旧卡数据，
 *    另一侧用规则运行时投影/钩子结果，`assert.equal` 直接比较。
 * 2. **随机部分用「注入固定骰面」重放**：先让新运行时掷骰（种子化、结果记录在 `rolls`/`trace` 里），
 *    再把同一批骰面喂给旧 engine 的 `attack` / `rollCheck` / `rollSkillCheck`（`replayRng`），
 *    此时两边消耗的骰子完全一致，命中/暴击/总值/伤害可以要求**严格相等**；
 *    同时断言重放 RNG 的消耗次数 = 掷骰次数（保证两套实现随机流对齐）。
 * 3. **可复现性**：同一 `roomSeed` + 同一调用顺序 → 同一骰面与总值。
 *
 * 旧卡 → 新卡的映射见 `dnd5e-fixtures.ts`（职业生命骰、装备实例、法术位分环）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_ABILITY,
  SKILL_NAME,
  abilityMod,
  applyDamage as engineApplyDamage,
  attack as engineAttack,
  proficiencyBonus,
  rollCheck as engineRollCheck,
  rollSkillCheck,
  skillBonus,
  type Ability,
  type CharacterCard,
  type SkillId,
} from '@dsh-trpg/engine';
import { createRuleRuntime, type ActionResultData, type CheckResultData, type RuleRuntime, type RuleResult } from '@dsh-trpg/rules/runtime';
import { DND5E_LITE_RULES, DND5E_LITE_SCRIPT_SOURCES } from '../src/rules-pack/index.ts';
import {
  PRESET_HEROES,
  diceFacesOf,
  engineCard,
  engineCombatant,
  engineCombatState,
  replayRng,
  toRulesCard,
  type ToRulesCardOptions,
} from './dnd5e-fixtures.ts';

const ABILITIES: readonly Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SEED = 20261116;

function newRuntime(seed = SEED): RuleRuntime {
  return createRuleRuntime({ rules: DND5E_LITE_RULES, roomSeed: seed, scripts: DND5E_LITE_SCRIPT_SOURCES });
}

/** 断言 `RuleResult` 成功并取出载荷（失败时把中文错误带进断言信息）。 */
function expectOk<T extends object>(result: RuleResult<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.error));
  return result as unknown as T;
}

function attackTraceOf(result: ActionResultData): Record<string, unknown> {
  const trace = result.trace?.data?.attack;
  assert.ok(trace !== undefined && typeof trace === 'object', '动作结果应带 trace.data.attack');
  return trace as Record<string, unknown>;
}

function addHeroes(runtime: RuleRuntime, team: 'player' | 'enemy' = 'player'): void {
  for (const hero of PRESET_HEROES) expectOk(runtime.addActor({ card: hero.rules, team }));
}

/** 合成一张新模型卡（测试边界用）：默认 14/14/14/10/10/10、1 级、生命骰 d10。 */
function syntheticRulesCard(
  cardId: string,
  options: ToRulesCardOptions & { level?: number; attacksProficient?: string[] } = {},
) {
  const level = options.level ?? 1;
  const base = engineCard({
    id: cardId,
    name: cardId,
    level,
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    hpMax: 10 + abilityMod(14) + (level - 1) * 5,
    ac: 10 + abilityMod(14),
    attacks: [{ name: '拳', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' }],
  });
  return toRulesCard(base, options);
}

// ---------------------------------------------------------------------------
// 派生数值
// ---------------------------------------------------------------------------

test('对照：属性调整值（4 张预置卡 × 6 属性）逐项等于 engine abilityMod', () => {
  const runtime = newRuntime();
  addHeroes(runtime);
  let compared = 0;
  for (const hero of PRESET_HEROES) {
    const derived = expectOk(runtime.getDerived(hero.rules.cardId)).derived;
    for (const ability of ABILITIES) {
      assert.equal(
        derived[`mod.${ability}`],
        abilityMod(hero.engine.abilities[ability]),
        `${hero.engine.identity.name} 的 ${ability} 调整值应与 engine abilityMod 一致`,
      );
      compared += 1;
    }
  }
  assert.equal(compared, 24, '应对照 4 张卡 × 6 属性');
});

test('对照：HP 上限 / 法术位上限（旧卡 combat.hpMax 与 spells.slots 逐项一致）', () => {
  const runtime = newRuntime();
  addHeroes(runtime);
  for (const hero of PRESET_HEROES) {
    const projection = expectOk(runtime.getSheet(hero.rules.cardId)).projection;
    const name = hero.engine.identity.name;
    const hp = projection.resources.find((resource) => resource.id === 'hp');
    assert.equal(hp?.max, hero.engine.combat.hpMax, `${name} 的 HP 上限应等于旧卡 combat.hpMax`);
    const legacySlots = hero.engine.spells?.slots ?? {};
    const slot1 = projection.resources.find((resource) => resource.id === 'slot1');
    const slot2 = projection.resources.find((resource) => resource.id === 'slot2');
    assert.equal(slot1?.max, legacySlots['1'] ?? 0, `${name} 的一环法术位上限`);
    assert.equal(slot2?.max, legacySlots['2'] ?? 0, `${name} 的二环法术位上限`);
    assert.deepEqual(projection.warnings, [], `${name} 的投影不应有降级 warning`);
  }
});

test('对照：技能列表与 engine 的 18 项技能 id/中文名完全一致', () => {
  const declared = DND5E_LITE_RULES.sheet.skills;
  assert.equal(declared.length, Object.keys(SKILL_ABILITY).length, '技能数量应等于 engine');
  for (const skill of declared) {
    const id = skill.id as SkillId;
    assert.equal(skill.name, SKILL_NAME[id], `技能 ${skill.id} 的中文名`);
    assert.equal(skill.attribute, SKILL_ABILITY[id], `技能 ${skill.id} 的关联属性`);
  }
  assert.deepEqual(
    declared.map((skill) => skill.id).sort(),
    Object.keys(SKILL_ABILITY).sort(),
    '技能 id 集合应与 engine SKILL_ABILITY 一致',
  );
});

test('对照：18 项技能总加值（4 张预置卡 × 18 技能）等于 engine skillBonus', () => {
  const runtime = newRuntime();
  addHeroes(runtime);
  let compared = 0;
  for (const hero of PRESET_HEROES) {
    const projection = expectOk(runtime.getSheet(hero.rules.cardId)).projection;
    const profile = {
      proficiency: hero.engine.proficiency.bonus,
      skills: hero.engine.proficiency.skills,
      saves: hero.engine.proficiency.saves,
    };
    for (const skill of Object.keys(SKILL_ABILITY) as SkillId[]) {
      const projected = projection.skills.find((entry) => entry.id === skill);
      assert.ok(projected, `投影缺少技能 ${skill}`);
      assert.equal(
        projected.total,
        skillBonus(profile, hero.engine.abilities, skill),
        `${hero.engine.identity.name} 的 ${SKILL_NAME[skill]} 总加值`,
      );
      compared += 1;
    }
  }
  assert.equal(compared, 4 * 18, '应对照 4 张卡 × 18 技能');
});

test('对照：熟练加值随等级（1–20）与 engine proficiencyBonus 一致', () => {
  const runtime = newRuntime();
  const levels = [1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 16, 17, 20];
  for (const level of levels) {
    const card = syntheticRulesCard(`lv_${level}`, {
      level,
      skills: [
        { id: 'athletics', proficient: true, bonus: 0 },
        { id: 'stealth', proficient: false, bonus: 0 },
      ],
    });
    expectOk(runtime.addActor({ card }));
    const projection = expectOk(runtime.getSheet(card.cardId)).projection;
    const dexMod = abilityMod(14);
    const athletics = projection.skills.find((entry) => entry.id === 'athletics');
    const stealth = projection.skills.find((entry) => entry.id === 'stealth');
    assert.equal(athletics?.total, dexMod + proficiencyBonus(level), `Lv${level} 熟练运动总加值`);
    assert.equal(stealth?.total, dexMod, `Lv${level} 非熟练隐匿总加值`);
  }
});

// ---------------------------------------------------------------------------
// AC / 先攻 / 攻击（同骰面重放）
// ---------------------------------------------------------------------------

/** 预置卡 → 攻击木桩用的动作/旧卡攻击档案（按关联属性一一对应）。 */
const HERO_ATTACKS: Readonly<Record<string, { actionId: string; profileName: string; ability: Ability }>> = {
  card_aqing: { actionId: 'attack.melee', profileName: '横刀', ability: 'str' },
  card_bailu: { actionId: 'attack.ranged', profileName: '柳叶刀', ability: 'dex' },
  card_sujiu: { actionId: 'attack.lingfu', profileName: '灵符', ability: 'cha' },
  card_xuanzhen: { actionId: 'attack.taomu', profileName: '桃木剑', ability: 'wis' },
};

/** 攻击木桩（旧卡 HP 很高，保证 4 名角色各打一次不会提前打死）。 */
const DUMMY_ENGINE_CARD: CharacterCard = engineCard({
  id: 'dummy',
  name: '木桩',
  level: 10,
  class: '木桩',
  abilities: { str: 10, dex: 10, con: 12, int: 8, wis: 8, cha: 8 },
  hpMax: 111,
  ac: 12,
  attacks: [{ name: '拳', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' }],
});

const DUMMY_RULES_CARD = toRulesCard(DUMMY_ENGINE_CARD, {
  level: 10,
  fields: { hitDie: 20 },
  resources: { hp: { current: 111 }, slot1: { current: 0 }, slot2: { current: 0 } },
  equipmentInstances: [{ instanceId: 'ins_dummy', slot: 'body', name: '铁甲', tags: ['armor'], stats: { 防御: 2 } }],
  skills: [],
});

test('对照：AC（10 + 敏捷调整 + 装备防御）与先攻加值，逐项等于旧卡数据', () => {
  const runtime = newRuntime();
  // 探针：力量 16、敏捷 10、穿「防御 2」护甲 → AC 应为 10 + 0 + 2 = 12
  const proberCard = syntheticRulesCard('prober', {
    attributes: { str: 16, dex: 10, con: 14 },
    equipmentInstances: [{ instanceId: 'ins_prober', slot: 'body', name: '铁甲', tags: ['armor'], stats: { 防御: 2 } }],
    resources: { hp: { current: 20 }, slot1: { current: 0 }, slot2: { current: 0 } },
  });
  expectOk(runtime.addActor({ card: proberCard, actorId: 'prober', team: 'player' }));
  addHeroes(runtime, 'enemy');
  const proberEngine = engineCard({
    id: 'prober',
    name: '探针',
    abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 10 },
    hpMax: 20,
    ac: 12,
    attacks: [{ name: '拳', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' }],
  });
  const heroesById = new Map(PRESET_HEROES.map((hero) => [hero.engine.id, hero.engine]));

  const started = expectOk(runtime.startCombat({}));
  // 先攻加值 = 先攻总值 - d20；应等于旧卡 initiativeBonus（未指定则 dex 调整）
  for (const entry of started.view.order) {
    const legacy = entry.actorId === 'prober' ? proberEngine : heroesById.get(entry.actorId);
    assert.ok(legacy, `未知参战者 ${entry.actorId}`);
    const expected = legacy.combat.initiativeBonus ?? abilityMod(legacy.abilities.dex);
    assert.equal(entry.initiative - entry.roll, expected, `${legacy.identity.name} 的先攻加值`);
  }

  const pending = new Set(PRESET_HEROES.map((hero) => hero.engine.id));
  let attackCount = 0;
  for (let step = 0; step < 300 && pending.size > 0; step += 1) {
    const active = runtime.getCombat().activeActorId;
    if (active === 'prober') {
      const targetId = [...pending][0] as string;
      const targetEngine = heroesById.get(targetId) as CharacterCard;
      const result = expectOk(runtime.useAction({ actorId: 'prober', actionId: 'attack.melee', targetId }));
      const trace = attackTraceOf(result);
      // AC 对照：规则公式算出的 defense 必须等于旧卡 combat.ac
      assert.equal(trace.defense, targetEngine.combat.ac, `${targetEngine.identity.name} 的 AC 应与旧卡一致`);

      const faces = diceFacesOf(result.rolls);
      const rng = replayRng(faces);
      const engineState = engineCombatState(engineCombatant(proberEngine, 'prober'), engineCombatant(targetEngine, targetId));
      const legacy = engineAttack(engineState, { attackerId: 'prober', targetId, attackName: '拳' }, rng);
      assert.equal(legacy.d20, trace.d20, `${targetEngine.identity.name}：同一骰面下 d20`);
      assert.equal(legacy.total, trace.total, `${targetEngine.identity.name}：命中总值`);
      assert.equal(legacy.hit, result.hit, `${targetEngine.identity.name}：命中判定`);
      assert.equal(legacy.critical, result.crit, `${targetEngine.identity.name}：暴击判定`);
      assert.equal(legacy.targetAc, trace.defense, `${targetEngine.identity.name}：engine 看到的目标 AC`);
      assert.equal(legacy.damage, result.damage?.amount ?? 0, `${targetEngine.identity.name}：伤害值`);
      assert.equal(rng.consumed(), faces.length, '重放应恰好消耗新运行时记录的骰面');
      pending.delete(targetId);
      attackCount += 1;
    }
    runtime.endTurn({});
  }
  assert.equal(pending.size, 0, '4 张预置卡都应被攻击到一次');
  assert.equal(attackCount, 4);
});

test('对照：命中加值 / 伤害（4 张预置卡攻击同一木桩，同骰面重放逐项相等）', () => {
  const runtime = newRuntime(778899);
  addHeroes(runtime, 'player');
  expectOk(runtime.addActor({ card: DUMMY_RULES_CARD, actorId: 'dummy', team: 'enemy' }));
  const dummyEngine = engineCombatant(DUMMY_ENGINE_CARD, 'dummy');
  const heroById = new Map(PRESET_HEROES.map((hero) => [hero.engine.id, hero.engine]));
  expectOk(runtime.startCombat({}));

  const pending = new Set(PRESET_HEROES.map((hero) => hero.engine.id));
  for (let step = 0; step < 300 && pending.size > 0; step += 1) {
    const active = runtime.getCombat().activeActorId;
    if (active !== null && pending.has(active)) {
      const heroEngine = heroById.get(active) as CharacterCard;
      const attack = HERO_ATTACKS[active] as { actionId: string; profileName: string; ability: Ability };
      const result = expectOk(runtime.useAction({ actorId: active, actionId: attack.actionId, targetId: 'dummy' }));
      const trace = attackTraceOf(result);
      const faces = diceFacesOf(result.rolls);
      const rng = replayRng(faces);
      const engineState = engineCombatState(engineCombatant(heroEngine, active), engineCombatant(DUMMY_ENGINE_CARD, 'dummy'));
      const legacy = engineAttack(engineState, { attackerId: active, targetId: 'dummy', attackName: attack.profileName }, rng);

      assert.equal(trace.attackBonus, legacy.attackBonus, `${heroEngine.identity.name} 的命中加值（ability=${attack.ability}）`);
      assert.equal(legacy.d20, trace.d20, `${heroEngine.identity.name} 的 d20`);
      assert.equal(legacy.total, trace.total, `${heroEngine.identity.name} 的命中总值`);
      assert.equal(legacy.hit, result.hit, `${heroEngine.identity.name} 的命中判定`);
      assert.equal(legacy.critical, result.crit, `${heroEngine.identity.name} 的暴击判定`);
      assert.equal(legacy.damage, result.damage?.amount ?? 0, `${heroEngine.identity.name} 的伤害值`);
      assert.equal(legacy.targetAc, trace.defense, '目标 AC 由同一公式算出');
      assert.equal(rng.consumed(), faces.length, `${heroEngine.identity.name} 的重放骰面数应一致`);
      // 伤害构成：骰面合计 + engine abilityMod(关联属性)（本规则包凡俗武器 equip.攻击=0）
      const damageDiceTotal = result.rolls.slice(1).reduce((sum, roll) => sum + roll.dice.reduce((inner, die) => inner + die, 0), 0);
      const abilityDamage = abilityMod(heroEngine.abilities[attack.ability]);
      const expectedDamage = result.hit === true
        ? Math.max(0, (result.crit === true ? damageDiceTotal * 2 : damageDiceTotal) + abilityDamage)
        : 0;
      assert.equal(result.damage?.amount ?? 0, expectedDamage, `${heroEngine.identity.name} 的伤害 = 伤害骰 + 属性调整`);
      pending.delete(active);
    }
    runtime.endTurn({});
  }
  assert.equal(pending.size, 0, '4 名角色都应完成一次攻击');
});

// ---------------------------------------------------------------------------
// 检定
// ---------------------------------------------------------------------------

test('对照：技能检定（同骰面重放 + 优势/劣势）与 engine rollSkillCheck 一致', () => {
  const runtime = newRuntime(31337);
  addHeroes(runtime);
  const hero = PRESET_HEROES[0] as (typeof PRESET_HEROES)[number];
  const profile = {
    proficiency: hero.engine.proficiency.bonus,
    skills: hero.engine.proficiency.skills,
    saves: hero.engine.proficiency.saves,
  };
  const skill: SkillId = 'athletics';
  for (const mode of ['normal', 'advantage', 'disadvantage'] as const) {
    const result: CheckResultData = expectOk(runtime.rollCheck({ actorId: hero.engine.id, skillId: skill, dc: 15, mode }));
    const faces = diceFacesOf(result.rolls);
    const rng = replayRng(faces);
    const legacy = rollSkillCheck(profile, hero.engine.abilities, skill, 15, rng, mode);
    assert.equal(result.d20, legacy.d20, `${mode}：d20 应取同一骰面`);
    assert.equal(result.total, legacy.total, `${mode}：检定总值`);
    assert.equal(result.success, legacy.success, `${mode}：成败判定`);
    assert.equal(result.modifier, legacy.bonus, `${mode}：加值`);
    if (mode === 'advantage') assert.equal(result.d20, Math.max(...faces), '优势取两骰较高者');
    if (mode === 'disadvantage') assert.equal(result.d20, Math.min(...faces), '劣势取两骰较低者');
    assert.equal(rng.consumed(), faces.length, `${mode}：骰面消耗次数一致`);
  }
  // 属性检定：加值 = engine abilityMod(dex)
  const attribute = expectOk(runtime.rollCheck({ actorId: hero.engine.id, attributeId: 'dex', dc: 12 }));
  assert.equal(attribute.modifier, abilityMod(hero.engine.abilities.dex));
  // 使用脚本钩子（不是内核缺省路径）
  assert.equal(attribute.usedHook, true, 'resolveCheck 钩子应生效');
});

test('对照：检定暴击/大失败边界（20 / 1）与 engine rollCheck 一致', () => {
  const runtime = newRuntime(424242);
  addHeroes(runtime);
  const heroId = (PRESET_HEROES[0] as (typeof PRESET_HEROES)[number]).engine.id;
  let crit: CheckResultData | undefined;
  let fumble: CheckResultData | undefined;
  for (let attempt = 0; attempt < 400 && (crit === undefined || fumble === undefined); attempt += 1) {
    const result = expectOk(runtime.rollCheck({ actorId: heroId, skillId: 'athletics', dc: 10 }));
    if (result.d20 === 20 && crit === undefined) crit = result;
    if (result.d20 === 1 && fumble === undefined) fumble = result;
  }
  assert.ok(crit, '扫描种子流应出现 d20=20');
  assert.ok(fumble, '扫描种子流应出现 d20=1');
  const critLegacy = engineRollCheck({ modifier: crit.modifier, dc: 10 }, replayRng([20]));
  assert.equal(critLegacy.critical, true);
  assert.equal(crit.crit, critLegacy.critical, 'd20=20 时判定暴击');
  assert.equal(crit.success, true, 'd20=20 时命中/检定成功');
  const fumbleLegacy = engineRollCheck({ modifier: fumble.modifier, dc: 10 }, replayRng([1]));
  assert.equal(fumbleLegacy.fumble, true);
  assert.equal(fumble.success, false, 'd20=1 时失败');
  assert.equal(fumble.degree, 'fumble');
});

test('对照：同一房间种子 + 同一调用顺序 → 骰面/总值可复现', () => {
  const sequence = (runtime: RuleRuntime): Array<{ d20: number; total: number }> => {
    addHeroes(runtime);
    const heroId = (PRESET_HEROES[1] as (typeof PRESET_HEROES)[number]).engine.id;
    return ['normal', 'advantage', 'disadvantage'].map((mode) => {
      const result = expectOk(runtime.rollCheck({ actorId: heroId, skillId: 'stealth', dc: 12, mode: mode as 'normal' }));
      return { d20: result.d20 ?? -1, total: result.total };
    });
  };
  const first = sequence(newRuntime(555));
  const second = sequence(newRuntime(555));
  assert.deepEqual(second, first, '同 seed + 同顺序应完全复现');
  const third = sequence(newRuntime(556));
  assert.notDeepEqual(third, first, '不同 seed 不应复现（极小概率相等，seed 固定后不会发生）');
});

// ---------------------------------------------------------------------------
// 伤害落账 / 倒地条件
// ---------------------------------------------------------------------------

test('对照：伤害落账与倒地条件（applyDamage / damage/after）与旧 engine 一致', () => {
  const runtime = newRuntime(9001);
  addHeroes(runtime);
  const hero = PRESET_HEROES[0] as (typeof PRESET_HEROES)[number];
  const heroEngine = hero.engine;
  const before = expectOk(runtime.getSheet(heroEngine.id)).projection.resources.find((resource) => resource.id === 'hp');
  assert.equal(before?.current, heroEngine.combat.hpMax);

  // 一部分伤害：两边 HP 剩余一致
  const partial = expectOk(runtime.applyDamage({ targetId: heroEngine.id, amount: 5, sourceActorId: heroEngine.id }));
  const legacyTarget = engineCombatant(heroEngine);
  engineApplyDamage(legacyTarget, 5, 'test');
  assert.equal(partial.hpBefore, heroEngine.combat.hpMax);
  assert.equal(partial.hpAfter, legacyTarget.hp.current, '部分伤害后 HP 应与 engine 一致');
  assert.equal(partial.usedHook, true, 'resolveDamage 钩子应生效');

  // 致死伤害：HP 归零 → 挂「倒地/失能」状态（与 engine applyDamage 的条件一致）
  const lethal = expectOk(runtime.applyDamage({ targetId: heroEngine.id, amount: 999, sourceActorId: heroEngine.id }));
  engineApplyDamage(legacyTarget, 999, 'test');
  assert.equal(lethal.hpAfter, 0);
  assert.equal(legacyTarget.hp.current, 0);
  const actor = expectOk(runtime.getActor(heroEngine.id)).actor;
  const statusIds = actor.effects.map((effect) => effect.statusId).filter((id): id is string => typeof id === 'string');
  assert.ok(statusIds.includes('prone'), 'HP 归零应挂「倒地」');
  assert.ok(statusIds.includes('incapacitated'), 'HP 归零应挂「失能」');
  assert.deepEqual(
    legacyTarget.conditions.slice().sort(),
    ['incapacitated', 'prone'],
    '旧 engine 的倒地条件集合应是 倒地+失能',
  );
  assert.ok(actor.card.resources.hp !== undefined && (actor.card.resources.hp.current ?? 0) === 0, '卡上 HP 应写回 0');
});
