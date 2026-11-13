/**
 * 跑团桌 Host 半边（M0 骨架）。
 *
 * 职责边界（见 docs/DESIGN.md §3）：
 * - 房间服务：局域网内可访问的 HTTP 服务，独立于 DSH Web 端口，绑 0.0.0.0。
 * - M0 只提供房间生命周期与健康检查；协议/引擎/AI 编排在后续里程碑接入。
 *
 * 该文件会被 scripts/build.mjs 打包成 lib/host.js（ESM，node 内置模块外置）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@dsh-trpg/protocol';

export const name = 'dsh-trpg-table';

/** M0：房间的占位结构，后续由房间服务与引擎替换。 */
interface RoomSummary {
  roomId: string;
  title: string;
  phase: 'lobby';
  gmMode: 'ai' | 'human';
  createdAt: number;
  inviteCode: string;
}

const DEFAULT_PORT = 45871;
const DEFAULT_HOST = '0.0.0.0';

function readPort(): number {
  const raw = process.env.DSH_TRPG_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function log(message: string): void {
  // 不依赖 DSH logger 服务（M0 阶段插件可能在任意 composition 下激活）。
  console.log(`[dsh-trpg-table] ${message}`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export interface TrpgConfig {
  /** 监听端口；默认 45871。 */
  port?: number;
  /** 监听地址；默认 0.0.0.0（局域网可访问）。 */
  bindHost?: string;
}

export function apply(ctx: { effect: (fn: () => () => void) => void }, config: TrpgConfig = {}): void {
  const port = config.port ?? readPort();
  const bindHost = config.bindHost ?? DEFAULT_HOST;
  const rooms = new Map<string, RoomSummary>();

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
      }

      if (request.method === 'GET' && url.pathname === '/trpg/health') {
        sendJson(response, 200, {
          ok: true,
          service: name,
          protocol: PROTOCOL_VERSION,
          rooms: rooms.size,
          uptimeSeconds: Math.round(process.uptime()),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/trpg/rooms') {
        sendJson(response, 200, { rooms: [...rooms.values()] });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/trpg/rooms') {
        const body = (await readJsonBody(request)) as { title?: unknown; gmMode?: unknown };
        const room: RoomSummary = {
          roomId: randomUUID(),
          title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : '未命名团',
          phase: 'lobby',
          gmMode: body.gmMode === 'human' ? 'human' : 'ai',
          createdAt: Date.now(),
          inviteCode: inviteCode(),
        };
        rooms.set(room.roomId, room);
        sendJson(response, 201, { room });
        return;
      }

      sendJson(response, 404, { error: 'not-found' });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) sendJson(response, 400, { error: message });
      else response.end();
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    log(`room server failed on ${bindHost}:${port}: ${error.code ?? ''} ${error.message}`);
  });

  server.listen(port, bindHost, () => {
    log(`room server listening on http://${bindHost}:${port} (protocol v${PROTOCOL_VERSION})`);
  });

  ctx.effect(() => () => {
    log('room server stopping');
    server.close();
    rooms.clear();
  });
}
