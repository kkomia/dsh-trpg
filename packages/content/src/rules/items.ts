import type { ItemDef } from '@dsh-trpg/engine';

/** D&D 5e-lite 物品（20 件）：武器 / 护甲 / 消耗品 / 工具 / 财物。 */
export const ITEMS: ItemDef[] = [
  { id: 'hengdao', name: '横刀', kind: 'weapon', effect: '1d8 挥砍，接触距离，武者常用', value: 30 },
  { id: 'liuyedao', name: '柳叶刀', kind: 'weapon', effect: '1d8 挥砍，近距', value: 30 },
  { id: 'changqiang', name: '长枪', kind: 'weapon', effect: '1d10 穿刺，近距，双手', value: 20 },
  { id: 'bishou', name: '匕首', kind: 'weapon', effect: '1d4 穿刺，接触距离，可藏于袖中', value: 4 },
  { id: 'gong', name: '猎弓', kind: 'weapon', effect: '1d8 穿刺，远距', value: 40 },
  { id: 'taomujian', name: '桃木剑', kind: 'weapon', effect: '1d6 钝击，近距；对邪物有额外威慑（叙事）', value: 15 },
  { id: 'lingfu', name: '灵符', kind: 'weapon', effect: '1d6 灵能，远距', value: 5 },
  { id: 'pijia', name: '皮甲', kind: 'armor', effect: 'AC 12 + 敏捷调整', value: 20 },
  { id: 'tiejia', name: '铁甲', kind: 'armor', effect: 'AC 16，隐匿劣势', value: 80 },
  { id: 'daopao', name: '道袍', kind: 'armor', effect: 'AC 11 + 敏捷调整，施法不受甲胄影响', value: 12 },
  { id: 'zhixuecao', name: '止血草', kind: 'consumable', effect: '外敷恢复 1d4 生命（一次）', value: 3 },
  { id: 'jiedusan', name: '解毒散', kind: 'consumable', effect: '解除中毒状态（一次）', value: 8 },
  { id: 'lingjiu', name: '灵酒', kind: 'consumable', effect: '饮下恢复 1 个 1 环法术位（一次）', value: 12 },
  { id: 'huozhezi', name: '火折子', kind: 'tool', effect: '照明，点燃易燃物', value: 2 },
  { id: 'masheng', name: '麻绳', kind: 'tool', effect: '10 米，攀爬与捆缚用', value: 1 },
  { id: 'miyan', name: '迷烟', kind: 'consumable', effect: '一团迷雾，遮蔽视线一回合', value: 6 },
  { id: 'tongjing', name: '铜镜', kind: 'tool', effect: '照见邪祟真形（对鬼火/纸人有奇效，叙事）', value: 10 },
  { id: 'fuwen', name: '符文石', kind: 'treasure', effect: '古洞阵法残片，交给懂行的人可换人情', value: 25 },
  { id: 'zhaohunling', name: '招魂铃', kind: 'treasure', effect: '摇动可引魂，也可能引来不该来的东西', value: 35 },
  { id: 'zhenhunfu', name: '镇魂符', kind: 'consumable', effect: '对邪物使用时，其攻击劣势一回合（叙事）', value: 9 },
];
