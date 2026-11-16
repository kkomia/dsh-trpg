import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogPack, ContentReloadResult, RoomView } from '@dsh-trpg/protocol';
import { CORE_GUIMUYA_PACK, ASSET_MANIFEST_ENTRY, type AssetManifest, type ContentPack } from '@dsh-trpg/content';
import { packToTrpgpack } from '@dsh-trpg/content/pack-zip';
import { RoomService } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from '../src/host/room-http.ts';
import { PackRegistry } from '../src/host/pack-registry.ts';

interface TestServer {
  base: string;
  registry: PackRegistry;
  close: () => Promise<void>;
}

/** 播种一个内容包目录（返回目录路径；测试自己决定写什么 .trpgpack）。 */
function seedDir(seed?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-http-'));
  seed?.(dir);
  return dir;
}

async function startServer(seed?: (dir: string) => void): Promise<TestServer> {
  const dir = seedDir(seed);
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
    assetOf: (packId, assetPath) => registry.assetOf(packId, assetPath),
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

// ---------------------------------------------------------------------------
// M9.5b 只读资产端点：播种一个带 assets/manifest.json + png/svg 的数据目录包
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#2f6f4e"/></svg>';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SeededAsset {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  etag: string;
}

interface SeededPack {
  packId: string;
  svg: SeededAsset;
  png: SeededAsset;
}

function assetEntry(assetId: string, file: string, format: 'png' | 'svg', bytes: Uint8Array): Record<string, unknown> {
  return {
    assetId,
    file,
    format,
    size: format === 'svg' ? { w: 128, h: 128 } : { w: 32, h: 32 },
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    kind: format === 'svg' ? 'status' : 'item',
    style: 'imported',
    seed: null,
    prompt: null,
    createdAt: '2026-11-16T18:00:00+08:00',
  };
}

/** 写一个带资产清单的 `.trpgpack`（三处引用：pack.icon / items[].icon / ui.itemCategories[].icon）。 */
function seedAssetPack(dir: string): SeededPack {
  const pack = JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
  pack.packId = 'asset-pack';
  pack.name = '资产测试包';
  pack.version = '1.0.0';
  pack.icon = 'assets/cover.png';
  pack.rules!.items![0]!.icon = 'icon.item.hengdao';
  pack.rules!.ui!.itemCategories![0]!.icon = 'status/poison';

  const svgBytes = encoder.encode(SVG_TEXT);
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const manifest: AssetManifest = {
    schemaVersion: 'trpg.assets/1',
    packId: 'asset-pack',
    assets: [
      assetEntry('cover.core.main', 'assets/cover.png', 'png', pngBytes),
      assetEntry('icon.item.hengdao', 'assets/icons/item/hengdao.png', 'png', pngBytes),
      assetEntry('icon.status.poison', 'assets/icons/status/poison.svg', 'svg', svgBytes),
    ] as unknown as AssetManifest['assets'],
  };
  const assets = new Map<string, Uint8Array>([
    ['assets/cover.png', pngBytes],
    ['assets/icons/item/hengdao.png', pngBytes],
    ['assets/icons/status/poison.svg', svgBytes],
    [ASSET_MANIFEST_ENTRY, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)],
  ]);
  writeFileSync(join(dir, 'asset-pack-1.0.0.trpgpack'), packToTrpgpack(pack, { assets }));
  const seeded = (path: string, bytes: Uint8Array): SeededAsset => {
    const sha256 = sha256Hex(bytes);
    return { path, bytes, sha256, etag: `"${sha256.slice(0, 16)}"` };
  };
  return {
    packId: 'asset-pack',
    svg: seeded('icons/status/poison.svg', svgBytes),
    png: seeded('cover.png', pngBytes),
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

// ---------------------------------------------------------------------------
// M9.5b：`GET /trpg/assets/<packId>/<assetPath>`（无 token、只读、ETag/304、403/404）
// ---------------------------------------------------------------------------

test('HTTP: 只读资产端点 200（无 token）+ content-type + ETag + immutable', async () => {
  let seeded: SeededPack | undefined;
  const server = await startServer((dir) => {
    seeded = seedAssetPack(dir);
  });
  try {
    assert.ok(seeded);
    // 不带任何 token / Authorization：资产端点是公开只读的（UI-CONTRACT §4.1）
    const svg = await fetch(`${server.base}/trpg/assets/${seeded.packId}/${seeded.svg.path}`);
    assert.equal(svg.status, 200, svg.status === 404 ? await svg.text() : '');
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.equal(svg.headers.get('etag'), seeded.svg.etag, 'ETag 应为 sha256 前 16 的强校验器');
    assert.match(svg.headers.get('cache-control') ?? '', /public, max-age=31536000, immutable/);
    assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...new Uint8Array(await svg.arrayBuffer())], [...seeded.svg.bytes]);

    const png = await fetch(`${server.base}/trpg/assets/${seeded.packId}/${seeded.png.path}`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [...seeded.png.bytes]);
    assert.equal(png.headers.get('etag'), seeded.png.etag);
  } finally {
    await server.close();
  }
});

test('HTTP: 资产端点 If-None-Match → 304（短 ETag / 完整 sha256 / * 都认）', async () => {
  let seeded: SeededPack | undefined;
  const server = await startServer((dir) => {
    seeded = seedAssetPack(dir);
  });
  try {
    assert.ok(seeded);
    const url = `${server.base}/trpg/assets/${seeded.packId}/${seeded.svg.path}`;
    const first = await fetch(url);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    await first.arrayBuffer();

    const short = await fetch(url, { headers: { 'if-none-match': etag } });
    assert.equal(short.status, 304);
    assert.equal(short.headers.get('etag'), etag);
    assert.match(short.headers.get('cache-control') ?? '', /immutable/);
    assert.equal((await short.arrayBuffer()).byteLength, 0, '304 不应带 body');

    const full = await fetch(url, { headers: { 'if-none-match': `"${seeded.svg.sha256}"` } });
    assert.equal(full.status, 304, '也接受完整 sha256 作为 ETag');
    await full.arrayBuffer();

    const wildcard = await fetch(url, { headers: { 'if-none-match': '*' } });
    assert.equal(wildcard.status, 304);
    await wildcard.arrayBuffer();

    const stale = await fetch(url, { headers: { 'if-none-match': '"0000000000000000"' } });
    assert.equal(stale.status, 200, '不匹配的 ETag 要回 200 全量');
  } finally {
    await server.close();
  }
});

test('HTTP: 资产端点 404（缺包 / 缺资产 / 非图片类型 / 内置包无字节资产）与中文错误', async () => {
  const server = await startServer((dir) => {
    seedAssetPack(dir);
  });
  try {
    for (const [path, part] of [
      ['asset-pack/icons/none.png', /资产不存在/],
      ['missing-pack/cover.png', /资产不存在/],
      ['asset-pack/manifest.json', /资产类型不支持/],
      ['asset-pack/cover.txt', /资产类型不支持/],
      ['core-guimuya/cover.png', /资产不存在/],
    ] as const) {
      const response = await fetch(`${server.base}/trpg/assets/${path}`);
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const body = (await response.json()) as { ok: boolean; error?: { code?: string; message?: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error?.code, 'not-found');
      assert.match(body.error?.message ?? '', part, path);
    }
  } finally {
    await server.close();
  }
});

test('HTTP: 未注入 assetOf 时资产端点优雅 404（host 未接注册表也不崩）', async () => {
  const dir = seedDir((seedDirPath) => {
    seedAssetPack(seedDirPath);
  });
  const registry = new PackRegistry({ dir });
  registry.reload();
  const service = new RoomService({ content: registry });
  const http = createRoomHttpServer({ port: 0, bindHost: '127.0.0.1', service });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', () => resolve()));
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/trpg/assets/asset-pack/cover.png`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { ok: boolean; error?: { code?: string; message?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, 'not-found');
    assert.match(body.error?.message ?? '', /资产不存在/);
  } finally {
    await http.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: 资产端点路径穿越 / 反斜杠 / 控制字符 / 空段 → 403（不泄露文件）', async () => {
  const server = await startServer((dir) => {
    seedAssetPack(dir);
  });
  try {
    const base = `${server.base}/trpg/assets/`;
    const cases: Array<[string, string]> = [
      ['asset-pack/%2e%2e/secret.png', '编码的 .. 穿越'],
      ['asset-pack/icons/item/%2e%2e%2f%2e%2e%2fsecret.png', '编码的 ../.. 穿越'],
      ['asset-pack/icons%5citem%5csecret.png', '反斜杠'],
      ['asset-pack/icons/item/secret%00.png', '控制字符 NUL'],
      ['asset-pack//cover.png', '空路径段'],
      ['asset-pack/icons%2f..%2f..%2fsecret.png', '编码斜杠的 .. 穿越'],
      ['Asset-Pack/cover.png', 'packId 大小写非法'],
    ];
    for (const [path, label] of cases) {
      const response = await fetch(base + path);
      assert.equal(response.status, 403, `${label}：应 403，实际 ${response.status}`);
      const body = (await response.json()) as { ok: boolean; error?: { code?: string; message?: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error?.code, 'forbidden');
      assert.ok((body.error?.message ?? '').length > 0, `${label}：中文错误信息不能为空`);
    }
    // 未编码的 `..` 会被 URL 规范化掉（请求变成别的路径）→ 非 200 即可，绝不能读到文件
    const plain = await fetch(`${server.base}/trpg/assets/asset-pack/../secret.png`);
    assert.notEqual(plain.status, 200);
    await plain.text();
  } finally {
    await server.close();
  }
});
