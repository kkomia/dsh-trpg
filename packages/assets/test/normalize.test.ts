/**
 * 归一化器测试：像素整数倍最近邻（无模糊）、留白/裁剪、去背阈值、多目标规格、超限拒绝、确定性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_TARGETS,
  decodePng,
  normalizeImage,
  removeSolidBackground,
  resolveNormalizeTarget,
  sha256Hex,
  sniffImageFormat,
} from '../src/index.ts';
import { patternRgba, pixelAt, rgbaPng, solidRgba } from './helpers.ts';

function png(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return rgbaPng(rgba, width, height);
}

function expectFail(result: ReturnType<typeof normalizeImage>, messagePart: string): void {
  assert.equal(result.ok, false, `应失败但成功（warnings: ${result.warnings.join(' | ')}）`);
  assert.ok(
    result.errors.some((error) => error.includes(messagePart)),
    `错误信息应包含「${messagePart}」，实际：${result.errors.join(' | ')}`,
  );
}

function decode(output: Uint8Array): ReturnType<typeof decodePng> {
  return decodePng(output);
}

// ---------------------------------------------------------------------------
// 像素风：整数倍最近邻，禁模糊
// ---------------------------------------------------------------------------

test('归一化 pixel-32：1024×1024 → 32×32 整数倍最近邻（逐像素对齐源图 32 块）', () => {
  const source = patternRgba(1024, 1024, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
  const result = normalizeImage(png(source, 1024, 1024), 'pixel-32', { removeBackground: false });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(result.format, 'png');
  assert.equal(result.width, 32);
  assert.equal(result.height, 32);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.equal(result.sha256, sha256Hex(result.bytes!));
  const decoded = decode(result.bytes!);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [17, 23], [31, 31]] as const) {
    assert.deepEqual(pixelAt(decoded.rgba, 32, x, y), [
      (x * 32) % 256,
      (y * 32) % 256,
      (x * 32 + y * 32) % 256,
      255,
    ]);
  }
});

test('归一化 pixel-32：两色棋盘格输出只含源色（无插值/无模糊）', () => {
  const colorA: [number, number, number, number] = [255, 0, 0, 255];
  const colorB: [number, number, number, number] = [0, 0, 255, 255];
  const source = patternRgba(1024, 1024, (x, y) => {
    const check = (Math.floor(x / 32) + Math.floor(y / 32)) % 2;
    return check === 0 ? colorA : colorB;
  });
  const result = normalizeImage(png(source, 1024, 1024), 'pixel-32', { removeBackground: false });
  assert.equal(result.ok, true, result.errors.join(' | '));
  const decoded = decode(result.bytes!);
  const seen = new Set<string>();
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      seen.add(pixelAt(decoded.rgba, 32, x, y).join(','));
    }
  }
  assert.deepEqual([...seen].sort(), [colorA.join(','), colorB.join(',')].sort());
});

test('归一化 pixel-32：512×512 → 32×32（16 倍整数缩小）', () => {
  const source = patternRgba(512, 512, (x, y) => [x % 256, y % 256, 0, 255]);
  const result = normalizeImage(png(source, 512, 512), 'pixel-32', { removeBackground: false });
  assert.equal(result.ok, true, result.errors.join(' | '));
  const decoded = decode(result.bytes!);
  assert.deepEqual(pixelAt(decoded.rgba, 32, 3, 4), [(3 * 16) % 256, (4 * 16) % 256, 0, 255]);
});

test('归一化 pixel-32：非整数倍源图拒绝（给可操作提示）', () => {
  const source = patternRgba(100, 100, () => [1, 2, 3, 255]);
  const result = normalizeImage(png(source, 100, 100), 'pixel-32');
  expectFail(result, '整数倍');
});

test('归一化 pixel-32：SVG 输入拒绝（v1 不做栅格化）', () => {
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="8" height="8"/></svg>',
  );
  expectFail(normalizeImage(svg, 'pixel-32'), '栅格化');
});

// ---------------------------------------------------------------------------
// 图标/头像/立绘：contain 留白 与 cover 裁剪
// ---------------------------------------------------------------------------

test('归一化 icon-128（contain）：64×32 等比放大 + 上下透明留白', () => {
  const source = patternRgba(64, 32, (x, y) => [x * 4, y * 8, 7, 255]);
  const result = normalizeImage(png(source, 64, 32), 'icon-128', { removeBackground: false });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(result.format, 'png');
  assert.equal(result.width, 128);
  assert.equal(result.height, 128);
  const decoded = decode(result.bytes!);
  assert.equal(pixelAt(decoded.rgba, 128, 10, 0)[3], 0, '顶部留白应透明');
  assert.equal(pixelAt(decoded.rgba, 128, 10, 127)[3], 0, '底部留白应透明');
  assert.equal(pixelAt(decoded.rgba, 128, 0, 64)[3], 255, '内容行应不透明');
});

test('归一化 icon-128（SVG 输入）：保矢量、净化输出、格式 svg', () => {
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#ff0000"/></svg>',
  );
  const result = normalizeImage(svg, 'icon-128');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(result.format, 'svg');
  assert.equal(result.width, 128);
  assert.equal(result.height, 128);
  const text = new TextDecoder().decode(result.bytes!);
  assert.ok(text.startsWith('<?xml'));
  assert.ok(text.includes('viewBox="0 0 128 128"'));
  assert.equal(result.sha256, sha256Hex(result.bytes!));
});

test('归一化 icon-128（PNG 输入）：输出 128×128 PNG', () => {
  const source = solidRgba(256, 256, [12, 34, 56, 255]);
  const result = normalizeImage(png(source, 256, 256), 'icon-128');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(result.format, 'png');
  const decoded = decode(result.bytes!);
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 128);
});

test('归一化 avatar-256（cover）：512×256 居中裁剪到 256×256，无留白', () => {
  const source = patternRgba(512, 256, (x, y) => [Math.floor(x / 64) * 40, Math.floor(y / 64) * 40, 9, 255]);
  const result = normalizeImage(png(source, 512, 256), 'avatar-256', { removeBackground: false });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(result.width, 256);
  assert.equal(result.height, 256);
  const decoded = decode(result.bytes!);
  assert.deepEqual(pixelAt(decoded.rgba, 256, 0, 0), [80, 0, 9, 255]);
  assert.deepEqual(pixelAt(decoded.rgba, 256, 255, 0), [200, 0, 9, 255]);
});

test('归一化 portrait：1024×1024 → 768×1024 居中裁剪', () => {
  const source = patternRgba(1024, 1024, (x, y) => [Math.floor(x / 128) * 20, Math.floor(y / 128) * 20, 5, 255]);
  const result = normalizeImage(png(source, 1024, 1024), 'portrait');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(result.width, 768);
  assert.equal(result.height, 1024);
  const decoded = decode(result.bytes!);
  assert.deepEqual(pixelAt(decoded.rgba, 768, 0, 0), [20, 0, 5, 255]);
});

test('归一化 variant：与立绘同规格 768×1024', () => {
  const source = solidRgba(600, 600, [1, 2, 3, 255]);
  const result = normalizeImage(png(source, 600, 600), 'variant');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual([result.width, result.height], [768, 1024]);
});

test('归一化 cover：1024×576 规格', () => {
  const source = solidRgba(512, 512, [20, 30, 40, 255]);
  const result = normalizeImage(png(source, 512, 512), 'cover');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual([result.width, result.height], [1024, 576]);
});

test('归一化 world-map：2048×1536 规格 + 512 KiB 上限通过', () => {
  const source = solidRgba(1024, 1024, [30, 60, 90, 255]);
  const result = normalizeImage(png(source, 1024, 1024), 'world-map');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual([result.width, result.height], [2048, 1536]);
  assert.ok(result.bytes!.length <= ASSET_TARGETS['world-map'].maxBytes);
});

test('归一化 battle-map：1024×768 规格', () => {
  const source = solidRgba(1024, 1024, [40, 50, 60, 255]);
  const result = normalizeImage(png(source, 1024, 1024), 'battle-map');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual([result.width, result.height], [1024, 768]);
});

// ---------------------------------------------------------------------------
// 帧表
// ---------------------------------------------------------------------------

test('归一化 spritesheet：默认 4×4 → 512×512（每格 128）', () => {
  const source = patternRgba(1024, 1024, (x, y) => [x % 256, y % 256, 3, 255]);
  const result = normalizeImage(png(source, 1024, 1024), 'spritesheet');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual([result.width, result.height], [512, 512]);
  const spec = resolveNormalizeTarget('spritesheet');
  assert.equal(spec.frameSize, 128);
});

test('归一化 spritesheet：自定义 2×3 → 384×256', () => {
  const source = solidRgba(256, 256, [9, 9, 9, 255]);
  const result = normalizeImage(png(source, 256, 256), 'spritesheet', { rows: 2, cols: 3 });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.deepEqual([result.width, result.height], [384, 256]);
});

test('归一化 spritesheet：非法行列拒绝', () => {
  try {
    resolveNormalizeTarget('spritesheet', { rows: 9, cols: 4 });
    assert.fail('应该抛错');
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('1–8'));
  }
});

// ---------------------------------------------------------------------------
// 去背
// ---------------------------------------------------------------------------

test('归一化去背：四角纯白背景 → 角落透明、主体保留', () => {
  const source = patternRgba(1024, 1024, (x, y) => {
    const inSquare = x >= 384 && x < 640 && y >= 384 && y < 640;
    return inSquare ? [255, 0, 0, 255] : [255, 255, 255, 255];
  });
  const result = normalizeImage(png(source, 1024, 1024), 'icon-128');
  assert.equal(result.ok, true, result.errors.join(' | '));
  const decoded = decode(result.bytes!);
  assert.equal(pixelAt(decoded.rgba, 128, 0, 0)[3], 0, '角落应透明');
  const center = pixelAt(decoded.rgba, 128, 64, 64);
  assert.ok(center[0] > 200 && center[1] < 40, `中心应保留红色，实际 ${center.join(',')}`);
  assert.equal(center[3], 255);
});

test('归一化去背失败：非纯色背景保留并给 warning（不阻断）', () => {
  const source = patternRgba(256, 256, (x, y) => [(x * 7 + y * 13) % 256, (x * 3) % 256, (y * 5) % 256, 255]);
  const result = normalizeImage(png(source, 256, 256), 'icon-128');
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.warnings.some((warning) => warning.includes('去背')), result.warnings.join(' | '));
  const decoded = decode(result.bytes!);
  assert.equal(pixelAt(decoded.rgba, 128, 0, 0)[3], 255, '失败时保留原背景');
});

test('去背只清边框连通区域：内部同色像素（被物体包围）不动', () => {
  const width = 64;
  const height = 64;
  const rgba = solidRgba(width, height, [255, 255, 255, 255]);
  for (let y = 24; y < 40; y += 1) {
    for (let x = 24; x < 40; x += 1) {
      const inner = x >= 28 && x < 36 && y >= 28 && y < 36;
      const offset = (y * width + x) * 4;
      if (!inner) rgba.set([255, 0, 0, 255], offset); // 红色环（只有 192 像素，白底 > 90%）
    }
  }
  const removal = removeSolidBackground(rgba, width, height, { tolerance: 8, coverage: 0.9 });
  assert.equal(removal.ok, true, removal.reason);
  assert.ok(removal.removedPixels > 0);
  const corner = pixelAt(rgba, width, 0, 0);
  const inner = pixelAt(rgba, width, 32, 32);
  assert.equal(corner[3], 0, '外部白底应被去背');
  assert.equal(inner[3], 255, '内部同色像素不能被挖空');
});

test('去背阈值：四角颜色不一致时跳过并返回原因', () => {
  const width = 32;
  const height = 32;
  const rgba = solidRgba(width, height, [255, 255, 255, 255]);
  rgba.set([0, 0, 0, 255], 0);
  const removal = removeSolidBackground(rgba, width, height);
  assert.equal(removal.ok, false);
  assert.ok(removal.reason!.includes('四角'));
});

// ---------------------------------------------------------------------------
// 体积上限 / 错误输入 / 确定性
// ---------------------------------------------------------------------------

test('归一化体积超限：拒绝并给「当前 / 上限」中文原因', () => {
  const source = patternRgba(256, 256, (x, y) => [x % 256, y % 256, (x * y) % 256, 255]);
  const result = normalizeImage(png(source, 256, 256), 'icon-128', { maxBytes: 100 });
  expectFail(result, '上限');
});

test('归一化确定性：同输入两次输出同字节同 sha256', () => {
  const source = patternRgba(128, 128, (x, y) => [x, y, (x + y) % 256, 255]);
  const first = normalizeImage(png(source, 128, 128), 'avatar-256');
  const second = normalizeImage(png(source, 128, 128), 'avatar-256');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual([...first.bytes!], [...second.bytes!]);
  assert.equal(first.sha256, second.sha256);
});

test('归一化拒绝 JPEG/GIF/WebP/BMP（按 magic 判定，不按扩展名）', () => {
  expectFail(normalizeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'icon-128'), 'JPEG');
  expectFail(normalizeImage(new TextEncoder().encode('GIF89a....'), 'icon-128'), 'GIF');
  const webp = new Uint8Array(16);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  expectFail(normalizeImage(webp, 'icon-128'), 'WebP');
  expectFail(normalizeImage(new Uint8Array([0x42, 0x4d, 0, 0]), 'icon-128'), 'BMP');
});

test('归一化空输入：拒绝', () => {
  expectFail(normalizeImage(new Uint8Array(0), 'icon-128'), '空');
});

test('归一化未知目标：拒绝', () => {
  const result = normalizeImage(solidRgba(8, 8, [1, 1, 1, 255]), 'not-a-target' as never);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('未知的归一化目标')));
});

test('归一化返回原尺寸信息（预览「原图」栏用）', () => {
  const source = solidRgba(300, 200, [1, 2, 3, 255]);
  const result = normalizeImage(png(source, 300, 200), 'icon-128');
  assert.equal(result.ok, true);
  assert.deepEqual(result.source, { width: 300, height: 200, format: 'png' });
});

test('sniffImageFormat：识别 PNG/SVG/JPEG/未知', () => {
  assert.equal(sniffImageFormat(png(solidRgba(1, 1, [0, 0, 0, 255]), 1, 1)), 'png');
  assert.equal(sniffImageFormat(new TextEncoder().encode('  <svg/>')), 'svg');
  assert.equal(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff])), 'jpeg');
  assert.equal(sniffImageFormat(new Uint8Array([1, 2, 3])), 'unknown');
});

test('归一化 SVG 输入到 PNG 目标：拒绝（不做栅格化）', () => {
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="8" height="8"/></svg>',
  );
  expectFail(normalizeImage(svg, 'avatar-256'), '栅格化');
});

test('归一化坏 PNG：拒绝并透出 PNG 中文原因', () => {
  const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  expectFail(normalizeImage(broken, 'icon-128'), 'PNG');
});
