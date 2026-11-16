import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSET_MANIFEST_ENTRY,
  ASSET_MANIFEST_LIMITS,
  ASSET_MANIFEST_SCHEMA_VERSION,
  collectPackAssetReferences,
  isSafeAssetId,
  verifyPackAssetManifest,
  type AssetEntry,
  type AssetFormat,
  type AssetManifest,
} from '../src/asset-manifest.ts';
import { CORE_GUIMUYA_PACK, validatePack, type ContentPack } from '../src/index.ts';
import { sha256Hex } from '../src/sha256.ts';
import { packToTrpgpack, trpgpackToPack } from '../src/pack-zip.ts';
import { readPackJsonFile, writePackJsonFile } from '../src/pack-io.ts';
import { DND5E_LITE_SCRIPT_SOURCES } from '../src/rules-pack/index.ts';

const SCRIPTS = new Map(DND5E_LITE_SCRIPT_SOURCES.map((source) => [source.file, source.code]));
const encoder = new TextEncoder();

function clonePack(): ContentPack {
  return JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
}

interface AssetFixture {
  assetId: string;
  file: string;
  format: AssetFormat;
  kind?: AssetEntry['kind'];
  bytes: Uint8Array;
  /** 覆盖清单里的 bytes（造不符用）。 */
  declaredBytes?: number;
  /** 覆盖清单里的 sha256（造不符用）。 */
  declaredSha256?: string;
  size?: { w: number; h: number };
}

function fixture(
  assetId: string,
  file: string,
  format: AssetFormat,
  content = `bytes-of-${assetId}`,
): AssetFixture {
  return { assetId, file, format, bytes: encoder.encode(content) };
}

function entryOf(item: AssetFixture): AssetEntry {
  const sha256 = sha256Hex(item.bytes);
  return {
    assetId: item.assetId,
    file: item.file,
    format: item.format,
    size: item.size ?? (item.format === 'svg' ? { w: 128, h: 128 } : { w: 32, h: 32 }),
    bytes: item.declaredBytes ?? item.bytes.length,
    sha256: item.declaredSha256 ?? sha256,
    kind: item.kind ?? (item.format === 'svg' ? 'status' : 'item'),
    style: 'imported',
    seed: null,
    prompt: null,
    createdAt: '2026-11-16T18:00:00+08:00',
  };
}

function manifestOf(items: readonly AssetFixture[], packId = 'core-guimuya'): AssetManifest {
  return { schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION, packId, assets: items.map(entryOf) };
}

/** 素材包：清单 + 每个资产的实际字节（zip 内路径 → 字节）。 */
function assetsOf(items: readonly AssetFixture[], text?: string): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const item of items) assets.set(item.file, item.bytes);
  assets.set(ASSET_MANIFEST_ENTRY, encoder.encode(text ?? manifestText(manifestOf(items))));
  return assets;
}

function manifestText(manifest: AssetManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** 三个资产 + 三处引用：pack.icon（文件）、items[].icon（assetId）、ui.itemCategories[].icon（短 id）。 */
function coverageFixtures(): AssetFixture[] {
  return [
    fixture('cover.core.main', 'assets/cover.png', 'png', 'cover-bytes'),
    fixture('icon.item.hengdao', 'assets/icons/item/hengdao.png', 'png'),
    fixture('icon.status.poison', 'assets/icons/status/poison.svg', 'svg'),
  ];
}

function packWithReferences(): ContentPack {
  const pack = clonePack();
  pack.icon = 'assets/cover.png';
  const rules = pack.rules;
  assert.ok(rules, '内置包应带规则段');
  assert.ok(rules.items && rules.items.length > 0, '内置规则包应有 items[]');
  rules.items[0]!.icon = 'icon.item.hengdao';
  assert.ok(rules.ui?.itemCategories && rules.ui.itemCategories.length > 0);
  rules.ui.itemCategories[0]!.icon = 'status/poison';
  return pack;
}

function errorText(report: { errors: Array<{ message: string }> }): string {
  return report.errors.map((item) => item.message).join('\n');
}

test('asset-manifest: 完整清单（file/bytes/sha256/三处引用）校验通过，无孤立告警', () => {
  const fixtures = coverageFixtures();
  const assets = assetsOf(fixtures);
  const report = validatePack(packWithReferences(), { assets });
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.deepEqual(report.warnings, [], '三个资产都被引用，不应有孤立告警');

  const verified = verifyPackAssetManifest({ manifest: assets.get(ASSET_MANIFEST_ENTRY)!, pack: packWithReferences(), contents: assets });
  assert.equal(verified.ok, true, errorText(verified));
  assert.equal(verified.entries.size, 3);
  assert.deepEqual([...verified.entries.keys()].sort(), [
    'cover.core.main',
    'icon.item.hengdao',
    'icon.status.poison',
  ]);
});

test('asset-manifest: 清单不存在时行为与 M8.1 一致（不产出清单告警）', () => {
  const pack = clonePack();
  pack.icon = 'assets/cover.svg';
  const report = validatePack(pack, { assetPaths: ['assets/cover.svg'] });
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.deepEqual(report.warnings, []);

  const orphan = validatePack(pack, { assetPaths: ['assets/cover.svg', 'assets/extra.svg'] });
  assert.equal(orphan.ok, true);
  assert.match(orphan.warnings.join('\n'), /孤立素材/);
});

test('asset-manifest: schemaVersion 非法 / assets 缺失 → error', () => {
  const wrongSchema = verifyPackAssetManifest({
    manifest: JSON.stringify({ schemaVersion: 'trpg.assets/0', assets: [] }),
  });
  assert.equal(wrongSchema.ok, false);
  assert.match(errorText(wrongSchema), /schemaVersion 必须是 "trpg\.assets\/1"/);

  const missing = verifyPackAssetManifest({ manifest: JSON.stringify({ schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION }) });
  assert.equal(missing.ok, false);
  assert.match(errorText(missing), /缺少 assets 数组/);
});

test('asset-manifest: assetId 非法 / 重复 / 数量超限 → error', () => {
  const base = fixture('icon.item.a', 'assets/icons/item/a.png', 'png');
  const unsafe = entryOf({ ...base, assetId: 'icon/item/a' });
  const dup = entryOf(fixture('icon.item.a', 'assets/icons/item/b.png', 'png', 'other'));
  const cases: Array<{ name: string; assets: AssetEntry[]; expected: RegExp }> = [
    { name: '路径不安全', assets: [unsafe], expected: /assetId 非法或路径不安全/ },
    { name: '重复', assets: [entryOf(base), dup], expected: /assetId 重复/ },
  ];
  for (const { name, assets, expected } of cases) {
    const result = verifyPackAssetManifest({
      manifest: manifestText({ schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION, assets }),
    });
    assert.equal(result.ok, false, name);
    assert.match(errorText(result), expected, name);
  }

  const tooMany = Array.from({ length: ASSET_MANIFEST_LIMITS.maxAssets + 1 }, (_, index) =>
    entryOf(fixture(`icon.item.a${index}`, `assets/icons/item/a${index}.png`, 'png')),
  );
  const result = verifyPackAssetManifest({
    manifest: manifestText({ schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION, assets: tooMany }),
  });
  assert.equal(result.ok, false);
  assert.match(errorText(result), /超过单包上限 512/);
});

test('asset-manifest: file 必须存在、路径安全、扩展名与 format 一致', () => {
  const fixtureA = fixture('icon.item.a', 'assets/icons/item/a.png', 'png');
  const assets = assetsOf([fixtureA]);
  const check = (manifest: AssetManifest, files: Iterable<string>, contents?: Map<string, Uint8Array>) =>
    verifyPackAssetManifest({
      manifest: manifestText(manifest),
      files,
      ...(contents !== undefined ? { contents } : {}),
    });

  const present = check(manifestOf([fixtureA]), [...assets.keys()]);
  assert.equal(present.ok, true, errorText(present));

  const missing = check(manifestOf([fixtureA]), [ASSET_MANIFEST_ENTRY]);
  assert.equal(missing.ok, false);
  assert.match(errorText(missing), /file 在包内不存在：assets\/icons\/item\/a\.png/);

  const traversal = verifyPackAssetManifest({
    manifest: manifestText(manifestOf([{ ...fixtureA, file: 'assets/../evil.png' }])),
  });
  assert.equal(traversal.ok, false);
  assert.match(errorText(traversal), /含路径穿越/);

  const wrongFormat = verifyPackAssetManifest({
    manifest: manifestText(manifestOf([{ ...fixtureA, file: 'assets/icons/item/a.svg' }])),
  });
  assert.equal(wrongFormat.ok, false);
  assert.match(errorText(wrongFormat), /扩展名与 format=png 不一致/);
});

test('asset-manifest: bytes / sha256 与实际文件不符 → error（传字节才校验）', () => {
  const fixtureA = fixture('icon.item.a', 'assets/icons/item/a.png', 'png');
  const assets = assetsOf([fixtureA]);

  const byteMismatch = verifyPackAssetManifest({
    manifest: manifestText(manifestOf([{ ...fixtureA, declaredBytes: fixtureA.bytes.length + 3 }])),
    contents: assets,
  });
  assert.equal(byteMismatch.ok, false);
  assert.match(errorText(byteMismatch), /bytes 与实际文件不符/);

  const shaMismatch = verifyPackAssetManifest({
    manifest: manifestText(manifestOf([{ ...fixtureA, declaredSha256: 'a'.repeat(64) }])),
    contents: assets,
  });
  assert.equal(shaMismatch.ok, false);
  assert.match(errorText(shaMismatch), /sha256 与实际文件不符/);

  // 只有路径（没读字节）→ 跳过 sha256/bytes 实检，不误报
  const pathOnly = verifyPackAssetManifest({
    manifest: manifestText(manifestOf([{ ...fixtureA, declaredSha256: 'a'.repeat(64) }])),
    files: [...assets.keys()],
  });
  assert.equal(pathOnly.ok, true, errorText(pathOnly));
});

test('asset-manifest: pack.json 引用的 assetId 不存在 → error（items/ui）', () => {
  const fixtures = coverageFixtures();
  const assets = assetsOf(fixtures);

  const missingItem = packWithReferences();
  missingItem.rules!.items![0]!.icon = 'icon.item.missing';
  const itemReport = validatePack(missingItem, { assets });
  assert.equal(itemReport.ok, false);
  assert.match(itemReport.errors.join('\n'), /引用的资产不存在：icon\.item\.missing（来源 pack\.rules\.items\[0\]\.icon）/);

  const missingUi = packWithReferences();
  missingUi.rules!.ui!.itemCategories![0]!.icon = 'icon.status.missing';
  const uiReport = validatePack(missingUi, { assets });
  assert.equal(uiReport.ok, false);
  assert.match(uiReport.errors.join('\n'), /引用的资产不存在：icon\.status\.missing（来源 pack\.rules\.ui\.itemCategories\[0\]\.icon）/);

  const missingCover = packWithReferences();
  missingCover.icon = 'assets/missing.png';
  const coverReport = validatePack(missingCover, { assets });
  assert.equal(coverReport.ok, false);
  assert.match(coverReport.errors.join('\n'), /引用的资产文件不在资产清单中：assets\/missing\.png（来源 pack\.icon）|icon 引用的素材不存在/);
});

test('asset-manifest: 短 id 命中约定路径 assets/icons/<短 id> 视为引用，未命中只 warning', () => {
  const fixtures = coverageFixtures();
  const hit = validatePack(packWithReferences(), { assets: assetsOf(fixtures) });
  assert.equal(hit.ok, true, hit.errors.join('\n'));
  assert.equal(hit.warnings.length, 0, '短 id 命中文件应计入引用，不产生孤立告警');

  const noFile = clonePack();
  noFile.rules!.items![0]!.icon = 'action/attack-melee';
  const assetsWithoutShortId = assetsOf([
    fixture('cover.core.main', 'assets/cover.png', 'png'),
  ]);
  // cover 未被引用 → 孤立资产 warning；短 id 无文件 → warning，二者都不阻断
  const report = validatePack(noFile, { assets: assetsWithoutShortId });
  assert.equal(report.ok, true, report.errors.join('\n'));
  const text = report.warnings.join('\n');
  assert.match(text, /短 id 图标没有对应资产文件/);
  assert.match(text, /孤立资产（pack\.json 未引用，不阻断）：cover\.core\.main/);
  assert.ok(!text.includes('孤立素材'), '有清单时不再按逐文件口径报孤立素材');
});

test('asset-manifest: 清单 packId 与 pack.json 不一致 → error', () => {
  const fixtures = coverageFixtures();
  const manifest = manifestOf(fixtures, 'another-pack');
  const assets = assetsOf(fixtures, manifestText(manifest));
  const report = validatePack(packWithReferences(), { assets });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /packId "another-pack" 与 pack\.json 的 packId "core-guimuya" 不一致/);
});

test('asset-manifest: JSON 语法 / UTF-8 / BOM 处理', () => {
  const broken = verifyPackAssetManifest({ manifest: '{ not json' });
  assert.equal(broken.ok, false);
  assert.match(errorText(broken), /不是合法 JSON/);

  const nonUtf8 = verifyPackAssetManifest({ manifest: new Uint8Array([0xff, 0xfe, 0xfd]) });
  assert.equal(nonUtf8.ok, false);
  assert.match(errorText(nonUtf8), /不是合法的 UTF-8 文本/);

  const text = `\uFEFF${JSON.stringify({ schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION, assets: [] })}`;
  const withBom = verifyPackAssetManifest({ manifest: text });
  assert.equal(withBom.ok, true, errorText(withBom));

  const notRecord = verifyPackAssetManifest({ manifest: '[]' });
  assert.equal(notRecord.ok, false);
  assert.match(errorText(notRecord), /顶层必须是 JSON 对象/);
});

test('asset-manifest: .trpgpack 导出/导入往返（清单随包、sha256 漂移被拒）', () => {
  const pack = packWithReferences();
  const fixtures = coverageFixtures();
  const assets = assetsOf(fixtures);
  const bytes = packToTrpgpack(pack, { assets, scripts: SCRIPTS });
  const decoded = trpgpackToPack(bytes);
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.ok(decoded.assets.has(ASSET_MANIFEST_ENTRY), '清单应作为 zip 条目随包解出');
  assert.equal(decoded.warnings.length, 0, decoded.warnings.join('\n'));

  const reencoded = packToTrpgpack(decoded.pack!, { assets: decoded.assets, scripts: decoded.scripts });
  assert.equal(Buffer.compare(Buffer.from(reencoded), Buffer.from(bytes)), 0, '带清单的包应可字节复现');

  // 清单 sha256 与实际素材字节不符 → 导出即被拒
  const badManifest = manifestOf([{ ...fixtures[0]!, declaredSha256: 'b'.repeat(64) }, ...fixtures.slice(1)]);
  const badAssets = assetsOf([fixtures[0]!, ...fixtures.slice(1)], manifestText(badManifest));
  assert.throws(
    () => packToTrpgpack(pack, { assets: badAssets, scripts: SCRIPTS }),
    (error: unknown) =>
      error instanceof Error && error.message.includes('sha256 与实际文件不符'),
  );
});

test('asset-manifest: 源码目录读取（loadAssets 关闭时只校验结构与存在性，开启时校验 sha256）', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-trpg-manifest-'));
  try {
    const pack = packWithReferences();
    const fixtures = coverageFixtures();
    const assets = assetsOf(fixtures);
    await writePackJsonFile(workDir, pack, { assets, scripts: SCRIPTS });

    const light = await readPackJsonFile(join(workDir, 'pack.json'));
    assert.equal(light.ok, true, light.errors.join('\n'));
    assert.ok(light.assetPaths.includes(ASSET_MANIFEST_ENTRY));

    // 篡改一个资产文件：轻读（不读字节）看不到，重读（loadAssets）要报 sha256 不符
    await writeFile(join(workDir, 'assets', 'icons', 'item', 'hengdao.png'), encoder.encode('tampered'));
    const lightAgain = await readPackJsonFile(join(workDir, 'pack.json'));
    assert.equal(lightAgain.ok, true, lightAgain.errors.join('\n'));
    const heavy = await readPackJsonFile(join(workDir, 'pack.json'), { loadAssets: true });
    assert.equal(heavy.ok, false);
    assert.match(heavy.errors.join('\n'), /sha256 与实际文件不符/);

    // 删除清单里声明的文件 → 两种情况都要报（存在性校验不依赖字节）
    await rm(join(workDir, 'assets', 'icons', 'status', 'poison.svg'));
    const missingFile = await readPackJsonFile(join(workDir, 'pack.json'));
    assert.equal(missingFile.ok, false);
    assert.match(missingFile.errors.join('\n'), /file 在包内不存在/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('asset-manifest: collectPackAssetReferences 只收 items/ui/icon 三处，isSafeAssetId 判定与 assets 包一致', () => {
  const pack = packWithReferences();
  const references = collectPackAssetReferences(pack);
  const sources = references.map((reference) => reference.source).sort();
  assert.deepEqual(sources, [
    'pack.icon',
    'pack.rules.items[0].icon',
    'pack.rules.ui.itemCategories[0].icon',
  ]);
  assert.deepEqual(references.map((reference) => reference.value).sort(), [
    'assets/cover.png',
    'icon.item.hengdao',
    'status/poison',
  ]);
  assert.equal(collectPackAssetReferences(undefined).length, 0);

  for (const assetId of ['item.weapons.hengdao', 'icon.item.a_1', 'a.b']) {
    assert.equal(isSafeAssetId(assetId), true, assetId);
  }
  for (const assetId of ['icon/item/a', '..', 'icon..a', 'icon.a.', '.icon.a', 'icon.a/b', '']) {
    assert.equal(isSafeAssetId(assetId), false, assetId);
  }
});
