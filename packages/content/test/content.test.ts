import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCharacterCard, validateMonsterDef } from '@dsh-trpg/engine';
import {
  CARDS,
  CLASSES,
  GUIMUYA_LOREBOOK,
  GUIMUYA_MODULE,
  ITEMS,
  MONSTERS,
  RACES,
  RULE_ID,
  SPELLS,
  SPELL_BY_ID,
  validateLorebook,
  validateModule,
} from '../src/index.ts';

test('cards: all four pregens validate and have unique ids', () => {
  assert.equal(CARDS.length, 4);
  const ids = new Set<string>();
  for (const card of CARDS) {
    const report = validateCharacterCard(card);
    assert.equal(report.ok, true, `${card.id}: ${report.errors.join('; ')}`);
    assert.ok(!ids.has(card.id), `duplicate card id: ${card.id}`);
    ids.add(card.id);
  }
});

test('cards: spellcasters only know existing spells', () => {
  for (const card of CARDS) {
    for (const spellId of card.spells?.known ?? []) {
      assert.ok(SPELL_BY_ID[spellId], `${card.identity.name} 的法术 ${spellId} 不存在`);
    }
  }
});

test('rules data: 4 races, 4 classes, 15 spells, 12 monsters, 20 items, all valid', () => {
  assert.equal(RACES.length, 4);
  assert.equal(CLASSES.length, 4);
  assert.equal(SPELLS.length, 15);
  assert.equal(MONSTERS.length, 12);
  assert.equal(ITEMS.length, 20);

  for (const monster of MONSTERS) {
    const report = validateMonsterDef(monster);
    assert.equal(report.ok, true, `${monster.id}: ${report.errors.join('; ')}`);
  }
  const ids = new Set(MONSTERS.map((monster) => monster.id));
  assert.equal(ids.size, MONSTERS.length, '怪物 id 必须唯一');

  const spellIds = new Set(SPELLS.map((spell) => spell.id));
  assert.equal(spellIds.size, SPELLS.length, '法术 id 必须唯一');
  for (const spell of SPELLS) {
    assert.ok(spell.level >= 0 && spell.level <= 2);
    assert.ok(spell.effect.kind.length > 0);
  }
});

test('lorebook: validates, ids unique, visibility legal', () => {
  const report = validateLorebook(GUIMUYA_LOREBOOK);
  assert.equal(report.ok, true, report.errors.join('; '));
  const ids = new Set(GUIMUYA_LOREBOOK.entries.map((entry) => entry.id));
  assert.equal(ids.size, GUIMUYA_LOREBOOK.entries.length);
  for (const entry of GUIMUYA_LOREBOOK.entries) {
    assert.ok(entry.visibility === 'public' || entry.visibility === 'gm' || entry.visibility.startsWith('player:'));
  }
  assert.ok(GUIMUYA_LOREBOOK.entries.some((entry) => entry.visibility === 'gm'), '至少有一条 GM 秘密');
});

test('module: validates, 3 scenes, all monster/item/npc references resolve', () => {
  const report = validateModule(GUIMUYA_MODULE);
  assert.equal(report.ok, true, report.errors.join('; '));
  assert.equal(GUIMUYA_MODULE.ruleId, RULE_ID);
  assert.equal(GUIMUYA_MODULE.scenes.length, 3);

  const monsterIds = new Set(MONSTERS.map((monster) => monster.id));
  const itemIds = new Set(ITEMS.map((item) => item.id));
  const npcIds = new Set(GUIMUYA_MODULE.npcs.map((npc) => npc.id));

  for (const scene of GUIMUYA_MODULE.scenes) {
    for (const npcId of scene.npcs ?? []) assert.ok(npcIds.has(npcId), `场景 ${scene.id} 引用了不存在的 NPC：${npcId}`);
    for (const encounter of scene.encounters ?? []) {
      for (const group of encounter.monsters) {
        assert.ok(monsterIds.has(group.monsterId), `遭遇 ${encounter.id} 引用了不存在的怪物：${group.monsterId}`);
      }
    }
    for (const reward of scene.rewards ?? []) {
      for (const itemId of reward.items) assert.ok(itemIds.has(itemId), `场景 ${scene.id} 奖励了不存在的物品：${itemId}`);
    }
  }
});

test('module: every scene has entry narration and every check is a legal skill/DC', () => {
  for (const scene of GUIMUYA_MODULE.scenes) {
    assert.ok(scene.entry.length > 20, `场景 ${scene.id} 缺少开场旁白`);
    for (const check of scene.checks ?? []) {
      assert.ok(check.dc >= 5 && check.dc <= 25, `场景 ${scene.id} 的 DC 不合理：${check.dc}`);
      assert.ok(check.success && check.failure);
    }
  }
});
