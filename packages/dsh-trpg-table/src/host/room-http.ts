/**
 * 房间服务的 HTTP/SSE 适配层（薄壳）：把 RoomService 映射成局域网可访问的接口。
 *
 * 端点：
 * - GET  /trpg/health               健康检查
 * - GET  /trpg/rooms                公开房间列表
 * - POST /trpg/rpc                  JSON-RPC 风格调用（token 认证）
 * - GET  /trpg/events?token&lastSeq SSE 事件流（断线重连补发）
 *
 * 安全：room.create / host.session 只接受 loopback 请求（房主就坐在本机）；
 * 其余操作靠 token → principal 解析，客户端不能自称身份。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RoomError, RoomService, type Principal } from '@dsh-trpg/rooms';
import {
  encodeSseEvent,
  PROTOCOL_VERSION,
  validateBindSession,
  validateGmAward,
  validateGmNarrate,
  validateGmScene,
  validateGmSecret,
  validateRpcRequest,
  type CatalogPack,
  type RpcResponse,
  type RpcRequest,
} from '@dsh-trpg/protocol';

export interface RoomHttpOptions {
  port: number;
  bindHost: string;
  log?: (message: string) => void;
  service?: RoomService;
  /** 把房间绑定到 DSH 会话（房主本机；host/index 注入实现）。 */
  bindSession?: (roomId: string, sessionId: string | null) => unknown | Promise<unknown>;
  /** 内容包脱敏目录（`content.list`，玩家可调、只读）。 */
  contentCatalog?: () => CatalogPack[];
  /** 重扫内容包（`content.reload`，仅 loopback + host token）。 */
  contentReload?: () => { packs: number; warnings: string[]; recoveredRooms?: number };
}

export interface RoomHttpServer {
  server: Server;
  service: RoomService;
  close: () => Promise<void>;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage, limitBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createRoomHttpServer(options: RoomHttpOptions): RoomHttpServer {
  const log = options.log ?? (() => {});
  const service = options.service ?? new RoomService();
  const startedAt = Date.now();

  const dispatch = async (request: IncomingMessage, rpc: RpcRequest): Promise<unknown> => {
    // 内容包目录：玩家可读的脱敏清单，不需要房间 token（建房前/大厅就要用）。
    if (rpc.method === 'content.list') {
      if (!options.contentCatalog) throw new RoomError('internal', '内容包注册表未就绪');
      return { packs: options.contentCatalog() };
    }
    if (rpc.method === 'content.reload') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以重扫内容包');
      if (!options.contentReload) throw new RoomError('internal', '内容包注册表未就绪');
      // loopback + host token：内容重扫会影响所有房间，只许房主触发。
      const hostPrincipal = service.login(rpc.token);
      if (hostPrincipal.kind !== 'host') throw new RoomError('forbidden', '只有房主可以重扫内容包');
      return options.contentReload();
    }
    if (rpc.method === 'room.create') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以创建房间');
      return service.createRoom(rpc.params);
    }
    if (rpc.method === 'room.join') {
      return service.join(rpc.params);
    }
    if (rpc.method === 'host.session') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以取回房间令牌');
      const roomId = (rpc.params as { roomId?: unknown } | undefined)?.roomId;
      if (typeof roomId !== 'string') throw new RoomError('bad-request', '缺少 roomId');
      const session = service.hostSession(roomId);
      return { ...session, roomId };
    }
    if (rpc.method === 'room.list') {
      return service.list();
    }
    if (rpc.method === 'room.closeAll') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以清空房间');
      return service.closeAll();
    }

    const principal: Principal = service.login(rpc.token);
    const take = <T>(report: { ok: boolean; value?: T; error?: string }): T => {
      if (!report.ok || report.value === undefined) throw new RoomError('bad-request', report.error ?? '参数非法');
      return report.value;
    };
    const requireHost = (): void => {
      if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能执行该操作');
    };
    switch (rpc.method) {
      case 'room.state':
        return service.state(principal);
      case 'room.seat':
        return service.seat(principal, rpc.params);
      case 'room.roll':
        return service.roll(principal, rpc.params);
      case 'room.say':
        return service.say(principal, rpc.params);
      case 'room.leave':
        return service.leave(principal);
      case 'room.kick':
        return service.kick(principal, rpc.params);
      case 'room.lock':
        return service.lock(principal, rpc.params);
      case 'room.bind': {
        requireHost();
        const params = take(validateBindSession(rpc.params));
        const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
        if (options.bindSession) return await options.bindSession(principal.roomId, sessionId);
        return { room: service.bindSession(principal.roomId, sessionId) };
      }
      case 'room.close': {
        requireHost();
        return service.closeRoom(principal.roomId);
      }
      case 'gm.narrate': {
        requireHost();
        const params = take(validateGmNarrate(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能发 GM 旁白');
        return { event: service.gmNarrate(principal.roomId, params.text) };
      }
      case 'gm.secret': {
        requireHost();
        const params = take(validateGmSecret(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能发私密信息');
        return { event: service.gmSecret(principal.roomId, params.playerId, params.text) };
      }
      case 'gm.scene': {
        requireHost();
        const params = take(validateGmScene(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能推进场景');
        return { event: service.gmScene(principal.roomId, params.sceneId, params.title) };
      }
      case 'gm.award': {
        requireHost();
        const params = take(validateGmAward(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能发奖励');
        return { event: service.gmAward(principal.roomId, params.playerId, { xp: params.xp, items: params.items, note: params.note }) };
      }
      // ---- M9.4 规则投影与命令（host 结算；读命令全桌可调，写命令由 rooms 校验行动者/权限） ----
      // 运行时事件 → SSE 的映射不在这一层：RuleRuntime 由 rooms 持有，运行时事件（turn/damage/
      // rules/error 等）在 rooms 的订阅里广播成 `combat/update` / `sheet/update` / `rules/error`，
      // 这里只把命令结果（投影 DTO + 中文错误）回包，保持 HTTP 适配层是薄壳。
      case 'sheet.get':
        return service.sheet(principal, rpc.params);
      case 'sheet.equip':
        return service.equip(principal, rpc.params);
      case 'sheet.unequip':
        return service.unequip(principal, rpc.params);
      case 'sheet.useItem':
        return service.useItem(principal, rpc.params);
      case 'combat.view':
        return service.combatView(principal);
      case 'combat.start':
        return service.startCombat(principal, rpc.params);
      case 'combat.useAction':
        return service.useAction(principal, rpc.params);
      case 'combat.move':
        return service.move(principal, rpc.params);
      case 'combat.endTurn':
        return service.endTurn(principal, rpc.params);
      case 'combat.rollCheck':
        return service.rollCheck(principal, rpc.params);
      case 'combat.end':
        return service.endCombat(principal, rpc.params);
      case 'worldmap.get':
        return service.worldMap(principal);
      default:
        throw new RoomError('bad-request', `未知方法：${rpc.method}`);
    }
  };

  async function handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : '请求体不是合法 JSON' },
      } satisfies RpcResponse);
      return;
    }
    const parsed = validateRpcRequest(body);
    if (!parsed.ok || !parsed.value) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'bad-request', message: parsed.error ?? 'RPC 请求非法' },
      } satisfies RpcResponse);
      return;
    }
    try {
      const result = await dispatch(request, parsed.value);
      sendJson(response, 200, { ok: true, result } satisfies RpcResponse);
    } catch (error) {
      if (error instanceof RoomError) {
        sendJson(response, 200, { ok: false, error: { code: error.code, message: error.message } } satisfies RpcResponse);
        return;
      }
      log(`rpc ${parsed.value.method} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(response, 500, {
        ok: false,
        error: { code: 'internal', message: '服务端内部错误' },
      } satisfies RpcResponse);
    }
  }

  function handleSse(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const token = url.searchParams.get('token') ?? undefined;
    let principal: Principal;
    try {
      principal = service.login(token);
    } catch {
      sendJson(response, 401, { ok: false, error: { code: 'unauthorized', message: '令牌无效' } });
      return;
    }
    const lastSeq = Number.parseInt(url.searchParams.get('lastSeq') ?? '0', 10);
    response.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 2000\n\n');

    const writeEvent = (event: Parameters<typeof encodeSseEvent>[0]): void => {
      try {
        response.write(encodeSseEvent(event));
        if ((event.payload as { close?: boolean } | null)?.close === true) response.end();
      } catch {
        /* 客户端已断开 */
      }
    };

    for (const event of service.eventsSince(principal, Number.isFinite(lastSeq) ? lastSeq : 0)) writeEvent(event);
    const unsubscribe = service.subscribe(principal, writeEvent);
    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    request.on('error', cleanup);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/trpg/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'dsh-trpg-table',
        protocol: PROTOCOL_VERSION,
        rooms: service.list().rooms.length,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/trpg/rooms') {
      sendJson(response, 200, service.list());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/trpg/events') {
      handleSse(request, response, url);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/trpg/rpc') {
      void handleRpc(request, response);
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: 'not-found', message: 'not found' } });
  });

  return {
    server,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 已建立的 SSE 连接会阻止 close 回调；主动断开。
        server.closeAllConnections?.();
      }),
  };
}
