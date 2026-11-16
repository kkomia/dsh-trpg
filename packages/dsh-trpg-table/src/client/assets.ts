/**
 * M9.5d 玩家角色资产（Client 半边）：本地私卡资产存储 + 生成/上传管线 + 自备接口。
 *
 * 口径（docs/UI-CONTRACT §4.4/§7.2/§8）：
 * - 私卡资产默认在**浏览器 IndexedDB**（库 `dsh-trpg-assets`、store `cardAssets`、
 *   key `<cardId>:<assetId>`）；localStorage 只放设置/上传缓存等文本，**不放二进制**。
 * - 落座只上传「展示用」白名单资产（头像/立绘/表情变体/帧表 ≤8 个 / ≤8 MiB），
 *   host 内容寻址落盘后回传 sha256 + `/trpg/room-assets/<roomId>/<sha256>.<ext>`。
 * - 生图默认走 host（`assets.generate`，服务未配置时 host 返回中文错误，原样展示）；
 *   可选玩家自备 OpenAI 兼容接口（baseUrl/key/model 只存本机，浏览器直连，需 CORS）。
 * - 客户端不做图片归一化（host 归一化），这里只做**前端预检**（格式/体积/尺寸）供预览。
 *
 * 不新增依赖：PNG 尺寸读 IHDR、SVG 尺寸读根属性/viewBox、sha256 用 WebCrypto。
 */
import type {
  AssetsGenerateCandidate,
  AssetsGenerateParams,
  AssetsGenerateResult,
  AssetsUploadedAsset,
  CharacterAssetRefInput,
  CharacterAssetMeta,
} from '@dsh-trpg/protocol';
import { callRpc, rpcErrorMessage } from './rpc.ts';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 本地卡资产 kind（与协议 `CharacterAssetKind` 同口径）。 */
export type CardAssetKind = 'avatar' | 'portrait' | 'portraitVariant' | 'spriteSheet' | 'icon';

/** 本地卡资产记录（IndexedDB `cardAssets` 的 value）。 */
export interface CardAssetRecord {
  /** 主键：`<cardId>:<assetId>`（UI-CONTRACT §4.4）。 */
  key: string;
  cardId: string;
  /** 卡内资产 id，如 `avatar.main` / `portrait.smile`（不含卡 id）。 */
  assetId: string;
  kind: CardAssetKind;
  /** 表情/动作变体名（`portraitVariant` 必有）。 */
  variant?: string;
  /** 图片字节的 base64（IndexedDB 里也只存文本，避免结构化克隆大对象）。 */
  bytes: string;
  format: 'png' | 'svg';
  width: number;
  height: number;
  /** 64 位小写十六进制 sha256（内容寻址；上传去重与 host 校验一致）。 */
  sha256: string;
  /** 帧表切分元数据（`spriteSheet` 存：rows/cols/frameSize）。 */
  meta?: CharacterAssetMeta;
  createdAt: number;
}

export type CardAssetFormat = 'png' | 'svg';

/** 前端预检的单文件体积上限（字节）；生成/上传由 host 归一化，这里只挡明显超限。 */
export const LOCAL_ASSET_BYTE_LIMITS: Record<CardAssetKind, number> = {
  avatar: 128 * 1024,
  portrait: 512 * 1024,
  portraitVariant: 512 * 1024,
  spriteSheet: 2 * 1024 * 1024,
  icon: 128 * 1024,
};

/** 落座上传限额（与协议 `ROOM_ASSET_LIMITS` 同口径；UI-CONTRACT §4.5）。 */
export const SEAT_UPLOAD_LIMITS = { maxFiles: 8, maxBytes: 8 * 1024 * 1024 } as const;

/** 目标尺寸建议（UI-CONTRACT §8.2：变体 768×1024、帧表单格 128）。 */
export const ASSET_TARGET_SIZES: Record<'avatar' | 'portrait' | 'sprite', { width: number; height: number }> = {
  avatar: { width: 256, height: 256 },
  portrait: { width: 768, height: 1024 },
  sprite: { width: 512, height: 512 },
};

/** 固定表情变体集（UI-CONTRACT §8.1；未配置的按立绘回退）。 */
export const VARIANT_PRESETS = ['idle', 'smile', 'sad', 'angry', 'attack'] as const;

/** 生图风格（与协议 `MediaAssetStyle` 同口径；玩家侧只暴露像素/2D 两档）。 */
export type PlayerGenStyle = 'pixel-32' | 'game-2d';

/** 生成目标（对应协议 `MediaAssetKind`）。 */
export type PlayerGenKind = 'avatar' | 'portrait' | 'sprite';

export const STYLE_LABELS: Record<PlayerGenStyle, string> = {
  'pixel-32': '像素风',
  'game-2d': '2D 风',
};

export const KIND_LABELS: Record<CardAssetKind, string> = {
  avatar: '头像',
  portrait: '立绘',
  portraitVariant: '表情变体',
  spriteSheet: '帧表',
  icon: '图标',
};

/** 自备 OpenAI 兼容接口设置（只存本机 localStorage，不进房间、不上传）。 */
export interface CustomEndpointSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SETTINGS_KEY = 'dsh-trpg:assets:settings:v1';
const UPLOAD_CACHE_KEY = 'dsh-trpg:assets:upload-cache:v1';
const UPLOAD_CACHE_MAX_ROOMS = 8;
const UPLOAD_CACHE_MAX_ROOM_ENTRIES = 64;

// ---------------------------------------------------------------------------
// 纯工具：base64 / sha256 / 图片嗅探 / URL
// ---------------------------------------------------------------------------

/** bytes → base64（分块，避免大数组 spread 爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** base64 → bytes（坏 base64 抛错，调用方转中文提示）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** WebCrypto sha256（小写十六进制）；不可用时抛带中文说明的错误。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new Error('当前环境不支持计算 sha256（需要安全上下文：localhost / https）');
  const digest = await subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** PNG 尺寸（IHDR：宽高各 4 字节大端）；非合法 PNG 返回 null。 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
  const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

function latin1Prefix(bytes: Uint8Array, length: number): string {
  let text = '';
  for (let index = 0; index < Math.min(bytes.length, length); index += 1) text += String.fromCharCode(bytes[index]!);
  return text;
}

/** 嗅探图片格式（只收 PNG/SVG；其它给中文拒绝原因）。 */
export function sniffImageFormat(bytes: Uint8Array): CardAssetFormat | null {
  if (pngSize(bytes) !== null) return 'png';
  const prefix = latin1Prefix(bytes, 512).trim();
  if (/^<svg[\s>]/i.test(prefix) || (/^<\?xml/i.test(prefix) && /<svg[\s>]/i.test(prefix))) return 'svg';
  return null;
}

function svgText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return latin1Prefix(bytes, bytes.length);
  }
}

/** SVG 尺寸：读根 width/height，缺失时读 viewBox；都缺失按 0 处理（由调用方提示）。 */
export function svgSize(bytes: Uint8Array): { width: number; height: number } {
  const text = svgText(bytes);
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? '';
  const width = /\bwidth\s*=\s*["']\s*([0-9.]+)(?:px)?\s*["']/i.exec(tag)?.[1];
  const height = /\bheight\s*=\s*["']\s*([0-9.]+)(?:px)?\s*["']/i.exec(tag)?.[1];
  if (width !== undefined && height !== undefined) {
    const w = Number.parseFloat(width);
    const h = Number.parseFloat(height);
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: Math.round(w), height: Math.round(h) };
  }
  const viewBox = /\bviewBox\s*=\s*["']\s*([-0-9.]+)[\s,]+([-0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
  if (viewBox !== null) {
    const w = Number.parseFloat(viewBox[3] ?? '');
    const h = Number.parseFloat(viewBox[4] ?? '');
    if (Number.isFinite(w) && Number.isFinite(h)) return { width: Math.round(w), height: Math.round(h) };
  }
  return { width: 0, height: 0 };
}

/** host 回传的资产 URL 可能是相对路径；拼成可直接给 `<img src>` 的绝对地址。 */
export function resolveAssetUrl(base: string | undefined, url: string | undefined): string | undefined {
  if (typeof url !== 'string' || url.trim().length === 0) return undefined;
  const trimmed = url.trim();
  if (/^(https?:|blob:|data:)/i.test(trimmed)) return trimmed;
  if (!base) return undefined;
  const root = base.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? `${root}${trimmed}` : `${root}/${trimmed}`;
}

/** 生图目标 kind → 落座上传用的 kind。 */
export function uploadKindOf(target: PlayerGenKind): CardAssetKind {
  return target === 'sprite' ? 'spriteSheet' : target;
}

/**
 * host 落座上传的「标准档」尺寸（与 host 的 validateStandardTarget 同口径）：
 * 客户端先挡掉不合规的本地图，避免一张不合规把整批上传都拒掉；真正归一化仍由 host/AI 生图完成。
 */
export function hostStandardIssue(record: Pick<CardAssetRecord, 'kind' | 'width' | 'height' | 'meta'>): string | null {
  const { kind, width, height } = record;
  if (kind === 'avatar' && (width !== 256 || height !== 256)) return `头像须 256×256（当前 ${width}×${height}）`;
  if ((kind === 'portrait' || kind === 'portraitVariant') && (width !== 768 || height !== 1024)) {
    return `${kind === 'portrait' ? '立绘' : '立绘变体'}须 768×1024（当前 ${width}×${height}）`;
  }
  if (kind === 'spriteSheet') {
    const rows = record.meta?.rows;
    const cols = record.meta?.cols;
    const frameSize = record.meta?.frameSize;
    if (rows === undefined || cols === undefined || frameSize === undefined) return '帧表缺 meta{rows,cols,frameSize}';
    if (width !== cols * frameSize || height !== rows * frameSize) {
      return `帧表 ${width}×${height} 与网格 ${cols}×${rows}×${frameSize} 不符`;
    }
  }
  if (kind === 'icon' && !((width === 128 && height === 128) || (width === 32 && height === 32))) {
    return `图标须 128×128 或 32×32（当前 ${width}×${height}）`;
  }
  return null;
}

/** 目标尺寸（生成提示/预检用）。 */
export function sizeOf(kind: CardAssetKind): { width: number; height: number } {
  if (kind === 'avatar') return ASSET_TARGET_SIZES.avatar;
  if (kind === 'spriteSheet') return ASSET_TARGET_SIZES.sprite;
  if (kind === 'portrait' || kind === 'portraitVariant') return ASSET_TARGET_SIZES.portrait;
  return ASSET_TARGET_SIZES.avatar;
}

/**
 * 卡内 assetId：`<kind>.<variant|main>`（UI-CONTRACT §8.1 的 `card:avatar.main` 形状）。
 * 同一个卡/kind/变体只有一份，重新导入即替换。
 */
export function assetIdOf(kind: CardAssetKind, variant?: string): string {
  const suffix = kind === 'portraitVariant' && variant !== undefined && variant.length > 0 ? variant : 'main';
  return `${kind === 'portraitVariant' ? 'portrait' : kind}.${suffix}`;
}

/** 某张卡里按 kind/variant 找已保存资产（未配变体回退主立绘）。 */
export function findCardAsset(
  assets: CardAssetRecord[],
  kind: CardAssetKind,
  variant?: string,
): CardAssetRecord | undefined {
  if (kind === 'portraitVariant') {
    return assets.find((asset) => asset.kind === kind && asset.variant === variant)
      ?? assets.find((asset) => asset.kind === 'portrait')
      ?? assets.find((asset) => asset.kind === 'portraitVariant');
  }
  return assets.find((asset) => asset.kind === kind);
}

/** 单卡展示资产排序：头像 > 立绘 > 变体 > 帧表 > 图标（落座上传按此优先）。 */
const UPLOAD_PRIORITY: CardAssetKind[] = ['avatar', 'portrait', 'portraitVariant', 'spriteSheet', 'icon'];

export function sortForUpload(assets: CardAssetRecord[]): CardAssetRecord[] {
  return [...assets].sort((left, right) => {
    const order = UPLOAD_PRIORITY.indexOf(left.kind) - UPLOAD_PRIORITY.indexOf(right.kind);
    if (order !== 0) return order;
    return left.createdAt - right.createdAt;
  });
}

// ---------------------------------------------------------------------------
// IndexedDB 存储（库 dsh-trpg-assets / store cardAssets / key <cardId>:<assetId>）
// ---------------------------------------------------------------------------

const DB_NAME = 'dsh-trpg-assets';
const DB_VERSION = 1;
const STORE_NAME = 'cardAssets';

/** IDB 不可用时（隐私模式/旧内核）退化为内存表，保证界面可用但刷新即丢。 */
const memoryStore = new Map<string, CardAssetRecord>();
let memoryOnly = false;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openAssetDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      memoryOnly = true;
      resolve(null);
      return;
    }
    try {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('cardId', 'cardId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        memoryOnly = true;
        resolve(null);
      };
      request.onblocked = () => {
        memoryOnly = true;
        resolve(null);
      };
    } catch {
      memoryOnly = true;
      resolve(null);
    }
  });
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务被取消'));
  });
}

/** 是否退化为内存存储（界面上给「刷新后会丢」的提示）。 */
export function isAssetStorageMemoryOnly(): boolean {
  return memoryOnly;
}

/** 读取某张卡的全部本地资产（按创建时间升序）。 */
export async function listCardAssets(cardId: string): Promise<CardAssetRecord[]> {
  const db = await openAssetDb();
  if (db === null) {
    return [...memoryStore.values()].filter((record) => record.cardId === cardId).sort((left, right) => left.createdAt - right.createdAt);
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('cardId');
    const request = index.getAll(cardId);
    request.onsuccess = () => {
      const list = (request.result as CardAssetRecord[]).sort((left, right) => left.createdAt - right.createdAt);
      resolve(list);
    };
    request.onerror = () => reject(request.error ?? new Error('读取本地资产失败'));
  });
}

/** 读单条（含坏数据兜底；界面渲染优先用 list 结果）。 */
export async function loadCardAsset(cardId: string, assetId: string): Promise<CardAssetRecord | null> {
  const db = await openAssetDb();
  if (db === null) return memoryStore.get(`${cardId}:${assetId}`) ?? null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(`${cardId}:${assetId}`);
    request.onsuccess = () => resolve((request.result as CardAssetRecord | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('读取本地资产失败'));
  });
}

/** 保存/替换一条资产（同 key 覆盖；返回落库后的记录）。 */
export async function saveCardAsset(record: CardAssetRecord): Promise<CardAssetRecord> {
  const db = await openAssetDb();
  if (db === null) {
    memoryStore.set(record.key, record);
    return record;
  }
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(record);
  await txDone(tx);
  return record;
}

/** 删除一条资产。 */
export async function deleteCardAsset(cardId: string, assetId: string): Promise<void> {
  const db = await openAssetDb();
  if (db === null) {
    memoryStore.delete(`${cardId}:${assetId}`);
    return;
  }
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(`${cardId}:${assetId}`);
  await txDone(tx);
}

// ---------------------------------------------------------------------------
// 前端预检（格式/体积/尺寸；归一化在 host，客户端不重编码）
// ---------------------------------------------------------------------------

export interface AssetPreflight {
  ok: boolean;
  /** 通过预检时的落库素材（base64 + 尺寸 + sha256）。 */
  b64: string;
  format: CardAssetFormat;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  errors: string[];
  warnings: string[];
}

function emptyPreflight(errors: string[]): AssetPreflight {
  return { ok: false, b64: '', format: 'png', width: 0, height: 0, bytes: 0, sha256: '', errors, warnings: [] };
}

/**
 * 导入前预检：只收 PNG/SVG、体积上限、尺寸建议；返回 base64/尺寸/sha256 供预览与落库。
 * 攻击面说明：SVG 含脚本/外链时不 inline 渲染（统一 `<img>`），这里只给 warning，由 host 归一化拒绝。
 */
export async function preflightAsset(kind: CardAssetKind, bytes: Uint8Array, fileName?: string): Promise<AssetPreflight> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = fileName !== undefined && fileName.length > 0 ? `「${fileName}」` : '文件';
  const format = sniffImageFormat(bytes);
  if (format === null) {
    errors.push(`${name}不是 PNG/SVG（只收 PNG/SVG；JPEG/WebP 请先转存）`);
    return emptyPreflight(errors);
  }
  const limit = LOCAL_ASSET_BYTE_LIMITS[kind];
  if (bytes.length > limit) {
    errors.push(`体积超限：${formatBytes(bytes.length)} > ${formatBytes(limit)}（${KIND_LABELS[kind]}上限）`);
  }
  const size = format === 'png' ? pngSize(bytes) : svgSize(bytes);
  if (size === null || size.width <= 0 || size.height <= 0) {
    errors.push('读不出图片尺寸（PNG 头损坏或 SVG 缺 width/height/viewBox）');
    return { ...emptyPreflight(errors), format, bytes: bytes.length };
  }
  const target = sizeOf(kind);
  if (kind === 'avatar' && Math.abs(size.width - size.height) > Math.max(8, size.width * 0.12)) {
    warnings.push(`头像是 ${size.width}×${size.height}，建议正方形（${target.width}×${target.height}）；落座后显示为小圆/方形裁切`);
  }
  if ((kind === 'portrait' || kind === 'portraitVariant') && Math.abs(size.width / Math.max(1, size.height) - 3 / 4) > 0.18) {
    warnings.push(`立绘是 ${size.width}×${size.height}，建议 3:4（${target.width}×${target.height}）`);
  }
  // host 落座上传只收标准档尺寸；本地预览可以先用，但要提前告诉玩家「上传会被拒」。
  const standardIssue = hostStandardIssue({ kind, width: size.width, height: size.height, meta: undefined });
  if (standardIssue !== null && kind !== 'spriteSheet') {
    warnings.push(`${standardIssue}：本地可预览，但落座上传会被 host 拒绝（AI 生成会自动归一化到标准档）`);
  }
  if (kind === 'spriteSheet' && (size.width % 128 !== 0 || size.height % 128 !== 0)) {
    warnings.push(`帧表按 128 网格切分：整表 ${size.width}×${size.height} 不是 128 的整数倍，落座上传可能被拒`);
  }
  if (format === 'svg') {
    const text = svgText(bytes);
    if (/<script\b|on[a-z]+\s*=|javascript:|<foreignObject\b/i.test(text)) {
      errors.push('SVG 含脚本/事件属性/外部对象：不能作为角色资产（host 归一化也会拒绝）');
    }
  }
  let sha256 = '';
  try {
    sha256 = await sha256Hex(bytes);
  } catch (error) {
    errors.push(rpcErrorMessage(error));
  }
  if (errors.length > 0) {
    return { ok: false, b64: '', format, width: size.width, height: size.height, bytes: bytes.length, sha256: '', errors, warnings };
  }
  return {
    ok: true,
    b64: bytesToBase64(bytes),
    format,
    width: size.width,
    height: size.height,
    bytes: bytes.length,
    sha256,
    errors,
    warnings,
  };
}

/** 人类可读字节数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// ---------------------------------------------------------------------------
// 提示词模板（角色名/种族/职业/外貌/性格可改）
// ---------------------------------------------------------------------------

export interface PromptVariables {
  name?: string;
  race?: string;
  class?: string;
  appearance?: string;
  personality?: string;
}

const KIND_PROMPT: Record<PlayerGenKind, string> = {
  avatar: '角色头像，正面半身，构图居中，面部清晰，纯色背景，无文字',
  portrait: '角色立绘，全身/七分身，站姿自然，服装有细节，纯色背景，无文字',
  sprite: '角色行走帧表，4 行 × 4 列网格，每格 128×128，俯视 45 度，每格姿势一致，纯色背景',
};

const STYLE_PROMPT: Record<PlayerGenStyle, string> = {
  'pixel-32': '像素艺术风格，32 位色，干净硬边轮廓，复古游戏感',
  'game-2d': '2D 游戏插画风格，柔和光影，扁平厚涂，干净背景',
};

/** 提示词变量清理：去掉空段与多余标点。 */
function joinParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('，')
    .replace(/，+/g, '，')
    .replace(/^，|，$/g, '');
}

/** 生成默认提示词（模板变量来自卡面）；玩家可在对话框里改。 */
export function renderPromptTemplate(kind: PlayerGenKind, style: PlayerGenStyle, variables: PromptVariables): string {
  const subject = joinParts([
    variables.name !== undefined && variables.name.length > 0 ? `角色名：${variables.name}` : '',
    [variables.race, variables.class].filter((part) => typeof part === 'string' && part.length > 0).join(' '),
    variables.appearance !== undefined && variables.appearance.length > 0 ? `外貌：${variables.appearance}` : '',
    variables.personality !== undefined && variables.personality.length > 0 ? `性格：${variables.personality}` : '',
  ]);
  return joinParts([KIND_PROMPT[kind], STYLE_PROMPT[style], subject, '不要文字，不要水印']);
}

// ---------------------------------------------------------------------------
// host RPC：生成 / 上传
// ---------------------------------------------------------------------------

/** 调 host 生图（`assets.generate`；服务未配置时抛 host 的中文错误）。 */
export async function requestHostGeneration(
  base: string,
  token: string | undefined,
  params: AssetsGenerateParams,
): Promise<AssetsGenerateResult> {
  return callRpc<AssetsGenerateResult>(base, 'assets.generate', params, token);
}

export interface UploadDisplayResult {
  refs: CharacterAssetRefInput[];
  uploaded: AssetsUploadedAsset[];
  /** 被跳过的资产与原因（超 8 个 / 超 8 MiB / 无 sha256 等）。 */
  skipped: string[];
}

/** 读上传缓存（sha256 → url，按房间）；localStorage 只放文本引用，不放二进制。 */
type UploadCache = Record<string, Record<string, { url: string; at: number }>>;

function readUploadCache(): UploadCache {
  try {
    const raw = globalThis.localStorage?.getItem(UPLOAD_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as UploadCache) : {};
  } catch {
    return {};
  }
}

function writeUploadCache(cache: UploadCache): void {
  try {
    const roomIds = Object.keys(cache);
    if (roomIds.length > UPLOAD_CACHE_MAX_ROOMS) {
      const keep = roomIds
        .sort((left, right) => {
          const leftAt = Math.max(0, ...Object.values(cache[left] ?? {}).map((entry) => entry.at));
          const rightAt = Math.max(0, ...Object.values(cache[right] ?? {}).map((entry) => entry.at));
          return rightAt - leftAt;
        })
        .slice(0, UPLOAD_CACHE_MAX_ROOMS);
      const next: UploadCache = {};
      for (const roomId of keep) next[roomId] = cache[roomId]!;
      globalThis.localStorage?.setItem(UPLOAD_CACHE_KEY, JSON.stringify(next));
      return;
    }
    globalThis.localStorage?.setItem(UPLOAD_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 隐私模式/配额满：缓存丢了只是多传一次 */
  }
}

/** 落座前把展示资产传上 host：sha256 命中缓存的不重复上传；失败抛错由调用方降级。 */
export async function uploadDisplayAssets(
  base: string,
  token: string | undefined,
  roomId: string,
  assets: CardAssetRecord[],
): Promise<UploadDisplayResult> {
  const refs: CharacterAssetRefInput[] = [];
  const uploaded: AssetsUploadedAsset[] = [];
  const skipped: string[] = [];
  const cache = readUploadCache();
  const roomCache = (cache[roomId] = cache[roomId] ?? {});
  const pending: Array<{ record: CardAssetRecord; bytes: number; meta?: CharacterAssetMeta }> = [];
  let total = 0;

  for (const record of sortForUpload(assets)) {
    if (!UPLOAD_PRIORITY.includes(record.kind)) continue;
    const standardIssue = hostStandardIssue(record);
    if (standardIssue !== null) {
      skipped.push(`${KIND_LABELS[record.kind]}${record.variant !== undefined ? `(${record.variant})` : ''}：${standardIssue}`);
      continue;
    }
    const cached = roomCache[record.sha256];
    if (cached !== undefined) {
      refs.push({
        kind: record.kind,
        ...(record.variant !== undefined ? { variant: record.variant } : {}),
        sha256: record.sha256,
        url: cached.url,
        ...(record.meta !== undefined ? { meta: record.meta } : {}),
      });
      continue;
    }
    let bytes = 0;
    try {
      bytes = base64ToBytes(record.bytes).length;
    } catch {
      skipped.push(`${KIND_LABELS[record.kind]}：本地字节损坏，已跳过`);
      continue;
    }
    if (refs.length + pending.length >= SEAT_UPLOAD_LIMITS.maxFiles) {
      skipped.push(`${KIND_LABELS[record.kind]}${record.variant !== undefined ? `(${record.variant})` : ''}：超过 ${SEAT_UPLOAD_LIMITS.maxFiles} 个文件上限`);
      continue;
    }
    if (total + bytes > SEAT_UPLOAD_LIMITS.maxBytes) {
      skipped.push(`${KIND_LABELS[record.kind]}${record.variant !== undefined ? `(${record.variant})` : ''}：超过 8 MiB 总上限`);
      continue;
    }
    total += bytes;
    pending.push({ record, bytes, ...(record.meta !== undefined ? { meta: record.meta } : {}) });
  }

  if (pending.length > 0) {
    try {
      const result = await callRpc<{ assets: AssetsUploadedAsset[] }>(
        base,
        'assets.upload',
        {
          assets: pending.map((entry) => ({
            kind: entry.record.kind,
            ...(entry.record.variant !== undefined ? { variant: entry.record.variant } : {}),
            b64: entry.record.bytes,
            ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
          })),
        },
        token,
      );
      const bySha = new Map(result.assets.map((asset) => [asset.sha256, asset]));
      for (const entry of pending) {
        const uploadedAsset = bySha.get(entry.record.sha256);
        if (uploadedAsset === undefined) {
          skipped.push(`${KIND_LABELS[entry.record.kind]}：host 未回传该资产`);
          continue;
        }
        uploaded.push(uploadedAsset);
        refs.push({
          kind: uploadedAsset.kind,
          ...(uploadedAsset.variant !== undefined ? { variant: uploadedAsset.variant } : {}),
          sha256: uploadedAsset.sha256,
          url: uploadedAsset.url,
          ...(entry.record.meta !== undefined ? { meta: entry.record.meta } : {}),
        });
        roomCache[uploadedAsset.sha256] = { url: uploadedAsset.url, at: Date.now() };
      }
    } finally {
      const entries = Object.entries(roomCache);
      if (entries.length > UPLOAD_CACHE_MAX_ROOM_ENTRIES) {
        for (const [sha] of entries.sort((left, right) => left[1].at - right[1].at).slice(0, entries.length - UPLOAD_CACHE_MAX_ROOM_ENTRIES)) {
          delete roomCache[sha];
        }
      }
      writeUploadCache(cache);
    }
  }

  return { refs, uploaded, skipped };
}

/** 落座用 `characterAssets` 引用（按 kind+variant 唯一；重复的取先出现的）。 */
export function canonicalRefs(refs: CharacterAssetRefInput[]): CharacterAssetRefInput[] {
  const seen = new Set<string>();
  const result: CharacterAssetRefInput[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}|${ref.variant ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 自备 OpenAI 兼容接口（浏览器直连；key 只存本机）
// ---------------------------------------------------------------------------

export function loadCustomEndpoint(storage?: Pick<Storage, 'getItem'> | null): CustomEndpointSettings {
  const target = storage ?? (globalThis as { localStorage?: Storage }).localStorage;
  try {
    const raw = target?.getItem(SETTINGS_KEY);
    if (!raw) return { baseUrl: '', apiKey: '', model: '' };
    const parsed = JSON.parse(raw) as Partial<CustomEndpointSettings>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
    };
  } catch {
    return { baseUrl: '', apiKey: '', model: '' };
  }
}

export function saveCustomEndpoint(settings: CustomEndpointSettings, storage?: Pick<Storage, 'setItem'> | null): void {
  const target = storage ?? (globalThis as { localStorage?: Storage }).localStorage;
  try {
    target?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式忽略 */
  }
}

function normalizeOpenAIBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) throw new Error('请填写接口地址（如 https://api.openai.com/v1）');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('接口地址必须以 http:// 或 https:// 开头');
  if (/\/images\/generations$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/images/generations`;
  return `${trimmed}/v1/images/generations`;
}

interface CompatImageResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
}

/** 从自备接口的一个返回项拿到 base64（`b64_json` 优先；只有 url 时再抓一次）。 */
async function candidateFromCompatItem(
  item: { b64_json?: string; url?: string; revised_prompt?: string },
  index: number,
  kind: PlayerGenKind,
  style: PlayerGenStyle,
  prompt: string,
): Promise<AssetsGenerateCandidate> {
  let b64 = typeof item.b64_json === 'string' && item.b64_json.length > 0 ? item.b64_json.replace(/^data:[^,]+,/, '') : '';
  if (b64.length === 0 && typeof item.url === 'string' && item.url.length > 0) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`接口返回了图片 URL，但抓取失败：HTTP ${response.status}（可能是 CORS 限制）`);
    b64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  }
  if (b64.length === 0) throw new Error('接口没有返回 b64_json 或 url（需要 response_format=b64_json）');
  const bytes = base64ToBytes(b64);
  const format = sniffImageFormat(bytes);
  if (format === null) throw new Error('接口返回的不是 PNG/SVG 图片');
  const size = format === 'png' ? pngSize(bytes) : svgSize(bytes);
  return {
    b64,
    format,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    sha256: await sha256Hex(bytes),
    prompt: typeof item.revised_prompt === 'string' && item.revised_prompt.length > 0 ? item.revised_prompt : prompt,
    seed: index,
    style,
  };
}

/**
 * 玩家自备接口直连生成（浏览器 → 玩家自己填的 OpenAI 兼容服务）。
 * CORS 不可用时给可读提示；不写 host、不进房间、不共享 key。
 */
export async function requestCustomGeneration(
  settings: CustomEndpointSettings,
  request: { kind: PlayerGenKind; style: PlayerGenStyle; prompt: string; subject?: string; seed?: number; count?: number },
): Promise<AssetsGenerateResult> {
  if (settings.baseUrl.trim().length === 0) throw new Error('还没填接口地址：请填写 OpenAI 兼容的 baseUrl（如 https://api.openai.com/v1）');
  if (settings.model.trim().length === 0) throw new Error('还没填模型名（如 dall-e-3 / gpt-image-1）');
  const endpoint = normalizeOpenAIBase(settings.baseUrl);
  const size = kindSizeForRequest(request.kind);
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    prompt: request.prompt,
    n: Math.max(1, Math.min(4, request.count ?? 1)),
    size,
    response_format: 'b64_json',
  };
  if (request.seed !== undefined) body.seed = request.seed;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey.trim().length > 0 ? { authorization: `Bearer ${settings.apiKey.trim()}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(
      `直连自备接口失败（浏览器跨域/CORS 或网络不可达）：${rpcErrorMessage(error)}。`
        + '可把接口地址换成允许浏览器直连的代理，或改用「AI 生成（host）」',
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const hint = text.length > 0 ? `：${text.slice(0, 200)}` : '';
    throw new Error(`自备接口返回 HTTP ${response.status}${hint}`);
  }
  const payload = (await response.json()) as CompatImageResponse;
  const items = Array.isArray(payload.data) ? payload.data : [];
  if (items.length === 0) throw new Error('自备接口没有返回图片候选（data 为空）');
  const candidates: AssetsGenerateCandidate[] = [];
  const errors: string[] = [];
  for (const [index, item] of items.entries()) {
    try {
      candidates.push(await candidateFromCompatItem(item, index, request.kind, request.style, request.prompt));
    } catch (error) {
      errors.push(rpcErrorMessage(error));
    }
  }
  if (candidates.length === 0) throw new Error(errors[0] ?? '自备接口返回的图片都不可用');
  return { candidates, provider: `self:${settings.model.trim()}` };
}

function kindSizeForRequest(kind: PlayerGenKind): string {
  if (kind === 'portrait') return '768x1024';
  if (kind === 'sprite') return '1024x1024';
  return '512x512';
}

// ---------------------------------------------------------------------------
// 帧表展示辅助
// ---------------------------------------------------------------------------

export interface SpriteSheetView {
  url: string;
  rows: number;
  cols: number;
  frameSize: number;
}

/**
 * 帧表缩略：v1 只显示第一帧（不做动画），用 CSS background-position 裁格，
 * 容器按 `frameSize` 等比缩放。图片缺失/元数据非法时返回 null（调用方回退徽记）。
 */
export function spriteFirstFrameStyle(sheet: SpriteSheetView, size: number, base?: string): Record<string, unknown> | null {
  const url = resolveAssetUrl(base, sheet.url);
  const rows = Math.floor(sheet.rows);
  const cols = Math.floor(sheet.cols);
  if (url === undefined || rows < 1 || cols < 1) return null;
  return {
    width: size,
    height: size,
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: '0 0',
    backgroundRepeat: 'no-repeat',
    borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2)',
    imageRendering: 'pixelated',
    flex: '0 0 auto',
  };
}
