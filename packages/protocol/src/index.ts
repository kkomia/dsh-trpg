/**
 * 跑团桌房间协议 v1（M2）。
 *
 * 约束（见 docs/DESIGN.md §7）：
 * - 与 DSH 解耦：DSH 客户端、未来 QQ/网页 adapter 都只认这套 RPC + SSE。
 * - 行动/角色身份由服务端绑定（token → playerId），客户端只提交文本。
 * - 事件带单调递增 seq；断线重连用 lastSeq 补发。
 * - 私密事件在服务端投影阶段决定接收者（to），客户端无法伪造。
 */

export const PROTOCOL_VERSION = 1 as const;

export type PlayerId = string;
export type RoomId = string;
export type Seq = number;

export type RoomPhase = 'lobby' | 'playing' | 'paused' | 'ended';
export type GMMode = 'ai' | 'human';

/** 事件接收者：全桌 / 仅 GM（含房主）/ 单个玩家。GM 永远能看到所有事件。 */
export type EventTarget = 'all' | 'gm' | PlayerId;

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export interface RoomPlayerView {
  playerId: PlayerId;
  displayName: string;
  seat: 'gm' | 'player';
  online: boolean;
  characterName?: string;
  characterSummary?: string;
}

export interface RoomView {
  roomId: RoomId;
  title: string;
  phase: RoomPhase;
  gmMode: GMMode;
  locked: boolean;
  /** 只有房主（host 身份）能看到邀请码。 */
  inviteCode?: string;
  players: RoomPlayerView[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export type EventKind = 'room' | 'narration' | 'dice' | 'alert' | 'scene' | 'combat' | 'private';

export interface GameEvent<K extends EventKind = EventKind, P = unknown> {
  v: typeof PROTOCOL_VERSION;
  kind: K;
  seq: Seq;
  at: number;
  to: EventTarget;
  payload: P;
}

export interface NarrationPayload {
  /** gm = AI/真人 GM 旁白；player = 玩家行动；system = 系统提示。 */
  speaker: 'gm' | 'player' | 'system';
  speakerName?: string;
  playerId?: PlayerId;
  text: string;
}

export interface DicePayload {
  expression: string;
  dice: number[];
  modifier: number;
  total: number;
  label?: string;
  rollerName: string;
  playerId: PlayerId;
  private: boolean;
  /** 检定结果（M3 战斗接入后使用）。 */
  check?: {
    kind: 'ability' | 'skill' | 'attack' | 'save';
    name: string;
    dc: number;
    success: boolean;
  };
}

export interface AlertPayload {
  level: 'info' | 'warning' | 'error';
  text: string;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export interface RpcRequest {
  method: RpcMethod;
  params?: unknown;
  token?: string;
  /** 客户端版本，便于以后做兼容性提示。 */
  clientVersion?: string;
}

export interface RpcError {
  code:
    | 'bad-request'
    | 'unauthorized'
    | 'forbidden'
    | 'not-found'
    | 'room-locked'
    | 'invalid-card'
    | 'invalid-expression'
    | 'conflict'
    | 'internal';
  message: string;
}

export type RpcResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: RpcError };

export type RpcMethod =
  | 'room.create'
  | 'room.join'
  | 'room.state'
  | 'room.seat'
  | 'room.roll'
  | 'room.say'
  | 'room.leave'
  | 'room.kick'
  | 'room.lock'
  | 'room.list'
  | 'host.session';

export interface CreateRoomParams {
  title: string;
  gmMode: GMMode;
}

export interface CreateRoomResult {
  room: RoomView;
  hostToken: string;
  inviteCode: string;
}

export interface JoinRoomParams {
  inviteCode: string;
  playerName: string;
  characterCard?: unknown;
}

export interface JoinRoomResult {
  room: RoomView;
  playerId: PlayerId;
  playerToken: string;
}

export interface SeatParams {
  characterCard: unknown;
}

export interface RollParams {
  expression: string;
  label?: string;
  private?: boolean;
}

export interface SayParams {
  text: string;
  /** true = 悄悄话给 GM，不进公共叙事。 */
  private?: boolean;
}

export interface KickParams {
  playerId: PlayerId;
}

export interface LockParams {
  locked: boolean;
}

export interface HostSessionParams {
  roomId: RoomId;
}

export interface RoomStateResult {
  room: RoomView;
}

export interface RollResult {
  event: GameEvent<'dice', DicePayload>;
}

export interface SayResult {
  event: GameEvent<'narration', NarrationPayload>;
}

export interface RoomListResult {
  rooms: Array<{ roomId: RoomId; title: string; phase: RoomPhase; gmMode: GMMode; players: number }>;
}

// ---------------------------------------------------------------------------
// 校验（手写守卫，零依赖）
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
  return typeof value === 'string' && value.trim().length > 0;
}

const METHODS: readonly RpcMethod[] = [
  'room.create',
  'room.join',
  'room.state',
  'room.seat',
  'room.roll',
  'room.say',
  'room.leave',
  'room.kick',
  'room.lock',
  'room.list',
  'host.session',
];

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && (METHODS as readonly string[]).includes(value);
}

export function validateRpcRequest(input: unknown): ValidationResult<RpcRequest> {
  if (!isRecord(input)) return fail('RPC 请求必须是对象');
  if (!isRpcMethod(input.method)) return fail(`未知 RPC 方法：${String(input.method)}`);
  if (input.token !== undefined && typeof input.token !== 'string') return fail('token 必须是字符串');
  if (input.params !== undefined && !isRecord(input.params)) return fail('params 必须是对象');
  return { ok: true, value: input as unknown as RpcRequest };
}

export function validateCreateRoom(params: unknown): ValidationResult<CreateRoomParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.title)) return fail('房间标题必填');
  if (params.title.length > 60) return fail('房间标题过长（最多 60 字）');
  if (params.gmMode !== 'ai' && params.gmMode !== 'human') return fail('gmMode 必须是 ai 或 human');
  return { ok: true, value: params as unknown as CreateRoomParams };
}

export function validateJoin(params: unknown): ValidationResult<JoinRoomParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.inviteCode)) return fail('邀请码必填');
  if (!isNonEmptyString(params.playerName)) return fail('玩家名必填');
  if (params.playerName.length > 30) return fail('玩家名过长（最多 30 字）');
  return { ok: true, value: params as unknown as JoinRoomParams };
}

export function validateRoll(params: unknown): ValidationResult<RollParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.expression)) return fail('骰子表达式必填');
  if (params.expression.length > 40) return fail('骰子表达式过长');
  if (params.private !== undefined && typeof params.private !== 'boolean') return fail('private 必须是布尔值');
  return { ok: true, value: params as unknown as RollParams };
}

export function validateSay(params: unknown): ValidationResult<SayParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.text)) return fail('内容不能为空');
  if (params.text.length > 3000) return fail('内容过长（最多 3000 字）');
  if (params.private !== undefined && typeof params.private !== 'boolean') return fail('private 必须是布尔值');
  return { ok: true, value: params as unknown as SayParams };
}

/** 事件的 SSE 线格式。 */
export function encodeSseEvent(event: GameEvent): string {
  return `event: game\ndata: ${JSON.stringify(event)}\n\n`;
}
