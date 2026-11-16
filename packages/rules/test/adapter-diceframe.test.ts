/**
 * M8.5a：DiceFrame 角色卡（schema_version: 2）→ 内部卡实例（trpg.card/1）适配器。
 *
 * 覆盖：版本守卫/嗅探、中英文属性与技能映射、装备/背包匹配与槽位容量、资源（外部值 / 上限公式
 * 兜底 / 无法求值）、叙事字段与 level、世界书另导入、origin/cardId 稳定性、validateCard 失败路径、
 * 确定性/不改入参，以及与 dnd5e-lite 契约（测试内构造的最小规则包）对齐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptDiceFrameCard,
  diceFrameToRulesCardJson,
  isDiceFrameCard,
  validateCard,
  validateRulePack,
  DICEFRAME_ATTRIBUTE_ALIASES,
  SAMPLE_CARD_AQING,
  type RulePack,
} from '../src/index.ts';
import {
  cloneCardFixture,
  DICEFRAME_CARD_EN,
  DICEFRAME_CARD_ZH,
  makeDiceFrameRules,
} from './diceframe-fixtures.ts';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

type AdaptResult = ReturnType<typeof adaptDiceFrameCard>;
type AdaptOk = Extract<AdaptResult, { ok: true }>;
type AdaptFail = Extract<AdaptResult, { ok: false }>;

function makeRules(): RulePack {
  return makeDiceFrameRules();
}

function withRules(mutate: (pack: RulePack) => void): RulePack {
  const pack = makeRules();
  mutate(pack);
  return pack;
}

function adaptOk(input: unknown, rules: RulePack = makeRules()): AdaptOk {
  const result = adaptDiceFrameCard(input, rules);
  if (!result.ok) assert.fail(`适配应成功，却失败：${result.errors.join('；')}`);
  return result;
}

function adaptFail(input: unknown, rules: RulePack = makeRules()): AdaptFail {
  const result = adaptDiceFrameCard(input, rules);
  if (result.ok) assert.fail(`适配应失败，却成功：${result.card.cardId}`);
  return result;
}

function warningsText(warnings: readonly string[]): string {
  return warnings.join('\n');
}

function attributesOf(card: Record<string, unknown>): Record<string, unknown> {
  const raw = card.attributes;
  assert.ok(typeof raw === 'object' && raw !== null && !Array.isArray(raw), 'attributes 应为对象');
  return raw as Record<string, unknown>;
}

function declaredSkillIds(rules: RulePack): string[] {
  return rules.sheet.skills.map((skill) => skill.id);
}

// ---------------------------------------------------------------------------
// fixture / 版本守卫
// ---------------------------------------------------------------------------

test('DiceFrame 适配：测试规则包 fixture 本身通过 validateRulePack', () => {
  const result = validateRulePack(makeRules());
  assert.equal(result.ok, true, result.errors.join('；'));
});

test('DiceFrame 适配：isDiceFrameCard 识别两张 fixture 卡与嗅探卡', () => {
  assert.equal(isDiceFrameCard(DICEFRAME_CARD_ZH), true);
  assert.equal(isDiceFrameCard(DICEFRAME_CARD_EN), true);
  const sniffed = cloneCardFixture(DICEFRAME_CARD_ZH);
  delete sniffed.schema_version;
  assert.equal(isDiceFrameCard(sniffed), true);
  sniffed.schema_version = '2';
  assert.equal(isDiceFrameCard(sniffed), false);
});

test('DiceFrame 适配：isDiceFrameCard 对非 DiceFrame 输入返回 false', () => {
  assert.equal(isDiceFrameCard(null), false);
  assert.equal(isDiceFrameCard(undefined), false);
  assert.equal(isDiceFrameCard([]), false);
  assert.equal(isDiceFrameCard('card'), false);
  assert.equal(isDiceFrameCard(SAMPLE_CARD_AQING), false);
  const versionOne = cloneCardFixture(DICEFRAME_CARD_ZH);
  versionOne.schema_version = 1;
  assert.equal(isDiceFrameCard(versionOne), false);
  assert.equal(isDiceFrameCard({ character_name: '只有名字' }), false);
});

test('DiceFrame 适配：schema_version 非 2 直接拒绝（版本守卫只认 2）', () => {
  for (const version of [1, 3, '2', 2.5]) {
    const input = cloneCardFixture(DICEFRAME_CARD_ZH);
    input.schema_version = version;
    const result = adaptFail(input);
    assert.ok(result.errors.some((error) => error.includes('schema_version')), result.errors.join('；'));
  }
});

test('DiceFrame 适配：非对象 / 缺 character_name / attributes 非对象拒绝', () => {
  for (const input of [null, undefined, [], 'card', 42]) {
    const result = adaptFail(input);
    assert.ok(result.errors.length > 0);
  }
  const noName = cloneCardFixture(DICEFRAME_CARD_ZH);
  delete noName.character_name;
  assert.ok(adaptFail(noName).errors.some((error) => error.includes('character_name')));

  const badAttributes = cloneCardFixture(DICEFRAME_CARD_ZH);
  badAttributes.attributes = ['str', 10];
  assert.ok(adaptFail(badAttributes).errors.some((error) => error.includes('attributes')));
});

test('DiceFrame 适配：缺 schema_version 但特征充足 → 嗅探成功并 warning', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  delete input.schema_version;
  const result = adaptOk(input);
  assert.ok(result.warnings.some((warning) => warning.includes('缺少 schema_version')), warningsText(result.warnings));
});

test('DiceFrame 适配：缺 schema_version 且特征不足 → 拒绝', () => {
  const result = adaptFail({ character_name: '无属性', rule_id: 'x' });
  assert.ok(result.errors.some((error) => error.includes('不是 DiceFrame')), result.errors.join('；'));
});

// ---------------------------------------------------------------------------
// 成功路径 / 身份
// ---------------------------------------------------------------------------

test('DiceFrame 适配：中文卡成功适配为 trpg.card/1 并带 origin', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  const card = result.card;
  assert.equal(card.schemaVersion, 'trpg.card/1');
  assert.equal(card.rulesId, 'dnd5e-lite-test');
  assert.equal(card.rulesVersion, '2.0.0');
  assert.deepEqual(card.origin, { packId: 'diceframe:freeform_wuxia' });
  assert.equal(card.statuses.length, 0);
  assert.ok(result.personalLore.length > 0);
});

test('DiceFrame 适配：cardId 形如 diceframe-<16 位 hex>', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  assert.match(result.card.cardId, /^diceframe-[0-9a-f]{16}$/);
});

test('DiceFrame 适配：cardId 稳定派生且按卡/规则包区分', () => {
  const first = adaptOk(DICEFRAME_CARD_ZH);
  const second = adaptOk(cloneCardFixture(DICEFRAME_CARD_ZH));
  assert.equal(first.card.cardId, second.card.cardId);
  const otherCard = adaptOk(DICEFRAME_CARD_EN);
  assert.notEqual(first.card.cardId, otherCard.card.cardId);
  const otherRules = withRules((pack) => {
    pack.rulesId = 'other-rules';
  });
  const underOtherRules = adaptOk(DICEFRAME_CARD_ZH, otherRules);
  assert.notEqual(first.card.cardId, underOtherRules.card.cardId);
});

test('DiceFrame 适配：中文卡适配结果通过 validateCard', () => {
  const rules = makeRules();
  const result = adaptOk(DICEFRAME_CARD_ZH, rules);
  assert.deepEqual(validateCard(rules, result.card), []);
});

test('DiceFrame 适配：英文卡适配结果通过 validateCard', () => {
  const rules = makeRules();
  const result = adaptOk(DICEFRAME_CARD_EN, rules);
  assert.deepEqual(validateCard(rules, result.card), []);
});

test('DiceFrame 适配：确定性（同输入两次结果完全一致）且不修改入参', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  const before = JSON.stringify(input);
  const first = adaptOk(input);
  const second = adaptOk(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), before);
});

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------

test('DiceFrame 适配：中文属性键映射到规则包属性 id', () => {
  const card = adaptOk(DICEFRAME_CARD_ZH).card;
  assert.deepEqual(card.attributes, { str: 10, dex: 16, con: 11, int: 12, wis: 8, cha: 3 });
});

test('DiceFrame 适配：英文属性键映射到规则包属性 id', () => {
  const card = adaptOk(DICEFRAME_CARD_EN).card;
  assert.deepEqual(card.attributes, { str: 14, dex: 16, con: 12, int: 10, wis: 13, cha: 8 });
});

test('DiceFrame 适配：规则包声明但外部缺失的属性用 default 并 warning', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  delete attributesOf(input)['魅力'];
  const result = adaptOk(input);
  assert.equal(result.card.attributes.cha, 10);
  assert.ok(result.warnings.some((warning) => warning.includes('没有属性「魅力」')), warningsText(result.warnings));
});

test('DiceFrame 适配：外部多余属性 warning 后丢弃，不写未声明属性', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  attributesOf(input)['幸运'] = 9;
  const result = adaptOk(input);
  assert.equal((result.card.attributes as Record<string, number>).幸运, undefined);
  assert.ok(result.warnings.some((warning) => warning.includes('幸运')), warningsText(result.warnings));
});

test('DiceFrame 适配：属性值非数值时用 default 并 warning', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  attributesOf(input)['力量'] = '14';
  const result = adaptOk(input);
  assert.equal(result.card.attributes.str, 10);
  assert.ok(result.warnings.some((warning) => warning.includes('不是数值')), warningsText(result.warnings));
});

test('DiceFrame 适配：属性越界不裁剪，由 validateCard 报错（失败路径）', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  attributesOf(input)['力量'] = 30;
  const result = adaptFail(input);
  const text = result.errors.join('；');
  assert.ok(text.includes('适配结果未通过卡校验'), text);
  assert.ok(text.includes('超出规则范围'), text);
  assert.ok(result.warnings.length >= 0);
});

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

test('DiceFrame 适配：中文技能名映射，value 原样写 bonus 并 warning', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  const athletics = result.card.skills.find((skill) => skill.id === 'athletics');
  assert.deepEqual(athletics, { id: 'athletics', proficient: false, bonus: 60 });
  assert.ok(
    result.warnings.some((warning) => warning.includes('运动') && warning.includes('按原值写入 bonus')),
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：显式 proficient / bonus 原样保留（不发 value 换算 warning）', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  const stealth = result.card.skills.find((skill) => skill.id === 'stealth');
  assert.deepEqual(stealth, { id: 'stealth', proficient: true, bonus: 2 });
  assert.ok(
    result.warnings.every((warning) => !(warning.includes('隐匿') && warning.includes('按原值写入 bonus'))),
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：未映射技能 warning，且卡的技能列表保持规则包全集', () => {
  const rules = makeRules();
  const result = adaptOk(DICEFRAME_CARD_ZH, rules);
  assert.ok(result.warnings.some((warning) => warning.includes('霜起')), warningsText(result.warnings));
  assert.deepEqual(
    result.card.skills.map((skill) => skill.id),
    declaredSkillIds(rules),
  );
});

test('DiceFrame 适配：skills 映射写法（对象）也支持', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  input.skills = { stealth: 2, perception: { proficient: true, bonus: 1 } };
  const result = adaptOk(input);
  const stealth = result.card.skills.find((skill) => skill.id === 'stealth');
  const perception = result.card.skills.find((skill) => skill.id === 'perception');
  assert.deepEqual(stealth, { id: 'stealth', proficient: false, bonus: 2 });
  assert.deepEqual(perception, { id: 'perception', proficient: true, bonus: 1 });
});

// ---------------------------------------------------------------------------
// 装备 / 背包
// ---------------------------------------------------------------------------

test('DiceFrame 适配：装备按名称匹配 rules.items[] 得到槽位/标签/词条', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  const sword = result.card.equipmentInstances.find((instance) => instance.name === '横刀');
  assert.ok(sword, '应迁移横刀');
  assert.equal(sword.slot, 'mainHand');
  assert.deepEqual(sword.tags, ['weapon:melee', '锋利']);
  assert.deepEqual(sword.stats, { 攻击: 2 });
  assert.equal(sword.note, '家传旧刀，刀脊有裂纹。');
  const armor = result.card.equipmentInstances.find((instance) => instance.name === '铁甲');
  assert.equal(armor?.slot, 'body');
  assert.deepEqual(armor?.stats, { 防御: 2 });
});

test('DiceFrame 适配：背包数量按件展开，受槽位 count 上限约束', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  const herbs = result.card.equipmentInstances.filter((instance) => instance.name === '止血草');
  assert.equal(herbs.length, 2); // qty=2
  assert.ok(herbs.every((instance) => instance.slot === 'trinket'));
  const torch = result.card.equipmentInstances.filter((instance) => instance.name === '火折子');
  assert.equal(torch.length, 1);
  assert.equal(result.card.equipmentInstances.length, 5); // 横刀/铁甲/止血草×2/火折子
});

test('DiceFrame 适配：未匹配物品只保留 name/tags/note 并 warning，不注入词条', () => {
  const result = adaptOk(DICEFRAME_CARD_EN);
  const bow = result.card.equipmentInstances.find((instance) => instance.name === 'Longbow');
  assert.ok(bow, '未匹配的 Longbow 也应尽量放入槽位');
  assert.equal(bow.slot, 'mainHand');
  assert.deepEqual(bow.stats, {});
  assert.deepEqual(bow.tags, ['weapon:ranged']);
  assert.ok(bow.note?.includes('DiceFrame'), String(bow.note));
  assert.ok(
    result.warnings.some((warning) => warning.includes('Longbow') && warning.includes('不在规则包 items[] 中')),
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：外部槽位别名 main_hand → mainHand', () => {
  const result = adaptOk(DICEFRAME_CARD_EN);
  const bow = result.card.equipmentInstances.find((instance) => instance.name === 'Longbow');
  assert.equal(bow?.slot, 'mainHand');
});

test('DiceFrame 适配：没有可接受标签的槽位时丢弃并 warning', () => {
  const rules = withRules((pack) => {
    pack.sheet.equipment.slots = pack.sheet.equipment.slots.filter((slot) => slot.id !== 'trinket');
  });
  const result = adaptOk(DICEFRAME_CARD_EN, rules);
  assert.equal(result.card.equipmentInstances.some((instance) => instance.name === 'Lucky Charm'), false);
  assert.ok(
    result.warnings.some((warning) => warning.includes('Lucky Charm') && warning.includes('无法映射')),
    warningsText(result.warnings),
  );
  assert.deepEqual(validateCard(rules, result.card), []);
});

test('DiceFrame 适配：背包数量超过槽位容量时截断并 warning', () => {
  const result = adaptOk(DICEFRAME_CARD_EN);
  const herbs = result.card.equipmentInstances.filter((instance) => instance.name === 'Healing Herb');
  assert.equal(herbs.length, 2); // 随身槽 3：Lucky Charm 占 1，剩 2
  assert.ok(
    result.warnings.some((warning) => warning.includes('Healing Herb') && warning.includes('容量不足')),
    warningsText(result.warnings),
  );
});

// ---------------------------------------------------------------------------
// 资源
// ---------------------------------------------------------------------------

test('DiceFrame 适配：外部资源 current/max 按中英文别名映射', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  assert.deepEqual(result.card.resources.hp, { current: 12, max: 14 });
  assert.deepEqual(result.card.resources.mana, { current: 13, max: 13 });
});

test('DiceFrame 适配：英文资源对象形式 {current,max} 映射', () => {
  const result = adaptOk(DICEFRAME_CARD_EN);
  assert.deepEqual(result.card.resources.hp, { current: 15, max: 18 });
  assert.deepEqual(result.card.resources.mana, { current: 4, max: 11 });
});

test('DiceFrame 适配：外部没有当前值时按上限公式结果作为当前值并 warning', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  const warnings = warningsText(result.warnings);
  assert.ok(warnings.includes('按上限公式结果 13 作为当前值'), warnings);
});

test('DiceFrame 适配：上限公式无法求值时当前值按 0 并 warning', () => {
  const rules = withRules((pack) => {
    pack.formulas.hpMax = 'derived.hpMax';
  });
  const input = cloneCardFixture(DICEFRAME_CARD_EN);
  delete input.resources;

  const result = adaptOk(input, rules);
  assert.deepEqual(result.card.resources.hp, { current: 0 });
  assert.ok(
    result.warnings.some((warning) => warning.includes('上限公式') && warning.includes('无法求值')),
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：无法映射的外部资源 warning 后丢弃', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  assert.ok(
    result.warnings.some((warning) => warning.includes('内力') && warning.includes('没有对应资源')),
    warningsText(result.warnings),
  );
  assert.equal((result.card.resources as Record<string, unknown>).qi, undefined);
});

// ---------------------------------------------------------------------------
// 叙事字段 / 等级
// ---------------------------------------------------------------------------

test('DiceFrame 适配：身份/背景/外貌/性格/公开摘要 → fields', () => {
  const result = adaptOk(DICEFRAME_CARD_EN);
  assert.equal(result.card.fields.name, 'Aldric');
  assert.equal(result.card.fields.race, 'Human');
  assert.equal(result.card.fields.class, 'Ranger');
  assert.equal(result.card.fields.background, 'A hunter from the northern woods.');
  assert.equal(result.card.fields.publicSummary, '林间猎手，靠得住。');
  assert.equal(result.card.fields.appearance, 'Weathered cloak, a longbow on the back.');
  assert.equal(result.card.fields.personality, 'Quiet and watchful.');
  assert.equal(result.card.fields.alignment, '中立'); // 外部 fields 直通（规则包声明了 enum）
});

test('DiceFrame 适配：目标规则包没有声明字段时 warning', () => {
  const rules = withRules((pack) => {
    pack.sheet.fields = pack.sheet.fields.filter((field) => field.id !== 'personality');
  });
  const result = adaptOk(DICEFRAME_CARD_EN, rules);
  assert.equal(result.card.fields.personality, undefined);
  assert.ok(
    result.warnings.some((warning) => warning.includes('没有声明字段「personality」')),
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：等级缺省 1、超 maxLevel 裁剪、非法值 warning', () => {
  const base = adaptOk(DICEFRAME_CARD_ZH);
  assert.equal(base.card.fields.level, 1);

  const high = cloneCardFixture(DICEFRAME_CARD_ZH);
  high.level = 99;
  const highResult = adaptOk(high);
  assert.equal(highResult.card.fields.level, 5); // fixture maxLevel = 5
  assert.ok(highResult.warnings.some((warning) => warning.includes('maxLevel')), warningsText(highResult.warnings));

  const bad = cloneCardFixture(DICEFRAME_CARD_ZH);
  bad.level = '高阶';
  const badResult = adaptOk(bad);
  assert.equal(badResult.card.fields.level, 1);
  assert.ok(badResult.warnings.some((warning) => warning.includes('level 不是数值')), warningsText(badResult.warnings));
});

// ---------------------------------------------------------------------------
// 世界书 / 来源 / 未映射内容
// ---------------------------------------------------------------------------

test('DiceFrame 适配：随卡世界书不写入卡，作为 personalLore 返回并 warning', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  assert.equal(result.personalLore.length, 2);
  assert.equal(result.personalLore[0]?.source, 'worldbook');
  assert.equal(result.personalLore[0]?.title, '枯木崖异光');
  assert.deepEqual(result.personalLore[0]?.keys, ['枯木崖', '绿光']);
  assert.ok(result.personalLore[0]?.content.includes('绿色异光'));
  assert.ok(
    result.warnings.some((warning) => warning.includes('世界书片段「worldbook」') && warning.includes('世界书导入流程')),
    warningsText(result.warnings),
  );
  const cardJson = JSON.stringify(result.card);
  assert.equal(cardJson.includes('夜夜出现绿色异光'), false);
});

test('DiceFrame 适配：对象式世界书（lore.entries）可提取；非法格式给 warning', () => {
  const enResult = adaptOk(DICEFRAME_CARD_EN);
  assert.equal(enResult.personalLore.length, 1);
  assert.equal(enResult.personalLore[0]?.source, 'lore');
  assert.equal(enResult.personalLore[0]?.title, 'Northern Woods');
  assert.deepEqual(enResult.personalLore[0]?.keys, ['forest']);

  const bad = cloneCardFixture(DICEFRAME_CARD_ZH);
  bad.worldbook = 123;
  const badResult = adaptOk(bad);
  assert.equal(badResult.personalLore.length, 0);
  assert.ok(badResult.warnings.some((warning) => warning.includes('「worldbook」')), warningsText(badResult.warnings));
});

test('DiceFrame 适配：rule_id 与目标规则包不同给 warning，origin 保留来源', () => {
  const result = adaptOk(DICEFRAME_CARD_ZH);
  assert.deepEqual(result.card.origin, { packId: 'diceframe:freeform_wuxia' });
  assert.ok(
    result.warnings.some((warning) => warning.includes('与目标规则包') && warning.includes('freeform_wuxia')),
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：无 rule_id 时 origin 为 diceframe（不猜规则）', () => {
  const result = adaptOk(DICEFRAME_CARD_EN);
  assert.deepEqual(result.card.origin, { packId: 'diceframe' });
  assert.equal(
    result.warnings.some((warning) => warning.includes('与目标规则包')),
    false,
    warningsText(result.warnings),
  );
});

test('DiceFrame 适配：关键物品 / 货币无法映射时 warning', () => {
  const zh = adaptOk(DICEFRAME_CARD_ZH);
  assert.ok(zh.warnings.some((warning) => warning.includes('货币（10000）')), warningsText(zh.warnings));
  const en = adaptOk(DICEFRAME_CARD_EN);
  assert.ok(en.warnings.some((warning) => warning.includes('关键物品') && warning.includes('指南针')), warningsText(en.warnings));
});

// ---------------------------------------------------------------------------
// JSON 输出
// ---------------------------------------------------------------------------

test('DiceFrame 适配：diceFrameToRulesCardJson 输出可解析的内部卡 JSON（含 origin）', () => {
  const result = diceFrameToRulesCardJson(cloneCardFixture(DICEFRAME_CARD_ZH), makeRules());
  if (!result.ok) assert.fail(`应成功：${result.errors.join('；')}`);
  assert.ok(result.json.endsWith('\n'));
  const parsed = JSON.parse(result.json) as Record<string, unknown>;
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(result.card)));
  assert.equal(parsed.schemaVersion, 'trpg.card/1');
  assert.deepEqual(parsed.origin, { packId: 'diceframe:freeform_wuxia' });
  assert.match(String(parsed.cardId), /^diceframe-[0-9a-f]{16}$/);
});

test('DiceFrame 适配：diceFrameToRulesCardJson 失败时不产出 JSON', () => {
  const result = diceFrameToRulesCardJson(null, makeRules());
  if (result.ok) assert.fail('非法输入不应成功');
  assert.ok(result.errors.length > 0);
  assert.equal((result as { json?: unknown }).json, undefined);
});

test('DiceFrame 适配：只有上限键（max_hp）时按上限落账，不误当当前值', () => {
  const rules = withRules((pack) => {
    pack.formulas.hpMax = 'derived.hpMax';
  });
  const input = cloneCardFixture(DICEFRAME_CARD_ZH);
  input.resources = { max_hp: 20 };
  const result = adaptOk(input, rules);
  assert.deepEqual(result.card.resources.hp, { current: 20, max: 20 });
});

test('DiceFrame 适配：外部 fields.level 直通可被等级映射识别', () => {
  const input = cloneCardFixture(DICEFRAME_CARD_EN);
  input.fields = { alignment: '中立', level: 3 };
  const result = adaptOk(input);
  assert.equal(result.card.fields.level, 3);
  assert.equal(result.card.fields.alignment, '中立');
});

// ---------------------------------------------------------------------------
// 别名表扩展性
// ---------------------------------------------------------------------------

test('DiceFrame 适配：别名表以外还支持目标规则包自定义属性/技能 id（数据驱动扩展）', () => {
  assert.ok(DICEFRAME_ATTRIBUTE_ALIASES.str?.includes('力量'));
  const customRules = withRules((pack) => {
    pack.sheet.attributes = [
      { id: 'strength', name: '力量', min: 3, max: 18, default: 10 },
      { id: 'agility', name: '轻功', min: 3, max: 18, default: 10 },
    ];
    pack.sheet.resources = [{ id: 'hp', name: '生命', formula: '1' }];
    pack.sheet.fields = [];
    pack.sheet.skills = [{ id: 'qigong', name: '轻功', attribute: 'strength' }];
    pack.sheet.equipment = { slots: [], stats: [] };
    pack.items = [];
    pack.formulas = { hpMax: '1' };
  });
  const input: Record<string, unknown> = {
    schema_version: 2,
    character_name: '无名',
    attributes: { 力量: 12, 敏捷: 9 },
    skills: [{ name: '轻功', bonus: 1 }],
  };
  const result = adaptOk(input, customRules);
  assert.equal(result.card.attributes.strength, 12);
  // 规则包没有 aglity/敏捷 属性：外部多余属性丢弃（warning）
  assert.ok(result.warnings.some((warning) => warning.includes('敏捷')), warningsText(result.warnings));
  const qigong = result.card.skills.find((skill) => skill.id === 'qigong');
  assert.deepEqual(qigong, { id: 'qigong', proficient: false, bonus: 1 });
  assert.deepEqual(validateCard(customRules, result.card), []);
});
