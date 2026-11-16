/**
 * dnd5e-lite 示例规则包 · 成长与掉落脚本（docs/RULES-MODEL §6/§11.2）
 *
 * 导出钩子：
 * - `onLevelUp(ctx, req)`：`{ level, fromLevel, xp, gains }` → 卡 patch。
 *   等级写卡（`level` 即 `fields.level`），并把 `progression.grants[]` 的技能点累加进数值字段
 *   `fields.skillPoints`（钩子比缺省行为多做「累加」这一点，其余仍由数据段驱动）。
 * - `generateLoot(ctx, req)`：按 `tables[]` 用种子骰掷表取物品（`ctx.tables.pick` 的随机数走房间种子，
 *   同 eventSeq 可复现）；名称/词条/标签由内核按 `rules.items[]` 补齐，脚本只回 itemId。
 *
 * 约束（§6）：无 require / Date / Math.random；随机只能 ctx.roll / ctx.rng / ctx.tables.pick。
 */

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function numberOr(value, fallback) {
  return isNumber(value) ? value : fallback;
}

/** 升级：写等级 + 累加技能点。 */
function onLevelUp(ctx, req) {
  var request = req ? req : {};
  var level = Math.max(1, Math.floor(numberOr(request.level, 1)));
  var patch = { level: level };
  var gained = 0;
  var notes = [];
  var gains = request.gains && request.gains.length !== undefined ? request.gains : [];
  var index;
  for (index = 0; index < gains.length; index += 1) {
    var gain = gains[index];
    if (!gain) continue;
    if (isNumber(gain.skillPoints) && gain.skillPoints > 0) gained += Math.floor(gain.skillPoints);
    if (typeof gain.note === 'string' && gain.note.length > 0) notes.push(gain.note);
  }
  if (gained > 0) {
    var current = ctx.sheet.get('fields.skillPoints');
    patch['fields.skillPoints'] = Math.max(0, Math.floor(numberOr(current, 0))) + gained;
  }
  ctx.log('dnd5e-lite 升级：' + String(numberOr(request.fromLevel, 1)) + ' → ' + level + ' 级' + (gained > 0 ? '，技能点 +' + gained : ''));
  for (index = 0; index < notes.length; index += 1) ctx.log('成长：' + notes[index]);
  return patch;
}

/** 掉落：按种子骰掷表，返回 `[{ itemId }]`（其余字段由内核按 rules.items[] 补）。 */
function generateLoot(ctx, req) {
  var request = req ? req : {};
  var tableId = typeof request.tableId === 'string' && request.tableId.length > 0 ? request.tableId : null;
  var count = Math.max(1, Math.min(20, Math.floor(numberOr(request.count, 1))));
  var items = [];
  if (tableId === null) return items;
  var index;
  for (index = 0; index < count; index += 1) {
    var picked = ctx.tables.pick(tableId);
    var entry = picked && picked.entry ? picked.entry : null;
    if (entry && typeof entry.itemId === 'string' && entry.itemId.length > 0) {
      items.push({ itemId: entry.itemId, note: '掉落表 ' + tableId });
    }
  }
  return items;
}

module.exports = {
  onLevelUp: onLevelUp,
  generateLoot: generateLoot,
};
