/**
 * D&D 5e-lite 核心类型（引擎与内容包共用的契约）。
 *
 * 设计原则（见 docs/DESIGN.md §4）：状态由引擎持有，AI 只能通过带校验的工具请求变更；
 * 因此这里的类型既要能表达角色卡，也要能表达战斗态。
 */

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';

export type AbilityScores = Record<Ability, number>;

export const ABILITIES: readonly Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

interface SkillAbilityMap {
  athletics: 'str';
  acrobatics: 'dex';
  sleight_of_hand: 'dex';
  stealth: 'dex';
  arcana: 'int';
  history: 'int';
  investigation: 'int';
  nature: 'int';
  religion: 'int';
  animal_handling: 'wis';
  insight: 'wis';
  medicine: 'wis';
  perception: 'wis';
  survival: 'wis';
  deception: 'cha';
  intimidation: 'cha';
  performance: 'cha';
  persuasion: 'cha';
}

export type SkillId = keyof SkillAbilityMap;

export const SKILL_ABILITY: Record<SkillId, Ability> = {
  athletics: 'str',
  acrobatics: 'dex',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  arcana: 'int',
  history: 'int',
  investigation: 'int',
  nature: 'int',
  religion: 'int',
  animal_handling: 'wis',
  insight: 'wis',
  medicine: 'wis',
  perception: 'wis',
  survival: 'wis',
  deception: 'cha',
  intimidation: 'cha',
  performance: 'cha',
  persuasion: 'cha',
};

/** 中文技能名，用于战报与 GM 提示。 */
export const SKILL_NAME: Record<SkillId, string> = {
  athletics: '运动',
  acrobatics: '体操',
  sleight_of_hand: '巧手',
  stealth: '隐匿',
  arcana: '奥秘',
  history: '历史',
  investigation: '调查',
  nature: '自然',
  religion: '宗教',
  animal_handling: '驯兽',
  insight: '洞悉',
  medicine: '医药',
  perception: '察觉',
  survival: '生存',
  deception: '欺瞒',
  intimidation: '威吓',
  performance: '表演',
  persuasion: '游说',
};

/** 距离档位：v1 用 theater-of-mind，不做格子地图。 */
export type RangeBand = 'engaged' | 'near' | 'far';

export const RANGE_NAME: Record<RangeBand, string> = {
  engaged: '接触',
  near: '近距',
  far: '远距',
};

/** v1 支持的八种状态。 */
export type Condition =
  | 'poisoned'
  | 'prone'
  | 'frightened'
  | 'restrained'
  | 'blinded'
  | 'incapacitated'
  | 'invisible'
  | 'hasted';

export const CONDITION_NAME: Record<Condition, string> = {
  poisoned: '中毒',
  prone: '倒地',
  frightened: '恐惧',
  restrained: '束缚',
  blinded: '目盲',
  incapacitated: '失能',
  invisible: '隐身',
  hasted: '加速',
};

export interface AttackProfile {
  name: string;
  ability: Ability;
  proficient: boolean;
  /** 伤害骰表达式，例如 `1d8`；属性加值由引擎换算后相加。 */
  damage: string;
  range: RangeBand;
  damageType?: string;
  note?: string;
}

export type SpellSchool = '道术' | '咒术' | '医术' | '符箓';

export type SpellEffect =
  | { kind: 'damage'; dice: string; saveAbility: Ability; halfOnSave: boolean }
  | { kind: 'heal'; dice: string; addCastingMod: boolean }
  | { kind: 'condition'; condition: Condition; rounds: number; saveAbility: Ability }
  | { kind: 'utility'; note: string };

export interface SpellDef {
  id: string;
  name: string;
  level: 0 | 1 | 2;
  school: SpellSchool;
  castingTime: 'action' | 'bonus';
  /** 目标距离限制；`self` 表示只对自己。 */
  range: RangeBand | 'self';
  effect: SpellEffect;
  desc: string;
}

export interface SpellSlots {
  max: Record<number, number>;
  current: Record<number, number>;
}

export interface Spellcasting {
  ability: Ability;
  slots: SpellSlots;
  known: string[];
}

export interface ActiveEffect {
  condition: Condition;
  /** 剩余回合数；-1 表示直到被移除。 */
  roundsLeft: number;
}

export interface Combatant {
  id: string;
  name: string;
  kind: 'pc' | 'monster';
  abilities: AbilityScores;
  proficiency: number;
  saves: Ability[];
  ac: number;
  hp: { max: number; current: number; temp: number };
  conditions: Condition[];
  effects: ActiveEffect[];
  attacks: AttackProfile[];
  spellcasting?: Spellcasting;
  initiativeBonus: number;
  range: RangeBand;
  downed: boolean;
  dead: boolean;
  deathSaves?: { successes: number; failures: number };
  notes?: string;
}

export interface CharacterCard {
  schemaVersion: 1;
  id: string;
  identity: { name: string; race: string; class: string; level: number; background?: string };
  owner?: { playerId?: string; displayName?: string };
  abilities: AbilityScores;
  proficiency: { bonus: number; skills: SkillId[]; saves: Ability[] };
  combat: {
    ac: number;
    hpMax: number;
    initiativeBonus?: number;
    attacks: AttackProfile[];
  };
  spells?: { ability: Ability; slots: Record<string, number>; known: string[] };
  inventory: Array<{ name: string; qty: number; effect?: string }>;
  publicSummary: string;
  appearance?: string;
  personality?: string;
  source?: { ruleId: string; ruleVersion: string; moduleId?: string | null };
}

export interface MonsterDef {
  id: string;
  name: string;
  cr: number;
  ac: number;
  hpMax: number;
  abilities: AbilityScores;
  saves?: Ability[];
  proficiency?: number;
  attacks: AttackProfile[];
  initiativeBonus?: number;
  traits?: string[];
  description?: string;
}

export interface RaceDef {
  id: string;
  name: string;
  bonuses: Partial<AbilityScores>;
  traits: string[];
}

export interface ClassDef {
  id: string;
  name: string;
  hpBase: number;
  primary: Ability;
  saves: Ability[];
  skills: SkillId[];
  spellcasting?: Ability;
  attacks: AttackProfile[];
}

export interface ItemDef {
  id: string;
  name: string;
  kind: 'weapon' | 'armor' | 'consumable' | 'tool' | 'treasure';
  effect: string;
  value?: number;
}
