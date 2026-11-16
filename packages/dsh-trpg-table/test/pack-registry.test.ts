import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_GUIMUYA_PACK, CORE_PACKS, type ContentPack } from '@dsh-trpg/content';
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
