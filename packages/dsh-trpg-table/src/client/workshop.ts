/**
 * M9.6a 内容工坊（客户端数据层）：工坊壳的 RPC 封装、内容包读取/写回、
 * 图标资产清单读取（pack.export → 浏览器内解 zip → assets/manifest.json）、
 * 战斗/世界地图结构落到 `rules.space` 的纯函数。
 *
 * 分工：
 * - 本文件**不渲染**任何东西（workshop-ui.ts 负责 UI）；
 * - 所有 host 调用走既有 `rpc.ts`（同一套中文错误口径）；工坊 RPC 需要
 *   loopback + host token，客户端只从当前房间会话取 hostToken，或本机自动发现
 *   （`room.list` → `host.session`，只读）；拿不到就给可读中文提示，不静默。
 * - 地图/世界结构 → pack JSON 的转换是纯函数（可单测/可预测），不改 host 数据模型。
 *
 * 与后端契约的已知偏差（工坊 RPC 目前没有「列资产清单」方法）：
 * `pack.detail` 只返回 pack.json；图标页因此用 `pack.export` 拿回 `.trpgpack`
 * 的 base64，在浏览器里读 zip 中央目录 + DecompressionStream('deflate-raw')
 * 解出 `assets/manifest.json`（只读、无需新依赖）。宿主不支持该 API 或包内没有
 * 清单时，降级为「按 pack.json 的 icon 引用推断 + 路径探测预览」并显式说明。
 */
import type {
  AssetsGenerateParams,
  AssetsGenerateResult,
  CatalogPack,
  ContentListResult,
  MapGenerateParams,
  MapGenerateResult,
  PackAssetDeleteResult,
  PackAssetKind,
  PackAssetPutMeta,
  PackAssetPutResult,
  PackDetailResult,
  PackExportResult,
  PackImportResult,
  PackImportStrategy,
  PackUpdateResult,
  RulesTestRequest,
  RulesTestResult,
  RulesValidateResult,
  WorldGenerateParams,
  WorldGenerateResult,
} from '@dsh-trpg/protocol';
import { BATTLE_TERRAIN_LEGEND } from '@dsh-trpg/protocol';
import {
  ACTION_KINDS,
  FIELD_KINDS,
  RANGE_BANDS,
  SPACE_MODELS,
  STACKING_MODES,
  TARGETING_SIDES,
  TARGETING_TYPES,
  TIME_MODELS,
} from '../../../rules/src/types.ts';
import type {
  CharacterCardDef,
  ContentPack,
  PackLorebookDef,
  PackModuleDef,
} from '@dsh-trpg/content';
import { base64ToBytes, bytesToBase64, formatBytes, sniffImageFormat } from './assets.ts';
import { callRpc, rpcErrorMessage } from './rpc.ts';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 主区域 keyed `main` 面板 id（`ctx.layout.selectPanel` 点名）。 */
export const WORKSHOP_PANEL_ID = 'trpg-workshop';

/** 与 index.ts 的 `DEFAULT_BASE` 保持同值（插件未连房间时回退本机 host）。 */
export const WORKSHOP_DEFAULT_BASE = 'http://127.0.0.1:45871';
/** 展示用提示（分享页脚注；与 `WORKSHOP_DEFAULT_BASE` 同值）。 */
export const WORKSHOP_DEFAULT_BASE_HINT = WORKSHOP_DEFAULT_BASE;

/** 工坊 tab（主区域工坊页 = 左侧包列表 + 右侧这些页签）。 */
export type WorkshopTab = 'overview' | 'cards' | 'lore' | 'modules' | 'rules' | 'icons' | 'maps' | 'share';

export const WORKSHOP_TABS: ReadonlyArray<{ id: WorkshopTab; label: string }> = [
  { id: 'overview', label: '概览' },
  { id: 'cards', label: '角色卡' },
  { id: 'lore', label: '世界书' },
  { id: 'modules', label: '模组' },
  { id: 'rules', label: '规则' },
  { id: 'icons', label: '图标' },
  { id: 'maps', label: '地图' },
  { id: 'share', label: '分享' },
];

/** 客户端会话的最小形状（与 index.ts 的 StoredSession 兼容）。 */
export interface WorkshopSessionLike {
  base?: string;
  hostToken?: string;
  roomId?: string;
}

export interface WorkshopConnection {
  base: string;
  token: string;
  /** 令牌来源（中文，直接展示）：会话房间 / 本机自动发现。 */
  source: string;
}

export interface WorkshopNotice {
  tone: 'ok' | 'bad' | 'info';
  text: string;
  lines: string[];
}

export interface WorkshopManifestEntry {
  assetId: string;
  file: string;
  format: 'png' | 'svg';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  kind: string;
  style?: string;
  seed?: number | null;
  prompt?: string | null;
}

export interface WorkshopManifest {
  packId: string;
  assets: WorkshopManifestEntry[];
}

export interface WorkshopSnapshot {
  phase: 'idle' | 'connecting' | 'ready' | 'error';
  base: string;
  /** 已解析的工坊连接（拿不到 host token 时为 null，但仍可读 content.list）。 */
  conn: WorkshopConnection | null;
  connectionError: string | null;
  packs: CatalogPack[];
  catalogBusy: boolean;
  catalogError: string | null;
  selectedPackId: string | null;
  detail: ContentPack | null;
  detailPackId: string | null;
  detailBusy: boolean;
  detailError: string | null;
  tab: WorkshopTab;
  notice: WorkshopNotice | null;
  manifest: WorkshopManifest | null;
  manifestPackId: string | null;
  manifestBusy: boolean;
  manifestError: string | null;
  manifestNote: string | null;
  /** 最近一次写回（update/import/assetPut）返回的 host warnings。 */
  lastWarnings: string[];
  /** 正在进行的写操作（中文标签；空 = 空闲）。 */
  writeBusy: string | null;
  exported: { fileName: string; bytes: number; packHash: string } | null;
  /** M9.6b 规则校验结果（rules.validate；草稿或已安装包）。 */
  validation: RulesValidateResult | null;
  validationBusy: boolean;
  /** M9.6b 规则测试台结果（rules.test）。 */
  testResult: RulesTestResult | null;
  testBusy: boolean;
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** 资产 kind 中文名（工坊图标页/资产列表共用）。 */
export const PACK_ASSET_KIND_LABELS: Record<PackAssetKind, string> = {
  item: '物品',
  action: '动作',
  status: '状态',
  resource: '资源',
  attribute: '属性',
  slot: '槽位',
  avatar: '头像',
  portrait: '立绘',
  variant: '变体',
  spritesheet: '帧表',
  npc: 'NPC',
  cover: '封面/底图',
};

/** 与 host `pack-workspace.ts` 的 KIND_FOLDER 同口径（预览路径探测用）。 */
const KIND_FOLDERS: Record<PackAssetKind, string> = {
  item: 'icons',
  action: 'icons',
  status: 'icons',
  resource: 'icons',
  attribute: 'icons',
  slot: 'icons',
  avatar: 'avatars',
  portrait: 'portraits',
  variant: 'portraits',
  spritesheet: 'sprites',
  npc: 'npcs',
  cover: 'covers',
};

/** slug 化：中文保留（assetId 允许中文？不允许，assetId 只允许 ASCII；中文按 id 兜底）。 */
export function slugifyId(value: string, fallback = 'icon'): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.length > 0) return ascii.slice(0, 48);
  // 全中文等无法 slug 化：用稳定哈希后缀，保证可复现且包内唯一。
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return `${fallback}-${hash.toString(36).slice(0, 8)}`;
}

/** 建议 assetId：`<kind>.<scope>.<slug>`（与 UI-CONTRACT §1.2 同口径，冲突由调用方加 `-2`）。 */
export function suggestAssetId(kind: PackAssetKind, scope: string, slug: string): string {
  const safeScope = slugifyId(scope, 'pack');
  const safeSlug = slugifyId(slug, 'asset');
  return `${kind}.${safeScope}.${safeSlug}`.slice(0, 120);
}

/** assetId 在已有集合里重名时追加 `-2`、`-3`… */
export function uniqueAssetId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 文件名→assetId 的 slug：去掉扩展名。 */
export function assetIdFromFileName(fileName: string): string {
  return slugifyId(fileName.replace(/\.[A-Za-z0-9]+$/, ''), 'icon');
}

/**
 * host 资产端点 URL：`GET /trpg/assets/<packId>/<assetPath>`（assetPath 是去掉
 * `assets/` 前缀的 zip 相对路径）。逐段编码，避免中文/空格出问题。
 */
export function packAssetUrl(base: string, packId: string, file: string): string {
  const relative = file.startsWith('assets/') ? file.slice('assets/'.length) : file;
  const encodedPath = relative
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${base.replace(/\/+$/, '')}/trpg/assets/${encodeURIComponent(packId)}/${encodedPath}`;
}

/** 资产文件路径（与 host 落盘规则同口径：`assets/<folder>/<assetId.-换成->.<ext>`）。 */
export function assetFilePathFor(kind: PackAssetKind, assetId: string, format: 'png' | 'svg', suffix = ''): string {
  const folder = KIND_FOLDERS[kind] ?? 'icons';
  const base = assetId.replaceAll('.', '-').replace(/[^A-Za-z0-9_-]/g, '-');
  return `assets/${folder}/${base}${suffix}.${format}`;
}

/** 猜测某 assetId 的预览 URL（png / svg 各试一次；清单不可用时兜底用）。 */
export function guessAssetUrls(base: string, packId: string, kind: PackAssetKind, assetId: string): string[] {
  return [
    packAssetUrl(base, packId, assetFilePathFor(kind, assetId, 'png')),
    packAssetUrl(base, packId, assetFilePathFor(kind, assetId, 'svg')),
  ];
}

/** base64 字节量（近似即可，UI 展示用；精确值以 host 返回为准）。 */
export function base64ByteSize(b64: string): number {
  try {
    return base64ToBytes(b64).length;
  } catch {
    return 0;
  }
}

export { formatBytes };

/** 浏览器下载（`<a download>`）；不弹新窗口。 */
export function downloadBase64File(fileName: string, b64: string, mediaType = 'application/zip'): void {
  try {
    const bytes = base64ToBytes(b64);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: mediaType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (error) {
    throw new Error(`浏览器下载失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 文件 → base64（去掉 data URL 前缀；不接受空文件）。 */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) throw new Error('选择的文件是空的');
  return bytesToBase64(bytes);
}

/**
 * 把 host 的 RPC 错误翻成可操作的中文：
 * - 老 host 没有这些方法（未重启/旧插件）→「工坊后端未就绪：…」；
 * - 网络不通 → 连接提示；
 * - 其余原样透出 host 的中文 message（不二次改写）。
 */
export function workshopErrorMessage(method: string, error: unknown): string {
  const text = rpcErrorMessage(error);
  if (/未知 ?RPC ?方法|未知方法/.test(text)) {
    return `工坊后端未就绪：host 尚未提供「${method}」（${text}）。请重启 DSH 让新插件 host 生效后再试。`;
  }
  if (/failed to fetch|networkerror|fetch failed|load failed|network request failed/i.test(text)) {
    return `工坊后端未就绪：无法连接 host（${method}）：${text}。请确认跑团桌 host 服务在运行。`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// `.trpgpack`（zip）内资产清单读取（无新依赖：中央目录 + DecompressionStream）
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function inflateRawBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { DecompressionStream?: new (format: string) => unknown }).DecompressionStream;
  if (typeof Ctor !== 'function') {
    return Promise.reject(new Error('当前宿主不支持 DecompressionStream，无法在浏览器内读取 .trpgpack 的资产清单'));
  }
  const stream = new Ctor('deflate-raw');
  const source = new Blob([bytes as unknown as BlobPart]).stream();
  const piped = (source as unknown as { pipeThrough: (transform: unknown) => ReadableStream }).pipeThrough(stream);
  return new Response(piped).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** 从 zip 字节里取一个条目（只支持 stored/deflate；本插件的 zip 编码器只产这两种）。 */
async function readZipEntry(bytes: Uint8Array, entryName: string): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minOffset = Math.max(0, bytes.length - 0xffff - 22);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (readU32(view, offset) === SIG_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP（找不到中央目录结尾）：无法读取资产清单');
  const entryCount = readU16(view, eocd + 10);
  const centralSize = readU32(view, eocd + 12);
  const centralOffset = readU32(view, eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 内容包：无法读取资产清单');
  }
  if (centralOffset + centralSize > eocd) throw new Error('ZIP 中央目录越界：无法读取资产清单');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pointer = centralOffset;
  for (let index = 0; index < entryCount && pointer + 46 <= eocd; index += 1) {
    if (readU32(view, pointer) !== SIG_CENTRAL) throw new Error('ZIP 中央目录条目损坏：无法读取资产清单');
    const flags = readU16(view, pointer + 8);
    const method = readU16(view, pointer + 10);
    const compressedSize = readU32(view, pointer + 20);
    const nameLength = readU16(view, pointer + 28);
    const extraLength = readU16(view, pointer + 30);
    const commentLength = readU16(view, pointer + 32);
    const localOffset = readU32(view, pointer + 42);
    if ((flags & 0x0001) !== 0) throw new Error('内容包条目被加密（不支持）：无法读取资产清单');
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 内容包：无法读取资产清单');
    const nameBytes = bytes.subarray(pointer + 46, pointer + 46 + nameLength);
    const name = decoder.decode(nameBytes);
    const next = pointer + 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) {
      pointer = next;
      continue;
    }
    if (readU32(view, localOffset) !== SIG_LOCAL) throw new Error('ZIP 本地文件头损坏：无法读取资产清单');
    const localNameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === METHOD_STORED) return data;
    if (method === METHOD_DEFLATE) return inflateRawBytes(data);
    throw new Error(`ZIP 条目压缩方式不支持（${method}）：无法读取资产清单`);
  }
  return null;
}

/** `assets/manifest.json` 文本 → 宽松解析成工坊清单（坏条目跳过，不炸 UI）。 */
export function parseWorkshopManifest(text: string, packIdFallback: string): WorkshopManifest {
  const raw = JSON.parse(text) as { packId?: unknown; assets?: unknown };
  const assetsRaw = Array.isArray(raw.assets) ? raw.assets : [];
  const assets: WorkshopManifestEntry[] = [];
  for (const item of assetsRaw) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const assetId = typeof entry.assetId === 'string' ? entry.assetId : '';
    const file = typeof entry.file === 'string' ? entry.file : '';
    if (assetId.length === 0 || file.length === 0) continue;
    const format = entry.format === 'svg' ? 'svg' : 'png';
    const size = (entry.size ?? {}) as Record<string, unknown>;
    assets.push({
      assetId,
      file,
      format,
      width: typeof size.w === 'number' ? size.w : 0,
      height: typeof size.h === 'number' ? size.h : 0,
      bytes: typeof entry.bytes === 'number' ? entry.bytes : 0,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '',
      kind: typeof entry.kind === 'string' ? entry.kind : 'item',
      ...(typeof entry.style === 'string' ? { style: entry.style } : {}),
      ...(typeof entry.seed === 'number' ? { seed: entry.seed } : {}),
      ...(typeof entry.prompt === 'string' ? { prompt: entry.prompt } : {}),
    });
  }
  return {
    packId: typeof raw.packId === 'string' && raw.packId.length > 0 ? raw.packId : packIdFallback,
    assets,
  };
}

// ---------------------------------------------------------------------------
// pack.json 引用推断（清单不可用时的降级：还有哪些图标位置/缺图目标）
// ---------------------------------------------------------------------------

export interface IconReferenceInfo {
  /** pack.json 里的原始引用值（短 id / `@pack:` / `assets/`）。 */
  ref: string;
  /** 引用所在的字段路径（错误定位/排查用）。 */
  source: string;
  kind: PackAssetKind;
  /** 能直接推出包内文件时给出（`assets/...`）。 */
  file?: string;
  /** 看起来是正规 assetId 时给出。 */
  assetId?: string;
}

export interface MissingIconTarget {
  id: string;
  name: string;
  kind: PackAssetKind;
  description: string;
  source: string;
}

interface IconSlot {
  ref: string | undefined;
  source: string;
  kind: PackAssetKind;
  id: string;
  name: string;
  description: string;
}

function collectIconSlots(pack: ContentPack): IconSlot[] {
  const slots: IconSlot[] = [];
  const rules = pack.rules;
  const push = (slot: IconSlot): void => {
    slots.push(slot);
  };
  for (const item of rules?.items ?? []) {
    push({ ref: item.icon, source: `rules.items[${item.itemId}].icon`, kind: 'item', id: item.itemId, name: item.name, description: item.description ?? '' });
  }
  for (const action of rules?.actions ?? []) {
    push({ ref: action.icon, source: `rules.actions[${action.actionId}].icon`, kind: 'action', id: action.actionId, name: action.name, description: action.description ?? '' });
  }
  for (const status of rules?.sheet?.statuses ?? []) {
    push({ ref: status.icon, source: `rules.sheet.statuses[${status.id}].icon`, kind: 'status', id: status.id, name: status.name, description: '' });
  }
  for (const attribute of rules?.sheet?.attributes ?? []) {
    push({ ref: attribute.icon, source: `rules.sheet.attributes[${attribute.id}].icon`, kind: 'attribute', id: attribute.id, name: attribute.name, description: '' });
  }
  for (const resource of rules?.sheet?.resources ?? []) {
    push({ ref: resource.icon, source: `rules.sheet.resources[${resource.id}].icon`, kind: 'resource', id: resource.id, name: resource.name, description: resource.formula ?? '' });
  }
  for (const slot of rules?.sheet?.equipment?.slots ?? []) {
    push({ ref: slot.icon, source: `rules.sheet.equipment.slots[${slot.id}].icon`, kind: 'slot', id: slot.id, name: slot.name, description: (slot.accepts ?? []).join('/') });
  }
  for (const category of rules?.ui?.itemCategories ?? []) {
    push({ ref: category.icon, source: `rules.ui.itemCategories[${category.id}].icon`, kind: 'item', id: category.id, name: category.name, description: '' });
  }
  if (typeof pack.icon === 'string' && pack.icon.trim().length > 0) {
    push({ ref: pack.icon, source: 'pack.icon', kind: 'cover', id: pack.packId, name: `${pack.name} 封面`, description: '' });
  }
  return slots;
}

/** 把短 id / iconRef 归一化成 `{assetId}` 或 `{file}`（都推不出时只保留 ref）。 */
function normalizeIconRef(ref: string, kind: PackAssetKind): { assetId?: string; file?: string } {
  const value = ref.trim();
  if (value.startsWith('@pack:')) {
    const file = value.slice('@pack:'.length);
    return file.startsWith('assets/') ? { file } : { file: `assets/${file}` };
  }
  if (value.startsWith('assets/')) return { file: value };
  if (value.startsWith('@room:') || value.startsWith('@local:') || value.startsWith('<svg')) return {};
  if (value.includes('/')) {
    // 短 id：`status/poison` / `item/hengdao` → 约定路径 assets/icons/<...>.<svg|png>
    return { file: `assets/icons/${value}.svg` };
  }
  if (value.includes('.')) return { assetId: value };
  return { file: `assets/icons/${value}.svg` };
}

/** pack.json 里出现的图标引用（含推断的包内路径/assetId）。 */
export function collectIconReferences(pack: ContentPack): IconReferenceInfo[] {
  const output: IconReferenceInfo[] = [];
  for (const slot of collectIconSlots(pack)) {
    if (typeof slot.ref !== 'string' || slot.ref.trim().length === 0) continue;
    const normalized = normalizeIconRef(slot.ref, slot.kind);
    output.push({
      ref: slot.ref,
      source: slot.source,
      kind: slot.kind,
      ...(normalized.file !== undefined ? { file: normalized.file } : {}),
      ...(normalized.assetId !== undefined ? { assetId: normalized.assetId } : {}),
    });
  }
  return output;
}

/** 还没有图标的可挂载目标（物品/动作/状态/属性/资源/槽位；图标工作台的批量对象）。 */
export function collectMissingIconTargets(pack: ContentPack): MissingIconTarget[] {
  const output: MissingIconTarget[] = [];
  for (const slot of collectIconSlots(pack)) {
    if (typeof slot.ref === 'string' && slot.ref.trim().length > 0) continue;
    output.push({ id: slot.id, name: slot.name, kind: slot.kind, description: slot.description, source: slot.source });
  }
  return output;
}

/** 图标生成提示词模板（中文，物品描述会拼进去；作者可改）。 */
export function iconPromptFor(target: MissingIconTarget, style: 'svg' | 'pixel-32' | 'game-2d'): string {
  const detail = target.description.length > 0 ? target.description.slice(0, 60) : '';
  const kindLabel = PACK_ASSET_KIND_LABELS[target.kind] ?? target.kind;
  if (style === 'svg') {
    return `为「${target.name}」画一个扁平矢量图标（${kindLabel}${detail.length > 0 ? `，${detail}` : ''}），纯色平涂、几何轮廓、2–3 主色、无文字、透明背景、128×128。`;
  }
  return `为「${target.name}」画一个${style === 'pixel-32' ? '像素风 32×32' : '2D 游戏'}图标（${kindLabel}${detail.length > 0 ? `，${detail}` : ''}），中心构图、轮廓清晰、透明背景。`;
}

// ---------------------------------------------------------------------------
// 地图结构 → pack.rules.space（纯函数，可预测）
// ---------------------------------------------------------------------------

/** 战斗地图生成结果（与协议 MapGenerateResult 同形；本地窄化避免与 UI 耦合）。 */
export type GeneratedBattleMap = Pick<MapGenerateResult, 'structure' | 'warnings' | 'method' | 'background'>;
export type GeneratedWorldMap = Pick<WorldGenerateResult, 'world' | 'warnings' | 'method' | 'background'>;

/** 地形 id → 中文名/颜色（预览渲染用；与 BATTLE_TERRAIN_LEGEND 的 id 对齐）。 */
export const TERRAIN_COLORS: Readonly<Record<string, { label: string; color: string }>> = {
  floor: { label: '地面', color: 'rgba(118,132,118,.42)' },
  rubble: { label: '碎石', color: 'rgba(164,148,112,.55)' },
  door: { label: '门', color: 'rgba(206,172,74,.62)' },
  tree: { label: '树木', color: 'rgba(48,120,68,.78)' },
  water: { label: '水域', color: 'rgba(54,104,206,.72)' },
  wall: { label: '岩壁/墙', color: 'rgba(32,34,40,.90)' },
};

/** 生成结构里的图例字符 → 地形 id（BATTLE_TERRAIN_LEGEND 是 host/校验器共用定义）。 */
export function battleCharToTerrainId(char: string): string {
  const spec = BATTLE_TERRAIN_LEGEND[char];
  return spec !== undefined ? spec.id : char;
}

function terrainNameOf(id: string): string {
  if (TERRAIN_COLORS[id]?.label !== undefined) return TERRAIN_COLORS[id].label;
  for (const spec of Object.values(BATTLE_TERRAIN_LEGEND)) if (spec.id === id) return spec.name;
  return id;
}

function terrainSpecOf(id: string): { walkable: boolean; moveCost: number } {
  for (const spec of Object.values(BATTLE_TERRAIN_LEGEND)) if (spec.id === id) return { walkable: spec.walkable, moveCost: spec.moveCost };
  return { walkable: true, moveCost: 1 };
}

/** 建议 mapId（包内唯一；同前缀自动加序号）。 */
export function suggestMapId(pack: ContentPack, prefix: 'battle' | 'world'): string {
  const taken = new Set<string>((pack.rules?.space?.battleMaps ?? []).map((map) => map.mapId));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

/** 保存战斗地图的附加参数。 */
export interface SaveBattleMapOptions {
  mapId: string;
  name?: string;
  /** 可选：绑定到某个区域（rules.space.zones[].zoneId；不存在会写坏引用，调用方先过滤）。 */
  zoneId?: string;
  /** 底图资产（已 pack.assetPut 落盘后的 assetId）。 */
  backgroundAssetId?: string;
}

/**
 * 生成结构 → pack JSON：写入 `rules.space.battleMaps`（新 mapId；同 id 替换）。
 * - 地形字符按 `BATTLE_TERRAIN_LEGEND` 映射到地形 id；包内 `space.terrains` 缺少的
 *   地形定义补上（保证 `validatePack()` 的「引用已声明地形」通过）；
 * - `space.model` 从 none 升到 grid（已有 zone 则 zone-grid），不降级；
 * - 纯函数：返回新 pack，不修改入参。
 */
export function applyBattleMap(
  pack: ContentPack,
  generated: GeneratedBattleMap,
  options: SaveBattleMapOptions,
): { pack: ContentPack; warnings: string[] } {
  if (pack.rules === undefined) throw new Error('该内容包没有 rules 段（纯叙事包），无法写入战斗地图');
  const warnings: string[] = [];
  const next = structuredClone(pack);
  const rules = next.rules;
  if (rules === undefined) throw new Error('该内容包没有 rules 段');
  const structure = generated.structure;
  const space = (rules.space ??= { model: 'grid' });
  const existingModel = space.model ?? 'none';
  const zones = space.zones ?? [];
  const hasZones = zones.length > 0;
  if (existingModel === 'none') space.model = hasZones ? 'zone-grid' : 'grid';
  else if (existingModel === 'zone' && hasZones) space.model = 'zone-grid';

  // 地形：字符 → 地形 id；补齐 terrains 声明。
  const terrain = structure.terrain.map((row) => row.map((cell) => battleCharToTerrainId(cell)));
  const usedIds = new Set<string>();
  for (const row of terrain) for (const id of row) usedIds.add(id);
  space.terrains = space.terrains ?? [];
  const declared = new Set(space.terrains.map((entry) => entry.id));
  let addedTerrain = false;
  for (const id of usedIds) {
    if (declared.has(id)) continue;
    const spec = terrainSpecOf(id);
    space.terrains.push({ id, name: terrainNameOf(id), blocksMove: !spec.walkable, moveCost: spec.moveCost });
    declared.add(id);
    addedTerrain = true;
  }
  if (addedTerrain) warnings.push('已把生成结构用到、但规则包未声明的地形补进 rules.space.terrains（name/moveCost 取内置图例）');

  const coverIds = new Set((space.covers ?? []).map((cover) => cover.id));
  const obstacles = structure.obstacles.map((obstacle) => ({
    x: obstacle.x,
    y: obstacle.y,
    w: obstacle.w,
    h: obstacle.h,
    ...(obstacle.terrain !== undefined ? { terrain: battleCharToTerrainId(obstacle.terrain) } : {}),
    ...(obstacle.coverId !== undefined && coverIds.has(obstacle.coverId) ? { coverId: obstacle.coverId } : {}),
  }));
  const zoneIds = new Set(zones.map((zone) => zone.zoneId));
  const zoneId = options.zoneId !== undefined && zoneIds.has(options.zoneId) ? options.zoneId : undefined;
  if (options.zoneId !== undefined && zoneId === undefined) warnings.push(`区域「${options.zoneId}」不存在，战斗地图未绑定区域`);
  const map = {
    mapId: options.mapId,
    ...(options.name !== undefined && options.name.trim().length > 0 ? { name: options.name.trim() } : {}),
    cols: structure.cols,
    rows: structure.rows,
    terrain,
    obstacles,
    spawns: structure.spawns.map((spawn) => ({
      side: spawn.side,
      x: spawn.x,
      y: spawn.y,
      ...(spawn.label !== undefined ? { label: spawn.label } : {}),
      ...(spawn.monsterId !== undefined ? { monsterId: spawn.monsterId } : {}),
    })),
    ...(zoneId !== undefined ? { zoneId } : {}),
    ...(options.backgroundAssetId !== undefined ? { backgroundAssetId: options.backgroundAssetId } : {}),
  };
  const maps = (space.battleMaps ?? []).filter((entry) => entry.mapId !== options.mapId);
  maps.push(map);
  space.battleMaps = maps;
  return { pack: next, warnings };
}

/** 保存世界地图的附加参数（底图 assetId 可选）。 */
export interface SaveWorldMapOptions {
  backgroundAssetId?: string;
  /** true = 只保留生成区域（默认追加/同 id 替换，保留作者已有区域）。 */
  replaceZones?: boolean;
}

/**
 * 生成世界结构 → pack JSON：写入 `rules.space.world`（底图/尺寸）与 `rules.space.zones`。
 * 生成区域按 zoneId 追加/替换（默认保留作者已有区域与它们的连线）。
 */
export function applyWorldMap(
  pack: ContentPack,
  generated: GeneratedWorldMap,
  options: SaveWorldMapOptions = {},
): { pack: ContentPack; warnings: string[] } {
  if (pack.rules === undefined) throw new Error('该内容包没有 rules 段（纯叙事包），无法写入世界地图');
  const warnings: string[] = [];
  const next = structuredClone(pack);
  const rules = next.rules;
  if (rules === undefined) throw new Error('该内容包没有 rules 段');
  const space = (rules.space ??= { model: 'zone' });
  const existingModel = space.model ?? 'none';
  const battleCount = (space.battleMaps ?? []).length;
  if (existingModel === 'none') space.model = battleCount > 0 ? 'zone-grid' : 'zone';
  else if (existingModel === 'grid' && battleCount > 0) space.model = 'zone-grid';
  else if (existingModel === 'grid' && battleCount === 0) space.model = 'zone-grid';
  space.world = {
    ...(space.world ?? {}),
    width: space.world?.width ?? 2048,
    height: space.world?.height ?? 1536,
    ...(options.backgroundAssetId !== undefined ? { backgroundAssetId: options.backgroundAssetId } : {}),
  };
  const zones = options.replaceZones === true ? [] : [...(space.zones ?? [])];
  const byId = new Map(zones.map((zone, index) => [zone.zoneId, index]));
  let added = 0;
  for (const generatedZone of generated.world.zones) {
    const zone = {
      zoneId: generatedZone.zoneId,
      name: generatedZone.name,
      ...(generatedZone.description !== undefined ? { description: generatedZone.description } : {}),
      hotspot: {
        x: generatedZone.hotspot.x,
        y: generatedZone.hotspot.y,
        w: generatedZone.hotspot.w,
        h: generatedZone.hotspot.h,
      },
      connections: generatedZone.connections.map((connection) => ({
        to: connection.to,
        ...(connection.kind !== undefined ? { kind: connection.kind } : {}),
      })),
    } as NonNullable<typeof space.zones>[number];
    const index = byId.get(zone.zoneId);
    if (index === undefined) {
      byId.set(zone.zoneId, zones.length);
      zones.push(zone);
      added += 1;
    } else {
      zones[index] = zone;
    }
  }
  space.zones = zones;
  if (options.replaceZones !== true && added < generated.world.zones.length) {
    warnings.push(`有 ${generated.world.zones.length - added} 个区域与已有区域同 id，已替换（其余区域保留）`);
  }
  const generatedIds = new Set(generated.world.zones.map((zone) => zone.zoneId));
  for (const zone of zones) {
    for (const connection of zone.connections ?? []) {
      if (!zones.some((candidate) => candidate.zoneId === connection.to)) {
        warnings.push(`区域「${zone.zoneId}」的连线指向不存在的区域「${connection.to}」（host 校验会拒绝）`);
      }
    }
  }
  void generatedIds;
  return { pack: next, warnings };
}

// ---------------------------------------------------------------------------
// 工坊 store（头部/左栏/页签共享状态；UI 用 useSnapshot 订阅）
// ---------------------------------------------------------------------------

function emptySnapshot(): WorkshopSnapshot {
  return {
    phase: 'idle',
    base: WORKSHOP_DEFAULT_BASE,
    conn: null,
    connectionError: null,
    packs: [],
    catalogBusy: false,
    catalogError: null,
    selectedPackId: null,
    detail: null,
    detailPackId: null,
    detailBusy: false,
    detailError: null,
    tab: 'overview',
    notice: null,
    manifest: null,
    manifestPackId: null,
    manifestBusy: false,
    manifestError: null,
    manifestNote: null,
    lastWarnings: [],
    writeBusy: null,
    exported: null,
    validation: null,
    validationBusy: false,
    testResult: null,
    testBusy: false,
  };
}

export interface WorkshopStore {
  getSnapshot(): WorkshopSnapshot;
  subscribe(listener: () => void): () => void;
  init(readSession: () => WorkshopSessionLike | null): void;
  setTab(tab: WorkshopTab): void;
  setNotice(notice: WorkshopNotice | null): void;
  dismissNotice(): void;
  connect(): Promise<void>;
  refreshCatalog(): Promise<void>;
  selectPack(packId: string): Promise<void>;
  refreshDetail(): Promise<void>;
  loadManifest(force?: boolean): Promise<void>;
  exportCurrent(): Promise<void>;
  duplicateCurrent(): Promise<void>;
  importPack(b64: string, fileName: string, strategy: PackImportStrategy): Promise<PackImportResult | null>;
  putAsset(input: { assetId: string; kind: PackAssetKind; b64: string; meta?: PackAssetPutMeta }): Promise<PackAssetPutResult | null>;
  deleteAsset(assetId: string): Promise<PackAssetDeleteResult | null>;
  generate(params: AssetsGenerateParams): Promise<AssetsGenerateResult | null>;
  generateMap(params: MapGenerateParams): Promise<MapGenerateResult | null>;
  generateWorld(params: WorldGenerateParams): Promise<WorldGenerateResult | null>;
  savePack(nextPack: ContentPack, label: string): Promise<PackUpdateResult | null>;
  /** M9.6b `rules.validate`：校验已安装包或草稿（不落盘）。 */
  validateRules(draft?: ContentPack | null): Promise<RulesValidateResult | null>;
  /** M9.6b `rules.test`：规则测试台（临时运行时 + 样本卡；可传草稿）。 */
  runRulesTest(input: { requests: RulesTestRequest[]; seed?: number; pack?: ContentPack | null }): Promise<RulesTestResult | null>;
  /** 当前包是否内置（只读；写操作前给可读提示）。 */
  isBuiltinPack(packId?: string): boolean;
}

export function createWorkshopStore(): WorkshopStore {
  let snapshot = emptySnapshot();
  const listeners = new Set<() => void>();
  let readSession: () => WorkshopSessionLike | null = () => null;
  let initialized = false;

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* 单个订阅者出错不影响其他 */
      }
    }
  };
  const patch = (partial: Partial<WorkshopSnapshot>): void => {
    snapshot = { ...snapshot, ...partial };
    notify();
  };
  const setNotice = (notice: WorkshopNotice | null): void => {
    patch({ notice });
  };
  const warnLines = (warnings: readonly string[]): string[] => warnings.filter((warning) => warning.length > 0);

  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const conn = snapshot.conn;
    if (conn === null) {
      throw new Error(
        snapshot.connectionError !== null
          ? `工坊后端未就绪：${snapshot.connectionError}`
          : '工坊尚未连接 host：请先在右栏跑团桌打开会话，或让宿主提供房主令牌',
      );
    }
    try {
      return await callRpc<T>(conn.base, method, params, conn.token);
    } catch (error) {
      throw new Error(workshopErrorMessage(method, error));
    }
  };

  /** 解析 host 令牌：优先当前房间会话的 hostToken；没有再本机自动发现（只读 RPC）。 */
  const resolveConnection = async (base: string): Promise<{ conn: WorkshopConnection | null; error: string | null }> => {
    const session = readSession() ?? null;
    const hostToken = typeof session?.hostToken === 'string' && session.hostToken.length > 0 ? session.hostToken : undefined;
    if (hostToken !== undefined) {
      return { conn: { base, token: hostToken, source: session?.roomId !== undefined ? '当前房间（房主）' : '本地会话（房主）' }, error: null };
    }
    // 没有本地 host 令牌：尝试本机自动发现（loopback + host.session；不创建/修改任何房间）。
    try {
      const list = await callRpc<{ rooms: Array<{ roomId: string }> }>(base, 'room.list', {});
      for (const room of list.rooms.slice(0, 5)) {
        try {
          const host = await callRpc<{ hostToken?: string }>(base, 'host.session', { roomId: room.roomId });
          if (typeof host.hostToken === 'string' && host.hostToken.length > 0) {
            return { conn: { base, token: host.hostToken, source: '本机自动发现（房主）' }, error: null };
          }
        } catch {
          /* 该房间不是本机房主会话：继续试下一个 */
        }
      }
    } catch (error) {
      return { conn: null, error: `无法连接 host（${base}）：${rpcErrorMessage(error)}` };
    }
    return {
      conn: null,
      error: `工坊需要房主令牌：本机没有可用的房主会话（host 上也没有房间）。请先建房或直接在本机 host 环境中打开工坊（${base}）`,
    };
  };

  const loadDetail = async (packId: string): Promise<void> => {
    patch({ detailBusy: true, detailError: null, detailPackId: packId });
    try {
      const result = await call<PackDetailResult>('pack.detail', { packId });
      patch({
        detail: (result.pack ?? null) as ContentPack | null,
        detailBusy: false,
        detailPackId: packId,
        detailError: null,
        manifest: null,
        manifestPackId: null,
        manifestNote: null,
        manifestError: null,
        validation: null,
        testResult: null,
      });
    } catch (error) {
      patch({ detail: null, detailBusy: false, detailError: error instanceof Error ? error.message : String(error) });
    }
  };

  const refreshCatalog = async (): Promise<void> => {
    patch({ catalogBusy: true, catalogError: null });
    const base = snapshot.base;
    try {
      const result = await callRpc<ContentListResult>(base, 'content.list', {});
      patch({ packs: Array.isArray(result.packs) ? result.packs : [], catalogBusy: false, catalogError: null });
    } catch (error) {
      patch({
        catalogBusy: false,
        catalogError: `读取内容包目录失败：${rpcErrorMessage(error)}`,
      });
    }
  };

  const ensureReady = async (): Promise<void> => {
    if (initialized) return;
    initialized = true;
    await connect();
  };

  const connect = async (): Promise<void> => {
    const session = readSession() ?? null;
    const base = typeof session?.base === 'string' && session.base.trim().length > 0 ? session.base.trim().replace(/\/+$/, '') : WORKSHOP_DEFAULT_BASE;
    patch({ phase: 'connecting', base, conn: null, connectionError: null, catalogError: null });
    // 1) 内容包目录（content.list 无需 token；先渲染左侧列表，再解析工坊令牌）。
    await refreshCatalog();
    // 2) 工坊令牌（pack.detail/update/… 需要 loopback + host token）。
    const resolved = await resolveConnection(base);
    patch({ conn: resolved.conn, connectionError: resolved.error });
    const packs = snapshot.packs;
    // 3) 默认选中：优先内置缺省包（core-guimuya），否则第一个。
    const preferred = packs.find((pack) => pack.source === 'builtin') ?? packs[0];
    if (preferred !== undefined && snapshot.selectedPackId === null) {
      patch({ selectedPackId: preferred.packId });
      if (resolved.conn !== null) await loadDetail(preferred.packId);
    }
    patch({ phase: resolved.conn !== null ? 'ready' : snapshot.packs.length > 0 ? 'ready' : 'error' });
  };

  const selectPack = async (packId: string): Promise<void> => {
    if (snapshot.selectedPackId === packId && snapshot.detailPackId === packId && snapshot.detailError === null) return;
    patch({ selectedPackId: packId, notice: null });
    await loadDetail(packId);
  };

  const refreshDetail = async (): Promise<void> => {
    if (snapshot.selectedPackId === null) return;
    await loadDetail(snapshot.selectedPackId);
  };

  const loadManifest = async (force = false): Promise<void> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return;
    if (!force && snapshot.manifestPackId === packId) return;
    const detail = snapshot.detail;
    if (detail === null) return;
    patch({ manifestBusy: true, manifestError: null, manifestPackId: packId });
    try {
      // 契约没有「列资产清单」方法：用 pack.export 取回 zip，在浏览器内读 assets/manifest.json。
      const exported = await call<PackExportResult>('pack.export', { packId });
      const zipBytes = base64ToBytes(exported.b64);
      const manifestBytes = await readZipEntry(zipBytes, 'assets/manifest.json');
      if (manifestBytes === null) {
        patch({
          manifest: null,
          manifestBusy: false,
          manifestNote: '该内容包没有 assets/manifest.json（还没落过资产）：下面按 pack.json 的 icon 引用推断可挂图标的位置。',
          manifestError: null,
        });
        return;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
      const manifest = parseWorkshopManifest(text, packId);
      patch({
        manifest,
        manifestBusy: false,
        manifestNote:
          manifest.assets.length === 0
            ? '清单里还没有资产条目：可以从「本地导入 / AI 生成 SVG / AI 生图」三条路径落盘第一张图标。'
            : `清单共 ${manifest.assets.length} 条资产（读自 pack.export 的 assets/manifest.json；后端暂无列清单 RPC，见已知偏差）。`,
        manifestError: null,
      });
    } catch (error) {
      patch({
        manifest: null,
        manifestBusy: false,
        manifestError: workshopErrorMessage('pack.export', error),
        manifestNote: '读资产清单失败：仍可按 pack.json 的引用探测预览。',
      });
    }
  };

  const exportCurrent = async (): Promise<void> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return;
    patch({ writeBusy: '正在导出内容包…' });
    try {
      const result = await call<PackExportResult>('pack.export', { packId });
      downloadBase64File(result.fileName, result.b64);
      patch({ writeBusy: null, exported: { fileName: result.fileName, bytes: result.bytes, packHash: result.packHash } });
      setNotice({
        tone: 'ok',
        text: `已导出并下载：${result.fileName}（${formatBytes(result.bytes)}；packHash ${result.packHash.slice(0, 12)}…）`,
        lines: ['浏览器下载已开始；文件名包含 packId 与版本，可直接分发给其他桌。'],
      });
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
    }
  };

  const importPack = async (b64: string, fileName: string, strategy: PackImportStrategy): Promise<PackImportResult | null> => {
    patch({ writeBusy: '正在导入内容包…' });
    try {
      const result = await call<PackImportResult>('pack.import', { b64, fileName, strategy });
      const warnings = warnLines(result.warnings ?? []);
      patch({ writeBusy: null, lastWarnings: warnings, exported: null });
      setNotice({
        tone: 'ok',
        text:
          result.action === 'created'
            ? `导入成功：新内容包「${result.packId}」v${result.version}`
            : result.action === 'overwritten'
              ? `导入成功：已覆盖数据目录包「${result.packId}」v${result.version}`
              : `导入成功：同 id 冲突，已另存为「${result.packId}」v${result.version}`,
        lines: warnings,
      });
      await refreshCatalog();
      patch({ selectedPackId: result.packId });
      await loadDetail(result.packId);
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
      return null;
    }
  };

  const duplicateCurrent = async (): Promise<void> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return;
    patch({ writeBusy: '正在复制为可编辑数据包…' });
    try {
      const exported = await call<PackExportResult>('pack.export', { packId });
      const imported = await call<PackImportResult>('pack.import', {
        b64: exported.b64,
        fileName: exported.fileName,
        strategy: 'rename',
      });
      const warnings = warnLines(imported.warnings ?? []);
      patch({ writeBusy: null, lastWarnings: warnings });
      setNotice({
        tone: 'ok',
        text: `已复制为可编辑数据目录包「${imported.packId}」（原包不受影响；内置包只读，编辑请用副本）`,
        lines: warnings,
      });
      await refreshCatalog();
      patch({ selectedPackId: imported.packId });
      await loadDetail(imported.packId);
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
    }
  };

  const putAsset = async (input: {
    assetId: string;
    kind: PackAssetKind;
    b64: string;
    meta?: PackAssetPutMeta;
  }): Promise<PackAssetPutResult | null> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return null;
    patch({ writeBusy: `正在落盘资产 ${input.assetId}…` });
    try {
      const result = await call<PackAssetPutResult>('pack.assetPut', {
        packId,
        assetId: input.assetId,
        kind: input.kind,
        b64: input.b64,
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      });
      patch({ writeBusy: null });
      setNotice({
        tone: 'ok',
        text: `资产已落盘：${result.assetId}（${formatBytes(result.bytes)}；sha256 ${result.sha256.slice(0, 8)}…；已更新 assets/manifest.json）`,
        lines: [],
      });
      await loadManifest(true);
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
      return null;
    }
  };

  const deleteAsset = async (assetId: string): Promise<PackAssetDeleteResult | null> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return null;
    patch({ writeBusy: `正在删除资产 ${assetId}…` });
    try {
      const result = await call<PackAssetDeleteResult>('pack.assetDelete', { packId, assetId });
      patch({ writeBusy: null });
      setNotice({
        tone: result.removed ? 'ok' : 'info',
        text: result.removed ? `已删除资产 ${assetId}` : `资产 ${assetId} 不存在（幂等删除）`,
        lines: [],
      });
      await loadManifest(true);
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
      return null;
    }
  };

  const generate = async (params: AssetsGenerateParams): Promise<AssetsGenerateResult | null> => {
    patch({ writeBusy: `正在生成候选项（${params.style}）…` });
    try {
      const result = await call<AssetsGenerateResult>('assets.generate', params);
      patch({ writeBusy: null });
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: `生成失败：${error instanceof Error ? error.message : String(error)}`, lines: [] });
      return null;
    }
  };

  const generateMap = async (params: MapGenerateParams): Promise<MapGenerateResult | null> => {
    patch({ writeBusy: params.withBackground === true ? '正在生成结构 + AI 底图…' : '正在生成战斗地图结构…' });
    try {
      const result = await call<MapGenerateResult>('map.generate', params);
      patch({ writeBusy: null });
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: `地图生成失败：${error instanceof Error ? error.message : String(error)}`, lines: [] });
      return null;
    }
  };

  const generateWorld = async (params: WorldGenerateParams): Promise<WorldGenerateResult | null> => {
    patch({ writeBusy: params.withBackground === true ? '正在生成世界结构 + AI 底图…' : '正在生成世界地图结构…' });
    try {
      const result = await call<WorldGenerateResult>('world.generate', params);
      patch({ writeBusy: null });
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: `世界地图生成失败：${error instanceof Error ? error.message : String(error)}`, lines: [] });
      return null;
    }
  };

  const savePack = async (nextPack: ContentPack, label: string): Promise<PackUpdateResult | null> => {
    const packId = nextPack.packId;
    patch({ writeBusy: `正在保存内容包（${label}）…` });
    try {
      const result = await call<PackUpdateResult>('pack.update', { packId, pack: nextPack });
      const warnings = warnLines(result.warnings ?? []);
      patch({ writeBusy: null, lastWarnings: warnings });
      setNotice({
        tone: 'ok',
        text: `已保存「${result.packId}」v${result.version}（${label}；packHash ${result.packHash.slice(0, 12)}…）`,
        lines: warnings,
      });
      await refreshCatalog();
      await loadDetail(packId);
      return result;
    } catch (error) {
      patch({ writeBusy: null });
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
      return null;
    }
  };

  /** M9.6b `rules.validate`：校验已安装包或草稿（草稿不落盘）。 */
  const validateRules = async (draft?: ContentPack | null): Promise<RulesValidateResult | null> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return null;
    if (snapshot.validationBusy) return null;
    patch({ validationBusy: true });
    try {
      const result = await call<RulesValidateResult>('rules.validate', {
        packId,
        ...(draft !== null && draft !== undefined ? { pack: draft } : {}),
      });
      patch({ validationBusy: false, validation: result });
      const lines = [
        ...result.errors.slice(0, 6).map((error) => `错误：${error}`),
        ...result.warnings.slice(0, 6).map((warning) => `警告：${warning}`),
      ];
      setNotice({
        tone: result.ok ? (result.warnings.length > 0 ? 'info' : 'ok') : 'bad',
        text: `规则校验${result.draft ? '（草稿，未保存）' : ''}：${
          result.ok ? `通过（${result.scripts.length} 条脚本检查）` : `${result.errors.length} 个错误`
        }`,
        lines,
      });
      return result;
    } catch (error) {
      patch({ validationBusy: false });
      setNotice({ tone: 'bad', text: `规则校验失败：${error instanceof Error ? error.message : String(error)}`, lines: [] });
      return null;
    }
  };

  /** M9.6b `rules.test`：临时运行时 + 样本卡试跑（可传草稿；不建房间）。 */
  const runRulesTest = async (input: {
    requests: RulesTestRequest[];
    seed?: number;
    pack?: ContentPack | null;
  }): Promise<RulesTestResult | null> => {
    const packId = snapshot.selectedPackId;
    if (packId === null) return null;
    if (snapshot.testBusy) return null;
    patch({ testBusy: true });
    try {
      const result = await call<RulesTestResult>('rules.test', {
        packId,
        requests: input.requests,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.pack !== null && input.pack !== undefined ? { pack: input.pack } : {}),
      });
      patch({ testBusy: false, testResult: result });
      const failed = result.outcomes.filter((outcome) => !outcome.ok).length;
      const lines = [
        ...result.errors.slice(0, 6),
        ...result.outcomes
          .filter((outcome) => !outcome.ok && outcome.error !== undefined)
          .slice(0, 4)
          .map((outcome) => `${outcome.label}：${outcome.error?.messageZh ?? ''}`),
      ];
      setNotice({
        tone: result.ok ? 'ok' : 'bad',
        text: `规则测试台${result.draft ? '（草稿）' : ''}：${result.outcomes.length} 条，${
          failed === 0 ? '全部通过' : `${failed} 条失败`
        }（seed ${result.seed}）`,
        lines,
      });
      return result;
    } catch (error) {
      patch({ testBusy: false });
      setNotice({ tone: 'bad', text: `规则测试台运行失败：${error instanceof Error ? error.message : String(error)}`, lines: [] });
      return null;
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    init(nextReadSession) {
      readSession = nextReadSession;
      void ensureReady();
    },
    setTab(tab) {
      patch({ tab });
      if (tab === 'icons' && snapshot.manifestPackId !== snapshot.selectedPackId) void loadManifest();
    },
    setNotice,
    dismissNotice: () => setNotice(null),
    connect,
    refreshCatalog,
    selectPack,
    refreshDetail,
    loadManifest,
    exportCurrent,
    duplicateCurrent,
    importPack,
    putAsset,
    deleteAsset,
    generate,
    generateMap,
    generateWorld,
    savePack,
    validateRules,
    runRulesTest,
    isBuiltinPack(packId) {
      const id = packId ?? snapshot.selectedPackId;
      return snapshot.packs.some((pack) => pack.packId === id && pack.source === 'builtin');
    },
  };
}

// 类型再导出（UI 用；避免 UI 直接依赖 content 包的内部形状）
export type { CharacterCardDef, ContentPack, PackLorebookDef, PackModuleDef };
/** 规则段类型（M9.6b 规则编辑器用）。 */
export type RulePackDef = NonNullable<ContentPack['rules']>;
/** 规则编辑器下拉选项（来自 rules 包的权威枚举，避免 UI 手抄漂移）。 */
export { ACTION_KINDS, FIELD_KINDS, RANGE_BANDS, SPACE_MODELS, STACKING_MODES, TARGETING_SIDES, TARGETING_TYPES, TIME_MODELS };

/** 给 UI 的图片嗅探（本地导入预检：只收 PNG/SVG）。 */
export function sniffIconFormat(b64: string): 'png' | 'svg' | null {
  try {
    return sniffImageFormat(base64ToBytes(b64));
  } catch {
    return null;
  }
}
