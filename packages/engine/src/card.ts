/**
 * 角色卡 / 怪物数据的运行时校验。
 *
 * 为什么手写校验：玩家端与房主端可能版本不一致，服务端收到卡必须能给出人话错误，
 * 而不是把坏数据塞进引擎。后续会导出 JSON Schema，这里保持零依赖。
 */
import { ABILITIES, SKILL_ABILITY, type Ability, type CharacterCard, type MonsterDef, type SkillId } from './types.ts';

export interface ValidationReport<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isAbility(value: unknown): value is Ability {
  return typeof value === 'string' && (ABILITIES as readonly string[]).includes(value);
}

export function isSkillId(value: unknown): value is SkillId {
  return typeof value === 'string' && Object.hasOwn(SKILL_ABILITY, value);
}

export function validateCharacterCard(input: unknown): ValidationReport<CharacterCard> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['角色卡必须是对象'] };
  if (input.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (typeof input.id !== 'string' || input.id.length === 0) errors.push('id 必填');

  const identity = input.identity;
  if (!isRecord(identity)) {
    errors.push('identity 必填');
  } else {
    if (typeof identity.name !== 'string' || !identity.name) errors.push('identity.name 必填');
    if (typeof identity.race !== 'string' || !identity.race) errors.push('identity.race 必填');
    if (typeof identity.class !== 'string' || !identity.class) errors.push('identity.class 必填');
    if (!isInt(identity.level, 1, 20)) errors.push('identity.level 必须是 1-20 的整数');
  }

  const abilities = input.abilities;
  if (!isRecord(abilities)) {
    errors.push('abilities 必填');
  } else {
    for (const ability of ABILITIES) {
      if (!isInt(abilities[ability], 1, 30)) errors.push(`abilities.${ability} 必须是 1-30 的整数`);
    }
  }

  const proficiency = input.proficiency;
  if (!isRecord(proficiency)) {
    errors.push('proficiency 必填');
  } else {
    if (!isInt(proficiency.bonus, 0, 9)) errors.push('proficiency.bonus 必须是 0-9 的整数');
    if (!Array.isArray(proficiency.skills) || proficiency.skills.some((skill) => !isSkillId(skill))) {
      errors.push('proficiency.skills 必须是合法技能 id 数组');
    }
    if (!Array.isArray(proficiency.saves) || proficiency.saves.some((ability) => !isAbility(ability))) {
      errors.push('proficiency.saves 必须是合法属性数组');
    }
  }

  const combat = input.combat;
  if (!isRecord(combat)) {
    errors.push('combat 必填');
  } else {
    if (!isInt(combat.ac, 1, 40)) errors.push('combat.ac 必须是 1-40 的整数');
    if (!isInt(combat.hpMax, 1, 999)) errors.push('combat.hpMax 必须是正整数');
    if (combat.initiativeBonus !== undefined && !isInt(combat.initiativeBonus, -10, 20)) {
      errors.push('combat.initiativeBonus 必须是 -10..20 的整数');
    }
    if (!Array.isArray(combat.attacks) || combat.attacks.length === 0) {
      errors.push('combat.attacks 至少需要一条');
    } else {
      combat.attacks.forEach((attack, index) => {
        if (!isRecord(attack)) {
          errors.push(`combat.attacks[${index}] 必须是对象`);
          return;
        }
        if (typeof attack.name !== 'string' || !attack.name) errors.push(`combat.attacks[${index}].name 必填`);
        if (!isAbility(attack.ability)) errors.push(`combat.attacks[${index}].ability 非法`);
        if (typeof attack.damage !== 'string' || !/^\d+d\d+([+-]\d+)?$/i.test(attack.damage)) {
          errors.push(`combat.attacks[${index}].damage 必须是 XdY 形式`);
        }
        if (attack.range !== 'engaged' && attack.range !== 'near' && attack.range !== 'far') {
          errors.push(`combat.attacks[${index}].range 非法`);
        }
      });
    }
  }

  const spells = input.spells;
  if (spells !== undefined) {
    if (!isRecord(spells)) {
      errors.push('spells 必须是对象');
    } else {
      if (!isAbility(spells.ability)) errors.push('spells.ability 非法');
      if (!isRecord(spells.slots)) errors.push('spells.slots 必须是对象');
      if (!Array.isArray(spells.known) || spells.known.some((id) => typeof id !== 'string')) {
        errors.push('spells.known 必须是法术 id 数组');
      }
    }
  }

  if (!Array.isArray(input.inventory)) errors.push('inventory 必须是数组');
  if (typeof input.publicSummary !== 'string') errors.push('publicSummary 必须是字符串');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], value: input as unknown as CharacterCard };
}

export function validateMonsterDef(input: unknown): ValidationReport<MonsterDef> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['怪物必须是对象'] };
  if (typeof input.id !== 'string' || !input.id) errors.push('id 必填');
  if (typeof input.name !== 'string' || !input.name) errors.push('name 必填');
  if (typeof input.cr !== 'number' || !Number.isFinite(input.cr) || input.cr < 0 || input.cr > 30) {
    errors.push('cr 必须是 0-30 的数字（可含 0.125/0.25/0.5 这类分数）');
  }
  if (!isInt(input.ac, 1, 40)) errors.push('ac 必须是 1-40 的整数');
  if (!isInt(input.hpMax, 1, 999)) errors.push('hpMax 必须是正整数');
  const abilities = input.abilities;
  if (!isRecord(abilities)) {
    errors.push('abilities 必填');
  } else {
    for (const ability of ABILITIES) {
      if (!isInt(abilities[ability], 1, 30)) errors.push(`abilities.${ability} 必须是 1-30 的整数`);
    }
  }
  if (!Array.isArray(input.attacks) || input.attacks.length === 0) errors.push('attacks 至少需要一条');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], value: input as unknown as MonsterDef };
}
