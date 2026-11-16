/**
 * PNG 编解码测试：roundtrip、filter 0–4、色彩类型/tRNS、坏样本拒绝、确定性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

import {
  decodePng,
  encodePng,
  isPng,
  PNG_SIGNATURE,
  PngError,
  readPngInfo,
} from '../src/index.ts';
import {
  concat,
  makePng,
  patternRgba,
  pngChunk,
  pixelAt,
  rgbaPng,
  rgbaRows,
  SIGNATURE,
  solidRgba,
} from './helpers.ts';

function expectPngError(
  fn: () => unknown,
  code: string,
  messagePart?: string,
): PngError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PngError, `应抛 PngError，实际：${String(error)}`);
    assert.equal(error.code, code);
    if (messagePart !== undefined) {
      assert.ok(
        error.message.includes(messagePart),
        `错误信息应包含「${messagePart}」，实际「${error.message}」`,
      );
    }
    return error;
  }
  assert.fail('预期抛出 PngError，但没有抛错');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// roundtrip
// ---------------------------------------------------------------------------

test('PNG roundtrip：2×2 RGBA 编码后解码无损', () => {
  const rgba = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 128,
    0, 0, 255, 255,
    10, 20, 30, 40,
  ]);
  const encoded = encodePng({ width: 2, height: 2, rgba });
  assert.ok(isPng(encoded));
  const decoded = decodePng(encoded);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
  assert.ok(bytesEqual(decoded.rgba, rgba));
});

test('PNG roundtrip：1×1 边界尺寸', () => {
  const rgba = new Uint8Array([1, 2, 3, 4]);
  const decoded = decodePng(encodePng({ width: 1, height: 1, rgba }));
  assert.deepEqual([...decoded.rgba], [1, 2, 3, 4]);
});

test('PNG roundtrip：4×3 渐变图案', () => {
  const rgba = patternRgba(4, 3, (x, y) => [x * 60, y * 80, x + y, 255 - x * 10]);
  const decoded = decodePng(encodePng({ width: 4, height: 3, rgba }));
  assert.ok(bytesEqual(decoded.rgba, rgba));
});

test('PNG 编码确定性：同输入同字节、同 sha（缓存/去重的前提）', () => {
  const rgba = patternRgba(8, 8, (x, y) => [x * 7, y * 9, (x * y) % 256, 255]);
  const first = encodePng({ width: 8, height: 8, rgba });
  const second = encodePng({ width: 8, height: 8, rgba });
  assert.ok(bytesEqual(first, second));
  assert.equal(first.length, second.length);
});

// ---------------------------------------------------------------------------
// filter 0–4
// ---------------------------------------------------------------------------

const FILTER_ROWS: Uint8Array[] = [
  new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 9, 9, 9, 9]),
  new Uint8Array([0, 0, 255, 255, 10, 20, 30, 40, 200, 100, 50, 25]),
  new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
];
const FILTER_EXPECTED = concat(FILTER_ROWS);

for (let filter = 0; filter <= 4; filter += 1) {
  test(`PNG 解码 filter=${filter}（三行同 filter）`, () => {
    const png = makePng({
      width: 3,
      height: 3,
      colorType: 6,
      rows: FILTER_ROWS,
      filters: [filter, filter, filter],
    });
    const decoded = decodePng(png);
    assert.ok(bytesEqual(decoded.rgba, FILTER_EXPECTED), `filter=${filter} 反滤波结果不符`);
  });
}

test('PNG 解码混合 filter 多行（0/1/2/3/4 逐行切换）', () => {
  const png = makePng({
    width: 3,
    height: 5,
    colorType: 6,
    rows: [
      new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      new Uint8Array([200, 100, 50, 25, 0, 0, 0, 0, 255, 255, 255, 255]),
      new Uint8Array([3, 3, 3, 3, 9, 9, 9, 9, 27, 27, 27, 27]),
      new Uint8Array([128, 64, 32, 16, 8, 4, 2, 1, 0, 255, 0, 255]),
    ],
    filters: [0, 1, 2, 3, 4],
  });
  const decoded = decodePng(png);
  const expected = concat([
    new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]),
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    new Uint8Array([200, 100, 50, 25, 0, 0, 0, 0, 255, 255, 255, 255]),
    new Uint8Array([3, 3, 3, 3, 9, 9, 9, 9, 27, 27, 27, 27]),
    new Uint8Array([128, 64, 32, 16, 8, 4, 2, 1, 0, 255, 0, 255]),
  ]);
  assert.ok(bytesEqual(decoded.rgba, expected));
});

test('PNG 解码边界尺寸：1×5 竖条', () => {
  const png = makePng({
    width: 1,
    height: 5,
    colorType: 6,
    rows: [0, 1, 2, 3, 4].map((value) => new Uint8Array([value, value, value, 255])),
  });
  const decoded = decodePng(png);
  assert.equal(decoded.width, 1);
  assert.equal(decoded.height, 5);
  assert.deepEqual([...decoded.rgba.subarray(0, 4)], [0, 0, 0, 255]);
});

test('PNG 解码边界尺寸：5×1 横条', () => {
  const row = new Uint8Array(20);
  for (let i = 0; i < 5; i += 1) row.set([i, i * 2, i * 3, 255], i * 4);
  const png = makePng({ width: 5, height: 1, colorType: 6, rows: [row] });
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded.rgba, 5, 4, 0), [4, 8, 12, 255]);
});

// ---------------------------------------------------------------------------
// 色彩类型与 tRNS
// ---------------------------------------------------------------------------

test('PNG 解码灰度（colorType 0）', () => {
  const png = makePng({
    width: 2,
    height: 1,
    colorType: 0,
    rows: [new Uint8Array([10, 200])],
  });
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded.rgba, 2, 0, 0), [10, 10, 10, 255]);
  assert.deepEqual(pixelAt(decoded.rgba, 2, 1, 0), [200, 200, 200, 255]);
});

test('PNG 灰度 tRNS：命中灰度值置透明', () => {
  const png = makePng({
    width: 2,
    height: 1,
    colorType: 0,
    rows: [new Uint8Array([10, 20])],
    trns: new Uint8Array([0, 10]),
  });
  const decoded = decodePng(png);
  assert.equal(pixelAt(decoded.rgba, 2, 0, 0)[3], 0);
  assert.equal(pixelAt(decoded.rgba, 2, 1, 0)[3], 255);
});

test('PNG 真彩 tRNS（color-key）：命中 RGB 置透明', () => {
  const png = makePng({
    width: 2,
    height: 1,
    colorType: 2,
    rows: [new Uint8Array([255, 0, 0, 0, 255, 0])],
    // R=255, G=0, B=0 为透明色键（每通道 2 字节大端）
    trns: new Uint8Array([0, 255, 0, 0, 0, 0]),
  });
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded.rgba, 2, 0, 0), [255, 0, 0, 0]);
  assert.deepEqual(pixelAt(decoded.rgba, 2, 1, 0), [0, 255, 0, 255]);
});

test('PNG 调色板 + tRNS：透明与半透明索引', () => {
  const png = makePng({
    width: 3,
    height: 1,
    colorType: 3,
    rows: [new Uint8Array([0, 1, 1])],
    palette: new Uint8Array([255, 0, 0, 0, 255, 0]),
    trns: new Uint8Array([0, 128]),
  });
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded.rgba, 3, 0, 0), [255, 0, 0, 0]);
  assert.deepEqual(pixelAt(decoded.rgba, 3, 1, 0), [0, 255, 0, 128]);
});

test('PNG 灰度+Alpha（colorType 4）', () => {
  const png = makePng({
    width: 2,
    height: 1,
    colorType: 4,
    rows: [new Uint8Array([100, 200, 50, 0])],
  });
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded.rgba, 2, 0, 0), [100, 100, 100, 200]);
  assert.deepEqual(pixelAt(decoded.rgba, 2, 1, 0), [50, 50, 50, 0]);
});

test('PNG 多 IDAT：拼接后解码一致', () => {
  const rgba = patternRgba(6, 5, (x, y) => [(x * 31) % 256, (y * 47) % 256, x + y, 255]);
  const png = makePng({
    width: 6,
    height: 5,
    colorType: 6,
    rows: rgbaRows(rgba, 6, 5),
    idatSplit: 3,
  });
  const decoded = decodePng(png);
  assert.ok(bytesEqual(decoded.rgba, rgba));
});

// ---------------------------------------------------------------------------
// 坏样本拒绝（全部中文可读）
// ---------------------------------------------------------------------------

test('PNG 坏 CRC：拒绝并提示校验失败', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    corruptCrcTypes: ['IDAT'],
  });
  expectPngError(() => decodePng(png), 'bad-crc', 'CRC');
});

test('PNG 截断：块数据不完整拒绝', () => {
  const png = rgbaPng(solidRgba(2, 2, [1, 2, 3, 4]), 2, 2);
  expectPngError(() => decodePng(png.subarray(0, png.length - 6)), 'truncated');
});

test('PNG 缺 IEND：拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    omitIend: true,
  });
  expectPngError(() => decodePng(png), 'missing-chunk', 'IEND');
});

test('PNG 缺 IDAT：拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    omitIdat: true,
  });
  expectPngError(() => decodePng(png), 'missing-chunk', 'IDAT');
});

test('PNG 16-bit：拒绝并提示导出 8-bit', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    bitDepth: 16,
    rows: [new Uint8Array(8)], // 16-bit RGBA = 每像素 8 字节
  });
  expectPngError(() => decodePng(png), 'unsupported-bit-depth', '8-bit');
});

test('PNG 位深 4-bit：拒绝', () => {
  const png = makePng({
    width: 2,
    height: 1,
    colorType: 3,
    bitDepth: 4,
    rows: [new Uint8Array([0b00010010])],
    palette: new Uint8Array([0, 0, 0, 255, 255, 255]),
  });
  expectPngError(() => decodePng(png), 'unsupported-bit-depth', '4-bit');
});

test('PNG Adam7 交错：拒绝并提示另存非交错', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    interlace: 1,
    rows: [new Uint8Array([1, 2, 3, 4])],
  });
  expectPngError(() => decodePng(png), 'unsupported-interlace', '交错');
});

test('PNG APNG（acTL）：拒绝动画', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    acTL: true,
  });
  expectPngError(() => decodePng(png), 'unsupported-chunk', 'APNG');
});

test('PNG 未知关键块：拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    unknownCriticalChunk: 'ZZZZ',
  });
  expectPngError(() => decodePng(png), 'unsupported-chunk', 'ZZZZ');
});

test('PNG 非法签名：拒绝（非 PNG）', () => {
  expectPngError(() => decodePng(new Uint8Array([1, 2, 3])), 'not-png');
  expectPngError(() => decodePng(new TextEncoder().encode('<svg/>')), 'not-png');
});

test('PNG 非法 filter 字节：拒绝', () => {
  const raw = new Uint8Array([5, 1, 2, 3, 4]);
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    overrideIdat: new Uint8Array(deflateSync(raw)),
  });
  expectPngError(() => decodePng(png), 'bad-filter', 'filter');
});

test('PNG 解压后长度不符：拒绝', () => {
  const png = makePng({
    width: 2,
    height: 2,
    colorType: 6,
    rows: [new Uint8Array(8), new Uint8Array(8)],
    overrideIdat: new Uint8Array(deflateSync(new Uint8Array([0, 1, 2]))),
  });
  expectPngError(() => decodePng(png), 'bad-image-data', '截断');
});

test('PNG IDAT 无法解压：拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    overrideIdat: new Uint8Array([1, 2, 3, 4, 5, 6]),
  });
  expectPngError(() => decodePng(png), 'bad-image-data', '解压失败');
});

test('PNG 调色板缺 PLTE：拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 3,
    rows: [new Uint8Array([0])],
  });
  expectPngError(() => decodePng(png), 'missing-chunk', 'PLTE');
});

test('PNG 调色板索引越界：拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 3,
    rows: [new Uint8Array([5])],
    palette: new Uint8Array([0, 0, 0]),
  });
  expectPngError(() => decodePng(png), 'bad-image-data', '越界');
});

test('PNG 超大尺寸：拒绝（防内存打爆）', () => {
  const width = 9000;
  const png = makePng({
    width,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array(width * 4)],
  });
  expectPngError(() => decodePng(png), 'dimension-limit', '上限');
});

// ---------------------------------------------------------------------------
// 编码参数校验 / info
// ---------------------------------------------------------------------------

test('encodePng：RGBA 长度与宽高不符拒绝', () => {
  try {
    encodePng({ width: 2, height: 2, rgba: new Uint8Array(5) });
    assert.fail('应该抛错');
  } catch (error) {
    assert.ok(error instanceof PngError);
    assert.equal(error.code, 'invalid-argument');
  }
});

test('encodePng：宽高非正整数拒绝', () => {
  expectPngError(
    () => encodePng({ width: 0, height: 1, rgba: new Uint8Array(0) }),
    'invalid-argument',
  );
});

test('readPngInfo：RGBA 图返回尺寸/位深/色彩类型/透明', () => {
  const png = encodePng({ width: 3, height: 2, rgba: new Uint8Array(24) });
  const info = readPngInfo(png);
  assert.equal(info.width, 3);
  assert.equal(info.height, 2);
  assert.equal(info.bitDepth, 8);
  assert.equal(info.colorType, 6);
  assert.equal(info.colorTypeName, 'RGBA');
  assert.equal(info.interlaced, false);
  assert.equal(info.hasAlpha, true);
  assert.equal(info.apng, false);
});

test('readPngInfo：RGB 图 hasAlpha=false', () => {
  const png = makePng({
    width: 2,
    height: 1,
    colorType: 2,
    rows: [new Uint8Array([1, 2, 3, 4, 5, 6])],
  });
  const info = readPngInfo(png);
  assert.equal(info.colorType, 2);
  assert.equal(info.colorTypeName, '真彩 RGB');
  assert.equal(info.hasAlpha, false);
});

test('readPngInfo：APNG 标记 apng=true（info 不抛错）', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    acTL: true,
  });
  assert.equal(readPngInfo(png).apng, true);
});

test('PNG 签名常量与 isPng 判定', () => {
  assert.deepEqual([...PNG_SIGNATURE], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(isPng(SIGNATURE));
  assert.ok(!isPng(new Uint8Array([137, 80, 78, 71])));
});

test('PNG 编码产物块结构：IHDR + IDAT + IEND', () => {
  const png = encodePng({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 4]) });
  const typeAt = (offset: number): string => String.fromCharCode(...png.subarray(offset, offset + 4));
  // 签名 8 字节；IHDR: 长度 4(type@12)-16、data 13、crc 4 → 下一块从 33 开始
  assert.equal(typeAt(12), 'IHDR');
  assert.equal(typeAt(37), 'IDAT');
  assert.equal(typeAt(png.length - 8), 'IEND');
});

test('PNG 手工坏块 CRC 覆盖所有块：IHDR 坏 CRC 拒绝', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    corruptCrcTypes: ['IHDR'],
  });
  expectPngError(() => decodePng(png), 'bad-crc');
});

test('PNG 合法但含未知辅助块：忽略并可解码', () => {
  const png = makePng({
    width: 1,
    height: 1,
    colorType: 6,
    rows: [new Uint8Array([1, 2, 3, 4])],
    extraChunks: [{ type: 'tEXt', data: new TextEncoder().encode('Comment\0hello') }],
  });
  const decoded = decodePng(png);
  assert.deepEqual([...decoded.rgba], [1, 2, 3, 4]);
});

test('PNG 尾部有额外垃圾字节：IEND 之后忽略', () => {
  const png = concat([
    encodePng({ width: 1, height: 1, rgba: new Uint8Array([7, 8, 9, 10]) }),
    pngChunk('tEXt', new TextEncoder().encode('x\0y')),
  ]);
  const decoded = decodePng(png);
  assert.deepEqual([...decoded.rgba], [7, 8, 9, 10]);
});
