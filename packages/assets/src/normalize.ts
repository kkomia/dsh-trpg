/**
 * 资产归一化器：解码 → 居中裁剪/等比缩放 → 留白补齐 →（可选）纯色背景去背 → 重新编码。
 *
 * 目标规格与硬约束来自 [docs/UI-CONTRACT.md](../../../docs/UI-CONTRACT.md) §3.1/§3.2；
 * 纯 JS / 纯 TS，零原生依赖（不引 sharp/jimp/Canvas），host 与客户端跑同一份代码：
 *
 * - 像素图标 `pixel-32`：**只允许整数倍最近邻**（1024→32 = 32×），禁抗锯齿/模糊；
 * - 图标 `icon-128`：SVG 进去还是 SVG（保矢量），PNG 进去出 PNG 128×128；
 * - 头像 256 / 立绘·变体 768×1024 / 帧表每格 128 / 封面 1024×576 / 世界图 2048×1536 / 战斗图 1024×768；
 * - 非像素缩略用面积平均（box），不引入双线性模糊；
 * - 去背：四角同色（ΔRGB ≤ 8）且占比 > 90% 才做，只从边框 4 连通 flood fill 置 alpha=0，
 *   内部同色像素不动；失败保留原背景并给 warning，不阻断；
 * - 输出字节确定：同输入同字节同 sha256；超体积上限直接拒绝并给中文原因。
 *
 * 边界：v1 不做 SVG→PNG 栅格化（无原生依赖），也不做调色/描边/超分/风格迁移。
 */

import { decodePng, encodePng, isPng } from './png.ts';
import { sha256Hex } from './sha256.ts';
import { SVG_VIEWBOX, sanitizeSvg } from './svg.ts';

export type NormalizedFormat = 'png' | 'svg';

export type NormalizeTargetId =
  | 'pixel-32'
  | 'icon-128'
  | 'avatar-256'
  | 'portrait'
  | 'variant'
  | 'spritesheet'
  | 'cover'
  | 'world-map'
  | 'battle-map';

export interface AssetTargetSpec {
  id: NormalizeTargetId;
  /** 中文展示名（预览面板用）。 */
  label: string;
  width: number;
  height: number;
  /** `png-or-svg` = 由输入格式决定（图标 SVG 保矢量，PNG 出 PNG）。 */
  format: NormalizedFormat | 'png-or-svg';
  /** 落盘体积上限（字节）。 */
  maxBytes: number;
  fit: 'contain' | 'cover';
  /** true = 整数倍最近邻、禁模糊（像素风）。 */
  pixelated: boolean;
  /** 默认是否做纯色背景去背。 */
  removeBackground: boolean;
  /** 帧表单格尺寸（仅 spritesheet）。 */
  frameSize?: number;
}

/** 目标规格表（§3.1 硬约束表；spritesheet 宽高由 rows/cols 在解析时计算）。 */
export const ASSET_TARGETS: Readonly<Record<NormalizeTargetId, AssetTargetSpec>> = {
  'pixel-32': {
    id: 'pixel-32',
    label: '像素图标 32×32',
    width: 32,
    height: 32,
    format: 'png',
    maxBytes: 16 * 1024,
    fit: 'contain',
    pixelated: true,
    removeBackground: true,
  },
  'icon-128': {
    id: 'icon-128',
    label: '图标 128×128',
    width: 128,
    height: 128,
    format: 'png-or-svg',
    maxBytes: 64 * 1024,
    fit: 'contain',
    pixelated: false,
    removeBackground: true,
  },
  'avatar-256': {
    id: 'avatar-256',
    label: '头像 256×256',
    width: 256,
    height: 256,
    format: 'png',
    maxBytes: 128 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: true,
  },
  portrait: {
    id: 'portrait',
    label: '立绘 768×1024',
    width: 768,
    height: 1024,
    format: 'png',
    maxBytes: 512 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: false,
  },
  variant: {
    id: 'variant',
    label: '表情/动作变体 768×1024',
    width: 768,
    height: 1024,
    format: 'png',
    maxBytes: 512 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: false,
  },
  spritesheet: {
    id: 'spritesheet',
    label: '帧表 128/格',
    width: 512,
    height: 512,
    format: 'png',
    maxBytes: 2 * 1024 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: false,
    frameSize: 128,
  },
  cover: {
    id: 'cover',
    label: '封面 1024×576',
    width: 1024,
    height: 576,
    format: 'png',
    maxBytes: 512 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: false,
  },
  'world-map': {
    id: 'world-map',
    label: '世界地图底图 2048×1536',
    width: 2048,
    height: 1536,
    format: 'png',
    maxBytes: 512 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: false,
  },
  'battle-map': {
    id: 'battle-map',
    label: '战斗地图底图 1024×768',
    width: 1024,
    height: 768,
    format: 'png',
    maxBytes: 512 * 1024,
    fit: 'cover',
    pixelated: false,
    removeBackground: false,
  },
};

export interface NormalizeOptions {
  /** 缩放模式：图标默认 contain（留白），头像/立绘/底图默认 cover（居中裁剪）。 */
  fit?: 'contain' | 'cover';
  /** true = 整数倍最近邻（像素风）；默认随目标规格。 */
  pixelated?: boolean;
  /** 是否做纯色背景去背；默认随目标规格。 */
  removeBackground?: boolean;
  /** 四角/背景色容差 ΔRGB，默认 8。 */
  backgroundTolerance?: number;
  /** 纯色背景最低占比（0–1），默认 0.9。 */
  backgroundCoverage?: number;
  /** contain 留白颜色，默认全透明。 */
  padColor?: [number, number, number, number];
  /** 帧表行数（1–8），默认 4。 */
  rows?: number;
  /** 帧表列数（1–8），默认 4。 */
  cols?: number;
  /** 覆盖目标规格的体积上限（字节），用于「降档重生成」的预览。 */
  maxBytes?: number;
}

export interface NormalizedSource {
  width: number;
  height: number;
  format: NormalizedFormat;
}

export interface NormalizeResult {
  ok: boolean;
  target: NormalizeTargetId;
  /** 归一化后的 PNG 字节或净化后的 SVG 文本字节。 */
  bytes?: Uint8Array;
  format?: NormalizedFormat;
  /** 目标宽高（失败时为规格宽高，解析失败时为 0）。 */
  width: number;
  height: number;
  warnings: string[];
  /** 中文错误原因（可多条）。 */
  errors: string[];
  /** 输出字节的 sha256（成功时给，可直接写 manifest）。 */
  sha256?: string;
  /** 输入原尺寸/格式（预览「原图」栏用）。 */
  source?: NormalizedSource;
}

export type NormalizeInput =
  | Uint8Array
  | {
      /** 原始文件字节（PNG/SVG，按 magic 嗅探，不看扩展名）。 */
      bytes: Uint8Array;
      /** 原始文件名（仅用于错误/日志展示，不参与格式判定）。 */
      filename?: string;
    };

export type ImageFormatKind =
  | 'png'
  | 'svg'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'bmp'
  | 'tiff'
  | 'unknown';

const FORMAT_LABELS: Record<ImageFormatKind, string> = {
  png: 'PNG',
  svg: 'SVG',
  jpeg: 'JPEG',
  gif: 'GIF',
  webp: 'WebP',
  bmp: 'BMP',
  tiff: 'TIFF',
  unknown: '未知格式',
};

class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizeError';
  }
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function hasSignature(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** 按文件内容（magic / 首个非空字符）嗅探图片格式；不看扩展名。 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormatKind {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return 'unknown';
  if (isPng(bytes)) return 'png';
  if (hasSignature(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (hasSignature(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (hasSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && hasSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  if (hasSignature(bytes, [0x42, 0x4d])) return 'bmp';
  if (hasSignature(bytes, [0x49, 0x49, 0x2a, 0x00])) return 'tiff';
  if (hasSignature(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  let index = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) {
    index += 1;
  }
  if (index < bytes.length && bytes[index] === 0x3c /* '<' */) return 'svg';
  return 'unknown';
}

interface ResolvedTarget extends AssetTargetSpec {
  width: number;
  height: number;
}

/** 解析目标规格（含 spritesheet 的 rows/cols），非法参数抛中文错误。 */
export function resolveNormalizeTarget(
  target: NormalizeTargetId,
  options: Pick<NormalizeOptions, 'rows' | 'cols' | 'maxBytes'> = {},
): ResolvedTarget {
  const base = ASSET_TARGETS[target];
  if (base === undefined) {
    throw new NormalizeError(`未知的归一化目标「${String(target)}」`);
  }
  const resolved: ResolvedTarget = { ...base };
  if (target === 'spritesheet') {
    const rows = options.rows ?? 4;
    const cols = options.cols ?? 4;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || rows > 8 || cols < 1 || cols > 8) {
      throw new NormalizeError(
        `帧表行列必须是 1–8 的整数，收到 rows=${String(options.rows)}、cols=${String(options.cols)}`,
      );
    }
    resolved.width = cols * (base.frameSize ?? 128);
    resolved.height = rows * (base.frameSize ?? 128);
  }
  if (options.maxBytes !== undefined) {
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new NormalizeError(`maxBytes 必须是正整数，收到 ${String(options.maxBytes)}`);
    }
    resolved.maxBytes = options.maxBytes;
  }
  return resolved;
}

function resolveInputBytes(input: NormalizeInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input !== null && typeof input === 'object' && input.bytes instanceof Uint8Array) {
    return input.bytes;
  }
  throw new NormalizeError('归一化输入必须是 PNG/SVG 的 Uint8Array 或 { bytes }');
}

// ---------------------------------------------------------------------------
// 几何：含抗锯齿风险的缩放一律走面积平均；像素风走整数倍最近邻
// ---------------------------------------------------------------------------

function resampleNearest(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / width));
      const si = (sy * sourceWidth + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = source[si]!;
      out[di + 1] = source[si + 1]!;
      out[di + 2] = source[si + 2]!;
      out[di + 3] = source[si + 3]!;
    }
  }
  return out;
}

/**
 * 面积平均缩放（box filter，支持任意比例；预乘 alpha 避免透明边发黑）。
 * 对缩小是标准 box 平均，对放大等价于最近邻（覆盖归一后即单像素）。
 */
function resampleArea(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const xScale = sourceWidth / width;
  const yScale = sourceHeight / height;
  for (let y = 0; y < height; y += 1) {
    const sy0 = y * yScale;
    const sy1 = sy0 + yScale;
    const iy0 = Math.floor(sy0);
    const iy1 = Math.ceil(sy1);
    for (let x = 0; x < width; x += 1) {
      const sx0 = x * xScale;
      const sx1 = sx0 + xScale;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.ceil(sx1);
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;
      let weightSum = 0;
      for (let sy = iy0; sy < iy1; sy += 1) {
        if (sy < 0 || sy >= sourceHeight) continue;
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx += 1) {
          if (sx < 0 || sx >= sourceWidth) continue;
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const si = (sy * sourceWidth + sx) * 4;
          const alpha = source[si + 3]! / 255;
          accA += weight * alpha;
          accR += weight * alpha * source[si]!;
          accG += weight * alpha * source[si + 1]!;
          accB += weight * alpha * source[si + 2]!;
          weightSum += weight;
        }
      }
      const di = (y * width + x) * 4;
      if (weightSum <= 0 || accA <= 0) {
        out[di] = 0;
        out[di + 1] = 0;
        out[di + 2] = 0;
        out[di + 3] = 0;
        continue;
      }
      out[di] = Math.max(0, Math.min(255, Math.round(accR / accA)));
      out[di + 1] = Math.max(0, Math.min(255, Math.round(accG / accA)));
      out[di + 2] = Math.max(0, Math.min(255, Math.round(accB / accA)));
      out[di + 3] = Math.max(0, Math.min(255, Math.round((accA / weightSum) * 255)));
    }
  }
  return out;
}

function scaleImage(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  pixelated: boolean,
): Uint8Array {
  if (width === sourceWidth && height === sourceHeight) {
    return new Uint8Array(source);
  }
  return pixelated
    ? resampleNearest(source, sourceWidth, sourceHeight, width, height)
    : resampleArea(source, sourceWidth, sourceHeight, width, height);
}

function newCanvas(
  width: number,
  height: number,
  padColor: [number, number, number, number],
): Uint8Array {
  const canvas = new Uint8Array(width * height * 4);
  const [r, g, b, a] = padColor;
  if (r === 0 && g === 0 && b === 0 && a === 0) return canvas;
  for (let i = 0; i < width * height; i += 1) {
    canvas[i * 4] = r;
    canvas[i * 4 + 1] = g;
    canvas[i * 4 + 2] = b;
    canvas[i * 4 + 3] = a;
  }
  return canvas;
}

/** 留白（contain）或居中裁剪（cover）合成到目标画布。 */
function composeOntoCanvas(
  resized: Uint8Array,
  resizedWidth: number,
  resizedHeight: number,
  width: number,
  height: number,
  fit: 'contain' | 'cover',
  padColor: [number, number, number, number],
): Uint8Array {
  const canvas = newCanvas(width, height, padColor);
  const copyWidth = Math.min(resizedWidth, width);
  const copyHeight = Math.min(resizedHeight, height);
  const sourceX = fit === 'contain' ? 0 : Math.floor(Math.max(0, resizedWidth - width) / 2);
  const sourceY = fit === 'contain' ? 0 : Math.floor(Math.max(0, resizedHeight - height) / 2);
  const destinationX = fit === 'contain' ? Math.floor((width - resizedWidth) / 2) : 0;
  const destinationY = fit === 'contain' ? Math.floor((height - resizedHeight) / 2) : 0;
  for (let y = 0; y < copyHeight; y += 1) {
    const destinationRow = (destinationY + y) * width;
    for (let x = 0; x < copyWidth; x += 1) {
      const si = ((sourceY + y) * resizedWidth + (sourceX + x)) * 4;
      const di = (destinationRow + destinationX + x) * 4;
      canvas[di] = resized[si]!;
      canvas[di + 1] = resized[si + 1]!;
      canvas[di + 2] = resized[si + 2]!;
      canvas[di + 3] = resized[si + 3]!;
    }
  }
  return canvas;
}

/** 像素风：居中裁剪到目标比例 → 整数倍最近邻缩放（不允许非整数倍）。 */
function fitPixelated(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  warnings: string[],
): Uint8Array {
  const targetRatio = width / height;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  if (sourceWidth / sourceHeight > targetRatio) {
    cropHeight = sourceHeight;
    cropWidth = Math.min(sourceWidth, Math.max(1, Math.round(sourceHeight * targetRatio)));
  } else {
    cropWidth = sourceWidth;
    cropHeight = Math.min(sourceHeight, Math.max(1, Math.round(sourceWidth / targetRatio)));
  }
  if (cropWidth !== sourceWidth || cropHeight !== sourceHeight) {
    warnings.push(`已居中裁剪以匹配目标比例：${sourceWidth}×${sourceHeight} → ${cropWidth}×${cropHeight}`);
  }
  const offsetX = Math.floor((sourceWidth - cropWidth) / 2);
  const offsetY = Math.floor((sourceHeight - cropHeight) / 2);

  const integerScaleX = cropWidth % width === 0 || width % cropWidth === 0;
  const integerScaleY = cropHeight % height === 0 || height % cropHeight === 0;
  if (!integerScaleX || !integerScaleY) {
    throw new NormalizeError(
      `像素风图标要求整数倍最近邻缩放：${cropWidth}×${cropHeight} 无法整数倍得到 ${width}×${height}；` +
        `请用 ${width * 32}×${height * 32}（32×）或 ${width * 4}×${height * 4}（4×）等整数倍源图重新生成`,
    );
  }

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = offsetY + Math.min(cropHeight - 1, Math.floor((y * cropHeight) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = offsetX + Math.min(cropWidth - 1, Math.floor((x * cropWidth) / width));
      const si = (sy * sourceWidth + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = source[si]!;
      out[di + 1] = source[si + 1]!;
      out[di + 2] = source[si + 2]!;
      out[di + 3] = source[si + 3]!;
    }
  }
  return out;
}

/** 通用缩放：等比缩放 + contain 留白 / cover 居中裁剪。 */
function fitGeneric(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  fit: 'contain' | 'cover',
  padColor: [number, number, number, number],
  warnings: string[],
): Uint8Array {
  const scale = fit === 'contain'
    ? Math.min(width / sourceWidth, height / sourceHeight)
    : Math.max(width / sourceWidth, height / sourceHeight);
  const resizedWidth = Math.max(1, Math.round(sourceWidth * scale));
  const resizedHeight = Math.max(1, Math.round(sourceHeight * scale));
  if (scale > 1.0001) {
    warnings.push(`源图 ${sourceWidth}×${sourceHeight} 小于目标 ${width}×${height}，已放大（v1 不做超分）`);
  }
  if (fit === 'cover' && (resizedWidth - width > 1 || resizedHeight - height > 1)) {
    warnings.push(`已居中裁剪以匹配目标比例：${resizedWidth}×${resizedHeight} → ${width}×${height}`);
  }
  const resized = scaleImage(source, sourceWidth, sourceHeight, resizedWidth, resizedHeight, false);
  return composeOntoCanvas(resized, resizedWidth, resizedHeight, width, height, fit, padColor);
}

// ---------------------------------------------------------------------------
// 去背：四角同色 + 边框 4 连通 flood fill（内部同色不动）
// ---------------------------------------------------------------------------

export interface BackgroundRemovalOptions {
  /** ΔRGB 容差，默认 8。 */
  tolerance?: number;
  /** 纯色最低占比（0–1），默认 0.9。 */
  coverage?: number;
}

export interface BackgroundRemovalResult {
  ok: boolean;
  removedPixels: number;
  /** 失败原因（中文；成功时无）。 */
  reason?: string;
}

/**
 * 纯色背景去背：四角取样一致（ΔRGB ≤ tolerance）且该色占比 > coverage 时，
 * 从边框做 4 连通 flood fill 置 `alpha=0`；**内部同色像素不动**（不把物体挖空）。
 * 返回失败原因供预览提示「背景未去除」，不抛异常。
 */
export function removeSolidBackground(
  rgba: Uint8Array,
  width: number,
  height: number,
  options: BackgroundRemovalOptions = {},
): BackgroundRemovalResult {
  const tolerance = options.tolerance ?? 8;
  const coverage = options.coverage ?? 0.9;
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) {
    return { ok: false, removedPixels: 0, reason: '图像数据长度与宽高不符，跳过去背' };
  }
  if (width < 3 || height < 3) {
    return { ok: false, removedPixels: 0, reason: '图像太小（<3×3），跳过去背' };
  }

  const cornerIndexes = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
  let transparentCorners = 0;
  const cornerColors: Array<[number, number, number]> = [];
  for (const index of cornerIndexes) {
    if (rgba[index + 3]! < 128) {
      transparentCorners += 1;
      continue;
    }
    cornerColors.push([rgba[index]!, rgba[index + 1]!, rgba[index + 2]!]);
  }
  if (transparentCorners >= 4) {
    return { ok: true, removedPixels: 0 }; // 已经是透明背景，无需去背
  }
  if (transparentCorners > 0 || cornerColors.length !== 4) {
    return { ok: false, removedPixels: 0, reason: '四角没有一致的纯色背景（含透明角），跳过去背' };
  }
  const reference = cornerColors[0]!;
  for (const [r, g, b] of cornerColors) {
    if (
      Math.abs(r - reference[0]) > tolerance ||
      Math.abs(g - reference[1]) > tolerance ||
      Math.abs(b - reference[2]) > tolerance
    ) {
      return { ok: false, removedPixels: 0, reason: '四角颜色不一致（ΔRGB 超过容差），跳过去背' };
    }
  }
  const average: [number, number, number] = [
    Math.round((cornerColors[0]![0] + cornerColors[1]![0] + cornerColors[2]![0] + cornerColors[3]![0]) / 4),
    Math.round((cornerColors[0]![1] + cornerColors[1]![1] + cornerColors[2]![1] + cornerColors[3]![1]) / 4),
    Math.round((cornerColors[0]![2] + cornerColors[1]![2] + cornerColors[2]![2] + cornerColors[3]![2]) / 4),
  ];

  const total = width * height;
  const matches = new Uint8Array(total);
  let matchCount = 0;
  const isMatch = (pixel: number): boolean => {
    const base = pixel * 4;
    if (rgba[base + 3]! < 16) return true;
    return (
      Math.abs(rgba[base]! - average[0]) <= tolerance &&
      Math.abs(rgba[base + 1]! - average[1]) <= tolerance &&
      Math.abs(rgba[base + 2]! - average[2]) <= tolerance
    );
  };
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (isMatch(pixel)) {
      matches[pixel] = 1;
      matchCount += 1;
    }
  }
  const ratio = matchCount / total;
  if (ratio <= coverage) {
    return {
      ok: false,
      removedPixels: 0,
      reason: `纯色背景占比 ${(ratio * 100).toFixed(1)}% 未超过 ${(coverage * 100).toFixed(0)}%，跳过去背`,
    };
  }

  // 从边框 4 连通 flood fill
  const stack: number[] = [];
  const enqueue = (pixel: number): void => {
    if (pixel < 0 || pixel >= total) return;
    if (matches[pixel] !== 1) return;
    matches[pixel] = 2;
    stack.push(pixel);
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  let removedPixels = 0;
  while (stack.length > 0) {
    const pixel = stack.pop()!;
    rgba[pixel * 4 + 3] = 0;
    removedPixels += 1;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) enqueue(pixel - 1);
    if (x < width - 1) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y < height - 1) enqueue(pixel + width);
  }

  return { ok: true, removedPixels };
}

// ---------------------------------------------------------------------------
// 归一化主流程
// ---------------------------------------------------------------------------

function decodeSvgSource(bytes: Uint8Array, target: ResolvedTarget, warnings: string[]): NormalizeResult {
  if (target.format === 'png') {
    throw new NormalizeError(
      `SVG 输入不能归一化为 ${target.label} 的 PNG（v1 纯 JS 不做栅格化）：请改用 PNG 源图、或选择「图标 128」SVG 档`,
    );
  }
  const sanitized = sanitizeSvg(bytes);
  if (!sanitized.ok || sanitized.svg === undefined) {
    throw new NormalizeError(sanitized.errors.join('；'));
  }
  const svgBytes = new TextEncoder().encode(sanitized.svg);
  const limit = target.maxBytes;
  if (svgBytes.length > limit) {
    throw new NormalizeError(
      `净化后 SVG 体积超限：当前 ${formatByteSize(svgBytes.length)} / 上限 ${formatByteSize(limit)}`,
    );
  }
  warnings.push('SVG 已按白名单净化并重建（保留矢量）');
  const [width, height] = SVG_VIEWBOX.split(' ').slice(2).map((value) => Number(value)) as [number, number];
  return {
    ok: true,
    target: target.id,
    bytes: svgBytes,
    format: 'svg',
    width,
    height,
    warnings,
    errors: [],
    sha256: sha256Hex(svgBytes),
    source: { width, height, format: 'svg' },
  };
}

function normalizeRaster(bytes: Uint8Array, target: ResolvedTarget, options: NormalizeOptions, warnings: string[]): NormalizeResult {
  const decoded = decodePng(bytes);
  const source: NormalizedSource = { width: decoded.width, height: decoded.height, format: 'png' };
  let rgba = decoded.rgba;
  let sourceWidth = decoded.width;
  let sourceHeight = decoded.height;

  const removeBackground = options.removeBackground ?? target.removeBackground;
  if (removeBackground) {
    const removal = removeSolidBackground(rgba, sourceWidth, sourceHeight, {
      tolerance: options.backgroundTolerance ?? 8,
      coverage: options.backgroundCoverage ?? 0.9,
    });
    if (!removal.ok && removal.reason !== undefined) {
      warnings.push(removal.reason);
    } else if (removal.ok && removal.removedPixels > 0) {
      warnings.push(`已去除纯色背景（${removal.removedPixels} 像素）`);
    }
  }

  const pixelated = options.pixelated ?? target.pixelated;
  const fit = options.fit ?? target.fit;
  const padColor = options.padColor ?? [0, 0, 0, 0];
  let canvas: Uint8Array;
  if (pixelated) {
    canvas = fitPixelated(rgba, sourceWidth, sourceHeight, target.width, target.height, warnings);
  } else {
    canvas = fitGeneric(rgba, sourceWidth, sourceHeight, target.width, target.height, fit, padColor, warnings);
  }

  // 防御：几何函数必须输出精确目标尺寸
  if (canvas.length !== target.width * target.height * 4) {
    throw new NormalizeError('归一化内部错误：输出像素长度与目标尺寸不符');
  }

  const encoded = encodePng({ width: target.width, height: target.height, rgba: canvas });
  if (encoded.length > target.maxBytes) {
    throw new NormalizeError(
      `资产体积超限：当前 ${formatByteSize(encoded.length)} / 上限 ${formatByteSize(target.maxBytes)}；` +
        '请重新生成并降档、换更简单的构图，或手动裁剪',
    );
  }
  return {
    ok: true,
    target: target.id,
    bytes: encoded,
    format: 'png',
    width: target.width,
    height: target.height,
    warnings,
    errors: [],
    sha256: sha256Hex(encoded),
    source,
  };
}

/**
 * 归一化一张图片到目标规格。
 *
 * - 输入：PNG / SVG 字节（按 magic 嗅探，拒 JPEG/WebP/GIF/BMP/TIFF）；
 * - 输出：PNG（位图）或净化后的 SVG（图标档 + SVG 输入）；
 * - 失败返回 `{ ok:false, errors[] }`（中文原因），**不抛异常**，供预览直接展示；
 * - 成功返回目标尺寸、格式、字节、sha256 与 warnings（去背失败/放大/裁剪等提示）。
 */
export function normalizeImage(
  input: NormalizeInput,
  target: NormalizeTargetId,
  options: NormalizeOptions = {},
): NormalizeResult {
  const warnings: string[] = [];
  let resolved: ResolvedTarget | undefined;
  try {
    resolved = resolveNormalizeTarget(target, options);
    const bytes = resolveInputBytes(input);
    if (bytes.length === 0) {
      throw new NormalizeError('输入为空：没有可归一化的图片数据');
    }
    const sniffed = sniffImageFormat(bytes);
    if (sniffed === 'png') {
      return normalizeRaster(bytes, resolved, options, warnings);
    }
    if (sniffed === 'svg') {
      return decodeSvgSource(bytes, resolved, warnings);
    }
    if (sniffed === 'unknown') {
      throw new NormalizeError(
        '无法识别的图片格式：v1 只支持 PNG/SVG（按文件内容 magic 判定，不看扩展名）',
      );
    }
    throw new NormalizeError(
      `v1 只支持 PNG/SVG，检测到 ${FORMAT_LABELS[sniffed]} 图片：请另存为标准 PNG 或 SVG`,
    );
  } catch (error) {
    const width = resolved?.width ?? 0;
    const height = resolved?.height ?? 0;
    return {
      ok: false,
      target,
      width,
      height,
      warnings,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
