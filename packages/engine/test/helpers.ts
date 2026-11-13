/** 测试夹具（不匹配 *.test.ts，避免被 test runner 当成用例文件）。 */
import type { Combatant } from '../src/index.ts';

const ABILITIES = { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 };

export function makePc(id = 'pc1', patch: Partial<Combatant> = {}): Combatant {
  return {
    id,
    name: '阿青',
    kind: 'pc',
    abilities: ABILITIES,
    proficiency: 2,
    saves: ['str', 'con'],
    ac: 16,
    hp: { max: 20, current: 20, temp: 0 },
    conditions: [],
    effects: [],
    attacks: [{ name: '横刀', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' }],
    initiativeBonus: 2,
    range: 'near',
    downed: false,
    dead: false,
    deathSaves: { successes: 0, failures: 0 },
    ...patch,
  };
}

export function makeMonster(id = 'mob1', patch: Partial<Combatant> = {}): Combatant {
  return {
    id,
    name: '山魈',
    kind: 'monster',
    abilities: { str: 12, dex: 12, con: 12, int: 6, wis: 10, cha: 8 },
    proficiency: 2,
    saves: [],
    ac: 13,
    hp: { max: 12, current: 12, temp: 0 },
    conditions: [],
    effects: [],
    attacks: [{ name: '利爪', ability: 'str', proficient: true, damage: '1d6', range: 'engaged' }],
    initiativeBonus: 1,
    range: 'near',
    downed: false,
    dead: false,
    ...patch,
  };
}

/** 按顺序返回固定值的 RNG 桩：值会被夹到 [0, maxExclusive)。 */
export function stubRng(values: number[]): { nextInt(maxExclusive: number): number } {
  let index = 0;
  return {
    nextInt(maxExclusive: number) {
      const value = values[index] ?? 0;
      index += 1;
      return Math.max(0, Math.min(value, maxExclusive - 1));
    },
  };
}
