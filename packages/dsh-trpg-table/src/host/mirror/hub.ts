/**
 * 房主侧镜像投影中枢（M7）：订阅房间全量事件 + 牌桌会话事件，按收件人投影成
 * 带递增 seq 的镜像帧，环形缓冲 ≥500，供 `/trpg/mirror` SSE 重放。
 *
 * 投影规则（安全边界）：
 * - 公开叙事/骰子/战斗/场景 → 全桌；
 * - 玩家公开行动 → 全桌（带【角色名】）；悄悄话行动 → 行动者 + GM；
 * - GM 秘密工具（世界书检索/场景/奖励/队伍）与暗骰 → 仅 GM；
 * - `trpg_secret_note` 的工具卡仅 GM，私密内容作为房间私密旁白只投目标玩家 + GM；
 * - 非跑团桌工具（read/pwsh/web_search 等）一律不进入镜像；
 * - 工具卡只投可读摘要（调用摘要 + 结果摘要），不复制原始参数/长文。
 *
 * seq 由本中枢单调分配（不是房间 seq），因此私密帧对无权限的收件人会表现为跳号——
 * 这是有意的：玩家侧只按收到的顺序 append（append 自己重分配会话 seq）。
 */
import type { AwardPayload, DicePayload, NarrationPayload } from '@dsh-trpg/protocol';
import type { GameEvent, PlayerActionInfo, Principal } from '@dsh-trpg/rooms';
import { extractAssistantText } from '../gm/runtime.ts';
import {
  diceDataOf,
  formatAwardText,
  formatCombatText,
  formatSceneNotice,
  isMirroredTool,
  parseInjectedAction,
  parseToolArguments,
  shortToolName,
  summarizeToolCall,
  summarizeToolResult,
  toolCallPolicy,
  truncateNarration,
  visibleTo,
} from './projection.ts';
import {
  MIRROR_MAX_BUFFER,
  MIRROR_PROTOCOL_VERSION,
  type MirrorFrame,
  type MirrorSink,
  type MirrorVisibility,
} from './types.ts';

/** 参与镜像的玩家（名字用于解析 `trpg_secret_note` 的收件人）。 */
export interface MirrorPlayerInfo {
  playerId: string;
  playerName: string;
  characterName?: string;
}

/** 镜像中枢依赖（host 注入；不 import 房间实现，便于单测）。 */
export interface MirrorHubOptions {
  /** 房间当前玩家席（解析私发目标用）。 */
  playersOf: (roomId: string) => MirrorPlayerInfo[];
  log?: (message: string) => void;
  now?: () => number;
  /** 环形缓冲上限（默认 {@link MIRROR_MAX_BUFFER}）。 */
  maxBuffer?: number;
}

/** 帧草稿（不含中枢分配的 v/seq/at）。 */
type FrameDraft = {
  [K in MirrorFrame['kind']]: Omit<Extract<MirrorFrame, { kind: K }>, 'v' | 'seq' | 'at'>;
}[MirrorFrame['kind']];

interface BufferedFrame {
  seq: number;
  visibility: MirrorVisibility;
  frame: MirrorFrame;
}

interface Subscriber {
  principal: Principal;
  sink: MirrorSink;
}

interface PendingAction {
  playerId: string;
  playerName: string;
  characterName?: string;
  /** 展示用正文（不含幕后备注/私密标记）。 */
  displayText: string;
  /** 实际注入会话的完整文本（含幕后备注）。 */
  injectedText: string;
  private: boolean;
}

interface RoomState {
  roomId: string;
  title?: string;
  sessionId?: string;
  /** 下一条帧的 seq（从 1 开始）。 */
  nextSeq: number;
  buffer: BufferedFrame[];
  subscribers: Set<Subscriber>;
  pendingActions: PendingAction[];
  /** 最近 assistant 文本（用于去掉房间旁白回声）。 */
  recentAssistantTexts: string[];
  /** 已发出 tool/call、等待 tool/result 的工具（callId → 工具名/可见性）。 */
  toolCalls: Map<string, { name: string; visibility: MirrorVisibility }>;
}

/** 从消息/事件 data 里拼接文本块。 */
function textOfContent(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type?: unknown; text?: unknown } => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();
}

/** 会话事件 data → 文本（user/message 是裸消息，其它消息类在 `message` 字段）。 */
function messageText(data: unknown): string {
  if (data === null || typeof data !== 'object') return '';
  const nested = (data as { message?: unknown }).message;
  return nested !== undefined ? textOfContent(nested) : textOfContent(data);
}

/** 镜像投影中枢。 */
export class RoomMirrorHub {
  private readonly rooms = new Map<string, RoomState>();
  private readonly sessionRooms = new Map<string, string>();
  private readonly playersOf: (roomId: string) => MirrorPlayerInfo[];
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly maxBuffer: number;

  constructor(options: MirrorHubOptions) {
    this.playersOf = options.playersOf;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.maxBuffer = Math.max(1, options.maxBuffer ?? MIRROR_MAX_BUFFER);
  }

  // -------------------------------------------------------------------------
  // 房间生命周期
  // -------------------------------------------------------------------------

  /** 登记房间（建房/续团时调用；重复调用只更新标题）。 */
  registerRoom(roomId: string, title?: string): void {
    const existing = this.rooms.get(roomId);
    if (existing !== undefined) {
      if (title !== undefined) existing.title = title;
      return;
    }
    this.rooms.set(roomId, {
      roomId,
      ...(title !== undefined ? { title } : {}),
      nextSeq: 1,
      buffer: [],
      subscribers: new Set(),
      pendingActions: [],
      recentAssistantTexts: [],
      toolCalls: new Map(),
    });
  }

  /** 该房间是否已登记。 */
  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** 房名（镜像会话标题用）。 */
  titleOf(roomId: string): string | undefined {
    return this.rooms.get(roomId)?.title;
  }

  /** 把房间绑定到牌桌会话（会话事件按此找到房间）。 */
  bindSession(roomId: string, sessionId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    if (room.sessionId !== undefined) this.sessionRooms.delete(room.sessionId);
    room.sessionId = sessionId;
    this.sessionRooms.set(sessionId, roomId);
  }

  /** 解绑会话（房间关闭/换会话）。 */
  unbindSession(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    if (room.sessionId !== undefined) this.sessionRooms.delete(room.sessionId);
    delete room.sessionId;
    room.pendingActions.length = 0;
    room.toolCalls.clear();
  }

  /** 房间关闭：断开订阅并释放该房间全部状态。 */
  disposeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    this.closeRoom(room, '房主关闭了房间');
    this.unbindSession(roomId);
    this.rooms.delete(roomId);
  }

  /** 插件卸载：断开全部订阅并释放状态。 */
  dispose(): void {
    for (const room of [...this.rooms.values()]) this.closeRoom(room, '镜像服务已停止');
    this.rooms.clear();
    this.sessionRooms.clear();
  }

  private closeRoom(room: RoomState, reason: string): void {
    for (const subscriber of [...room.subscribers]) {
      try {
        subscriber.sink.close(reason);
      } catch {
        /* 单个连接异常不影响清理 */
      }
    }
    room.subscribers.clear();
  }

  // -------------------------------------------------------------------------
  // 订阅 / 重放
  // -------------------------------------------------------------------------

  /** 缓冲窗口：最旧/最新 seq（无缓冲时 oldest = latest = nextSeq - 1）。 */
  seqRange(roomId: string): { oldest: number; latest: number } | undefined {
    const room = this.rooms.get(roomId);
    if (room === undefined) return undefined;
    const latest = room.nextSeq - 1;
    const oldest = room.buffer[0]?.seq ?? latest;
    return { oldest, latest };
  }

  /** 取 lastSeq 之后对该收件人可见、且仍在缓冲内的帧（断线重放）。 */
  eventsSince(principal: Principal, lastSeq: number): MirrorFrame[] {
    const room = this.rooms.get(principal.roomId);
    if (room === undefined) return [];
    return room.buffer
      .filter((entry) => entry.seq > lastSeq && visibleTo(entry.visibility, principal))
      .map((entry) => entry.frame);
  }

  /** 订阅该收件人的可见帧；返回取消函数。 */
  subscribe(principal: Principal, sink: MirrorSink): () => void {
    const room = this.rooms.get(principal.roomId);
    if (room === undefined) return () => {};
    const subscriber: Subscriber = { principal, sink };
    room.subscribers.add(subscriber);
    return () => {
      room.subscribers.delete(subscriber);
    };
  }

  /** 当前房间的帧数（诊断/测试用）。 */
  bufferedCount(roomId: string): number {
    return this.rooms.get(roomId)?.buffer.length ?? 0;
  }

  // -------------------------------------------------------------------------
  // 事件入口
  // -------------------------------------------------------------------------

  /** 玩家行动注入会话前登记（用于把会话 user/message 认领成「谁的公开/私密行动」）。 */
  noteInjectedAction(roomId: string, info: PlayerActionInfo, injectedText: string): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    room.pendingActions.push({
      playerId: info.playerId,
      playerName: info.playerName,
      ...(info.characterName !== undefined ? { characterName: info.characterName } : {}),
      displayText: info.text,
      injectedText,
      private: info.private,
    });
    if (room.pendingActions.length > 16) room.pendingActions.splice(0, room.pendingActions.length - 16);
  }

  /**
   * 房间全量事件（`RoomService.subscribeAll`）→ 镜像帧。
   * @param roomId - 房间 id。
   * @param event - 房间事件（含私密事件，本方法按收件人重新投影）。
   */
  onRoomEvent(roomId: string, event: GameEvent): void {
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    switch (event.kind) {
      case 'narration': {
        const payload = event.payload as NarrationPayload;
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (text.length === 0) return;
        if (payload.speaker === 'system') {
          this.emit(room, 'all', { kind: 'notice', data: { text } });
          return;
        }
        if (payload.speaker === 'player') {
          // 已绑定牌桌会话时，玩家行动由会话 user/message 投影（带【角色名】），避免重复。
          if (room.sessionId !== undefined) return;
          if (event.to === 'all') {
            this.emit(room, 'all', {
              kind: 'action',
              data: {
                ...(payload.playerId !== undefined ? { playerId: payload.playerId } : {}),
                ...(payload.speakerName !== undefined ? { playerName: payload.speakerName } : {}),
                text,
              },
            });
            return;
          }
          // 悄悄话给 GM：只投 GM（收件玩家自己通过会话 user/message 看到自己的行动）。
          this.emit(room, 'host', { kind: 'action', data: { text, private: true } });
          return;
        }
        const visibility = this.visibilityOfTarget(event.to);
        if (visibility === 'all' && this.consumeAssistantEcho(room, text)) return;
        this.emit(room, visibility, {
          kind: 'narration',
          data: {
            text: truncateNarration(text),
            ...(payload.speakerName !== undefined ? { speakerName: payload.speakerName } : {}),
            ...(visibility !== 'all' ? { private: true } : {}),
          },
        });
        return;
      }
      case 'dice': {
        const payload = event.payload as DicePayload;
        this.emit(room, this.visibilityOfTarget(event.to), { kind: 'dice', data: diceDataOf(payload) });
        return;
      }
      case 'combat':
      case 'combat/update': {
        this.emit(room, 'all', { kind: 'combat', data: { text: formatCombatText(event.payload) } });
        return;
      }
      case 'award': {
        const payload = event.payload as AwardPayload;
        this.emit(room, { playerId: payload.playerId }, {
          kind: 'award',
          data: {
            playerName: payload.playerName,
            xp: payload.xp,
            items: Array.isArray(payload.items) ? [...payload.items] : [],
            ...(payload.note !== undefined ? { note: payload.note } : {}),
          },
        });
        return;
      }
      case 'scene': {
        const payload = event.payload as { sceneId?: unknown; title?: unknown };
        const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : '';
        const title = typeof payload.title === 'string' ? payload.title : undefined;
        this.emit(room, 'all', { kind: 'notice', data: { text: formatSceneNotice(sceneId, title) } });
        return;
      }
      default:
        // room / alert / sheet/update / rules/error / private 不进镜像（右栏实时记录仍可见）。
        return;
    }
  }

  /**
   * 牌桌会话事件 → 镜像帧（只处理行动/叙事/工具卡；turn/step/title 由玩家侧本地合成）。
   * @param sessionId - 事件所属会话。
   * @param type - 会话事件类型。
   * @param data - 事件数据。
   */
  onSessionEvent(sessionId: string, type: string | undefined, data: unknown): void {
    if (type === undefined) return;
    const roomId = this.sessionRooms.get(sessionId);
    if (roomId === undefined) return;
    const room = this.rooms.get(roomId);
    if (room === undefined) return;
    switch (type) {
      case 'user/message': {
        this.onUserMessage(room, data);
        return;
      }
      case 'assistant/message': {
        const text = extractAssistantText((data as { message?: unknown } | undefined)?.message);
        if (text.length === 0) return;
        room.recentAssistantTexts.push(text);
        if (room.recentAssistantTexts.length > 20) room.recentAssistantTexts.shift();
        this.emit(room, 'all', { kind: 'narration', data: { text: truncateNarration(text) } });
        return;
      }
      case 'tool/call': {
        this.onToolCall(room, data);
        return;
      }
      case 'tool/result': {
        this.onToolResult(room, data);
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // 内部投影
  // -------------------------------------------------------------------------

  private onUserMessage(room: RoomState, data: unknown): void {
    const text = messageText(data);
    if (text.length === 0) return;
    const index = room.pendingActions.findIndex((pending) => text === pending.injectedText);
    const fallbackIndex = index >= 0
      ? index
      : room.pendingActions.findIndex((pending) => text.startsWith(pending.injectedText));
    if (fallbackIndex >= 0) {
      const [action] = room.pendingActions.splice(fallbackIndex, 1);
      if (action !== undefined) {
        this.emit(room, action.private ? { playerId: action.playerId } : 'all', {
          kind: 'action',
          data: {
            playerId: action.playerId,
            playerName: action.playerName,
            ...(action.characterName !== undefined ? { characterName: action.characterName } : {}),
            text: action.displayText,
            ...(action.private ? { private: true } : {}),
          },
        });
      }
      return;
    }
    // 房主在牌桌会话里手动输入：可能是 GM 幕后备注，外泄风险 > 收益 → 只投 GM。
    const parsed = parseInjectedAction(text);
    if (parsed.text.length === 0) return;
    this.emit(room, 'host', { kind: 'action', data: { text: parsed.text, private: true } });
  }

  private onToolCall(room: RoomState, data: unknown): void {
    const record = data as { name?: unknown; arguments?: unknown; callId?: unknown } | undefined;
    const name = typeof record?.name === 'string' ? record.name : '';
    if (name.length === 0 || !isMirroredTool(name)) return;
    const args = parseToolArguments(record?.arguments);
    const policy = toolCallPolicy(name, args);
    let visibility: MirrorVisibility;
    if (policy.visibility === 'public') visibility = 'all';
    else if (policy.visibility === 'host') visibility = 'host';
    else {
      const target = this.resolvePlayer(room, policy.targetPlayerName);
      visibility = target !== undefined ? { playerId: target.playerId } : 'host';
    }
    // 私密消息的工具卡只给 GM：目标玩家拿到的是一句私密旁白，不是工具卡。
    if (shortToolName(name) === 'secret_note') visibility = 'host';
    const callId = typeof record?.callId === 'string' && record.callId.length > 0
      ? record.callId
      : `mirror-call-${room.nextSeq}`;
    room.toolCalls.set(callId, { name, visibility });
    this.emit(room, visibility, {
      kind: 'tool',
      data: { phase: 'call', callId, name: shortToolName(name), summary: summarizeToolCall(name, args) },
    });
  }

  private onToolResult(room: RoomState, data: unknown): void {
    const record = data as
      | { message?: unknown; error?: { name?: unknown; reason?: unknown }; callId?: unknown }
      | undefined;
    const message = record?.message as { toolCallId?: unknown; source?: { callId?: unknown }; isError?: unknown } | undefined;
    const callId = typeof message?.toolCallId === 'string'
      ? message.toolCallId
      : typeof message?.source?.callId === 'string'
        ? message.source.callId
        : typeof record?.callId === 'string'
          ? record.callId
          : '';
    if (callId.length === 0) return;
    const cached = room.toolCalls.get(callId);
    if (cached === undefined) return;
    room.toolCalls.delete(callId);
    const text = messageText(record);
    const error = record?.error;
    const isError = error !== undefined || message?.isError === true;
    const errorText = error !== undefined
      ? `${typeof error.name === 'string' ? error.name : '工具错误'}${typeof error.reason === 'string' ? `：${error.reason}` : ''}`
      : '';
    this.emit(room, cached.visibility, {
      kind: 'tool',
      data: {
        phase: isError ? 'error' : 'result',
        callId,
        name: shortToolName(cached.name),
        summary: isError ? summarizeToolResult(cached.name, text.length > 0 ? text : errorText) : summarizeToolResult(cached.name, text),
      },
    });
  }

  /** 房间事件收件人 → 镜像可见性。 */
  private visibilityOfTarget(target: GameEvent['to']): MirrorVisibility {
    if (target === 'all') return 'all';
    if (target === 'gm') return 'host';
    return { playerId: target };
  }

  /** 去掉「assistant 消息 → 房间旁白」的回声（返回 true = 这条房间旁白是回声，已消费）。 */
  private consumeAssistantEcho(room: RoomState, text: string): boolean {
    const index = room.recentAssistantTexts.indexOf(text);
    if (index < 0) return false;
    room.recentAssistantTexts.splice(index, 1);
    return true;
  }

  /** 按玩家名/角色名解析玩家席。 */
  private resolvePlayer(room: RoomState, name: string | undefined): MirrorPlayerInfo | undefined {
    if (name === undefined || name.length === 0) return undefined;
    let players: MirrorPlayerInfo[];
    try {
      players = this.playersOf(room.roomId);
    } catch {
      return undefined;
    }
    return players.find((player) => player.playerName === name)
      ?? players.find((player) => player.characterName === name);
  }

  /** 分配 seq、入环形缓冲并投递给可见订阅者。 */
  private emit(room: RoomState, visibility: MirrorVisibility, draft: FrameDraft): MirrorFrame {
    const seq = room.nextSeq;
    room.nextSeq += 1;
    const frame = { ...draft, v: MIRROR_PROTOCOL_VERSION, seq, at: this.now() } as MirrorFrame;
    room.buffer.push({ seq, visibility, frame });
    if (room.buffer.length > this.maxBuffer) room.buffer.splice(0, room.buffer.length - this.maxBuffer);
    for (const subscriber of [...room.subscribers]) {
      if (!visibleTo(visibility, subscriber.principal)) continue;
      try {
        subscriber.sink.frame(frame);
      } catch {
        /* 单个连接异常不影响广播 */
      }
    }
    return frame;
  }
}
