/**
 * 跑团桌房间协议 v1（M0 骨架）。
 *
 * 设计约束（见 docs/DESIGN.md §7）：
 * - 房间协议与 DSH 解耦：DSH 客户端、未来的 QQ adapter、网页 adapter 都只认这套消息。
 * - 客户端提交的行动只带 token 与文本；角色绑定由服务端完成（防「扮演劫色混淆」）。
 * - 服务端事件带单调递增 seq；断线重连时客户端带 lastSeq 补发。
 * - 私密事件在服务端投影阶段决定接收者（to），不依赖客户端隐藏。
 */

export const PROTOCOL_VERSION = 1 as const;

export type PlayerId = string;
export type CharacterId = string;
export type RoomId = string;
export type Seq = number;

/** 玩家行动的可选结构化标签；不替代自由 RP 文本，只是给引擎/AI 的提示。 */
export type ActionTag =
  | 'attack'
  | 'cast'
  | 'check'
  | 'talk'
  | 'move'
  | 'use'
  | 'other';

export interface JoinRequest {
  inviteCode: string;
  playerName: string;
  clientVersion: string;
}

export interface HelloRequest {
  roomId: RoomId;
  playerToken?: string;
}

export interface ActionRequest {
  text: string;
  tags?: ActionTag[];
}

/** 客户端 → 服务端 */
export type ClientMessage =
  | { v: typeof PROTOCOL_VERSION; type: 'hello'; id: string; payload: HelloRequest }
  | { v: typeof PROTOCOL_VERSION; type: 'join'; id: string; payload: JoinRequest }
  | { v: typeof PROTOCOL_VERSION; type: 'action'; id: string; payload: ActionRequest }
  | { v: typeof PROTOCOL_VERSION; type: 'ping'; id: string; payload: { at: number } };

export type RoomPhase = 'lobby' | 'playing' | 'paused' | 'ended';
export type AlertLevel = 'info' | 'warning' | 'error';

/** 服务端 → 客户端的事件种类。 */
export type EventKind =
  | 'welcome'
  | 'room'
  | 'seat'
  | 'narration'
  | 'dice'
  | 'private'
  | 'combat'
  | 'scene'
  | 'alert';

export interface GameEvent<K extends EventKind = EventKind, P = unknown> {
  v: typeof PROTOCOL_VERSION;
  kind: K;
  seq: Seq;
  at: number;
  /** 服务端投影决定：all / gm / 单个 playerId。客户端只读。 */
  to: 'all' | 'gm' | PlayerId;
  payload: P;
}

export interface WelcomePayload {
  roomId: RoomId;
  playerId: PlayerId;
  playerToken: string;
  protocol: typeof PROTOCOL_VERSION;
  displayName: string;
}

export interface RoomPayload {
  roomId: RoomId;
  phase: RoomPhase;
  title: string;
  gmMode: 'ai' | 'human';
  players: Array<{
    playerId: PlayerId;
    displayName: string;
    characterName?: string;
    online: boolean;
    seat: 'gm' | 'player';
  }>;
}

export interface NarrationPayload {
  text: string;
  /** gm = 房主/AI 的旁白；player = 玩家行动；system = 系统提示。 */
  speaker: 'gm' | 'player' | 'system';
  speakerName?: string;
  /** 同一段叙事可标记为战斗轮中的行动，用于 UI 分组。 */
  combatRound?: number;
}

export interface DicePayload {
  expression: string;
  dice: number[];
  modifier: number;
  total: number;
  /** 检定相关（可选）：目标、DC、成败。 */
  check?: {
    kind: 'ability' | 'skill' | 'attack' | 'save';
    name: string;
    dc: number;
    success: boolean;
    mode?: 'normal' | 'advantage' | 'disadvantage';
  };
  /** 私骰时服务端会把它投影给单个玩家。 */
  private?: boolean;
}

export interface AlertPayload {
  text: string;
  level: AlertLevel;
}

export type ServerMessage =
  | { v: typeof PROTOCOL_VERSION; type: 'ack'; id: string }
  | { v: typeof PROTOCOL_VERSION; type: 'error'; id?: string; code: string; message: string }
  | { v: typeof PROTOCOL_VERSION; type: 'event'; event: GameEvent };

// ---------------------------------------------------------------------------
// 校验：手写守卫，零依赖，服务端入口与测试共用。
// ---------------------------------------------------------------------------

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateClientMessage(input: unknown): ValidationResult<ClientMessage> {
  if (!isRecord(input)) return fail('message must be an object');
  if (input.v !== PROTOCOL_VERSION) return fail(`unsupported protocol version: ${String(input.v)}`);
  if (!isNonEmptyString(input.type)) return fail('message.type must be a string');
  if (!isNonEmptyString(input.id)) return fail('message.id must be a string');
  const payload = input.payload;
  if (!isRecord(payload)) return fail('message.payload must be an object');

  switch (input.type) {
    case 'hello':
      if (!isNonEmptyString(payload.roomId)) return fail('hello.roomId must be a string');
      if (payload.playerToken !== undefined && typeof payload.playerToken !== 'string') {
        return fail('hello.playerToken must be a string');
      }
      return { ok: true, value: input as unknown as ClientMessage };
    case 'join':
      if (!isNonEmptyString(payload.inviteCode)) return fail('join.inviteCode must be a string');
      if (!isNonEmptyString(payload.playerName)) return fail('join.playerName must be a string');
      if (!isNonEmptyString(payload.clientVersion)) return fail('join.clientVersion must be a string');
      return { ok: true, value: input as unknown as ClientMessage };
    case 'action': {
      if (!isNonEmptyString(payload.text)) return fail('action.text must be a string');
      if (payload.text.length > 2000) return fail('action.text exceeds 2000 characters');
      if (payload.tags !== undefined) {
        if (!Array.isArray(payload.tags) || payload.tags.some((tag) => !isNonEmptyString(tag))) {
          return fail('action.tags must be a string array');
        }
      }
      return { ok: true, value: input as unknown as ClientMessage };
    }
    case 'ping': {
      if (typeof payload.at !== 'number' || !Number.isFinite(payload.at)) {
        return fail('ping.at must be a finite number');
      }
      return { ok: true, value: input as unknown as ClientMessage };
    }
    default:
      return fail(`unknown message type: ${input.type}`);
  }
}

export function isTerminalEvent(event: GameEvent): boolean {
  return event.kind === 'scene';
}
