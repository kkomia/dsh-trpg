import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateEquipmentStats,
  buildSheetProjection,
  cardLevel,
  validateCard,
  type CardInstance,
  type EquipmentInstanceDef,
  type RulePack,
} from '../src/index.ts';
import { cloneCard, clonePack, withPack } from './helpers.ts';

function cardErrors(card: unknown, rules: RulePack = clonePack()): string[] {
  return validateCard(rules, card);
}

// ---------------------------------------------------------------------------
// validateCard
// ---------------------------------------------------------------------------

test('卡校验：示例卡都合法', () => {
  const rules = clonePack();
  for (const index of [0, 1]) {
    const errors = validateCard(rules, cloneCard(index));
    assert.deepEqual(errors, [], errors.join('; '));
  }
});

test('卡校验：schemaVersion 必须匹配', () => {
  const card = cloneCard();
  (card as unknown as { schemaVersion: string }).schemaVersion = 'trpg.card/2';
  assert.ok(cardErrors(card).some((error) => error.includes('schemaVersion')));
});

test('卡校验：rulesId 必须与规则包一致', () => {
  const card = cloneCard();
  card.rulesId = 'other-rules';
  assert.ok(cardErrors(card).some((error) => error.includes('rulesId')));
});

test('卡校验：属性超出范围报错', () => {
  const card = cloneCard();
  card.attributes.str = 99;
  assert.ok(cardErrors(card).some((error) => error.includes('超出规则范围')));
});

test('卡校验：缺少声明的属性报错', () => {
  const card = cloneCard();
  delete card.attributes.con;
  assert.ok(cardErrors(card).some((error) => error.includes('缺少属性')));
});

test('卡校验：未声明的属性报错', () => {
  const card = cloneCard();
  card.attributes.luck = 10;
  assert.ok(cardErrors(card).some((error) => error.includes('未声明的属性')));
});

test('卡校验：资源 current 不能为负', () => {
  const card = cloneCard();
  card.resources.hp = { current: -1 };
  assert.ok(cardErrors(card).some((error) => error.includes('不能为负数')));
});

test('卡校验：缺少声明的资源报错', () => {
  const card = cloneCard();
  delete card.resources.hp;
  assert.ok(cardErrors(card).some((error) => error.includes('缺少资源')));
});

test('卡校验：未声明的资源报错', () => {
  const card = cloneCard();
  card.resources.mana = { current: 1 };
  assert.ok(cardErrors(card).some((error) => error.includes('未声明的资源')));
});

test('卡校验：enum 字段值必须在 options 内', () => {
  const card = cloneCard();
  card.fields.alignment = '绝对中立';
  assert.ok(cardErrors(card).some((error) => error.includes('枚举值')));
});

test('卡校验：text 字段类型错误', () => {
  const card = cloneCard();
  card.fields.name = 42;
  assert.ok(cardErrors(card).some((error) => error.includes('必须是文本')));
});

test('卡校验：技能 id 必须已声明', () => {
  const card = cloneCard();
  card.skills.push({ id: 'arcana', proficient: true });
  assert.ok(cardErrors(card).some((error) => error.includes('未声明的技能')));
});

test('卡校验：装备槽必须已声明', () => {
  const card = cloneCard();
  card.equipmentInstances[0]!.slot = 'hat';
  assert.ok(cardErrors(card).some((error) => error.includes('未声明的装备槽')));
});

test('卡校验：装备标签必须匹配槽位 accepts', () => {
  const card = cloneCard();
  card.equipmentInstances[0]!.slot = 'body';
  assert.ok(cardErrors(card).some((error) => error.includes('不能放入槽位')));
});

test('卡校验：槽位件数不能超限', () => {
  const card = cloneCard();
  for (let index = 0; index < 3; index += 1) {
    card.equipmentInstances.push({
      instanceId: `ins_extra_${index}`,
      slot: 'trinket',
      name: '杂物',
      tags: ['misc'],
      stats: {},
    });
  }
  const errors = cardErrors(card);
  assert.ok(errors.some((error) => error.includes('最多 3 件')), errors.join('; '));
});

test('卡校验：词条 id 必须已声明', () => {
  const card = cloneCard();
  card.equipmentInstances[0]!.stats = { 不存在: 1 };
  assert.ok(cardErrors(card).some((error) => error.includes('未声明的词条')));
});

test('卡校验：词条值不能超过上限', () => {
  const card = cloneCard();
  card.equipmentInstances[0]!.stats = { 攻击: 99 };
  assert.ok(cardErrors(card).some((error) => error.includes('大于词条上限')));
});

test('卡校验：状态 id 必须已声明', () => {
  const card = cloneCard();
  card.statuses.push({ id: 'burning', stacks: 1 });
  assert.ok(cardErrors(card).some((error) => error.includes('未声明的状态')));
});

test('卡校验：状态层数必须是正整数', () => {
  const card = cloneCard();
  card.statuses = [{ id: 'poisoned', stacks: 0 }];
  assert.ok(cardErrors(card).some((error) => error.includes('stacks')));
});

// ---------------------------------------------------------------------------
// 词条聚合
// ---------------------------------------------------------------------------

test('词条聚合：add 相加', () => {
  const rules = clonePack();
  const aggregate = aggregateEquipmentStats(rules, [
    { instanceId: 'a', slot: 'mainHand', name: '刀', tags: [], stats: { 攻击: 2 } },
    { instanceId: 'b', slot: 'trinket', name: '护符', tags: [], stats: { 攻击: 1 } },
  ]);
  assert.equal(aggregate.statValues['攻击'], 3);
});

test('词条聚合：max / min / unique 叠法', () => {
  const rules = clonePack();
  rules.sheet.equipment.stats = [
    { id: '甲', name: '甲', stacking: 'add' },
    { id: '乙', name: '乙', stacking: 'max' },
    { id: '丙', name: '丙', stacking: 'min' },
    { id: '丁', name: '丁', stacking: 'unique' },
  ];
  const instances: EquipmentInstanceDef[] = [
    { instanceId: 'i1', slot: 'trinket', name: '一', tags: [], stats: { 甲: 2, 乙: 3, 丙: 5, 丁: 4 } },
    { instanceId: 'i2', slot: 'trinket', name: '二', tags: [], stats: { 甲: 1, 乙: 7, 丙: 1, 丁: 9 } },
  ];
  const aggregate = aggregateEquipmentStats(rules, instances);
  assert.deepEqual(aggregate.statValues, { 甲: 3, 乙: 7, 丙: 1, 丁: 9 });
  const trace = new Map(aggregate.trace.map((entry) => [entry.statId, entry]));
  assert.equal(trace.get('乙')?.parts[0]?.stack, 'max');
  assert.equal(trace.get('丁')?.parts.length, 2);
});

test('词条聚合：规则包未声明的词条容错按 add 聚合', () => {
  const rules = clonePack();
  const aggregate = aggregateEquipmentStats(rules, [
    { instanceId: 'a', slot: 'trinket', name: '怪东西', tags: [], stats: { 未声明: 2 } },
    { instanceId: 'b', slot: 'trinket', name: '怪东西2', tags: [], stats: { 未声明: 3 } },
  ]);
  assert.equal(aggregate.statValues['未声明'], 5);
});

// ---------------------------------------------------------------------------
// buildSheetProjection
// ---------------------------------------------------------------------------

test('投影：身份 / 属性 / 资源上限按公式算', () => {
  const rules = clonePack();
  const projection = buildSheetProjection(rules, cloneCard(0), { 'mod.str': 3, 'mod.dex': 2, 'mod.con': 2 });
  assert.equal(projection.cardId, 'card_aqing');
  assert.equal(projection.identity.name, '阿青');
  assert.equal(projection.identity.level, 1);
  assert.equal(projection.identity.race, '山民');
  assert.equal(projection.values.str, 17);
  const hp = projection.resources.find((resource) => resource.id === 'hp');
  assert.equal(hp?.current, 12);
  assert.equal(hp?.max, 18); // hpMax = 2 + con(15) + level(1)
  const str = projection.attributes.find((attribute) => attribute.id === 'str');
  assert.equal(str?.mod, 3);
});

test('投影：技能总加值走 formulas.check', () => {
  const projection = buildSheetProjection(clonePack(), cloneCard(0), { 'mod.str': 3, 'mod.dex': 2 });
  const athletics = projection.skills.find((skill) => skill.id === 'athletics');
  const stealth = projection.skills.find((skill) => skill.id === 'stealth');
  assert.equal(athletics?.total, 5); // 3 + 1×2 + 0
  assert.equal(athletics?.proficient, true);
  assert.equal(stealth?.total, 2); // 2 + 0×2 + 0
  assert.equal(stealth?.proficient, false);
});

test('投影：装备槽与词条总览', () => {
  const projection = buildSheetProjection(clonePack(), cloneCard(0), {});
  const mainHand = projection.equipment.slots.find((slot) => slot.slotId === 'mainHand');
  assert.equal(mainHand?.items[0]?.name, '横刀');
  assert.equal(mainHand?.items[0]?.stats['攻击'], 2);
  assert.equal(projection.equipment.statValues['攻击'], 2);
  assert.equal(projection.equipment.statValues['防御'], 2);
  const totals = new Map(projection.equipment.statTotals.map((total) => [total.statId, total.total]));
  assert.equal(totals.get('攻击'), 2);
});

test('投影：动作可用（行动经济成本）', () => {
  const projection = buildSheetProjection(clonePack(), cloneCard(0), {});
  const attack = projection.actions.find((action) => action.actionId === 'attack.melee');
  assert.equal(attack?.available, true);
  assert.deepEqual(attack?.cost?.turn, { action: 1 });
});

test('投影：资源不足时动作不可用并给原因', () => {
  const rules = withPack((pack) => {
    pack.sheet.resources.push({ id: 'mana', name: '真气', formula: '3' });
    pack.actions.push({
      actionId: 'spell.bolt',
      name: '术法飞弹',
      kind: 'spell',
      cost: { resource: 'mana' },
      targeting: { type: 'single', range: 'near', sides: 'enemy' },
      description: '消耗 1 点真气。',
    });
  });
  const card = cloneCard(0);
  card.resources.mana = { current: 0 };
  const projection = buildSheetProjection(rules, card, {});
  const spell = projection.actions.find((action) => action.actionId === 'spell.bolt');
  assert.equal(spell?.available, false);
  assert.ok(spell?.reason?.includes('真气不足'), spell?.reason);

  card.resources.mana = { current: 2 };
  const available = buildSheetProjection(rules, card, {});
  assert.equal(available.actions.find((action) => action.actionId === 'spell.bolt')?.available, true);
});

test('投影：状态与背包预留形状', () => {
  const projection = buildSheetProjection(clonePack(), cloneCard(0), {});
  assert.deepEqual(projection.statuses, [{ id: 'poisoned', name: '中毒', stacks: 1, remaining: 2, icon: 'status/poison' }]);
  assert.deepEqual(projection.inventory, { items: [], categories: [] });
});

test('投影：缺 fields.level 时按 1 级并给 warning', () => {
  const card = cloneCard(0);
  delete card.fields.level;
  const projection = buildSheetProjection(clonePack(), card, {});
  assert.equal(projection.identity.level, 1);
  assert.ok(projection.warnings.some((warning) => warning.includes('level')));
});

test('投影：资源上限公式求值失败时回退卡缓存 max 并给 warning', () => {
  const rules = withPack((pack) => (pack.sheet.resources[0]!.formula = 'derived.manaMax'));
  const projection = buildSheetProjection(rules, cloneCard(0), {});
  const hp = projection.resources.find((resource) => resource.id === 'hp');
  assert.equal(hp?.max, 18);
  assert.ok(projection.warnings.some((warning) => warning.includes('上限求值失败')));
});

test('投影：未知装备槽的实例被忽略并给 warning', () => {
  const card = cloneCard(0);
  card.equipmentInstances.push({ instanceId: 'ins_bad', slot: 'hat', name: '帽子', tags: ['misc'], stats: {} });
  const projection = buildSheetProjection(clonePack(), card, {});
  assert.ok(projection.warnings.some((warning) => warning.includes('未声明')));
  assert.ok(!projection.equipment.slots.some((slot) => slot.slotId === 'hat'));
});

test('投影：未知状态被忽略并给 warning', () => {
  const card = cloneCard(0);
  card.statuses.push({ id: 'burning', stacks: 1 });
  const projection = buildSheetProjection(clonePack(), card, {});
  assert.ok(projection.warnings.some((warning) => warning.includes('未在规则包声明')));
});

test('卡等级：fields.level 缺省/非法按 1', () => {
  assert.equal(cardLevel({ fields: {} }), 1);
  assert.equal(cardLevel({ fields: { level: 3 } }), 3);
  assert.equal(cardLevel({ fields: { level: 0 } }), 1);
});

test('投影：同一输入两次结果一致（确定性）', () => {
  const rules = clonePack();
  const card = cloneCard(0);
  const first = buildSheetProjection(rules, card, { 'mod.str': 3 });
  const second = buildSheetProjection(rules, card, { 'mod.str': 3 });
  assert.deepEqual(first, second);
});

test('投影：返回结构包含核心分组（values/resources/equipment/skills/actions/statuses/inventory）', () => {
  const projection = buildSheetProjection(clonePack(), cloneCard(1), {});
  assert.ok(Array.isArray(projection.attributes));
  assert.ok(Array.isArray(projection.resources));
  assert.ok(Array.isArray(projection.equipment.slots));
  assert.ok(Array.isArray(projection.equipment.statTotals));
  assert.ok(Array.isArray(projection.skills));
  assert.ok(Array.isArray(projection.actions));
  assert.ok(Array.isArray(projection.statuses));
  assert.ok(Array.isArray(projection.inventory.items));
});

test('卡实例类型：投影输入可来自迁移结果以外的合法卡（显式构造）', () => {
  const rules = clonePack();
  const card: CardInstance = {
    schemaVersion: 'trpg.card/1',
    cardId: 'card_min',
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    attributes: { str: 10, dex: 10, con: 10 },
    resources: { hp: { current: 5 } },
    fields: {},
    equipmentInstances: [],
    skills: [],
    statuses: [],
  };
  assert.deepEqual(validateCard(rules, card), []);
  const projection = buildSheetProjection(rules, card, {});
  assert.equal(projection.identity.level, 1);
});
