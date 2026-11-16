import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogPack, ContentReloadResult, RoomView } from '@dsh-trpg/protocol';
import { RoomService } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from '../src/host/room-http.ts';
import { PackRegistry } from '../src/host/pack-registry.ts';

interface TestServer {
  base: string;
  registry: PackRegistry;
  close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-http-'));
  const registry = new PackRegistry({ dir });
  registry.reload();
  const service = new RoomService({ content: registry });
  const http: RoomHttpServer = createRoomHttpServer({
    port: 0,
    bindHost: '127.0.0.1',
    service,
    contentCatalog: () => registry.publicCatalog(),
    contentReload: () => {
      const reloaded = registry.reload();
      const recoveredRooms = service.revalidateContent().recovered;
      return { ...reloaded, ...(recoveredRooms > 0 ? { recoveredRooms } : {}) };
    },
  });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', () => resolve()));
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    registry,
    close: async () => {
      await http.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface RpcBody<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

async function rpc<T = unknown>(base: string, method: string, params?: unknown, token?: string): Promise<RpcBody<T>> {
  const response = await fetch(`${base}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...(params !== undefined ? { params } : {}), ...(token ? { token } : {}) }),
  });
  return (await response.json()) as RpcBody<T>;
}

test('HTTP: content.list 不需要 token，返回脱敏目录，可直接用于选包建房', async () => {
  const server = await startServer();
  try {
    const listed = await rpc<{ packs: CatalogPack[] }>(server.base, 'content.list');
    assert.equal(listed.ok, true);
    const packs = listed.result?.packs ?? [];
    assert.equal(packs.length, 1);
    const pack = packs[0];
    assert.ok(pack);
    assert.equal(pack.packId, 'core-guimuya');
    assert.deepEqual(Object.keys(pack.modules[0] ?? {}).sort(), ['level', 'moduleId', 'playerCount', 'sceneCount', 'title']);
    const serialized = JSON.stringify(listed.result);
    assert.ok(!serialized.includes('gmNotes'), 'content.list 不能泄漏 GM 备注');

    const created = await rpc<{ room: RoomView; hostToken: string; inviteCode: string }>(server.base, 'room.create', {
      title: '接包测试',
      gmMode: 'ai',
      packId: pack.packId,
      moduleId: pack.modules[0]?.moduleId,
    });
    assert.equal(created.ok, true, created.error?.message);
    const room = created.result?.room;
    assert.ok(room);
    assert.equal(room.content?.packId, 'core-guimuya');
    assert.equal(room.content?.moduleId, pack.modules[0]?.moduleId);
    assert.equal(room.content?.packVersion, pack.version);
    assert.equal(room.scenes?.length, pack.modules[0]?.sceneCount);
    assert.equal(room.content?.degraded, undefined);
  } finally {
    await server.close();
  }
});

test('HTTP: room.create 选不存在的包 → bad-request 中文错误', async () => {
  const server = await startServer();
  try {
    const bad = await rpc(server.base, 'room.create', { title: 'x', gmMode: 'ai', packId: 'missing-pack' });
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, 'bad-request');
    assert.match(bad.error?.message ?? '', /内容包/);
  } finally {
    await server.close();
  }
});

test('HTTP: content.reload 需要 loopback + host token（玩家/无 token 被拒），房主可重扫', async () => {
  const server = await startServer();
  try {
    const anonymous = await rpc(server.base, 'content.reload');
    assert.equal(anonymous.ok, false);
    assert.equal(anonymous.error?.code, 'unauthorized');

    const created = await rpc<{ room: RoomView; hostToken: string; inviteCode: string }>(server.base, 'room.create', {
      title: '重扫',
      gmMode: 'ai',
    });
    const hostToken = created.result?.hostToken;
    const inviteCode = created.result?.inviteCode;
    assert.ok(hostToken && inviteCode);

    const joined = await rpc<{ playerToken: string }>(server.base, 'room.join', { inviteCode, playerName: '阿青' });
    const playerToken = joined.result?.playerToken;
    assert.ok(playerToken);
    const asPlayer = await rpc(server.base, 'content.reload', undefined, playerToken);
    assert.equal(asPlayer.ok, false);
    assert.equal(asPlayer.error?.code, 'forbidden');

    const asHost = await rpc<ContentReloadResult>(server.base, 'content.reload', undefined, hostToken);
    assert.equal(asHost.ok, true, asHost.error?.message);
    assert.equal(asHost.result?.packs, 1);
    assert.deepEqual(asHost.result?.warnings, []);
  } finally {
    await server.close();
  }
});
