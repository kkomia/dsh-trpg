/**
 * 检定与派生数值：等级→熟练加值、属性调整、技能/豁免检定、施法 DC。
 */
import { rollCheck, type CheckMode, type CheckResult } from './dice.ts';
import { SKILL_ABILITY, type Ability, type AbilityScores, type SkillId } from './types.ts';

export function proficiencyBonus(level: number): number {
  if (!Number.isInteger(level) || level < 1) throw new RangeError(`level must be >= 1, got ${level}`);
  return 2 + Math.floor((Math.min(level, 20) - 1) / 4);
}

export function abilityMod(score: number): number {
  if (!Number.isInteger(score)) throw new RangeError(`ability score must be an integer, got ${score}`);
  return Math.floor((score - 10) / 2);
}

export function abilityMods(scores: AbilityScores): Record<Ability, number> {
  return {
    str: abilityMod(scores.str),
    dex: abilityMod(scores.dex),
    con: abilityMod(scores.con),
    int: abilityMod(scores.int),
    wis: abilityMod(scores.wis),
    cha: abilityMod(scores.cha),
  };
}

export interface ProficientSkills {
  proficiency: number;
  skills: SkillId[];
  saves: Ability[];
}

/** 技能检定加值 = 属性调整 + 熟练（若熟练）。 */
export function skillBonus(profile: ProficientSkills, abilities: AbilityScores, skill: SkillId): number {
  const base = abilityMod(abilities[SKILL_ABILITY[skill]]);
  return base + (profile.skills.includes(skill) ? profile.proficiency : 0);
}

/** 豁免加值 = 属性调整 + 熟练（若熟练）。 */
export function saveBonus(profile: ProficientSkills, abilities: AbilityScores, ability: Ability): number {
  const base = abilityMod(abilities[ability]);
  return base + (profile.saves.includes(ability) ? profile.proficiency : 0);
}

export interface CheckOutcome extends CheckResult {
  skill: SkillId;
  bonus: number;
}

/** 技能检定。 */
export function rollSkillCheck(
  profile: ProficientSkills,
  abilities: AbilityScores,
  skill: SkillId,
  dc: number,
  rng: { nextInt(maxExclusive: number): number },
  mode: CheckMode = 'normal',
): CheckOutcome {
  const bonus = skillBonus(profile, abilities, skill);
  const result = rollCheck({ modifier: bonus, dc, mode }, rng);
  return { ...result, skill, bonus };
}

/** 豁免检定。 */
export function rollSave(
  profile: ProficientSkills,
  abilities: AbilityScores,
  ability: Ability,
  dc: number,
  rng: { nextInt(maxExclusive: number): number },
  mode: CheckMode = 'normal',
): CheckResult & { ability: Ability; bonus: number } {
  const bonus = saveBonus(profile, abilities, ability);
  const result = rollCheck({ modifier: bonus, dc, mode }, rng);
  return { ...result, ability, bonus };
}

/** 施法检定/豁免 DC = 8 + 熟练 + 施法属性调整。 */
export function spellSaveDC(castingAbility: Ability, abilities: AbilityScores, proficiency: number): number {
  return 8 + proficiency + abilityMod(abilities[castingAbility]);
}

/** 攻击命中加值 = 属性调整 + 熟练（若熟练）。 */
export function attackBonus(abilities: AbilityScores, proficiency: number, ability: Ability, proficient: boolean): number {
  return abilityMod(abilities[ability]) + (proficient ? proficiency : 0);
}
