/**
 * 客户端成长与战报（纯函数，便于单测）：
 * - 把 GM 发的 award 事件累计到本地成长档案（按事件 seq 去重）；
 * - 把一局房间事件导出成 Markdown 战报。
 *
 * M5 会在此基础上把成长写回玩家本地角色卡库；v1 先提供可导出的 JSON + Markdown。
 */
import type { AwardPayload, GameEvent, RoomView } from '@dsh-trpg/protocol';

export interface AwardRecord {
  /** 去重键：`<roomId>:<seq>`。 */
  key: string;
  roomId: string;
  playerId: string;
  playerName: string;
  xp: number;
  items: string[];
  note?: string;
  at: number;
}

export interface GrowthState {
  xp: number;
  items: string[];
  awards: AwardRecord[];
}

const MAX_AWARDS = 200;

export function emptyGrowth(): GrowthState {
  return { xp: 0, items: [], awards: [] };
}

/** 合并一条奖励；同一事件重复到达（SSE 补发）不会重复累计。 */
export function mergeGrowth(current: GrowthState | null, roomId: string, event: GameEvent<'award', AwardPayload>): GrowthState {
  const state = current ?? emptyGrowth();
  const key = `${roomId}:${event.seq}`;
  if (state.awards.some((award) => award.key === key)) return state;
  const payload = event.payload;
  const record: AwardRecord = {
    key,
    roomId,
    playerId: payload.playerId,
    playerName: payload.playerName,
    xp: payload.xp,
    items: [...payload.items],
    ...(payload.note ? { note: payload.note } : {}),
    at: event.at,
  };
  const awards = [...state.awards, record].slice(-MAX_AWARDS);
  const items = awards.flatMap((award) => award.items);
  const xp = awards.reduce((sum, award) => sum + award.xp, 0);
  return { xp, items, awards };
}

/** 成长 → 角色卡补丁（M5 写回本地卡库时使用）。 */
export function growthToCardPatch(growth: GrowthState): { xp: number; items: string[]; note: string } {
  return {
    xp: growth.xp,
    items: [...new Set(growth.items)],
    note: growth.awards.map((award) => `+${award.xp}XP${award.items.length ? `（${award.items.join('、')}）` : ''}${award.note ? ` ${award.note}` : ''}`).join('\n'),
  };
}

export function growthStorageKey(roomId: string, playerId: string): string {
  return `dsh-trpg:growth:v1:${roomId}:${playerId}`;
}

export function loadGrowth(roomId: string, playerId: string, storage?: Pick<Storage, 'getItem'> | null): GrowthState | null {
  try {
    const raw = (storage ?? (globalThis as { localStorage?: Storage }).localStorage)?.getItem(growthStorageKey(roomId, playerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GrowthState;
    if (typeof parsed?.xp !== 'number' || !Array.isArray(parsed?.awards)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveGrowth(roomId: string, playerId: string, growth: GrowthState, storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    (storage ?? (globalThis as { localStorage?: Storage }).localStorage)?.setItem(growthStorageKey(roomId, playerId), JSON.stringify(growth));
  } catch {
    /* 隐私模式忽略 */
  }
}

function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

/** 把一局事件导出成 Markdown 战报（叙事/骰子/场景/奖励/系统）。 */
export function roomToMarkdown(room: RoomView, events: GameEvent[]): string {
  const lines: string[] = [];
  lines.push(`# 跑团战报 · ${room.title}`);
  lines.push('');
  lines.push(`- 房间：${room.roomId}`);
  lines.push(`- 模式：${room.gmMode === 'human' ? '真人 GM' : 'AI GM'}`);
  lines.push(`- 玩家：${room.players.map((player) => player.displayName + (player.characterName ? `（${player.characterName}）` : '')).join('、') || '无'}`);
  if (room.scene) lines.push(`- 当前场景：${room.scene.title ?? room.scene.sceneId}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const event of events) {
    const time = formatTime(event.at);
    if (event.kind === 'narration') {
      const payload = event.payload as { speaker: string; speakerName?: string; text: string };
      const name = payload.speakerName ?? (payload.speaker === 'gm' ? 'GM' : '玩家');
      lines.push(`**${name}**${time ? ` · ${time}` : ''}${event.to !== 'all' ? '（私密）' : ''}`);
      lines.push('');
      lines.push(payload.text);
      lines.push('');
    } else if (event.kind === 'dice') {
      const payload = event.payload as {
        expression: string;
        dice: number[];
        modifier: number;
        total: number;
        label?: string;
        rollerName: string;
        private: boolean;
        check?: { name: string; dc: number; success: boolean };
      };
      const check = payload.check ? ` → ${payload.check.success ? '成功' : '失败'}（DC ${payload.check.dc}）` : '';
      lines.push(`🎲 ${payload.rollerName} ${payload.label ?? '掷骰'}：${payload.expression} = [${payload.dice.join(', ')}]${payload.modifier ? ` + ${payload.modifier}` : ''} = **${payload.total}**${check}${payload.private ? '（私骰）' : ''}`);
      lines.push('');
    } else if (event.kind === 'scene') {
      const payload = event.payload as { sceneId: string; title?: string };
      lines.push(`📍 场景推进：${payload.title ?? payload.sceneId}`);
      lines.push('');
    } else if (event.kind === 'award') {
      const payload = event.payload as AwardPayload;
      lines.push(`🎁 奖励：+${payload.xp} XP${payload.items.length ? `，物品：${payload.items.join('、')}` : ''}${payload.note ? `（${payload.note}）` : ''}`);
      lines.push('');
    } else if (event.kind === 'alert') {
      const payload = event.payload as { text: string };
      lines.push(`> ${payload.text}`);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('> 由 跑团桌 · TRPG Table 导出');
  return lines.join('\n');
}
