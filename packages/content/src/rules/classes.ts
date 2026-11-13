import type { ClassDef } from '@dsh-trpg/engine';

/** D&D 5e-lite 职业（中式奇幻皮）。 */
export const CLASSES: ClassDef[] = [
  {
    id: 'wuzhe',
    name: '武者',
    hpBase: 10,
    primary: 'str',
    saves: ['str', 'con'],
    skills: ['athletics', 'intimidation'],
    attacks: [{ name: '横刀', ability: 'str', proficient: true, damage: '1d8', range: 'engaged', damageType: '挥砍' }],
  },
  {
    id: 'youxia',
    name: '游侠',
    hpBase: 10,
    primary: 'dex',
    saves: ['dex', 'wis'],
    skills: ['stealth', 'perception'],
    attacks: [{ name: '柳叶刀', ability: 'dex', proficient: true, damage: '1d8', range: 'near', damageType: '挥砍' }],
  },
  {
    id: 'shushi',
    name: '术士',
    hpBase: 6,
    primary: 'cha',
    saves: ['con', 'cha'],
    skills: ['arcana', 'insight'],
    spellcasting: 'cha',
    attacks: [{ name: '灵符', ability: 'cha', proficient: true, damage: '1d6', range: 'far', damageType: '灵能' }],
  },
  {
    id: 'fangshi',
    name: '方士',
    hpBase: 8,
    primary: 'wis',
    saves: ['wis', 'cha'],
    skills: ['medicine', 'religion'],
    spellcasting: 'wis',
    attacks: [{ name: '桃木剑', ability: 'wis', proficient: true, damage: '1d6', range: 'near', damageType: '钝击' }],
  },
];
