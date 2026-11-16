/**
 * dnd5e-lite 数值对照测试的夹具（不是测试文件，不会被 `node --test` 直接执行）。
 *
 * 干什么：把**旧 engine 的角色卡**（`packages/content/cards/*.json`，schemaVersion 1）
 * 映射成新模型的卡实例（`trpg.card/1`），并给出「同一批骰面」的 engine 侧重放工具，
 * 让对照测试能对同一 (卡, 骰面) 分别跑旧实现与新规则包，逐项比较。
 *
 * 映射口径（在测试里断言）：
 * - 六属性 → `attributes`；`identity.level` → `fields.level`；职业 → `fields.hitDie`（生命骰）；
 * - `proficiency.skills` → 卡 `skills[]`（18 项全列，proficient 标记）；
 * - `combat.hpMax` → `resources.hp.current`（上限由公式 `hpMax` 重算，测试断言两者相等）；
 * - `spells.slots` → `resources.slot1/slot2`（上限由 `slot1Max/slot2Max` 重算）；
 * - `inventory` → `equipmentInstances`：按规则包 `items[]` 匹配名字、取词条/标签/槽位；
 *   同名物品只迁 1 件（v1 卡实例不存背包数量），槽位容量按规则包 `equipment.slots[].count`。
 *
 * 为什么不用 `migrateLegacyCard`（packages/rules/src/migrate.ts）：那是通用迁移器，
 * 不认识「职业→生命骰」「法术位分环」这类 dnd5e-lite 专属口径；本文件只服务对照测试。
 */
import {
  SKILL_ABILITY,
  combatantFromCard,
  type CharacterCard,
  type Combatant,
  type Rng,
  type SkillId,
} from '@dsh-trpg/engine';
import type { CardInstance, EquipmentInstanceDef } from '../src/rules-bridge.ts';
import { CARDS } from '../src/index.ts';
import { DND5E_LITE_ITEMS, DND5E_LITE_RULES } from '../src/rules-pack/index.ts';

/** 职业 → 生命骰面数（旧卡没有这条数据，对照测试按旧卡 HP 口径反推）。 */
export const HIT_DIE_BY_CLASS: Readonly<Record<string, number>> = {
  武者: 10,
  游侠: 10,
  术士: 6,
  方士: 8,
};

/** 旧卡 inventory 物品名 → 规则包 items[]（按名字匹配，名称是旧卡唯一稳定引用）。 */
const ITEM_BY_NAME = new Map(DND5E_LITE_ITEMS.map((item) => [item.name, item]));

function slotLimitOf(slotId: string): number {
  const slot = DND5E_LITE_RULES.sheet.equipment.slots.find((entry) => entry.id === slotId);
  return slot?.count ?? 1;
}

function slotAcceptsOf(slotId: string): string[] {
  const slot = DND5E_LITE_RULES.sheet.equipment.slots.find((entry) => entry.id === slotId);
  return slot?.accepts ?? [];
}

/** 旧卡 inventory → 新模型装备实例（守住槽位容量与标签白名单）。 */
export function equipmentInstancesOf(card: CharacterCard): EquipmentInstanceDef[] {
  const instances: EquipmentInstanceDef[] = [];
  const seenNames = new Set<string>();
  const usage = new Map<string, number>();
  for (const entry of card.inventory) {
    if (seenNames.has(entry.name)) continue;
    const item = ITEM_BY_NAME.get(entry.name);
    const slotId = item?.equipSlot?.[0];
    if (item === undefined || slotId === undefined) continue;
    const tags = item.tags ?? [];
    const accepts = slotAcceptsOf(slotId);
    if (!(accepts.includes('*') || tags.some((tag) => accepts.includes(tag)))) continue;
    const used = usage.get(slotId) ?? 0;
    if (used >= slotLimitOf(slotId)) continue;
    usage.set(slotId, used + 1);
    seenNames.add(entry.name);
    instances.push({
      instanceId: `ins_${instances.length + 1}`,
      slot: slotId,
      name: item.name,
      tags: [...tags],
      stats: { ...(item.stats ?? {}) },
      ...(entry.effect !== undefined ? { note: entry.effect } : {}),
    });
  }
  return instances;
}

export interface ToRulesCardOptions {
  /** 覆盖等级（默认取旧卡 identity.level）。 */
  level?: number;
  /** 覆盖职业生命骰（默认按 `HIT_DIE_BY_CLASS`）。 */
  hitDie?: number;
  /** 覆盖部分字段（测试构造边界卡时用）。 */
  fields?: Record<string, string | number>;
  resources?: CardInstance['resources'];
  attributes?: Record<string, number>;
  equipmentInstances?: EquipmentInstanceDef[];
  skills?: CardInstance['skills'];
}

/** 旧 engine 角色卡 → 新模型卡实例（`trpg.card/1`）。 */
export function toRulesCard(card: CharacterCard, options: ToRulesCardOptions = {}): CardInstance {
  const level = options.level ?? card.identity.level;
  const hitDie = options.hitDie ?? HIT_DIE_BY_CLASS[card.identity.class] ?? 8;
  const slots = card.spells?.slots ?? {};
  const slot1 = typeof slots['1'] === 'number' ? slots['1'] : 0;
  const slot2 = typeof slots['2'] === 'number' ? slots['2'] : 0;
  // 施法等级：旧卡有 spells 段即按角色等级算（法术位上限口径见 rules 的 slot1Max/slot2Max）
  const casterLevel = card.spells !== undefined ? level : 0;
  const skills: CardInstance['skills'] = Object.keys(SKILL_ABILITY).map((skillId) => ({
    id: skillId,
    proficient: card.proficiency.skills.includes(skillId as SkillId),
    bonus: 0,
  }));
  return {
    schemaVersion: 'trpg.card/1',
    cardId: card.id,
    rulesId: DND5E_LITE_RULES.rulesId,
    rulesVersion: DND5E_LITE_RULES.rulesVersion,
    attributes: { ...card.abilities, ...(options.attributes ?? {}) },
    resources: options.resources ?? {
      hp: { current: card.combat.hpMax },
      slot1: { current: slot1 },
      slot2: { current: slot2 },
    },
    fields: {
      name: card.identity.name,
      race: card.identity.race,
      class: card.identity.class,
      background: card.identity.background ?? '',
      publicSummary: card.publicSummary,
      ...(card.appearance !== undefined ? { appearance: card.appearance } : {}),
      ...(card.personality !== undefined ? { personality: card.personality } : {}),
      level,
      xp: 0,
      skillPoints: 0,
      hitDie,
      casterLevel,
      alignment: '中立',
      ...(options.fields ?? {}),
    },
    equipmentInstances: options.equipmentInstances ?? equipmentInstancesOf(card),
    skills: options.skills ?? skills,
    statuses: [],
  };
}

/** 四张内置预置卡对应的新模型卡实例（对照测试的主要输入）。 */
export const PRESET_HEROES: readonly { engine: CharacterCard; rules: CardInstance }[] = CARDS.map((card) => ({
  engine: card,
  rules: toRulesCard(card),
}));

/** 造一张旧 engine 卡（测试里构造木桩/合成角色用）。 */
export function engineCard(overrides: {
  id: string;
  name?: string;
  level?: number;
  class?: string;
  abilities: Record<string, number>;
  hpMax: number;
  ac: number;
  proficiencyBonus?: number;
  skills?: string[];
  attacks?: CharacterCard['combat']['attacks'];
}): CharacterCard {
  return {
    schemaVersion: 1,
    id: overrides.id,
    identity: {
      name: overrides.name ?? overrides.id,
      race: '测试',
      class: overrides.class ?? '武者',
      level: overrides.level ?? 1,
    },
    abilities: {
      str: overrides.abilities.str ?? 10,
      dex: overrides.abilities.dex ?? 10,
      con: overrides.abilities.con ?? 10,
      int: overrides.abilities.int ?? 10,
      wis: overrides.abilities.wis ?? 10,
      cha: overrides.abilities.cha ?? 10,
    },
    proficiency: {
      bonus: overrides.proficiencyBonus ?? 2,
      skills: (overrides.skills ?? []) as CharacterCard['proficiency']['skills'],
      saves: [],
    },
    combat: {
      ac: overrides.ac,
      hpMax: overrides.hpMax,
      attacks: overrides.attacks ?? [
        { name: '拳', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' },
      ],
    },
    inventory: [],
    publicSummary: '测试角色',
  };
}

/** engine 侧的 Combatant（从角色卡构造；id 与规则运行时 actorId 对齐）。 */
export function engineCombatant(card: CharacterCard, id = card.id): Combatant {
  return { ...combatantFromCard(card, { id }) };
}

export interface EngineCombatStateOptions {
  range?: Combatant['range'];
}

/** engine 侧单次攻击用的最小 CombatState（economy 全新、无日志、种子无关——骰面由 rng 注入）。 */
export function engineCombatState(attacker: Combatant, target: Combatant, options: EngineCombatStateOptions = {}) {
  return {
    participants: [attacker, target],
    order: [attacker.id, target.id],
    activeIndex: 0,
    round: 1,
    range: options.range ?? 'near',
    economy: { action: false, bonus: false, reaction: false, movement: 0 },
    log: [],
    seed: 0,
    rollIndex: 0,
  };
}

/**
 * 固定骰面重放 RNG：按传入的骰面数组依次返回 `face-1`，
 * 用来让旧 engine 实现「吃」新规则运行时实际掷出的骰面（同一批骰子跑两套实现）。
 */
export function replayRng(faces: readonly number[]): Rng & { consumed(): number } {
  let index = 0;
  return {
    nextInt(maxExclusive: number): number {
      const face = faces[index];
      index += 1;
      if (face === undefined) throw new RangeError(`重放骰面用尽（还差一次 d${maxExclusive}）`);
      return Math.min(face, maxExclusive) - 1;
    },
    nextFloat(): number {
      throw new Error('对照测试不需要 nextFloat');
    },
    state(): number {
      return index;
    },
    consumed(): number {
      return index;
    },
  };
}

/** 取一次 `runtime.rollCheck` / `runtime.useAction` 结果里记录的骰面（按掷骰顺序）。 */
export function diceFacesOf(rolls: readonly { dice: number[] }[]): number[] {
  const faces: number[] = [];
  for (const roll of rolls) for (const die of roll.dice) faces.push(die);
  return faces;
}
