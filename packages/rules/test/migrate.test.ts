import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateLegacyCard,
  validateCard,
  SAMPLE_LEGACY_CARD,
  type LegacyCharacterCard,
  type RulePack,
} from '../src/index.ts';
import { clonePack, withPack } from './helpers.ts';

function cloneLegacy(): LegacyCharacterCard {
  return structuredClone(SAMPLE_LEGACY_CARD);
}

function migrate(legacy: unknown, rules: RulePack = clonePack()) {
  return migrateLegacyCard(legacy, rules);
}

test('迁移：旧卡成功迁移为 trpg.card/1', () => {
  const result = migrate(cloneLegacy());
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.errors.length, 0);
  assert.equal(result.card?.schemaVersion, 'trpg.card/1');
  assert.equal(result.card?.cardId, 'card_aqing');
  assert.equal(result.card?.rulesId, 'd20-mini');
  assert.equal(result.card?.rulesVersion, '1.0.0');
});

test('迁移：abilities → attributes', () => {
  const result = migrate(cloneLegacy());
  assert.deepEqual(result.card?.attributes, { str: 17, dex: 14, con: 15 });
});

test('迁移：combat.hpMax → resources.hp（current + max）', () => {
  const result = migrate(cloneLegacy());
  assert.deepEqual(result.card?.resources.hp, { current: 12, max: 12 });
});

test('迁移：identity.level 写进 fields.level', () => {
  const result = migrate(cloneLegacy());
  assert.equal(result.card?.fields.level, 1);
});

test('迁移：身份 / 摘要 / 外貌 / 性格 → fields', () => {
  const result = migrate(cloneLegacy());
  const fields = result.card?.fields;
  assert.equal(fields?.name, '阿青');
  assert.equal(fields?.race, '山民');
  assert.equal(fields?.class, '武者');
  assert.ok(String(fields?.background).includes('铁匠铺'));
  assert.ok(String(fields?.publicSummary).includes('背刀'));
  assert.ok(String(fields?.appearance).includes('短打'));
  assert.ok(String(fields?.personality).includes('护短'));
});

test('迁移：inventory → equipmentInstances（名称/词条/槽位尽量映射）', () => {
  const result = migrate(cloneLegacy());
  const instances = result.card?.equipmentInstances ?? [];
  assert.equal(instances.length, 5); // 横刀 1 + 铁甲 1 + 火折子 1 + 止血草 ×2
  const sword = instances.find((instance) => instance.slot === 'mainHand');
  assert.equal(sword?.name, '横刀');
  assert.deepEqual(sword?.stats, { 攻击: 2 });
  assert.ok(sword?.tags.includes('weapon:melee'));
  const armor = instances.find((instance) => instance.slot === 'body');
  assert.equal(armor?.name, '铁甲');
  assert.deepEqual(armor?.stats, { 防御: 2 });
  const herbs = instances.filter((instance) => instance.name === '止血草');
  assert.equal(herbs.length, 2);
  assert.ok(herbs[0]?.tags.includes('consumable:heal'));
  assert.equal(herbs[0]?.note, '恢复 1d4 生命');
});

test('迁移：proficiency.skills → skills[{ proficient }]', () => {
  const result = migrate(cloneLegacy());
  const skills = result.card?.skills ?? [];
  assert.deepEqual(skills, [
    { id: 'athletics', proficient: true, bonus: 0 },
    { id: 'stealth', proficient: false, bonus: 0 },
  ]);
});

test('迁移：无法映射的属性 / 技能 / 豁免熟练给 warning', () => {
  const result = migrate(cloneLegacy());
  const warnings = result.warnings.join('\n');
  assert.ok(warnings.includes('int'), warnings);
  assert.ok(warnings.includes('intimidation'), warnings);
  assert.ok(warnings.includes('豁免熟练'), warnings);
});

test('迁移：source → origin（保留旧引用）', () => {
  const result = migrate(cloneLegacy());
  assert.deepEqual(result.card?.origin, { packId: 'd20-mini', moduleId: 'guimuya' });
});

test('迁移：迁移结果通过 validateCard 校验', () => {
  const rules = clonePack();
  const result = migrate(cloneLegacy(), rules);
  assert.equal(result.ok, true);
  if (result.card === undefined) return;
  assert.deepEqual(validateCard(rules, result.card), []);
});

test('迁移：旧卡 schemaVersion 非 1 直接失败', () => {
  const legacy = cloneLegacy() as unknown as { schemaVersion: number };
  legacy.schemaVersion = 2;
  const result = migrate(legacy);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('schemaVersion')));
});

test('迁移：旧卡缺 abilities 直接失败', () => {
  const legacy = cloneLegacy() as unknown as { abilities?: unknown };
  delete legacy.abilities;
  const result = migrate(legacy);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('abilities')));
});

test('迁移：属性超出新规则范围时裁剪并 warning', () => {
  const legacy = cloneLegacy();
  legacy.abilities.str = 99;
  const result = migrate(legacy);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.card?.attributes.str, 18);
  assert.ok(result.warnings.some((warning) => warning.includes('裁剪')));
});

test('迁移：等级超过 maxLevel 时裁剪并 warning', () => {
  const legacy = cloneLegacy();
  legacy.identity.level = 99;
  const result = migrate(legacy);
  assert.equal(result.card?.fields.level, 5); // fixture maxLevel = 5
  assert.ok(result.warnings.some((warning) => warning.includes('maxLevel')));
});

test('迁移：非法等级按 1 级并 warning', () => {
  const legacy = cloneLegacy();
  legacy.identity.level = 0;
  const result = migrate(legacy);
  assert.equal(result.card?.fields.level, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('identity.level')));
});

test('迁移：规则包有 mana 资源时法术位折算为资源当前值', () => {
  const rules = withPack((pack) => {
    pack.sheet.resources.push({ id: 'mana', name: '真气', formula: '3' });
  });
  const legacy = cloneLegacy();
  legacy.spells = { ability: 'int', slots: { '1': 2, '2': 1 }, known: ['magic_missile'] };
  const result = migrate(legacy, rules);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.card?.resources.mana?.current, 3);
  assert.ok(result.warnings.some((warning) => warning.includes('法术位')));
  assert.ok(result.warnings.some((warning) => warning.includes('已知法术')));
});

test('迁移：规则包没有 mana 资源时法术位给 warning', () => {
  const legacy = cloneLegacy();
  legacy.spells = { ability: 'int', slots: { '1': 2 } };
  const result = migrate(legacy);
  assert.ok(result.warnings.some((warning) => warning.includes('法术位')));
});

test('迁移：无法映射的背包物品给 warning（规则包无物品库且无通配槽）', () => {
  const rules = withPack((pack) => {
    delete pack.items;
    pack.sheet.equipment.slots = pack.sheet.equipment.slots.filter((slot) => slot.id !== 'trinket');
  });
  const result = migrate(cloneLegacy(), rules);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.card?.equipmentInstances.length, 0);
  const warnings = result.warnings.join('\n');
  assert.ok(warnings.includes('无法映射'), warnings);
});

test('迁移：规则包有物品库时 inventory 词条按物品定义映射', () => {
  const result = migrate(cloneLegacy());
  const instances = result.card?.equipmentInstances ?? [];
  const sword = instances.find((instance) => instance.name === '横刀');
  assert.deepEqual(sword?.stats, { 攻击: 2 });
  assert.equal(sword?.note, '1d8 挥砍'); // 旧卡 effect 文本进备注
});

test('迁移：迁移是确定性的（同输入两次结果一致）', () => {
  const first = migrate(cloneLegacy());
  const second = migrate(cloneLegacy());
  assert.deepEqual(first, second);
});

test('迁移：旧卡无 hpMax 时生命按 0 并 warning', () => {
  const legacy = cloneLegacy();
  delete legacy.combat;
  const result = migrate(legacy);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.card?.resources.hp?.current, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('hpMax')));
});
