/**
 * M8.5a DiceFrame 适配器测试 fixture（自建，**不依赖** `@dsh-trpg/content`，避免 rules ↔ content 循环依赖）。
 *
 * - {@link makeDiceFrameRules}：在 `MINIMAL_RULE_PACK`（packages/rules/src/fixtures.ts）基础上扩成
 *   「dnd5e-lite 测试子集」——六属性 / hp+mana 双资源 / 6 技能 / 3 装备槽 / 5 件物品；
 *   字段契约与 dnd5e-lite 对齐（属性范围 3–18、`fields` 身份字段、`rules.items[]` 等）。
 * - {@link DICEFRAME_CARD_ZH}：中式奇幻卡（中文属性键 / 中文技能 / 匹配规则包物品 / 外部资源 / 世界书）。
 * - {@link DICEFRAME_CARD_EN}：西幻卡（英文属性键与英文技能 / 未匹配物品与数量溢出的背包 / 对象式世界书）。
 */
import { MINIMAL_RULE_PACK, type RulePack } from '../src/index.ts';

/** `MINIMAL_RULE_PACK` 的 dnd5e-lite 测试子集（六属性 / 双资源 / 6 技能 / 5 物品）。 */
export function makeDiceFrameRules(): RulePack {
  const pack = structuredClone(MINIMAL_RULE_PACK);
  pack.rulesId = 'dnd5e-lite-test';
  pack.rulesVersion = '2.0.0';
  pack.name = 'D&D 5e-lite（测试子集）';
  pack.sheet.attributes.push(
    { id: 'int', name: '智力', min: 3, max: 18, default: 10 },
    { id: 'wis', name: '感知', min: 3, max: 18, default: 10 },
    { id: 'cha', name: '魅力', min: 3, max: 18, default: 10 },
  );
  pack.sheet.resources.push({ id: 'mana', name: '法力', formula: 'manaMax' });
  pack.sheet.skills.push(
    { id: 'perception', name: '察觉', attribute: 'wis' },
    { id: 'insight', name: '洞悉', attribute: 'wis' },
    { id: 'persuasion', name: '游说', attribute: 'cha' },
    { id: 'arcana', name: '奥秘', attribute: 'int' },
  );
  pack.formulas.manaMax = 'attr.int + level';
  if (pack.items === undefined) pack.items = [];
  pack.items.push({
    itemId: 'changong',
    name: '长弓',
    tags: ['weapon:ranged'],
    rarity: 'common',
    stats: { 攻击: 1 },
    equipSlot: ['mainHand'],
    description: '猎户用的长弓。',
  });
  return pack;
}

/** 中式奇幻卡：中文属性/技能键、匹配规则包物品、外部资源与随卡世界书。 */
export const DICEFRAME_CARD_ZH: Record<string, unknown> = {
  id: 'card_1794149170987269402_f001195e',
  schema_version: 2,
  character_name: '苏泠霜',
  race: '人族',
  class: '剑客',
  source: '角色卡库',
  identity: {
    origin: '人族',
    archetype: '剑客',
    background: '昆仑剑宗「照雪」一脉唯一传人，奉宗门之命下山查探枯木崖异光。',
  },
  attributes: { 力量: 10, 敏捷: 16, 体质: 11, 智力: 12, 感知: 8, 魅力: 3 },
  skills: [
    { name: '运动', value: 60, effect: '体术：剑法根基' },
    { name: '隐匿', bonus: 2, proficient: true, effect: '潜行接近不惊动目标' },
    { name: '霜起', value: 20, effect: '起手/控场：剑未出鞘，霜先漫地' },
    { name: '察觉', value: 40, effect: '留意枯木崖的异光' },
  ],
  background: '昆仑剑宗「照雪」一脉唯一传人，奉宗门之命下山查探枯木崖异光。',
  equipment: [
    { name: '横刀', type: 'weapon', damage: 6, slot: 'main_hand', quality: 'common' },
    { name: '铁甲', type: 'armor', damage: 0, slot: 'body', quality: 'uncommon' },
  ],
  inventory: [
    { name: '止血草', qty: 2, effect: '恢复 1d4 生命' },
    { name: '火折子', qty: 1, effect: '照明' },
  ],
  key_items: [],
  gold: 10000,
  currency: { amount: 10000 },
  rule_id: 'freeform_wuxia',
  rule_name: '武侠仙侠自由规则',
  rule_version: '1.2',
  mechanics: 'freeform_d20_core',
  language: 'zh-CN',
  resources: { hp: 12, max_hp: 14, 内力: 100 },
  worldbook: [
    { title: '枯木崖异光', keys: ['枯木崖', '绿光'], content: '青石镇以西三里的崖顶夜夜出现绿色异光约一炷香。' },
    '清风茶馆的柳掌柜消息灵通，京城退隐。',
  ],
};

/** 西幻卡：英文属性/技能、未匹配规则包物品、数量溢出的背包、对象式世界书；无 rule_id。 */
export const DICEFRAME_CARD_EN: Record<string, unknown> = {
  id: 'card_1794149170987269403_a1b2c3d4',
  schema_version: 2,
  character_name: 'Aldric',
  race: 'Human',
  class: 'Ranger',
  source: '角色卡库',
  identity: { origin: 'Human', archetype: 'Ranger', background: 'A hunter from the northern woods.' },
  attributes: { str: 14, dex: 16, con: 12, int: 10, wis: 13, cha: 8 },
  skills: [
    { name: 'stealth', value: 45 },
    { name: 'perception', bonus: 3, proficient: true },
    { name: 'athletics', value: 55 },
    { name: 'arcana', value: 30 },
  ],
  background: 'A hunter from the northern woods.',
  appearance: 'Weathered cloak, a longbow on the back.',
  personality: 'Quiet and watchful.',
  public_summary: '林间猎手，靠得住。',
  fields: { alignment: '中立' },
  equipment: [
    { name: 'Longbow', type: 'weapon', damage: 8, slot: 'main_hand', quality: 'rare' },
    { name: 'Leather Vest', type: 'armor', damage: 0, slot: 'body', quality: 'common' },
    { name: 'Lucky Charm', type: 'misc', damage: 0, slot: 'trinket', quality: 'uncommon' },
  ],
  inventory: [{ name: 'Healing Herb', qty: 5, effect: '恢复少量生命' }],
  key_items: ['锈蚀的指南针'],
  gold: 0,
  currency: { amount: 0 },
  rule_name: '武侠仙侠自由规则',
  rule_version: '1.2',
  mechanics: 'freeform_d20_core',
  language: 'zh-CN',
  resources: { hp: { current: 15, max: 18 }, mana: 4 },
  lore: { entries: [{ title: 'Northern Woods', keys: 'forest', content: 'North of the town, an old forest.' }] },
};

/** 深拷贝 fixture（用例之间互不污染）。 */
export function cloneCardFixture(card: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(card);
}
