/**
 * 玩家本地角色卡库（纯函数，可单测）。
 *
 * 设计（DESIGN §6.1「玩家本地为真源」）：
 * - 卡保存在玩家自己的浏览器存储里，可导入/导出 JSON；
 * - 落座时把卡上传给房间（服务端校验）；
 * - 散团后把 GM 发的 XP/物品合并回本地卡（物品进背包，XP 累计在成长档案里）。
 */
import {
  ABILITIES,
  SKILL_ABILITY,
  SKILL_NAME,
  validateCharacterCard,
  type Ability,
  type CharacterCard,
  type SkillId,
} from '@dsh-trpg/engine';

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

// ---------------------------------------------------------------------------
// 本地卡新建 / 编辑（M9.6b 最小表单：名字/种族/职业/等级/六属性/技能熟练/叙事字段）
// ---------------------------------------------------------------------------

/** 本地卡表单（工坊「角色卡」页：新建/编辑玩家本地卡）。 */
export interface LocalCardForm {
  name: string;
  race: string;
  class: string;
  level: number;
  abilities: Record<Ability, number>;
  /** 已熟练的技能（engine 18 个 d20 技能里选）。 */
  skills: SkillId[];
  appearance: string;
  personality: string;
  publicSummary: string;
}

/** d20 属性顺序（表单渲染用）。 */
export const LOCAL_CARD_ABILITY_IDS: readonly Ability[] = ABILITIES;
/** 技能 id → 中文名（表单展示用）。 */
export const LOCAL_CARD_SKILL_NAMES: Readonly<Record<string, string>> = SKILL_NAME;

function abilityModifier(score: number): number {
  return Math.floor((Math.max(1, Math.min(30, Math.trunc(score))) - 10) / 2);
}

function proficiencyBonusOf(level: number): number {
  return Math.max(2, Math.min(9, 2 + Math.floor((Math.max(1, Math.min(20, Math.trunc(level))) - 1) / 4)));
}

/** 空白本地卡表单（六属性 10、1 级、无技能）。 */
export function emptyLocalCardForm(): LocalCardForm {
  return {
    name: '新角色',
    race: '人类',
    class: '冒险者',
    level: 1,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    skills: [],
    appearance: '',
    personality: '',
    publicSummary: '',
  };
}

/**
 * 表单 → engine 角色卡（`trpg.card` 旧形状，本地卡库/落座沿用）。
 * 派生值只做「能让卡合法」的最小计算（AC/HP/先攻），规则权威仍由房间主机投影。
 */
function buildCharacterCardFromForm(form: LocalCardForm, id: string): CharacterCard {
  const level = Math.max(1, Math.min(20, Math.trunc(form.level)));
  const scores: Record<Ability, number> = {
    str: Math.trunc(form.abilities.str),
    dex: Math.trunc(form.abilities.dex),
    con: Math.trunc(form.abilities.con),
    int: Math.trunc(form.abilities.int),
    wis: Math.trunc(form.abilities.wis),
    cha: Math.trunc(form.abilities.cha),
  };
  const skills = form.skills.filter((skill): skill is SkillId => skill in SKILL_ABILITY);
  const attackAbility: Ability = 'str';
  const attackName = `${form.class.trim() || '冒险者'}武器`;
  return {
    schemaVersion: 1,
    id,
    identity: {
      name: form.name.trim(),
      race: form.race.trim(),
      class: form.class.trim(),
      level,
    },
    abilities: scores,
    proficiency: { bonus: proficiencyBonusOf(level), skills, saves: [] },
    combat: {
      ac: Math.max(1, Math.min(40, 10 + abilityModifier(scores.dex))),
      hpMax: Math.max(1, Math.min(999, 8 + abilityModifier(scores.con) + (level - 1) * 5)),
      initiativeBonus: abilityModifier(scores.dex),
      attacks: [
        {
          name: attackName,
          ability: attackAbility,
          proficient: true,
          damage: '1d6',
          range: 'engaged',
        },
      ],
    },
    inventory: [],
    publicSummary: form.publicSummary.trim(),
    ...(form.appearance.trim().length > 0 ? { appearance: form.appearance.trim() } : {}),
    ...(form.personality.trim().length > 0 ? { personality: form.personality.trim() } : {}),
  };
}

/** 表单 → 新本地卡（新 id）；失败给可读中文（空名字/等级越界等）。 */
export function createLocalCardFromForm(
  form: LocalCardForm,
  now: number = Date.now(),
): { ok: boolean; errors: string[]; record?: LocalCardRecord } {
  const errors: string[] = [];
  if (form.name.trim().length === 0) errors.push('名字不能为空');
  if (form.race.trim().length === 0) errors.push('种族不能为空');
  if (form.class.trim().length === 0) errors.push('职业不能为空');
  if (!Number.isInteger(form.level) || form.level < 1 || form.level > 20) errors.push('等级必须是 1–20 的整数');
  for (const ability of ABILITIES) {
    const value = form.abilities[ability];
    if (!Number.isInteger(value) || value < 1 || value > 30) errors.push(`属性 ${ability.toUpperCase()} 必须是 1–30 的整数`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const card = buildCharacterCardFromForm(form, makeCardId(now));
  const report = validateCharacterCard(card);
  if (!report.ok || !report.value) return { ok: false, errors: report.errors };
  return {
    ok: true,
    errors: [],
    record: { card: report.value, origin: 'import', createdAt: now, updatedAt: now },
  };
}

/** 表单 → 替换既有本地卡（保留 id；`origin` 不变）；失败给可读中文。 */
export function updateLocalCardFromForm(
  record: LocalCardRecord,
  form: LocalCardForm,
  now: number = Date.now(),
): { ok: boolean; errors: string[]; record?: LocalCardRecord } {
  const built = createLocalCardFromForm(form, now);
  if (!built.ok || built.record === undefined) return { ok: false, errors: built.errors };
  return {
    ok: true,
    errors: [],
    record: { ...record, card: { ...built.record.card, id: record.card.id }, updatedAt: now },
  };
}

/** 本地卡 → 表单回填（编辑入口用）。 */
export function localCardFormOf(card: CharacterCard): LocalCardForm {
  const skills = card.proficiency.skills.filter((skill): skill is SkillId => skill in SKILL_ABILITY);
  return {
    name: card.identity.name,
    race: card.identity.race,
    class: card.identity.class,
    level: card.identity.level,
    abilities: { ...card.abilities },
    skills: [...skills],
    appearance: card.appearance ?? '',
    personality: card.personality ?? '',
    publicSummary: card.publicSummary ?? '',
  };
}
