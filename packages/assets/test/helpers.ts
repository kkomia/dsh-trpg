/**
 * 测试用图片/资产工厂（不属于公开 API；node --test 只跑 *.test.ts）。
 *
 * 手写 PNG 组装器：可指定色彩类型、位深、每行 filter、调色板/tRNS、拆 IDAT、
 * 插入未知关键块/APNG acTL、破坏 CRC、截断等，覆盖解码器的全部拒绝分支。
 */

import { deflateSync } from 'node:zlib';

export const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function typeBytes(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) out[i] = type.charCodeAt(i);
  return out;
}

export function pngChunk(type: string, data: Uint8Array, corruptCrc = false): Uint8Array {
  const typeData = typeBytes(type);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeData, 0);
  crcInput.set(data, 4);
  let crc = crc32(crcInput);
  if (corruptCrc) crc = (crc ^ 0xffffffff) >>> 0;
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out.set(typeData, 4);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc);
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
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

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

/** 正向滤波（编码侧），用于制造 filter 0–4 的测试样本。 */
export function filterRow(
  filter: number,
  row: Uint8Array,
  previous: Uint8Array | undefined,
  bytesPerPixel: number,
): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel]! : 0;
    const up = previous === undefined ? 0 : previous[i]!;
    const upLeft = previous === undefined || i < bytesPerPixel ? 0 : previous[i - bytesPerPixel]!;
    let predictor = 0;
    switch (filter) {
      case 0:
        predictor = 0;
        break;
      case 1:
        predictor = left;
        break;
      case 2:
        predictor = up;
        break;
      case 3:
        predictor = Math.floor((left + up) / 2);
        break;
      case 4:
        predictor = paeth(left, up, upLeft);
        break;
      default:
        throw new Error(`invalid filter ${filter}`);
    }
    out[i] = (row[i]! - predictor) & 0xff;
  }
  return out;
}

export interface FakePngOptions {
  width: number;
  height: number;
  colorType: 0 | 2 | 3 | 4 | 6;
  /** 未滤波的扫描行；长度必须 = width*channels */
  rows: Uint8Array[];
  /** 每行 filter（默认全 0） */
  filters?: number[];
  bitDepth?: number;
  interlace?: number;
  palette?: Uint8Array;
  trns?: Uint8Array;
  /** 插入 APNG 的 acTL 块（触发拒绝） */
  acTL?: boolean;
  /** 在 IDAT 前插入未知关键块（如 'ZZZZ'） */
  unknownCriticalChunk?: string;
  /** 省略 IDAT（缺数据） */
  omitIdat?: boolean;
  /** 省略 IEND（截断） */
  omitIend?: boolean;
  /** 把压缩数据拆成 n 个 IDAT */
  idatSplit?: number;
  /** 直接指定 IDAT 的（已压缩）数据，用于制造解压失败 */
  overrideIdat?: Uint8Array;
  /** 破坏指定块的 CRC */
  corruptCrcTypes?: string[];
  /** 在 IEND 前追加自定义块 */
  extraChunks?: Array<{ type: string; data: Uint8Array }>;
}

/** 手写组装 PNG（测试用，可制造各种坏样本）。 */
export function makePng(options: FakePngOptions): Uint8Array {
  const channels = CHANNELS[options.colorType];
  if (channels === undefined) throw new Error('bad color type');
  const bitDepth = options.bitDepth ?? 8;
  const bytesPerRow = Math.ceil((options.width * channels * bitDepth) / 8);
  const rawRows = options.rows;
  if (rawRows.length !== options.height) {
    throw new Error(`expected ${options.height} rows, got ${rawRows.length}`);
  }
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const raw = new Uint8Array(options.height * (1 + bytesPerRow));
  let position = 0;
  for (let y = 0; y < options.height; y += 1) {
    const row = rawRows[y]!;
    if (row.length !== bytesPerRow) {
      throw new Error(`row ${y} length ${row.length} != ${bytesPerRow}`);
    }
    const filter = options.filters?.[y] ?? 0;
    const filtered = filterRow(filter, row, y > 0 ? rawRows[y - 1] : undefined, bpp);
    raw[position] = filter;
    raw.set(filtered, position + 1);
    position += 1 + filtered.length;
  }

  const corrupt = new Set(options.corruptCrcTypes ?? []);
  const parts: Uint8Array[] = [SIGNATURE];

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, options.width);
  writeU32(ihdr, 4, options.height);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = options.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = options.interlace ?? 0;
  parts.push(pngChunk('IHDR', ihdr, corrupt.has('IHDR')));

  if (options.palette !== undefined) parts.push(pngChunk('PLTE', options.palette));
  if (options.trns !== undefined) parts.push(pngChunk('tRNS', options.trns));
  if (options.acTL) {
    parts.push(pngChunk('acTL', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0])));
  }
  if (options.unknownCriticalChunk !== undefined) {
    parts.push(pngChunk(options.unknownCriticalChunk, new Uint8Array([1, 2, 3])));
  }

  if (!options.omitIdat) {
    const idatData = options.overrideIdat ?? new Uint8Array(deflateSync(raw));
    const split = options.idatSplit ?? 1;
    if (split <= 1) {
      parts.push(pngChunk('IDAT', idatData, corrupt.has('IDAT')));
    } else {
      const per = Math.ceil(idatData.length / split);
      for (let index = 0; index < split; index += 1) {
        parts.push(pngChunk('IDAT', idatData.subarray(index * per, (index + 1) * per)));
      }
    }
  }

  for (const extra of options.extraChunks ?? []) {
    parts.push(pngChunk(extra.type, extra.data));
  }
  if (!options.omitIend) parts.push(pngChunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

/** 生成纯色 RGBA 像素数组。 */
export function solidRgba(
  width: number,
  height: number,
  color: [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) out.set(color, i * 4);
  return out;
}

/** 按坐标函数生成 RGBA 像素数组。 */
export function patternRgba(
  width: number,
  height: number,
  fn: (x: number, y: number) => [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out.set(fn(x, y), (y * width + x) * 4);
    }
  }
  return out;
}

/** 把 RGBA 数组拆成扫描行（colorType 6 的 makePng 入参）。 */
export function rgbaRows(rgba: Uint8Array, width: number, height: number): Uint8Array[] {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  return rows;
}

/** 用 RGBA 数组直接造一张标准 PNG（colorType 6、filter 0）。 */
export function rgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return makePng({
    width,
    height,
    colorType: 6,
    rows: rgbaRows(rgba, width, height),
  });
}

/** 取 RGBA 数组中某像素。 */
export function pixelAt(
  rgba: Uint8Array,
  width: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, rgba[offset + 3]!];
}
