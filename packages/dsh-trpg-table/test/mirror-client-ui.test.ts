import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMirrorApi,
  mirrorStartInput,
  mirrorStatusText,
  shouldAutoStartMirror,
  MIRROR_API_PATH,
  MIRROR_FALLBACK_HINT,
  type MirrorSessionView,
  type MirrorStatusView,
} from '../src/client/mirror.ts';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  handler: (call: FetchCall) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const result = await handler(call);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

test('镜像接口：start/status/stop 走同源路径、方法与 JSON 信封', async () => {
  const fake = fakeFetch((call) => {
    if (call.url.endsWith('/start')) {
      return { body: { ok: true, status: { state: 'connecting', roomId: 'room-1', sessionId: 'session-1', synced: 0, lastSeq: 0 } } };
    }
    if (call.url.includes('/status')) {
      return { body: { ok: true, status: { state: 'live', roomId: 'room-1', sessionId: 'session-1', synced: 7, lastSeq: 7 } } };
    }
    return { body: { ok: true, status: { state: 'stopped', roomId: 'room-1', synced: 7, lastSeq: 7 } } };
  });
  const api = createMirrorApi(fake.fetch);
  const started = await api.start({ base: 'http://127.0.0.1:45871', roomId: 'room-1', token: 'tok-1234', roomTitle: '鬼木崖·异光' });
  assert.equal(started.state, 'connecting');
  assert.equal(fake.calls[0]?.url, `${MIRROR_API_PATH}/start`);
  assert.equal(fake.calls[0]?.init.method, 'POST');
  assert.equal(JSON.parse(String(fake.calls[0]?.init.body)).roomTitle, '鬼木崖·异光');
  assert.equal((fake.calls[0]?.init.headers as Record<string, string>)['content-type'], 'application/json');

  const live = await api.status('room-1');
  assert.equal(live.state, 'live');
  assert.equal(live.synced, 7);
  assert.equal(fake.calls[1]?.url, `${MIRROR_API_PATH}/status?roomId=room-1`);

  const stopped = await api.stop('room-1');
  assert.equal(stopped.state, 'stopped');
  assert.equal(fake.calls[2]?.url, `${MIRROR_API_PATH}/stop`);
  assert.deepEqual(JSON.parse(String(fake.calls[2]?.init.body)), { roomId: 'room-1' });
});

test('镜像接口：HTTP 错误/中文错误信息映射为 unavailable', async () => {
  const fake = fakeFetch(() => ({ status: 400, body: { ok: false, error: { message: '缺少合法的 roomId' } } }));
  const api = createMirrorApi(fake.fetch);
  const status = await api.start({ base: 'http://127.0.0.1:1', roomId: 'room-1', token: 'tok-1234' });
  assert.equal(status.state, 'unavailable');
  assert.match(status.error ?? '', /缺少合法的 roomId/);

  const noMessage = fakeFetch(() => ({ status: 500, body: { ok: false } }));
  const status2 = await createMirrorApi(noMessage.fetch).status();
  assert.match(status2.error ?? '', /HTTP 500/);
});

test('镜像接口：fetch 抛错/宿主没有 fetch 时给可读降级文案', async () => {
  const throwing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const status = await createMirrorApi(throwing).status();
  assert.equal(status.state, 'unavailable');
  assert.match(status.error ?? '', /本机镜像接口不可用/);
  assert.match(status.error ?? '', /ECONNREFUSED/);

  const noFetch = await createMirrorApi(undefined as unknown as typeof fetch).status();
  // 显式传入 undefined 时仍会尝试全局 fetch（node 环境有 fetch），只验证不抛异常。
  assert.equal(typeof noFetch, 'object');
});

test('是否需要自动启动镜像：只有玩家身份且 base/roomId 齐全', () => {
  const player: MirrorSessionView = { base: 'http://127.0.0.1:45871', roomId: 'room-1', playerToken: 'tok-1234', playerName: '阿青' };
  assert.equal(shouldAutoStartMirror(player), true);
  assert.equal(shouldAutoStartMirror({ ...player, playerToken: undefined }), false);
  assert.equal(shouldAutoStartMirror({ ...player, roomId: undefined }), false);
  assert.equal(shouldAutoStartMirror({ ...player, base: undefined }), false);
  assert.equal(shouldAutoStartMirror(null), false);
  assert.equal(shouldAutoStartMirror(undefined), false);
});

test('启动参数组装：玩家带 name/title，房主返回 undefined', () => {
  const player: MirrorSessionView = { base: 'http://127.0.0.1:45871', roomId: 'room-1', playerToken: 'tok-1234', playerName: '阿青' };
  assert.deepEqual(mirrorStartInput(player, '鬼木崖·异光'), {
    base: 'http://127.0.0.1:45871',
    roomId: 'room-1',
    token: 'tok-1234',
    playerName: '阿青',
    roomTitle: '鬼木崖·异光',
  });
  assert.equal(mirrorStartInput({ base: 'http://x', roomId: 'room-1' }, '房名'), undefined);
  assert.equal(mirrorStartInput(player, undefined)?.roomTitle, undefined);
});

test('状态文案：房主/未加入/准备中/连接中/重连中', () => {
  assert.match(mirrorStatusText(undefined, { isHost: true }).text, /房主/);
  assert.equal(mirrorStatusText(undefined, { player: false }).kind, 'idle');
  assert.match(mirrorStatusText(undefined, { player: true }).text, /准备中/);
  const connecting = mirrorStatusText({ state: 'connecting' }, { player: true });
  assert.equal(connecting.kind, 'busy');
  assert.match(connecting.text, /连接房主中/);
  const reconnecting = mirrorStatusText({ state: 'reconnecting', error: '连接中断' }, { player: true });
  assert.equal(reconnecting.kind, 'busy');
  assert.match(reconnecting.text, /重连中/);
});

test('状态文案：已连接显示同步条数、停止/错误/不可用各有文案', () => {
  const live = mirrorStatusText({ state: 'live', synced: 12 }, { player: true });
  assert.equal(live.kind, 'ok');
  assert.match(live.text, /已同步 12 条/);
  const stopped = mirrorStatusText({ state: 'stopped', error: '房主关闭了房间' }, { player: true });
  assert.equal(stopped.kind, 'idle');
  assert.match(stopped.text, /已停止/);
  const error = mirrorStatusText({ state: 'error', error: '令牌无效' }, { player: true });
  assert.equal(error.kind, 'bad');
  assert.match(error.text, /镜像失败/);
  assert.match(error.text, /令牌无效/);
  const unavailable = mirrorStatusText({ state: 'unavailable', error: '缺少会话服务' }, { player: true });
  assert.equal(unavailable.kind, 'bad');
  assert.match(unavailable.text, /镜像不可用/);
  assert.match(MIRROR_FALLBACK_HINT, /P0/);
});

test('状态文案：未知/空闲状态不误报为错误', () => {
  assert.equal(mirrorStatusText({ state: 'idle' }, { player: true }).kind, 'idle');
  assert.match(mirrorStatusText({ state: 'idle' }, { player: true }).text, /未启动/);
  const unknown = mirrorStatusText({ state: 'weird' } as MirrorStatusView, { player: true });
  assert.equal(unknown.kind, 'idle');
  assert.match(unknown.text, /weird/);
});

test('镜像接口路径常量为宿主路由前缀（与 host 一致）', () => {
  assert.equal(MIRROR_API_PATH, '/api/dsh-trpg-table/mirror');
});
