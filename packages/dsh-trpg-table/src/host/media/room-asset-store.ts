/**
 * 房间资产存储（M9.5d）：落座上传的玩家展示资产（头像/立绘/变体/帧表/图标）。
 *
 * 路径：与房间存档同一父目录的内容寻址资产区
 * `<DSH_HOME>/profile-data/<profile>/dsh-trpg-table/room-assets/<roomId>/<sha256>.<ext>`
 * （`defaultRoomsDir()` 的上层 + `room-assets/`；见 `persistence.ts`）。
 *
 * 规则（UI-CONTRACT §4.1/§4.5/§8）：
 * - 按 sha256 去重（同内容只落一份文件，重复引用不重复写）；
 * - 写临时文件 + rename 原子写，避免半截文件；
 * - 房间关闭**不删**（续团保留），只清内存索引；
 * - 只收 PNG/SVG；SVG 一律走白名单净化后重建（同输入同字节、可复现 sha256）；
 * - 尺寸/体积按标准档强制（avatar 256、portrait 768×1024、帧表 rows×cols×frameSize、icon 128/32）；
 * - 读取端做路径安全校验（roomId/sha256/ext 严格正则 + 归一化后前缀检查）。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  ASSET_TARGETS,
  readPngInfo,
  sanitizeSvg,
  sha256Hex,
  sniffImageFormat,
} from '../../../../assets/src/index.ts';
import { RoomError } from '@dsh-trpg/rooms';
import {
  ROOM_ASSET_LIMITS,
  type AssetsUploadedAsset,
  type CharacterAssetKind,
  type CharacterAssetRefInput,
  type CharacterAssetUploadItem,
  type RoomAssetView,
} from '@dsh-trpg/protocol';
import { defaultRoomsDir } from '../persistence.ts';

/** 房间资产区根目录（默认 `<profile-data>/dsh-trpg-table/room-assets`）。 */
export function defaultRoomAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultRoomsDir(env)), 'room-assets');
}

/** 房间 id 规范（UUID 由 host 生成；这里只做路径安全约束）。 */
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_EXTENSIONS = ['png', 'svg'] as const;
type AssetExtension = (typeof ASSET_EXTENSIONS)[number];

/** 帧表每格允许的边长范围（契约 §8.1：每格 128，留出 16–256 的可配空间）。 */
const MIN_FRAME_SIZE = 16;
const MAX_FRAME_SIZE = 256;
const MAX_SPRITE_EDGE = 2048;

/** 房间资产索引里的一条（JSON 可序列化；随房间续团保留）。 */
export interface StoredRoomAsset {
  sha256: string;
  ext: AssetExtension;
  kind: CharacterAssetKind;
  variant?: string;
  width: number;
  height: number;
  bytes: number;
  rows?: number;
  cols?: number;
  frameSize?: number;
  ownerId: string;
  createdAt: number;
}

interface RoomAssetIndex {
  schemaVersion: 1;
  roomId: string;
  assets: StoredRoomAsset[];
}

export interface RoomAssetStoreOptions {
  /** 显式目录（测试用）；默认走 DSH profile-data。 */
  dir?: string;
  /** 环境变量来源（默认目录用；测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 上传频率限流（每玩家/房间；默认 10 次/分钟，够客户端重试与多表情上传）。 */
  uploadRateLimit?: { max: number; windowMs: number };
  now?: () => number;
  log?: (message: string) => void;
}

/** `room-http` 依赖的最小接口（方便注入假实现）。 */
export interface RoomAssetsStore {
  store(roomId: string, ownerId: string, items: CharacterAssetUploadItem[]): { assets: AssetsUploadedAsset[] };
  read(roomId: string, sha256: string, ext: string): { bytes: Uint8Array; sha256: string; contentType: string } | undefined;
  canonicalizeRefs(roomId: string, refs: CharacterAssetRefInput[]): CharacterAssetRefInput[];
  listRoom(roomId: string): RoomAssetView[];
}

const CONTENT_TYPES: Readonly<Record<AssetExtension, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
};

interface DecodedImage {
  bytes: Uint8Array;
  ext: AssetExtension;
  width: number;
  height: number;
}

function isAssetExtension(value: string): value is AssetExtension {
  return (ASSET_EXTENSIONS as readonly string[]).includes(value);
}

/** base64 → 字节（严格：只接受标准字母表 + 末尾 padding，空白剥掉）。 */
function decodeBase64Strict(value: string, label: string): Uint8Array {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0) throw new RoomError('bad-request', `${label} 的 b64 为空`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new RoomError('bad-request', `${label} 的 b64 不是合法 Base64`);
  }
  return Buffer.from(compact, 'base64');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 解码 + 格式/尺寸/体积校验（按 kind 的标准档强制）。
 * @returns 校验通过的图片（PNG 原样、SVG 净化后重建）。
 * @throws RoomError `bad-request`（中文可读原因）。
 */
function decodeUploadedImage(item: CharacterAssetUploadItem, index: number): DecodedImage {
  const label = `assets[${index}]（${item.kind}）`;
  if (item.kind === 'portraitVariant' && (item.variant === undefined || item.variant.length === 0)) {
    throw new RoomError('bad-request', `${label} 是表情/动作变体，必须带 variant 名（如 idle / smile）`);
  }
  const raw = decodeBase64Strict(item.b64, label);
  if (raw.length === 0) throw new RoomError('bad-request', `${label} 的图片字节为空`);
  const sniffed = sniffImageFormat(raw);
  if (sniffed !== 'png' && sniffed !== 'svg') {
    throw new RoomError('bad-request', `${label} 只收 PNG / SVG 图片（检测到 ${sniffed === 'unknown' ? '未知格式' : sniffed.toUpperCase()}）`);
  }
  if (sniffed === 'svg') {
    if (item.kind !== 'icon') {
      throw new RoomError('bad-request', `${label}：SVG 只支持 icon（头像/立绘/变体请上传 PNG）`);
    }
    const sanitized = sanitizeSvg(raw);
    if (!sanitized.ok || sanitized.svg === undefined) {
      throw new RoomError('bad-request', `${label} 的 SVG 未通过白名单净化：${sanitized.errors[0] ?? '未知原因'}`);
    }
    const bytes = new TextEncoder().encode(sanitized.svg);
    if (bytes.length > ASSET_TARGETS['icon-128'].maxBytes) {
      throw new RoomError('bad-request', `${label} 的 SVG 体积超限：${formatBytes(bytes.length)} / 上限 ${formatBytes(ASSET_TARGETS['icon-128'].maxBytes)}`);
    }
    // 净化器强制 viewBox 0 0 128 128
    return { bytes, ext: 'svg', width: 128, height: 128 };
  }
  let info;
  try {
    info = readPngInfo(raw);
  } catch (error) {
    throw new RoomError('bad-request', `${label} 的 PNG 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const width = info.width;
  const height = info.height;
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    throw new RoomError('bad-request', `${label} 的尺寸非法：${width}×${height}`);
  }
  return { bytes: raw, ext: 'png', width, height };
}

/** 按 kind 校验尺寸/体积（PNG/SVG 都走这里；返回帧表参数）。 */
function validateStandardTarget(
  item: CharacterAssetUploadItem,
  image: DecodedImage,
  index: number,
): Pick<StoredRoomAsset, 'rows' | 'cols' | 'frameSize'> {
  const label = `assets[${index}]（${item.kind}）`;
  const sizeText = `${image.width}×${image.height}`;
  const checkBytes = (maxBytes: number, targetLabel: string): void => {
    if (image.bytes.length > maxBytes) {
      throw new RoomError(
        'bad-request',
        `${label} 体积超限：${formatBytes(image.bytes.length)} / ${targetLabel} 上限 ${formatBytes(maxBytes)}；请换更小的图或降档`,
      );
    }
  };
  switch (item.kind) {
    case 'avatar':
      if (image.width !== 256 || image.height !== 256) {
        throw new RoomError('bad-request', `${label} 必须是 256×256 的头像（收到 ${sizeText}）`);
      }
      checkBytes(ASSET_TARGETS['avatar-256'].maxBytes, '头像');
      return {};
    case 'portrait':
      if (image.width !== 768 || image.height !== 1024) {
        throw new RoomError('bad-request', `${label} 必须是 768×1024 的立绘（收到 ${sizeText}）`);
      }
      checkBytes(ASSET_TARGETS.portrait.maxBytes, '立绘');
      return {};
    case 'portraitVariant':
      if (image.width !== 768 || image.height !== 1024) {
        throw new RoomError('bad-request', `${label} 必须是 768×1024 的立绘变体（收到 ${sizeText}）`);
      }
      checkBytes(ASSET_TARGETS.variant.maxBytes, '立绘变体');
      return {};
    case 'icon':
      if (image.ext === 'svg') {
        checkBytes(ASSET_TARGETS['icon-128'].maxBytes, 'SVG 图标');
        return {};
      }
      if (!((image.width === 128 && image.height === 128) || (image.width === 32 && image.height === 32))) {
        throw new RoomError('bad-request', `${label} 必须是 128×128 或 32×32 的图标（收到 ${sizeText}）`);
      }
      checkBytes(
        image.width === 32 ? ASSET_TARGETS['pixel-32'].maxBytes : ASSET_TARGETS['icon-128'].maxBytes,
        image.width === 32 ? '像素图标' : '图标',
      );
      return {};
    case 'spriteSheet': {
      const meta = item.meta;
      const rows = meta?.rows;
      const cols = meta?.cols;
      const frameSize = meta?.frameSize;
      if (rows === undefined || cols === undefined || frameSize === undefined) {
        throw new RoomError('bad-request', `${label} 是帧表，必须提供 meta{rows,cols,frameSize}`);
      }
      if (!Number.isInteger(rows) || rows < 1 || rows > 8 || !Number.isInteger(cols) || cols < 1 || cols > 8) {
        throw new RoomError('bad-request', `${label} 的帧表行列必须是 1–8 的整数（收到 ${rows}×${cols}）`);
      }
      if (!Number.isInteger(frameSize) || frameSize < MIN_FRAME_SIZE || frameSize > MAX_FRAME_SIZE) {
        throw new RoomError('bad-request', `${label} 的 frameSize 必须是 ${MIN_FRAME_SIZE}–${MAX_FRAME_SIZE} 的整数（收到 ${String(frameSize)}）`);
      }
      if (cols * frameSize > MAX_SPRITE_EDGE || rows * frameSize > MAX_SPRITE_EDGE) {
        throw new RoomError('bad-request', `${label} 的帧表尺寸超限（${cols * frameSize}×${rows * frameSize}，单边上限 ${MAX_SPRITE_EDGE}）`);
      }
      if (image.width !== cols * frameSize || image.height !== rows * frameSize) {
        throw new RoomError(
          'bad-request',
          `${label} 的帧表尺寸与网格不符：图片 ${sizeText}，应为 ${cols * frameSize}×${rows * frameSize}（${cols} 列 × ${rows} 行 × 每格 ${frameSize}）`,
        );
      }
      checkBytes(ASSET_TARGETS.spritesheet.maxBytes, '帧表');
      return { rows, cols, frameSize };
    }
  }
}

/** 单次上传频率限流默认值（每玩家/房间 10 次/分钟）。 */
const DEFAULT_UPLOAD_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const;

/**
 * 房间资产存储：内容寻址 + 索引文件（`index.json`）持久化。
 *
 * 索引懒加载：第一次访问某房间时读 `<dir>/<roomId>/index.json`，缺失/损坏按空处理。
 * 房间关闭不删文件与索引（续团保留）；索引与文件都按 sha256 去重。
 */
export class RoomAssetStore implements RoomAssetsStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly indexes = new Map<string, Map<string, StoredRoomAsset>>();
  private readonly uploadRateLimit: { max: number; windowMs: number };
  private readonly uploadHits = new Map<string, number[]>();

  constructor(options: RoomAssetStoreOptions = {}) {
    this.dir = resolve(options.dir ?? defaultRoomAssetsDir(options.env ?? process.env));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    const max = Math.max(1, Math.trunc(options.uploadRateLimit?.max ?? DEFAULT_UPLOAD_RATE_LIMIT.max));
    const windowMs = Math.max(1000, Math.trunc(options.uploadRateLimit?.windowMs ?? DEFAULT_UPLOAD_RATE_LIMIT.windowMs));
    this.uploadRateLimit = { max, windowMs };
  }

  /** 房间资产目录（绝对路径；测试/诊断用）。 */
  roomDir(roomId: string): string {
    this.assertRoomId(roomId);
    return join(this.dir, roomId);
  }

  /** 一条资产的落盘路径（绝对路径；测试/诊断用）。 */
  assetPath(roomId: string, sha256: string, ext: AssetExtension): string {
    this.assertRoomId(roomId);
    if (!SHA256_PATTERN.test(sha256)) throw new RoomError('bad-request', `sha256 非法：${JSON.stringify(sha256)}`);
    return join(this.roomDir(roomId), `${sha256}.${ext}`);
  }

  /** 上传落盘（token + 房间成员校验由 room-http 完成）：限流 + 去重 + 原子写 + 索引更新。 */
  store(roomId: string, ownerId: string, items: CharacterAssetUploadItem[]): { assets: AssetsUploadedAsset[] } {
    this.assertRoomId(roomId);
    const limitError = this.takeUploadSlot(roomId, ownerId);
    if (limitError !== undefined) throw new RoomError('conflict', limitError);
    if (items.length > ROOM_ASSET_LIMITS.maxFiles) {
      throw new RoomError(
        'conflict',
        `单次最多上传 ${ROOM_ASSET_LIMITS.maxFiles} 个资产（当前 ${items.length} 个）：请删掉不用的表情或换更小的图`,
      );
    }
    const decoded: Array<{ item: CharacterAssetUploadItem; image: DecodedImage; index: number }> = [];
    let totalBytes = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const image = decodeUploadedImage(item, index);
      totalBytes += image.bytes.length;
      decoded.push({ item, image, index });
    }
    if (totalBytes > ROOM_ASSET_LIMITS.maxBytes) {
      throw new RoomError(
        'conflict',
        `上传资产总量超限：当前 ${formatBytes(totalBytes)} / 上限 ${formatBytes(ROOM_ASSET_LIMITS.maxBytes)}；请删掉不用的表情或换更小的图`,
      );
    }

    const index = this.loadIndex(roomId);
    const now = this.now();
    const outputs: AssetsUploadedAsset[] = [];
    let mutated = false;
    for (const { item, image, index: itemIndex } of decoded) {
      const spriteMeta = validateStandardTarget(item, image, itemIndex);
      const sha256 = sha256Hex(image.bytes);
      const existing = index.get(sha256);
      if (existing === undefined) {
        const target = this.assetPath(roomId, sha256, image.ext);
        this.ensureRoomDir(roomId);
        if (!existsSync(target)) {
          // 原子写：临时文件（同目录）→ rename；目标已存在（并发同内容）则跳过（内容寻址幂等）。
          const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
          writeFileSync(tmp, image.bytes);
          renameSync(tmp, target);
        }
        index.set(sha256, {
          sha256,
          ext: image.ext,
          kind: item.kind,
          ...(item.variant !== undefined ? { variant: item.variant } : {}),
          width: image.width,
          height: image.height,
          bytes: image.bytes.length,
          ...spriteMeta,
          ownerId,
          createdAt: now,
        });
        mutated = true;
      }
      outputs.push({
        assetId: sha256,
        kind: item.kind,
        ...(item.variant !== undefined ? { variant: item.variant } : {}),
        sha256,
        url: this.urlOfKnown(roomId, sha256, existing ?? index.get(sha256)!),
        width: image.width,
        height: image.height,
        bytes: image.bytes.length,
      });
    }
    if (mutated) this.writeIndex(roomId, index);
    return { assets: outputs };
  }

  /** 房间资产列表（按上传时间正序；`RoomView.assets` 数据源）。 */
  listRoom(roomId: string): RoomAssetView[] {
    if (!ROOM_ID_PATTERN.test(roomId)) return [];
    const index = this.loadIndex(roomId);
    return [...index.values()]
      .sort((left, right) => left.createdAt - right.createdAt || left.sha256.localeCompare(right.sha256))
      .map((entry) => ({
        assetId: entry.sha256,
        kind: entry.kind,
        ...(entry.variant !== undefined ? { variant: entry.variant } : {}),
        sha256: entry.sha256,
        url: this.urlOfKnown(roomId, entry.sha256, entry),
        width: entry.width,
        height: entry.height,
        bytes: entry.bytes,
        ownerId: entry.ownerId,
      }));
  }

  /**
   * 读一条资产字节（`GET /trpg/room-assets/...`）。
   * 路径安全：roomId/sha256/ext 全部严格校验，拼出的绝对路径必须落在房间目录内。
   * @returns 未登记/文件不存在/扩展名不匹配时 undefined。
   */
  read(roomId: string, sha256: string, ext: string): { bytes: Uint8Array; sha256: string; contentType: string } | undefined {
    if (!ROOM_ID_PATTERN.test(roomId)) return undefined;
    if (!SHA256_PATTERN.test(sha256)) return undefined;
    if (!isAssetExtension(ext)) return undefined;
    const index = this.loadIndex(roomId);
    const entry = index.get(sha256);
    if (entry === undefined || entry.ext !== ext) return undefined;
    const target = this.assetPath(roomId, sha256, ext);
    const roomRoot = `${this.roomDir(roomId)}${sep}`;
    const normalized = resolve(target);
    if (!normalized.startsWith(roomRoot)) {
      this.log(`room-assets 路径越权已拒绝：${normalized}`);
      return undefined;
    }
    if (!existsSync(normalized)) return undefined;
    try {
      const bytes = new Uint8Array(readFileSync(normalized));
      if (bytes.length !== entry.bytes) return undefined;
      return { bytes, sha256, contentType: CONTENT_TYPES[ext] };
    } catch (error) {
      this.log(`room-assets 读取失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** sha256 → 无 token 只读 URL（未登记返回 undefined）。 */
  urlOf(roomId: string, sha256: string): string | undefined {
    if (!ROOM_ID_PATTERN.test(roomId) || !SHA256_PATTERN.test(sha256)) return undefined;
    const entry = this.loadIndex(roomId).get(sha256);
    if (entry === undefined) return undefined;
    return this.urlOfKnown(roomId, sha256, entry);
  }

  /**
   * 把落座提交的资产引用规范化成 host 权威引用：
   * 只保留本房间已登记的 sha256（上传失败/未上传的引用丢弃，落座不阻断），URL 由 host 重算。
   */
  canonicalizeRefs(roomId: string, refs: CharacterAssetRefInput[]): CharacterAssetRefInput[] {
    if (!ROOM_ID_PATTERN.test(roomId) || refs.length === 0) return [];
    const index = this.loadIndex(roomId);
    const output: CharacterAssetRefInput[] = [];
    for (const ref of refs) {
      const entry = index.get(ref.sha256);
      if (entry === undefined) continue;
      output.push({
        kind: ref.kind,
        ...(ref.variant !== undefined ? { variant: ref.variant } : {}),
        sha256: ref.sha256,
        url: this.urlOfKnown(roomId, ref.sha256, entry),
        // 帧表元数据以 host 落盘记录为准（客户端不用回传就能拿到 rows/cols/frameSize）。
        ...(entry.rows !== undefined && entry.cols !== undefined && entry.frameSize !== undefined
          ? { meta: { rows: entry.rows, cols: entry.cols, frameSize: entry.frameSize } }
          : {}),
      });
    }
    return output;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private assertRoomId(roomId: string): void {
    if (!ROOM_ID_PATTERN.test(roomId)) {
      throw new RoomError('bad-request', `房间 id 非法（不允许用于文件路径）：${JSON.stringify(roomId)}`);
    }
  }

  /**
   * 上传频率限流（每 `roomId:ownerId` 滑动窗口）。
   * @returns `undefined` = 允许本次；否则中文错误（含等待秒数）。
   */
  private takeUploadSlot(roomId: string, ownerId: string): string | undefined {
    const key = `${roomId}:${ownerId}`;
    const now = this.now();
    const cutoff = now - this.uploadRateLimit.windowMs;
    const hits = (this.uploadHits.get(key) ?? []).filter((at) => at > cutoff);
    if (hits.length >= this.uploadRateLimit.max) {
      this.uploadHits.set(key, hits);
      const waitSeconds = Math.max(1, Math.ceil(((hits[0] ?? now) + this.uploadRateLimit.windowMs - now) / 1000));
      return `上传太频繁：每 ${Math.round(this.uploadRateLimit.windowMs / 1000)} 秒最多 ${this.uploadRateLimit.max} 次，请 ${waitSeconds} 秒后再试`;
    }
    hits.push(now);
    this.uploadHits.set(key, hits);
    if (this.uploadHits.size > 2000) {
      for (const [candidate, at] of this.uploadHits) {
        if (at.length === 0 || (at[at.length - 1] ?? 0) <= cutoff) this.uploadHits.delete(candidate);
      }
    }
    return undefined;
  }

  private urlOfKnown(roomId: string, sha256: string, entry: StoredRoomAsset): string {
    return `/trpg/room-assets/${roomId}/${sha256}.${entry.ext}`;
  }

  private ensureRoomDir(roomId: string): void {
    mkdirSync(this.roomDir(roomId), { recursive: true });
  }

  private indexFileOf(roomId: string): string {
    return join(this.roomDir(roomId), 'index.json');
  }

  private loadIndex(roomId: string): Map<string, StoredRoomAsset> {
    const cached = this.indexes.get(roomId);
    if (cached !== undefined) return cached;
    const index = new Map<string, StoredRoomAsset>();
    const file = this.indexFileOf(roomId);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as RoomAssetIndex;
        if (parsed.schemaVersion === 1 && Array.isArray(parsed.assets)) {
          for (const entry of parsed.assets) {
            if (this.isStoredAsset(entry)) index.set(entry.sha256, entry);
          }
        } else {
          this.log(`room-assets 索引格式不识别，按空处理：${file}`);
        }
      } catch (error) {
        this.log(`room-assets 索引读取失败（按空处理）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.indexes.set(roomId, index);
    return index;
  }

  private isStoredAsset(value: unknown): value is StoredRoomAsset {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entry = value as Partial<StoredRoomAsset>;
    if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) return false;
    if (entry.ext !== 'png' && entry.ext !== 'svg') return false;
    if (typeof entry.kind !== 'string') return false;
    if (typeof entry.width !== 'number' || typeof entry.height !== 'number' || typeof entry.bytes !== 'number') return false;
    if (typeof entry.ownerId !== 'string' || typeof entry.createdAt !== 'number') return false;
    return true;
  }

  private writeIndex(roomId: string, index: Map<string, StoredRoomAsset>): void {
    try {
      this.ensureRoomDir(roomId);
      const file = this.indexFileOf(roomId);
      const payload: RoomAssetIndex = {
        schemaVersion: 1,
        roomId,
        assets: [...index.values()].sort((left, right) => left.createdAt - right.createdAt || left.sha256.localeCompare(right.sha256)),
      };
      const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      renameSync(tmp, file);
    } catch (error) {
      this.log(`room-assets 索引写入失败：${error instanceof Error ? error.message : String(error)}`);
      throw new RoomError('internal', '房间资产索引写入失败，请检查磁盘权限/剩余空间');
    }
  }
}
