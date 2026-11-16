/**
 * `trpg.assets/1` 清单测试：唯一性/路径安全/sha/上限/引用完整性，读写序列化与合并。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_LIMITS,
  ASSET_MANIFEST_FILE,
  ASSET_SCHEMA_VERSION,
  buildAssetEntry,
  checkAssetFilePath,
  createManifest,
  findAsset,
  isSafeAssetId,
  mergeManifests,
  parseManifest,
  readManifest,
  removeAssets,
  stringifyManifest,
  validateManifest,
  type AssetEntry,
  type AssetManifest,
} from '../src/index.ts';
import { sha256Hex } from '../src/index.ts';

const SHA = 'a'.repeat(64);

function makeEntry(overrides: Partial<AssetEntry> = {}): AssetEntry {
  const assetId = overrides.assetId ?? 'item.weapons.hengdao';
  const base: AssetEntry = {
    assetId,
    file: `assets/icons/item/${assetId.split('.').pop()}.png`,
    format: 'png',
    size: { w: 32, h: 32 },
    bytes: 100,
    sha256: SHA,
    kind: 'item',
    style: 'pixel-32',
    seed: null,
    prompt: null,
    createdAt: '2026-11-16T18:00:00+08:00',
  };
  return { ...base, ...overrides };
}

function makeManifest(assets: AssetEntry[], packId = 'core-guimuya'): AssetManifest {
  return { schemaVersion: ASSET_SCHEMA_VERSION, packId, assets };
}

function issueText(result: ReturnType<typeof validateManifest>): string {
  return result.errors.map((issue) => `${issue.code}:${issue.message}`).join(' | ');
}

function expectError(
  result: ReturnType<typeof validateManifest>,
  code: string,
  messagePart?: string,
): void {
  assert.equal(result.ok, false, `应校验失败，实际通过（warnings: ${JSON.stringify(result.warnings)}）`);
  assert.ok(
    result.errors.some((issue) => issue.code === code),
    `应包含错误码 ${code}，实际：${issueText(result)}`,
  );
  if (messagePart !== undefined) {
    assert.ok(
      result.errors.some((issue) => issue.message.includes(messagePart)),
      `错误信息应包含「${messagePart}」，实际：${issueText(result)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 合法清单
// ---------------------------------------------------------------------------

test('manifest：合法清单通过（含 provenance）', () => {
  const manifest = makeManifest([
    makeEntry({
      assetId: 'item.weapons.hengdao',
      style: 'game-2d',
      seed: 1234,
      prompt: '一把家传旧刀',
      provenance: { source: 'ai-image', model: 'sd-xl', createdAt: '2026-11-16T18:00:00+08:00' },
    }),
    makeEntry({
      assetId: 'avatar.hero.aqing',
      file: 'assets/icons/avatar/aqing.png',
      kind: 'avatar',
      format: 'png',
      size: { w: 256, h: 256 },
      bytes: 2048,
      style: 'imported',
    }),
  ]);
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, issueText(result));
  assert.deepEqual(result.errors, []);
});

test('manifest：空资产清单合法（无资产可缺 manifest）', () => {
  const result = validateManifest(createManifest('core-guimuya'));
  assert.equal(result.ok, true, issueText(result));
});

// ---------------------------------------------------------------------------
// 唯一性 / 路径安全
// ---------------------------------------------------------------------------

test('manifest：重复 assetId 拒绝', () => {
  const entry = makeEntry();
  expectError(
    validateManifest(makeManifest([entry, { ...entry }])),
    'asset-id-duplicate',
    '唯一',
  );
});

test('manifest：assetId 路径穿越/非法字符拒绝（逐个样本）', () => {
  const badIds = ['../evil', 'a/b.icon', 'a\\b.icon', 'a..b', 'a', '.a.icon', '', 'a'.repeat(200)];
  for (const assetId of badIds) {
    const result = validateManifest(makeManifest([makeEntry({ assetId })]));
    assert.equal(result.ok, false, `assetId「${assetId}」应被拒绝`);
    assert.ok(
      result.errors.some((issue) => issue.code === 'asset-id'),
      `assetId「${assetId}」错误码不符`,
    );
  }
});

test('manifest：assetId 合法样例通过（isSafeAssetId）', () => {
  assert.equal(isSafeAssetId('item.weapons.hengdao'), true);
  assert.equal(isSafeAssetId('status.poison.main'), true);
  assert.equal(isSafeAssetId('../x'), false);
  assert.equal(isSafeAssetId('a/b'), false);
  assert.equal(isSafeAssetId('a..b'), false);
  assert.equal(isSafeAssetId('nodot'), false);
  assert.equal(isSafeAssetId(''), false);
});

test('manifest：file 路径穿越拒绝', () => {
  expectError(
    validateManifest(makeManifest([makeEntry({ file: 'assets/../secret.png' })])),
    'asset-file',
    '穿越',
  );
});

test('manifest：file 非法路径（绝对/反斜杠/非 assets 前缀/URL 字符）逐个拒绝', () => {
  const badFiles = [
    '/assets/icons/x.png',
    'assets\\icons\\x.png',
    'icons/x.png',
    'assets//x.png',
    'assets/icons/x.png?v=1',
    'assets/icons/x.gif',
    ASSET_MANIFEST_FILE,
  ];
  for (const file of badFiles) {
    const result = validateManifest(makeManifest([makeEntry({ file })]));
    assert.equal(result.ok, false, `file「${file}」应被拒绝`);
    assert.ok(
      result.errors.some((issue) => issue.code === 'asset-file'),
      `file「${file}」错误码不符：${issueText(result)}`,
    );
  }
});

test('manifest：file 扩展名与 format 不一致拒绝', () => {
  expectError(
    validateManifest(makeManifest([makeEntry({ file: 'assets/icons/item/x.png', format: 'svg' })])),
    'asset-file',
    '不一致',
  );
});

test('manifest：checkAssetFilePath 边界（正常路径通过）', () => {
  assert.deepEqual(checkAssetFilePath('assets/icons/item/hengdao.svg', 'svg'), { ok: true });
  assert.equal(checkAssetFilePath('assets/icons/zh_1.svg', 'svg').ok, true);
  // 扩展名不区分大小写的宽松写法不接受（归一化产物统一小写）
  assert.equal(checkAssetFilePath('assets/icons/x.PNG', 'png').ok, false);
});

// ---------------------------------------------------------------------------
// 字段校验
// ---------------------------------------------------------------------------

test('manifest：坏 sha256（大写/长度/非十六进制）拒绝', () => {
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'z'.repeat(64), '']) {
    const result = validateManifest(makeManifest([makeEntry({ sha256 })]));
    assert.equal(result.ok, false, `sha256「${sha256}」应被拒绝`);
    assert.ok(result.errors.some((issue) => issue.code === 'asset-sha256'));
  }
});

test('manifest：非法 kind / format / style 拒绝', () => {
  expectError(
    validateManifest(makeManifest([makeEntry({ kind: 'weapon' as never })])),
    'asset-kind',
  );
  expectError(
    validateManifest(makeManifest([makeEntry({ format: 'jpeg' as never })])),
    'asset-format',
  );
  expectError(
    validateManifest(makeManifest([makeEntry({ style: '含空格的风格' as never })])),
    'asset-style',
  );
});

test('manifest：非法 size（0/负数/非整数）拒绝', () => {
  for (const size of [{ w: 0, h: 32 }, { w: 32, h: -1 }, { w: 32.5, h: 32 }]) {
    expectError(validateManifest(makeManifest([makeEntry({ size })])), 'asset-size');
  }
});

test('manifest：非法 seed / prompt / createdAt 拒绝', () => {
  expectError(validateManifest(makeManifest([makeEntry({ seed: -1 })])), 'asset-seed');
  expectError(validateManifest(makeManifest([makeEntry({ seed: 1.5 })])), 'asset-seed');
  expectError(
    validateManifest(
      makeManifest([makeEntry({ prompt: 'x'.repeat(ASSET_LIMITS.maxPromptLength + 1) })]),
    ),
    'asset-prompt',
  );
  expectError(
    validateManifest(makeManifest([makeEntry({ createdAt: '昨天' })])),
    'asset-created-at',
  );
});

test('manifest：schemaVersion / assets 结构错误拒绝', () => {
  expectError(
    validateManifest({ schemaVersion: 'trpg.assets/2', assets: [] }),
    'manifest-schema',
  );
  expectError(validateManifest({ schemaVersion: ASSET_SCHEMA_VERSION }), 'manifest-assets');
  expectError(validateManifest('not-an-object'), 'manifest-shape');
});

test('manifest：单资产 bytes 超过 8 MiB 上限拒绝', () => {
  expectError(
    validateManifest(makeManifest([makeEntry({ bytes: ASSET_LIMITS.maxAssetBytes + 1 })])),
    'asset-bytes',
  );
});

// ---------------------------------------------------------------------------
// 上限：数量 / 总量
// ---------------------------------------------------------------------------

test('manifest：资产数量超过 512 拒绝', () => {
  const assets: AssetEntry[] = [];
  for (let index = 0; index < ASSET_LIMITS.maxAssets + 1; index += 1) {
    assets.push(
      makeEntry({
        assetId: `item.scope.asset${index}`,
        file: `assets/icons/item/asset${index}.png`,
      }),
    );
  }
  expectError(validateManifest(makeManifest(assets)), 'manifest-count', '512');
});

test('manifest：总量超过 64 MiB 拒绝', () => {
  const assets: AssetEntry[] = [];
  for (let index = 0; index < 9; index += 1) {
    assets.push(
      makeEntry({
        assetId: `item.scope.big${index}`,
        file: `assets/icons/item/big${index}.png`,
        bytes: ASSET_LIMITS.maxAssetBytes,
      }),
    );
  }
  expectError(validateManifest(makeManifest(assets)), 'manifest-total-bytes', '64 MiB');
});

// ---------------------------------------------------------------------------
// 引用完整性 / 实检
// ---------------------------------------------------------------------------

test('manifest：被引用的 assetId 不存在 → error', () => {
  const result = validateManifest(makeManifest([makeEntry()]), {
    referenced: [{ assetId: 'item.weapons.missing', source: 'rules.items[3].icon' }],
  });
  expectError(result, 'asset-reference-missing', 'item.weapons.missing');
  assert.ok(result.errors.some((issue) => issue.message.includes('rules.items[3].icon')));
});

test('manifest：有资产但无人引用 → 孤立资产 warning', () => {
  const result = validateManifest(makeManifest([makeEntry()]), { referenced: [] });
  assert.equal(result.ok, true, issueText(result));
  assert.ok(result.warnings.some((issue) => issue.code === 'asset-orphan'));
});

test('manifest：files 实检缺失文件 → error', () => {
  const result = validateManifest(makeManifest([makeEntry()]), {
    files: ['assets/icons/other.png'],
  });
  expectError(result, 'asset-file-missing');
});

test('manifest：contents 实检 bytes / sha256 不符 → error', () => {
  const bytes = new TextEncoder().encode('hello asset');
  const entry = makeEntry({
    file: 'assets/icons/item/hengdao.png',
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
  });
  const ok = validateManifest(makeManifest([entry]), {
    contents: new Map([['assets/icons/item/hengdao.png', bytes]]),
  });
  assert.equal(ok.ok, true, issueText(ok));

  const wrongBytes = makeEntry({ ...entry, bytes: bytes.length + 1 });
  expectError(
    validateManifest(makeManifest([wrongBytes]), {
      contents: new Map([['assets/icons/item/hengdao.png', bytes]]),
    }),
    'asset-bytes-mismatch',
  );

  const wrongSha = makeEntry({ ...entry, sha256: 'b'.repeat(64) });
  expectError(
    validateManifest(makeManifest([wrongSha]), {
      contents: new Map([['assets/icons/item/hengdao.png', bytes]]),
    }),
    'asset-sha256-mismatch',
  );
});

test('manifest：多个资产复用同一 file → warning', () => {
  const result = validateManifest(
    makeManifest([
      makeEntry({ assetId: 'item.scope.a', file: 'assets/icons/item/shared.png' }),
      makeEntry({ assetId: 'item.scope.b', file: 'assets/icons/item/shared.png' }),
    ]),
  );
  assert.equal(result.ok, true, issueText(result));
  assert.ok(result.warnings.some((issue) => issue.code === 'asset-file-duplicate'));
});

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

test('manifest：parseManifest 解析合法 JSON 文本', () => {
  const text = JSON.stringify(makeManifest([makeEntry()]));
  const result = parseManifest(text);
  assert.equal(result.ok, true);
  assert.equal(result.manifest!.assets.length, 1);
});

test('manifest：parseManifest 非法 JSON / 非法结构给中文错误', () => {
  const badJson = parseManifest('{ not json');
  assert.equal(badJson.ok, false);
  assert.ok(badJson.errors[0]!.message.includes('不是合法 JSON'));

  const badShape = parseManifest(JSON.stringify({ schemaVersion: 'trpg.assets/2', assets: [] }));
  assert.equal(badShape.ok, false);
  assert.ok(badShape.errors.some((issue) => issue.code === 'manifest-schema'));
});

test('manifest：stringifyManifest 资产按 assetId 排序且同输入同字节', () => {
  const manifest = makeManifest([
    makeEntry({ assetId: 'item.scope.z', file: 'assets/icons/item/z.png' }),
    makeEntry({ assetId: 'item.scope.a', file: 'assets/icons/item/a.png' }),
  ]);
  const first = stringifyManifest(manifest);
  const second = stringifyManifest(manifest);
  assert.equal(first, second);
  const parsed = JSON.parse(first) as { assets: AssetEntry[] };
  assert.deepEqual(parsed.assets.map((asset) => asset.assetId), [
    'item.scope.a',
    'item.scope.z',
  ]);
  assert.ok(first.endsWith('\n'));
});

test('manifest：字符串化 → parse 往返一致（字段与默认值）', () => {
  const manifest = makeManifest([makeEntry({ seed: 7, prompt: '刀' })]);
  const parsed = parseManifest(stringifyManifest(manifest));
  assert.equal(parsed.ok, true);
  const entry = parsed.manifest!.assets[0]!;
  assert.equal(entry.seed, 7);
  assert.equal(entry.prompt, '刀');
  assert.deepEqual(entry.size, { w: 32, h: 32 });
});

test('manifest：readManifest / writeManifest 为 parse/stringify 语义别名', () => {
  const manifest = makeManifest([makeEntry()]);
  assert.equal(typeof readManifest, 'function');
  const text = stringifyManifest(manifest);
  assert.equal(parseManifest(text).ok, true);
});

// ---------------------------------------------------------------------------
// 构造 / 合并 / 删除
// ---------------------------------------------------------------------------

test('manifest：buildAssetEntry 构造合法条目 / 拒绝坏 sha', () => {
  const ok = buildAssetEntry({
    assetId: 'item.scope.new',
    file: 'assets/icons/item/new.png',
    format: 'png',
    width: 32,
    height: 32,
    bytes: 120,
    sha256: SHA,
    kind: 'item',
    style: 'pixel-32',
    createdAt: '2026-11-16T18:00:00+08:00',
  });
  assert.equal(ok.ok, true, ok.errors.map((issue) => issue.message).join(' | '));
  assert.equal(ok.entry!.seed, null);
  assert.equal(ok.entry!.prompt, null);

  const bad = buildAssetEntry({
    assetId: 'item.scope.new',
    file: 'assets/icons/item/new.png',
    format: 'png',
    width: 32,
    height: 32,
    bytes: 120,
    sha256: 'bad',
    kind: 'item',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((issue) => issue.code === 'asset-sha256'));
});

test('manifest：mergeManifests 新增（added）', () => {
  const base = makeManifest([makeEntry({ assetId: 'item.scope.a' })]);
  const incoming = makeManifest([makeEntry({ assetId: 'item.scope.b', file: 'assets/icons/item/b.png' })]);
  const result = mergeManifests(base, incoming);
  assert.equal(result.ok, true, issueText({ errors: result.errors, warnings: result.warnings, ok: result.ok }));
  assert.deepEqual(result.added, ['item.scope.b']);
  assert.equal(result.manifest.assets.length, 2);
  assert.equal(result.manifest.packId, 'core-guimuya');
});

test('manifest：mergeManifests 同 assetId 替换（replace）', () => {
  const base = makeManifest([makeEntry({ bytes: 100 })]);
  const incoming = makeManifest([makeEntry({ bytes: 200, sha256: 'c'.repeat(64) })]);
  const result = mergeManifests(base, incoming);
  assert.equal(result.ok, true);
  assert.deepEqual(result.replaced, ['item.weapons.hengdao']);
  const merged = findAsset(result.manifest, 'item.weapons.hengdao')!;
  assert.equal(merged.bytes, 200);
  assert.equal(merged.sha256, 'c'.repeat(64));
});

test('manifest：mergeManifests skip / error 策略', () => {
  const base = makeManifest([makeEntry({ bytes: 100 })]);
  const incoming = makeManifest([makeEntry({ bytes: 200 })]);
  const skipped = mergeManifests(base, incoming, { strategy: 'skip' });
  assert.equal(skipped.ok, true);
  assert.deepEqual(skipped.skipped, ['item.weapons.hengdao']);
  assert.equal(findAsset(skipped.manifest, 'item.weapons.hengdao')!.bytes, 100);

  const errored = mergeManifests(base, incoming, { strategy: 'error' });
  assert.equal(errored.ok, false);
  assert.ok(errored.errors.some((issue) => issue.code === 'merge-duplicate'));
});

test('manifest：mergeManifests packId 冲突拒绝', () => {
  const base = makeManifest([makeEntry()]);
  const incoming = makeManifest([makeEntry({ assetId: 'item.scope.other' })], 'another-pack');
  const result = mergeManifests(base, incoming);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.code === 'merge-pack-id'));
});

test('manifest：mergeManifests 合并后总量超限被整体校验拦下', () => {
  const base = makeManifest([
    makeEntry({ assetId: 'item.scope.a', bytes: ASSET_LIMITS.maxAssetBytes }),
  ]);
  const incoming: AssetEntry[] = [];
  for (let index = 0; index < 8; index += 1) {
    incoming.push(
      makeEntry({
        assetId: `item.scope.big${index}`,
        file: `assets/icons/item/big${index}.png`,
        bytes: ASSET_LIMITS.maxAssetBytes,
      }),
    );
  }
  const result = mergeManifests(base, incoming);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((issue) => issue.code === 'manifest-total-bytes'));
});

test('manifest：removeAssets 删除并返回缺失列表', () => {
  const manifest = makeManifest([
    makeEntry({ assetId: 'item.scope.a' }),
    makeEntry({ assetId: 'item.scope.b', file: 'assets/icons/item/b.png' }),
  ]);
  const result = removeAssets(manifest, ['item.scope.a', 'item.scope.missing']);
  assert.deepEqual(result.removed, ['item.scope.a']);
  assert.deepEqual(result.missing, ['item.scope.missing']);
  assert.deepEqual(result.manifest.assets.map((asset) => asset.assetId), ['item.scope.b']);
});

test('manifest：findAsset 命中/未命中', () => {
  const manifest = makeManifest([makeEntry()]);
  assert.equal(findAsset(manifest, 'item.weapons.hengdao')!.assetId, 'item.weapons.hengdao');
  assert.equal(findAsset(manifest, 'item.nope.x'), undefined);
});
