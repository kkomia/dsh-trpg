/**
 * dnd5e-lite 示例规则包（`trpg.rules/1`，docs/RULES-MODEL §3/§11）。
 *
 * 定位：把 `@dsh-trpg/engine` 里写死的 dnd5e-lite（六属性 / 18 技能 / 8 状态 / 攻击与伤害 /
 * HP 与法术位 / 先攻 / 行动经济）**完整数据化**，脚本只做「数据表达不了的条件链」：
 *   - 数值公式 → `formulas`（AC/HP 上限/先攻/命中/伤害/技能加值/法术位上限）；
 *   - 逐属性映射（属性调整值 `floor((x-10)/2)`）→ `scripts/sheet.js` 的 `computeDerived`；
 *   - 骰子/命中/伤害落账 → `scripts/combat.js`；
 *   - 条件与状态 tick → `scripts/events.js`；
 *   - 成长与掉落 → `scripts/progression.js`。
 *
 * `space.model = 'none'`：v1 沿用 theater-of-mind（接触/近距/远距档位），不做战棋；
 * `time` 只按回合计（`durationUnit: 'round'`）。`defaultMaxRounds: 0`（无上限）由 M9.1 校验器
 * 判为非法（`isPositiveInteger`），因此**省略该字段**——运行时的语义同样是「0 = 无回合上限」。
 *
 * 本文件只依赖类型与脚本哈希：脚本源码在 `scripts/*.js`（生成器内联到 `scripts.embedded.ts`），
 * `pack.rules.scripts` 只记 `{ file, sha256 }`（docs §3）。
 */
import {
  RULE_PACK_SCHEMA_VERSION,
  type ActionDef,
  type FieldDef,
  type RulePack,
  type RulePackItemDef,
  type RulePackScripts,
  type ScriptRef,
  type SkillDef,
  type StatusDef,
} from '../../rules-bridge.ts';
import { ITEMS } from '../../rules/items.ts';
import { DND5E_LITE_SCRIPT_FILES, dnd5eScriptRef } from './script-hashes.ts';

export const DND5E_LITE_RULES_ID = 'dnd5e-lite';
export const DND5E_LITE_RULES_VERSION = '2.0.0';
export const DND5E_LITE_RULES_NAME = 'D&D 5e-lite';

// ---------------------------------------------------------------------------
// items：复用 content 现有 20 件物品定义，映射成 `rules.items[]`
// ---------------------------------------------------------------------------

/** 远程武器（其余武器按近战处理）。 */
const RANGED_WEAPON_IDS = new Set(['gong', 'lingfu']);

/** 护甲词条「防御」基准值：AC = 10 + 敏捷调整 + 防御（与旧卡 AC 对齐，见 test/dnd5e-rules-parity.test.ts）。 */
const ARMOR_DEFENSE: Readonly<Record<string, number>> = { pijia: 1, tiejia: 4, daopao: 1 };

/** 个别物品的额外词条（镇魂符：随身护符，防御 +1 —— 旧卡玄真 AC 13 的来源）。 */
const SPECIAL_STATS: Readonly<Record<string, Readonly<Record<string, number>>>> = { zhenhunfu: { 防御: 1 } };

/** 个别物品的额外标签（分类/叙事用）。 */
const SPECIAL_TAGS: Readonly<Record<string, readonly string[]>> = {
  fuwen: ['阵法残片'],
  zhaohunling: ['法器'],
  zhenhunfu: ['护符'],
};

function toRuleItem(item: (typeof ITEMS)[number]): RulePackItemDef {
  const tags: string[] = [];
  const equipSlot: string[] = [];
  const stats: Record<string, number> = { ...(SPECIAL_STATS[item.id] ?? {}) };
  let stackable = false;
  if (item.kind === 'weapon') {
    tags.push(RANGED_WEAPON_IDS.has(item.id) ? 'weapon:ranged' : 'weapon:melee');
    equipSlot.push('mainHand');
  } else if (item.kind === 'armor') {
    tags.push('armor');
    equipSlot.push('body');
    const defense = ARMOR_DEFENSE[item.id];
    if (defense !== undefined) stats['防御'] = defense;
  } else if (item.kind === 'consumable') {
    tags.push('consumable');
    equipSlot.push('trinket');
    stackable = true;
  } else if (item.kind === 'tool') {
    tags.push('tool');
    equipSlot.push('trinket');
  } else {
    tags.push('treasure');
    equipSlot.push('trinket');
  }
  for (const extra of SPECIAL_TAGS[item.id] ?? []) tags.push(extra);
  const value = item.value ?? 0;
  return {
    itemId: item.id,
    name: item.name,
    tags,
    rarity: value >= 30 ? 'rare' : 'common',
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
    equipSlot,
    ...(stackable ? { stackable: true } : {}),
    description: item.effect,
  };
}

/** 世界物品库：dnd5e-lite 的 20 件物品（内容包 `rules/items.ts` 是数据源）。 */
export const DND5E_LITE_ITEMS: RulePackItemDef[] = ITEMS.map(toRuleItem);

// ---------------------------------------------------------------------------
// sheet：六属性 / 资源 / 字段 / 装备 / 18 技能 / 8 状态
// ---------------------------------------------------------------------------

const ATTRIBUTES = [
  { id: 'str', name: '力量', min: 3, max: 18, default: 10 },
  { id: 'dex', name: '敏捷', min: 3, max: 18, default: 10 },
  { id: 'con', name: '体质', min: 3, max: 18, default: 10 },
  { id: 'int', name: '智力', min: 3, max: 18, default: 10 },
  { id: 'wis', name: '感知', min: 3, max: 18, default: 10 },
  { id: 'cha', name: '魅力', min: 3, max: 18, default: 10 },
] as const;

const FIELDS: FieldDef[] = [
  { id: 'name', name: '姓名', kind: 'text' },
  { id: 'race', name: '种族', kind: 'text' },
  { id: 'class', name: '职业', kind: 'text' },
  { id: 'background', name: '背景', kind: 'text' },
  { id: 'publicSummary', name: '公开摘要', kind: 'text' },
  { id: 'appearance', name: '外貌', kind: 'text' },
  { id: 'personality', name: '性格', kind: 'text' },
  { id: 'level', name: '等级', kind: 'number' },
  { id: 'xp', name: '经验值', kind: 'number' },
  // 职业生命骰面数（d10/d8/d6…）：hpMax 公式读它，等价旧卡的「职业固定 HP 口径」。
  { id: 'hitDie', name: '生命骰', kind: 'number' },
  // 施法等级（非施法职业为 0）：法术位上限按它算，等价旧卡 spells.slots 的分环口径。
  { id: 'casterLevel', name: '施法等级', kind: 'number' },
  { id: 'skillPoints', name: '技能点', kind: 'number' },
  { id: 'alignment', name: '阵营', kind: 'enum', options: ['守序', '中立', '混乱'] },
];

/** 18 项技能（id/中文名/关联属性与 `@dsh-trpg/engine` 的 SKILL_ABILITY/SKILL_NAME 完全一致）。 */
const SKILLS: SkillDef[] = [
  { id: 'athletics', name: '运动', attribute: 'str' },
  { id: 'acrobatics', name: '体操', attribute: 'dex' },
  { id: 'sleight_of_hand', name: '巧手', attribute: 'dex' },
  { id: 'stealth', name: '隐匿', attribute: 'dex' },
  { id: 'arcana', name: '奥秘', attribute: 'int' },
  { id: 'history', name: '历史', attribute: 'int' },
  { id: 'investigation', name: '调查', attribute: 'int' },
  { id: 'nature', name: '自然', attribute: 'int' },
  { id: 'religion', name: '宗教', attribute: 'int' },
  { id: 'animal_handling', name: '驯兽', attribute: 'wis' },
  { id: 'insight', name: '洞悉', attribute: 'wis' },
  { id: 'medicine', name: '医药', attribute: 'wis' },
  { id: 'perception', name: '察觉', attribute: 'wis' },
  { id: 'survival', name: '生存', attribute: 'wis' },
  { id: 'deception', name: '欺瞒', attribute: 'cha' },
  { id: 'intimidation', name: '威吓', attribute: 'cha' },
  { id: 'performance', name: '表演', attribute: 'cha' },
  { id: 'persuasion', name: '游说', attribute: 'cha' },
];

/** 八种状态（id/中文名与 engine 的 `Condition` / `CONDITION_NAME` 一致；时长按回合）。 */
const STATUSES: StatusDef[] = [
  { id: 'poisoned', name: '中毒', duration: 3, stacking: 'refresh' },
  { id: 'prone', name: '倒地', duration: 1, stacking: 'refresh' },
  { id: 'frightened', name: '恐惧', duration: 2, stacking: 'refresh' },
  { id: 'restrained', name: '束缚', duration: 1, stacking: 'refresh' },
  { id: 'blinded', name: '目盲', duration: 2, stacking: 'refresh' },
  { id: 'incapacitated', name: '失能', duration: 1, stacking: 'refresh' },
  { id: 'invisible', name: '隐身', duration: 3, stacking: 'refresh' },
  { id: 'hasted', name: '加速', duration: 3, stacking: 'refresh' },
];

// ---------------------------------------------------------------------------
// formulas：静态数值（不许随机/条件，docs §5）
// ---------------------------------------------------------------------------

/** 六属性的命中/伤害公式名后缀（脚本按 `attack.<attr>` / `damage.<attr>` 取关联属性）。 */
const ABILITY_IDS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

const FORMULAS: Record<string, string> = {
  // 熟练加值：1–4 级 +2、5–8 级 +3、9–12 级 +4 …（与 engine `proficiencyBonus` 同式）
  proficiency: 'floor((level - 1) / 4) + 2',
  // 技能总加值 = 关联属性调整 + 熟练（若熟练）+ 额外加值（derived.mod 由投影按技能属性注入）
  check: 'derived.mod + skill.proficient * proficiency + skill.bonus',
  // AC = 10 + 敏捷调整 + 护甲「防御」词条
  defense: '10 + derived.mod.dex + equip.防御',
  // 先攻加值 = 敏捷调整 + 装备「先攻」词条
  initiative: 'derived.mod.dex + equip.先攻',
  // HP 上限由 `computeDerived` 算好（要读职业生命骰 field，受限公式语言不能按职业分支）；
  // 这里仍保留命名公式 `hpMax`，资源上限继续走「数据引用公式」的契约。
  hpMax: 'derived.hpMax',
  // 法术位上限由 `computeDerived` 算好（只有施法职业有，卡字段 casterLevel=0 时两环皆 0）；
  // 公式只是引用派生值，保持「资源上限由命名公式给出」的契约。
  slot1Max: 'derived.slot1Max',
  slot2Max: 'derived.slot2Max',
};

for (const ability of ABILITY_IDS) {
  FORMULAS[`attack.${ability}`] = `derived.mod.${ability} + proficiency + equip.攻击`;
  FORMULAS[`damage.${ability}`] = `derived.mod.${ability} + equip.攻击`;
}

// ---------------------------------------------------------------------------
// actions：近战/远程/法术示例
// ---------------------------------------------------------------------------

const ACTIONS: ActionDef[] = [
  {
    actionId: 'attack.melee',
    name: '近战攻击',
    kind: 'attack',
    cost: { action: 1 },
    targeting: { type: 'single', range: 'engaged', sides: 'enemy' },
    toHit: 'attack.str',
    damage: { formula: 'damage.str', dice: '1d8' },
    description: '用主手近战武器攻击一个接触目标（力量命中，1d8 挥砍）。',
    icon: 'action/attack-melee',
  },
  {
    actionId: 'attack.ranged',
    name: '远程攻击',
    kind: 'attack',
    cost: { action: 1 },
    targeting: { type: 'single', range: 'far', sides: 'enemy' },
    toHit: 'attack.dex',
    damage: { formula: 'damage.dex', dice: '1d8' },
    description: '用远程武器攻击一个远距目标（敏捷命中，1d8 穿刺）。',
    icon: 'action/attack-ranged',
  },
  {
    actionId: 'attack.lingfu',
    name: '灵符',
    kind: 'attack',
    cost: { action: 1 },
    targeting: { type: 'single', range: 'far', sides: 'enemy' },
    toHit: 'attack.cha',
    damage: { formula: 'damage.cha', dice: '1d6' },
    description: '甩出一张灵符，远距灵能伤害（魅力命中，1d6 灵能）。',
    icon: 'action/lingfu',
  },
  {
    actionId: 'attack.taomu',
    name: '桃木剑',
    kind: 'attack',
    cost: { action: 1 },
    targeting: { type: 'single', range: 'near', sides: 'enemy' },
    toHit: 'attack.wis',
    damage: { formula: 'damage.wis', dice: '1d6' },
    description: '桃木剑劈刺，对邪物有额外威慑（感知命中，1d6 钝击）。',
    icon: 'action/taomu',
  },
  {
    actionId: 'spell.zhuoyan',
    name: '灼焰掌',
    kind: 'spell',
    cost: { action: 1, resource: { id: 'slot1', amount: 1 } },
    targeting: { type: 'single', range: 'engaged', sides: 'enemy' },
    toHit: 'attack.cha',
    damage: { formula: 'damage.cha', dice: '2d6' },
    description: '消耗一个一环法术位，掌心喷火（法术示例：命中判定 + 2d6 火焰伤害）。',
    icon: 'action/zhuoyan',
  },
];

// ---------------------------------------------------------------------------
// scripts：钩子 → 独立脚本文件
// ---------------------------------------------------------------------------

const SCRIPTS: RulePackScripts = {
  validateSheet: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.sheet),
  computeDerived: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.sheet),
  resolveCheck: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.combat),
  resolveAttack: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.combat),
  resolveDamage: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.combat),
  onEvent: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.events),
  onLevelUp: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.progression),
  generateLoot: dnd5eScriptRef(DND5E_LITE_SCRIPT_FILES.progression),
};

/** 规则包声明的脚本文件（去重后的 `ScriptRef` 列表，导出/导入时用）。 */
export const DND5E_LITE_SCRIPT_REFS: readonly ScriptRef[] = (() => {
  const seen = new Map<string, string>();
  for (const ref of Object.values(SCRIPTS)) {
    if (ref !== undefined) seen.set(ref.file, ref.sha256);
  }
  return [...seen.entries()].map(([file, sha256]) => ({ file, sha256 }));
})();

// ---------------------------------------------------------------------------
// 规则包
// ---------------------------------------------------------------------------

/** dnd5e-lite 示例规则包（`trpg.rules/1`）。内容包通过 `ContentPack.rules` 引用它。 */
export const DND5E_LITE_RULES: RulePack = {
  schemaVersion: RULE_PACK_SCHEMA_VERSION,
  rulesId: DND5E_LITE_RULES_ID,
  rulesVersion: DND5E_LITE_RULES_VERSION,
  name: DND5E_LITE_RULES_NAME,
  description:
    'D&D 5e-lite：六属性（3–18）、18 项技能、8 种状态、HP + 两环法术位；AC/先攻/命中/伤害全部走命名公式，' +
    '属性调整与条件处理走 JS 钩子。v1 不做战棋（theater-of-mind 距离档位）、时间只按回合计。',
  sheet: {
    attributes: ATTRIBUTES.map((attribute) => ({ ...attribute })),
    resources: [
      { id: 'hp', name: '生命', formula: 'hpMax', icon: 'resource/hp' },
      { id: 'slot1', name: '一环法术位', formula: 'slot1Max' },
      { id: 'slot2', name: '二环法术位', formula: 'slot2Max' },
    ],
    fields: FIELDS.map((field) => ({ ...field })),
    equipment: {
      slots: [
        { id: 'mainHand', name: '主手', accepts: ['weapon:melee', 'weapon:ranged'], count: 2, icon: 'slot/mainHand' },
        { id: 'body', name: '身上', accepts: ['armor'], count: 1, icon: 'slot/body' },
        { id: 'trinket', name: '随身', accepts: ['*'], count: 3, icon: 'slot/trinket' },
      ],
      stats: [
        { id: '攻击', name: '攻击', min: -5, max: 15, stacking: 'add' },
        { id: '防御', name: '防御', min: 0, max: 30, stacking: 'add' },
        { id: '先攻', name: '先攻', min: -5, max: 10, stacking: 'add' },
        { id: '暴击范围', name: '暴击范围', min: 19, max: 20, stacking: 'min' },
      ],
      stacking: { add: '相加', max: '取最大', min: '取最小', unique: '同名只生效最高一条' },
    },
    skills: SKILLS.map((skill) => ({ ...skill })),
    statuses: STATUSES.map((status) => ({ ...status })),
  },
  actions: ACTIONS.map((action) => ({ ...action })),
  turn: {
    refill: 'turnStart',
    resources: [
      { id: 'action', name: '动作', count: 1 },
      { id: 'bonus', name: '附赠动作', count: 1 },
      { id: 'reaction', name: '反应', count: 1 },
    ],
    movement: { id: 'movement', name: '移动力', cells: 6 },
    endTurn: { trigger: 'player' },
  },
  progression: {
    maxLevel: 10,
    xpTable: [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500],
    grants: [
      { atLevel: 2, skillPoints: 1 },
      { atLevel: 3, skillPoints: 1 },
      { atLevel: 5, skillPoints: 2 },
      { atLevel: 7, skillPoints: 2 },
      { atLevel: 9, skillPoints: 3 },
    ],
  },
  tables: [
    {
      tableId: 'loot.common',
      roll: '1d100',
      description: '鬼木崖一带的常见掉落（与旧模组奖励同口径）。',
      entries: [
        { min: 1, max: 40, itemId: 'zhixuecao' },
        { min: 41, max: 70, itemId: 'huozhezi' },
        { min: 71, max: 85, itemId: 'masheng' },
        { min: 86, max: 95, itemId: 'zhenhunfu' },
        { min: 96, max: 100, itemId: 'fuwen' },
      ],
    },
  ],
  ui: {
    groups: [
      { id: 'combat', title: '战斗', fields: ['resources.hp', 'derived.ac', 'derived.initiative'] },
      { id: 'attributes', title: '属性', fields: ['attributes.str', 'attributes.dex', 'attributes.con', 'attributes.int', 'attributes.wis', 'attributes.cha'] },
      { id: 'skills', title: '技能', fields: ['skills.athletics', 'skills.stealth', 'skills.perception', 'skills.insight'] },
      { id: 'growth', title: '成长', fields: ['fields.level', 'fields.xp', 'fields.skillPoints'] },
    ],
    itemCategories: [
      { id: 'weapon', name: '武器', tags: ['weapon'] },
      { id: 'armor', name: '护甲', tags: ['armor'] },
      { id: 'consumable', name: '消耗品', tags: ['consumable'] },
      { id: 'treasure', name: '财物', tags: ['treasure'] },
    ],
    rarities: [
      { id: 'common', name: '普通', color: '#9aa0a6' },
      { id: 'rare', name: '稀有', color: '#4aa3ff' },
    ],
    templates: {
      sheetCompact: ['resources', 'attributes', 'skills'],
      itemCard: ['icon', 'stats', 'description'],
    },
  },
  formulas: FORMULAS,
  scripts: SCRIPTS,
  space: { model: 'none' },
  time: { model: 'round', durationUnit: 'round' },
  items: DND5E_LITE_ITEMS,
};
