import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS } from '@dsh-trpg/content';
import {
  copyFromPregen,
  exportCardText,
  importCard,
  loadLocalCards,
  mergeGrowthIntoCard,
  removeLocalCard,
  saveLocalCards,
  upsertLocalCard,
} from '../src/client/cards.ts';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    size: () => store.size,
  };
}

test('importCard: 合法卡通过，坏 JSON / 坏字段给出人性化错误', () => {
  const ok = importCard(JSON.stringify(CARDS[0]!));
  assert.equal(ok.ok, true);
  assert.equal(ok.record?.origin, 'import');
  assert.equal(importCard('{bad json').ok, false);
  const invalid = importCard(JSON.stringify({ schemaVersion: 1 }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length > 0);
});

test('copyFromPregen: 生成新 id 且卡内容合法', () => {
  const record = copyFromPregen(CARDS[0]!, 1700000000000);
  assert.notEqual(record.card.id, CARDS[0]?.id);
  assert.ok(record.card.id.startsWith('card_1700000000000_'));
  assert.equal(record.origin, 'pregen-copy');
  assert.equal(record.card.identity.name, CARDS[0]?.identity.name);
});

test('mergeGrowthIntoCard: 物品叠数量、新物品进背包、原卡不变', () => {
  const card = CARDS[0];
  assert.ok(card);
  const existingName = card.inventory[0]?.name ?? '止血草';
  const merged = mergeGrowthIntoCard(card, [existingName, '镇魂符', '镇魂符', ''], 1700000001000);
  const before = card.inventory.find((item) => item.name === existingName)?.qty ?? 0;
  const after = merged.card.inventory.find((item) => item.name === existingName)?.qty ?? 0;
  assert.equal(after, before + 1);
  assert.equal(merged.card.inventory.find((item) => item.name === '镇魂符')?.qty, 2);
  assert.equal(merged.addedItems.length, 3);
  assert.equal(card.inventory.find((item) => item.name === '镇魂符'), undefined, '原卡不应被修改');
});

test('本地卡库: 保存/读取/替换/删除/导出可用', () => {
  const storage = memoryStorage();
  const record = copyFromPregen(CARDS[1]!, 1700000002000);
  saveLocalCards([record], storage);
  const loaded = loadLocalCards(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.card.id, record.card.id);

  const merged = mergeGrowthIntoCard(record.card, ['灵酒']);
  const updated = upsertLocalCard(loaded, { ...record, card: merged.card, updatedAt: 1700000003000 });
  assert.equal(updated.length, 1);
  assert.ok(updated[0]?.card.inventory.some((item) => item.name === '灵酒'));

  const exported = exportCardText(updated[0]!.card);
  const reimported = importCard(exported);
  assert.equal(reimported.ok, true);
  assert.equal(reimported.record?.card.id, record.card.id);

  assert.equal(removeLocalCard(updated, record.card.id).length, 0);
});
