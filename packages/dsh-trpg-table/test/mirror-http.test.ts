import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { RoomService } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from '../src/host/room-http.ts';
import { RoomMirrorHub } from '../src/host/mirror/hub.ts';
import type { MirrorFrame, MirrorReadyFrame } from '../src/host/mirror/types.ts';

interface SseEvent {
  event: string;
  data: unknown;
}

class SseSession {
  readonly events: SseEvent[] = [];
  ended = false;
  statusCode = 0;
  readonly request: ReturnType<typeof httpGet>;
  private readonly waiters = new Set<() => void>();

  constructor(request: ReturnType<typeof httpGet>) {
    this.request = request;
  }

  notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  async waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('SSE 等待超时');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        this.waiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  frames(): MirrorFrame[] {
    return this.events.filter((event) => event.event === 'mirror').map((event) => event.data as MirrorFrame);
  }

  ready(): MirrorReadyFrame | undefined {
    return this.events.find((event) => event.event === 'ready')?.data as MirrorReadyFrame | undefined;
  }

  close(): void {
    this.request.destroy();
  }
}

/** 打开镜像 SSE 并收集事件（测试用）。 */
function openSse(url: string): Promise<SseSession> {
  return new Promise((resolve, reject) => {
    const session = new SseSession(httpGet(url));
    let buffer = '';
    session.request.on('response', (response: IncomingMessage) => {
      session.statusCode = response.statusCode ?? 0;
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) break;
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
          }
          if (dataLines.length === 0) continue;
          try {
            session.events.push({ event, data: JSON.parse(dataLines.join('\n')) });
          } catch {
            /* 坏帧忽略 */
          }
          session.notify();
        }
      });
      response.on('end', () => {
        session.ended = true;
        session.notify();
      });
      response.on('error', () => {
        session.ended = true;
        session.notify();
      });
      resolve(session);
    });
    session.request.on('error', (error) => {
      if (session.statusCode === 0) reject(error);
    });
  });
}

interface MirrorServer {
  base: string;
  roomId: string;
  hostToken: string;
  aliceToken: string;
  bobToken: string;
  alicePlayerId: string;
  bobPlayerId: string;
  hub: RoomMirrorHub;
  service: RoomService;
  http: RoomHttpServer;
  close: () => Promise<void>;
}

async function startMirrorServer(options: { maxBuffer?: number; withMirror?: boolean } = {}): Promise<MirrorServer> {
  const hubRef: { current: RoomMirrorHub | null } = { current: null };
  const service = new RoomService({
    maxRooms: 4,
    onRoomClosed: (closedRoomId) => hubRef.current?.disposeRoom(closedRoomId),
  });
  const created = service.createRoom({ title: '鬼木崖·异光', gmMode: 'ai' });
  const roomId = created.room.roomId;
  const alice = service.join({ inviteCode: created.inviteCode, playerName: '阿青' });
  const bob = service.join({ inviteCode: created.inviteCode, playerName: '白露' });
  const hub = new RoomMirrorHub({
    playersOf: () => service.gmParty(roomId).map((player) => ({ playerId: player.playerId, playerName: player.name })),
    maxBuffer: options.maxBuffer,
  });
  hubRef.current = hub;
  service.subscribeAll((id, event) => hub.onRoomEvent(id, event));
  hub.registerRoom(roomId, '鬼木崖·异光');
  hub.bindSession(roomId, 'session-gm');
  const http = createRoomHttpServer({
    port: 0,
    bindHost: '127.0.0.1',
    service,
    ...(options.withMirror === false ? {} : { mirror: hub }),
  });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', () => resolve()));
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    roomId,
    hostToken: created.hostToken,
    aliceToken: alice.playerToken,
    bobToken: bob.playerToken,
    alicePlayerId: alice.playerId,
    bobPlayerId: bob.playerId,
    hub,
    service,
    http,
    close: async () => {
      await http.close();
    },
  };
}

test('镜像 SSE：无 token → 401 中文错误', async () => {
  const server = await startMirrorServer();
  try {
    const response = await fetch(`${server.base}/trpg/mirror?roomId=${server.roomId}`);
    assert.equal(response.status, 401);
    const body = await response.json() as { ok: boolean; error: { message: string } };
    assert.equal(body.ok, false);
    assert.match(body.error.message, /令牌/);
  } finally {
    await server.close();
  }
});

test('镜像 SSE：非法 token → 401，错误中文', async () => {
  const server = await startMirrorServer();
  try {
    const response = await fetch(`${server.base}/trpg/mirror?token=bogus-token&roomId=${server.roomId}`);
    assert.equal(response.status, 401);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /无效|失效/);
  } finally {
    await server.close();
  }
});

test('镜像 SSE：token 与 roomId 不匹配 → 400', async () => {
  const server = await startMirrorServer();
  try {
    const response = await fetch(`${server.base}/trpg/mirror?token=${server.aliceToken}&roomId=another-room`);
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /不匹配/);
  } finally {
    await server.close();
  }
});

test('镜像 SSE：房主端未接入镜像中枢 → 503 中文错误', async () => {
  const server = await startMirrorServer({ withMirror: false });
  try {
    const response = await fetch(`${server.base}/trpg/mirror?token=${server.aliceToken}`);
    assert.equal(response.status, 503);
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /未启用/);
  } finally {
    await server.close();
  }
});

test('镜像 SSE：ready 握手给出缓冲窗口，并按 lastSeq 重放之后的历史', async () => {
  const server = await startMirrorServer();
  try {
    server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '第一段' }] } });
    server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '第二段' }] } });
    const sse = await openSse(`${server.base}/trpg/mirror?token=${server.aliceToken}&roomId=${server.roomId}&lastSeq=1`);
    try {
      await sse.waitFor(() => sse.ready() !== undefined && sse.frames().length >= 1);
      const ready = sse.ready();
      assert.equal(ready?.type, 'ready');
      assert.equal(ready?.lastSeq, 1);
      assert.equal(ready?.oldestSeq, 1);
      assert.equal(ready?.latestSeq, 2);
      assert.equal(ready?.skipped, 0);
      assert.equal(ready?.roomTitle, '鬼木崖·异光');
      assert.deepEqual(sse.frames().map((frame) => frame.seq), [2]);
    } finally {
      sse.close();
    }
  } finally {
    await server.close();
  }
});

test('镜像 SSE：lastSeq 早于缓冲窗口时 ready.skipped 告知丢失条数', async () => {
  const server = await startMirrorServer({ maxBuffer: 2 });
  try {
    for (let index = 1; index <= 4; index += 1) {
      server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: `第 ${index} 段` }] } });
    }
    const sse = await openSse(`${server.base}/trpg/mirror?token=${server.hostToken}&lastSeq=1`);
    try {
      await sse.waitFor(() => sse.ready() !== undefined && sse.frames().length >= 2);
      const ready = sse.ready();
      assert.equal(ready?.oldestSeq, 3);
      assert.equal(ready?.skipped, 1);
      assert.deepEqual(sse.frames().map((frame) => frame.seq), [3, 4]);
    } finally {
      sse.close();
    }
  } finally {
    await server.close();
  }
});

test('镜像 SSE：非法 lastSeq 当作 0 处理（重放缓冲内全部可见帧）', async () => {
  const server = await startMirrorServer();
  try {
    server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '历史' }] } });
    const sse = await openSse(`${server.base}/trpg/mirror?token=${server.aliceToken}&lastSeq=not-a-number`);
    try {
      await sse.waitFor(() => sse.frames().length >= 1);
      assert.deepEqual(sse.frames().map((frame) => frame.seq), [1]);
    } finally {
      sse.close();
    }
  } finally {
    await server.close();
  }
});

test('镜像 SSE：实时推送 + 按收件人过滤（私密/秘密不发给其他玩家）', async () => {
  const server = await startMirrorServer();
  try {
    const aliceSse = await openSse(`${server.base}/trpg/mirror?token=${server.aliceToken}&roomId=${server.roomId}`);
    try {
      await aliceSse.waitFor(() => aliceSse.ready() !== undefined);
      server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '公开旁白' }] } });
      server.service.gmSecret(server.roomId, server.bobPlayerId, '给白露的秘密');
      server.hub.onSessionEvent('session-gm', 'tool/call', {
        callId: 'call-secret',
        name: 'trpg_secret_note',
        arguments: JSON.stringify({ playerName: '白露', text: '给白露的秘密' }),
        turn: 1,
        step: 1,
      });
      server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '第二段公开' }] } });
      await aliceSse.waitFor(() => aliceSse.frames().length >= 2);
      const frames = aliceSse.frames();
      assert.deepEqual(frames.map((frame) => frame.kind), ['narration', 'narration']);
      assert.deepEqual(frames.map((frame) => (frame.data as { text: string }).text), ['公开旁白', '第二段公开']);
      assert.equal(JSON.stringify(frames).includes('给白露的秘密'), false);

      const hostSse = await openSse(`${server.base}/trpg/mirror?token=${server.hostToken}&lastSeq=0`);
      try {
        await hostSse.waitFor(() => hostSse.frames().length >= 4);
        const hostFrames = hostSse.frames();
        assert.equal(hostFrames.length, 4);
        assert.equal(hostFrames.some((frame) => frame.kind === 'tool'), true);
        assert.equal(JSON.stringify(hostFrames).includes('给白露的秘密'), true);
      } finally {
        hostSse.close();
      }
    } finally {
      aliceSse.close();
    }
  } finally {
    await server.close();
  }
});

test('镜像 SSE：房主关闭房间 → close 事件并断开连接', async () => {
  const server = await startMirrorServer();
  try {
    const sse = await openSse(`${server.base}/trpg/mirror?token=${server.aliceToken}`);
    try {
      await sse.waitFor(() => sse.ready() !== undefined);
      server.service.closeRoom(server.roomId);
      await sse.waitFor(() => sse.events.some((event) => event.event === 'close'));
      const close = sse.events.find((event) => event.event === 'close')?.data as { type: string; reason: string };
      assert.equal(close.type, 'close');
      assert.match(close.reason, /关闭/);
      assert.equal(server.hub.hasRoom(server.roomId), false);
    } finally {
      sse.close();
    }
  } finally {
    await server.close();
  }
});

test('镜像 SSE：客户端断开后服务端清理订阅，后续事件继续进缓冲', async () => {
  const server = await startMirrorServer();
  try {
    const sse = await openSse(`${server.base}/trpg/mirror?token=${server.aliceToken}`);
    await sse.waitFor(() => sse.ready() !== undefined);
    sse.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '断开之后' }] } });
    assert.equal(server.hub.bufferedCount(server.roomId), 1);
    const replay = server.hub.eventsSince(server.service.login(server.aliceToken), 0);
    assert.equal(replay.length, 1);
  } finally {
    await server.close();
  }
});

test('镜像 SSE：省略 roomId 时按 token 所在房间处理', async () => {
  const server = await startMirrorServer();
  try {
    server.hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '无 roomId' }] } });
    const sse = await openSse(`${server.base}/trpg/mirror?token=${server.aliceToken}`);
    try {
      await sse.waitFor(() => sse.frames().length >= 1);
      assert.equal(sse.ready()?.roomId, server.roomId);
      assert.equal(sse.statusCode, 200);
    } finally {
      sse.close();
    }
  } finally {
    await server.close();
  }
});
