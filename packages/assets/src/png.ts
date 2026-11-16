/**
 * PNG 编解码（纯 TS + `node:zlib`，零外部依赖）。
 *
 * 支持矩阵（与 [docs/UI-CONTRACT.md](../../../docs/UI-CONTRACT.md) §3.3 一致）：
 * - 位深：仅 **8-bit**（16-bit 明确拒绝，给中文可读原因）；
 * - 色彩类型：0 灰度 / 2 真彩 / 3 调色板 / 4 灰度+Alpha / 6 RGBA；
 * - 交错：仅**非交错**（Adam7 交错明确拒绝）；
 * - 透明：直接 Alpha / 调色板 tRNS / 单色 tRNS（color-key）；
 * - 多 IDAT：拼接后解压；支持 filter 0–4；
 * - 其它：CRC 全量校验；APNG（acTL）拒绝；未知**关键块**拒绝；gAMA/sRGB 等辅助块忽略。
 *
 * 编码只写标准子集：8-bit RGBA + 非交错 + 单 IDAT + 每行 filter=None + 固定 chunk 集
 * （IHDR/IDAT/IEND），`node:zlib` 固定压缩级别 → 同输入同字节、同 sha256，
 * 资产缓存与去重才有意义。
 */

import { deflateSync, inflateSync } from 'node:zlib';

/** PNG 文件签名（8 字节）。 */
export const PNG_SIGNATURE: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** 解码边界：防止恶意/异常大图把内存打爆。 */
export const PNG_LIMITS = {
  /** 单边最大值（像素） */
  maxDimension: 8192,
  /** 总像素上限（≈4096×4096，RGBA 约 64 MiB） */
  maxPixels: 16_777_216,
  /** 输入字节上限（资产单文件本来 ≤ 8 MiB，这里给宽松硬上限） */
  maxSourceBytes: 64 * 1024 * 1024,
} as const;

export type PngErrorCode =
  | 'not-png'
  | 'truncated'
  | 'bad-crc'
  | 'unsupported-bit-depth'
  | 'unsupported-interlace'
  | 'unsupported-color-type'
  | 'unsupported-chunk'
  | 'missing-chunk'
  | 'bad-filter'
  | 'bad-image-data'
  | 'dimension-limit'
  | 'invalid-argument';

/** PNG 编解码错误（`message` 为可直接展示给作者的中文原因）。 */
export class PngError extends Error {
  code: PngErrorCode;

  constructor(code: PngErrorCode, message: string) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  /** 中文色彩类型名（真彩 / 调色板 / RGBA …），便于预览展示。 */
  colorTypeName: string;
  /** true = Adam7 交错（本库解码会拒绝，但 info 仍如实返回）。 */
  interlaced: boolean;
  /** 是否带透明信息（色彩类型 4/6 或含 tRNS）。 */
  hasAlpha: boolean;
  /** 是否 APNG 动图（含 acTL 块）。 */
  apng: boolean;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** 已统一为 8-bit RGBA、非预乘、行优先，长度 = width*height*4。 */
  rgba: Uint8Array;
}

export interface EncodePngInput {
  width: number;
  height: number;
  /** 8-bit RGBA、非预乘、行优先，长度必须 = width*height*4。 */
  rgba: Uint8Array;
}

const COLOR_TYPE_NAMES: Record<number, string> = {
  0: '灰度',
  2: '真彩 RGB',
  3: '调色板',
  4: '灰度+Alpha',
  6: 'RGBA',
};

const KNOWN_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new PngError('truncated', 'PNG 数据被截断：无法读取 4 字节整数');
  }
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new PngError('truncated', 'PNG 数据被截断：无法读取 2 字节整数');
  }
  return ((bytes[offset]! << 8) | bytes[offset + 1]!) & 0xffff;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) {
    throw new PngError('truncated', 'PNG 数据被截断：无法读取块类型');
  }
  let text = '';
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(bytes[offset + i]!);
  }
  return text;
}

function bytesOfAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRC32（PNG 规范：多项式 0xEDB88320，覆盖「块类型 + 块数据」）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(seed: number, bytes: Uint8Array): number {
  let c = seed;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return c >>> 0;
}

function crc32Chunk(typeBytes: Uint8Array, data: Uint8Array): number {
  const start = 0xffffffff;
  const c = crc32Update(crc32Update(start, typeBytes), data);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 块解析
// ---------------------------------------------------------------------------

interface PngChunk {
  type: string;
  data: Uint8Array;
}

interface PngIhdr {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compression: number;
  filter: number;
  interlace: number;
}

/** 是否是 PNG（只做 8 字节签名检查，不解析块）。 */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function assertLooksLikePng(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new PngError('invalid-argument', 'PNG 输入必须是 Uint8Array');
  }
  if (bytes.length > PNG_LIMITS.maxSourceBytes) {
    throw new PngError(
      'dimension-limit',
      `PNG 文件过大（${bytes.length} 字节）：上限 ${PNG_LIMITS.maxSourceBytes} 字节`,
    );
  }
  if (!isPng(bytes)) {
    throw new PngError('not-png', '不是合法的 PNG 文件：文件签名不符（magic 嗅探失败）');
  }
}

function readChunks(bytes: Uint8Array): PngChunk[] {
  assertLooksLikePng(bytes);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new PngError('truncated', 'PNG 数据被截断：块头不完整');
    }
    const length = readU32(bytes, offset);
    if (length > 0x7fffffff) {
      throw new PngError('truncated', 'PNG 数据损坏：块长度非法');
    }
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new PngError('truncated', 'PNG 数据被截断：块数据不完整');
    }
    const type = ascii(bytes, offset + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new PngError('truncated', `PNG 数据损坏：非法块类型 ${JSON.stringify(type)}`);
    }
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = readU32(bytes, offset + 8 + length);
    const actualCrc = crc32Chunk(bytesOfAscii(type), data);
    if (expectedCrc !== actualCrc) {
      throw new PngError('bad-crc', `PNG 块 ${type} 的 CRC 校验失败：文件已损坏或被截断`);
    }
    chunks.push({ type, data });
    offset = end;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  if (!sawIend) {
    throw new PngError('missing-chunk', 'PNG 文件缺少 IEND 块：文件可能被截断');
  }
  return chunks;
}

function parseIhdr(data: Uint8Array): PngIhdr {
  if (data.length !== 13) {
    throw new PngError('bad-image-data', `PNG 的 IHDR 块长度应为 13，实际 ${data.length}`);
  }
  const ihdr: PngIhdr = {
    width: readU32(data, 0),
    height: readU32(data, 4),
    bitDepth: data[8]!,
    colorType: data[9]!,
    compression: data[10]!,
    filter: data[11]!,
    interlace: data[12]!,
  };
  const name = COLOR_TYPE_NAMES[ihdr.colorType];
  if (name === undefined) {
    throw new PngError(
      'unsupported-color-type',
      `PNG 色彩类型 ${ihdr.colorType} 不受支持（v1 只接受灰度/真彩/调色板/灰度+Alpha/RGBA 的 8-bit 图）`,
    );
  }
  if (ihdr.bitDepth !== 8) {
    if (ihdr.bitDepth === 16) {
      throw new PngError('unsupported-bit-depth', 'PNG 位深为 16-bit，不受支持：请导出 8-bit PNG');
    }
    throw new PngError(
      'unsupported-bit-depth',
      `PNG 位深为 ${ihdr.bitDepth}-bit，不受支持：v1 只接受 8-bit PNG`,
    );
  }
  if (ihdr.compression !== 0) {
    throw new PngError('unsupported-chunk', `PNG 压缩方法 ${ihdr.compression} 不受支持（仅支持 0）`);
  }
  if (ihdr.filter !== 0) {
    throw new PngError('unsupported-chunk', `PNG 滤波方法 ${ihdr.filter} 不受支持（仅支持 0）`);
  }
  if (ihdr.interlace !== 0) {
    if (ihdr.interlace === 1) {
      throw new PngError(
        'unsupported-interlace',
        'PNG 为 Adam7 交错编码，v1 只支持非交错 PNG：请另存为非交错 PNG',
      );
    }
    throw new PngError('unsupported-interlace', `PNG 交错方法 ${ihdr.interlace} 不受支持`);
  }
  if (ihdr.width === 0 || ihdr.height === 0) {
    throw new PngError('bad-image-data', 'PNG 宽高不能为 0');
  }
  if (ihdr.width > PNG_LIMITS.maxDimension || ihdr.height > PNG_LIMITS.maxDimension) {
    throw new PngError(
      'dimension-limit',
      `PNG 尺寸 ${ihdr.width}×${ihdr.height} 超过上限（单边 ≤ ${PNG_LIMITS.maxDimension}）`,
    );
  }
  if (ihdr.width * ihdr.height > PNG_LIMITS.maxPixels) {
    throw new PngError(
      'dimension-limit',
      `PNG 像素总量 ${ihdr.width}×${ihdr.height} 超过上限 ${PNG_LIMITS.maxPixels}`,
    );
  }
  return ihdr;
}

function channelsFor(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new PngError('unsupported-color-type', `PNG 色彩类型 ${colorType} 不支持`);
  }
}

function findChunk(chunks: PngChunk[], type: string): PngChunk | undefined {
  return chunks.find((chunk) => chunk.type === type);
}

/**
 * 读取 PNG 头信息（宽高、位深、色彩类型、是否带透明、是否 APNG）。
 * 不重建像素，只做结构校验（含 CRC），用于「原尺寸」预览与上传前预检。
 */
export function readPngInfo(bytes: Uint8Array): PngInfo {
  const chunks = readChunks(bytes);
  const ihdrChunk = chunks[0];
  if (ihdrChunk === undefined || ihdrChunk.type !== 'IHDR') {
    throw new PngError('missing-chunk', 'PNG 首个块必须是 IHDR');
  }
  const ihdr = parseIhdr(ihdrChunk.data);
  const hasTrns = findChunk(chunks, 'tRNS') !== undefined;
  return {
    width: ihdr.width,
    height: ihdr.height,
    bitDepth: ihdr.bitDepth,
    colorType: ihdr.colorType,
    colorTypeName: COLOR_TYPE_NAMES[ihdr.colorType] ?? '未知',
    interlaced: ihdr.interlace !== 0,
    hasAlpha: ihdr.colorType === 4 || ihdr.colorType === 6 || hasTrns,
    apng: findChunk(chunks, 'acTL') !== undefined,
  };
}

/**
 * 解码 PNG → 统一 8-bit RGBA。
 *
 * 拒绝（抛 `PngError`，`message` 为中文）：16-bit、Adam7 交错、APNG、坏 CRC、
 * 截断、未知关键块、非法 filter、调色板缺失/索引越界等。
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const chunks = readChunks(bytes);
  const ihdrChunk = chunks[0];
  if (ihdrChunk === undefined || ihdrChunk.type !== 'IHDR') {
    throw new PngError('missing-chunk', 'PNG 首个块必须是 IHDR');
  }
  const ihdr = parseIhdr(ihdrChunk.data);

  if (findChunk(chunks, 'acTL') !== undefined) {
    throw new PngError(
      'unsupported-chunk',
      'PNG 是 APNG 动图（含 acTL 块），v1 不支持动画：请导出静态 PNG',
    );
  }

  let palette: Uint8Array | undefined;
  let paletteTrns: Uint8Array | undefined;
  let colorKey: Uint8Array | undefined;
  const idatParts: Uint8Array[] = [];

  for (const chunk of chunks) {
    const { type } = chunk;
    if (type === 'IHDR' || type === 'IEND') continue;
    if (type === 'IDAT') {
      idatParts.push(chunk.data);
      continue;
    }
    if (type === 'PLTE') {
      if (chunk.data.length === 0 || chunk.data.length % 3 !== 0 || chunk.data.length > 768) {
        throw new PngError(
          'bad-image-data',
          `PNG 调色板 PLTE 长度非法（${chunk.data.length}，应为 3 的倍数且 ≤ 768）`,
        );
      }
      palette = chunk.data;
      continue;
    }
    if (type === 'tRNS') {
      if (ihdr.colorType === 3) {
        paletteTrns = chunk.data;
      } else {
        colorKey = chunk.data;
      }
      continue;
    }
    const isCritical = type.charCodeAt(0) < 0x61;
    if (isCritical && !KNOWN_CRITICAL_CHUNKS.has(type)) {
      throw new PngError(
        'unsupported-chunk',
        `PNG 含不受支持的必需块 ${JSON.stringify(type)}，无法安全解码`,
      );
    }
    // 其余辅助块（gAMA/sRGB/iCCP/pHYs/tEXt…）一律忽略
  }

  if (idatParts.length === 0) {
    throw new PngError('missing-chunk', 'PNG 缺少 IDAT 图像数据块');
  }
  if (ihdr.colorType === 3 && palette === undefined) {
    throw new PngError('missing-chunk', '调色板 PNG 缺少 PLTE 块');
  }

  const bytesPerPixel = channelsFor(ihdr.colorType);
  const stride = ihdr.width * bytesPerPixel;
  const expectedRawLength = ihdr.height * (stride + 1);

  let raw: Uint8Array;
  try {
    raw = inflateSync(concatBytes(idatParts));
  } catch {
    throw new PngError('bad-image-data', 'PNG 图像数据解压失败：IDAT 数据损坏或被截断');
  }
  if (raw.length < expectedRawLength) {
    throw new PngError(
      'bad-image-data',
      `PNG 图像数据被截断：解压后 ${raw.length} 字节，应为 ${expectedRawLength} 字节`,
    );
  }
  if (raw.length > expectedRawLength) {
    throw new PngError(
      'bad-image-data',
      `PNG 图像数据长度不符：解压后 ${raw.length} 字节，应为 ${expectedRawLength} 字节`,
    );
  }

  // 反滤波（filter 0–4），逐行
  const pixels = new Uint8Array(ihdr.height * stride);
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < ihdr.height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    if (filter > 4) {
      throw new PngError('bad-filter', `PNG 第 ${y + 1} 行 filter=${filter} 非法（仅支持 0–4）`);
    }
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const x = raw[rowStart + 1 + i]!;
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel]! : 0;
      const up = prevRow[i]!;
      const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + left;
          break;
        case 2:
          value = x + up;
          break;
        case 3:
          value = x + Math.floor((left + up) / 2);
          break;
        default:
          value = x + paeth(left, up, upLeft);
          break;
      }
      row[i] = value & 0xff;
    }
    pixels.set(row, y * stride);
    prevRow = row;
  }

  // 统一转 8-bit RGBA
  const { width, height } = ihdr;
  const rgba = new Uint8Array(width * height * 4);
  const pixelCount = width * height;

  switch (ihdr.colorType) {
    case 0: {
      // tRNS 对灰度图是 2 字节大端灰度值（8-bit 图高字节恒 0）
      const keyGray =
        colorKey !== undefined && colorKey.length >= 2
          ? (readU16(colorKey, 0) & 0xff)
          : -1;
      for (let i = 0; i < pixelCount; i += 1) {
        const gray = pixels[i]!;
        rgba[i * 4] = gray;
        rgba[i * 4 + 1] = gray;
        rgba[i * 4 + 2] = gray;
        rgba[i * 4 + 3] = gray === keyGray ? 0 : 255;
      }
      break;
    }
    case 2: {
      // tRNS 对真彩图是 6 字节：R/G/B 各 2 字节大端
      const keyR = colorKey !== undefined && colorKey.length >= 6 ? readU16(colorKey, 0) & 0xff : -1;
      const keyG = colorKey !== undefined && colorKey.length >= 6 ? readU16(colorKey, 2) & 0xff : -1;
      const keyB = colorKey !== undefined && colorKey.length >= 6 ? readU16(colorKey, 4) & 0xff : -1;
      for (let i = 0; i < pixelCount; i += 1) {
        const r = pixels[i * 3]!;
        const g = pixels[i * 3 + 1]!;
        const b = pixels[i * 3 + 2]!;
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = r === keyR && g === keyG && b === keyB ? 0 : 255;
      }
      break;
    }
    case 3: {
      const entries = palette!.length / 3;
      for (let i = 0; i < pixelCount; i += 1) {
        const index = pixels[i]!;
        if (index >= entries) {
          throw new PngError(
            'bad-image-data',
            `PNG 调色板索引 ${index} 越界（调色板只有 ${entries} 色）`,
          );
        }
        rgba[i * 4] = palette![index * 3]!;
        rgba[i * 4 + 1] = palette![index * 3 + 1]!;
        rgba[i * 4 + 2] = palette![index * 3 + 2]!;
        const alpha = paletteTrns !== undefined && index < paletteTrns.length ? paletteTrns[index]! : 255;
        rgba[i * 4 + 3] = alpha;
      }
      break;
    }
    case 4: {
      for (let i = 0; i < pixelCount; i += 1) {
        const gray = pixels[i * 2]!;
        rgba[i * 4] = gray;
        rgba[i * 4 + 1] = gray;
        rgba[i * 4 + 2] = gray;
        rgba[i * 4 + 3] = pixels[i * 2 + 1]!;
      }
      break;
    }
    default: {
      for (let i = 0; i < pixelCount; i += 1) {
        rgba[i * 4] = pixels[i * 4]!;
        rgba[i * 4 + 1] = pixels[i * 4 + 1]!;
        rgba[i * 4 + 2] = pixels[i * 4 + 2]!;
        rgba[i * 4 + 3] = pixels[i * 4 + 3]!;
      }
      break;
    }
  }

  return { width, height, rgba };
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = bytesOfAscii(type);
  const chunk = new Uint8Array(12 + data.length);
  writeU32(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  writeU32(chunk, 8 + data.length, crc32Chunk(typeBytes, data));
  return chunk;
}

/**
 * 编码 PNG（固定输出 8-bit RGBA + 非交错 + 单 IDAT + 每行 filter=None）。
 *
 * 输出字节确定：同一输入（宽高 + 像素）永远得到同一份字节与同一 sha256。
 */
export function encodePng(input: EncodePngInput): Uint8Array {
  if (input === null || typeof input !== 'object') {
    throw new PngError('invalid-argument', 'encodePng 需要 { width, height, rgba } 对象');
  }
  const { width, height, rgba } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PngError('invalid-argument', `PNG 宽高必须为正整数，收到 ${width}×${height}`);
  }
  if (width > PNG_LIMITS.maxDimension || height > PNG_LIMITS.maxDimension) {
    throw new PngError(
      'dimension-limit',
      `PNG 尺寸 ${width}×${height} 超过上限（单边 ≤ ${PNG_LIMITS.maxDimension}）`,
    );
  }
  if (width * height > PNG_LIMITS.maxPixels) {
    throw new PngError(
      'dimension-limit',
      `PNG 像素总量 ${width}×${height} 超过上限 ${PNG_LIMITS.maxPixels}`,
    );
  }
  if (!(rgba instanceof Uint8Array)) {
    throw new PngError('invalid-argument', 'encodePng 的 rgba 必须是 Uint8Array');
  }
  if (rgba.length !== width * height * 4) {
    throw new PngError(
      'invalid-argument',
      `RGBA 数据长度 ${rgba.length} 与 ${width}×${height}×4 = ${width * height * 4} 不符`,
    );
  }

  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const offset = y * (stride + 1);
    raw[offset] = 0; // filter None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), offset + 1);
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const compressed = deflateSync(raw, { level: 9 });
  const idat = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);

  return concatBytes([
    PNG_SIGNATURE,
    encodeChunk('IHDR', ihdr),
    encodeChunk('IDAT', idat),
    encodeChunk('IEND', new Uint8Array(0)),
  ]);
}
