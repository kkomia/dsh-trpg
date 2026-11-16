/**
 * M9.5e 协议层：地图/世界生成 + 内容包工坊 8 个 RPC 的方法表、参数校验与常量契约。
 *
 * 只锁协议契约与中文错误；结构校验/生成/落盘行为在 host 的 map-generator / pack-workspace /
 * studio-rpc 测试里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTLE_STRUCTURE_LIMITS,
  BATTLE_TERRAIN_CHARS,
  BATTLE_TERRAIN_LEGEND,
  MAP_GENERATE_STYLES,
  PACK_ASSET_KINDS,
  PACK_ASSET_TARGETS,
  PACK_IMPORT_STRATEGIES,
  PACK_WORKSHOP_LIMITS,
  WORLD_GENERATE_STYLES,
  WORLD_STRUCTURE_LIMITS,
  isRpcMethod,
  isWorldZoneId,
  validateMapGenerate,
  validatePackAssetDelete,
  validatePackAssetPut,
  validatePackDetail,
  validatePackExport,
  validatePackImport,
  validatePackUpdate,
  validateRpcRequest,
  validateWorldGenerate,
} from '../src/index.ts';

function errorOf(result: { ok: boolean; error?: string }): string {
  assert.equal(result.ok, false, '预期校验失败');
  return result.error ?? '';
}

// ---------------------------------------------------------------------------
// 方法表 / 信封
// ---------------------------------------------------------------------------

test('RPC：M9.5e 工坊 8 个方法进入方法表，信封校验放行', () => {
  const methods = [
    'map.generate',
    'world.generate',
    'pack.detail',
    'pack.update',
    'pack.export',
    'pack.import',
    'pack.assetPut',
    'pack.assetDelete',
  ] as const;
  for (const method of methods) {
    assert.equal(isRpcMethod(method), true, `${method} 应进入方法表`);
    assert.equal(validateRpcRequest({ method, params: {}, token: 't' }).ok, true, `${method} 信封应放行`);
  }
  assert.equal(isRpcMethod('pack.delete'), false);
  assert.equal(validateRpcRequest({ method: 'map.generate', params: [] }).ok, false, 'params 必须是对象');
});

test('常量：地形图例/上下限/工坊上限与契约一致', () => {
  assert.deepEqual(BATTLE_TERRAIN_CHARS.sort(), ['#', '+', '.', 'r', 't', 'w', '~', 'g'].sort());
  for (const char of BATTLE_TERRAIN_CHARS) {
    const spec = BATTLE_TERRAIN_LEGEND[char];
    assert.ok(spec, `图例缺 ${char}`);
    assert.ok(spec.id.length > 0);
    assert.equal(typeof spec.walkable, 'boolean');
    assert.ok(spec.moveCost >= 0);
  }
  assert.equal(BATTLE_TERRAIN_LEGEND.w?.walkable, false);
  assert.equal(BATTLE_TERRAIN_LEGEND.g?.walkable, true);
  assert.equal(BATTLE_TERRAIN_LEGEND.r?.moveCost, 2);
  assert.equal(BATTLE_STRUCTURE_LIMITS.maxCols, 32);
  assert.equal(BATTLE_STRUCTURE_LIMITS.maxRows, 32);
  assert.equal(BATTLE_STRUCTURE_LIMITS.maxSpawns, 20);
  assert.deepEqual(WORLD_STRUCTURE_LIMITS.minZones, 3);
  assert.deepEqual(WORLD_STRUCTURE_LIMITS.maxZones, 8);
  assert.deepEqual([...MAP_GENERATE_STYLES], ['topdown-2d', 'pixel-topdown']);
  assert.deepEqual([...WORLD_GENERATE_STYLES], ['2d-illustration']);
  assert.deepEqual([...PACK_IMPORT_STRATEGIES], ['reject', 'overwrite', 'rename']);
  assert.ok(PACK_WORKSHOP_LIMITS.maxBase64Bytes < 10 * 1024 * 1024, 'RPC 体 12 MiB 内要留余量');
  assert.equal(PACK_ASSET_KINDS.includes('cover'), true);
  assert.equal(PACK_ASSET_TARGETS.includes('battle-map'), true);
  assert.equal(PACK_ASSET_TARGETS.includes('world-map'), true);
});

// ---------------------------------------------------------------------------
// map.generate
// ---------------------------------------------------------------------------

test('map.generate：合法参数通过（最小 / 完整）', () => {
  assert.deepEqual(validateMapGenerate({ prompt: '洞口遭遇', style: 'topdown-2d' }).value, {
    prompt: '洞口遭遇',
    style: 'topdown-2d',
  });
  const full = validateMapGenerate({
    prompt: '洞口遭遇',
    style: 'pixel-topdown',
    cols: 16,
    rows: 10,
    partySize: 4,
    seed: 42,
    withBackground: true,
  });
  assert.equal(full.ok, true);
  assert.equal(full.value?.withBackground, true);
  assert.equal(full.value?.seed, 42);
});

test('map.generate：style / prompt / 尺寸 / 队伍 / seed 非法一律中文报错', () => {
  assert.match(errorOf(validateMapGenerate({ prompt: '', style: 'topdown-2d' })), /prompt/);
  assert.match(errorOf(validateMapGenerate({ prompt: 'x', style: 'isometric' })), /style/);
  assert.match(errorOf(validateMapGenerate({ prompt: 'x', style: 'topdown-2d', cols: 3 })), /cols/);
  assert.match(errorOf(validateMapGenerate({ prompt: 'x', style: 'topdown-2d', cols: 33 })), /cols/);
  assert.match(errorOf(validateMapGenerate({ prompt: 'x', style: 'topdown-2d', rows: 0 })), /rows/);
  assert.match(errorOf(validateMapGenerate({ prompt: 'x', style: 'topdown-2d', partySize: 9 })), /partySize/);
  assert.match(errorOf(validateMapGenerate({ prompt: 'x', style: 'topdown-2d', seed: -1 })), /seed/);
  assert.match(
    errorOf(validateMapGenerate({ prompt: 'x', style: 'topdown-2d', withBackground: 'yes' })),
    /withBackground/,
  );
});

// ---------------------------------------------------------------------------
// world.generate
// ---------------------------------------------------------------------------

test('world.generate：合法参数通过；zoneCount 3..8 / style / seed 校验', () => {
  assert.equal(validateWorldGenerate({ prompt: '青石镇周边' }).ok, true);
  assert.equal(validateWorldGenerate({ prompt: '青石镇周边', zoneCount: 3, style: '2d-illustration', seed: 1 }).ok, true);
  assert.match(errorOf(validateWorldGenerate({ prompt: 'x', zoneCount: 2 })), /zoneCount/);
  assert.match(errorOf(validateWorldGenerate({ prompt: 'x', zoneCount: 9 })), /zoneCount/);
  assert.match(errorOf(validateWorldGenerate({ prompt: 'x', style: 'pixel-topdown' })), /style/);
  assert.match(errorOf(validateWorldGenerate({ prompt: '' })), /prompt/);
  assert.match(errorOf(validateWorldGenerate({ prompt: 'x', seed: 2 ** 31 })), /seed/);
});

// ---------------------------------------------------------------------------
// 内容包工坊参数
// ---------------------------------------------------------------------------

test('pack.detail / pack.export：packId 必须小写 slug', () => {
  assert.equal(validatePackDetail({ packId: 'core-guimuya' }).ok, true);
  assert.equal(validatePackExport({ packId: 'my_pack-2' }).ok, true);
  for (const bad of ['', 'Core-Guimuya', '../evil', 'a'.repeat(65), 'has space']) {
    assert.match(errorOf(validatePackDetail({ packId: bad })), /packId/, `应拒绝 ${JSON.stringify(bad)}`);
    assert.match(errorOf(validatePackExport({ packId: bad })), /packId/);
  }
  assert.match(errorOf(validatePackDetail({})), /packId/);
});

test('pack.update：pack 必须是对象且 packId 与参数一致', () => {
  const pack = { schemaVersion: 'trpg.pack/1', packId: 'my-pack', name: 'X', version: '1.0.0' };
  assert.equal(validatePackUpdate({ packId: 'my-pack', pack }).ok, true);
  assert.match(errorOf(validatePackUpdate({ packId: 'my-pack', pack: [] })), /pack 必须是对象/);
  assert.match(
    errorOf(validatePackUpdate({ packId: 'my-pack', pack: { ...pack, packId: 'other' } })),
    /pack\.packId 必须与参数 packId 一致/,
  );
  assert.match(errorOf(validatePackUpdate({ packId: 'BAD', pack })), /packId/);
});

test('pack.import：b64 / fileName / strategy 校验', () => {
  const b64 = Buffer.from('PK fake').toString('base64');
  assert.equal(validatePackImport({ b64, strategy: 'reject' }).ok, true);
  assert.equal(validatePackImport({ b64, strategy: 'overwrite', fileName: 'a.trpgpack' }).ok, true);
  assert.match(errorOf(validatePackImport({ b64: '', strategy: 'reject' })), /b64/);
  assert.match(errorOf(validatePackImport({ b64, strategy: 'merge' })), /strategy/);
  assert.match(errorOf(validatePackImport({ b64, strategy: 'rename', fileName: 3 })), /fileName/);
  const huge = `${'A'.repeat(Math.ceil(PACK_WORKSHOP_LIMITS.maxBase64Bytes * 4 / 3) + 1024)}====`;
  assert.match(errorOf(validatePackImport({ b64: huge, strategy: 'reject' })), /导入包过大/);
});

test('pack.assetPut：assetId/kind/meta 校验；pack.assetDelete 幂等参数校验', () => {
  const b64 = Buffer.from('fake').toString('base64');
  const base = { packId: 'my-pack', assetId: 'item.weapon.hengdao', kind: 'item', b64 };
  assert.equal(validatePackAssetPut(base).ok, true);
  assert.equal(validatePackAssetPut({ ...base, meta: { target: 'battle-map', style: 'imported', seed: 3 } }).ok, true);
  assert.match(errorOf(validatePackAssetPut({ ...base, assetId: 'nodots' })), /assetId/);
  assert.match(errorOf(validatePackAssetPut({ ...base, assetId: '../evil.asset' })), /assetId/);
  assert.match(errorOf(validatePackAssetPut({ ...base, kind: 'map' })), /kind/);
  assert.match(errorOf(validatePackAssetPut({ ...base, meta: { target: 'huge-map' } })), /meta\.target/);
  assert.match(errorOf(validatePackAssetPut({ ...base, meta: { rows: 9 } })), /meta\.rows/);
  assert.match(errorOf(validatePackAssetPut({ ...base, b64: '' })), /b64/);
  assert.equal(validatePackAssetDelete({ packId: 'my-pack', assetId: 'item.x.y' }).ok, true);
  assert.match(errorOf(validatePackAssetDelete({ packId: 'my-pack', assetId: 'bad' })), /assetId/);
});

test('isWorldZoneId：允许中文与 . -，拒绝空格/斜杠/超长', () => {
  assert.equal(isWorldZoneId('qingshi_gate'), true);
  assert.equal(isWorldZoneId('青石镇-1'), true);
  assert.equal(isWorldZoneId('zone.1'), true);
  assert.equal(isWorldZoneId('bad zone'), false);
  assert.equal(isWorldZoneId('a/b'), false);
  assert.equal(isWorldZoneId(''), false);
  assert.equal(isWorldZoneId('a'.repeat(65)), false);
  assert.equal(isWorldZoneId(7), false);
});
