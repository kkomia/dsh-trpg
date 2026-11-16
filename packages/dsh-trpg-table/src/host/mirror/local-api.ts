/**
 * 玩家侧镜像控制接口（M7）：挂在**本机** DSH Web 服务器的 `/api/dsh-trpg-table/mirror` 前缀路由上。
 *
 * 客户端（右栏跑团桌卡片）通过同源 fetch 调用：
 * - `GET  /api/dsh-trpg-table/mirror/status?roomId=…` 查询镜像状态；
 * - `POST /api/dsh-trpg-table/mirror/start` 入房后启动镜像（base/roomId/token/roomTitle）；
 * - `POST /api/dsh-trpg-table/mirror/stop` 退房/关房时停止。
 *
 * 安全：只接受**本机**（loopback）请求；带 Origin/Sec-Fetch-Site 时要求同源。镜像只在
 * 玩家自己的机器上创建本地会话，不接受远端调用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MirrorClientService, MirrorStartValidation } from './client.ts';
import { validateMirrorStart } from './client.ts';

/** 镜像控制接口路径前缀（webServer 具名路由）。 */
export const MIRROR_API_PREFIX = '/api/dsh-trpg-table/mirror';

/** 请求体上限（启动参数很小）。 */
const BODY_LIMIT_BYTES = 64 * 1024;

/** DSH WebServer 的最小结构面（`ctx.webServer`）。 */
export interface MirrorWebServerLike {
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/** 控制接口依赖。 */
export interface MirrorRouteOptions {
  mirror: MirrorClientService;
  log?: (message: string) => void;
  /** loopback 判定注入点（单测模拟「非本机请求」用；缺省按 socket.remoteAddress）。 */
  isLoopbackRequest?: (request: IncomingMessage) => boolean;
}

function defaultIsLoopback(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress ?? '';
  // 空地址 = 进程内/Electron IPC 桥接调用，同样视为本机。
  return address === ''
    || address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

/** 本机 + 同源校验；返回拒绝原因（undefined = 放行）。 */
export function requestRejection(request: IncomingMessage, isLoopback: (request: IncomingMessage) => boolean): string | undefined {
  if (!isLoopback(request)) return '镜像控制接口只允许本机请求（不会把本地会话创建能力暴露到网络）';
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return '请求来源 Origin 非法，已拒绝';
    }
    if (originHost !== request.headers.host) return '跨站请求被拒绝（Origin 与 Host 不一致）';
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return '跨站请求被拒绝（Sec-Fetch-Site: cross-site）';
  return undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > BODY_LIMIT_BYTES) return { ok: false, error: '请求体过大（上限 64 KiB）' };
    chunks.push(buffer);
  }
  if (size === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' };
  }
}

/** 创建控制接口的请求处理器（测试可直接用 node:http server 挂载）。 */
export function createMirrorRouteHandler(options: MirrorRouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const log = options.log ?? (() => {});
  const isLoopback = options.isLoopbackRequest ?? defaultIsLoopback;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const suffix = url.pathname.slice(MIRROR_API_PREFIX.length);
    const rejection = requestRejection(request, isLoopback);
    if (rejection !== undefined) {
      sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: rejection } });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': request.headers.origin ?? '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && suffix === '/status') {
      const roomId = url.searchParams.get('roomId') ?? undefined;
      sendJson(response, 200, { ok: true, status: options.mirror.status(roomId) });
      return;
    }
    if (request.method === 'POST' && suffix === '/start') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { ok: false, error: { code: 'bad-request', message: body.error } });
        return;
      }
      const parsed: MirrorStartValidation = validateMirrorStart(body.value);
      if (!parsed.ok) {
        sendJson(response, 400, { ok: false, error: { code: 'bad-request', message: parsed.error } });
        return;
      }
      const status = await options.mirror.start(parsed.value);
      log(`mirror start: room=${parsed.value.roomId} state=${status.state}`);
      sendJson(response, 200, { ok: true, status });
      return;
    }
    if (request.method === 'POST' && suffix === '/stop') {
      const body = await readJsonBody(request);
      if (!body.ok) {
        sendJson(response, 400, { ok: false, error: { code: 'bad-request', message: body.error } });
        return;
      }
      const roomId = body.value !== null && typeof body.value === 'object'
        ? (body.value as { roomId?: unknown }).roomId
        : undefined;
      const status = options.mirror.stop(typeof roomId === 'string' && roomId.length > 0 ? roomId : undefined);
      sendJson(response, 200, { ok: true, status });
      return;
    }
    sendJson(response, 404, {
      ok: false,
      error: { code: 'not-found', message: `未知镜像接口：${request.method ?? 'GET'} ${url.pathname}` },
    });
  };
}

/**
 * 把控制接口注册到本机 DSH WebServer（`ctx.webServer.register`，prefix 路由）。
 * @param webServer - `ctx.webServer` 服务。
 * @param options - 镜像服务与日志。
 * @returns 注销函数（插件卸载时调用）。
 */
export function registerMirrorRoutes(webServer: MirrorWebServerLike, options: MirrorRouteOptions): () => void {
  const handler = createMirrorRouteHandler(options);
  return webServer.register({
    kind: 'prefix',
    path: MIRROR_API_PREFIX,
    handler,
  });
}
