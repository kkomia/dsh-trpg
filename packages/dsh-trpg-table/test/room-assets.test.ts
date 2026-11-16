/**
 * M9.5d 房间资产存储（RoomAssetStore）：落盘/去重/索引/限额/尺寸强制/路径安全/续团保留。
 *
 * 全部离线：PNG 用 `@dsh-trpg/assets` 的确定性编码器现场生成，不读外部文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '../../assets/src/index.ts';
import { RoomAssetStore, defaultRoomAssetsDir } from '../src/host/media/index.ts';
import { defaultRoomsDir } from '../src/host/persistence.ts';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 确定性 PNG（渐变图案，任意尺寸）。 */
function pngOf(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = index % 256;
    rgba[index * 4 + 1] = (index * 7) % 256;
    rgba[index * 4 + 2] = (index * 13) % 256;
    rgba[index * 4 + 3] = 255;
  }
  return encodePng({ width, height, rgba });
}

/** 伪随机 PNG（不可压，用于体积上限用例）。 */
function noisePngOf(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  let state = 0x12345678;
  for (let index = 0; index < rgba.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    rgba[index] = state & 0xff;
  }
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 255;
  return encodePng({ width, height, rgba });
}

const AVATAR_PNG = pngOf(256, 256);
const PORTRAIT_PNG = pngOf(768, 1024);
const ICON_PNG = pngOf(128, 128);
const PIXEL_ICON_PNG = pngOf(32, 32);
const SPRITE_PNG = pngOf(512, 512);
const SVG_TEXT =
  '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="8" y="8" width="112" height="112" fill="#2f6f4e"/></svg>';

function b64(bytes: Uint8Array | string): string {
  return Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64');
}

interface StoreFixture {
  store: RoomAssetStore;
  dir: string;
  roomId: string;
}

function makeStore(roomId = 'room-0001'): StoreFixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-room-assets-'));
  return { store: new RoomAssetStore({ dir }), dir, roomId };
}

function cleanup(fixture: StoreFixture): void {
  rmSync(fixture.dir, { recursive: true, force: true });
}

test('RoomAssetStore: 上传头像 → 内容寻址落盘（sha256.png）+ 索引 + 只读 URL', () => {
  const fixture = makeStore();
  try {
    const result = fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(AVATAR_PNG) }]);
    assert.equal(result.assets.length, 1);
    const asset = result.assets[0]!;
    const expectedSha = sha256(AVATAR_PNG);
    assert.equal(asset.sha256, expectedSha);
    assert.equal(asset.assetId, expectedSha);
    assert.equal(asset.kind, 'avatar');
    assert.equal(asset.width, 256);
    assert.equal(asset.height, 256);
    assert.equal(asset.bytes, AVATAR_PNG.length);
    assert.equal(asset.url, `/trpg/room-assets/${fixture.roomId}/${expectedSha}.png`);
    const file = join(fixture.dir, fixture.roomId, `${expectedSha}.png`);
    assert.equal(existsSync(file), true, '落盘到 <dir>/<roomId>/<sha256>.<ext>');
    assert.equal(existsSync(join(fixture.dir, fixture.roomId, 'index.json')), true);

    const read = fixture.store.read(fixture.roomId, expectedSha, 'png');
    assert.ok(read);
    assert.equal(read.sha256, expectedSha);
    assert.equal(read.contentType, 'image/png');
    assert.deepEqual([...read.bytes], [...AVATAR_PNG]);
    assert.equal(readdirSync(join(fixture.dir, fixture.roomId)).filter((name) => name.endsWith('.tmp')).length, 0, '不残留临时文件');

    const listed = fixture.store.listRoom(fixture.roomId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ownerId, 'p1');
    assert.equal(listed[0]?.url, asset.url);
    assert.equal(fixture.store.listRoom('room-unknown').length, 0, '不存在的房间返回空列表');
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 同内容去重（同房已有同 sha256 只登记引用、不重复写文件）', () => {
  const fixture = makeStore();
  try {
    const first = fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(AVATAR_PNG) }]);
    const second = fixture.store.store(fixture.roomId, 'p2', [{ kind: 'avatar', b64: b64(AVATAR_PNG) }]);
    assert.equal(first.assets[0]?.url, second.assets[0]?.url);
    assert.equal(fixture.store.listRoom(fixture.roomId).length, 1, '同内容只登记一条');
    const pngFiles = readdirSync(join(fixture.dir, fixture.roomId)).filter((name) => name.endsWith('.png'));
    assert.equal(pngFiles.length, 1);
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 单次超过 8 个文件 → conflict + 可读中文错误', () => {
  const fixture = makeStore();
  try {
    const items = Array.from({ length: 9 }, () => ({ kind: 'avatar' as const, b64: b64(AVATAR_PNG) }));
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', items),
      /最多上传 8 个资产/,
    );
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 总字节超过 8 MiB → conflict + 中文错误（8 张 768×1024 噪点立绘）', () => {
  const fixture = makeStore();
  try {
    const noise = noisePngOf(768, 1024); // ~3.1MB / 张 → 8 张约 25MB（尺寸校验前先拦总量）
    const items = Array.from({ length: 8 }, () => ({ kind: 'portrait' as const, b64: b64(noise) }));
    assert.throws(() => fixture.store.store(fixture.roomId, 'p1', items), /上传资产总量超限/);
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 尺寸强制（头像 256 / 立绘 768×1024 / 图标 128·32 / 帧表网格）→ 中文错误', () => {
  const fixture = makeStore();
  try {
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(pngOf(64, 64)) }]),
      /256×256 的头像/,
    );
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'portrait', b64: b64(AVATAR_PNG) }]),
      /768×1024 的立绘/,
    );
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'portraitVariant', b64: b64(PORTRAIT_PNG) }]),
      /必须带 variant/,
    );
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'icon', b64: b64(pngOf(64, 64)) }]),
      /128×128 或 32×32/,
    );
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'spriteSheet', b64: b64(SPRITE_PNG) }]),
      /必须提供 meta/,
    );
    assert.throws(
      () =>
        fixture.store.store(fixture.roomId, 'p1', [
          { kind: 'spriteSheet', b64: b64(SPRITE_PNG), meta: { rows: 4, cols: 4, frameSize: 64 } },
        ]),
      /帧表尺寸与网格不符/,
    );
    // 正确配置：变体 + 图标两档 + 帧表
    const ok = fixture.store.store(fixture.roomId, 'p1', [
      { kind: 'portraitVariant', variant: 'idle', b64: b64(PORTRAIT_PNG) },
      { kind: 'icon', b64: b64(ICON_PNG) },
      { kind: 'icon', b64: b64(PIXEL_ICON_PNG) },
      { kind: 'spriteSheet', b64: b64(SPRITE_PNG), meta: { rows: 4, cols: 4, frameSize: 128 } },
    ]);
    assert.deepEqual(ok.assets.map((asset) => asset.kind), ['portraitVariant', 'icon', 'icon', 'spriteSheet']);
    assert.equal(ok.assets[0]?.variant, 'idle');
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 非法 base64 / 非 PNG/SVG 字节 → bad-request 中文错误', () => {
  const fixture = makeStore();
  try {
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: '***not-base64***' }]),
      /不是合法 Base64/,
    );
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(jpeg) }]),
      /只收 PNG \/ SVG/,
    );
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64('hello world') }]),
      /只收 PNG \/ SVG/,
    );
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: SVG 只允许 icon，且必须通过白名单净化（script/外链被拒）', () => {
  const fixture = makeStore();
  try {
    const stored = fixture.store.store(fixture.roomId, 'p1', [{ kind: 'icon', b64: b64(SVG_TEXT) }]);
    const sha = stored.assets[0]?.sha256;
    assert.ok(sha);
    const read = fixture.store.read(fixture.roomId, sha, 'svg');
    assert.ok(read);
    assert.equal(read.contentType, 'image/svg+xml');
    const sanitized = Buffer.from(read.bytes).toString('utf8');
    assert.match(sanitized, /<svg[^>]*viewBox="0 0 128 128"/);
    assert.equal(stored.assets[0]?.url, `/trpg/room-assets/${fixture.roomId}/${sha}.svg`);

    assert.throws(
      () =>
        fixture.store.store(fixture.roomId, 'p1', [
          { kind: 'avatar', b64: b64(SVG_TEXT) },
        ]),
      /SVG 只支持 icon/,
    );
    const malicious = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><script>alert(1)</script></svg>';
    assert.throws(
      () => fixture.store.store(fixture.roomId, 'p1', [{ kind: 'icon', b64: b64(malicious) }]),
      /未通过白名单净化/,
    );
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 读取路径安全（穿越 roomId / 非法 sha / 扩展名不符 / 未登记 → undefined）', () => {
  const fixture = makeStore();
  try {
    const sha = sha256(AVATAR_PNG);
    fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(AVATAR_PNG) }]);
    for (const [roomId, fileSha, ext] of [
      ['../etc', sha, 'png'],
      ['room-0001/../../etc', sha, 'png'],
      ['..', sha, 'png'],
      ['', sha, 'png'],
      [fixture.roomId, sha.toUpperCase(), 'png'],
      [fixture.roomId, sha.slice(0, 63), 'png'],
      [fixture.roomId, sha, 'jpg'],
      [fixture.roomId, '0'.repeat(64), 'png'],
    ] as const) {
      assert.equal(fixture.store.read(roomId, fileSha, ext), undefined, `${roomId}/${fileSha}.${ext} 必须读不到`);
    }
    assert.ok(fixture.store.read(fixture.roomId, sha, 'png'));
    // roomId 非法时 urlOf / listRoom 也不拼路径
    assert.equal(fixture.store.urlOf('../../evil', sha), undefined);
    assert.deepEqual(fixture.store.listRoom('../../evil'), []);
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 落座引用规范化（已知 sha 换 host URL + 帧表补 meta；未知 sha / 客户端 url 丢弃）', () => {
  const fixture = makeStore();
  try {
    const avatar = fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(AVATAR_PNG) }]);
    const sprite = fixture.store.store(fixture.roomId, 'p1', [
      { kind: 'spriteSheet', b64: b64(SPRITE_PNG), meta: { rows: 4, cols: 4, frameSize: 128 } },
    ]);
    const avatarSha = avatar.assets[0]!.sha256;
    const spriteSha = sprite.assets[0]!.sha256;
    const refs = fixture.store.canonicalizeRefs(fixture.roomId, [
      { kind: 'avatar', sha256: avatarSha, url: 'https://evil.example.com/x.png' },
      { kind: 'portrait', sha256: '0'.repeat(64) },
      { kind: 'spriteSheet', sha256: spriteSha },
    ]);
    assert.equal(refs.length, 2, '未知 sha 丢弃');
    assert.deepEqual(refs[0], {
      kind: 'avatar',
      sha256: avatarSha,
      url: `/trpg/room-assets/${fixture.roomId}/${avatarSha}.png`,
    }, '客户端传的 url 不采信，host 重算');
    assert.equal(refs[1]?.kind, 'spriteSheet');
    assert.deepEqual(refs[1]?.meta, { rows: 4, cols: 4, frameSize: 128 }, '帧表 meta 由 host 存储补全');
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: 上传限流（默认 10 次/分钟；可配；不同玩家/房间独立）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-room-assets-'));
  try {
    const store = new RoomAssetStore({ dir, uploadRateLimit: { max: 2, windowMs: 60_000 } });
    const item = { kind: 'avatar' as const, b64: b64(AVATAR_PNG) };
    store.store('room-0001', 'p1', [item]);
    store.store('room-0001', 'p1', [item]);
    assert.throws(() => store.store('room-0001', 'p1', [item]), /上传太频繁/);
    // 别的玩家 / 别的房间各自独立计数
    store.store('room-0001', 'p2', [item]);
    store.store('room-0002', 'p1', [item]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RoomAssetStore: 续团保留（新实例读索引；房间关闭不删文件）', () => {
  const scope = makeStore();
  try {
    const stored = scope.store.store(scope.roomId, 'p1', [
      { kind: 'avatar', b64: b64(AVATAR_PNG) },
      { kind: 'portrait', b64: b64(PORTRAIT_PNG) },
    ]);
    const avatarSha = stored.assets[0]!.sha256;
    // 模拟 host 重启：同目录新实例
    const restarted = new RoomAssetStore({ dir: scope.dir });
    assert.equal(restarted.listRoom(scope.roomId).length, 2);
    assert.ok(restarted.read(scope.roomId, avatarSha, 'png'));
    // 关闭房间没有删除接口：文件与索引都还在
    assert.equal(existsSync(join(scope.dir, scope.roomId, 'index.json')), true);
    assert.equal(readdirSync(join(scope.dir, scope.roomId)).filter((name) => name.endsWith('.png')).length, 2);
  } finally {
    cleanup(scope);
  }
});

test('RoomAssetStore: 索引损坏/缺文件时优雅降级（不崩、读不到返回 undefined）', () => {
  const fixture = makeStore();
  try {
    const stored = fixture.store.store(fixture.roomId, 'p1', [{ kind: 'avatar', b64: b64(AVATAR_PNG) }]);
    const sha = stored.assets[0]!.sha256;
    // 删掉文件但保留索引 → read undefined（不会抛）
    rmSync(join(fixture.dir, fixture.roomId, `${sha}.png`));
    assert.equal(fixture.store.read(fixture.roomId, sha, 'png'), undefined);
    // 坏索引 → 新实例按空处理
    fixture.store.store(fixture.roomId, 'p1', [{ kind: 'icon', b64: b64(ICON_PNG) }]);
    rmSync(join(fixture.dir, fixture.roomId, 'index.json'));
    const fresh = new RoomAssetStore({ dir: fixture.dir });
    assert.deepEqual(fresh.listRoom(fixture.roomId), []);
  } finally {
    cleanup(fixture);
  }
});

test('RoomAssetStore: defaultRoomAssetsDir 与房间存档同父目录（跟随 DSH_HOME/DSH_PROFILE）', () => {
  const dir = defaultRoomAssetsDir({ DSH_HOME: 'C:/dsh-home', DSH_PROFILE: 'trpg' } as NodeJS.ProcessEnv);
  assert.equal(dir.replaceAll('\\', '/'), 'C:/dsh-home/profile-data/trpg/dsh-trpg-table/room-assets');
  assert.equal(defaultRoomsDir({ DSH_HOME: 'C:/dsh-home', DSH_PROFILE: 'trpg' } as NodeJS.ProcessEnv).replaceAll('\\', '/'), 'C:/dsh-home/profile-data/trpg/dsh-trpg-table/rooms');
});
