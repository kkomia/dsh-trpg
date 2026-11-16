/**
 * 测试用最小 d20 示例规则包 + 示例卡（**不是**最终 dnd5e-lite 示例包）。
 *
 * 覆盖：3 属性 / 1 资源 / 2 技能 / 2 动作 / 2 公式 / 8×6 战棋图 + 2 个 zone /
 * 装备槽与词条 / 背包物品库 / 状态 / 回合行动经济 / 回合时间。
 * 后续 M9.3 的 dnd5e-lite 规则包应以 docs/RULES-MODEL.md §11 为准，不以此文件为最终口径。
 */
import {
  CARD_SCHEMA_VERSION,
  RULE_PACK_SCHEMA_VERSION,
  type CardInstance,
  type LegacyCharacterCard,
  type RulePack,
} from './types.ts';

const WALL = 'wall';
const FLOOR = 'floor';
const RUBBLE = 'rubble';

/** 8 列 × 6 行战斗地图（结构数据是权威，底图只是皮肤）。 */
const CAVE_TERRAIN: string[][] = [
  [WALL, WALL, WALL, WALL, WALL, WALL, WALL, WALL],
  [WALL, FLOOR, FLOOR, FLOOR, RUBBLE, RUBBLE, FLOOR, WALL],
  [WALL, FLOOR, FLOOR, WALL, WALL, FLOOR, FLOOR, WALL],
  [WALL, FLOOR, FLOOR, FLOOR, FLOOR, FLOOR, FLOOR, WALL],
  [WALL, FLOOR, FLOOR, RUBBLE, RUBBLE, FLOOR, FLOOR, WALL],
  [WALL, WALL, WALL, WALL, WALL, WALL, WALL, WALL],
];

/** 最小 d20 规则包（合法，可直接过 validateRulePack）。 */
export const MINIMAL_RULE_PACK: RulePack = {
  schemaVersion: RULE_PACK_SCHEMA_VERSION,
  rulesId: 'd20-mini',
  rulesVersion: '1.0.0',
  name: 'D20 极简示例',
  description: '测试用最小 d20 规则包：3 属性 / 1 资源 / 2 技能 / 2 动作 / 2 公式 / 8×6 战棋图 + 2 区域。',
  sheet: {
    attributes: [
      { id: 'str', name: '力量', min: 3, max: 18, default: 10, icon: 'attr/str' },
      { id: 'dex', name: '敏捷', min: 3, max: 18, default: 10 },
      { id: 'con', name: '体质', min: 3, max: 18, default: 10 },
    ],
    resources: [{ id: 'hp', name: '生命', formula: 'hpMax', icon: 'resource/hp' }],
    fields: [
      { id: 'name', name: '姓名', kind: 'text' },
      { id: 'race', name: '种族', kind: 'text' },
      { id: 'class', name: '职业', kind: 'text' },
      { id: 'background', name: '背景', kind: 'text' },
      { id: 'publicSummary', name: '公开摘要', kind: 'text' },
      { id: 'appearance', name: '外貌', kind: 'text' },
      { id: 'personality', name: '性格', kind: 'text' },
      { id: 'level', name: '等级', kind: 'number' },
      { id: 'alignment', name: '阵营', kind: 'enum', options: ['守序', '中立', '混乱'] },
    ],
    equipment: {
      slots: [
        { id: 'mainHand', name: '主手', accepts: ['weapon:melee', 'weapon:ranged'], icon: 'slot/mainHand' },
        { id: 'body', name: '身上', accepts: ['armor'] },
        { id: 'trinket', name: '随身', accepts: ['*'], count: 3 },
      ],
      stats: [
        { id: '攻击', name: '攻击', min: -5, max: 15, stacking: 'add' },
        { id: '防御', name: '防御', min: 0, max: 30, stacking: 'add' },
        { id: '先攻', name: '先攻', min: -5, max: 10, stacking: 'add' },
        { id: '暴击范围', name: '暴击范围', min: 19, max: 20, stacking: 'min' },
      ],
      stacking: { add: '相加', max: '取最大', min: '取最小', unique: '同名只生效最高一条' },
    },
    skills: [
      { id: 'athletics', name: '运动', attribute: 'str' },
      { id: 'stealth', name: '潜行', attribute: 'dex' },
    ],
    statuses: [
      { id: 'poisoned', name: '中毒', duration: 3, stacking: 'refresh', icon: 'status/poison' },
      { id: 'prone', name: '倒地', duration: 1, stacking: 'refresh' },
    ],
  },
  actions: [
    {
      actionId: 'attack.melee',
      name: '近战攻击',
      kind: 'attack',
      cost: { action: 1 },
      targeting: { type: 'single', range: 'engaged', sides: 'enemy' },
      damage: { dice: '1d8' },
      description: '用主手武器攻击一个接触目标。',
      icon: 'action/attack',
    },
    {
      actionId: 'skill.athletics',
      name: '运动检定',
      kind: 'skill',
      cost: { action: 1 },
      targeting: { type: 'self', range: 'engaged', sides: 'self' },
      description: '力量（运动）检定，难度由 GM 定。',
    },
  ],
  turn: {
    resources: [
      { id: 'action', name: '动作', count: 1 },
      { id: 'bonus', name: '附赠动作', count: 1 },
    ],
    movement: { id: 'movement', name: '移动力', cells: 6 },
  },
  formulas: {
    hpMax: '2 + attr.con + level',
    check: 'derived.mod + skill.proficient * proficiency + skill.bonus',
  },
  progression: {
    maxLevel: 5,
    xpTable: [0, 100, 300, 700, 1500],
    grants: [{ atLevel: 2, skillPoints: 1 }],
  },
  tables: [
    {
      tableId: 'loot.common',
      roll: '1d100',
      entries: [
        { min: 1, max: 60, itemId: 'hengdao' },
        { min: 61, max: 100, itemId: 'huozhezi' },
      ],
    },
  ],
  items: [
    {
      itemId: 'hengdao',
      name: '横刀',
      tags: ['weapon:melee', '锋利'],
      rarity: 'common',
      stats: { 攻击: 2 },
      equipSlot: ['mainHand'],
      description: '家传旧刀，刀脊有裂纹。',
    },
    {
      itemId: 'tieja',
      name: '铁甲',
      tags: ['armor'],
      rarity: 'common',
      stats: { 防御: 2 },
      equipSlot: ['body'],
      description: '旧铁甲。',
    },
    {
      itemId: 'huozhezi',
      name: '火折子',
      tags: ['tool', 'light'],
      rarity: 'common',
      equipSlot: ['trinket'],
      description: '照明用。',
    },
    {
      itemId: 'zhixuecao',
      name: '止血草',
      tags: ['consumable:heal'],
      rarity: 'common',
      stackable: true,
      equipSlot: ['trinket'],
      description: '恢复 1d4 生命。',
    },
  ],
  ui: {
    groups: [
      { id: 'combat', title: '战斗', fields: ['resources.hp', 'attributes.str', 'attributes.dex'] },
      { id: 'skills', title: '技能', fields: ['skills.athletics', 'skills.stealth'] },
    ],
    itemCategories: [{ id: 'weapon', name: '武器', tags: ['weapon'] }],
    rarities: [{ id: 'common', name: '普通', color: '#9aa0a6' }],
    templates: { sheetCompact: ['resources', 'attributes', 'skills'], itemCard: ['icon', 'stats', 'description'] },
    worldMap: { labelMode: 'always', showConnections: true, currentZonePulse: true, exploredOnly: false },
    battleGrid: { gridOpacity: 0.2, tokenSize: 'auto', showMoveRange: true, showDistanceOnHover: true, showCoverMarkers: true },
  },
  space: {
    model: 'zone-grid',
    units: '格',
    distanceMode: 'chebyshev',
    grid: { cellMeters: 1.5 },
    world: { backgroundAssetId: 'map/region-test', width: 1024, height: 768 },
    zones: [
      {
        zoneId: 'town',
        name: '青石镇',
        tags: ['open'],
        hotspot: { x: 0.3, y: 0.6 },
        connections: [{ to: 'cave', kind: 'road', distance: 3 }],
        battleMapId: null,
      },
      {
        zoneId: 'cave',
        name: '洞口',
        parentZoneId: 'town',
        tags: ['dark'],
        hotspot: { x: 0.6, y: 0.4 },
        connections: [{ to: 'town', kind: 'road', distance: 3 }],
        battleMapId: 'map_cave',
      },
    ],
    battleMaps: [
      {
        mapId: 'map_cave',
        zoneId: 'cave',
        cols: 8,
        rows: 6,
        terrain: CAVE_TERRAIN,
        obstacles: [{ x: 3, y: 4, w: 2, h: 1, terrain: RUBBLE, coverId: 'half' }],
        spawns: [
          { team: 'player', cells: [[1, 4], [2, 4]] },
          { team: 'enemy', cells: [[6, 1], [6, 2]] },
        ],
        backgroundAssetId: 'map/battle-cave',
        calibration: { offsetX: 0, offsetY: 0, cellPx: 64 },
      },
    ],
    terrains: [
      { id: FLOOR, name: '地面', moveCost: 1 },
      { id: WALL, name: '岩壁', moveCost: 0, blocksMove: true, blocksSight: true },
      { id: RUBBLE, name: '碎石', moveCost: 2 },
    ],
    covers: [{ id: 'half', name: '半掩体', defenseBonus: 2, tags: ['wall'] }],
    areas: [],
  },
  time: {
    model: 'round',
    durationUnit: 'round',
    defaultMaxRounds: 10,
    onRoundLimit: 'end',
  },
};

/** 示例卡 1：阿青（近战；熟练运动；中毒 2 回合）。 */
export const SAMPLE_CARD_AQING: CardInstance = {
  schemaVersion: CARD_SCHEMA_VERSION,
  cardId: 'card_aqing',
  rulesId: 'd20-mini',
  rulesVersion: '1.0.0',
  attributes: { str: 17, dex: 14, con: 15 },
  resources: { hp: { current: 12, max: 18 } },
  fields: {
    name: '阿青',
    race: '山民',
    class: '武者',
    background: '青石镇铁匠铺的学徒，一把横刀使得比锤子好。',
    publicSummary: '背刀的山民少女，话不多，眼睛很亮。',
    appearance: '短打劲装，右手虎口有常年握刀的旧茧。',
    personality: '护短、认死理，对镇上的孩子很好。',
    level: 1,
    alignment: '中立',
  },
  equipmentInstances: [
    { instanceId: 'ins_1', slot: 'mainHand', name: '横刀', tags: ['weapon:melee', '锋利'], stats: { 攻击: 2 }, note: '家传旧刀' },
    { instanceId: 'ins_2', slot: 'body', name: '铁甲', tags: ['armor'], stats: { 防御: 2 } },
    { instanceId: 'ins_3', slot: 'trinket', name: '火折子', tags: ['tool', 'light'], stats: {} },
  ],
  skills: [
    { id: 'athletics', proficient: true, bonus: 0 },
    { id: 'stealth', proficient: false, bonus: 0 },
  ],
  statuses: [{ id: 'poisoned', stacks: 1, remaining: 2 }],
  notes: '玩家备注：想学骑术。',
  origin: { packId: 'core-guimuya', moduleId: 'guimuya' },
};

/** 示例卡 2：白露（远程/潜行；两件随身体积物占满通配槽）。 */
export const SAMPLE_CARD_BAILU: CardInstance = {
  schemaVersion: CARD_SCHEMA_VERSION,
  cardId: 'card_bailu',
  rulesId: 'd20-mini',
  rulesVersion: '1.0.0',
  attributes: { str: 12, dex: 16, con: 13 },
  resources: { hp: { current: 14, max: 17 } },
  fields: {
    name: '白露',
    race: '镇上人',
    class: '游侠',
    background: '常年在镇外跑腿，认路。',
    publicSummary: '背着短弓的少女，总在屋顶上。',
    level: 2,
  },
  equipmentInstances: [
    { instanceId: 'ins_1', slot: 'trinket', name: '火折子', tags: ['tool', 'light'], stats: {} },
    { instanceId: 'ins_2', slot: 'trinket', name: '止血草', tags: ['consumable:heal'], stats: {}, note: '恢复 1d4 生命' },
  ],
  skills: [
    { id: 'athletics', proficient: false, bonus: 0 },
    { id: 'stealth', proficient: true, bonus: 1 },
  ],
  statuses: [],
};

/** 所有示例卡（可被 M9.2/M9.4 当投影测试数据）。 */
export const SAMPLE_CARDS: CardInstance[] = [SAMPLE_CARD_AQING, SAMPLE_CARD_BAILU];

/** 旧 engine CharacterCard（schemaVersion: 1），迁移测试用。 */
export const SAMPLE_LEGACY_CARD: LegacyCharacterCard = {
  schemaVersion: 1,
  id: 'card_aqing',
  identity: {
    name: '阿青',
    race: '山民',
    class: '武者',
    level: 1,
    background: '青石镇铁匠铺的学徒，一把横刀使得比锤子好。',
  },
  owner: { playerId: null, displayName: '未分配' },
  abilities: { str: 17, dex: 14, con: 15, int: 10, wis: 12, cha: 8 },
  proficiency: { bonus: 2, skills: ['athletics', 'intimidation'], saves: ['str', 'con'] },
  combat: {
    ac: 16,
    hpMax: 12,
    initiativeBonus: 2,
    attacks: [{ name: '横刀', ability: 'str', proficient: true, damage: '1d8', range: 'engaged', damageType: '挥砍' }],
  },
  inventory: [
    { name: '横刀', qty: 1, effect: '1d8 挥砍' },
    { name: '铁甲', qty: 1, effect: 'AC 16' },
    { name: '火折子', qty: 1, effect: '照明' },
    { name: '止血草', qty: 2, effect: '恢复 1d4 生命' },
  ],
  publicSummary: '背刀的山民少女，话不多，眼睛很亮。',
  appearance: '短打劲装，右手虎口有常年握刀的旧茧。',
  personality: '护短、认死理，对镇上的孩子很好。',
  source: { ruleId: 'd20-mini', ruleVersion: '1.0.0', moduleId: 'guimuya' },
};
