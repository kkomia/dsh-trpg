/**
 * 玩家侧镜像服务（M7）：连房主的 `/trpg/mirror` SSE → 本地镜像会话 → `session.append()`。
 *
 * 关键性质：
 * - **一次性确保本地镜像会话存在**（同一房间重连/重进复用同一个会话，避免刷会话列表）；
 * - 按帧 seq 去重/排序；断线用 `lastSeq` 续传，跨过被淘汰历史时写一条提示行；
 * - 只 append DSH 已知事件（白名单），**不唤醒模型**、不写 request/header、标题钉住
 *   （`session/title source.kind='user'`），因此不会触发自动命名 LLM；
 * - 会话服务不可用 / 创建失败 → 状态降级为 `unavailable`/`error`（客户端据此提示 P0 兜底）。
 *
 * 本模块只跑在插件 host（node）里，不进入 client bundle。
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  closeMirrorTurn,
  createMirrorMapState,
  mapMirrorFrame,
  mirrorGapNoticeEvent,
  mirrorTitleEvent,
  type MirrorMapState,
  type MirrorSessionEventInput,
} from './mapping.ts';
import { buildMirrorTitle } from './projection.ts';
import {
  MIRROR_PROTOCOL_VERSION,
  type MirrorCloseFrame,
  type MirrorFrame,
  type MirrorReadyFrame,
  type MirrorStartRequest,
  type MirrorStatus,
} from './types.ts';

/** 本地镜像会话的最小结构面（DSH Session）。 */
export interface MirrorSessionLike {
  append(...args: unknown[]): unknown;
}

/** `ctx.sessions` 的最小结构面。 */
export interface MirrorSessionsLike {
  create?(id?: unknown, options?: unknown): MirrorSessionLike;
  get?(id: string): MirrorSessionLike | undefined;
}

/** 一次会话创建结果。 */
export interface MirrorSessionHandle {
  session: MirrorSessionLike;
  sessionId?: string;
}

/** 会话创建工厂（host 注入：优先走 UI 同款的 `sessionController.create`，可被原生界面打开）。 */
export type MirrorSessionFactory = () => Promise<MirrorSessionHandle> | MirrorSessionHandle;

/** 玩家侧镜像服务依赖。 */
export interface MirrorClientOptions {
  /** 读到 DSH 会话服务（`ctx.sessions`）；未注入/不可用时降级。 */
  getSessions?: () => MirrorSessionsLike | undefined;
  /**
   * 会话创建工厂（host 注入：`sessionController.create()` + `sessions.get()`）。
   * 缺省回退到 `ctx.sessions.create()`（裸会话：不在持久化目录里，原生界面打不开，仅兜底/单测）。
   */
  createSession?: MirrorSessionFactory;
  log?: (message: string) => void;
  now?: () => number;
  createId?: (prefix: string) => string;
  /** 重连基准延迟（ms，默认 1500）。 */
  reconnectDelayMs?: number;
  /** 最大重连次数（默认 8）。 */
  maxReconnectAttempts?: number;
}

/** 启动参数校验结果。 */
export type MirrorStartValidation =
  | { ok: true; value: MirrorStartRequest }
  | { ok: false; error: string };

/** 房间 id 的安全字符集（host 生成 UUID；允许测试用短 id）。 */
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** 房间 token（base64url 随机串；兼容测试里的短 token）。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{4,512}$/;

/** 校验并规范化启动参数（中文错误）。 */
export function validateMirrorStart(input: unknown): MirrorStartValidation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '启动参数必须是对象（base / roomId / token）' };
  }
  const record = input as Record<string, unknown>;
  const baseRaw = typeof record.base === 'string' ? record.base.trim() : '';
  if (baseRaw.length === 0) return { ok: false, error: '缺少房主地址 base' };
  if (baseRaw.length > 2048) return { ok: false, error: '房主地址过长（上限 2048 字符）' };
  let url: URL;
  try {
    url = new URL(baseRaw);
  } catch {
    return { ok: false, error: `房主地址不是合法 URL：${baseRaw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `房主地址只支持 http/https（收到 ${url.protocol}）` };
  }
  if (url.hostname.length === 0) return { ok: false, error: '房主地址缺少主机名' };
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  const roomId = typeof record.roomId === 'string' ? record.roomId.trim() : '';
  if (!ROOM_ID_PATTERN.test(roomId)) return { ok: false, error: '缺少合法的 roomId' };
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!TOKEN_PATTERN.test(token)) return { ok: false, error: '缺少合法的房间令牌 token' };
  const playerName = typeof record.playerName === 'string' && record.playerName.trim().length > 0
    ? record.playerName.trim().slice(0, 200)
    : undefined;
  const roomTitle = typeof record.roomTitle === 'string' && record.roomTitle.trim().length > 0
    ? record.roomTitle.trim().slice(0, 200)
    : undefined;
  const lastSeqRaw = record.lastSeq;
  const lastSeq = typeof lastSeqRaw === 'number' && Number.isInteger(lastSeqRaw) && lastSeqRaw >= 0
    ? lastSeqRaw
    : undefined;
  return {
    ok: true,
    value: {
      base,
      roomId,
      token,
      ...(playerName !== undefined ? { playerName } : {}),
      ...(roomTitle !== undefined ? { roomTitle } : {}),
      ...(lastSeq !== undefined ? { lastSeq } : {}),
    },
  };
}

/** 解析一个 SSE 事件块（`event:` + `data:` 行）。 */
export function parseSseBlock(raw: string): { event: string; data: string } | undefined {
  const lines = raw.split('\n');
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    const index = line.indexOf(':');
    const field = index < 0 ? line.trim() : line.slice(0, index).trim();
    let value = index < 0 ? '' : line.slice(index + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

/** 从 HTTP 错误响应体里提取中文错误（兼容 JSON 信封）。 */
function errorBodyMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      const envelope = parsed as { error?: { message?: unknown }; message?: unknown };
      if (typeof envelope.error?.message === 'string') return envelope.error.message;
      if (typeof envelope.message === 'string') return envelope.message;
    }
  } catch {
    /* 非 JSON：保留原文 */
  }
  return trimmed.slice(0, 200);
}

interface SessionCacheEntry {
  session: MirrorSessionLike;
  sessionId?: string;
  /** 已写入的会话标题（避免重复 append；标题由房名推导）。 */
  title: string;
}

interface MirrorInstance {
  request: MirrorStartRequest;
  session?: MirrorSessionLike;
  sessionId?: string;
  state: MirrorStatus['state'];
  synced: number;
  lastSeq: number;
  error?: string;
  mapState: MirrorMapState;
  httpRequest?: ClientRequest;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  attempts: number;
  stopped: boolean;
  sseBuffer: string;
  /** 已写进会话的标题（避免重复 append）。 */
  appliedTitle?: string;
}

/** 玩家侧镜像服务（同一 DSH 实例/房间一次性建会话，重连复用）。 */
export class MirrorClientService {
  private readonly active = new Map<string, MirrorInstance>();
  private readonly sessionsByRoom = new Map<string, SessionCacheEntry>();
  private readonly getSessions: () => MirrorSessionsLike | undefined;
  private readonly createSessionFactory: MirrorSessionFactory | undefined;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly createId: (prefix: string) => string;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  /** 最近一次启动的房间（无 roomId 的 status/stop 指向它）。 */
  private lastRoomId: string | undefined;
  /** 每房间已消费到的镜像 seq（stop 后重启/重新入房时续传用）。 */
  private readonly resumeSeq = new Map<string, number>();
  /** 每房间的轮次映射状态（重启复用会话时接着上次的 turn 编号，避免重号）。 */
  private readonly mapStates = new Map<string, MirrorMapState>();

  constructor(options: MirrorClientOptions) {
    this.getSessions = options.getSessions ?? (() => undefined);
    this.createSessionFactory = options.createSession;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? ((prefix) => `${prefix}-${randomUUID()}`);
    this.reconnectDelayMs = Math.max(10, options.reconnectDelayMs ?? 1500);
    this.maxReconnectAttempts = Math.max(1, options.maxReconnectAttempts ?? 8);
  }

  /**
   * 启动/续连某房间的镜像（同一房间重复调用幂等）。
   * @param input - base / roomId / token 等启动参数。
   * @returns 当前状态（失败也返回 error/unavailable 状态，不抛异常）。
   */
  async start(input: unknown): Promise<MirrorStatus> {
    const parsed = validateMirrorStart(input);
    if (!parsed.ok) {
      const failed: MirrorStatus = {
        state: 'error',
        synced: 0,
        lastSeq: 0,
        error: parsed.error,
      };
      return failed;
    }
    const request = parsed.value;
    const existing = this.active.get(request.roomId);
    if (existing !== undefined && !existing.stopped) {
      // 已有活动连接：幂等返回（客户端轮询/重复触发不应重连），但补齐/更新标题。
      if (request.roomTitle !== undefined && existing.request.roomTitle !== request.roomTitle) {
        existing.request.roomTitle = request.roomTitle;
        try {
          this.applyTitle(existing, buildMirrorTitle(request.roomTitle));
        } catch {
          /* 标题失败不影响连接 */
        }
      }
      return this.statusOf(existing);
    }
    const existingState = this.mapStates.get(request.roomId);
    const mapState = existingState ?? createMirrorMapState();
    this.mapStates.set(request.roomId, mapState);
    const instance: MirrorInstance = {
      request,
      state: 'connecting',
      synced: 0,
      lastSeq: Math.max(request.lastSeq ?? 0, this.resumeSeq.get(request.roomId) ?? 0),
      mapState,
      attempts: 0,
      stopped: false,
      sseBuffer: '',
    };
    this.active.set(request.roomId, instance);
    this.lastRoomId = request.roomId;
    const ready = await this.ensureSession(instance);
    if (!ready) return this.statusOf(instance);
    this.connect(instance);
    return this.statusOf(instance);
  }

  /** 停止镜像（关闭 SSE、取消重连；已写入的镜像会话保留）。 */
  stop(roomId?: string): MirrorStatus {
    const target = roomId !== undefined ? this.active.get(roomId) : undefined;
    if (target !== undefined) {
      this.stopInstance(target);
      return this.statusOf(target);
    }
    if (roomId === undefined) {
      for (const instance of [...this.active.values()]) this.stopInstance(instance);
      return this.status();
    }
    const cached = this.sessionsByRoom.get(roomId);
    return {
      state: 'stopped',
      roomId,
      ...(cached?.sessionId !== undefined ? { sessionId: cached.sessionId } : {}),
      synced: 0,
      lastSeq: 0,
    };
  }

  /** 查询镜像状态（缺省取最近一次启动的房间）。 */
  status(roomId?: string): MirrorStatus {
    const target = roomId !== undefined ? this.active.get(roomId) : undefined;
    if (target !== undefined) return this.statusOf(target);
    if (roomId === undefined && this.lastRoomId !== undefined) {
      const last = this.active.get(this.lastRoomId);
      if (last !== undefined) return this.statusOf(last);
    }
    const cached = roomId !== undefined ? this.sessionsByRoom.get(roomId) : undefined;
    return {
      state: 'idle',
      ...(roomId !== undefined ? { roomId } : {}),
      ...(cached?.sessionId !== undefined ? { sessionId: cached.sessionId } : {}),
      ...(cached !== undefined ? { roomTitle: cached.title } : {}),
      synced: 0,
      lastSeq: 0,
    };
  }

  /** 插件卸载：断开全部镜像连接（会话保留在本地，可手动打开）。 */
  dispose(): void {
    for (const instance of [...this.active.values()]) this.stopInstance(instance);
    this.active.clear();
  }

  // -------------------------------------------------------------------------
  // 本地镜像会话
  // -------------------------------------------------------------------------

  /** 一次性确保本地镜像会话存在（同房间复用；标题钉住）。返回 false = 已降级。 */
  private async ensureSession(instance: MirrorInstance): Promise<boolean> {
    const roomId = instance.request.roomId;
    const cached = this.sessionsByRoom.get(roomId);
    if (cached !== undefined) {
      instance.session = cached.session;
      if (cached.sessionId !== undefined) instance.sessionId = cached.sessionId;
      this.applyTitle(instance, instance.request.roomTitle !== undefined ? buildMirrorTitle(instance.request.roomTitle) : cached.title);
      return true;
    }
    const title = buildMirrorTitle(instance.request.roomTitle);
    try {
      const handle = await this.createHandle();
      const entry: SessionCacheEntry = {
        session: handle.session,
        title,
        ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
      };
      this.sessionsByRoom.set(roomId, entry);
      instance.session = handle.session;
      if (handle.sessionId !== undefined) instance.sessionId = handle.sessionId;
      this.appendEvents(instance, [mirrorTitleEvent(instance.request.roomTitle)]);
      instance.appliedTitle = title;
      this.log(`mirror session created: room=${roomId} session=${handle.sessionId ?? '?'}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('没有可用的会话服务')) {
        instance.state = 'unavailable';
        instance.error = `${message}；请改用右栏实时记录（P0 兜底）。`;
        this.log(`mirror unavailable: ${message}`);
      } else {
        instance.state = 'error';
        instance.error = `创建镜像会话失败：${message}（右栏实时记录仍可用）`;
        this.log(`mirror session create failed: ${instance.error}`);
      }
      return false;
    }
  }

  /**
   * 创建/取回本地镜像会话：
   * 1. host 注入的工厂优先（`sessionController.create()` + `sessions.get()`：与 UI 新建会话同路，
   *    会话会持久化且能被 DSH 原生界面打开）；
   * 2. 回退 `ctx.sessions.create()`（裸会话：不持久化、原生界面打开会报 session/not-found，仅兜底）。
   */
  private async createHandle(): Promise<MirrorSessionHandle> {
    if (this.createSessionFactory !== undefined) {
      return await this.createSessionFactory();
    }
    const sessions = this.getSessions();
    if (sessions === undefined || typeof sessions.create !== 'function') {
      throw new Error('当前 DSH 宿主没有可用的会话服务（ctx.sessions / sessionController）');
    }
    const session = sessions.create();
    const sessionId = (session as { id?: unknown }).id;
    return {
      session,
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
    };
  }

  /** 房名变了就再钉一次标题（不触发自动命名 LLM）。 */
  private applyTitle(instance: MirrorInstance, title: string): void {
    if (instance.appliedTitle === title) return;
    this.appendEvents(instance, [mirrorTitleEvent(instance.request.roomTitle)]);
    instance.appliedTitle = title;
  }

  /** 把映射后的事件批量写进本地会话（surface 事件补 `{surfaceOp:'append'}`）。 */
  private appendEvents(instance: MirrorInstance, events: MirrorSessionEventInput[]): void {
    if (events.length === 0) return;
    const session = instance.session;
    if (session === undefined) return;
    const inputs = events.map((event) => event.surfaceOp === undefined
      ? [event.type, event.data]
      : [event.type, event.data, { surfaceOp: event.surfaceOp }]);
    (session as { append(inputs: unknown): unknown }).append(inputs);
  }

  // -------------------------------------------------------------------------
  // SSE 连接
  // -------------------------------------------------------------------------

  private connect(instance: MirrorInstance): void {
    if (instance.stopped) return;
    instance.state = instance.attempts === 0 ? 'connecting' : 'reconnecting';
    let url: URL;
    try {
      url = new URL(`${instance.request.base}/trpg/mirror`);
    } catch {
      instance.state = 'error';
      instance.error = '镜像地址非法';
      return;
    }
    url.searchParams.set('token', instance.request.token);
    url.searchParams.set('roomId', instance.request.roomId);
    url.searchParams.set('lastSeq', String(instance.lastSeq));
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let request: ClientRequest;
    try {
      request = requester(url, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'cache-control': 'no-store',
          'user-agent': 'dsh-trpg-table-mirror/0.0.1',
        },
      }, (response) => this.onResponse(instance, response));
    } catch (error) {
      this.onDisconnect(instance, error instanceof Error ? error.message : String(error));
      return;
    }
    instance.httpRequest = request;
    request.on('error', (error: Error) => this.onDisconnect(instance, error.message));
    request.end();
  }

  private onResponse(instance: MirrorInstance, response: IncomingMessage): void {
    const statusCode = response.statusCode ?? 0;
    if (statusCode !== 200) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      response.on('end', () => {
        const detail = errorBodyMessage(body);
        const reason = statusCode === 401
          ? '镜像鉴权失败：房间令牌无效或已失效，请退出后重新加入房间'
          : statusCode === 403
            ? `镜像被拒绝${detail.length > 0 ? `：${detail}` : ''}`
            : statusCode === 404
              ? '镜像不可用：房间不存在或已关闭'
              : `镜像连接失败（HTTP ${statusCode}）${detail.length > 0 ? `：${detail}` : ''}`;
        if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
          instance.state = 'error';
          instance.error = reason;
          this.log(`mirror sse rejected: ${statusCode} ${detail}`);
          return;
        }
        this.onDisconnect(instance, reason);
      });
      return;
    }
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => this.onSseData(instance, chunk));
    response.on('end', () => this.onDisconnect(instance, '镜像连接已关闭'));
    response.on('error', (error: Error) => this.onDisconnect(instance, error.message));
  }

  private onSseData(instance: MirrorInstance, chunk: string): void {
    instance.sseBuffer += chunk;
    for (;;) {
      const normalized = instance.sseBuffer.replace(/\r\n/g, '\n');
      const index = normalized.indexOf('\n\n');
      if (index < 0) {
        instance.sseBuffer = normalized;
        return;
      }
      const block = normalized.slice(0, index);
      instance.sseBuffer = normalized.slice(index + 2);
      this.onSseBlock(instance, block);
    }
  }

  private onSseBlock(instance: MirrorInstance, block: string): void {
    const parsed = parseSseBlock(block);
    if (parsed === undefined) return;
    if (parsed.event === 'ready') {
      this.onReady(instance, parsed.data);
      return;
    }
    if (parsed.event === 'mirror') {
      this.onMirrorFrame(instance, parsed.data);
      return;
    }
    if (parsed.event === 'close') {
      let reason = '镜像已关闭';
      try {
        const close = JSON.parse(parsed.data) as MirrorCloseFrame;
        if (typeof close.reason === 'string' && close.reason.length > 0) reason = close.reason;
      } catch {
        /* 坏帧用缺省原因 */
      }
      this.stopInstance(instance);
      instance.state = 'stopped';
      instance.error = reason;
      return;
    }
  }

  private onReady(instance: MirrorInstance, raw: string): void {
    let ready: MirrorReadyFrame;
    try {
      ready = JSON.parse(raw) as MirrorReadyFrame;
    } catch {
      return;
    }
    if (ready.type !== 'ready') return;
    if (instance.lastSeq === 0 && typeof ready.skipped === 'number' && ready.skipped > 0) {
      try {
        this.appendEvents(instance, [mirrorGapNoticeEvent(ready.skipped, { createId: this.createId })]);
      } catch (error) {
        this.log(`mirror gap notice failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (instance.request.roomTitle === undefined && typeof ready.roomTitle === 'string' && ready.roomTitle.length > 0) {
      instance.request.roomTitle = ready.roomTitle;
      this.applyTitle(instance, buildMirrorTitle(ready.roomTitle));
    }
    instance.state = 'live';
    instance.attempts = 0;
    delete instance.error;
    this.log(`mirror live: room=${instance.request.roomId} lastSeq=${instance.lastSeq}`);
  }

  private onMirrorFrame(instance: MirrorInstance, raw: string): void {
    let frame: MirrorFrame;
    try {
      frame = JSON.parse(raw) as MirrorFrame;
    } catch {
      return;
    }
    if (frame.v !== MIRROR_PROTOCOL_VERSION || typeof frame.seq !== 'number') return;
    // 去重/排序：只接受比已消费 seq 更大的帧（重连重放会重复发）。
    if (frame.seq <= instance.lastSeq) return;
    try {
      const events = mapMirrorFrame(frame, instance.mapState, { createId: this.createId });
      this.appendEvents(instance, events);
      instance.lastSeq = frame.seq;
      instance.synced += 1;
      this.resumeSeq.set(instance.request.roomId, frame.seq);
    } catch (error) {
      instance.state = 'error';
      instance.error = `写入镜像会话失败：${error instanceof Error ? error.message : String(error)}`;
      this.log(`mirror append failed: ${instance.error}`);
    }
  }

  private onDisconnect(instance: MirrorInstance, reason: string): void {
    if (instance.stopped) return;
    instance.httpRequest = undefined;
    this.scheduleReconnect(instance, reason);
  }

  private scheduleReconnect(instance: MirrorInstance, reason: string): void {
    if (instance.stopped) return;
    instance.attempts += 1;
    if (instance.attempts > this.maxReconnectAttempts) {
      instance.state = 'error';
      instance.error = `镜像连接中断：${reason}（已重试 ${this.maxReconnectAttempts} 次；可用右栏实时记录兜底）`;
      this.log(`mirror reconnect exhausted: ${reason}`);
      return;
    }
    const delay = this.reconnectDelayMs * instance.attempts;
    instance.state = 'reconnecting';
    instance.error = `连接中断，${delay}ms 后重连：${reason}`;
    instance.reconnectTimer = setTimeout(() => {
      instance.reconnectTimer = undefined;
      this.connect(instance);
    }, delay);
    if (typeof instance.reconnectTimer.unref === 'function') instance.reconnectTimer.unref();
  }

  private stopInstance(instance: MirrorInstance): void {
    instance.stopped = true;
    instance.state = 'stopped';
    if (instance.reconnectTimer !== undefined) {
      clearTimeout(instance.reconnectTimer);
      instance.reconnectTimer = undefined;
    }
    // 收尾：关闭仍打开的 turn，避免下次续连时轮次内容悬空。
    try {
      this.appendEvents(instance, closeMirrorTurn(instance.mapState));
    } catch (error) {
      this.log(`mirror close turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const request = instance.httpRequest;
    instance.httpRequest = undefined;
    try {
      request?.destroy();
    } catch {
      /* ignore */
    }
  }

  private statusOf(instance: MirrorInstance): MirrorStatus {
    return {
      state: instance.state,
      roomId: instance.request.roomId,
      ...(instance.request.roomTitle !== undefined ? { roomTitle: instance.request.roomTitle } : {}),
      ...(instance.sessionId !== undefined ? { sessionId: instance.sessionId } : {}),
      synced: instance.synced,
      lastSeq: instance.lastSeq,
      ...(instance.error !== undefined ? { error: instance.error } : {}),
    };
  }
}
