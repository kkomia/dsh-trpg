/**
 * M9.5e 内容包工坊后端（host/studio/pack-workspace.ts）：detail / update / export / import /
 * assetPut / assetDelete。全部离线临时目录，不碰真实 profile-data。
 *
 * 覆盖：内置包只读、原子写与旧版本清理、校验失败不落盘、资产归一化 + manifest 更新、
 * 被引用资产拒绝删除、同 id 冲突三种策略、导出 packHash 与文件字节一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_GUIMUYA_PACK, ASSET_MANIFEST_ENTRY, type AssetManifest, type ContentPack } from '@dsh-trpg/content';
import { packHashOfBytes, packToTrpgpack, trpgpackToPack } from '@dsh-trpg/content/pack-zip';
import { readPackFile } from '@dsh-trpg/content/pack-io';
import { RoomError } from '@dsh-trpg/rooms';
import { PackRegistry } from '../src/host/pack-registry.ts';
import { PackWorkspace } from '../src/host/studio/index.ts';
import { fakeMediaPng } from '../src/host/media/index.ts';

const BUILTIN_ID = CORE_GUIMUYA_PACK.packId;
const PNG_B64 = Buffer.from(fakeMediaPng(0)).toString('base64');
const SVG_B64 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#2f6f4e"/></svg>',
  'utf8',
).toString('base64');

interface Harness {
  dir: string;
  registry: PackRegistry;
  workspace: PackWorkspace;
  close: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-studio-'));
  const registry = new PackRegistry({ dir });
  registry.reload();
  const workspace = new PackWorkspace({ registry, dir, now: () => 1_760_000_000_000 });
  return {
    dir,
    registry,
    workspace,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 最小可用测试包：内置包 clone 去掉 rules（避免脚本条目依赖），改 id/版本/名称。 */
function makePack(packId = 'test-pack', version = '1.0.0'): ContentPack {
  const clone = structuredClone(CORE_GUIMUYA_PACK) as ContentPack & { rules?: unknown };
  delete clone.rules;
  clone.packId = packId;
  clone.version = version;
  clone.name = `测试包 ${version}`;
  clone.author = '测试作者';
  return clone;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function expectRoomError(
  operation: () => Promise<unknown> | unknown,
  code: string,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(
    async () => operation(),
    (error: unknown) => {
      assert.ok(error instanceof RoomError, `应抛 RoomError，收到：${String(error)}`);
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// detail / update
// ---------------------------------------------------------------------------

test('pack.detail：内置包返回完整包（rules/lorebook/modules/cards），且是深拷贝', () => {
  const { registry, workspace, close } = harness();
  try {
    const result = workspace.detail({ packId: BUILTIN_ID });
    const pack = result.pack as ContentPack;
    assert.equal(pack.packId, BUILTIN_ID);
    assert.ok(Array.isArray(pack.modules) && pack.modules.length > 0);
    assert.ok(Array.isArray(pack.cards) && pack.cards.length > 0);
    assert.ok(Array.isArray(pack.lorebook.entries) && pack.lorebook.entries.length > 0);
    assert.ok(pack.rules !== undefined, '内置包应带 rules 段');
    // 深拷贝：改返回值不影响注册表
    pack.name = '被改坏了';
    assert.notEqual(registry.get(BUILTIN_ID)?.name, '被改坏了');
    const fresh = (workspace.detail({ packId: BUILTIN_ID }).pack as ContentPack).name;
    assert.equal(fresh, CORE_GUIMUYA_PACK.name);
  } finally {
    close();
  }
});

test('pack.detail：包不存在 → not-found 中文错误', async () => {
  const { workspace, close } = harness();
  try {
    await expectRoomError(() => workspace.detail({ packId: 'nope' }), 'not-found', /内容包不存在/);
  } finally {
    close();
  }
});

test('pack.update：内置包只读（conflict），不写任何文件', async () => {
  const { dir, workspace, close } = harness();
  try {
    await expectRoomError(
      () => workspace.update({ packId: BUILTIN_ID, pack: makePack(BUILTIN_ID) }),
      'conflict',
      /内置包.*只读/,
    );
    assert.deepEqual(
      (await import('node:fs')).readdirSync(dir).filter((name) => name.endsWith('.trpgpack')),
      [],
      '内置包只读：不应产生任何数据目录文件',
    );
  } finally {
    close();
  }
});

test('pack.update：新包写入 <packId>-<version>.trpgpack 并 reload（packHash 与文件字节一致）', async () => {
  const { dir, registry, workspace, close } = harness();
  try {
    const before = packHashOfBytes(new Uint8Array(0));
    const result = await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    assert.equal(result.packId, 'test-pack');
    assert.equal(result.version, '1.0.0');
    assert.match(result.packHash, /^[0-9a-f]{64}$/);
    assert.notEqual(result.packHash, before);
    const filePath = join(dir, 'test-pack-1.0.0.trpgpack');
    assert.equal(existsSync(filePath), true);
    const fileBytes = new Uint8Array(readFileSync(filePath));
    assert.equal(sha256(fileBytes), result.packHash);
    const entry = registry.getEntry('test-pack');
    assert.ok(entry);
    assert.equal(entry.source, 'data');
    assert.equal(entry.pack.version, '1.0.0');
  } finally {
    close();
  }
});

test('pack.update：升版本写新文件并删旧文件（不留下两个同名包）', async () => {
  const { dir, registry, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const updated = makePack('test-pack', '1.1.0');
    updated.description = '第二版';
    const result = await workspace.update({ packId: 'test-pack', pack: updated });
    assert.equal(result.version, '1.1.0');
    assert.equal(existsSync(join(dir, 'test-pack-1.0.0.trpgpack')), false, '旧版本文件应被清理');
    assert.equal(existsSync(join(dir, 'test-pack-1.1.0.trpgpack')), true);
    assert.equal(registry.getEntry('test-pack')?.pack.description, '第二版');
  } finally {
    close();
  }
});

test('pack.update：validatePack 失败 → bad-request 且不落盘（旧版本保持）', async () => {
  const { dir, registry, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const broken = makePack('test-pack', '2.0.0') as unknown as Record<string, unknown>;
    broken.name = '';
    broken.version = 'not-semver';
    await expectRoomError(() => workspace.update({ packId: 'test-pack', pack: broken }), 'bad-request', /校验失败/);
    assert.equal(existsSync(join(dir, 'test-pack-2.0.0.trpgpack')), false, '坏包不能留下半成品');
    assert.equal(registry.getEntry('test-pack')?.pack.version, '1.0.0');
  } finally {
    close();
  }
});

test('pack.update：packId 与 pack.packId 不一致 → bad-request', async () => {
  const { workspace, close } = harness();
  try {
    await expectRoomError(
      () => workspace.update({ packId: 'test-pack', pack: makePack('other-pack') }),
      'bad-request',
      /packId/,
    );
  } finally {
    close();
  }
});

test('pack.update：编辑 pack.json 时保留既有 assets/scripts 二进制条目', async () => {
  const { dir, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const put = await workspace.assetPut({
      packId: 'test-pack',
      assetId: 'item.test.rock',
      kind: 'item',
      b64: PNG_B64,
    });
    const updated = makePack('test-pack', '1.0.0');
    updated.description = '改描述不应丢资产';
    await workspace.update({ packId: 'test-pack', pack: updated });
    const filePath = join(dir, 'test-pack-1.0.0.trpgpack');
    const decoded = await readPackFile(filePath);
    assert.equal(decoded.ok, true, decoded.errors.join('；'));
    const assetPath = [...decoded.assets.keys()].find((path) => path !== ASSET_MANIFEST_ENTRY);
    assert.ok(assetPath, '资产条目应保留');
    const assetBytes = decoded.assets.get(assetPath as string) as Uint8Array;
    assert.equal(sha256(assetBytes), put.sha256);
    assert.match(assetPath as string, /^assets\/icons\/item-test-rock\.png$/);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test('pack.export：内置包现场编码（可复现），b64 解码后能再次通过 zip 校验', async () => {
  const { workspace, close } = harness();
  try {
    const result = workspace.exportPack({ packId: BUILTIN_ID });
    assert.equal(result.fileName, `${BUILTIN_ID}-${CORE_GUIMUYA_PACK.version}.trpgpack`);
    const bytes = new Uint8Array(Buffer.from(result.b64, 'base64'));
    assert.equal(bytes.length, result.bytes);
    assert.equal(sha256(bytes), result.packHash);
    const decoded = trpgpackToPack(bytes);
    assert.equal(decoded.ok, true, decoded.errors.join('；'));
    assert.equal(decoded.pack?.packId, BUILTIN_ID);
    assert.ok(decoded.scripts.size > 0, '内置 dnd5e-lite 规则脚本应随包导出');
  } finally {
    close();
  }
});

test('pack.export：数据目录包导出原始字节，packHash = sha256(文件)', async () => {
  const { dir, workspace, close } = harness();
  try {
    const update = await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const fileBytes = new Uint8Array(readFileSync(join(dir, 'test-pack-1.0.0.trpgpack')));
    assert.equal(packHashOfBytes(fileBytes), update.packHash);
    const exported = workspace.exportPack({ packId: 'test-pack' });
    assert.equal(exported.packHash, packHashOfBytes(fileBytes));
    assert.deepEqual(new Uint8Array(Buffer.from(exported.b64, 'base64')), fileBytes);
  } finally {
    close();
  }
});

test('pack.export：包不存在 → not-found', async () => {
  const { workspace, close } = harness();
  try {
    await expectRoomError(() => workspace.exportPack({ packId: 'nope' }), 'not-found', /内容包不存在/);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

test('pack.import：reject 策略遇内置包同 id → conflict（提示 overwrite/rename）', async () => {
  const { workspace, close } = harness();
  try {
    const b64 = Buffer.from(packToTrpgpack(CORE_GUIMUYA_PACK)).toString('base64');
    await expectRoomError(
      () => workspace.importPack({ b64, strategy: 'reject' }),
      'conflict',
      /已安装.*overwrite.*rename/s,
    );
  } finally {
    close();
  }
});

test('pack.import：overwrite 内置包 → conflict；rename → 另存 copy-1 且注册表双包并存', async () => {
  const { dir, registry, workspace, close } = harness();
  try {
    const b64 = Buffer.from(packToTrpgpack(CORE_GUIMUYA_PACK)).toString('base64');
    await expectRoomError(
      () => workspace.importPack({ b64, strategy: 'overwrite' }),
      'conflict',
      /内置包.*不可覆盖/,
    );
    const renamed = await workspace.importPack({ b64, strategy: 'rename' });
    assert.equal(renamed.action, 'renamed');
    assert.equal(renamed.packId, `${BUILTIN_ID}-copy-1`);
    assert.equal(registry.getEntry(`${BUILTIN_ID}-copy-1`)?.source, 'data');
    assert.ok(existsSync(join(dir, `${BUILTIN_ID}-copy-1-${CORE_GUIMUYA_PACK.version}.trpgpack`)));
    // 再导入一次 → copy-2（不踩已有副本）
    const second = await workspace.importPack({ b64, strategy: 'rename' });
    assert.equal(second.packId, `${BUILTIN_ID}-copy-2`);
  } finally {
    close();
  }
});

test('pack.import：overwrite 数据包 → action=overwritten、版本更新、旧文件清理', async () => {
  const { dir, registry, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const incoming = makePack('test-pack', '1.1.0');
    incoming.description = '导入覆盖版';
    const b64 = Buffer.from(packToTrpgpack(incoming)).toString('base64');
    const result = await workspace.importPack({ b64, strategy: 'overwrite' });
    assert.equal(result.action, 'overwritten');
    assert.equal(result.version, '1.1.0');
    assert.equal(registry.getEntry('test-pack')?.pack.description, '导入覆盖版');
    assert.equal(existsSync(join(dir, 'test-pack-1.0.0.trpgpack')), false);
    assert.equal(existsSync(join(dir, 'test-pack-1.1.0.trpgpack')), true);
  } finally {
    close();
  }
});

test('pack.import：坏 base64 / 坏 zip → bad-request（不落盘）', async () => {
  const { dir, workspace, close } = harness();
  try {
    await expectRoomError(
      () => workspace.importPack({ b64: '不是base64', strategy: 'reject' }),
      'bad-request',
      /Base64/,
    );
    const fakeZip = Buffer.from('this is not a zip').toString('base64');
    await expectRoomError(
      () => workspace.importPack({ b64: fakeZip, strategy: 'reject' }),
      'bad-request',
      /校验失败|ZIP/,
    );
    assert.deepEqual(
      (await import('node:fs')).readdirSync(dir).filter((name) => name.endsWith('.trpgpack')),
      [],
    );
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// assetPut / assetDelete
// ---------------------------------------------------------------------------

test('pack.assetPut：PNG → 归一化到 icon-128 + 写 manifest/资产，validatePack 通过', async () => {
  const { dir, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const result = await workspace.assetPut({
      packId: 'test-pack',
      assetId: 'item.test.rock',
      kind: 'item',
      b64: PNG_B64,
      meta: { style: 'game-2d', seed: 7, prompt: '一块石头' },
    });
    assert.equal(result.assetId, 'item.test.rock');
    assert.equal(result.manifestUpdated, true);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    const decoded = await readPackFile(join(dir, 'test-pack-1.0.0.trpgpack'));
    assert.equal(decoded.ok, true, decoded.errors.join('；'));
    const manifestBytes = decoded.assets.get(ASSET_MANIFEST_ENTRY);
    assert.ok(manifestBytes);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as AssetManifest;
    const entry = manifest.assets.find((asset) => asset.assetId === 'item.test.rock');
    assert.ok(entry);
    assert.equal(entry.format, 'png');
    assert.deepEqual(entry.size, { w: 128, h: 128 });
    assert.equal(entry.sha256, result.sha256);
    assert.equal(entry.style, 'game-2d');
    assert.equal(entry.seed, 7);
    assert.equal(entry.prompt, '一块石头');
    const stored = decoded.assets.get(entry.file);
    assert.ok(stored);
    assert.equal(sha256(stored as Uint8Array), result.sha256);
  } finally {
    close();
  }
});

test('pack.assetPut：同 assetId 重复上传 = 替换（manifest 单条、sha 更新、旧文件清理）', async () => {
  const { dir, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const first = await workspace.assetPut({ packId: 'test-pack', assetId: 'status.test.fire', kind: 'status', b64: PNG_B64 });
    const second = await workspace.assetPut({
      packId: 'test-pack',
      assetId: 'status.test.fire',
      kind: 'status',
      b64: SVG_B64,
    });
    assert.notEqual(first.sha256, second.sha256);
    const decoded = await readPackFile(join(dir, 'test-pack-1.0.0.trpgpack'));
    const manifest = JSON.parse(new TextDecoder().decode(decoded.assets.get(ASSET_MANIFEST_ENTRY))) as AssetManifest;
    const matches = manifest.assets.filter((asset) => asset.assetId === 'status.test.fire');
    assert.equal(matches.length, 1, '同 assetId 只能有一条 manifest 记录');
    assert.equal(matches[0]?.format, 'svg');
    assert.equal(matches[0]?.sha256, second.sha256);
    const assetFileEntries = [...decoded.assets.keys()].filter((path) => path !== ASSET_MANIFEST_ENTRY);
    assert.equal(assetFileEntries.length, 1, '替换后不应残留旧文件');
  } finally {
    close();
  }
});

test('pack.assetPut：meta.target=world-map 归一化到 2048×1536；battle-map 到 1024×768', async () => {
  const { dir, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    await workspace.assetPut({
      packId: 'test-pack',
      assetId: 'cover.world.region',
      kind: 'cover',
      b64: PNG_B64,
      meta: { target: 'world-map' },
    });
    await workspace.assetPut({
      packId: 'test-pack',
      assetId: 'cover.battle.cave',
      kind: 'cover',
      b64: PNG_B64,
      meta: { target: 'battle-map' },
    });
    const decoded = await readPackFile(join(dir, 'test-pack-1.0.0.trpgpack'));
    const manifest = JSON.parse(new TextDecoder().decode(decoded.assets.get(ASSET_MANIFEST_ENTRY))) as AssetManifest;
    const region = manifest.assets.find((asset) => asset.assetId === 'cover.world.region');
    const battle = manifest.assets.find((asset) => asset.assetId === 'cover.battle.cave');
    assert.deepEqual(region?.size, { w: 2048, h: 1536 });
    assert.deepEqual(battle?.size, { w: 1024, h: 768 });
  } finally {
    close();
  }
});

test('pack.assetPut：内置包只读 → conflict；坏图片 → bad-request 且不改包', async () => {
  const { workspace, close } = harness();
  try {
    await expectRoomError(
      () => workspace.assetPut({ packId: BUILTIN_ID, assetId: 'item.x.y', kind: 'item', b64: PNG_B64 }),
      'conflict',
      /内置包.*只读/,
    );
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    const before = workspace.exportPack({ packId: 'test-pack' }).packHash;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');
    await expectRoomError(
      () => workspace.assetPut({ packId: 'test-pack', assetId: 'item.bad.jpeg', kind: 'item', b64: jpeg }),
      'bad-request',
      /归一化失败|JPEG/,
    );
    assert.equal(workspace.exportPack({ packId: 'test-pack' }).packHash, before, '失败不应改动包字节');
  } finally {
    close();
  }
});

test('pack.assetDelete：未被引用 → removed=true 并清理文件/manifest；重复删除幂等 false', async () => {
  const { dir, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    await workspace.assetPut({ packId: 'test-pack', assetId: 'item.test.rock', kind: 'item', b64: PNG_B64 });
    const removed = await workspace.assetDelete({ packId: 'test-pack', assetId: 'item.test.rock' });
    assert.deepEqual(removed, { removed: true });
    const decoded = await readPackFile(join(dir, 'test-pack-1.0.0.trpgpack'));
    assert.equal([...decoded.assets.keys()].filter((path) => path !== ASSET_MANIFEST_ENTRY).length, 0);
    const manifest = JSON.parse(new TextDecoder().decode(decoded.assets.get(ASSET_MANIFEST_ENTRY))) as AssetManifest;
    assert.equal(manifest.assets.length, 0);
    assert.deepEqual(await workspace.assetDelete({ packId: 'test-pack', assetId: 'item.test.rock' }), { removed: false });
    assert.deepEqual(await workspace.assetDelete({ packId: 'test-pack', assetId: 'item.none.here' }), { removed: false });
  } finally {
    close();
  }
});

test('pack.assetDelete：被 pack.json 引用 → conflict（提示先解除引用）；解除后可删', async () => {
  const { dir, workspace, close } = harness();
  try {
    await workspace.update({ packId: 'test-pack', pack: makePack('test-pack', '1.0.0') });
    await workspace.assetPut({ packId: 'test-pack', assetId: 'item.test.rock', kind: 'item', b64: PNG_B64 });
    const decoded = await readPackFile(join(dir, 'test-pack-1.0.0.trpgpack'));
    const assetPath = [...decoded.assets.keys()].find((path) => path !== ASSET_MANIFEST_ENTRY) as string;
    const referenced = makePack('test-pack', '1.0.0');
    referenced.icon = assetPath;
    await workspace.update({ packId: 'test-pack', pack: referenced });
    await expectRoomError(
      () => workspace.assetDelete({ packId: 'test-pack', assetId: 'item.test.rock' }),
      'conflict',
      /仍被 pack\.json 引用.*pack\.icon/s,
    );
    const unreferenced = makePack('test-pack', '1.0.0');
    await workspace.update({ packId: 'test-pack', pack: unreferenced });
    assert.deepEqual(await workspace.assetDelete({ packId: 'test-pack', assetId: 'item.test.rock' }), { removed: true });
  } finally {
    close();
  }
});

test('pack.assetDelete：内置包只读 → conflict', async () => {
  const { workspace, close } = harness();
  try {
    await expectRoomError(
      () => workspace.assetDelete({ packId: BUILTIN_ID, assetId: 'item.x.y' }),
      'conflict',
      /内置包.*只读/,
    );
  } finally {
    close();
  }
});
