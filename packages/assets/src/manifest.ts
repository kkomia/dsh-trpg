/**
 * `trpg.assets/1` 资产清单：类型、校验、序列化与合并工具。
 *
 * 与 [docs/UI-CONTRACT.md](../../../docs/UI-CONTRACT.md) §1.2/§1.4 对齐：
 * - 一个包最多 512 个资产、总量 ≤ 64 MiB；
 * - `assetId` 包内唯一且**路径安全**（`<kind>.<scope>.<slug>`，禁止 `/ \ ..`）；
 * - `file` 必须是 `assets/` 下的 zip 相对路径，扩展名与 `format` 一致；
 * - `sha256` 是归一化后字节的指纹（去重/缓存/校验），必须小写 64 位十六进制；
 * - 被引用的 `assetId` 必须存在（error）；无人引用的资产是 warning（孤立资产，沿用 M8.1 口径）；
 * - 可选传入 `files` / `contents` 做「文件存在 + 字节数 + sha256」实检。
 *
 * 本模块不读文件系统：读写即 `parseManifest` / `stringifyManifest`（纯文本），
 * 落盘的原子写由 host 侧负责（M9.5b）。同一 manifest 序列化结果稳定（资产按 assetId 排序）。
 */

import { sha256Hex } from './sha256.ts';

export const ASSET_SCHEMA_VERSION = 'trpg.assets/1';
export const ASSET_MANIFEST_FILE = 'assets/manifest.json';

export const ASSET_KINDS = [
  'item',
  'action',
  'status',
  'resource',
  'attribute',
  'slot',
  'avatar',
  'portrait',
  'variant',
  'spritesheet',
  'npc',
  'cover',
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_FORMATS = ['png', 'svg'] as const;
export type AssetFormat = (typeof ASSET_FORMATS)[number];

export const ASSET_STYLES = [
  'imported',
  'pixel-32',
  'game-2d',
  '2d-illustration',
  'topdown-2d',
  'pixel-topdown',
] as const;
export type AssetStyle = (typeof ASSET_STYLES)[number];

export const ASSET_LIMITS = {
  /** 单包资产数量上限 */
  maxAssets: 512,
  /** 单包资产总字节上限 */
  maxTotalBytes: 64 * 1024 * 1024,
  /** 单资产字节上限（= zip 单条目上限 8 MiB） */
  maxAssetBytes: 8 * 1024 * 1024,
  /** assetId 最大长度 */
  maxAssetIdLength: 128,
  /** file 路径最大长度 */
  maxFilePathLength: 256,
  /** prompt 最大长度 */
  maxPromptLength: 8000,
  /** 尺寸单边上限（像素） */
  maxDimension: 8192,
} as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const ASSET_ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STYLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const FILE_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const KIND_SET: ReadonlySet<string> = new Set(ASSET_KINDS);
const FORMAT_SET: ReadonlySet<string> = new Set(ASSET_FORMATS);

export interface AssetSize {
  w: number;
  h: number;
}

export interface AssetProvenance {
  /** 来源：本地导入 / AI SVG / AI 生图 / 手工程序生成 */
  source: string;
  model?: string | null;
  createdAt?: string;
}

export interface AssetEntry {
  /** `<kind>.<scope>.<slug>`，包内唯一 */
  assetId: string;
  /** zip 内相对路径，必须 `assets/` 开头并以 .png/.svg 结尾 */
  file: string;
  format: AssetFormat;
  size: AssetSize;
  bytes: number;
  sha256: string;
  kind: AssetKind;
  style: string;
  /** AI 生成时的种子（可复现）；本地导入为 null */
  seed: number | null;
  /** AI 生成时的提示词（可复现 + 生成历史）；本地导入为 null */
  prompt: string | null;
  /** ISO 8601 时间 */
  createdAt: string;
  provenance?: AssetProvenance;
}

export interface AssetManifest {
  schemaVersion: typeof ASSET_SCHEMA_VERSION;
  packId?: string;
  assets: AssetEntry[];
}

export interface AssetIssue {
  code: string;
  message: string;
  assetId?: string;
  file?: string;
}

export interface AssetValidationResult {
  ok: boolean;
  errors: AssetIssue[];
  warnings: AssetIssue[];
}

export interface AssetReferenceInput {
  assetId: string;
  /** 引用来源（如 `rules.items[3].icon`），用于错误定位 */
  source?: string;
}

export interface ValidateManifestOptions {
  /** zip 内实际存在的条目路径集合（校验 file 存在性） */
  files?: Iterable<string>;
  /** 实际文件字节（校验 bytes / sha256）；key 为 file 路径 */
  contents?: Map<string, Uint8Array> | Iterable<[string, Uint8Array]> | Record<string, Uint8Array>;
  /** 数据里实际引用的 assetId 列表（校验存在性 + 孤立资产 warning） */
  referenced?: Array<string | AssetReferenceInput>;
}

function issue(code: string, message: string, extra: { assetId?: string; file?: string } = {}): AssetIssue {
  const result: AssetIssue = { code, message };
  if (extra.assetId !== undefined) result.assetId = extra.assetId;
  if (extra.file !== undefined) result.file = extra.file;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** assetId 是否路径安全：`<kind>.<scope>.<slug>`，禁止 `/ \ ..` 与空段。 */
export function isSafeAssetId(assetId: unknown): assetId is string {
  if (typeof assetId !== 'string') return false;
  if (assetId.length === 0 || assetId.length > ASSET_LIMITS.maxAssetIdLength) return false;
  if (!ASSET_ID_PATTERN.test(assetId)) return false;
  if (assetId.includes('..')) return false;
  if (assetId.includes('/') || assetId.includes('\\')) return false;
  const segments = assetId.split('.');
  if (segments.length < 2) return false;
  return segments.every((segment) => ASSET_ID_SEGMENT_PATTERN.test(segment));
}

/** 校验资产文件路径：`assets/` 开头、无路径穿越、扩展名合法。 */
export function checkAssetFilePath(
  file: unknown,
  format?: AssetFormat,
): { ok: boolean; reason?: string } {
  if (typeof file !== 'string' || file.length === 0) {
    return { ok: false, reason: 'file 必须是非空字符串' };
  }
  if (file.length > ASSET_LIMITS.maxFilePathLength) {
    return { ok: false, reason: `file 路径过长（${file.length} > ${ASSET_LIMITS.maxFilePathLength}）` };
  }
  if (file.includes('\\')) return { ok: false, reason: 'file 不允许使用反斜杠（zip 内统一用 /）' };
  if (file.includes('..')) return { ok: false, reason: 'file 含路径穿越（..），拒绝' };
  if (/[\u0000-\u001f\u007f]/.test(file)) return { ok: false, reason: 'file 含控制字符，拒绝' };
  if (file.startsWith('/')) return { ok: false, reason: 'file 必须是相对路径（不能以 / 开头）' };
  if (!file.startsWith('assets/')) return { ok: false, reason: 'file 必须以 assets/ 开头' };
  if (file === ASSET_MANIFEST_FILE) return { ok: false, reason: 'manifest.json 本身不能作为资产 file' };
  if (file.includes('//')) return { ok: false, reason: 'file 含空路径段（//），拒绝' };
  if (file.includes('?') || file.includes('#') || file.includes('%')) {
    return { ok: false, reason: 'file 不允许含 ? # %（不是 URL，是 zip 路径）' };
  }
  const segments = file.split('/');
  const fileName = segments[segments.length - 1] ?? '';
  if (!/\.(png|svg)$/.test(fileName)) {
    return { ok: false, reason: 'file 扩展名必须是 .png 或 .svg' };
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || !FILE_SEGMENT_PATTERN.test(segment)) {
      return { ok: false, reason: `file 含非法路径段「${segment}」` };
    }
  }
  if (format !== undefined) {
    const expectedExtension = format === 'png' ? '.png' : '.svg';
    if (!fileName.toLowerCase().endsWith(expectedExtension)) {
      return { ok: false, reason: `file 扩展名与 format=${format} 不一致` };
    }
  }
  return { ok: true };
}

function toContentMap(
  contents: ValidateManifestOptions['contents'],
): Map<string, Uint8Array> | undefined {
  if (contents === undefined) return undefined;
  if (contents instanceof Map) return contents;
  const map = new Map<string, Uint8Array>();
  if (Array.isArray(contents)) {
    for (const [file, bytes] of contents) map.set(file, bytes);
  } else if (typeof (contents as Iterable<[string, Uint8Array]>)[Symbol.iterator] === 'function') {
    for (const [file, bytes] of contents as Iterable<[string, Uint8Array]>) map.set(file, bytes);
  } else {
    for (const [file, bytes] of Object.entries(contents as Record<string, Uint8Array>)) {
      map.set(file, bytes);
    }
  }
  return map;
}

function normalizeReferences(
  referenced: ValidateManifestOptions['referenced'],
): AssetReferenceInput[] {
  if (referenced === undefined) return [];
  return referenced.map((reference) =>
    typeof reference === 'string' ? { assetId: reference } : reference,
  );
}

/**
 * 校验资产清单（结构 + 唯一性 + 路径安全 + 上限 + 可选实检 + 引用完整性）。
 * 一次聚合全部问题：结构错误进 errors；孤立资产等容错项进 warnings。
 */
export function validateManifest(
  input: unknown,
  options: ValidateManifestOptions = {},
): AssetValidationResult {
  const errors: AssetIssue[] = [];
  const warnings: AssetIssue[] = [];
  if (!isRecord(input)) {
    errors.push(issue('manifest-shape', '资产清单必须是 JSON 对象'));
    return { ok: false, errors, warnings };
  }
  if (input.schemaVersion !== ASSET_SCHEMA_VERSION) {
    errors.push(
      issue(
        'manifest-schema',
        `资产清单 schemaVersion 必须是 "${ASSET_SCHEMA_VERSION}"，实际为 ${JSON.stringify(input.schemaVersion)}`,
      ),
    );
  }
  if (input.packId !== undefined) {
    if (typeof input.packId !== 'string' || !PACK_ID_PATTERN.test(input.packId)) {
      errors.push(
        issue(
          'manifest-pack-id',
          `packId 非法（应为小写字母/数字/下划线/连字符，≤64 字符）：${JSON.stringify(input.packId)}`,
        ),
      );
    }
  }
  if (!Array.isArray(input.assets)) {
    errors.push(issue('manifest-assets', '资产清单缺少 assets 数组'));
    return { ok: false, errors, warnings };
  }

  const assets = input.assets;
  if (assets.length > ASSET_LIMITS.maxAssets) {
    errors.push(
      issue(
        'manifest-count',
        `资产数量 ${assets.length} 超过单包上限 ${ASSET_LIMITS.maxAssets}`,
      ),
    );
  }

  const fileSet = options.files === undefined ? undefined : new Set(options.files);
  const contentMap = toContentMap(options.contents);
  const references = normalizeReferences(options.referenced);
  const referencedIds = new Set(references.map((reference) => reference.assetId));
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const presentIds = new Set<string>();
  let totalBytes = 0;

  assets.forEach((raw, index) => {
    const path = `assets[${index}]`;
    if (!isRecord(raw)) {
      errors.push(issue('asset-shape', `${path} 必须是 JSON 对象`));
      return;
    }

    const assetIdRaw = raw.assetId;
    const assetId = typeof assetIdRaw === 'string' ? assetIdRaw : '';
    if (!isSafeAssetId(assetIdRaw)) {
      errors.push(
        issue(
          'asset-id',
          `${path}.assetId 非法或路径不安全：${JSON.stringify(assetIdRaw)}（应为 <kind>.<scope>.<slug>，禁止 / \\ ..）`,
        ),
      );
    } else if (seenIds.has(assetId)) {
      errors.push(
        issue('asset-id-duplicate', `${path}.assetId 重复：${assetId}（包内必须唯一）`, { assetId }),
      );
    } else {
      seenIds.add(assetId);
      presentIds.add(assetId);
    }

    const formatRaw = raw.format;
    const format = typeof formatRaw === 'string' && FORMAT_SET.has(formatRaw)
      ? (formatRaw as AssetFormat)
      : undefined;
    if (format === undefined) {
      errors.push(
        issue('asset-format', `${path}.format 必须是 png 或 svg，实际为 ${JSON.stringify(formatRaw)}`, { assetId }),
      );
    }

    const fileRaw = raw.file;
    const fileCheck = checkAssetFilePath(fileRaw, format);
    const file = typeof fileRaw === 'string' ? fileRaw : '';
    if (!fileCheck.ok) {
      errors.push(
        issue('asset-file', `${path}.file 非法：${fileCheck.reason ?? '未知原因'}`, { assetId, file }),
      );
    } else if (seenFiles.has(file)) {
      warnings.push(
        issue('asset-file-duplicate', `${path}.file 被多个资产复用（建议一个 assetId 对应一个文件）：${file}`, {
          assetId,
          file,
        }),
      );
    } else {
      seenFiles.add(file);
    }

    const sizeRaw = raw.size;
    if (!isRecord(sizeRaw)) {
      errors.push(issue('asset-size', `${path}.size 必须是 { w, h } 对象`, { assetId }));
    } else {
      const w = sizeRaw.w;
      const h = sizeRaw.h;
      const validDimension = (value: unknown): value is number =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= ASSET_LIMITS.maxDimension;
      if (!validDimension(w) || !validDimension(h)) {
        errors.push(
          issue(
            'asset-size',
            `${path}.size 非法：w/h 必须是 1–${ASSET_LIMITS.maxDimension} 的整数，实际为 ${JSON.stringify(sizeRaw)}`,
            { assetId },
          ),
        );
      } else if (format === 'svg' && (w !== 128 || h !== 128)) {
        warnings.push(
          issue(
            'asset-size-svg',
            `${path}.size 为 ${w}×${h}：SVG 图标根元素固定 viewBox="0 0 128 128"，建议记 128×128`,
            { assetId },
          ),
        );
      }
    }

    const bytes = raw.bytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1) {
      errors.push(
        issue('asset-bytes', `${path}.bytes 必须是正整数，实际为 ${JSON.stringify(bytes)}`, { assetId }),
      );
    } else {
      totalBytes += bytes;
      if (bytes > ASSET_LIMITS.maxAssetBytes) {
        errors.push(
          issue(
            'asset-bytes',
            `${path}.bytes 为 ${bytes} 字节，超过单资产上限 ${ASSET_LIMITS.maxAssetBytes} 字节`,
            { assetId },
          ),
        );
      }
    }

    const sha256 = raw.sha256;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      errors.push(
        issue(
          'asset-sha256',
          `${path}.sha256 必须是 64 位小写十六进制，实际为 ${JSON.stringify(sha256)}`,
          { assetId },
        ),
      );
    }

    const kind = raw.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      errors.push(
        issue(
          'asset-kind',
          `${path}.kind 必须是 ${ASSET_KINDS.join('|')} 之一，实际为 ${JSON.stringify(kind)}`,
          { assetId },
        ),
      );
    }

    const style = raw.style;
    if (typeof style !== 'string' || !STYLE_PATTERN.test(style)) {
      errors.push(
        issue(
          'asset-style',
          `${path}.style 必须是 1–48 字符的小写风格标识（如 imported/pixel-32/game-2d），实际为 ${JSON.stringify(style)}`,
          { assetId },
        ),
      );
    }

    const seed = raw.seed;
    if (
      seed !== null &&
      (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1)
    ) {
      errors.push(
        issue('asset-seed', `${path}.seed 必须是 null 或 0..2147483647 的整数，实际为 ${JSON.stringify(seed)}`, {
          assetId,
        }),
      );
    }

    const prompt = raw.prompt;
    if (prompt !== null) {
      if (typeof prompt !== 'string' || prompt.length > ASSET_LIMITS.maxPromptLength) {
        errors.push(
          issue(
            'asset-prompt',
            `${path}.prompt 必须是 null 或 ≤ ${ASSET_LIMITS.maxPromptLength} 字符的字符串`,
            { assetId },
          ),
        );
      }
    }

    const createdAt = raw.createdAt;
    if (
      typeof createdAt !== 'string' ||
      createdAt.length === 0 ||
      Number.isNaN(Date.parse(createdAt))
    ) {
      errors.push(
        issue('asset-created-at', `${path}.createdAt 必须是可解析的 ISO 8601 时间字符串`, { assetId }),
      );
    }

    if (raw.provenance !== undefined) {
      if (!isRecord(raw.provenance)) {
        errors.push(issue('asset-provenance', `${path}.provenance 必须是对象`, { assetId }));
      } else {
        if (typeof raw.provenance.source !== 'string' || raw.provenance.source.length === 0) {
          errors.push(issue('asset-provenance', `${path}.provenance.source 必须是非空字符串`, { assetId }));
        }
        if (raw.provenance.model !== undefined && raw.provenance.model !== null && typeof raw.provenance.model !== 'string') {
          errors.push(issue('asset-provenance', `${path}.provenance.model 必须是字符串或 null`, { assetId }));
        }
        if (raw.provenance.createdAt !== undefined) {
          const provenanceCreatedAt = raw.provenance.createdAt;
          if (
            typeof provenanceCreatedAt !== 'string' ||
            Number.isNaN(Date.parse(provenanceCreatedAt))
          ) {
            errors.push(
              issue('asset-provenance', `${path}.provenance.createdAt 必须是可解析的时间字符串`, { assetId }),
            );
          }
        }
      }
    }

    if (fileSet !== undefined && file !== '' && !fileSet.has(file)) {
      errors.push(
        issue('asset-file-missing', `${path}.file 在包内不存在：${file}`, { assetId, file }),
      );
    }
    const actualBytes = contentMap?.get(file);
    if (contentMap !== undefined && file !== '') {
      if (actualBytes === undefined) {
        errors.push(
          issue('asset-file-missing', `${path}.file 无实际内容可校验（不存在）：${file}`, { assetId, file }),
        );
      } else {
        if (typeof bytes === 'number' && actualBytes.length !== bytes) {
          errors.push(
            issue(
              'asset-bytes-mismatch',
              `${path}.bytes 与实际文件不符：清单 ${bytes} 字节 / 实际 ${actualBytes.length} 字节`,
              { assetId, file },
            ),
          );
        }
        if (typeof sha256 === 'string' && SHA256_PATTERN.test(sha256)) {
          const actualSha = sha256Hex(actualBytes);
          if (actualSha !== sha256) {
            errors.push(
              issue(
                'asset-sha256-mismatch',
                `${path}.sha256 与实际文件不符：清单 ${sha256.slice(0, 12)}… / 实际 ${actualSha.slice(0, 12)}…`,
                { assetId, file },
              ),
            );
          }
        }
      }
    }
  });

  if (totalBytes > ASSET_LIMITS.maxTotalBytes) {
    errors.push(
      issue(
        'manifest-total-bytes',
        `资产总量 ${totalBytes} 字节超过单包上限 ${ASSET_LIMITS.maxTotalBytes} 字节（64 MiB）`,
      ),
    );
  }

  // 引用完整性：被引用必须存在；存在但无人引用 → 孤立资产 warning
  for (const reference of references) {
    if (!presentIds.has(reference.assetId)) {
      const suffix = reference.source === undefined ? '' : `（来自 ${reference.source}）`;
      errors.push(
        issue(
          'asset-reference-missing',
          `被引用的资产不存在：${reference.assetId}${suffix}`,
          { assetId: reference.assetId },
        ),
      );
    }
  }
  if (options.referenced !== undefined) {
    for (const assetId of presentIds) {
      if (!referencedIds.has(assetId)) {
        warnings.push(
          issue('asset-orphan', `孤立资产（未被任何数据引用）：${assetId}`, { assetId }),
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// 序列化 / 反序列化（稳定顺序：assets 按 assetId 码点排序）
// ---------------------------------------------------------------------------

function canonicalAsset(asset: AssetEntry): Record<string, unknown> {
  const ordered: Record<string, unknown> = {
    assetId: asset.assetId,
    file: asset.file,
    format: asset.format,
    size: { w: asset.size.w, h: asset.size.h },
    bytes: asset.bytes,
    sha256: asset.sha256,
    kind: asset.kind,
    style: asset.style,
    seed: asset.seed ?? null,
    prompt: asset.prompt ?? null,
    createdAt: asset.createdAt,
  };
  if (asset.provenance !== undefined) {
    const provenance: Record<string, unknown> = { source: asset.provenance.source };
    if (asset.provenance.model !== undefined) provenance.model = asset.provenance.model;
    if (asset.provenance.createdAt !== undefined) provenance.createdAt = asset.provenance.createdAt;
    ordered.provenance = provenance;
  }
  return ordered;
}

function compareAssetIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 规范化清单：字段固定顺序、资产按 assetId 排序（保证同输入同字节）。 */
export function canonicalizeManifest(manifest: AssetManifest): Record<string, unknown> {
  const ordered: Record<string, unknown> = { schemaVersion: ASSET_SCHEMA_VERSION };
  if (manifest.packId !== undefined) ordered.packId = manifest.packId;
  ordered.assets = [...manifest.assets]
    .sort((left, right) => compareAssetIds(left.assetId, right.assetId))
    .map((asset) => canonicalAsset(asset));
  return ordered;
}

/** 序列化 `assets/manifest.json` 文本（2 空格缩进 + 末尾换行，确定性输出）。 */
export function stringifyManifest(manifest: AssetManifest): string {
  return `${JSON.stringify(canonicalizeManifest(manifest), null, 2)}\n`;
}

export interface ManifestParseResult {
  ok: boolean;
  manifest?: AssetManifest;
  errors: AssetIssue[];
  warnings: AssetIssue[];
}

/** 解析并校验 `assets/manifest.json` 文本；JSON 语法错误也会给中文原因。 */
export function parseManifest(text: string): ManifestParseResult {
  if (typeof text !== 'string') {
    return {
      ok: false,
      errors: [issue('manifest-input', 'manifest 输入必须是字符串')],
      warnings: [],
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      errors: [
        issue(
          'manifest-json',
          `assets/manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
      warnings: [],
    };
  }
  const validation = validateManifest(data);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings };
  }
  return {
    ok: true,
    manifest: data as AssetManifest,
    errors: [],
    warnings: validation.warnings,
  };
}

/** 读 manifest（parseManifest 的语义别名，便于工坊代码语义对齐）。 */
export const readManifest = parseManifest;
/** 写 manifest（stringifyManifest 的语义别名；落盘由宿主执行）。 */
export const writeManifest = stringifyManifest;

/** 新建空清单。 */
export function createManifest(packId?: string): AssetManifest {
  const manifest: AssetManifest = { schemaVersion: ASSET_SCHEMA_VERSION, assets: [] };
  if (packId !== undefined) manifest.packId = packId;
  return manifest;
}

/** 在清单里找一条资产。 */
export function findAsset(manifest: AssetManifest, assetId: string): AssetEntry | undefined {
  return manifest.assets.find((asset) => asset.assetId === assetId);
}

// ---------------------------------------------------------------------------
// 单条资产构造 + 合并（工坊落盘/替换用）
// ---------------------------------------------------------------------------

export interface AssetEntryInput {
  assetId: string;
  file: string;
  format: AssetFormat;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  kind: AssetKind;
  style?: string;
  seed?: number | null;
  prompt?: string | null;
  createdAt?: string;
  provenance?: AssetProvenance;
}

export interface BuildAssetEntryResult {
  ok: boolean;
  entry?: AssetEntry;
  errors: AssetIssue[];
  warnings: AssetIssue[];
}

/** 构造并校验单条资产记录（归一化产物 → manifest 条目）。 */
export function buildAssetEntry(input: AssetEntryInput): BuildAssetEntryResult {
  const entry: AssetEntry = {
    assetId: input.assetId,
    file: input.file,
    format: input.format,
    size: { w: input.width, h: input.height },
    bytes: input.bytes,
    sha256: input.sha256,
    kind: input.kind,
    style: input.style ?? 'imported',
    seed: input.seed ?? null,
    prompt: input.prompt ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.provenance !== undefined) entry.provenance = input.provenance;
  const manifest: AssetManifest = { schemaVersion: ASSET_SCHEMA_VERSION, assets: [entry] };
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings };
  }
  return { ok: true, entry, errors: [], warnings: validation.warnings };
}

export type MergeStrategy = 'replace' | 'skip' | 'error';

export interface MergeManifestOptions {
  /** 同 assetId 冲突策略：replace（默认，落盘替换同 sha256 换内容）/ skip / error */
  strategy?: MergeStrategy;
  /** 是否在合并后做整体校验（数量/总量/路径等），默认 true */
  validate?: boolean;
}

export interface MergeManifestResult {
  ok: boolean;
  manifest: AssetManifest;
  added: string[];
  replaced: string[];
  skipped: string[];
  errors: AssetIssue[];
  warnings: AssetIssue[];
}

/**
 * 合并两个清单（或一份清单 + 若干新条目）。
 * - 同 assetId：`replace` 用新条目覆盖（引用不断、sha256 变化 → 界面刷新）、`skip` 保留旧条目、`error` 报错；
 * - packId 两边都有且不同 → 错误（跨包不许混）；
 * - 输出资产按 assetId 排序，保证落盘字节稳定。
 */
export function mergeManifests(
  base: AssetManifest,
  incoming: AssetManifest | AssetEntry[],
  options: MergeManifestOptions = {},
): MergeManifestResult {
  const strategy = options.strategy ?? 'replace';
  const errors: AssetIssue[] = [];
  const warnings: AssetIssue[] = [];
  const incomingAssets = Array.isArray(incoming) ? incoming : incoming.assets;
  const incomingPackId = Array.isArray(incoming) ? undefined : incoming.packId;

  if (
    base.packId !== undefined &&
    incomingPackId !== undefined &&
    base.packId !== incomingPackId
  ) {
    errors.push(
      issue(
        'merge-pack-id',
        `manifest packId 不一致：现有 ${base.packId} / 导入 ${incomingPackId}（跨包资产不许混）`,
      ),
    );
    return {
      ok: false,
      manifest: base,
      added: [],
      replaced: [],
      skipped: [],
      errors,
      warnings,
    };
  }

  const incomingValidation = validateManifest({
    schemaVersion: ASSET_SCHEMA_VERSION,
    ...(incomingPackId === undefined ? {} : { packId: incomingPackId }),
    assets: incomingAssets,
  });
  if (!incomingValidation.ok) {
    return {
      ok: false,
      manifest: base,
      added: [],
      replaced: [],
      skipped: [],
      errors: incomingValidation.errors,
      warnings: incomingValidation.warnings,
    };
  }

  const merged = new Map<string, AssetEntry>();
  for (const asset of base.assets) merged.set(asset.assetId, asset);
  const added: string[] = [];
  const replaced: string[] = [];
  const skipped: string[] = [];

  for (const asset of incomingAssets) {
    const existing = merged.get(asset.assetId);
    if (existing === undefined) {
      merged.set(asset.assetId, asset);
      added.push(asset.assetId);
      continue;
    }
    if (strategy === 'skip') {
      skipped.push(asset.assetId);
      continue;
    }
    if (strategy === 'error') {
      errors.push(
        issue('merge-duplicate', `资产已存在且策略为 error：${asset.assetId}`, {
          assetId: asset.assetId,
        }),
      );
      continue;
    }
    merged.set(asset.assetId, asset);
    replaced.push(asset.assetId);
  }

  const resultManifest: AssetManifest = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    ...(base.packId !== undefined
      ? { packId: base.packId }
      : incomingPackId !== undefined
        ? { packId: incomingPackId }
        : {}),
    assets: [...merged.values()].sort((left, right) => compareAssetIds(left.assetId, right.assetId)),
  };

  if (options.validate !== false) {
    const validation = validateManifest(resultManifest);
    errors.push(...validation.errors);
    warnings.push(...validation.warnings);
  }

  return { ok: errors.length === 0, manifest: resultManifest, added, replaced, skipped, errors, warnings };
}

export interface RemoveAssetsResult {
  manifest: AssetManifest;
  removed: string[];
  missing: string[];
}

/** 删除若干资产（工坊「移除」），返回新清单与缺失列表。 */
export function removeAssets(manifest: AssetManifest, assetIds: string[]): RemoveAssetsResult {
  const target = new Set(assetIds);
  const removed: string[] = [];
  const remaining: AssetEntry[] = [];
  for (const asset of manifest.assets) {
    if (target.has(asset.assetId)) {
      removed.push(asset.assetId);
      target.delete(asset.assetId);
    } else {
      remaining.push(asset);
    }
  }
  const next: AssetManifest = {
    schemaVersion: ASSET_SCHEMA_VERSION,
    ...(manifest.packId === undefined ? {} : { packId: manifest.packId }),
    assets: remaining.sort((left, right) => compareAssetIds(left.assetId, right.assetId)),
  };
  return { manifest: next, removed, missing: [...target] };
}
