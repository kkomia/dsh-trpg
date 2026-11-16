/**
 * `assets/manifest.json`（`trpg.assets/1` 资产清单）在内容包里的承载与校验。
 *
 * 契约：[docs/UI-CONTRACT.md](../../../docs/UI-CONTRACT.md) §1.2（清单形状）、§1.4（引用校验与缺失降级）、
 * §3.1（尺寸/体积硬约束）。与 M8.1 的规则脚本同一口径：
 * - **有清单才校验**：zip 里没有 `assets/manifest.json` 时本模块不产出任何 error/warning，
 *   素材存在性仍由 `validatePack({ assetPaths })` 的老路径负责（M8.1 行为不变）；
 * - 清单自身合法（schemaVersion / assetId 唯一且路径安全 / file 合法且唯一 / format 与扩展名一致 /
 *   size / bytes / sha256 / kind / style / seed / prompt / createdAt / provenance / 数量与总量上限）；
 * - `asset.file` 必须在包内存在，且 `bytes` / `sha256` 与实际条目字节一致（传了字节才算 sha256；
 *   只有路径时退化为存在性校验，与 `verifyPackScripts` 的降级路径一致）；
 * - `pack.json` 引用的资产（`pack.icon`、`rules.items[].icon`、`rules.ui.itemCategories[].icon`）必须存在：
 *   - `assetId` 形式（如 `icon.item.hengdao`）→ 直接查清单；
 *   - 文件路径形式（`assets/...`，`pack.icon` 用）→ 按 `file` 反查清单条目；
 *   - 短 id 形式（`status/poison`，源数据写法）→ 按约定路径 `assets/icons/<短 id>.<svg|png>` 反查；
 *     查不到只给 **warning**（运行时退回几何徽记，契约 §1.4）；
 * - 清单里存在但 `pack.json` 无人引用 → **孤立资产 warning**（沿用 M8.1 口径，不阻断）。
 *
 * 为什么这里复制了 `@dsh-trpg/assets` 的清单类型与校验（而不是 import）：
 * `@dsh-trpg/assets` 的 `sha256.ts` 用 `node:crypto`、`png.ts` 用 `node:zlib`，而
 * `@dsh-trpg/content` 会被打进浏览器 client bundle（见 `scripts/build.mjs`）。本包已有纯 JS 的
 * `sha256.ts`，所以这里保留一份"纯数据层"校验实现（字段与错误口径和
 * `packages/assets/src/manifest.ts` 对齐），避免把 node: 内置模块拖进浏览器。
 * 若将来 assets 拆出纯数据子路径导出，可替换成包名导入。
 */
import { sha256Hex } from './sha256.ts';

/** 资产清单在 zip 内的固定路径（与 `@dsh-trpg/assets` 的 `ASSET_MANIFEST_FILE` 一致）。 */
export const ASSET_MANIFEST_ENTRY = 'assets/manifest.json';

/** 资产清单 schema 版本。 */
export const ASSET_MANIFEST_SCHEMA_VERSION = 'trpg.assets/1';

/** 资产种类（图标挂载点，契约 §1.2/§1.3）。 */
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

/** v1 只收 PNG / SVG（契约 §0 #6）。 */
export const ASSET_FORMATS = ['png', 'svg'] as const;
export type AssetFormat = (typeof ASSET_FORMATS)[number];

/** 清单上限（与 `packages/assets/src/manifest.ts` 的 `ASSET_LIMITS` 对齐）。 */
export const ASSET_MANIFEST_LIMITS = {
  /** 单包资产数量上限（= zip 条目上限 520 中留给资产的部分） */
  maxAssets: 512,
  /** 单包资产总字节上限（= zip 解压总量上限 64 MiB） */
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
const ASSET_PATH_PREFIX = 'assets/';
const KIND_SET: ReadonlySet<string> = new Set(ASSET_KINDS);
const FORMAT_SET: ReadonlySet<string> = new Set(ASSET_FORMATS);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

// ---------------------------------------------------------------------------
// 类型（与 `@dsh-trpg/assets` 的 trpg.assets/1 对齐）
// ---------------------------------------------------------------------------

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
  /** AI 生成时的提示词；本地导入为 null */
  prompt: string | null;
  /** ISO 8601 时间 */
  createdAt: string;
  provenance?: AssetProvenance;
}

export interface AssetManifest {
  schemaVersion: typeof ASSET_MANIFEST_SCHEMA_VERSION;
  packId?: string;
  assets: AssetEntry[];
}

export interface AssetIssue {
  code: string;
  message: string;
  assetId?: string;
  file?: string;
}

/** pack.json 里的一处图标/资产引用（`value` 是源数据原样字符串）。 */
export interface PackAssetReference {
  value: string;
  /** 引用位置，如 `pack.rules.items[3].icon`（错误定位用）。 */
  source: string;
}

export interface PackAssetVerifyReport {
  ok: boolean;
  errors: AssetIssue[];
  warnings: AssetIssue[];
  /** 清单本身（只有 JSON 解析成功时才有，即使结构校验失败也保留原始形状）。 */
  manifest?: AssetManifest;
  /** 清单里可用的资产条目（assetId → entry；结构错误条目会被跳过）。 */
  entries: Map<string, AssetEntry>;
}

export interface PackAssetVerifyOptions {
  /** `assets/manifest.json` 的原始文本或字节。 */
  manifest: string | Uint8Array;
  /** `pack.json`（用于收集引用；不传 = 只校验清单自身）。 */
  pack?: unknown;
  /** zip 内实际条目路径（校验 `file` 存在性）。 */
  files?: Iterable<string>;
  /** 实际文件字节（校验 `bytes` / `sha256`）；key 为 zip 内路径。 */
  contents?: Map<string, Uint8Array> | Iterable<[string, Uint8Array]> | Record<string, Uint8Array>;
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function issue(code: string, message: string, extra: { assetId?: string; file?: string } = {}): AssetIssue {
  const result: AssetIssue = { code, message };
  if (extra.assetId !== undefined) result.assetId = extra.assetId;
  if (extra.file !== undefined) result.file = extra.file;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** assetId 是否路径安全：`<kind>.<scope>.<slug>`，禁止 `/ \ ..` 与空段。 */
export function isSafeAssetId(assetId: unknown): boolean {
  if (typeof assetId !== 'string') return false;
  if (assetId.length === 0 || assetId.length > ASSET_MANIFEST_LIMITS.maxAssetIdLength) return false;
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
  if (file.length > ASSET_MANIFEST_LIMITS.maxFilePathLength) {
    return {
      ok: false,
      reason: `file 路径过长（${file.length} > ${ASSET_MANIFEST_LIMITS.maxFilePathLength}）`,
    };
  }
  if (file.includes('\\')) return { ok: false, reason: 'file 不允许使用反斜杠（zip 内统一用 /）' };
  if (file.includes('..')) return { ok: false, reason: 'file 含路径穿越（..），拒绝' };
  if (/[\u0000-\u001f\u007f]/.test(file)) return { ok: false, reason: 'file 含控制字符，拒绝' };
  if (file.startsWith('/')) return { ok: false, reason: 'file 必须是相对路径（不能以 / 开头）' };
  if (!file.startsWith(ASSET_PATH_PREFIX)) return { ok: false, reason: 'file 必须以 assets/ 开头' };
  if (file === ASSET_MANIFEST_ENTRY) return { ok: false, reason: 'manifest.json 本身不能作为资产 file' };
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
  contents: PackAssetVerifyOptions['contents'],
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

// ---------------------------------------------------------------------------
// 清单校验（结构 + 实检）
// ---------------------------------------------------------------------------

interface ManifestCheckOptions {
  files?: Set<string>;
  contents?: Map<string, Uint8Array>;
  /** pack.json 的 packId（清单写了 packId 时必须一致）。 */
  packId?: string;
}

interface ManifestCheckResult {
  errors: AssetIssue[];
  warnings: AssetIssue[];
  entries: Map<string, AssetEntry>;
}

function checkManifest(raw: Record<string, unknown>, options: ManifestCheckOptions): ManifestCheckResult {
  const errors: AssetIssue[] = [];
  const warnings: AssetIssue[] = [];
  const entries = new Map<string, AssetEntry>();
  const { files, contents } = options;

  if (raw.schemaVersion !== ASSET_MANIFEST_SCHEMA_VERSION) {
    errors.push(
      issue(
        'manifest-schema',
        `assets/manifest.json 的 schemaVersion 必须是 "${ASSET_MANIFEST_SCHEMA_VERSION}"，实际为 ${JSON.stringify(raw.schemaVersion)}`,
      ),
    );
  }
  if (raw.packId !== undefined) {
    if (typeof raw.packId !== 'string' || !PACK_ID_PATTERN.test(raw.packId)) {
      errors.push(
        issue(
          'manifest-pack-id',
          `assets/manifest.json 的 packId 非法（应为小写字母/数字/下划线/连字符，≤64 字符）：${JSON.stringify(raw.packId)}`,
        ),
      );
    } else if (options.packId !== undefined && raw.packId !== options.packId) {
      errors.push(
        issue(
          'manifest-pack-id-mismatch',
          `assets/manifest.json 的 packId "${raw.packId}" 与 pack.json 的 packId "${options.packId}" 不一致`,
        ),
      );
    }
  }
  if (!Array.isArray(raw.assets)) {
    errors.push(issue('manifest-assets', 'assets/manifest.json 缺少 assets 数组'));
    return { errors, warnings, entries };
  }

  const assets = raw.assets;
  if (assets.length > ASSET_MANIFEST_LIMITS.maxAssets) {
    errors.push(
      issue(
        'manifest-count',
        `资产数量 ${assets.length} 超过单包上限 ${ASSET_MANIFEST_LIMITS.maxAssets}（UI-CONTRACT §3.1）`,
      ),
    );
  }

  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  const presentIds = new Set<string>();
  let totalBytes = 0;

  assets.forEach((rawAsset, index) => {
    const path = `assets[${index}]`;
    if (!isRecord(rawAsset)) {
      errors.push(issue('asset-shape', `assets/manifest.json 的 ${path} 必须是 JSON 对象`));
      return;
    }

    const assetIdRaw = rawAsset.assetId;
    const assetId = typeof assetIdRaw === 'string' ? assetIdRaw : '';
    let idUsable = false;
    if (!isSafeAssetId(assetIdRaw)) {
      errors.push(
        issue(
          'asset-id',
          `assets/manifest.json 的 ${path}.assetId 非法或路径不安全：${JSON.stringify(assetIdRaw)}（应为 <kind>.<scope>.<slug>，禁止 / \\ ..）`,
        ),
      );
    } else if (seenIds.has(assetId)) {
      errors.push(
        issue('asset-id-duplicate', `assets/manifest.json 的 ${path}.assetId 重复：${assetId}（包内必须唯一）`, { assetId }),
      );
    } else {
      seenIds.add(assetId);
      presentIds.add(assetId);
      idUsable = true;
    }

    const formatRaw = rawAsset.format;
    const format = typeof formatRaw === 'string' && FORMAT_SET.has(formatRaw)
      ? (formatRaw as AssetFormat)
      : undefined;
    if (format === undefined) {
      errors.push(
        issue('asset-format', `assets/manifest.json 的 ${path}.format 必须是 png 或 svg，实际为 ${JSON.stringify(formatRaw)}`, { assetId }),
      );
    }

    const fileRaw = rawAsset.file;
    const fileCheck = checkAssetFilePath(fileRaw, format);
    const file = typeof fileRaw === 'string' ? fileRaw : '';
    let entryUsable = false;
    if (!fileCheck.ok) {
      errors.push(
        issue('asset-file', `assets/manifest.json 的 ${path}.file 非法：${fileCheck.reason ?? '未知原因'}`, { assetId, file }),
      );
    } else if (seenFiles.has(file)) {
      warnings.push(
        issue('asset-file-duplicate', `assets/manifest.json 的 ${path}.file 被多个资产复用（建议一个 assetId 对应一个文件）：${file}`, {
          assetId,
          file,
        }),
      );
      entryUsable = true;
    } else {
      seenFiles.add(file);
      entryUsable = true;
    }

    const sizeRaw = rawAsset.size;
    if (!isRecord(sizeRaw)) {
      errors.push(issue('asset-size', `assets/manifest.json 的 ${path}.size 必须是 { w, h } 对象`, { assetId }));
    } else {
      const w = sizeRaw.w;
      const h = sizeRaw.h;
      const validDimension = (value: unknown): value is number =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= ASSET_MANIFEST_LIMITS.maxDimension;
      if (!validDimension(w) || !validDimension(h)) {
        errors.push(
          issue(
            'asset-size',
            `assets/manifest.json 的 ${path}.size 非法：w/h 必须是 1–${ASSET_MANIFEST_LIMITS.maxDimension} 的整数，实际为 ${JSON.stringify(sizeRaw)}`,
            { assetId },
          ),
        );
      } else if (format === 'svg' && (w !== 128 || h !== 128)) {
        warnings.push(
          issue(
            'asset-size-svg',
            `assets/manifest.json 的 ${path}.size 为 ${w}×${h}：SVG 图标根元素固定 viewBox="0 0 128 128"，建议记 128×128`,
            { assetId },
          ),
        );
      }
    }

    const bytes = rawAsset.bytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1) {
      errors.push(
        issue('asset-bytes', `assets/manifest.json 的 ${path}.bytes 必须是正整数，实际为 ${JSON.stringify(bytes)}`, { assetId }),
      );
    } else {
      totalBytes += bytes;
      if (bytes > ASSET_MANIFEST_LIMITS.maxAssetBytes) {
        errors.push(
          issue(
            'asset-bytes',
            `assets/manifest.json 的 ${path}.bytes 为 ${bytes} 字节，超过单资产上限 ${ASSET_MANIFEST_LIMITS.maxAssetBytes} 字节`,
            { assetId },
          ),
        );
      }
    }

    const sha256 = rawAsset.sha256;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      errors.push(
        issue('asset-sha256', `assets/manifest.json 的 ${path}.sha256 必须是 64 位小写十六进制，实际为 ${JSON.stringify(sha256)}`, {
          assetId,
        }),
      );
    }

    const kind = rawAsset.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      errors.push(
        issue('asset-kind', `assets/manifest.json 的 ${path}.kind 必须是 ${ASSET_KINDS.join('|')} 之一，实际为 ${JSON.stringify(kind)}`, {
          assetId,
        }),
      );
    }

    const style = rawAsset.style;
    if (typeof style !== 'string' || !STYLE_PATTERN.test(style)) {
      errors.push(
        issue(
          'asset-style',
          `assets/manifest.json 的 ${path}.style 必须是 1–48 字符的风格标识（如 imported/pixel-32/game-2d），实际为 ${JSON.stringify(style)}`,
          { assetId },
        ),
      );
    }

    const seed = rawAsset.seed;
    if (
      seed !== null &&
      (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 2 ** 31 - 1)
    ) {
      errors.push(
        issue('asset-seed', `assets/manifest.json 的 ${path}.seed 必须是 null 或 0..2147483647 的整数，实际为 ${JSON.stringify(seed)}`, {
          assetId,
        }),
      );
    }

    const prompt = rawAsset.prompt;
    if (prompt !== null) {
      if (typeof prompt !== 'string' || prompt.length > ASSET_MANIFEST_LIMITS.maxPromptLength) {
        errors.push(
          issue(
            'asset-prompt',
            `assets/manifest.json 的 ${path}.prompt 必须是 null 或 ≤ ${ASSET_MANIFEST_LIMITS.maxPromptLength} 字符的字符串`,
            { assetId },
          ),
        );
      }
    }

    const createdAt = rawAsset.createdAt;
    if (typeof createdAt !== 'string' || createdAt.length === 0 || Number.isNaN(Date.parse(createdAt))) {
      errors.push(
        issue('asset-created-at', `assets/manifest.json 的 ${path}.createdAt 必须是可解析的 ISO 8601 时间字符串`, { assetId }),
      );
    }

    if (rawAsset.provenance !== undefined) {
      if (!isRecord(rawAsset.provenance)) {
        errors.push(issue('asset-provenance', `assets/manifest.json 的 ${path}.provenance 必须是对象`, { assetId }));
      } else {
        const provenance = rawAsset.provenance;
        if (!isNonEmptyString(provenance.source)) {
          errors.push(
            issue('asset-provenance', `assets/manifest.json 的 ${path}.provenance.source 必须是非空字符串`, { assetId }),
          );
        }
        if (provenance.model !== undefined && provenance.model !== null && typeof provenance.model !== 'string') {
          errors.push(
            issue('asset-provenance', `assets/manifest.json 的 ${path}.provenance.model 必须是字符串或 null`, { assetId }),
          );
        }
        if (provenance.createdAt !== undefined) {
          const provenanceCreatedAt = provenance.createdAt;
          if (typeof provenanceCreatedAt !== 'string' || Number.isNaN(Date.parse(provenanceCreatedAt))) {
            errors.push(
              issue('asset-provenance', `assets/manifest.json 的 ${path}.provenance.createdAt 必须是可解析的时间字符串`, { assetId }),
            );
          }
        }
      }
    }

    if (files !== undefined && file !== '' && !files.has(file)) {
      errors.push(
        issue('asset-file-missing', `assets/manifest.json 的 ${path}.file 在包内不存在：${file}`, { assetId, file }),
      );
    }
    if (contents !== undefined && file !== '') {
      const actualBytes = contents.get(file);
      if (actualBytes === undefined) {
        errors.push(
          issue('asset-file-missing', `assets/manifest.json 的 ${path}.file 在包内没有实际字节：${file}`, { assetId, file }),
        );
      } else {
        if (typeof bytes === 'number' && actualBytes.length !== bytes) {
          errors.push(
            issue(
              'asset-bytes-mismatch',
              `assets/manifest.json 的 ${path}.bytes 与实际文件不符：清单 ${bytes} 字节 / 实际 ${actualBytes.length} 字节`,
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
                `assets/manifest.json 的 ${path}.sha256 与实际文件不符：清单 ${sha256.slice(0, 12)}… / 实际 ${actualSha.slice(0, 12)}…`,
                { assetId, file },
              ),
            );
          }
        }
      }
    }

    if (idUsable && entryUsable) {
      entries.set(assetId, rawAsset as unknown as AssetEntry);
    }
  });

  if (totalBytes > ASSET_MANIFEST_LIMITS.maxTotalBytes) {
    errors.push(
      issue(
        'manifest-total-bytes',
        `资产总量 ${totalBytes} 字节超过单包上限 ${ASSET_MANIFEST_LIMITS.maxTotalBytes} 字节（64 MiB）`,
      ),
    );
  }

  return { errors, warnings, entries };
}

// ---------------------------------------------------------------------------
// pack.json 引用收集与解析
// ---------------------------------------------------------------------------

function pushReference(output: PackAssetReference[], value: unknown, source: string): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  output.push({ value: trimmed, source });
}

/**
 * 收集 `pack.json` 里对资产的引用（契约 §1.3 目前落地的挂载点）：
 * - `pack.icon`（封面，`assets/...` 路径或内联 SVG）；
 * - `pack.rules.items[].icon`（世界物品库图标）；
 * - `pack.rules.ui.itemCategories[].icon`（背包分类图标）。
 * 其它挂载点（actions / sheet / space 底图等）留到后续 milestone，不在此处提前校验。
 */
export function collectPackAssetReferences(pack: unknown): PackAssetReference[] {
  const references: PackAssetReference[] = [];
  if (!isRecord(pack)) return references;
  pushReference(references, pack.icon, 'pack.icon');
  const rules = isRecord(pack.rules) ? pack.rules : undefined;
  if (rules === undefined) return references;
  if (Array.isArray(rules.items)) {
    rules.items.forEach((item, index) => {
      if (isRecord(item)) pushReference(references, item.icon, `pack.rules.items[${index}].icon`);
    });
  }
  if (isRecord(rules.ui) && Array.isArray(rules.ui.itemCategories)) {
    rules.ui.itemCategories.forEach((category, index) => {
      if (isRecord(category)) {
        pushReference(references, category.icon, `pack.rules.ui.itemCategories[${index}].icon`);
      }
    });
  }
  return references;
}

/** 短 id → 约定文件路径（契约 §1.1：`assets/icons/<短 id>.<svg|png>`）。 */
const SHORT_ID_EXTENSIONS = ['svg', 'png'] as const;

/**
 * 解析引用 → 清单里真实存在的 assetId。缺失的 assetId/路径引用记为 error；
 * 短 id 无对应文件只记 warning（运行时退回几何徽记）。返回去重后的引用列表（assetId → 首个来源）。
 */
function resolveReferences(
  references: readonly PackAssetReference[],
  entries: Map<string, AssetEntry>,
  errors: AssetIssue[],
  warnings: AssetIssue[],
): Array<{ assetId: string; source: string }> {
  const byId = new Map<string, AssetEntry>();
  const fileToId = new Map<string, string>();
  for (const [assetId, entry] of entries) {
    byId.set(assetId, entry);
    const file = (entry as { file?: unknown }).file;
    if (typeof file === 'string' && !fileToId.has(file)) fileToId.set(file, assetId);
  }
  const resolved: Array<{ assetId: string; source: string }> = [];
  const seen = new Set<string>();

  const record = (assetId: string, source: string): void => {
    if (seen.has(assetId)) return;
    seen.add(assetId);
    resolved.push({ assetId, source });
  };

  for (const reference of references) {
    const { value, source } = reference;
    if (value.startsWith('<svg')) continue;
    if (value.startsWith('@pack:')) {
      const file = value.slice('@pack:'.length);
      const assetId = fileToId.get(file);
      if (assetId === undefined) {
        errors.push(issue('asset-reference-missing', `pack.json 引用的资产文件不在资产清单中：${file}（来源 ${source}）`, { file }));
      } else {
        record(assetId, source);
      }
      continue;
    }
    if (value.startsWith(ASSET_PATH_PREFIX)) {
      const assetId = fileToId.get(value);
      if (assetId === undefined) {
        errors.push(
          issue('asset-reference-missing', `pack.json 引用的资产文件不在资产清单中：${value}（来源 ${source}）`, { file: value }),
        );
      } else {
        record(assetId, source);
      }
      continue;
    }
    if (isSafeAssetId(value)) {
      if (!byId.has(value)) {
        errors.push(
          issue('asset-reference-missing', `pack.json 引用的资产不存在：${value}（来源 ${source}）`, { assetId: value }),
        );
      } else {
        record(value, source);
      }
      continue;
    }
    if (value.includes('/')) {
      const candidates = SHORT_ID_EXTENSIONS.map((extension) => `${ASSET_PATH_PREFIX}icons/${value}.${extension}`);
      const matched = candidates.map((file) => fileToId.get(file)).find((assetId) => assetId !== undefined);
      if (matched === undefined) {
        warnings.push(
          issue(
            'asset-short-id-missing',
            `短 id 图标没有对应资产文件（不阻断，运行时退回几何徽记）：${value}（来源 ${source}；约定 ${candidates.join(' / ')}）`,
          ),
        );
      } else {
        record(matched, source);
      }
    }
    // 其它形状（无法识别为资产引用）忽略：validatePack 已对 pack.icon 做格式校验。
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 解析并校验 `assets/manifest.json`（+ 可选 `pack.json` 引用完整性）。
 * 一次聚合全部问题，不抛异常。没有清单时调用方不该调用本函数。
 */
export function verifyPackAssetManifest(options: PackAssetVerifyOptions): PackAssetVerifyReport {
  const errors: AssetIssue[] = [];
  const warnings: AssetIssue[] = [];
  const entries = new Map<string, AssetEntry>();
  const empty = (manifest?: AssetManifest): PackAssetVerifyReport => ({
    ok: false,
    errors,
    warnings,
    ...(manifest !== undefined ? { manifest } : {}),
    entries,
  });

  let text: string;
  if (typeof options.manifest === 'string') {
    text = options.manifest;
  } else {
    try {
      text = UTF8_DECODER.decode(options.manifest);
    } catch {
      errors.push(issue('manifest-text', 'assets/manifest.json 不是合法的 UTF-8 文本'));
      return empty();
    }
  }
  text = text.replace(/^\uFEFF/u, '');

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    errors.push(
      issue(
        'manifest-json',
        `assets/manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return empty();
  }
  if (!isRecord(raw)) {
    errors.push(issue('manifest-shape', 'assets/manifest.json 顶层必须是 JSON 对象'));
    return empty();
  }

  const contents = toContentMap(options.contents);
  const files = new Set<string>(options.files ?? []);
  if (contents !== undefined) for (const file of contents.keys()) files.add(file);
  const packId = isRecord(options.pack) && typeof options.pack.packId === 'string' ? options.pack.packId : undefined;
  const checked = checkManifest(raw, {
    ...(contents !== undefined ? { contents } : {}),
    ...(files.size > 0 ? { files } : {}),
    ...(packId !== undefined ? { packId } : {}),
  });
  errors.push(...checked.errors);
  warnings.push(...checked.warnings);
  for (const [assetId, entry] of checked.entries) entries.set(assetId, entry);

  // 引用完整性：被引用必须存在（error），存在但无人引用 → 孤立资产 warning（M8.1 口径）
  if (options.pack !== undefined) {
    const references = resolveReferences(collectPackAssetReferences(options.pack), entries, errors, warnings);
    const referencedIds = new Set(references.map((reference) => reference.assetId));
    for (const assetId of entries.keys()) {
      if (!referencedIds.has(assetId)) {
        warnings.push(issue('asset-orphan', `孤立资产（pack.json 未引用，不阻断）：${assetId}`, { assetId }));
      }
    }
  }

  const manifest = raw as unknown as AssetManifest;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    entries,
  };
}
