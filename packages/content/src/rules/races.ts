import type { RaceDef } from '@dsh-trpg/engine';

/** D&D 5e-lite 种族（中式奇幻皮）。属性加值在创建角色时叠加。 */
export const RACES: RaceDef[] = [
  {
    id: 'shanmin',
    name: '山民',
    bonuses: { str: 2, con: 1 },
    traits: ['山野体魄：HP 上限 +2', '吃苦耐劳：对抗中毒的豁免 +1'],
  },
  {
    id: 'manyi',
    name: '蛮裔',
    bonuses: { str: 1, con: 2 },
    traits: ['蛮力：推撞与擒抱检定 +2', '夜视：黑暗中视物 18 米'],
  },
  {
    id: 'lingyi',
    name: '灵裔',
    bonuses: { dex: 2, int: 1 },
    traits: ['灵巧：隐匿与体操 +1', '古法亲和：奥秘 +2'],
  },
  {
    id: 'banyao',
    name: '半妖',
    bonuses: { cha: 2, dex: 1 },
    traits: ['妖异气质：威吓与欺瞒 +1', '夜视：黑暗中视物 18 米'],
  },
];
