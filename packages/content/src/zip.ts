/**
 * 最小 ZIP 读写（零外部依赖，只用 `node:zlib` + 内置 Buffer）。
 *
 * 只实现内容包场景需要的子集（CONTENT-MODEL §2.2）：
 * - 写：stored(0) / deflate(8)，固定 DOS 时间戳 1980-01-01、UTF-8 文件名标志、
 *   无 extra/comment/数据描述符 → 同一输入产出字节一致的 zip（可复现）；
 * - 读：从尾部 EOCD 找中央目录，按偏移读 local header；大小/CRC 以中央目录为准，
 *   容忍 bit 3 数据描述符（local 的 size 为 0 不算错）；拒绝加密、zip64、重复条目、
 *   绝对路径/`..`/控制字符、非常规压缩方法；逐条重算 CRC32；
 * - 防压缩炸弹：整包 / 单条目 / 条目数 / 解压总量上限，解压时再叠 maxOutputLength。
 *
 * 该模块属于 host/Node 侧能力（zlib），不进入浏览器 bundle：
 * 插件 client 侧只从 `@dsh-trpg/content` 的纯数据模块取内容，见 `package.json` 的 exports。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** zip 读取上限（CONTENT-MODEL §2.2；单测直接断言这些常量）。 */
export const ZIP_LIMITS = {
  /** 整个 .trpgpack 文件 ≤ 16 MiB。 */
  maxArchiveBytes: 16 * 1024 * 1024,
  /** pack.json 解压后 ≤ 4 MiB。 */
  maxPackJsonBytes: 4 * 1024 * 1024,
  /** 单条目解压后 ≤ 8 MiB。 */
  maxEntryBytes: 8 * 1024 * 1024,
  /** 条目数 ≤ 512。 */
  maxEntries: 512,
  /** 解压总量 ≤ 32 MiB。 */
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
} as const;

export type ZipErrorCode =
  | 'not-zip'
  | 'corrupt'
  | 'zip64'
  | 'encrypted'
  | 'unsupported-method'
  | 'limit'
  | 'path'
  | 'duplicate'
  | 'crc';

export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
/** DOS 时间 1980-01-01 00:00:00：date = (1980-1980)<<9 | 1<<5 | 1，time = 0。 */
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
/** 通用标志 bit 11：文件名 UTF-8。 */
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 标准 CRC32（IEEE 802.3，与 zip 的 crc-32 一致）。 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index] as number;
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  /** 解压后的原始字节。 */
  data: Uint8Array;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ReadZipResult {
  entries: Map<string, ZipEntry>;
  warnings: string[];
}

export type ZipReadLimits = typeof ZIP_LIMITS;

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function requireRange(bytes: Uint8Array, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new ZipError('corrupt', `${what}越界（offset=${offset}, length=${length}, 文件大小=${bytes.length}）`);
  }
}

/**
 * 规范化并校验一个 zip 条目名：`\` → `/`、NFC、拒绝绝对路径 / 盘符 / `..` / 空段 / 控制字符。
 * 返回值是规范化后的路径；warning 通过返回值带出（由调用方汇总）。
 */
export function normalizeEntryPath(rawName: string): { path: string; warnings: string[] } {
  const warnings: string[] = [];
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new ZipError('path', 'zip 条目名为空');
  }
  let name = rawName;
  if (name.includes('\\')) {
    name = name.replaceAll('\\', '/');
    warnings.push(`zip 条目名含反斜杠，已规范化为 /：${rawName}`);
  }
  name = name.normalize('NFC');
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ZipError('path', `zip 条目名包含控制字符：${JSON.stringify(rawName)}`);
  }
  if (name.startsWith('/')) throw new ZipError('path', `zip 条目名不能是绝对路径：${rawName}`);
  if (/^[A-Za-z]:/.test(name)) throw new ZipError('path', `zip 条目名不能带盘符：${rawName}`);
  if (name.startsWith('//')) throw new ZipError('path', `zip 条目名不能是 UNC 路径：${rawName}`);
  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new ZipError('path', `zip 条目名包含非法路径段（空段 / . / ..）：${rawName}`);
  }
  return { path: name, warnings };
}

function decodeEntryName(nameBytes: Uint8Array, flags: number, warnings: string[]): string {
  let decoded: string;
  try {
    decoded = UTF8_DECODER.decode(nameBytes);
  } catch {
    throw new ZipError('path', 'zip 条目名不是合法的 UTF-8（v1 只接受 UTF-8 文件名）');
  }
  if ((flags & FLAG_UTF8) === 0) warnings.push(`zip 条目未声明 UTF-8 文件名标志（仍按 UTF-8 解析）：${decoded}`);
  const normalized = normalizeEntryPath(decoded);
  warnings.push(...normalized.warnings);
  return normalized.path;
}

function isDirectoryName(rawName: string): boolean {
  return rawName.endsWith('/') || rawName.endsWith('\\');
}

/**
 * 读取一个 ZIP。结构错误 / 超限 / 路径不安全 / CRC 不符都会抛 `ZipError`；
 * 可容忍的异常（目录条目、非 UTF-8 标志、local 与中央目录不一致）进 warnings。
 */
export function readZip(bytes: Uint8Array, limits: ZipReadLimits = ZIP_LIMITS): ReadZipResult {
  const warnings: string[] = [];
  if (!(bytes instanceof Uint8Array)) throw new ZipError('not-zip', 'zip 输入必须是 Uint8Array');
  if (bytes.length > limits.maxArchiveBytes) {
    throw new ZipError('limit', `包过大：${bytes.length} 字节，上限 ${limits.maxArchiveBytes} 字节（< 16 MiB）`);
  }
  if (bytes.length < EOCD_SIZE) throw new ZipError('not-zip', '不是有效的 ZIP：文件太小，找不到中央目录结尾');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  const scanFloor = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
  for (let offset = bytes.length - EOCD_SIZE; offset >= scanFloor; offset -= 1) {
    if (u32(view, offset) === SIG_EOCD) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new ZipError('not-zip', '不是有效的 ZIP：找不到中央目录结尾（EOCD）');

  const commentLength = u16(view, eocdOffset + 20);
  if (eocdOffset + EOCD_SIZE + commentLength !== bytes.length) {
    throw new ZipError('corrupt', 'ZIP 结尾有多余数据（EOCD 注释长度与实际文件长度不符）');
  }
  if (eocdOffset >= 20 && u32(view, eocdOffset - 20) === SIG_ZIP64_LOCATOR) {
    throw new ZipError('zip64', '不支持 zip64 内容包（v1 要求包 < 4 GiB）');
  }

  const diskNumber = u16(view, eocdOffset + 4);
  const centralDisk = u16(view, eocdOffset + 6);
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new ZipError('corrupt', '不支持分卷 ZIP（v1 只接受单文件单卷）');
  }
  const entryCount = u16(view, eocdOffset + 10);
  const centralSize = u32(view, eocdOffset + 12);
  const centralOffset = u32(view, eocdOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('zip64', '不支持 zip64 内容包（v1 要求包 < 4 GiB）');
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError('limit', `ZIP 条目数超限：${entryCount} / 上限 ${limits.maxEntries}`);
  }
  if (centralOffset + centralSize > eocdOffset) {
    throw new ZipError('corrupt', 'ZIP 中央目录偏移越界（文件可能被截断）');
  }

  const entries = new Map<string, ZipEntry>();
  const seenNames = new Set<string>();
  let pointer = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    requireRange(bytes, pointer, 46, `中央目录第 ${index + 1} 项`);
    if (u32(view, pointer) !== SIG_CENTRAL) {
      throw new ZipError('corrupt', `中央目录第 ${index + 1} 项签名错误（不是 PK\\x01\\x02）`);
    }
    const flags = u16(view, pointer + 8);
    const method = u16(view, pointer + 10);
    const entryCrc = u32(view, pointer + 16);
    const compressedSize = u32(view, pointer + 20);
    const uncompressedSize = u32(view, pointer + 24);
    const nameLength = u16(view, pointer + 28);
    const extraLength = u16(view, pointer + 30);
    const commentLen = u16(view, pointer + 32);
    const diskStart = u16(view, pointer + 34);
    const localOffset = u32(view, pointer + 42);
    const recordEnd = pointer + 46 + nameLength + extraLength + commentLen;
    requireRange(bytes, pointer + 46, nameLength + extraLength + commentLen, `中央目录第 ${index + 1} 项内容`);

    const rawNameBytes = bytes.subarray(pointer + 46, pointer + 46 + nameLength);
    const rawName = (() => {
      try {
        return UTF8_DECODER.decode(rawNameBytes);
      } catch {
        throw new ZipError('path', `第 ${index + 1} 个条目名不是合法的 UTF-8`);
      }
    })();
    pointer = recordEnd;

    if ((flags & 0x0001) !== 0) {
      throw new ZipError('encrypted', `ZIP 条目已加密，v1 不支持：${rawName}`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64', `条目使用 zip64 扩展（包过大）：${rawName}`);
    }
    if (diskStart !== 0) throw new ZipError('corrupt', `不支持的跨盘条目：${rawName}`);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError('unsupported-method', `不支持的压缩方式 ${method}（只接受 0 stored / 8 deflate）：${rawName}`);
    }
    if (isDirectoryName(rawName)) {
      warnings.push(`忽略目录条目：${rawName}`);
      continue;
    }

    const name = decodeEntryName(rawNameBytes, flags, warnings);
    const duplicateKey = name.toLowerCase();
    if (seenNames.has(duplicateKey)) {
      throw new ZipError('duplicate', `ZIP 内条目名重复（大小写不敏感）：${name}`);
    }
    seenNames.add(duplicateKey);

    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ZipError(
        'limit',
        `条目 "${name}" 解压后 ${uncompressedSize} 字节，超过单条目上限 ${limits.maxEntryBytes} 字节`,
      );
    }
    if (totalUncompressed + uncompressedSize > limits.maxTotalUncompressedBytes) {
      throw new ZipError(
        'limit',
        `解压总量超限：已累计 ${totalUncompressed} + ${uncompressedSize} / 上限 ${limits.maxTotalUncompressedBytes} 字节`,
      );
    }

    // local header（大小/CRC 以中央目录为准；local 冲突只记 warning）
    requireRange(bytes, localOffset, 30, `条目 "${name}" local header`);
    if (u32(view, localOffset) !== SIG_LOCAL) {
      throw new ZipError('corrupt', `条目 "${name}" 的 local header 签名错误`);
    }
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    if ((localFlags & 0x0001) !== 0) throw new ZipError('encrypted', `ZIP 条目已加密，v1 不支持：${name}`);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    if (localMethod !== method) {
      warnings.push(`条目 "${name}" 的 local 压缩方式(${localMethod})与中央目录(${method})不一致，以中央目录为准`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(bytes, dataStart, compressedSize, `条目 "${name}" 数据区`);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === METHOD_STORED) {
      if (compressedSize !== uncompressedSize) {
        throw new ZipError('corrupt', `stored 条目 "${name}" 的压缩/解压大小不一致`);
      }
      data = compressed.slice();
    } else {
      const remaining = limits.maxTotalUncompressedBytes - totalUncompressed;
      const maxOutputLength = Math.min(limits.maxEntryBytes, Math.max(remaining, 0));
      if (maxOutputLength <= 0) {
        throw new ZipError('limit', `解压总量超限（上限 ${limits.maxTotalUncompressedBytes} 字节）`);
      }
      try {
        const inflated = inflateRawSync(compressed, { maxOutputLength });
        data = new Uint8Array(inflated);
      } catch (error) {
        if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipError('limit', `条目 "${name}" 解压后超过上限（防压缩炸弹）`);
        }
        throw new ZipError(
          'corrupt',
          `第 ${index + 1} 个条目（${name}）deflate 解压失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (data.length !== uncompressedSize) {
      throw new ZipError(
        'corrupt',
        `条目 "${name}" 解压后大小 ${data.length} 与中央目录声明 ${uncompressedSize} 不一致`,
      );
    }
    const actualCrc = crc32(data);
    if (actualCrc !== entryCrc) {
      throw new ZipError(
        'crc',
        `第 ${index + 1} 个条目（${name}）CRC 校验失败：期望 ${entryCrc.toString(16)}，实际 ${actualCrc.toString(16)}`,
      );
    }
    totalUncompressed += data.length;
    entries.set(name, {
      name,
      data,
      method,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
    });
  }

  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export interface ZipWriteEntry {
  name: string;
  data: Uint8Array;
  /** 缺省用 deflate；素材里已压缩的格式可显式用 stored。 */
  method?: 'stored' | 'deflate';
}

export interface ZipWriteOptions {
  /** zlib 压缩级别，固定默认 6（同一输入 → 同一输出）。 */
  deflateLevel?: number;
}

function writeU16(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt16LE(value, offset);
}

function writeU32(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value, offset);
}

/**
 * 写一个 ZIP（条目顺序即传入顺序）。固定时间戳/标志/无 extra → 可复现。
 * 条目名会做与读取相同的安全校验；不安全路径/重复名直接抛 `ZipError`。
 */
export function writeZip(entries: readonly ZipWriteEntry[], options: ZipWriteOptions = {}): Uint8Array {
  if (entries.length > ZIP_LIMITS.maxEntries) {
    throw new ZipError('limit', `ZIP 条目数超限：${entries.length} / 上限 ${ZIP_LIMITS.maxEntries}`);
  }
  const level = options.deflateLevel ?? 6;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seenNames = new Set<string>();
  let offset = 0;
  let totalUncompressed = 0;

  for (const entry of entries) {
    const { path } = normalizeEntryPath(entry.name);
    const duplicateKey = path.toLowerCase();
    if (seenNames.has(duplicateKey)) throw new ZipError('duplicate', `ZIP 内条目名重复（大小写不敏感）：${path}`);
    seenNames.add(duplicateKey);

    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    if (data.length > ZIP_LIMITS.maxEntryBytes) {
      throw new ZipError('limit', `条目 "${path}" 过大：${data.length} / 上限 ${ZIP_LIMITS.maxEntryBytes} 字节`);
    }
    totalUncompressed += data.length;
    if (totalUncompressed > ZIP_LIMITS.maxTotalUncompressedBytes) {
      throw new ZipError('limit', `解压总量超限：上限 ${ZIP_LIMITS.maxTotalUncompressedBytes} 字节`);
    }

    const method = entry.method ?? 'deflate';
    const compressed = method === 'stored' ? Buffer.from(data) : deflateRawSync(data, { level });
    const methodCode = method === 'stored' ? METHOD_STORED : METHOD_DEFLATE;
    const nameBytes = Buffer.from(path, 'utf8');
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    writeU32(localHeader, 0, SIG_LOCAL);
    writeU16(localHeader, 4, 20);
    writeU16(localHeader, 6, FLAG_UTF8);
    writeU16(localHeader, 8, methodCode);
    writeU16(localHeader, 10, DOS_TIME);
    writeU16(localHeader, 12, DOS_DATE);
    writeU32(localHeader, 14, crc);
    writeU32(localHeader, 18, compressed.length);
    writeU32(localHeader, 22, data.length);
    writeU16(localHeader, 26, nameBytes.length);
    writeU16(localHeader, 28, 0);

    locals.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    writeU32(centralHeader, 0, SIG_CENTRAL);
    writeU16(centralHeader, 4, 20);
    writeU16(centralHeader, 6, 20);
    writeU16(centralHeader, 8, FLAG_UTF8);
    writeU16(centralHeader, 10, methodCode);
    writeU16(centralHeader, 12, DOS_TIME);
    writeU16(centralHeader, 14, DOS_DATE);
    writeU32(centralHeader, 16, crc);
    writeU32(centralHeader, 20, compressed.length);
    writeU32(centralHeader, 24, data.length);
    writeU16(centralHeader, 28, nameBytes.length);
    writeU16(centralHeader, 30, 0);
    writeU16(centralHeader, 32, 0);
    writeU16(centralHeader, 34, 0);
    writeU16(centralHeader, 36, 0);
    writeU32(centralHeader, 38, 0);
    writeU32(centralHeader, 42, offset);
    centrals.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const localData = Buffer.concat(locals);
  const eocd = Buffer.alloc(EOCD_SIZE);
  writeU32(eocd, 0, SIG_EOCD);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, centralDirectory.length);
  writeU32(eocd, 16, localData.length);
  writeU16(eocd, 20, 0);

  return new Uint8Array(Buffer.concat([localData, centralDirectory, eocd]));
}
