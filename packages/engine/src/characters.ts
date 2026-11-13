/**
 * 把角色卡 / 怪物数据转成战斗单位。角色卡是玩家本地真源，进入房间后由服务端产出 Combatant 快照。
 */
import { abilityMod } from './checks.ts';
import type {
  CharacterCard,
  Combatant,
  MonsterDef,
  RangeBand,
  SpellSlots,
} from './types.ts';

export function spellSlotsFromRecord(record: Record<string, number>): SpellSlots {
  const max: Record<number, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const level = Number.parseInt(key, 10);
    if (Number.isInteger(level) && level >= 0 && Number.isInteger(value) && value >= 0) {
      max[level] = value;
    }
  }
  return { max, current: { ...max } };
}

export function combatantFromCard(card: CharacterCard, options: { id?: string; range?: RangeBand } = {}): Combatant {
  const combatant: Combatant = {
    id: options.id ?? card.id,
    name: card.identity.name,
    kind: 'pc',
    abilities: card.abilities,
    proficiency: card.proficiency.bonus,
    saves: card.proficiency.saves,
    ac: card.combat.ac,
    hp: { max: card.combat.hpMax, current: card.combat.hpMax, temp: 0 },
    conditions: [],
    effects: [],
    attacks: card.combat.attacks,
    initiativeBonus: card.combat.initiativeBonus ?? abilityMod(card.abilities.dex),
    range: options.range ?? 'near',
    downed: false,
    dead: false,
    deathSaves: { successes: 0, failures: 0 },
    notes: card.publicSummary,
  };
  if (card.spells) {
    combatant.spellcasting = {
      ability: card.spells.ability,
      slots: spellSlotsFromRecord(card.spells.slots),
      known: [...card.spells.known],
    };
  }
  return combatant;
}

export function combatantFromMonster(monster: MonsterDef, options: { id?: string; range?: RangeBand } = {}): Combatant {
  return {
    id: options.id ?? monster.id,
    name: monster.name,
    kind: 'monster',
    abilities: monster.abilities,
    proficiency: monster.proficiency ?? 2,
    saves: monster.saves ?? [],
    ac: monster.ac,
    hp: { max: monster.hpMax, current: monster.hpMax, temp: 0 },
    conditions: [],
    effects: [],
    attacks: monster.attacks,
    initiativeBonus: monster.initiativeBonus ?? abilityMod(monster.abilities.dex),
    range: options.range ?? 'near',
    downed: false,
    dead: false,
    notes: monster.description,
  };
}

/** 给 UI / GM 提示用的角色摘要。 */
export function describeCombatant(combatant: Combatant): string {
  const hp = `${combatant.hp.current}/${combatant.hp.max}${combatant.hp.temp > 0 ? `+${combatant.hp.temp}` : ''}`;
  const extra = combatant.conditions.length ? ` · ${combatant.conditions.join('/')}` : '';
  return `${combatant.name}（HP ${hp}，AC ${combatant.ac}${extra}）`;
}
