import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MirrorClientService, parseSseBlock, validateMirrorStart, type MirrorSessionLike, type MirrorSessionsLike } from '../src/host/mirror/client.ts';
import type { MirrorFrame, MirrorReadyFrame } from '../src/host/mirror/types.ts';

interface AppendedEvent {
  type: string;
  data: Record<string, unknown>;
  opts?: { surfaceOp?: string };
}

class FakeSession implements MirrorSessionLike {
  readonly id: string;
  readonly appended: AppendedEvent[] = [];
  /** true = 除标题外的事件写入失败（模拟会话已进入不可写状态）。 */
  readonly failOnAppend: boolean;

  constructor(id: string, failOnAppend = false) {
    this.id = id;
    this.failOnAppend = failOnAppend;
  }

  append(inputs: unknown): unknown {
    const list = Array.isArray(inputs) ? inputs : [inputs];
    for (const input of list) {
      if (!Array.isArray(input)) continue;
      const type = String(input[0]);
      if (this.failOnAppend && type !== 'session/title') throw new Error('模拟写入失败');
      this.appended.push({
        type,
        data: input[1] as Record<string, unknown>,
        ...(input[2] !== undefined ? { opts: input[2] as { surfaceOp?: string } } : {}),
      });
    }
    return [];
  }

  /** 除标题外的会话事件（标题单独断言）。 */
  events(): AppendedEvent[] {
    return this.appended.filter((event) => event.type !== 'session/title');
  }

  titles(): string[] {
    return this.appended
      .filter((event) => event.type === 'session/title')
      .map((event) => String(event.data.title));
  }
}

interface FakeSessions {
  sessions: FakeSession[];
  created: number;
  store: MirrorSessionsLike;
}

function createFakeSessions(options: { failCreate?: boolean; failAppend?: boolean } = {}): FakeSessions {
  const sessions: FakeSession[] = [];
  const fake: FakeSessions = {
    sessions,
    created: 0,
    store: {
      create: () => {
        if (options.failCreate === true) throw new Error('磁盘只读');
        fake.created += 1;
        const session = new FakeSession(`session-mirror-${fake.created}`, options.failAppend === true);
        sessions.push(session);
        return session;
      },
    },
  };
  return fake;
}

interface FakeMirrorServer {
  base: string;
  queries: URLSearchParams[];
  clients: ServerResponse[];
  setOnConnection(hook: ((response: ServerResponse, query: URLSearchParams, index: number) => void) | undefined): void;
  send(name: string, payload: unknown): void;
  close(): Promise<void>;
}

async function startFakeMirror(options: { statusCode?: number; body?: string } = {}): Promise<FakeMirrorServer> {
  const queries: URLSearchParams[] = [];
  const clients: ServerResponse[] = [];
  let onConnection: ((response: ServerResponse, query: URLSearchParams, index: number) => void) | undefined;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/trpg/mirror') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"ok":false}');
      return;
    }
    queries.push(url.searchParams);
    if (options.statusCode !== undefined && options.statusCode !== 200) {
      response.writeHead(options.statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(options.body ?? JSON.stringify({ ok: false, error: { message: '服务器拒绝' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    response.write('retry: 1000\n\n');
    clients.push(response);
    onConnection?.(response, url.searchParams, queries.length);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    queries,
    clients,
    setOnConnection: (hook) => {
      onConnection = hook;
    },
    send: (name, payload) => {
      for (const client of clients) {
        if (!client.writableEnded) client.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      }
    },
    close: async () => {
      for (const client of clients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readyFrame(overrides: Partial<MirrorReadyFrame> = {}): MirrorReadyFrame {
  return {
    type: 'ready',
    v: 1,
    roomId: 'room-1',
    roomTitle: '鬼木崖·异光',
    lastSeq: 0,
    oldestSeq: 1,
    latestSeq: 0,
    skipped: 0,
    ...overrides,
  };
}

function frame(seq: number, kind: MirrorFrame['kind'], data: Record<string, unknown>): MirrorFrame {
  return { v: 1, seq, at: 1000 + seq, kind, data } as unknown as MirrorFrame;
}

function createClient(fake: FakeSessions, options: { reconnectDelayMs?: number; maxReconnectAttempts?: number } = {}): MirrorClientService {
  let id = 0;
  return new MirrorClientService({
    getSessions: () => fake.store,
    reconnectDelayMs: options.reconnectDelayMs ?? 10,
    maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
    createId: (prefix) => {
      id += 1;
      return `${prefix}-${id}`;
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startRequest(base: string, overrides: Record<string, unknown> = {}) {
  return {
    base,
    roomId: 'room-1',
    token: 'player-token-1234',
    playerName: '阿青',
    roomTitle: '鬼木崖·异光',
    ...overrides,
  };
}

test('镜像启动参数校验：地址/房间/令牌/可选字段', () => {
  const valid = validateMirrorStart(startRequest('http://127.0.0.1:45871/'));
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(valid.value.base, 'http://127.0.0.1:45871');
  assert.equal(valid.value.roomId, 'room-1');
  assert.equal(valid.value.lastSeq, undefined);

  assert.match((validateMirrorStart(null) as { error: string }).error, /对象/);
  assert.match((validateMirrorStart({ roomId: 'r', token: 't1234' }) as { error: string }).error, /base/);
  assert.match((validateMirrorStart({ base: 'ftp://x', roomId: 'r', token: 't1234' }) as { error: string }).error, /http/);
  assert.match((validateMirrorStart({ base: 'http://x', roomId: '', token: 't1234' }) as { error: string }).error, /roomId/);
  assert.match((validateMirrorStart({ base: 'http://x', roomId: 'r', token: 'x y' }) as { error: string }).error, /token/);
  const lastSeq = validateMirrorStart({ base: 'http://x', roomId: 'r', token: 't1234', lastSeq: -5 });
  assert.equal(lastSeq.ok, true);
  if (lastSeq.ok) assert.equal(lastSeq.value.lastSeq, undefined);
});

test('SSE 事件块解析：event/data/多行 data/注释', () => {
  assert.deepEqual(parseSseBlock('event: mirror\ndata: {"seq":1}'), { event: 'mirror', data: '{"seq":1}' });
  assert.deepEqual(parseSseBlock('data: a\ndata: b'), { event: 'message', data: 'a\nb' });
  assert.equal(parseSseBlock(': ping'), undefined);
  assert.equal(parseSseBlock('event: x'), undefined);
});

test('镜像服务：启动时一次性创建本地会话并钉住「跑团桌：<房名>」标题', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    const status = await mirror.start(startRequest(server.base));
    assert.equal(status.state, 'connecting');
    await waitFor(() => mirror.status('room-1').state === 'live');
    assert.equal(fake.created, 1);
    const session = fake.sessions[0] as FakeSession;
    assert.deepEqual(session.titles(), ['跑团桌：鬼木崖·异光']);
    const title = session.appended.find((event) => event.type === 'session/title');
    assert.equal((title?.data.source as { kind: string }).kind, 'user');
    assert.deepEqual(title?.data.messageSeqs, []);
    assert.equal(status.sessionId, session.id);
    // 第二次 start 幂等：不再建会话、不再建立第二条连接。
    await mirror.start(startRequest(server.base));
    assert.equal(fake.created, 1);
    assert.equal(server.queries.length, 1);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：帧映射到 DSH 事件白名单（用户气泡/叙事/工具卡/轮次）', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'live');
    const session = fake.sessions[0] as FakeSession;

    server.send('mirror', frame(1, 'narration', { text: 'GM：门开了。' }));
    server.send('mirror', frame(2, 'action', { playerId: 'p1', playerName: '阿青', text: '我推开门' }));
    server.send('mirror', frame(3, 'tool', { phase: 'call', callId: 'call-1', name: 'roll_check', summary: '检定：阿青 perception vs DC 12' }));
    server.send('mirror', frame(4, 'tool', { phase: 'result', callId: 'call-1', name: 'roll_check', summary: '阿青的侦察检定：d20=[15] + 2 = 17 vs DC 12 → 成功' }));
    server.send('mirror', frame(5, 'dice', {
      expression: '2d6', dice: [3, 4], modifier: 1, total: 8, rollerName: '阿青', private: false, label: '伤害',
    }));
    server.send('mirror', frame(6, 'combat', { text: '⚔️ 战斗 · 第 2 轮 · 行动：阿青' }));
    server.send('mirror', frame(7, 'award', { playerName: '阿青', xp: 50, items: ['面具'] }));
    server.send('mirror', frame(8, 'notice', { text: '🎬 场景：废弃道观' }));
    await waitFor(() => mirror.status('room-1').synced >= 8);
    await waitFor(() => session.events().some((event) => event.type === 'assistant/message'));

    const types = session.events().map((event) => event.type);
    const whitelist = new Set([
      'user/message', 'assistant/message', 'tool/call', 'tool/result',
      'turn/start', 'turn/end', 'step/start', 'step/end', 'session/title',
    ]);
    for (const type of types) assert.equal(whitelist.has(type), true, `非白名单事件：${type}`);

    // 玩家行动：原生用户气泡，带【角色名】，surfaceOp=append。
    const userMessages = session.events().filter((event) => event.type === 'user/message');
    assert.equal(userMessages.length, 1);
    const userText = (userMessages[0]?.data.content as Array<{ text: string }>)[0]?.text;
    assert.equal(userText, '【阿青】我推开门');
    assert.equal((userMessages[0]?.data.source as { kind: string }).kind, 'user');
    assert.equal(userMessages[0]?.opts?.surfaceOp, 'append');

    // GM 叙事：助手消息（markdown 文本）。
    const assistants = session.events().filter((event) => event.type === 'assistant/message');
    assert.equal(assistants.length, 3); // narration + award + notice
    const narration = assistants.find((event) => (event.data.message as { content: Array<{ text: string }> }).content[0]?.text.startsWith('GM'));
    assert.ok(narration);
    assert.equal((narration.data.message as { role: string }).role, 'assistant');
    assert.deepEqual(narration.data.stream, []);
    assert.equal(narration.opts?.surfaceOp, 'append');

    // 工具卡成对出现，参数只含摘要。
    const toolCalls = session.events().filter((event) => event.type === 'tool/call');
    const toolResults = session.events().filter((event) => event.type === 'tool/result');
    assert.equal(toolCalls.length, 3); // roll_check + dice + combat
    assert.equal(toolResults.length, 3);
    assert.equal(String(toolCalls[0]?.data.name), 'trpg_roll_check');
    assert.equal(Object.keys(JSON.parse(String(toolCalls[0]?.data.arguments))).join(','), '摘要');
    assert.match(JSON.stringify(toolResults[0]?.data), /成功/);

    // 轮次结构：玩家行动前收掉 GM turn，之后重新开 turn。
    assert.equal(session.appended[0]?.type, 'session/title');
    assert.equal(types.filter((type) => type === 'turn/start').length, 2);
    assert.equal(types.filter((type) => type === 'turn/end').length, 1);
    assert.equal(session.events().filter((event) => event.type === 'session/title').length, 0);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：重复/过期 seq 去重，重放不会写两遍', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'live');
    const session = fake.sessions[0] as FakeSession;
    const narration = frame(1, 'narration', { text: '只应出现一次' });
    server.send('mirror', narration);
    server.send('mirror', narration);
    server.send('mirror', frame(1, 'narration', { text: '旧帧' }));
    await waitFor(() => mirror.status('room-1').synced >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const texts = session.events()
      .filter((event) => event.type === 'assistant/message')
      .map((event) => (event.data.message as { content: Array<{ text: string }> }).content[0]?.text);
    assert.deepEqual(texts, ['只应出现一次']);
    assert.equal(mirror.status('room-1').synced, 1);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：ready.skipped>0 时写一条「从中间开始」的提示行', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame({ skipped: 3, oldestSeq: 4, latestSeq: 6 }))}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'live');
    const session = fake.sessions[0] as FakeSession;
    const gap = session.events().find((event) => event.type === 'user/message');
    assert.ok(gap);
    assert.equal((gap.data.source as { kind: string }).kind, 'system');
    assert.match((gap.data.content as Array<{ text: string }>)[0]?.text ?? '', /淘汰了更早的 3 条/);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：断线重连带 lastSeq 续传，不重复写历史', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake, { reconnectDelayMs: 10, maxReconnectAttempts: 3 });
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response, query, index) => {
      if (index === 1) {
        response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
        response.write(`event: mirror\ndata: ${JSON.stringify(frame(1, 'narration', { text: '第一段' }))}\n\n`);
        setTimeout(() => response.end(), 10);
        return;
      }
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame({ lastSeq: 1, latestSeq: 2, oldestSeq: 1 }))}\n\n`);
      response.write(`event: mirror\ndata: ${JSON.stringify(frame(2, 'narration', { text: '第二段' }))}\n\n`);
      // 重放一条已经消费过的帧（模拟服务端从 lastSeq 重发重复）。
      response.write(`event: mirror\ndata: ${JSON.stringify(frame(1, 'narration', { text: '第一段' }))}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => server.queries.length >= 2 && mirror.status('room-1').state === 'live');
    await waitFor(() => mirror.status('room-1').synced >= 2);
    assert.equal(server.queries[1]?.get('lastSeq'), '1');
    const session = fake.sessions[0] as FakeSession;
    const texts = session.events()
      .filter((event) => event.type === 'assistant/message')
      .map((event) => (event.data.message as { content: Array<{ text: string }> }).content[0]?.text);
    assert.deepEqual(texts, ['第一段', '第二段']);
    assert.equal(mirror.status('room-1').lastSeq, 2);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：会话创建失败降级为 error（不抛异常，提示可用右栏兜底）', async () => {
  const fake = createFakeSessions({ failCreate: true });
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    const status = await mirror.start(startRequest(server.base));
    assert.equal(status.state, 'error');
    assert.match(status.error ?? '', /创建镜像会话失败/);
    assert.match(status.error ?? '', /右栏/);
    assert.equal(server.queries.length, 0);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：没有 ctx.sessions（精简宿主）时降级为 unavailable', async () => {
  const mirror = new MirrorClientService({ getSessions: () => undefined });
  const status = await mirror.start(startRequest('http://127.0.0.1:1'));
  assert.equal(status.state, 'unavailable');
  assert.match(status.error ?? '', /右栏|P0/);
  mirror.dispose();
});

test('镜像服务：优先用 host 注入的会话工厂（UI 同款会话，可被原生界面打开）', async () => {
  let created = 0;
  const session = new FakeSession('session-ui-1');
  const mirror = new MirrorClientService({
    createSession: () => {
      created += 1;
      return { session, sessionId: 'session-ui-1' };
    },
    reconnectDelayMs: 10,
  });
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    const status = await mirror.start(startRequest(server.base));
    assert.equal(status.sessionId, 'session-ui-1');
    assert.equal(created, 1);
    await waitFor(() => mirror.status('room-1').state === 'live');
    mirror.stop('room-1');
    await mirror.start(startRequest(server.base));
    assert.equal(created, 1, '同一房间重启镜像应复用同一镜像会话');
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：会话工厂抛错 → error（提示右栏兜底），不建立 SSE 连接', async () => {
  const mirror = new MirrorClientService({
    createSession: async () => {
      throw new Error('workspace 只读');
    },
    reconnectDelayMs: 10,
  });
  const server = await startFakeMirror();
  try {
    const status = await mirror.start(startRequest(server.base));
    assert.equal(status.state, 'error');
    assert.match(status.error ?? '', /创建镜像会话失败/);
    assert.match(status.error ?? '', /workspace 只读/);
    assert.equal(server.queries.length, 0);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：HTTP 401 明确提示重新加入房间，且不无限重连', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake, { reconnectDelayMs: 10, maxReconnectAttempts: 2 });
  const server = await startFakeMirror({ statusCode: 401, body: JSON.stringify({ ok: false, error: { message: '令牌无效' } }) });
  try {
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'error');
    assert.match(mirror.status('room-1').error ?? '', /令牌|重新加入/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(server.queries.length, 1);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：写入会话失败 → error 状态并保留可读原因', async () => {
  const fake = createFakeSessions({ failAppend: true });
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'live');
    server.send('mirror', frame(1, 'narration', { text: '写不进去' }));
    await waitFor(() => mirror.status('room-1').state === 'error');
    assert.match(mirror.status('room-1').error ?? '', /写入镜像会话失败/);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：服务端 close 事件 → stopped 且原因中文', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'live');
    server.send('close', { type: 'close', reason: '房主关闭了房间' });
    await waitFor(() => mirror.status('room-1').state === 'stopped');
    assert.match(mirror.status('room-1').error ?? '', /关闭/);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：stop 后不再写入，重启复用同一镜像会话并带 lastSeq 续传', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
      response.write(`event: mirror\ndata: ${JSON.stringify(frame(1, 'narration', { text: '第一段' }))}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').synced >= 1);
    const session = fake.sessions[0] as FakeSession;
    const stopped = mirror.stop('room-1');
    assert.equal(stopped.state, 'stopped');
    server.send('mirror', frame(2, 'narration', { text: '停止后不该写入' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(session.events().filter((event) => event.type === 'assistant/message').length, 1);

    await mirror.start(startRequest(server.base));
    await waitFor(() => server.queries.length >= 2);
    assert.equal(fake.created, 1);
    assert.equal(server.queries[1]?.get('lastSeq'), '1');
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：房间名来自 ready 握手时补钉标题', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame({ roomTitle: '鬼木崖·异光' }))}\n\n`);
    });
    await mirror.start(startRequest(server.base, { roomTitle: undefined }));
    await waitFor(() => mirror.status('room-1').state === 'live');
    const session = fake.sessions[0] as FakeSession;
    await waitFor(() => session.titles().includes('跑团桌：鬼木崖·异光'));
    assert.equal(session.appended[0]?.type, 'session/title');
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：非法 JSON/版本不符的帧被忽略', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const server = await startFakeMirror();
  try {
    server.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame())}\n\n`);
    });
    await mirror.start(startRequest(server.base));
    await waitFor(() => mirror.status('room-1').state === 'live');
    server.clients[0]?.write('event: mirror\ndata: not-json\n\n');
    server.send('mirror', { v: 99, seq: 1, kind: 'narration', data: { text: '版本不符' } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const session = fake.sessions[0] as FakeSession;
    assert.equal(session.events().length, 0);
    assert.equal(mirror.status('room-1').synced, 0);
  } finally {
    mirror.dispose();
    await server.close();
  }
});

test('镜像服务：同一实例可并行镜像多个房间，status/stop 按 roomId 区分', async () => {
  const fake = createFakeSessions();
  const mirror = createClient(fake);
  const first = await startFakeMirror();
  const second = await startFakeMirror();
  try {
    first.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame({ roomId: 'room-1' }))}\n\n`);
    });
    second.setOnConnection((response) => {
      response.write(`event: ready\ndata: ${JSON.stringify(readyFrame({ roomId: 'room-2' }))}\n\n`);
    });
    await mirror.start(startRequest(first.base, { roomId: 'room-1' }));
    await mirror.start(startRequest(second.base, { roomId: 'room-2' }));
    await waitFor(() => mirror.status('room-1').state === 'live' && mirror.status('room-2').state === 'live');
    assert.equal(fake.created, 2);
    assert.equal(mirror.status('room-1').sessionId, 'session-mirror-1');
    assert.equal(mirror.status('room-2').sessionId, 'session-mirror-2');
    assert.equal(mirror.stop('room-1').state, 'stopped');
    assert.equal(mirror.status('room-2').state, 'live');
    assert.equal(mirror.stop().state, 'stopped');
  } finally {
    mirror.dispose();
    await first.close();
    await second.close();
  }
});
