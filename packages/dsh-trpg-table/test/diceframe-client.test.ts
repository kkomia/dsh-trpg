/**
 * M9.6b 客户端：DiceFrame 卡导入（`client/diceframe.ts`）与本地卡新建/编辑表单（`client/cards.ts`）。
 *
 * 纯函数（不碰 DOM/localStorage）；DiceFrame → 本地卡 → validateCharacterCard 全链路离线可测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCharacterCard } from '@dsh-trpg/engine';
import { DND5E_LITE_RULES } from '@dsh-trpg/content/rules-pack';
import {
  cardInstanceToLocalCard,
  importDiceFrameAsLocalCard,
  importDiceFrameText,
  isDiceFrameJson,
} from '../src/client/diceframe.ts';
import {
  createLocalCardFromForm,
  emptyLocalCardForm,
  localCardFormOf,
  updateLocalCardFromForm,
} from '../src/client/cards.ts';
import { adaptDiceFrameCard } from '../../rules/src/adapters/diceframe.ts';

const DICEFRAME_CARD = {
  schema_version: 2,
  id: 'df-shen-qingwu',
  rule_id: 'freeform_wuxia',
  character_name: '沈青梧',
  race: '山民',
  class: '剑客',
  level: 3,
  background: '青石镇铁匠铺学徒',
  publicSummary: '背刀的山民少女，话不多，眼睛很亮。',
  appearance: '短打劲装，右手虎口有旧茧。',
  personality: '护短、认死理。',
  attributes: { 力量: 16, 敏捷: 14, 体质: 13, 智力: 10, 感知: 12, 魅力: 8 },
  resources: { 生命: { current: 18, max: 20 } },
  skills: [
    { name: '运动', proficient: true },
    { name: '察觉', proficient: true },
    { name: '游说', proficient: false },
  ],
  equipment: [{ name: '横刀', type: 'weapon', damage: 3, quality: '精良' }],
  inventory: [
    { name: '金创药', qty: 2, type: 'consumable' },
    { name: '火折子', qty: 1 },
  ],
  worldbook: [{ title: '青梧的师门', keys: ['师门', '青梧'], content: '剑宗外门弟子，师父姓柳。' }],
};

test('DiceFrame 导入：检测 + 适配 + 本地卡映射（名字/六属性/技能/HP/攻击/背包）', () => {
  assert.equal(isDiceFrameJson(DICEFRAME_CARD), true);
  assert.equal(isDiceFrameJson({ schemaVersion: 1, id: 'x' }), false);
  const result = importDiceFrameAsLocalCard(DICEFRAME_CARD, DND5E_LITE_RULES);
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('；'));
  if (!result.ok) return;
  assert.equal(result.card.identity.name, '沈青梧');
  assert.equal(result.card.identity.race, '山民');
  assert.equal(result.card.identity.class, '剑客');
  assert.equal(result.card.identity.level, 3);
  assert.equal(result.card.abilities.str, 16);
  assert.equal(result.card.abilities.dex, 14);
  assert.equal(result.card.abilities.cha, 8);
  assert.ok(result.card.proficiency.skills.includes('athletics'));
  assert.ok(result.card.proficiency.skills.includes('perception'));
  assert.equal(result.card.combat.hpMax, 20);
  assert.ok(result.card.combat.attacks.length >= 1);
  assert.equal(result.card.combat.attacks[0]?.damage, '1d8');
  assert.ok(result.card.inventory.some((item) => item.name === '横刀'));
  assert.ok(result.card.inventory.some((item) => item.name === '金创药' && item.qty === 2));
  assert.equal(validateCharacterCard(result.card).ok, true);
  // personalLore 不进卡，单独返回提示另导
  assert.equal(result.personalLore.length, 1);
  assert.equal(result.personalLore[0]?.title, '青梧的师门');
  assert.ok(Array.isArray(result.warnings));
});

test('DiceFrame 导入：不是 DiceFrame / 没有规则包 / JSON 坏文本 → 可读中文错误', () => {
  const notDice = importDiceFrameAsLocalCard({ schemaVersion: 1, id: 'card_x' }, DND5E_LITE_RULES);
  assert.equal(notDice.ok, false);
  assert.match(notDice.ok ? '' : notDice.errors.join('；'), /不是 DiceFrame 角色卡/);
  const noRules = importDiceFrameAsLocalCard(DICEFRAME_CARD, undefined);
  assert.equal(noRules.ok, false);
  assert.match(noRules.ok ? '' : noRules.errors.join('；'), /没有 rules 段/);
  const badJson = importDiceFrameText('{bad json', DND5E_LITE_RULES);
  assert.equal(badJson.ok, false);
  assert.match(badJson.ok ? '' : badJson.errors.join('；'), /不是合法的 JSON/);
});

test('DiceFrame 导入：schema_version 不是 2 → 拒绝（版本守卫）', () => {
  const version1 = { ...DICEFRAME_CARD, schema_version: 1 };
  const result = importDiceFrameAsLocalCard(version1, DND5E_LITE_RULES);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.errors.join('；'), /schema_version/);
});

test('cardInstanceToLocalCard：没有 HP 资源时按体质估算，且保证合法', () => {
  const adapted = adaptDiceFrameCard({ ...DICEFRAME_CARD, resources: {} }, DND5E_LITE_RULES);
  assert.equal(adapted.ok, true);
  if (!adapted.ok) return;
  const converted = cardInstanceToLocalCard(adapted.card, DND5E_LITE_RULES);
  assert.equal(converted.ok, true, converted.ok ? '' : converted.errors.join('；'));
  if (!converted.ok) return;
  assert.ok(converted.card.combat.hpMax >= 1);
  assert.equal(validateCharacterCard(converted.card).ok, true);
});

test('本地卡表单：新建 → 编辑 → 回填往返（六属性/技能/叙事字段保留）', () => {
  const form = emptyLocalCardForm();
  form.name = '阿青';
  form.race = '山民';
  form.class = '武者';
  form.level = 4;
  form.abilities = { str: 17, dex: 14, con: 15, int: 10, wis: 12, cha: 8 };
  form.skills = ['athletics', 'intimidation'];
  form.appearance = '短打劲装';
  form.personality = '护短';
  form.publicSummary = '背刀的山民少女';
  const created = createLocalCardFromForm(form, 1_700_000_000_000);
  assert.equal(created.ok, true, created.errors.join('；'));
  assert.ok(created.record !== undefined);
  if (!created.record) return;
  assert.equal(created.record.card.identity.name, '阿青');
  assert.equal(created.record.card.abilities.str, 17);
  assert.deepEqual(created.record.card.proficiency.skills, ['athletics', 'intimidation']);
  assert.equal(created.record.card.identity.level, 4);
  assert.equal(created.record.card.proficiency.bonus, 2);
  assert.equal(created.record.card.combat.attacks.length, 1);
  assert.equal(validateCharacterCard(created.record.card).ok, true);

  const editForm = localCardFormOf(created.record.card);
  assert.equal(editForm.name, '阿青');
  editForm.level = 5;
  editForm.name = '阿青（五级）';
  const updated = updateLocalCardFromForm(created.record, editForm, 1_700_000_100_000);
  assert.equal(updated.ok, true, updated.errors.join('；'));
  assert.equal(updated.record?.card.id, created.record.card.id, '编辑应保留卡 id');
  assert.equal(updated.record?.card.identity.level, 5);
  assert.equal(updated.record?.card.identity.name, '阿青（五级）');
  assert.equal(updated.record?.createdAt, created.record.createdAt);
});

test('本地卡表单：空名字/越界等级给中文错误，不产出卡', () => {
  const form = emptyLocalCardForm();
  form.name = '';
  const noName = createLocalCardFromForm(form);
  assert.equal(noName.ok, false);
  assert.match(noName.errors.join('；'), /名字不能为空/);
  form.name = '测试';
  form.level = 21;
  const badLevel = createLocalCardFromForm(form);
  assert.equal(badLevel.ok, false);
  assert.match(badLevel.errors.join('；'), /等级必须是 1–20/);
  form.level = 1;
  form.abilities.str = 40;
  const badAbility = createLocalCardFromForm(form);
  assert.equal(badAbility.ok, false);
  assert.match(badAbility.errors.join('；'), /属性 STR 必须是 1–30/);
});
