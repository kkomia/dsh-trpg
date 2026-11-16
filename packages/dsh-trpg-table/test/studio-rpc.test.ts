/**
 * M9.5e 工坊 RPC 接线（host/room-http.ts）：8 个方法全部 **loopback + host token**，
 * 通过真实 HTTP 调用验证参数校验 / 鉴权 / 生成 / 内容包读写闭环。
 *
 * 结构生成用注入的文本生成器（固定 JSON，离线）；底图用注入的假生图器（`fakeMediaPng`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_GUIMUYA_PACK, ASSET_MANIFEST_ENTRY } from '@dsh-trpg/content';
import { trpgpackToPack } from '@dsh-trpg/content/pack-zip';
import { RoomService } from '@dsh-trpg/rooms';
import type { RpcResponse } from '@dsh-trpg/protocol';
import { createRoomHttpServer, type RoomHttpServer } from '../src/host/room-http.ts';
import { PackRegistry } from '../src/host/pack-registry.ts';
import {
  createStudio,
  type Studio,
  type StudioImageGenerator,
  type StudioTextGenerator,
} from '../src/host/studio/index.ts';
import { fakeMediaPng } from '../src/host/media/index.ts';

const BUILTIN_ID = CORE_GUIMUYA_PACK.packId;

const BATTLE_DRAFT = JSON.stringify({
  cols: 6,
  rows: 5,
  legend: '# wall | . floor',
  terrain: ['######', '#....#', '#....#', '#....#', '######'],
  spawns: [
    { x: 1, y: 2, side: 'player' },
    { x: 4, y: 2, side: 'enemy' },
  ],
});

const WORLD_DRAFT = JSON.stringify({
  zones: [
    {
      zoneId: 'zone_a',
      name: '青石镇',
      hotspot: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 },
      connections: [
        { to: 'zone_b', kind: 'road' },
        { to: 'zone_c', kind: 'path' },
      ],
    },
    {
      zoneId: 'zone_b',
      name: '枯木崖',
      hotspot: { x: 0.55, y: 0.05, w: 0.2, h: 0.2 },
      connections: [
        { to: 'zone_a', kind: 'road' },
        { to: 'zone_c', kind: 'river' },
      ],
    },
    {
      zoneId: 'zone_c',
      name: '寒潭',
      hotspot: { x: 0.05, y: 0.6, w: 0.2, h: 0.2 },
      connections: [
        { to: 'zone_a', kind: 'path' },
        { to: 'zone_b', kind: 'river' },
      ],
    },
  ],
});

const fakeImageGenerator: StudioImageGenerator = () => ({ images: [{ bytes: fakeMediaPng(0) }], provider: 'fake' });

const textGenerator: StudioTextGenerator = (request) =>
  request.kind === 'battle-map' ? BATTLE_DRAFT : WORLD_DRAFT;

interface Harness {
  base: string;
  service: RoomService;
  registry: PackRegistry;
  studio: Studio | undefined;
  hostToken: string;
  playerToken: string;
  rpc: <T = unknown>(method: string, params: unknown, token?: string) => Promise<RpcResponse<T>>;
  createPack: (packId?: string, version?: string) => Promise<{ packId: string; version: string; packHash: string }>;
  close: () => Promise<void>;
}

async function harness(options: {
  withStudio?: boolean;
  isLoopbackRequest?: () => boolean;
  imageGenerator?: StudioImageGenerator;
  studioText?: StudioTextGenerator;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-studio-rpc-'));
  const registry = new PackRegistry({ dir, log: () => {} });
  registry.reload();
  const studio =
    options.withStudio === false
      ? undefined
      : createStudio({
          registry,
          dir,
          env: {},
          textGenerator: options.studioText ?? textGenerator,
          imageGenerator: options.imageGenerator ?? fakeImageGenerator,
          log: () => {},
        });
  const service = new RoomService({ content: registry });
  const http: RoomHttpServer = createRoomHttpServer({
    port: 0,
    bindHost: '127.0.0.1',
    service,
    contentCatalog: () => registry.publicCatalog(),
    contentReload: () => registry.reload(),
    ...(studio !== undefined ? { studio } : {}),
    ...(options.isLoopbackRequest !== undefined ? { isLoopbackRequest: options.isLoopbackRequest } : {}),
  });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', () => resolve()));
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const created = service.createRoom({ title: '工坊测试', gmMode: 'human' });
  const roomId = created.room.roomId;
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '玩家甲' });

  const rpc = async <T = unknown>(method: string, params: unknown, token?: string): Promise<RpcResponse<T>> => {
    const response = await fetch(`${base}/trpg/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params, ...(token !== undefined ? { token } : {}) }),
    });
    return (await response.json()) as RpcResponse<T>;
  };

  const createPack = async (packId = 'rpc-pack', version = '1.0.0'): Promise<{ packId: string; version: string; packHash: string }> => {
    const clone = structuredClone(CORE_GUIMUYA_PACK) as unknown as Record<string, unknown> & { rules?: unknown };
    delete clone.rules;
    clone.packId = packId;
    clone.version = version;
    clone.name = `RPC 包 ${version}`;
    const result = await rpc<{ packId: string; version: string; packHash: string }>(
      'pack.update',
      { packId, pack: clone },
      created.hostToken,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    return (result as { ok: true; result: { packId: string; version: string; packHash: string } }).result;
  };

  return {
    base,
    service,
    registry,
    studio,
    hostToken: created.hostToken,
    playerToken: joined.playerToken,
    rpc,
    createPack,
    close: async () => {
      await http.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function resultOf<T>(response: RpcResponse<T>): T {
  assert.equal(response.ok, true, `RPC 应成功，实际：${JSON.stringify(response)}`);
  return (response as { ok: true; result: T }).result;
}

function errorOf(response: RpcResponse<unknown>): { code: string; message: string } {
  assert.equal(response.ok, false, `RPC 应失败，实际：${JSON.stringify(response)}`);
  return (response as { ok: false; error: { code: string; message: string } }).error;
}

// ---------------------------------------------------------------------------
// 鉴权：loopback + host token
// ---------------------------------------------------------------------------

test('工坊 RPC 鉴权：无 token → unauthorized；玩家 token → forbidden（10 个方法全拒）', async () => {
  const h = await harness();
  try {
    const methods = [
      'map.generate',
      'world.generate',
      'pack.detail',
      'pack.update',
      'pack.export',
      'pack.import',
      'pack.assetPut',
      'pack.assetDelete',
      'rules.validate',
      'rules.test',
    ] as const;
    for (const method of methods) {
      const noToken = errorOf(await h.rpc(method, { packId: BUILTIN_ID, prompt: 'x', style: 'topdown-2d' }));
      assert.equal(noToken.code, 'unauthorized', `${method} 无 token 应 unauthorized`);
      const player = errorOf(
        await h.rpc(method, { packId: BUILTIN_ID, prompt: 'x', style: 'topdown-2d' }, h.playerToken),
      );
      assert.equal(player.code, 'forbidden', `${method} 玩家 token 应 forbidden`);
      assert.match(player.message, /只有房主/);
    }
  } finally {
    await h.close();
  }
});

test('工坊 RPC 鉴权：非 loopback 请求即使 host token 也 forbidden（10 个方法全拒）', async () => {
  const h = await harness({ isLoopbackRequest: () => false });
  try {
    const cases: Array<[string, unknown]> = [
      ['map.generate', { prompt: '洞口', style: 'topdown-2d' }],
      ['world.generate', { prompt: '青石镇' }],
      ['pack.detail', { packId: BUILTIN_ID }],
      ['pack.update', { packId: 'x-pack', pack: { packId: 'x-pack' } }],
      ['pack.export', { packId: BUILTIN_ID }],
      ['pack.import', { b64: 'AAAA', strategy: 'reject' }],
      ['pack.assetPut', { packId: BUILTIN_ID, assetId: 'item.x.y', kind: 'item', b64: 'AAAA' }],
      ['pack.assetDelete', { packId: BUILTIN_ID, assetId: 'item.x.y' }],
      ['rules.validate', { packId: BUILTIN_ID }],
      ['rules.test', { packId: BUILTIN_ID, requests: [{ kind: 'derived' }] }],
    ];
    for (const [method, params] of cases) {
      const error = errorOf(await h.rpc(method, params, h.hostToken));
      assert.equal(error.code, 'forbidden', `${method} 非 loopback 应 forbidden`);
      assert.match(error.message, /loopback/);
    }
  } finally {
    await h.close();
  }
});

test('工坊 RPC：host 未注入 studio → conflict 中文错误', async () => {
  const h = await harness({ withStudio: false });
  try {
    const error = errorOf(await h.rpc('map.generate', { prompt: '洞口', style: 'topdown-2d' }, h.hostToken));
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /工坊服务未启用/);
  } finally {
    await h.close();
  }
});

test('工坊 RPC：参数校验在 dispatch 前生效（bad-request + 中文原因）', async () => {
  const h = await harness();
  try {
    const style = errorOf(await h.rpc('map.generate', { prompt: '洞口', style: 'isometric' }, h.hostToken));
    assert.equal(style.code, 'bad-request');
    assert.match(style.message, /style/);
    const packId = errorOf(await h.rpc('pack.detail', { packId: 'BAD ID' }, h.hostToken));
    assert.equal(packId.code, 'bad-request');
    assert.match(packId.message, /packId/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 地图 / 世界生成（含底图）
// ---------------------------------------------------------------------------

test('map.generate：AI 草稿 → 结构 + method=ai；withBackground 走假生图器归一化到 1024×768', async () => {
  const h = await harness();
  try {
    const plain = resultOf<{
      structure: { cols: number; rows: number; terrain: string[][]; spawns: unknown[] };
      warnings: string[];
      method: string;
      background: unknown;
    }>(await h.rpc('map.generate', { prompt: '洞口遭遇', style: 'topdown-2d' }, h.hostToken));
    assert.equal(plain.method, 'ai');
    assert.equal(plain.structure.cols, 6);
    assert.equal(plain.structure.rows, 5);
    assert.equal(plain.background, null);
    assert.equal(plain.structure.spawns.length, 2);

    const withBg = resultOf<{
      background: { b64: string; width: number; height: number; sha256: string; format: string } | null;
    }>(
      await h.rpc(
        'map.generate',
        { prompt: '洞口遭遇', style: 'pixel-topdown', cols: 8, rows: 6, partySize: 2, seed: 3, withBackground: true },
        h.hostToken,
      ),
    );
    assert.ok(withBg.background);
    assert.equal(withBg.background.width, 1024);
    assert.equal(withBg.background.height, 768);
    assert.equal(withBg.background.format, 'png');
    assert.equal(Buffer.from(withBg.background.b64, 'base64').length > 0, true);
  } finally {
    await h.close();
  }
});

test('map.generate：底图生图失败只进 warnings，结构照常返回', async () => {
  const h = await harness({
    imageGenerator: () => {
      throw new Error('生图接口 503');
    },
  });
  try {
    const result = resultOf<{ structure: unknown; method: string; warnings: string[]; background: unknown }>(
      await h.rpc('map.generate', { prompt: '洞口', style: 'topdown-2d', withBackground: true }, h.hostToken),
    );
    assert.ok(result.structure);
    assert.equal(result.background, null);
    assert.match(result.warnings.join('；'), /底图生图失败.*生图接口 503/);
  } finally {
    await h.close();
  }
});

test('map.generate：AI 草稿连续失败 → 程序化兜底（method=procedural、结构合法）', async () => {
  const h = await harness({ studioText: () => '模型不会画' });
  try {
    const result = resultOf<{ method: string; warnings: string[]; structure: { terrain: string[][] } }>(
      await h.rpc('map.generate', { prompt: '断崖', style: 'topdown-2d', partySize: 3 }, h.hostToken),
    );
    assert.equal(result.method, 'procedural');
    assert.match(result.warnings.join('；'), /回退程序化/);
    assert.ok(result.structure.terrain.length > 0);
  } finally {
    await h.close();
  }
});

test('world.generate：AI 草稿 → 3 区域 + 底图 2048×1536；zoneCount 越界被 bad-request 拒绝', async () => {
  const h = await harness();
  try {
    const result = resultOf<{
      world: { zones: Array<{ zoneId: string; connections: unknown[] }>; background: null };
      method: string;
      background: { width: number; height: number } | null;
    }>(await h.rpc('world.generate', { prompt: '青石镇周边', withBackground: true }, h.hostToken));
    assert.equal(result.method, 'ai');
    assert.equal(result.world.zones.length, 3);
    assert.equal(result.world.background, null);
    assert.ok(result.background);
    assert.equal(result.background.width, 2048);
    assert.equal(result.background.height, 1536);

    const bad = errorOf(await h.rpc('world.generate', { prompt: '青石镇', zoneCount: 9 }, h.hostToken));
    assert.equal(bad.code, 'bad-request');
    assert.match(bad.message, /zoneCount/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 内容包工坊闭环
// ---------------------------------------------------------------------------

test('pack.detail：host 可取完整包（含 rules/modules/cards）；未知包 not-found', async () => {
  const h = await harness();
  try {
    const detail = resultOf<{ pack: { packId: string; modules: unknown[]; cards: unknown[]; rules?: unknown } }>(
      await h.rpc('pack.detail', { packId: BUILTIN_ID }, h.hostToken),
    );
    assert.equal(detail.pack.packId, BUILTIN_ID);
    assert.ok(detail.pack.modules.length > 0);
    assert.ok(detail.pack.cards.length > 0);
    assert.ok(detail.pack.rules !== undefined);
    const missing = errorOf(await h.rpc('pack.detail', { packId: 'not-installed' }, h.hostToken));
    assert.equal(missing.code, 'not-found');
  } finally {
    await h.close();
  }
});

test('pack.update：新建数据包 → registry reload 后 content.list 可见；内置包拒绝；坏包拒绝', async () => {
  const h = await harness();
  try {
    const created = await h.createPack('rpc-pack', '1.0.0');
    assert.equal(created.packId, 'rpc-pack');
    assert.match(created.packHash, /^[0-9a-f]{64}$/);
    assert.equal(h.registry.getEntry('rpc-pack')?.source, 'data');
    const catalog = resultOf<{ packs: Array<{ packId: string; source: string }> }>(await h.rpc('content.list', {}));
    assert.ok(catalog.packs.some((pack) => pack.packId === 'rpc-pack' && pack.source === 'data'));

    const builtin = errorOf(
      await h.rpc('pack.update', { packId: BUILTIN_ID, pack: { ...structuredClone(CORE_GUIMUYA_PACK) } }, h.hostToken),
    );
    assert.equal(builtin.code, 'conflict');
    assert.match(builtin.message, /内置包/);

    const broken = errorOf(
      await h.rpc('pack.update', { packId: 'broken-pack', pack: { packId: 'broken-pack', name: '' } }, h.hostToken),
    );
    assert.equal(broken.code, 'bad-request');
    assert.match(broken.message, /校验失败/);
  } finally {
    await h.close();
  }
});

test('pack.export / pack.import：导出内置包 → rename 导入副本 → 新包可 detail', async () => {
  const h = await harness();
  try {
    const exported = resultOf<{ fileName: string; b64: string; bytes: number; packHash: string }>(
      await h.rpc('pack.export', { packId: BUILTIN_ID }, h.hostToken),
    );
    assert.equal(exported.fileName, `${BUILTIN_ID}-${CORE_GUIMUYA_PACK.version}.trpgpack`);
    const decoded = trpgpackToPack(new Uint8Array(Buffer.from(exported.b64, 'base64')));
    assert.equal(decoded.ok, true);

    const rejected = errorOf(
      await h.rpc('pack.import', { b64: exported.b64, strategy: 'reject' }, h.hostToken),
    );
    assert.equal(rejected.code, 'conflict');

    const imported = resultOf<{ packId: string; version: string; action: string; warnings: string[] }>(
      await h.rpc('pack.import', { b64: exported.b64, strategy: 'rename' }, h.hostToken),
    );
    assert.equal(imported.action, 'renamed');
    assert.equal(imported.packId, `${BUILTIN_ID}-copy-1`);
    const detail = resultOf<{ pack: { packId: string } }>(
      await h.rpc('pack.detail', { packId: imported.packId }, h.hostToken),
    );
    assert.equal(detail.pack.packId, imported.packId);
  } finally {
    await h.close();
  }
});

test('pack.assetPut / assetDelete：上传 PNG → 导出包里能看到 manifest 条目 → 删除后消失', async () => {
  const h = await harness();
  try {
    await h.createPack('asset-pack', '1.0.0');
    const png = Buffer.from(fakeMediaPng(0)).toString('base64');
    const put = resultOf<{ assetId: string; sha256: string; bytes: number; manifestUpdated: boolean }>(
      await h.rpc(
        'pack.assetPut',
        { packId: 'asset-pack', assetId: 'item.weapon.blade', kind: 'item', b64: png, meta: { style: 'imported' } },
        h.hostToken,
      ),
    );
    assert.equal(put.assetId, 'item.weapon.blade');
    assert.equal(put.manifestUpdated, true);
    assert.ok(put.bytes > 0);

    const exported = resultOf<{ b64: string }>(await h.rpc('pack.export', { packId: 'asset-pack' }, h.hostToken));
    const decoded = trpgpackToPack(new Uint8Array(Buffer.from(exported.b64, 'base64')));
    assert.equal(decoded.ok, true, decoded.errors.join('；'));
    const manifest = JSON.parse(
      new TextDecoder().decode(decoded.assets.get(ASSET_MANIFEST_ENTRY) as Uint8Array),
    ) as { assets: Array<{ assetId: string; sha256: string }> };
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0]?.assetId, 'item.weapon.blade');
    assert.equal(manifest.assets[0]?.sha256, put.sha256);

    const deleted = resultOf<{ removed: boolean }>(
      await h.rpc('pack.assetDelete', { packId: 'asset-pack', assetId: 'item.weapon.blade' }, h.hostToken),
    );
    assert.equal(deleted.removed, true);
    const after = resultOf<{ b64: string }>(await h.rpc('pack.export', { packId: 'asset-pack' }, h.hostToken));
    const afterDecoded = trpgpackToPack(new Uint8Array(Buffer.from(after.b64, 'base64')));
    const afterManifest = JSON.parse(
      new TextDecoder().decode(afterDecoded.assets.get(ASSET_MANIFEST_ENTRY) as Uint8Array),
    ) as { assets: unknown[] };
    assert.equal(afterManifest.assets.length, 0);
  } finally {
    await h.close();
  }
});

test('pack.assetPut：内置包 → conflict；坏 b64 → bad-request（RPC 层中文错误）', async () => {
  const h = await harness();
  try {
    const builtin = errorOf(
      await h.rpc(
        'pack.assetPut',
        { packId: BUILTIN_ID, assetId: 'item.x.y', kind: 'item', b64: Buffer.from('x').toString('base64') },
        h.hostToken,
      ),
    );
    assert.equal(builtin.code, 'conflict');
    assert.match(builtin.message, /内置包/);
    await h.createPack('bad-asset-pack', '1.0.0');
    const bad = errorOf(
      await h.rpc(
        'pack.assetPut',
        { packId: 'bad-asset-pack', assetId: 'item.x.y', kind: 'item', b64: '!!!!!!!!' },
        h.hostToken,
      ),
    );
    assert.equal(bad.code, 'bad-request');
    assert.match(bad.message, /Base64/);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// M9.6b 规则校验 / 规则测试台（新增 2 个方法走同一条工坊鉴权通道）
// ---------------------------------------------------------------------------

test('rules.validate RPC：内置包通过；草稿 sha256 不符时 ok=false 但 RPC 成功（不落盘）', async () => {
  const h = await harness();
  try {
    const builtin = resultOf<{ ok: boolean; rulesId: string; draft: boolean; scripts: unknown[] }>(
      await h.rpc('rules.validate', { packId: BUILTIN_ID }, h.hostToken),
    );
    assert.equal(builtin.ok, true);
    assert.equal(builtin.draft, false);
    assert.equal(builtin.rulesId, CORE_GUIMUYA_PACK.rules?.rulesId);
    assert.ok(builtin.scripts.length > 0);

    const draft = structuredClone(CORE_GUIMUYA_PACK) as unknown as {
      rules?: { scripts?: Record<string, { file: string; sha256: string }> };
    };
    const scripts = draft.rules?.scripts;
    assert.ok(scripts !== undefined);
    const firstHook = Object.keys(scripts)[0] as string;
    scripts[firstHook] = { ...scripts[firstHook]!, sha256: '0'.repeat(64) };
    const draftResult = resultOf<{ ok: boolean; draft: boolean; errors: string[] }>(
      await h.rpc('rules.validate', { packId: BUILTIN_ID, pack: draft }, h.hostToken),
    );
    assert.equal(draftResult.ok, false);
    assert.equal(draftResult.draft, true);
    assert.match(draftResult.errors.join('；'), /sha256 与清单不符/);
    // 未落盘：再次校验已安装包仍然通过
    const again = resultOf<{ ok: boolean }>(await h.rpc('rules.validate', { packId: BUILTIN_ID }, h.hostToken));
    assert.equal(again.ok, true);
  } finally {
    await h.close();
  }
});

test('rules.test RPC：检定返回 rolls/trace/result；参数错误走 bad-request 中文', async () => {
  const h = await harness();
  try {
    const result = resultOf<{
      ok: boolean;
      seed: number;
      outcomes: Array<{ ok: boolean; rolls: unknown[]; trace: { lines: string[] }; result: Record<string, unknown> | null }>;
    }>(
      await h.rpc(
        'rules.test',
        { packId: BUILTIN_ID, requests: [{ kind: 'check', skillId: 'perception', dc: 10 }], seed: 123 },
        h.hostToken,
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.seed, 123);
    assert.equal(result.outcomes.length, 1);
    assert.ok(result.outcomes[0]!.rolls.length >= 1);
    assert.ok(result.outcomes[0]!.trace.lines.length > 0);
    assert.equal(typeof result.outcomes[0]!.result?.total, 'number');

    const bad = errorOf(
      await h.rpc('rules.test', { packId: BUILTIN_ID, requests: [{ kind: 'action' }] }, h.hostToken),
    );
    assert.equal(bad.code, 'bad-request');
    assert.match(bad.message, /需要 actionId/);
  } finally {
    await h.close();
  }
});
