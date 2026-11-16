/**
 * dnd5e-lite 示例规则包 · 卡面脚本（docs/RULES-MODEL §6/§11.2）
 *
 * 导出钩子：
 * - `validateSheet(ctx, sheet)` → string[]：六属性范围、等级、HP/法术位、技能与状态 id 的语义校验
 *   （schema 级校验由内核 `validateCard` 先做，这里只补「dnd5e-lite 这条规则自己的约束」）；
 * - `computeDerived(ctx, sheet)` → { mod.str … mod.cha }：属性调整值 `floor((x-10)/2)`。
 *   AC/HP 上限/先攻/命中/伤害等**静态公式**留在 `rules.formulas`（数据段），这里只算「逐属性映射」——
 *   正是 §11.1 里「公式不能逐属性映射，用钩子」的边界。
 *
 * 约束（§6 沙箱）：无 require / process / Date / Math.random；随机只能 ctx.roll / ctx.rng。
 * 本文件是唯一真相；`scripts/embed-dnd5e-scripts.mjs` 把它内联到 `scripts.embedded.ts` 并记 sha256。
 */

var ABILITY_IDS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
var ABILITY_NAMES = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力',
};

var SKILL_ATTRIBUTES = {
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

var STATUS_IDS = [
  'poisoned',
  'prone',
  'frightened',
  'restrained',
  'blinded',
  'incapacitated',
  'invisible',
  'hasted',
];

var ATTRIBUTE_MIN = 3;
var ATTRIBUTE_MAX = 18;
var RESOURCE_IDS = ['hp', 'slot1', 'slot2'];

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function levelOf(sheet) {
  var fields = sheet && sheet.fields ? sheet.fields : {};
  if (!isNumber(fields.level)) return 1;
  return Math.max(1, Math.floor(fields.level));
}

/**
 * 六属性调整值（D&D 5e：`floor((score-10)/2)`）+ HP 上限。
 *
 * 内核投影/公式通过 `derived.mod.<attr>` 读调整值；`formulas.check` 里的 `derived.mod` 会按技能关联属性
 * 自动取对应的 `mod.<attr>`（见 packages/rules/src/sheet.ts buildSheetProjection）。
 *
 * HP 上限放在这里而不是公式里：它要读**职业生命骰**（`fields.hitDie`），而受限公式语言不能按职业分支；
 * 公式 `hpMax` 只是引用 `derived.hpMax`，保证「上限由命名公式给出」这个契约不变。
 * 口径（与旧卡 combat.hpMax 逐项一致）：`hitDie + con 调整 + (level-1) * ceil(hitDie/2)`。
 */
function computeDerived(ctx, sheet) {
  var attributes = sheet && sheet.attributes ? sheet.attributes : {};
  var derived = {};
  var index;
  for (index = 0; index < ABILITY_IDS.length; index += 1) {
    var id = ABILITY_IDS[index];
    var score = attributes[id];
    if (!isNumber(score)) score = 10;
    derived['mod.' + id] = Math.floor((score - 10) / 2);
  }

  var level = levelOf(sheet);
  var fields = sheet && sheet.fields ? sheet.fields : {};
  var hitDie = isNumber(fields.hitDie) && fields.hitDie > 0 ? Math.floor(fields.hitDie) : 8;
  var conMod = isNumber(derived['mod.con']) ? derived['mod.con'] : 0;
  derived.hpMax = Math.max(1, hitDie + conMod + (level - 1) * Math.ceil(hitDie / 2));

  // 法术位：只有施法职业有（卡字段 casterLevel，非施法者 0）；上限口径与旧卡 spells.slots 一致：
  // 一环 = 施法等级 + 1，二环 = 施法等级 - 1（下限 0）。
  var casterLevel = isNumber(fields.casterLevel) && fields.casterLevel > 0 ? Math.floor(fields.casterLevel) : 0;
  derived.slot1Max = casterLevel > 0 ? casterLevel + 1 : 0;
  derived.slot2Max = casterLevel > 1 ? casterLevel - 1 : 0;
  return derived;
}

/**
 * 规则语义校验：返回中文人话问题清单（空数组 = 通过）。
 * 只做 schema 表达不了的部分；属性范围在 `sheet.attributes[].min/max` 里，这里再兜一层，
 * 因为落座时玩家端可能投来旧版本卡。
 */
function validateSheet(ctx, sheet) {
  var errors = [];
  var attributes = sheet && sheet.attributes ? sheet.attributes : {};
  var index;
  for (index = 0; index < ABILITY_IDS.length; index += 1) {
    var id = ABILITY_IDS[index];
    var score = attributes[id];
    if (!isNumber(score) || Math.floor(score) !== score) {
      errors.push('属性「' + ABILITY_NAMES[id] + '」必须是整数');
      continue;
    }
    if (score < ATTRIBUTE_MIN || score > ATTRIBUTE_MAX) {
      errors.push('属性「' + ABILITY_NAMES[id] + '」=' + score + ' 超出 dnd5e-lite 范围 [' + ATTRIBUTE_MIN + ', ' + ATTRIBUTE_MAX + ']');
    }
  }

  var level = levelOf(sheet);
  if (level < 1 || level > 20) errors.push('等级必须是 1–20 的整数');

  var resources = sheet && sheet.resources ? sheet.resources : {};
  for (index = 0; index < RESOURCE_IDS.length; index += 1) {
    var resourceId = RESOURCE_IDS[index];
    var state = resources[resourceId];
    if (state === undefined || state === null) continue;
    if (!isNumber(state.current) || state.current < 0) {
      errors.push('资源「' + resourceId + '」的当前值必须是非负数值');
    }
  }
  var hp = resources.hp;
  if (hp !== undefined && hp !== null && isNumber(hp.max) && isNumber(hp.current) && hp.current > hp.max) {
    errors.push('生命当前值 ' + hp.current + ' 不能超过上限 ' + hp.max);
  }

  var skills = sheet && sheet.skills ? sheet.skills : [];
  for (index = 0; index < skills.length; index += 1) {
    var skill = skills[index];
    if (!skill || !Object.prototype.hasOwnProperty.call(SKILL_ATTRIBUTES, skill.id)) {
      errors.push('技能「' + String(skill && skill.id) + '」不是 dnd5e-lite 的 18 项技能之一');
      continue;
    }
    if (skill.proficient !== undefined && typeof skill.proficient !== 'boolean') {
      errors.push('技能「' + skill.id + '」的 proficient 必须是布尔值');
    }
    if (skill.bonus !== undefined && !isNumber(skill.bonus)) {
      errors.push('技能「' + skill.id + '」的 bonus 必须是数值');
    }
  }

  var statuses = sheet && sheet.statuses ? sheet.statuses : [];
  for (index = 0; index < statuses.length; index += 1) {
    var status = statuses[index];
    if (STATUS_IDS.indexOf(status && status.id) < 0) {
      errors.push('状态「' + String(status && status.id) + '」不在 dnd5e-lite 的 8 种状态里');
    }
  }

  var equipment = sheet && sheet.equipmentInstances ? sheet.equipmentInstances : [];
  for (index = 0; index < equipment.length; index += 1) {
    var instance = equipment[index];
    if (!instance || typeof instance.slot !== 'string' || instance.slot.length === 0) {
      errors.push('装备实例必须带 slot（主手/身上/随身）');
      continue;
    }
    var stats = instance.stats ? instance.stats : {};
    var statKeys = Object.keys(stats);
    for (var statIndex = 0; statIndex < statKeys.length; statIndex += 1) {
      if (!isNumber(stats[statKeys[statIndex]])) {
        errors.push('装备「' + String(instance.name || instance.instanceId) + '」的词条「' + statKeys[statIndex] + '」必须是数值');
      }
    }
  }

  return errors;
}

module.exports = {
  validateSheet: validateSheet,
  computeDerived: computeDerived,
};
