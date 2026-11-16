/**
 * `.trpgpack` 编解码：ZIP 容器（`pack.json` + 可选 `assets/**`）↔ `ContentPack`。
 *
 * 对外主 API（M8.2 host / M8.3 UI 共用）：
 * - `packToTrpgpack(pack, { assets })` → `Uint8Array`（导出前先 `validatePack()`，不合法抛错）；
 * - `trpgpackToPack(bytes)` → `{ ok, pack?, errors, warnings, assets, contentHash, packHash }`
 *   （不抛异常，坏包给中文可读错误，导入方决定是否落盘）；
 * - `encodePackZip` / `decodePackZip` 是 CONTENT-MODEL §2.2 里约定的别名；
 * - `trpgpackFileName(pack)` → `<packId>-<version>.trpgpack`。
 *
 * 可复现（CONTENT-MODEL §2.2）：pack.json 写成「键排序 + 无空白」的规范化 JSON，条目顺序固定
 * （pack.json 第一、assets 按路径字典序），时间戳/压缩级别固定 → 同一 pack 导出字节一致；
 * `contentHash = sha256(规范化 pack.json)`，`packHash = sha256(zip 字节)`。
 */
import { createHash } from 'node:crypto';
import { validatePack, migratePack, PackValidationError, type ContentPack } from './pack.ts';
import { readZip, writeZip, ZipError, ZIP_LIMITS, type ZipWriteEntry } from './zip.ts';

export const PACK_JSON_ENTRY = 'pack.json';
export const ASSET_ENTRY_PREFIX = 'assets/';

/** 素材输入：`assets/xxx.png` → 字节。也接受 Record（字符串按 UTF-8 编码）。 */
export type AssetsInput = Map<string, Uint8Array> | Record<string, Uint8Array | string>;

export interface PackEncodeOptions {
  assets?: AssetsInput;
}

export interface TrpgpackDecodeResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  pack?: ContentPack;
  assets: Map<string, Uint8Array>;
  /** sha256(规范化 pack.json 字节)，供房间快照比对。 */
  contentHash?: string;
  /** sha256(zip 字节)，用于断言导出可复现。 */
  packHash?: string;
}

const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 规范化 JSON：对象键递归排序、去掉 undefined、无空白（跨机器字节稳定）。 */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map((item) => (item === undefined ? null : canonicalize(item)));
    if (isRecord(input)) {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        const item = input[key];
        if (item !== undefined) output[key] = canonicalize(item);
      }
      return output;
    }
    return input;
  };
  return utf8Encoder.encode(JSON.stringify(canonicalize(value)));
}

/** 内容指纹：`sha256(规范化 pack.json 字节)`，不含 zip 元数据（CONTENT-MODEL §2.1）。 */
export function contentHashOfPack(pack: ContentPack): string {
  return sha256Hex(canonicalJsonBytes(pack));
}

/** 整包指纹：`sha256(zip 字节)`，用于断言导出可复现。 */
export function packHashOfBytes(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** 导出文件名：`<packId>-<version>.trpgpack`。 */
export function trpgpackFileName(pack: Pick<ContentPack, 'packId' | 'version'>): string {
  return `${pack.packId}-${pack.version}.trpgpack`;
}

function normalizeAssets(input: AssetsInput | undefined): Map<string, Uint8Array> {
  const output = new Map<string, Uint8Array>();
  if (input === undefined) return output;
  const rawEntries: Array<[string, Uint8Array | string]> =
    input instanceof Map ? [...input.entries()] : Object.entries(input);
  let totalBytes = 0;
  for (const [rawName, rawData] of rawEntries) {
    const name = typeof rawName === 'string' ? rawName.replaceAll('\\', '/') : '';
    if (!name.startsWith(ASSET_ENTRY_PREFIX)) {
      throw new PackValidationError([`素材路径必须以 ${ASSET_ENTRY_PREFIX} 开头：${String(rawName)}`]);
    }
    if (name === PACK_JSON_ENTRY) throw new PackValidationError(['素材不能占用 pack.json 这个条目名']);
    const data = typeof rawData === 'string' ? utf8Encoder.encode(rawData) : rawData;
    if (!(data instanceof Uint8Array)) {
      throw new PackValidationError([`素材 "${name}" 的内容必须是 Uint8Array 或字符串`]);
    }
    if (data.length > ZIP_LIMITS.maxEntryBytes) {
      throw new PackValidationError([
        `素材 "${name}" 过大：${data.length} 字节，上限 ${ZIP_LIMITS.maxEntryBytes} 字节`,
      ]);
    }
    totalBytes += data.length;
    if (totalBytes > ZIP_LIMITS.maxTotalUncompressedBytes) {
      throw new PackValidationError([`素材总量超限：上限 ${ZIP_LIMITS.maxTotalUncompressedBytes} 字节`]);
    }
    const key = name.toLowerCase();
    for (const existing of output.keys()) {
      if (existing.toLowerCase() === key) throw new PackValidationError([`素材路径重复：${name}`]);
    }
    output.set(name, data);
  }
  if (output.size + 1 > ZIP_LIMITS.maxEntries) {
    throw new PackValidationError([`素材条目数超限：${output.size} / 上限 ${ZIP_LIMITS.maxEntries - 1}`]);
  }
  return output;
}

/** 已压缩格式用 stored，其余（文本/未知）用 deflate——只在导出侧决定，读取侧两种都支持。 */
const STORED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.zip', '.gz', '.woff2'];

function assetMethod(path: string): 'stored' | 'deflate' {
  const lower = path.toLowerCase();
  return STORED_EXTENSIONS.some((extension) => lower.endsWith(extension)) ? 'stored' : 'deflate';
}

/**
 * 把一个内容包编码成 `.trpgpack` 字节。
 * 先跑 `validatePack()`（含素材引用存在性）；校验不过抛 `PackValidationError`，不产出半成品。
 */
export function packToTrpgpack(pack: ContentPack, options: PackEncodeOptions = {}): Uint8Array {
  const assets = normalizeAssets(options.assets);
  const report = validatePack(pack, { assetPaths: [...assets.keys()] });
  if (!report.ok) throw new PackValidationError(report.errors);

  const packJson = canonicalJsonBytes(pack);
  if (packJson.length > ZIP_LIMITS.maxPackJsonBytes) {
    throw new PackValidationError([
      `pack.json 解压后 ${packJson.length} 字节，超过上限 ${ZIP_LIMITS.maxPackJsonBytes} 字节`,
    ]);
  }

  const entries: ZipWriteEntry[] = [{ name: PACK_JSON_ENTRY, data: packJson, method: 'deflate' }];
  for (const assetPath of [...assets.keys()].sort()) {
    entries.push({ name: assetPath, data: assets.get(assetPath) as Uint8Array, method: assetMethod(assetPath) });
  }
  return writeZip(entries);
}

/**
 * 解码 `.trpgpack`：zip 结构 → `pack.json` → 迁移 → 校验。不抛异常，错误聚合返回。
 * 未列入 `assets/**` 的条目记 warning 后忽略（兼容 `__MACOSX/`、`.DS_Store`）。
 */
export function trpgpackToPack(bytes: Uint8Array): TrpgpackDecodeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const assets = new Map<string, Uint8Array>();

  const result = (): TrpgpackDecodeResult => ({ ok: errors.length === 0, errors, warnings, assets });

  if (!(bytes instanceof Uint8Array)) {
    errors.push('输入必须是 Uint8Array（.trpgpack 文件字节）');
    return result();
  }
  if (bytes.length > ZIP_LIMITS.maxArchiveBytes) {
    errors.push(`包过大：${bytes.length} 字节，上限 ${ZIP_LIMITS.maxArchiveBytes} 字节（< 16 MiB）`);
    return result();
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    errors.push('不是有效的 .trpgpack：缺少 ZIP 魔数 PK\\x03\\x04（内容包必须是 zip 容器）');
    return result();
  }

  let zip: ReturnType<typeof readZip>;
  try {
    zip = readZip(bytes);
  } catch (error) {
    errors.push(error instanceof ZipError ? error.message : `ZIP 解析失败：${String(error)}`);
    return result();
  }
  warnings.push(...zip.warnings);

  let packJsonBytes: Uint8Array | undefined;
  for (const [name, entry] of zip.entries) {
    if (name === PACK_JSON_ENTRY) {
      packJsonBytes = entry.data;
      continue;
    }
    if (name.startsWith(ASSET_ENTRY_PREFIX)) {
      assets.set(name, entry.data);
      continue;
    }
    warnings.push(`忽略未识别的 zip 条目：${name}（v1 只接受 pack.json 与 assets/**）`);
  }

  if (packJsonBytes === undefined) {
    const nested = [...zip.entries.keys()].find((name) => name.endsWith(`/${PACK_JSON_ENTRY}`));
    errors.push(
      nested
        ? `pack.json 必须在 zip 根目录，检测到 ${nested}（不要把整个文件夹压进包里）`
        : '包内缺少 pack.json（zip 根目录下必须有 pack.json）',
    );
    return result();
  }
  if (packJsonBytes.length > ZIP_LIMITS.maxPackJsonBytes) {
    errors.push(`pack.json 解压后 ${packJsonBytes.length} 字节，超过上限 ${ZIP_LIMITS.maxPackJsonBytes} 字节`);
    return result();
  }

  let parsed: unknown;
  try {
    // 容忍 Windows 编辑器写入的 UTF-8 BOM（内容作者常见坑）
    const text = new TextDecoder('utf-8', { fatal: true }).decode(packJsonBytes).replace(/^\uFEFF/u, '');
    parsed = JSON.parse(text);
  } catch (error) {
    errors.push(
      `pack.json 解析失败：${error instanceof Error ? error.message : String(error)}（应为 UTF-8 JSON）`,
    );
    return result();
  }

  const migration = migratePack(parsed);
  warnings.push(...migration.warnings);
  const report = validatePack(migration.pack, { assetPaths: [...assets.keys()] });
  warnings.push(...report.warnings);
  if (!report.ok || !report.value) {
    errors.push(...report.errors);
    return result();
  }

  return {
    ok: true,
    errors: [],
    warnings,
    pack: report.value,
    assets,
    contentHash: contentHashOfPack(report.value),
    packHash: packHashOfBytes(bytes),
  };
}

/** CONTENT-MODEL §2.2 约定的写别名。 */
export function encodePackZip(pack: ContentPack, assets?: AssetsInput): Uint8Array {
  return packToTrpgpack(pack, assets === undefined ? {} : { assets });
}

/** CONTENT-MODEL §2.2 约定的读别名。 */
export function decodePackZip(bytes: Uint8Array): TrpgpackDecodeResult {
  return trpgpackToPack(bytes);
}
