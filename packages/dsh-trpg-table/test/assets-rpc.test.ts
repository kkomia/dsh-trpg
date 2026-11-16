/**
 * M9.5d host HTTP 集成：`assets.generate` / `assets.upload` RPC + `GET /trpg/room-assets/...`
 * 端点 + 落座引用闭环（上传 → 落座 → 房间视图/卡面/战棋带 URL）。
 *
 * 走真链路：内置内容包（PackRegistry → RoomService 规则运行时）→ HTTP RPC；
 * 生图用 `--fake` 假生成器（离线），资产区用临时目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARDS } from '@dsh-trpg/content';
import type { AssetsGenerateResult, AssetsUploadResult, RoomView, SheetView } from '@dsh-trpg/protocol';
import { RoomService } from '@dsh-trpg/rooms';
import { encodePng } from '../../assets/src/index.ts';
import { createRoomHttpServer, type RoomHttpServer } from '../src/host/room-http.ts';
import { PackRegistry } from '../src/host/pack-registry.ts';
import { MediaService, RoomAssetStore, type MediaAssetsService, type RoomAssetsStore } from '../src/host/media/index.ts';

interface TestServer {
  base: string;
  service: RoomService;
  media: MediaService;
  roomAssets: RoomAssetStore;
  mediaDir: string;
  close: () => Promise<void>;
}

interface StartOptions {
  media?: MediaAssetsService | false;
  roomAssets?: RoomAssetsStore | false;
}

function avatarPng(): Uint8Array {
  const rgba = new Uint8Array(256 * 256 * 4);
  for (let index = 0; index < 256 * 256; index += 1) {
    rgba[index * 4] = index % 256;
    rgba[index * 4 + 1] = (index * 5) % 256;
    rgba[index * 4 + 2] = 90;
    rgba[index * 4 + 3] = 255;
  }
  return encodePng({ width: 256, height: 256, rgba });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function startServer(options: StartOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-assets-rpc-'));
  const mediaDir = mkdtempSync(join(tmpdir(), 'dsh-trpg-assets-rpc-media-'));
  const registry = new PackRegistry({ dir });
  registry.reload();
  const service = new RoomService({ content: registry, rules: registry });
  const media = new MediaService({ fake: true, env: {}, rateLimit: { max: 3, windowMs: 60_000 } });
  const roomAssets = new RoomAssetStore({ dir: mediaDir });
  const http: RoomHttpServer = createRoomHttpServer({
    port: 0,
    bindHost: '127.0.0.1',
    service,
    contentCatalog: () => registry.publicCatalog(),
    assetOf: (packId, assetPath) => registry.assetOf(packId, assetPath),
    ...(options.media === false ? {} : { media: options.media ?? media }),
    ...(options.roomAssets === false ? {} : { roomAssets: options.roomAssets ?? roomAssets }),
  });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', () => resolve()));
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    service,
    media,
    roomAssets,
    mediaDir,
    close: async () => {
      await http.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(mediaDir, { recursive: true, force: true });
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

interface Joined {
  inviteCode: string;
  hostToken: string;
  playerToken: string;
  playerId: string;
  roomId: string;
}

async function openRoom(base: string): Promise<Joined> {
  const created = await rpc<{ room: RoomView; hostToken: string; inviteCode: string }>(base, 'room.create', {
    title: '资产 RPC',
    gmMode: 'ai',
  });
  assert.equal(created.ok, true, created.error?.message);
  const hostToken = created.result!.hostToken;
  const inviteCode = created.result!.inviteCode;
  const joined = await rpc<{ playerId: string; playerToken: string }>(base, 'room.join', { inviteCode, playerName: '阿青' });
  assert.equal(joined.ok, true, joined.error?.message);
  return {
    inviteCode,
    hostToken,
    playerToken: joined.result!.playerToken,
    playerId: joined.result!.playerId,
    roomId: created.result!.room.roomId,
  };
}

// ---------------------------------------------------------------------------
// assets.generate
// ---------------------------------------------------------------------------

test('HTTP assets.generate：未注入生图服务 → conflict + 可读中文错误', async () => {
  const server = await startServer({ media: false });
  try {
    const room = await openRoom(server.base);
    const generated = await rpc(server.base, 'assets.generate', { kind: 'avatar', style: 'game-2d', prompt: '阿青' }, room.playerToken);
    assert.equal(generated.ok, false);
    assert.equal(generated.error?.code, 'conflict');
    assert.match(generated.error?.message ?? '', /生图服务未启用/);
    assert.match(generated.error?.message ?? '', /DSH_TRPG_OPENAI_BASE_URL/);
  } finally {
    await server.close();
  }
});

test('HTTP assets.generate：无 token → unauthorized（不能匿名烧房主配额）', async () => {
  const server = await startServer();
  try {
    const generated = await rpc(server.base, 'assets.generate', { kind: 'avatar', style: 'game-2d', prompt: '阿青' });
    assert.equal(generated.ok, false);
    assert.equal(generated.error?.code, 'unauthorized');
  } finally {
    await server.close();
  }
});

test('HTTP assets.generate：玩家/房主都可用（fake 生成器）→ 候选标准档 + 参数校验中文错误', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const asPlayer = await rpc<AssetsGenerateResult>(
      server.base,
      'assets.generate',
      { kind: 'avatar', style: 'game-2d', prompt: '青衫少年', subject: '阿青', count: 2 },
      room.playerToken,
    );
    assert.equal(asPlayer.ok, true, asPlayer.error?.message);
    assert.equal(asPlayer.result?.candidates.length, 2);
    assert.equal(asPlayer.result?.candidates[0]?.width, 256);
    assert.equal(asPlayer.result?.provider, 'fake');
    const bytes = Buffer.from(asPlayer.result!.candidates[0]!.b64, 'base64');
    assert.equal(sha256(new Uint8Array(bytes)), asPlayer.result!.candidates[0]!.sha256);

    const asHost = await rpc<AssetsGenerateResult>(
      server.base,
      'assets.generate',
      { kind: 'icon', style: 'pixel-32', prompt: '横刀' },
      room.hostToken,
    );
    assert.equal(asHost.ok, true, asHost.error?.message);
    assert.equal(asHost.result?.candidates[0]?.width, 32);

    const badKind = await rpc(server.base, 'assets.generate', { kind: 'cover', style: 'game-2d', prompt: 'x' }, room.playerToken);
    assert.equal(badKind.ok, false);
    assert.equal(badKind.error?.code, 'bad-request');
    assert.match(badKind.error?.message ?? '', /kind 必须是/);
    const badCount = await rpc(
      server.base,
      'assets.generate',
      { kind: 'avatar', style: 'game-2d', prompt: 'x', count: 5 },
      room.playerToken,
    );
    assert.match(badCount.error?.message ?? '', /count 必须是 1–4/);
  } finally {
    await server.close();
  }
});

test('HTTP assets.generate：每玩家限流 3 次/分钟 → 第 4 次 conflict（房主配额独立）', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    for (let index = 0; index < 3; index += 1) {
      const ok = await rpc(server.base, 'assets.generate', { kind: 'avatar', style: 'game-2d', prompt: `第${index}次` }, room.playerToken);
      assert.equal(ok.ok, true, ok.error?.message);
    }
    const limited = await rpc(server.base, 'assets.generate', { kind: 'avatar', style: 'game-2d', prompt: '第4次' }, room.playerToken);
    assert.equal(limited.ok, false);
    assert.equal(limited.error?.code, 'conflict');
    assert.match(limited.error?.message ?? '', /生成请求太频繁/);
    const hostOk = await rpc(server.base, 'assets.generate', { kind: 'avatar', style: 'game-2d', prompt: '房主' }, room.hostToken);
    assert.equal(hostOk.ok, true, '房主不与玩家共享限流');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// assets.upload + GET /trpg/room-assets
// ---------------------------------------------------------------------------

test('HTTP assets.upload：无 token → unauthorized；未注入存储 → conflict', async () => {
  const noStore = await startServer({ roomAssets: false });
  try {
    const room = await openRoom(noStore.base);
    const anonymous = await rpc(noStore.base, 'assets.upload', { assets: [{ kind: 'avatar', b64: 'AAA=' }] });
    assert.equal(anonymous.ok, false);
    assert.equal(anonymous.error?.code, 'unauthorized');
    const asPlayer = await rpc(noStore.base, 'assets.upload', { assets: [{ kind: 'avatar', b64: 'AAA=' }] }, room.playerToken);
    assert.equal(asPlayer.ok, false);
    assert.equal(asPlayer.error?.code, 'conflict');
    assert.match(asPlayer.error?.message ?? '', /房间资产存储未启用/);
  } finally {
    await noStore.close();
  }
});

test('HTTP assets.upload → GET /trpg/room-assets：200 + content-type + ETag + immutable + 304', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const bytes = avatarPng();
    const uploaded = await rpc<AssetsUploadResult>(
      server.base,
      'assets.upload',
      { assets: [{ kind: 'avatar', b64: Buffer.from(bytes).toString('base64') }] },
      room.playerToken,
    );
    assert.equal(uploaded.ok, true, uploaded.error?.message);
    const asset = uploaded.result!.assets[0]!;
    assert.equal(asset.sha256, sha256(bytes));
    assert.equal(asset.width, 256);
    assert.equal(asset.url, `/trpg/room-assets/${room.roomId}/${asset.sha256}.png`);

    // 无 token 只读
    const response = await fetch(`${server.base}${asset.url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('etag'), `"${asset.sha256.slice(0, 16)}"`);
    assert.match(response.headers.get('cache-control') ?? '', /public, max-age=31536000, immutable/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytes]);

    // If-None-Match → 304（短 ETag / 完整 sha256 / * 都认）
    const etag = response.headers.get('etag')!;
    for (const header of [etag, `"${asset.sha256}"`, '*']) {
      const cached = await fetch(`${server.base}${asset.url}`, { headers: { 'if-none-match': header } });
      assert.equal(cached.status, 304, `If-None-Match: ${header}`);
      assert.equal((await cached.arrayBuffer()).byteLength, 0);
    }
    const stale = await fetch(`${server.base}${asset.url}`, { headers: { 'if-none-match': '"0000000000000000"' } });
    assert.equal(stale.status, 200);
  } finally {
    await server.close();
  }
});

test('HTTP assets.upload：同内容 sha256 去重（重复上传同 url，不重复落盘）', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const body = { assets: [{ kind: 'avatar', b64: Buffer.from(avatarPng()).toString('base64') }] };
    const first = await rpc<AssetsUploadResult>(server.base, 'assets.upload', body, room.playerToken);
    const second = await rpc<AssetsUploadResult>(server.base, 'assets.upload', body, room.playerToken);
    assert.equal(first.result!.assets[0]!.url, second.result!.assets[0]!.url);
    assert.equal(server.roomAssets.listRoom(room.roomId).length, 1);
  } finally {
    await server.close();
  }
});

test('HTTP assets.upload：超限/尺寸不符 → 中文错误（bad-request / conflict）', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const nine = { assets: Array.from({ length: 9 }, () => ({ kind: 'avatar', b64: 'AAA=' })) };
    const tooMany = await rpc(server.base, 'assets.upload', nine, room.playerToken);
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error?.code, 'bad-request');
    assert.match(tooMany.error?.message ?? '', /单次最多上传 8 个资产/);

    const wrongSize = await rpc(
      server.base,
      'assets.upload',
      { assets: [{ kind: 'portrait', b64: Buffer.from(avatarPng()).toString('base64') }] },
      room.playerToken,
    );
    assert.equal(wrongSize.ok, false);
    assert.equal(wrongSize.error?.code, 'bad-request');
    assert.match(wrongSize.error?.message ?? '', /768×1024 的立绘/);
  } finally {
    await server.close();
  }
});

test('HTTP 房间资产端点：路径穿越/非法文件名 → 403；不存在 → 404；未注入存储 → 404', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const sha = 'a'.repeat(64);
    const base = `${server.base}/trpg/room-assets/`;
    const forbidden = [
      `${room.roomId}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      `..%2f${room.roomId}/${sha}.png`,
      `${room.roomId}/..%2f${sha}.png`,
      `${room.roomId}/${sha.toUpperCase()}.png`,
      `${room.roomId}/${sha.slice(0, 16)}.png`,
      `${room.roomId}/index.json`,
      `${room.roomId}/%00.png`,
      `${room.roomId}/a%5cb.png`,
    ];
    for (const path of forbidden) {
      const response = await fetch(base + path);
      assert.equal(response.status, 403, `${path} 应 403`);
      const body = (await response.json()) as { ok: boolean; error?: { code?: string; message?: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error?.code, 'forbidden');
      assert.ok((body.error?.message ?? '').length > 0, '中文错误信息不能为空');
    }
    const missing = await fetch(`${base}${room.roomId}/${sha}.png`);
    assert.equal(missing.status, 404);
    const missingBody = (await missing.json()) as { error?: { message?: string } };
    assert.match(missingBody.error?.message ?? '', /房间资产不存在/);

    const unsupported = await fetch(`${base}${room.roomId}/${sha}.jpg`);
    assert.equal(unsupported.status, 404);
  } finally {
    const noStore = await startServer({ roomAssets: false });
    try {
      const room2 = await openRoom(noStore.base);
      const response = await fetch(`${noStore.base}/trpg/room-assets/${room2.roomId}/${'a'.repeat(64)}.png`);
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error?: { message?: string } };
      assert.match(body.error?.message ?? '', /房间资产存储未启用/);
    } finally {
      await noStore.close();
    }
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 落座引用闭环：上传 → seat → 房间视图 / 卡面 / 战棋
// ---------------------------------------------------------------------------

test('HTTP 落座带资产引用：RoomView.assets + sheet.identity.avatarUrl 指向可取的房间资产', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const bytes = avatarPng();
    const uploaded = await rpc<AssetsUploadResult>(
      server.base,
      'assets.upload',
      { assets: [{ kind: 'avatar', b64: Buffer.from(bytes).toString('base64') }] },
      room.playerToken,
    );
    const asset = uploaded.result!.assets[0]!;
    const seated = await rpc<{ room: RoomView }>(
      server.base,
      'room.seat',
      {
        characterCard: CARDS[0],
        characterAssets: [{ kind: 'avatar', sha256: asset.sha256, url: asset.url }],
      },
      room.playerToken,
    );
    assert.equal(seated.ok, true, seated.error?.message);
    assert.equal(seated.result?.room.assets?.length, 1);
    assert.equal(seated.result?.room.assets?.[0]?.kind, 'avatar');
    const sheet = await rpc<{ sheet: SheetView }>(server.base, 'sheet.get', {}, room.playerToken);
    assert.equal(sheet.ok, true, sheet.error?.message);
    assert.equal(sheet.result?.sheet.identity.avatarUrl, asset.url);
    // DTO 里的 URL 就是无 token 可取的只读地址
    const image = await fetch(`${server.base}${sheet.result!.sheet.identity.avatarUrl}`);
    assert.equal(image.status, 200);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [...bytes]);

    // 战棋 token 也带同一头像
    const started = await rpc<{ combat: { tokens: Array<{ playerId?: string; avatarUrl?: string }> } }>(
      server.base,
      'combat.start',
      { enemies: [{ name: '血尸' }] },
      room.hostToken,
    );
    assert.equal(started.ok, true, started.error?.message);
    const token = started.result?.combat.tokens.find((candidate) => candidate.playerId === room.playerId);
    assert.equal(token?.avatarUrl, asset.url);
  } finally {
    await server.close();
  }
});

test('HTTP 落座带未知 sha256 引用：不阻断落座（丢弃引用，客户端用徽记兜底）', async () => {
  const server = await startServer();
  try {
    const room = await openRoom(server.base);
    const unknown = 'f'.repeat(64);
    const seated = await rpc<{ room: RoomView }>(
      server.base,
      'room.seat',
      {
        characterCard: CARDS[0],
        characterAssets: [{ kind: 'avatar', sha256: unknown, url: `/trpg/room-assets/${room.roomId}/${unknown}.png` }],
      },
      room.playerToken,
    );
    assert.equal(seated.ok, true, seated.error?.message);
    assert.equal(seated.result?.room.assets, undefined);
    const sheet = await rpc<{ sheet: SheetView }>(server.base, 'sheet.get', {}, room.playerToken);
    assert.equal(sheet.result?.sheet.identity.avatarUrl, undefined);
  } finally {
    await server.close();
  }
});
