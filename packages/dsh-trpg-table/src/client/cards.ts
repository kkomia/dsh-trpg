/**
 * 玩家本地角色卡库（纯函数，可单测）。
 *
 * 设计（DESIGN §6.1「玩家本地为真源」）：
 * - 卡保存在玩家自己的浏览器存储里，可导入/导出 JSON；
 * - 落座时把卡上传给房间（服务端校验）；
 * - 散团后把 GM 发的 XP/物品合并回本地卡（物品进背包，XP 累计在成长档案里）。
 */
import { validateCharacterCard, type CharacterCard } from '@dsh-trpg/engine';

export interface LocalCardRecord {
  card: CharacterCard;
  origin: 'import' | 'pregen-copy';
  createdAt: number;
  updatedAt: number;
}

const CARDS_KEY = 'dsh-trpg:cards:v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storageOf(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  const candidate = (globalThis as { localStorage?: Storage }).localStorage;
  return candidate ?? null;
}

function makeCardId(now: number): string {
  const hex = Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  return `card_${now}_${hex}`;
}

export function loadLocalCards(storage?: StorageLike | null): LocalCardRecord[] {
  try {
    const raw = storageOf(storage)?.getItem(CARDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is LocalCardRecord => {
      if (!entry || typeof entry !== 'object') return false;
      const record = entry as LocalCardRecord;
      return Boolean(record.card) && validateCharacterCard(record.card).ok;
    });
  } catch {
    return [];
  }
}

export function saveLocalCards(records: LocalCardRecord[], storage?: StorageLike | null): void {
  try {
    storageOf(storage)?.setItem(CARDS_KEY, JSON.stringify(records));
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 导入角色卡 JSON；返回人性化错误。 */
export function importCard(
  text: string,
  now: number = Date.now(),
): { ok: boolean; errors: string[]; record?: LocalCardRecord } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['不是合法的 JSON 文本'] };
  }
  const report = validateCharacterCard(parsed);
  if (!report.ok || !report.value) return { ok: false, errors: report.errors };
  const record: LocalCardRecord = {
    card: report.value,
    origin: 'import',
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, errors: [], record };
}

/** 把预制卡复制成本地卡（新 id，避免与卡库里的旧卡冲突）。 */
export function copyFromPregen(pregen: CharacterCard, now: number = Date.now()): LocalCardRecord {
  const card: CharacterCard = { ...pregen, id: makeCardId(now), inventory: pregen.inventory.map((item) => ({ ...item })) };
  return { card, origin: 'pregen-copy', createdAt: now, updatedAt: now };
}

/** 把成长物品合并进本地卡（按名字叠数量），返回合并后的新卡。 */
export function mergeGrowthIntoCard(
  card: CharacterCard,
  items: string[],
  now: number = Date.now(),
): { card: CharacterCard; addedItems: string[] } {
  const inventory = card.inventory.map((item) => ({ ...item }));
  const addedItems: string[] = [];
  for (const name of items) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const existing = inventory.find((item) => item.name === trimmed);
    if (existing) {
      existing.qty += 1;
    } else {
      inventory.push({ name: trimmed, qty: 1, effect: 'GM 奖励' });
    }
    addedItems.push(trimmed);
  }
  return { card: { ...card, inventory }, addedItems };
}

/** 导出为可再次导入的 JSON 文本。 */
export function exportCardText(card: CharacterCard): string {
  return JSON.stringify(card, null, 2);
}

/** 校验并替换本地卡库中的一张卡（按 id）；返回新数组。 */
export function upsertLocalCard(records: LocalCardRecord[], record: LocalCardRecord): LocalCardRecord[] {
  const index = records.findIndex((entry) => entry.card.id === record.card.id);
  if (index < 0) return [...records, record];
  const next = [...records];
  next[index] = record;
  return next;
}

export function removeLocalCard(records: LocalCardRecord[], cardId: string): LocalCardRecord[] {
  return records.filter((entry) => entry.card.id !== cardId);
}
