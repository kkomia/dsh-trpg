import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASSET_MANIFEST_ENTRY, CORE_GUIMUYA_PACK, CORE_PACKS, type ContentPack } from '@dsh-trpg/content';
import { contentHashOfPack, packToTrpgpack } from '@dsh-trpg/content/pack-zip';
import { PackRegistry, defaultPacksDir } from '../src/host/pack-registry.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-trpg-packs-'));
}

/** 由内置包派生一个合法的新包（换 packId/name/version，内容仍引用同一套 id）。 */
function variantPack(packId: string, version = '1.0.0', name = `测试包·${packId}`): ContentPack {
  return { ...CORE_GUIMUYA_PACK, packId, name, version };
}

function writePack(dir: string, fileName: string, pack: ContentPack): void {
  writeFileSync(join(dir, fileName), packToTrpgpack(pack));
}

test('registry: 内置包可列出/可解析/内容指纹可用，数据目录缺省不存在也不报错', () => {
  const dir = tempDir();
  try {
    const registry = new PackRegistry({ dir: join(dir, 'packs') });
    const loaded = registry.reload();
    assert.equal(loaded.packs, 1, '只有内置包');
    assert.deepEqual(loaded.warnings, []);
    assert.equal(registry.defaultPackId, 'core-guimuya');
    assert.equal(registry.list()[0]?.source, 'builtin');
    assert.equal(registry.get('core-guimuya')?.name, CORE_GUIMUYA_PACK.name);
    assert.equal(registry.hasPack('core-guimuya'), true);
    assert.equal(registry.hasPack('missing'), false);
    assert.equal(registry.contentHashOf('core-guimuya'), contentHashOfPack(CORE_GUIMUYA_PACK));
    assert.equal(registry.contentHashOf('core-guimuya')?.length, 64);
    assert.equal(registry.resolveModule('missing'), undefined);
    assert.equal(registry.resolveModule('core-guimuya', 'missing-module'), undefined);

    const resolved = registry.resolveModule('core-guimuya');
    assert.ok(resolved);
    assert.equal(resolved.moduleId, 'guimuya');
    assert.equal(resolved.packVersion, '1.0.0');
    assert.equal(resolved.moduleTitle, CORE_GUIMUYA_PACK.modules[0]?.title);
    assert.equal(resolved.scenes.length, CORE_GUIMUYA_PACK.modules[0]?.scenes.length);
    assert.deepEqual(Object.keys(resolved.scenes[0] ?? {}).sort(), ['sceneId', 'title'], '场景摘要只含公开字段');

    const legacy = registry.resolveLegacy('core-guimuya');
    assert.ok(legacy);
    assert.equal(legacy.module.scenes.length, CORE_GUIMUYA_PACK.modules[0]?.scenes.length);
    assert.equal(legacy.lorebook.entries.length, CORE_GUIMUYA_PACK.lorebook.entries.length);
    assert.ok(legacy.module.gmNotes, 'host 侧解析仍带 GM 备注（只有 publicCatalog 脱敏）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: 数据目录里的合法 .trpgpack 被收录，reload 发现新增文件', () => {
  const dir = tempDir();
  try {
    writePack(dir, 'dsh-test-pack-1.0.0.trpgpack', variantPack('dsh-test-pack'));
    const registry = new PackRegistry({ dir });
    const loaded = registry.reload();
    assert.equal(loaded.packs, 2);
    assert.equal(registry.get('dsh-test-pack')?.name, '测试包·dsh-test-pack');
    const entry = registry.getEntry('dsh-test-pack');
    assert.equal(entry?.source, 'data');
    assert.ok(entry?.filePath?.endsWith('dsh-test-pack-1.0.0.trpgpack'));
    const resolved = registry.resolveModule('dsh-test-pack');
    assert.equal(resolved?.moduleId, 'guimuya', 'moduleId 缺省取包 defaultModuleId');
    assert.equal(resolved?.packVersion, '1.0.0');

    // 重新可扫：导入新包后 reload 即可见（M8.3 用）
    writePack(dir, 'dsh-second-1.0.0.trpgpack', variantPack('dsh-second'));
    assert.equal(registry.reload().packs, 3);
    assert.equal(registry.hasPack('dsh-second'), true);
    assert.equal(registry.list().filter((item) => item.source === 'data').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: 坏包只记 warning 不崩服务，好包照常加载', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'aaa-broken.trpgpack'), 'not a zip at all');
    writePack(dir, 'bbb-valid.trpgpack', variantPack('dsh-valid'));
    const registry = new PackRegistry({ dir });
    const loaded = registry.reload();
    assert.equal(loaded.packs, 2, '内置包 + 合法数据包');
    assert.equal(registry.hasPack('dsh-valid'), true);
    assert.ok(
      loaded.warnings.some((warning) => warning.includes('aaa-broken.trpgpack')),
      `expected warning for broken pack, got: ${loaded.warnings.join(' | ')}`,
    );
    assert.deepEqual(registry.warnings(), loaded.warnings);
    assert.ok(registry.resolveLegacy('core-guimuya'), '坏包不影响内置包');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: 重复 packId 内置优先、数据目录先加载者优先，并给可读 warning', () => {
  const dir = tempDir();
  try {
    // 与内置包同 packId：数据目录版本必须被忽略
    writePack(dir, 'aaa-core-copy.trpgpack', variantPack('core-guimuya', '9.9.9', '伪造的内置包'));
    // 两个数据包同 packId：按文件名排序先加载者优先
    writePack(dir, 'bbb-dup.trpgpack', variantPack('dsh-dup', '1.0.0', '先加载的数据包'));
    writePack(dir, 'ccc-dup.trpgpack', variantPack('dsh-dup', '2.0.0', '后加载的数据包'));
    const registry = new PackRegistry({ dir });
    const loaded = registry.reload();
    assert.equal(loaded.packs, 2, '内置包 + dsh-dup；core 副本被忽略、两个 dsh-dup 只留一份');
    assert.equal(registry.get('core-guimuya')?.name, CORE_GUIMUYA_PACK.name, '内置包优先');
    assert.equal(registry.getEntry('core-guimuya')?.source, 'builtin');
    assert.equal(registry.contentHashOf('core-guimuya'), contentHashOfPack(CORE_GUIMUYA_PACK));
    assert.equal(registry.get('dsh-dup')?.name, '先加载的数据包', '先加载的文件优先');
    assert.ok(loaded.warnings.some((warning) => warning.includes('与内置包重名')));
    assert.ok(loaded.warnings.some((warning) => warning.includes('重复')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: publicCatalog 是脱敏投影，不含 GM 备注/秘密/遭遇/判定/世界书正文', () => {
  const dir = tempDir();
  try {
    const registry = new PackRegistry({ dir });
    registry.reload();
    const catalog = registry.publicCatalog();
    assert.equal(catalog.length, 1);
    const core = catalog[0];
    assert.ok(core);
    assert.equal(core.packId, 'core-guimuya');
    assert.equal(core.source, 'builtin');
    assert.equal(core.cardCount, CORE_GUIMUYA_PACK.cards.length);
    assert.equal(core.loreCount, CORE_GUIMUYA_PACK.lorebook.entries.length);
    assert.equal(core.defaultModuleId, 'guimuya');
    assert.equal(core.modules.length, 1);
    assert.deepEqual(Object.keys(core.modules[0] ?? {}).sort(), [
      'level',
      'moduleId',
      'playerCount',
      'sceneCount',
      'title',
    ]);
    assert.equal(core.modules[0]?.sceneCount, CORE_GUIMUYA_PACK.modules[0]?.scenes.length);

    const serialized = JSON.stringify(catalog);
    for (const keyword of [
      'gmNotes',
      'secret',
      'encounter',
      'revealWhen',
      'loreIds',
      'checks',
      'rewards',
      'synopsis',
      'npcIds',
      'startSceneId',
      'lorebook',
      'entry_',
      'content',
    ]) {
      assert.ok(!serialized.includes(keyword), `publicCatalog 不应包含敏感字段/内容：${keyword}`);
    }
    // 连模组 GM 备注、秘密正文、世界书正文原文都不能出现
    const module = CORE_GUIMUYA_PACK.modules[0];
    assert.ok(module?.gmNotes && !serialized.includes(module.gmNotes));
    assert.ok(module?.secrets[0]?.content && !serialized.includes(module.secrets[0].content));
    assert.ok(!serialized.includes(CORE_GUIMUYA_PACK.lorebook.entries[0]?.content ?? '###'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: defaultPacksDir 与房间存档同一父目录（profile-data 约定）', () => {
  const dir = defaultPacksDir({ DSH_HOME: 'C:/dsh-home', DSH_PROFILE: 'trpg' } as NodeJS.ProcessEnv);
  assert.ok(dir.includes('dsh-home'));
  assert.ok(dir.includes('trpg'));
  assert.ok(dir.replaceAll('\\', '/').endsWith('dsh-trpg-table/content/packs'));
});

test('registry: 数据目录包的 png/svg 资产被缓存，assetOf 返回字节/sha256/contentType（路径安全）', () => {
  const dir = tempDir();
  const encoder = new TextEncoder();
  const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  try {
    const pack = variantPack('asset-pack');
    pack.icon = 'assets/cover.png';
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    const svg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"></svg>');
    const manifest = {
      schemaVersion: 'trpg.assets/1',
      packId: 'asset-pack',
      assets: [
        {
          assetId: 'cover.core.main',
          file: 'assets/cover.png',
          format: 'png',
          size: { w: 32, h: 32 },
          bytes: png.length,
          sha256: sha256Hex(png),
          kind: 'cover',
          style: 'imported',
          seed: null,
          prompt: null,
          createdAt: '2026-11-16T18:00:00+08:00',
        },
        {
          assetId: 'icon.status.poison',
          file: 'assets/icons/status/poison.svg',
          format: 'svg',
          size: { w: 128, h: 128 },
          bytes: svg.length,
          sha256: sha256Hex(svg),
          kind: 'status',
          style: 'imported',
          seed: null,
          prompt: null,
          createdAt: '2026-11-16T18:00:00+08:00',
        },
      ],
    };
    const assets = new Map<string, Uint8Array>([
      ['assets/cover.png', png],
      ['assets/icons/status/poison.svg', svg],
      [ASSET_MANIFEST_ENTRY, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)],
    ]);
    writeFileSync(join(dir, 'asset-pack-1.0.0.trpgpack'), packToTrpgpack(pack, { assets }));

    const registry = new PackRegistry({ dir });
    assert.equal(registry.reload().packs, 2, '内置包 + 带资产的数据包');

    const cover = registry.assetOf('asset-pack', 'cover.png');
    assert.ok(cover);
    assert.equal(cover.path, 'assets/cover.png');
    assert.equal(cover.contentType, 'image/png');
    assert.equal(cover.sha256, sha256Hex(png));
    assert.deepEqual([...cover.bytes], [...png]);

    const status = registry.assetOf('asset-pack', 'icons/status/poison.svg');
    assert.equal(status?.contentType, 'image/svg+xml');
    assert.equal(status?.sha256, sha256Hex(svg));

    // 清单本身不是图片资产；路径穿越/绝对路径/反斜杠/空段一律拒绝
    assert.equal(registry.assetOf('asset-pack', 'manifest.json'), undefined);
    for (const assetPath of ['../cover.png', '/cover.png', '', 'icons//status/poison.svg', 'icons\\x.png', '.']) {
      assert.equal(registry.assetOf('asset-pack', assetPath), undefined, `应拒绝：${JSON.stringify(assetPath)}`);
    }
    assert.equal(registry.assetOf('missing-pack', 'cover.png'), undefined);
    assert.equal(registry.assetOf('core-guimuya', 'cover.png'), undefined, '内置包没有字节资产（随代码编译）');

    // reload 重扫后缓存随包消失
    rmSync(join(dir, 'asset-pack-1.0.0.trpgpack'));
    assert.equal(registry.reload().packs, 1);
    assert.equal(registry.assetOf('asset-pack', 'cover.png'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
