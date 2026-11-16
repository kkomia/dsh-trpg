/**
 * dnd5e-lite 示例规则包 · 事件脚本（docs/RULES-MODEL §6/§11.2）
 *
 * 导出钩子：
 * - `onEvent(ctx, event)`：事件总线上的条件/状态后续效果。内核已经做了「状态按回合 tick」，
 *   本钩子只补 dnd5e-lite 自己的口径：
 *   - `damage/after`：目标 HP 归零 → 挂「倒地 + 失能」永久状态（与旧 engine `applyDamage` 一致）；
 *   - `turn/start`：中毒者每回合开始受 1 点毒伤（HP 剩 1 时不再扣，避免把角色毒死）；
 *   - `status/tick` / `round/start` / `round/end` / `level/up` / `equip/change`：只写规则日志（GM 提示）。
 *
 * 返回值形状：`{ effects?, sheetUpdates?, log? }`（§6）。本脚本只用 `effects` 与 `log`；
 * 需要改卡时应走 `ctx.sheet.set` 或 `sheetUpdates`（形状校验同样由内核兜底）。
 */

var ABILITY_IDS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/** 当前事件主角身上的状态 id 列表（ctx.sheet.get 走卡实例路径，读卡上 statuses 投影）。 */
function statusIdsOf(ctx) {
  var statuses = ctx.sheet.get('statuses');
  var ids = [];
  if (!statuses || statuses.length === undefined) return ids;
  var index;
  for (index = 0; index < statuses.length; index += 1) {
    var status = statuses[index];
    if (status && typeof status.id === 'string') ids.push(status.id);
  }
  return ids;
}

/** 挂状态（永久：remaining > 0 才会 tick，-1 = 不 tick）。 */
function applyStatus(ctx, targetActorId, statusId, remaining, stacks) {
  return ctx.effects.apply({
    targetActorId: targetActorId,
    statusId: statusId,
    stacks: typeof stacks === 'number' && stacks > 0 ? stacks : 1,
    remaining: typeof remaining === 'number' ? remaining : -1,
  });
}

function onEvent(ctx, event) {
  var payload = event ? event : {};
  var kind = typeof payload.kind === 'string' ? payload.kind : '';
  var data = payload.data ? payload.data : {};
  var logs = [];
  var index;

  // 目标倒下：倒地 + 失能（旧 engine 在 HP 归零时也挂这两个条件）
  if (kind === 'damage/after') {
    if (data.hpAfter === 0 && typeof data.targetId === 'string') {
      applyStatus(ctx, data.targetId, 'prone', -1, 1);
      applyStatus(ctx, data.targetId, 'incapacitated', -1, 1);
      logs.push('目标 HP 归零：进入倒地/失能');
    }
    return { log: logs };
  }

  // 回合开始：中毒每回合 1 点毒伤（HP 只剩 1 点时不扣，避免规则直接造成死亡）
  if (kind === 'turn/start') {
    var statusIds = statusIdsOf(ctx);
    if (statusIds.indexOf('poisoned') >= 0) {
      var hp = ctx.resource.get('hp');
      if (typeof hp === 'number' && hp > 1) {
        ctx.resource.spend('hp', 1);
        logs.push('中毒发作：受到 1 点毒伤（HP ' + hp + ' → ' + (hp - 1) + '）');
      }
    }
    return { log: logs };
  }

  // 状态 tick：只记录（时长/移除由内核维护）
  if (kind === 'status/tick') {
    if (data.removed === true && typeof data.name === 'string') {
      logs.push('状态结束：' + data.name);
    }
    return { log: logs };
  }

  if (kind === 'round/start') {
    logs.push('第 ' + String(data.round) + ' 轮开始');
    return { log: logs };
  }

  if (kind === 'round/end') {
    logs.push('第 ' + String(data.round) + ' 轮结束');
    return { log: logs };
  }

  if (kind === 'round/limit') {
    logs.push('达到回合上限（第 ' + String(data.round) + ' 轮）');
    return { log: logs };
  }

  if (kind === 'level/up') {
    logs.push('升级：' + String(data.fromLevel) + ' → ' + String(data.level) + ' 级');
    return { log: logs };
  }

  if (kind === 'equip/change') {
    var attack = ctx.equipment.stats('攻击');
    var defense = ctx.equipment.stats('防御');
    var initiative = ctx.equipment.stats('先攻');
    logs.push('换装完成：攻击 +' + String(attack) + ' / 防御 +' + String(defense) + ' / 先攻 +' + String(initiative));
    return { log: logs };
  }

  if (kind === 'death') {
    logs.push('角色倒下，等待抢救或复活');
    return { log: logs };
  }

  // 维持六属性引用（避免脚本被裁剪时的静态检查告警；也便于将来扩展）
  void ABILITY_IDS;
  return {};
}

module.exports = {
  onEvent: onEvent,
};
