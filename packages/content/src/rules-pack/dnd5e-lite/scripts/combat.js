/**
 * dnd5e-lite 示例规则包 · 战斗脚本（docs/RULES-MODEL §6/§11.2）
 *
 * 导出钩子：
 * - `resolveCheck(ctx, req)`：d20 + 加值 vs DC；优势/劣势掷 2d20 取高/低；20 暴击、1 大失败。
 *   加值由内核按 `formulas.check`（技能总加值）或属性调整算好后放进 `req.modifier`，本钩子只掷骰与判成败。
 * - `resolveAttack(ctx, req)`：d20 + `req.attackBonus`（= `formulas.attack.*` 的结果）vs `req.defense`
 *   （= 目标的 `formulas.defense`）；命中后掷 `action.damage.dice`，加值 = 关联属性调整 + `equip.攻击`。
 *   暴击（d20 ≥ `equip.暴击范围`）时伤害骰结果 ×2（与旧 engine `combat.attack` 的 `diceTotal * times`
 *   同口径，便于数值对照逐项相等）。
 * - `resolveDamage(ctx, evt)`：伤害落账前的抗性/减伤通道。默认数据没有减伤词条 → 原样返回；
 *   若目标身上有效果带 `data.damageReduction`，按其总值减伤并消费该效果（`consumedEffects`）。
 *
 * 约定：动作的命中/伤害公式名带属性后缀（`attack.str` / `damage.dex` …），本脚本据此找「关联属性」；
 * 数值本身仍由数据段 `rules.formulas` 计算，脚本不重复实现公式。
 */

var ABILITY_IDS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
var CRIT_STAT_ID = '暴击范围';
var ATTACK_STAT_ID = '攻击';
var FUMBLE_ROLL = 1;
var CRIT_ROLL = 20;

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function numberOr(value, fallback) {
  return isNumber(value) ? value : fallback;
}

/** 把 ctx.roll 的结果裁成内核认的骰子记录（多带 terms 也无妨，内核只取已知字段）。 */
function diceRecord(roll) {
  return {
    expr: roll && typeof roll.expr === 'string' ? roll.expr : 'd20',
    dice: roll && roll.dice ? roll.dice : [],
    modifier: roll && isNumber(roll.modifier) ? roll.modifier : 0,
    total: roll && isNumber(roll.total) ? roll.total : 0,
  };
}

function normalizeMode(mode) {
  return mode === 'advantage' || mode === 'disadvantage' ? mode : 'normal';
}

/** 掷先攻/检定/攻击的 d20（优势/劣势两次取高/低，不叠加）。 */
function rollD20(ctx, mode) {
  if (mode === 'normal') {
    var single = ctx.roll('d20');
    var singleDice = single.dice;
    return { d20: singleDice[0], roll: single };
  }
  var pair = ctx.roll('2d20');
  var dice = pair.dice;
  var first = dice[0];
  var second = dice[1];
  var picked = mode === 'advantage' ? Math.max(first, second) : Math.min(first, second);
  return { d20: picked, roll: pair };
}

/** 从命名公式（`damage.dex` / `attack.str`）取属性后缀；不是六属性则 null。 */
function abilityOfFormula(name) {
  if (typeof name !== 'string') return null;
  var segments = name.split('.');
  var last = segments[segments.length - 1];
  return ABILITY_IDS.indexOf(last) >= 0 ? last : null;
}

/**
 * 命中/伤害的关联属性：优先 `action.damage.formula`，其次 `action.toHit`；
 * 都没有时退回感知（`wis`，dnd5e-lite 的默认攻击属性由数据决定，这里只是兜底）。
 */
function abilityOfAction(action) {
  if (!action) return null;
  var damage = action.damage ? action.damage : {};
  var fromDamage = abilityOfFormula(damage.formula);
  if (fromDamage !== null) return fromDamage;
  var fromToHit = abilityOfFormula(action.toHit);
  if (fromToHit !== null) return fromToHit;
  return null;
}

/** 伤害加值 = `derived.mod.<attr>` + `equip.攻击`（与 `rules.formulas.damage.*` 同口径）。 */
function damageBonusOf(ctx, action) {
  var ability = abilityOfAction(action);
  var modifier = ability === null ? 0 : numberOr(ctx.derived('mod.' + ability), 0);
  var attackStat = numberOr(ctx.equipment.stats(ATTACK_STAT_ID), 0);
  return modifier + attackStat;
}

/** 检定：d20 + 加值 vs DC。 */
function resolveCheck(ctx, req) {
  var request = req ? req : {};
  var mode = normalizeMode(request.mode);
  var picked = rollD20(ctx, mode);
  var d20 = picked.d20;
  var modifier = numberOr(request.modifier, 0) + numberOr(request.mods, 0);
  var dc = numberOr(request.dc, 10);
  var total = d20 + modifier;
  var crit = d20 === CRIT_ROLL;
  var fumble = d20 === FUMBLE_ROLL;
  var success = !fumble && (crit || total >= dc);
  var degree = crit ? 'crit' : fumble ? 'fumble' : success ? 'success' : 'fail';
  var modeText = mode === 'advantage' ? '（优势）' : mode === 'disadvantage' ? '（劣势）' : '';
  return {
    total: total,
    success: success,
    crit: crit,
    degree: degree,
    d20: d20,
    rolls: [diceRecord(picked.roll)],
    log: '检定 d20=' + d20 + modeText + (modifier >= 0 ? '+' : '') + modifier + ' = ' + total + ' vs DC ' + dc + ' → ' + (crit ? '暴击成功' : fumble ? '大失败' : success ? '成功' : '失败'),
  };
}

/** 攻击：命中判定 + 伤害骰（暴击翻倍伤害骰；加值只算一次，与旧 engine 一致）。 */
function resolveAttack(ctx, req) {
  var request = req ? req : {};
  var action = request.action ? request.action : {};
  var damageDef = action.damage ? action.damage : {};
  var mode = normalizeMode(request.mode);
  var attackBonus = numberOr(request.attackBonus, 0);
  var mods = numberOr(request.mods, 0);
  var defense = numberOr(request.defense, 10);
  var critRange = numberOr(request.critRange, CRIT_ROLL);
  if (critRange < 2 || critRange > CRIT_ROLL) critRange = CRIT_ROLL;

  var picked = rollD20(ctx, mode);
  var d20 = picked.d20;
  var critical = d20 >= critRange;
  var fumble = d20 === FUMBLE_ROLL;
  var total = d20 + attackBonus + mods;
  var hit = !fumble && (critical || total >= defense);

  var rolls = [diceRecord(picked.roll)];
  var diceExpr = typeof damageDef.dice === 'string' && damageDef.dice.length > 0 ? damageDef.dice : null;
  var diceTotal = 0;
  if (hit && diceExpr !== null) {
    var damageRoll = ctx.roll(diceExpr);
    rolls.push(diceRecord(damageRoll));
    // 暴击：伤害骰结果 ×2（旧 engine `combat.attack` 的 `diceTotal * times` 口径，逐项一致）；
    // 伤害加值（属性调整 + equip.攻击）不翻倍。
    diceTotal = critical ? damageRoll.total * 2 : damageRoll.total;
  }
  var bonus = hit ? damageBonusOf(ctx, action) : 0;
  var damage = hit ? Math.max(0, Math.floor(diceTotal + bonus)) : 0;
  var modeText = mode === 'advantage' ? '（优势）' : mode === 'disadvantage' ? '（劣势）' : '';
  var detail = {
    attackBonus: attackBonus,
    mods: mods,
    defense: defense,
    critRange: critRange,
    d20: d20,
    total: total,
    hit: hit,
    crit: critical,
    fumble: fumble,
    damage: damage,
    dice: diceExpr,
    diceTotal: diceTotal,
    bonus: bonus,
  };
  return {
    hit: hit,
    crit: critical,
    damage: damage,
    d20: d20,
    total: total,
    attackBonus: attackBonus,
    defense: defense,
    critRange: critRange,
    rolls: rolls,
    detail: detail,
    log:
      '攻击 d20=' + d20 + modeText + (attackBonus + mods >= 0 ? '+' : '') + (attackBonus + mods) +
      ' = ' + total + ' vs 防御 ' + defense + ' → ' +
      (hit ? (critical ? '暴击命中' : '命中') : '未命中') +
      (hit ? '，伤害 ' + damage + (diceExpr ? '（' + diceExpr + (critical ? '×2' : '') + (bonus !== 0 ? (bonus >= 0 ? '+' : '') + bonus : '') + '）' : '') : ''),
  };
}

/** 伤害落账：按效果上的 `damageReduction` 减伤（默认数据没有 → 原值返回，等价旧 engine）。 */
function resolveDamage(ctx, evt) {
  var event = evt ? evt : {};
  var amount = Math.max(0, Math.floor(numberOr(event.amount, 0)));
  var effects = event.effects && event.effects.length !== undefined ? event.effects : [];
  var reduction = 0;
  var consumed = [];
  var index;
  for (index = 0; index < effects.length; index += 1) {
    var effect = effects[index];
    var data = effect && effect.data ? effect.data : null;
    if (data && isNumber(data.damageReduction) && data.damageReduction > 0) {
      reduction += data.damageReduction;
      if (effect.effectId) consumed.push(effect.effectId);
    }
  }
  var adjusted = Math.max(0, amount - reduction);
  var notes = reduction > 0 ? '减伤 ' + reduction + '：' + amount + ' → ' + adjusted : '';
  return {
    amount: adjusted,
    consumedEffects: consumed,
    notes: notes,
  };
}

module.exports = {
  resolveCheck: resolveCheck,
  resolveAttack: resolveAttack,
  resolveDamage: resolveDamage,
};
