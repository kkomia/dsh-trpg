/**
 * M9.5d 协议层：`assets.generate` / `assets.upload` / `seat.characterAssets` 参数校验，
 * M9.5d DTO 扩展（SheetView.identity 媒体字段 / CombatTokenView.avatarUrl / RoomView.assets）。
 *
 * 只锁协议契约与中文错误；生图/落盘行为在 host 的 media-service / room-assets 测试里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARACTER_ASSET_KINDS,
  MEDIA_ASSET_KINDS,
  MEDIA_ASSET_STYLES,
  ROOM_ASSET_LIMITS,
  isRpcMethod,
  validateAssetsGenerate,
  validateAssetsUpload,
  validateCharacterAssetRefs,
  validateRpcRequest,
  type AssetsGenerateResult,
  type AssetsUploadResult,
  type CombatTokenView,
  type RoomAssetView,
  type RoomView,
  type SheetView,
} from '../src/index.ts';

function errorOf(result: { ok: boolean; error?: string }): string {
  assert.equal(result.ok, false, '预期校验失败');
  return result.error ?? '';
}

// ---------------------------------------------------------------------------
// 方法表 / 请求信封
// ---------------------------------------------------------------------------

test('RPC：assets.generate / assets.upload 进入方法表，信封校验放行', () => {
  assert.equal(isRpcMethod('assets.generate'), true);
  assert.equal(isRpcMethod('assets.upload'), true);
  assert.equal(isRpcMethod('assets.import'), false, '作者侧工坊方法不在 v1 房间 RPC 里');

  for (const method of ['assets.generate', 'assets.upload'] as const) {
    const parsed = validateRpcRequest({ method, params: {}, token: 't' });
    assert.equal(parsed.ok, true, `${method} 应被接受`);
  }
  assert.equal(validateRpcRequest({ method: 'nope.method' }).ok, false);
});

// ---------------------------------------------------------------------------
// assets.generate
// ---------------------------------------------------------------------------

test('assets.generate：白名单 kind/style + 可选 subject/seed/count(1–4)', () => {
  assert.deepEqual(
    validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: '青衫少年' }).value,
    { kind: 'avatar', style: 'game-2d', prompt: '青衫少年' },
  );
  const full = validateAssetsGenerate({
    kind: 'sprite',
    style: 'pixel-32',
    prompt: '走路帧',
    subject: '阿青',
    seed: 12345,
    count: 4,
  });
  assert.equal(full.ok, true);
  assert.equal(full.value?.count, 4);
  assert.equal(full.value?.seed, 12345);
  assert.deepEqual(MEDIA_ASSET_KINDS, ['avatar', 'portrait', 'icon', 'sprite']);
  assert.deepEqual(MEDIA_ASSET_STYLES, ['pixel-32', 'game-2d', 'svg']);
});

test('assets.generate：非法 kind/style/prompt/seed/count → 可读中文错误', () => {
  assert.equal(validateAssetsGenerate(undefined).ok, false);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'cover', style: 'game-2d', prompt: 'x' })), /kind 必须是 avatar \/ portrait \/ icon \/ sprite/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: '2d-illustration', prompt: 'x' })), /style 必须是 pixel-32 \/ game-2d \/ svg/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: '   ' })), /prompt 不能为空/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x'.repeat(2001) })), /prompt 过长/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x', subject: 'x'.repeat(101) })), /subject 过长/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x', seed: -1 })), /seed/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x', seed: 1.5 })), /seed/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x', count: 0 })), /count 必须是 1–4/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x', count: 5 })), /count 必须是 1–4/);
  assert.match(errorOf(validateAssetsGenerate({ kind: 'avatar', style: 'game-2d', prompt: 'x', count: 2.5 })), /count 必须是 1–4/);
});

// ---------------------------------------------------------------------------
// assets.upload
// ---------------------------------------------------------------------------

test('assets.upload：合法白名单资产（含变体/帧表 meta）通过', () => {
  const result = validateAssetsUpload({
    assets: [
      { kind: 'avatar', b64: 'AAA=' },
      { kind: 'portraitVariant', variant: 'idle', b64: 'BBB=' },
      { kind: 'spriteSheet', b64: 'CCC=', meta: { rows: 4, cols: 4, frameSize: 128 } },
    ],
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value?.assets.length, 3);
  assert.equal(result.value?.assets[1]?.variant, 'idle');
  assert.deepEqual(CHARACTER_ASSET_KINDS, ['avatar', 'portrait', 'portraitVariant', 'spriteSheet', 'icon']);
  assert.equal(ROOM_ASSET_LIMITS.maxFiles, 8);
  assert.equal(ROOM_ASSET_LIMITS.maxBytes, 8 * 1024 * 1024);
});

test('assets.upload：非法 kind / 变体缺名 / meta 非法 / 帧表缺 meta → 中文错误', () => {
  assert.match(errorOf(validateAssetsUpload({})), /缺少 assets 数组/);
  assert.match(errorOf(validateAssetsUpload({ assets: [] })), /至少上传 1 个资产/);
  assert.match(errorOf(validateAssetsUpload({ assets: [{ kind: 'cover', b64: 'AAA=' }] })), /kind 必须是 avatar/);
  assert.match(errorOf(validateAssetsUpload({ assets: [{ kind: 'avatar', b64: '' }] })), /b64 不能为空/);
  assert.match(errorOf(validateAssetsUpload({ assets: [{ kind: 'portraitVariant', b64: 'AAA=' }] })), /必须带 variant 名/);
  assert.match(errorOf(validateAssetsUpload({ assets: [{ kind: 'avatar', b64: 'AAA=', variant: 'x y' }] })), /variant 非法/);
  assert.match(errorOf(validateAssetsUpload({ assets: [{ kind: 'spriteSheet', b64: 'AAA=' }] })), /必须带 meta/);
  assert.match(
    errorOf(validateAssetsUpload({ assets: [{ kind: 'spriteSheet', b64: 'AAA=', meta: { rows: 9 } }] })),
    /meta.rows 必须是 1–8/,
  );
  assert.match(
    errorOf(validateAssetsUpload({ assets: [{ kind: 'spriteSheet', b64: 'AAA=', meta: { frameSize: 8 } }] })),
    /frameSize 必须是 16–256/,
  );
});

test('assets.upload：单次 ≤8 个文件 / ≤8 MiB（按 base64 近似字节，中文错误）', () => {
  const nine = Array.from({ length: 9 }, () => ({ kind: 'avatar', b64: 'AAA=' }));
  assert.match(errorOf(validateAssetsUpload({ assets: nine })), /单次最多上传 8 个资产/);

  // 两条各约 4.5MB（base64 长 6,000,000）→ 合计约 9MB > 8MiB
  const chunk = 'A'.repeat(6_000_000);
  const oversized = { assets: [{ kind: 'portrait', b64: chunk }, { kind: 'portrait', b64: chunk }] };
  assert.match(errorOf(validateAssetsUpload(oversized)), /上传资产总量超限/);
});

// ---------------------------------------------------------------------------
// seat.characterAssets
// ---------------------------------------------------------------------------

test('seat.characterAssets：合法引用（kind/variant/sha256/url/meta）通过；undefined = 无资产', () => {
  assert.deepEqual(validateCharacterAssetRefs(undefined).value, []);
  assert.deepEqual(validateCharacterAssetRefs(null).value, []);
  const sha = 'a'.repeat(64);
  const result = validateCharacterAssetRefs([
    { kind: 'avatar', sha256: sha, url: '/trpg/room-assets/room-1/' + sha + '.png' },
    { kind: 'portraitVariant', variant: 'smile', sha256: sha },
    { kind: 'spriteSheet', sha256: sha, meta: { rows: 4, cols: 4, frameSize: 128 } },
  ]);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.value?.length, 3);
  assert.equal(result.value?.[1]?.variant, 'smile');
  assert.deepEqual(result.value?.[2]?.meta, { rows: 4, cols: 4, frameSize: 128 });
});

test('seat.characterAssets：坏 sha / 越权 url / 重复 kind+variant → 中文错误', () => {
  const sha = 'a'.repeat(64);
  assert.match(errorOf(validateCharacterAssetRefs('avatar')), /必须是数组/);
  assert.match(errorOf(validateCharacterAssetRefs([{ kind: 'cover', sha256: sha }])), /kind 必须是 avatar/);
  assert.match(errorOf(validateCharacterAssetRefs([{ kind: 'avatar', sha256: sha.toUpperCase() }])), /64 位小写十六进制/);
  assert.match(errorOf(validateCharacterAssetRefs([{ kind: 'avatar', sha256: sha.slice(0, 32) }])), /64 位小写十六进制/);
  assert.match(errorOf(validateCharacterAssetRefs([{ kind: 'portraitVariant', sha256: sha }])), /必须带 variant 名/);
  assert.match(
    errorOf(validateCharacterAssetRefs([{ kind: 'avatar', sha256: sha, url: 'https://evil.example.com/a.png' }])),
    /\/trpg\/room-assets\/ 下的相对路径/,
  );
  assert.match(
    errorOf(validateCharacterAssetRefs([{ kind: 'avatar', sha256: sha, url: '/trpg/room-assets/room-1/../x.png' }])),
    /\/trpg\/room-assets\/ 下的相对路径/,
  );
  assert.match(
    errorOf(validateCharacterAssetRefs([{ kind: 'avatar', sha256: sha, url: '//evil/x.png' }])),
    /\/trpg\/room-assets\/ 下的相对路径/,
  );
  assert.match(
    errorOf(
      validateCharacterAssetRefs([
        { kind: 'avatar', sha256: sha },
        { kind: 'avatar', sha256: sha },
      ]),
    ),
    /同一 kind\/variant 只能有一条引用/,
  );
  const nine = Array.from({ length: 9 }, () => ({ kind: 'avatar' as const, sha256: sha }));
  assert.match(errorOf(validateCharacterAssetRefs(nine)), /最多 8 个文件/);
});

// ---------------------------------------------------------------------------
// DTO 扩展（形状契约；客户端照此实现）
// ---------------------------------------------------------------------------

test('DTO：SheetView.identity 媒体字段 / CombatTokenView.avatarUrl / RoomView.assets 可选扩展', () => {
  const mediaIdentity: SheetView['identity'] = {
    name: '阿青',
    level: 1,
    avatarUrl: '/trpg/room-assets/r/a.png',
    portraitUrl: '/trpg/room-assets/r/p.png',
    portraitVariants: [{ variant: 'smile', url: '/trpg/room-assets/r/s.png' }],
    spriteSheet: { url: '/trpg/room-assets/r/sheet.png', rows: 4, cols: 4, frameSize: 128 },
  };
  assert.equal(mediaIdentity.portraitVariants?.[0]?.variant, 'smile');
  const token: CombatTokenView = { actorId: 'a1', name: '阿青', team: 'player', dead: false, active: true, avatarUrl: '/x.png' };
  assert.equal(token.avatarUrl, '/x.png');
  const asset: RoomAssetView = {
    assetId: 'a'.repeat(64),
    kind: 'portrait',
    sha256: 'a'.repeat(64),
    url: '/trpg/room-assets/r/' + 'a'.repeat(64) + '.png',
    ownerId: 'p1',
  };
  const room: RoomView = {
    roomId: 'r',
    title: 't',
    phase: 'lobby',
    gmMode: 'ai',
    locked: false,
    players: [],
    createdAt: 1,
    assets: [asset],
  };
  assert.equal(room.assets?.length, 1);
  const generated: AssetsGenerateResult = {
    candidates: [
      { b64: 'AAA=', format: 'png', width: 256, height: 256, sha256: 'b'.repeat(64), prompt: 'p', style: 'game-2d' },
    ],
    provider: 'fake',
  };
  assert.equal(generated.candidates[0]?.width, 256);
  const uploaded: AssetsUploadResult = {
    assets: [
      {
        assetId: 'b'.repeat(64),
        kind: 'avatar',
        sha256: 'b'.repeat(64),
        url: '/trpg/room-assets/r/' + 'b'.repeat(64) + '.png',
        width: 256,
        height: 256,
        bytes: 1024,
      },
    ],
  };
  assert.equal(uploaded.assets[0]?.kind, 'avatar');
});
