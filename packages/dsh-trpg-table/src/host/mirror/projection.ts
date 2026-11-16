/**
 * 镜像投影的纯函数（host 侧与玩家侧共用）：
 * - 会话/房间事件 → 可读摘要（工具卡只给摘要，不泄露 GM 秘密）；
 * - 房间可见性 → 镜像收件人（`all` / `host` / 指定玩家）；
 * - 玩家行动的注入格式解析（剥掉幕后备注与悄悄话标记）。
 *
 * 这里不做 I/O、不 import node 模块，也不依赖 DSH Harness 包，便于单测与客户端复用。
 */
import type { AwardPayload, DicePayload } from '@dsh-trpg/protocol';
import type { MirrorActionData, MirrorDiceData, MirrorVisibility } from './types.ts';

/** 注入行动后面附带的幕后备注分界（与 host/table-session.ts 的 actionContextBlock 保持一致）。 */
const ACTION_CONTEXT_SEPARATOR = '\n\n---\n\n【本轮 GM 幕后备注';
/** 私密行动在注入文本里的后缀（table-session.promptAction）。 */
const PRIVATE_ACTION_TAG = '（悄悄话给 GM）';

/** 工具结果摘要最大长度（避免把整篇世界书/日志塞进玩家会话）。 */
export const MIRROR_TOOL_RESULT_MAX_CHARS = 600;
/** 旁白/叙事单条最大长度（极端长文截断，仍保留主要文本）。 */
export const MIRROR_NARRATION_MAX_CHARS = 12000;

/** 摘要用的工具中文名。 */
const TOOL_LABEL: Readonly<Record<string, string>> = {
  roll_check: '检定',
  roll_dice: '掷骰',
  attack: '攻击',
  use_action: '动作',
  move: '移动',
  combat: '战斗',
  start_combat: '开战',
  next_turn: '下一回合',
  combat_status: '战斗状态',
  end_combat: '结束战斗',
  secret_note: '私密消息',
  check_lore: '检索世界书',
  reveal_lore: '揭示世界书',
  list_party: '查看队伍',
  scene: '推进场景',
  reward: '发放奖励',
};

/** 全桌可见的工具（结果本身就是公开结算）。 */
const PUBLIC_TOOLS: ReadonlySet<string> = new Set([
  'roll_check',
  'roll_dice',
  'attack',
  'use_action',
  'move',
  'combat',
  'start_combat',
  'next_turn',
  'combat_status',
  'end_combat',
]);

/** 只给 GM 的工具（GM 幕后备注类：世界书检索、场景/奖励控制、队伍完整信息）。 */
const GM_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'check_lore',
  'reveal_lore',
  'list_party',
  'scene',
  'reward',
]);

/** 收件人可见性判定（GM 能看到所有帧；玩家只看 all + 投给自己的）。 */
export function visibleTo(visibility: MirrorVisibility, recipient: { kind: 'host' } | { kind: 'player'; playerId: string }): boolean {
  if (recipient.kind === 'host') return true;
  if (visibility === 'all') return true;
  if (visibility === 'host') return false;
  return visibility.playerId === recipient.playerId;
}

/** 去掉工具名的 `trpg_` 前缀（GM 工具在会话里带前缀，避免与全局工具冲突）。 */
export function shortToolName(name: string): string {
  return name.startsWith('trpg_') ? name.slice('trpg_'.length) : name;
}

/** 工具是否属于跑团桌投影范围（非 trpg 工具不进入玩家镜像）。 */
export function isMirroredTool(name: string): boolean {
  const short = shortToolName(name);
  return PUBLIC_TOOLS.has(short) || GM_ONLY_TOOLS.has(short) || short === 'secret_note';
}

/** 工具调用 → 镜像可见性；`targetPlayerName` 用于 secret_note 找收件玩家。 */
export interface ToolCallPolicy {
  visibility: 'public' | 'host' | 'player';
  targetPlayerName?: string;
}

/**
 * 工具调用的镜像可见性策略。
 * - `secret_note`：只投目标玩家 + GM（内容走房间私密旁白，工具卡只给 GM）；
 * - `roll_check(private=true)`（旧路径暗骰）：只投 GM；
 * - 公开结算工具：全桌；
 * - 其余（GM 幕后备注工具/未知工具）：只投 GM。
 */
export function toolCallPolicy(name: string, args: Readonly<Record<string, unknown>>): ToolCallPolicy {
  const short = shortToolName(name);
  if (short === 'secret_note') {
    const playerName = typeof args.playerName === 'string' ? args.playerName : undefined;
    return { visibility: 'player', ...(playerName !== undefined ? { targetPlayerName: playerName } : {}) };
  }
  if (short === 'roll_check' && args.private === true) return { visibility: 'host' };
  if (PUBLIC_TOOLS.has(short)) {
    // 玩家掷骰的私密标记只在旧路径有意义；公开工具本身仍按全桌处理。
    return { visibility: 'public' };
  }
  return { visibility: 'host' };
}

/** 工具短名 → 中文标签（未知工具退回原名）。 */
export function toolLabel(name: string): string {
  const short = shortToolName(name);
  return TOOL_LABEL[short] ?? short;
}

/** 工具参数（JSON 字符串）解析失败回退空对象。 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 把未知值压成一行短文本（摘要用；对象只取 1 层字符串字段）。 */
function shortValue(value: unknown, max = 80): string {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * 工具**调用**的可读摘要：只描述参数语义，不复制参数原文（秘密文本永远不进摘要）。
 * @param name - 会话里的工具名（带/不带 `trpg_` 前缀均可）。
 * @param args - 已解析的参数对象。
 */
export function summarizeToolCall(name: string, args: Readonly<Record<string, unknown>>): string {
  const short = shortToolName(name);
  switch (short) {
    case 'roll_check': {
      const actor = shortValue(args.actorId ?? args.playerName);
      const skill = shortValue(args.skillId ?? args.skill ?? args.kind ?? args.attributeId, 40);
      const dc = typeof args.dc === 'number' ? args.dc : undefined;
      const reason = shortValue(args.reason, 60);
      const mode = shortValue(args.mode, 20);
      const parts = [`${actor.length > 0 ? `${actor} ` : ''}${skill.length > 0 ? skill : '检定'}`];
      if (dc !== undefined) parts.push(`vs DC ${dc}`);
      if (mode.length > 0 && mode !== 'normal') parts.push(mode === 'advantage' ? '优势' : '劣势');
      if (reason.length > 0) parts.push(`（${reason}）`);
      return `检定：${parts.join(' ')}`;
    }
    case 'roll_dice': {
      const expression = shortValue(args.expression, 40);
      const label = shortValue(args.label, 40);
      return `掷骰 ${expression}${label.length > 0 ? `（${label}）` : ''}`;
    }
    case 'attack': {
      const attacker = shortValue(args.attacker);
      const target = shortValue(args.target);
      return `攻击：${attacker} → ${target}`;
    }
    case 'use_action': {
      const actionId = shortValue(args.actionId, 40);
      const actor = shortValue(args.actorId);
      const target = shortValue(args.targetId);
      return `${actionId.length > 0 ? actionId : '动作'}：${actor}${target.length > 0 ? ` → ${target}` : ''}`;
    }
    case 'move': {
      const actor = shortValue(args.actorId);
      return `移动：${actor}`;
    }
    case 'start_combat': {
      const monsters = shortValue(args.monsters, 60);
      return `开战${monsters.length > 0 ? `：${monsters}` : ''}`;
    }
    case 'combat': {
      const action = shortValue(args.action, 20);
      return `战斗操作${action.length > 0 ? `：${action}` : ''}`;
    }
    case 'secret_note': {
      const playerName = shortValue(args.playerName, 40);
      return `给 ${playerName.length > 0 ? playerName : '某位玩家'} 发一条私密消息`;
    }
    case 'check_lore': {
      const query = shortValue(args.query ?? args.keyword, 40);
      return `检索世界书${query.length > 0 ? `：${query}` : ''}`;
    }
    case 'reveal_lore': {
      const entryId = shortValue(args.entryId, 60);
      return `揭示世界书条目${entryId.length > 0 ? `：${entryId}` : ''}`;
    }
    case 'scene': {
      const sceneId = shortValue(args.sceneId, 60);
      return `推进场景${sceneId.length > 0 ? `：${sceneId}` : ''}`;
    }
    case 'reward': {
      const playerName = shortValue(args.playerName, 40);
      return `给 ${playerName.length > 0 ? playerName : '某位玩家'} 发放奖励`;
    }
    case 'list_party':
      return '查看队伍';
    case 'next_turn':
      return '推进到下一回合';
    case 'combat_status':
      return '查看战斗状态';
    case 'end_combat':
      return '结束战斗';
    default:
      return toolLabel(short);
  }
}

/** 截断长文本（保留首尾，中间省略号）。 */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * 工具**结果**的可读摘要：只保留结算文本，截断超长内容；私密工具由调用方保证不进玩家流。
 * @param name - 工具名。
 * @param text - 工具返回文本。
 */
export function summarizeToolResult(name: string, text: string): string {
  const clean = text.trim();
  const short = shortToolName(name);
  // 私密消息的结果文本会把秘密原文复述一遍（「已私发 阿青：<秘密>」）：摘要里只保留收件人。
  if (short === 'secret_note') {
    const match = /^已私发\s*([^：:]{1,40})[：:]/.exec(clean);
    if (match !== null) return `已私发 ${match[1]?.trim() ?? '目标玩家'}（内容只在该玩家的私密消息里）`;
    return '已私发一条私密消息（内容不下发镜像）';
  }
  if (clean.length === 0) return `${toolLabel(name)}：（无输出）`;
  return truncate(clean, MIRROR_TOOL_RESULT_MAX_CHARS);
}

/** 房间 dice 事件 → 可读掷骰文本。 */
export function formatDiceText(data: MirrorDiceData): string {
  const dice = data.dice.map((die) => String(die)).join(', ');
  const modifier = data.modifier === 0 ? '' : data.modifier > 0 ? ` + ${data.modifier}` : ` - ${Math.abs(data.modifier)}`;
  const label = data.label !== undefined && data.label.length > 0 ? `（${data.label}）` : '';
  const check = data.check !== undefined
    ? ` vs DC ${data.check.dc} → ${data.check.success ? '成功' : '失败'}`
    : '';
  const secret = data.private ? '（暗骰）' : '';
  return `🎲 ${data.rollerName} 掷 ${data.expression}${label}：骰面 [${dice}]${modifier} = ${data.total}${check}${secret}`;
}

/** 房间 dice 事件（protocol payload）→ 镜像 dice 数据。 */
export function diceDataOf(payload: DicePayload): MirrorDiceData {
  return {
    expression: payload.expression,
    dice: [...payload.dice],
    modifier: payload.modifier,
    total: payload.total,
    ...(payload.label !== undefined ? { label: payload.label } : {}),
    rollerName: payload.rollerName,
    private: payload.private,
    ...(payload.check !== undefined
      ? { check: { ...payload.check } }
      : {}),
  };
}

/**
 * 战斗事件 → 一行摘要。兼容旧 `combat`（view 摘要）与 M9.4 `combat/update`（CombatView）。
 * @param payload - 事件 payload（未知形状时给通用提示）。
 */
export function formatCombatText(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as { view?: unknown; combat?: unknown };
    const legacy = record.view as
      | { round?: unknown; activeName?: unknown; order?: Array<{ downed?: unknown; dead?: unknown }> }
      | undefined;
    if (legacy !== undefined && legacy !== null && typeof legacy === 'object') {
      const round = typeof legacy.round === 'number' ? legacy.round : undefined;
      const active = typeof legacy.activeName === 'string' ? legacy.activeName : undefined;
      const order = Array.isArray(legacy.order) ? legacy.order : [];
      const alive = order.filter((entry) => entry?.downed !== true && entry?.dead !== true).length;
      const parts = ['⚔️ 战斗'];
      if (round !== undefined) parts.push(`第 ${round} 轮`);
      if (active !== undefined) parts.push(`行动：${active}`);
      if (order.length > 0) parts.push(`存活 ${alive}/${order.length}`);
      return parts.join(' · ');
    }
    const combat = record.combat as { round?: unknown; maxRounds?: unknown; activeActorId?: unknown; tokens?: Array<{ name?: unknown; actorId?: unknown; dead?: unknown }> } | undefined;
    if (combat !== undefined && combat !== null && typeof combat === 'object') {
      const round = typeof combat.round === 'number' ? combat.round : undefined;
      const maxRounds = typeof combat.maxRounds === 'number' ? combat.maxRounds : undefined;
      const tokens = Array.isArray(combat.tokens) ? combat.tokens : [];
      const activeId = typeof combat.activeActorId === 'string' ? combat.activeActorId : undefined;
      const activeName = activeId !== undefined
        ? tokens.find((token) => token?.actorId === activeId)?.name
        : undefined;
      const alive = tokens.filter((token) => token?.dead !== true).length;
      const parts = ['⚔️ 战斗'];
      if (round !== undefined) parts.push(maxRounds !== undefined && maxRounds > 0 ? `第 ${round}/${maxRounds} 轮` : `第 ${round} 轮`);
      if (typeof activeName === 'string' && activeName.length > 0) parts.push(`行动：${activeName}`);
      if (tokens.length > 0) parts.push(`存活 ${alive}/${tokens.length}`);
      return parts.join(' · ');
    }
  }
  return '⚔️ 战斗状态更新';
}

/** 奖励事件 → 可读文本（私发，只投目标玩家 + GM）。 */
export function formatAwardText(data: AwardPayload | { playerName?: unknown; xp?: unknown; items?: unknown; note?: unknown }): string {
  const playerName = typeof data.playerName === 'string' ? data.playerName : '你';
  const xp = typeof data.xp === 'number' ? data.xp : 0;
  const items = Array.isArray(data.items) ? data.items.filter((item): item is string => typeof item === 'string') : [];
  const note = typeof data.note === 'string' && data.note.length > 0 ? `（${data.note}）` : '';
  const itemText = items.length > 0 ? `，物品：${items.join('、')}` : '';
  return `🎁 ${playerName} 获得 ${xp} XP${itemText}${note}`;
}

/** 场景推进 → 通知文本。 */
export function formatSceneNotice(sceneId: string, title?: string): string {
  return `🎬 场景：${title !== undefined && title.length > 0 ? title : sceneId}`;
}

/** 注入行动文本 → 去掉幕后备注，返回展示文本与是否带备注。 */
export function parseInjectedAction(text: string): { text: string; hadContext: boolean } {
  const index = text.indexOf(ACTION_CONTEXT_SEPARATOR);
  if (index < 0) return { text: text.trim(), hadContext: false };
  return { text: text.slice(0, index).trim(), hadContext: true };
}

/** 去掉私密行动标记（展示时不重复）。 */
export function stripPrivateActionTag(text: string): string {
  return text.split(PRIVATE_ACTION_TAG).join('').trim();
}

/** 玩家行动（镜像帧）→ 原生用户气泡文本：`【角色名】…`。 */
export function formatActionText(data: MirrorActionData): string {
  const who = data.characterName !== undefined && data.characterName.length > 0
    ? data.characterName
    : data.playerName !== undefined && data.playerName.length > 0
      ? data.playerName
      : '玩家';
  const secret = data.private === true ? '（悄悄话）' : '';
  return `【${who}】${secret}${stripPrivateActionTag(data.text)}`;
}

/** 镜像会话标题：`跑团桌：<房名>`（≤ 80 字）。 */
export function buildMirrorTitle(roomTitle: string | undefined): string {
  const title = typeof roomTitle === 'string' ? roomTitle.trim() : '';
  return truncate(title.length > 0 ? `跑团桌：${title}` : '跑团桌', 80);
}

/** 叙事文本截断（超长叙事只保留前 12000 字）。 */
export function truncateNarration(text: string): string {
  return truncate(text, MIRROR_NARRATION_MAX_CHARS);
}
