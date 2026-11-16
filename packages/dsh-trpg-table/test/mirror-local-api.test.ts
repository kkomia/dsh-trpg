import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MirrorClientService, type MirrorSessionsLike } from '../src/host/mirror/client.ts';
import {
  createMirrorRouteHandler,
  MIRROR_API_PREFIX,
  registerMirrorRoutes,
  requestRejection,
  type MirrorWebServerLike,
} from '../src/host/mirror/local-api.ts';

class FakeSession {
  readonly id = 'session-local-1';
  readonly appended: unknown[] = [];
  append(inputs: unknown): unknown {
    this.appended.push(inputs);
    return [];
  }
}

function createMirror(overrides: { sessions?: MirrorSessionsLike } = {}): MirrorClientService {
  return new MirrorClientService({
    getSessions: () => overrides.sessions ?? { create: () => new FakeSession() },
    reconnectDelayMs: 20,
    maxReconnectAttempts: 1,
  });
}

async function startApi(mirror: MirrorClientService, options: { isLoopbackRequest?: (request: IncomingMessage) => boolean } = {}): Promise<{ base: string; server: Server; close: () => Promise<void> }> {
  const handler = createMirrorRouteHandler({ mirror, ...(options.isLoopbackRequest !== undefined ? { isLoopbackRequest: options.isLoopbackRequest } : {}) });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('镜像控制接口：状态查询返回结构化 status', async () => {
  const mirror = createMirror();
  const api = await startApi(mirror);
  try {
    const response = await fetch(`${api.base}${MIRROR_API_PREFIX}/status?roomId=room-1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; status: { state: string } };
    assert.equal(body.ok, true);
    assert.equal(body.status.state, 'idle');
  } finally {
    mirror.dispose();
    await api.close();
  }
});

test('镜像控制接口：start 校验参数（缺 base/roomId/token → 400 中文）', async () => {
  const mirror = createMirror();
  const api = await startApi(mirror);
  try {
    const response = await fetch(`${api.base}${MIRROR_API_PREFIX}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', token: 'tok-1234' }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { ok: boolean; error: { message: string } };
    assert.equal(body.ok, false);
    assert.match(body.error.message, /base/);

    const badJson = await fetch(`${api.base}${MIRROR_API_PREFIX}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    const body2 = await badJson.json() as { error: { message: string } };
    assert.match(body2.error.message, /JSON/);
  } finally {
    mirror.dispose();
    await api.close();
  }
});

test('镜像控制接口：start 成功启动后 status 进入 connecting，stop 收场', async () => {
  const sessions = { created: 0, create: () => {
    sessions.created += 1;
    return new FakeSession();
  } };
  const mirror = createMirror({ sessions });
  const api = await startApi(mirror);
  try {
    const start = await fetch(`${api.base}${MIRROR_API_PREFIX}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 'http://127.0.0.1:1', roomId: 'room-1', token: 'tok-1234', roomTitle: '鬼木崖·异光' }),
    });
    assert.equal(start.status, 200);
    const body = await start.json() as { ok: boolean; status: { state: string; sessionId?: string } };
    assert.equal(body.ok, true);
    assert.equal(body.status.state, 'connecting');
    assert.equal(body.status.sessionId, 'session-local-1');
    assert.equal(sessions.created, 1);

    const stop = await fetch(`${api.base}${MIRROR_API_PREFIX}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1' }),
    });
    const stopBody = await stop.json() as { status: { state: string } };
    assert.equal(stopBody.status.state, 'stopped');
  } finally {
    mirror.dispose();
    await api.close();
  }
});

test('镜像控制接口：未知子路径 → 404 中文', async () => {
  const mirror = createMirror();
  const api = await startApi(mirror);
  try {
    const response = await fetch(`${api.base}${MIRROR_API_PREFIX}/nope`);
    assert.equal(response.status, 404);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /未知镜像接口/);
  } finally {
    mirror.dispose();
    await api.close();
  }
});

test('镜像控制接口：非本机请求被拒绝（403），跨站 Origin 被拒绝', async () => {
  const mirror = createMirror();
  const handler = createMirrorRouteHandler({ mirror, isLoopbackRequest: () => false });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${MIRROR_API_PREFIX}/status`);
    assert.equal(response.status, 403);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /只允许本机/);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  const mirror2 = createMirror();
  const api = await startApi(mirror2);
  try {
    const crossOrigin = await fetch(`${api.base}${MIRROR_API_PREFIX}/status`, {
      headers: { origin: 'https://evil.example', host: `127.0.0.1` },
    });
    assert.equal(crossOrigin.status, 403);
    const body = await crossOrigin.json() as { error: { message: string } };
    assert.match(body.error.message, /跨站|Origin/);
  } finally {
    mirror2.dispose();
    await api.close();
  }
});

test('requestRejection：IPv4/IPv6 loopback 与空地址视为本机，非 loopback 拒绝', () => {
  const make = (address: string | undefined): IncomingMessage => ({ socket: { remoteAddress: address }, headers: {} } as unknown as IncomingMessage);
  const loopback = (request: IncomingMessage): boolean => {
    const address = request.socket.remoteAddress ?? '';
    return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  };
  assert.equal(requestRejection(make('127.0.0.1'), loopback), undefined);
  assert.equal(requestRejection(make('::1'), loopback), undefined);
  assert.equal(requestRejection(make(''), loopback), undefined);
  assert.match(requestRejection(make('192.168.1.20'), loopback) ?? '', /只允许本机/);
  const crossSite = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'sec-fetch-site': 'cross-site' } } as unknown as IncomingMessage;
  assert.match(requestRejection(crossSite, loopback) ?? '', /跨站/);
});

test('registerMirrorRoutes：向 webServer 注册 prefix 路由并返回注销函数', () => {
  const routes: Array<{ kind: string; path: string; handler: unknown }> = [];
  const webServer: MirrorWebServerLike = {
    register: (route) => {
      routes.push({ kind: route.kind, path: route.path, handler: route.handler });
      return () => {
        routes.pop();
      };
    },
  };
  const mirror = createMirror();
  const off = registerMirrorRoutes(webServer, { mirror });
  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [['prefix', MIRROR_API_PREFIX]]);
  assert.equal(typeof routes[0]?.handler, 'function');
  off();
  assert.equal(routes.length, 0);
  mirror.dispose();
});
