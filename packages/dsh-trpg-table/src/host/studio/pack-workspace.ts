/**
 * 内容包工坊后端（M9.5e，host 侧）：`pack.detail/update/export/import/assetPut/assetDelete` 的实现。
 *
 * 权威与安全：
 * - **内置包只读**：内置包不可 update / assetPut / assetDelete（registry 里内置包永远优先，
 *   写数据目录也盖不住它）——给可读中文错误并提示用 `pack.import strategy=rename` 复制成数据包；
 * - 写操作全部「先校验（validatePack）+ 临时文件 + rename」原子落盘；失败不产出半成品；
 * - 写成功后立即 `registry.reload()`，并清掉数据目录里同 packId 的陈旧文件（否则旧文件可能因
 *   文件名排序先加载而"盖住"新写入，导致作者以为没生效）；
 * - 上传资产复用 `@dsh-trpg/assets` 的 `normalizeImage` 按 kind 归一到标准档，再更新
 *   `assets/manifest.json`（结构/大小/sha256/引用由 `validatePack()` 复核）；
 * - 内置包导出 = `packToTrpgpack()` 现场编码（可复现）；数据目录包导出 = 原始 zip 字节（packHash 与安装一致）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ASSET_MANIFEST_ENTRY,
  collectPackAssetReferences,
  isSafeAssetId,
  migratePack,
  validatePack,
  type ContentPack,
} from '@dsh-trpg/content';
import { packHashOfBytes, packToTrpgpack, trpgpackFileName, trpgpackToPack } from '@dsh-trpg/content/pack-zip';
import { readPackFile, writePackBytesFile, writePackFile } from '@dsh-trpg/content/pack-io';
import {
  buildAssetEntry,
  createManifest,
  findAsset,
  normalizeImage,
  parseManifest,
  stringifyManifest,
  type AssetManifest,
  type NormalizeTargetId,
} from '../../../../assets/src/index.ts';
import { RoomError } from '@dsh-trpg/rooms';
import type {
  PackAssetDeleteParams,
  PackAssetDeleteResult,
  PackAssetKind,
  PackAssetPutParams,
  PackAssetPutResult,
  PackAssetTargetId,
  PackDetailParams,
  PackDetailResult,
  PackExportParams,
  PackExportResult,
  PackImportParams,
  PackImportResult,
  PackUpdateParams,
  PackUpdateResult,
} from '@dsh-trpg/protocol';
import type { PackEntry, PackRegistry } from '../pack-registry.ts';
import { BACKGROUND_MAX_BYTES } from './background.ts';

export interface PackWorkspaceOptions {
  registry: PackRegistry;
  /** 数据目录（缺省 `registry.dir`）。 */
  dir?: string;
  log?: (message: string) => void;
  now?: () => number;
}

/** 资产 kind → 归一化目标档（`meta.target` 可覆盖；地图底图用 world-map / battle-map）。 */
const KIND_TO_TARGET: Readonly<Record<PackAssetKind, NormalizeTargetId>> = {
  item: 'icon-128',
  action: 'icon-128',
  status: 'icon-128',
  resource: 'icon-128',
  attribute: 'icon-128',
  slot: 'icon-128',
  avatar: 'avatar-256',
  portrait: 'portrait',
  variant: 'variant',
  spritesheet: 'spritesheet',
  npc: 'portrait',
  cover: 'cover',
};

/** 资产 kind → `assets/<folder>/...` 落盘目录。 */
const KIND_FOLDER: Readonly<Record<PackAssetKind, string>> = {
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

const MAP_TARGETS: ReadonlySet<string> = new Set(['battle-map', 'world-map']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePack(entry: PackEntry): ContentPack {
  return structuredClone(entry.pack);
}

/** base64 → 字节（严格校验，坏输入给中文错误）。 */
function decodeBase64(text: string, label: string): Uint8Array {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new RoomError('bad-request', `${label}不是合法的 Base64`);
  }
  const bytes = new Uint8Array(Buffer.from(compact, 'base64'));
  if (bytes.length === 0) throw new RoomError('bad-request', `${label}解码后为空`);
  return bytes;
}

/** 资产文件路径（manifest 的 `file`）：`assets/<folder>/<assetId 的 . 换成 ->.<ext>`。 */
function assetFilePath(kind: PackAssetKind, assetId: string, extension: string, suffix = ''): string {
  const folder = KIND_FOLDER[kind];
  const base = assetId.replaceAll('.', '-').replace(/[^A-Za-z0-9_-]/g, '-');
  return `assets/${folder}/${base}${suffix}.${extension}`;
}

/** 一个文件路径是否被清单里某个条目占用（用于「替换同 assetId / 去重」时避开冲突）。 */
function fileUsedByOther(manifest: AssetManifest, file: string, assetId: string): boolean {
  return manifest.assets.some((asset) => asset.file === file && asset.assetId !== assetId);
}

/** 在清单里挑一个未被占用的落盘路径（同 assetId 替换优先沿用旧路径，引用不断）。 */
function pickAssetFilePath(
  manifest: AssetManifest,
  kind: PackAssetKind,
  assetId: string,
  extension: string,
  existingFile?: string,
): string {
  if (existingFile !== undefined && !fileUsedByOther(manifest, existingFile, assetId)) return existingFile;
  const first = assetFilePath(kind, assetId, extension);
  if (!fileUsedByOther(manifest, first, assetId)) return first;
  for (let index = 2; index < 100; index += 1) {
    const candidate = assetFilePath(kind, assetId, extension, `-${index}`);
    if (!fileUsedByOther(manifest, candidate, assetId)) return candidate;
  }
  throw new RoomError('conflict', `资产文件路径冲突无法解决：${assetId}`);
}

/** `pack.json` 对某个 assetId 的引用位置（删除资产前做「被引用则拒绝」检查）。 */
function referencesToAsset(pack: ContentPack, manifest: AssetManifest, assetId: string): string[] {
  const byFile = new Map<string, string>();
  for (const asset of manifest.assets) byFile.set(asset.file, asset.assetId);
  const sources: string[] = [];
  for (const reference of collectPackAssetReferences(pack)) {
    const { value, source } = reference;
    if (value.startsWith('<svg')) continue;
    if (value.startsWith('@pack:')) {
      if (byFile.get(value.slice('@pack:'.length)) === assetId) sources.push(source);
      continue;
    }
    if (value.startsWith('assets/')) {
      if (byFile.get(value) === assetId) sources.push(source);
      continue;
    }
    if (isSafeAssetId(value)) {
      if (value === assetId) sources.push(source);
      continue;
    }
    if (value.includes('/')) {
      for (const extension of ['svg', 'png'] as const) {
        if (byFile.get(`assets/icons/${value}.${extension}`) === assetId) sources.push(source);
      }
    }
  }
  return sources;
}

/** `.trpgpack` 字节 → 校验后的包（导入/导出复用同一口径，不旁路 import）。 */
function decodePackBytes(bytes: Uint8Array): { pack: ContentPack; assets: Map<string, Uint8Array>; scripts: Map<string, Uint8Array>; warnings: string[] } {
  const decoded = trpgpackToPack(bytes);
  if (!decoded.ok || decoded.pack === undefined) {
    throw new RoomError('bad-request', `内容包校验失败：${decoded.errors.join('；')}`);
  }
  return { pack: decoded.pack, assets: decoded.assets, scripts: decoded.scripts, warnings: decoded.warnings };
}

/**
 * 内容包工坊：读写 host 内容包数据目录（`<profile-data>/dsh-trpg-table/content/packs/*.trpgpack`）。
 * 所有方法抛 `RoomError`（中文消息）；调用方（room-http）只负责 loopback + host token 鉴权。
 */
export class PackWorkspace {
  readonly dir: string;
  private readonly registry: PackRegistry;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(options: PackWorkspaceOptions) {
    this.registry = options.registry;
    this.dir = options.dir ?? options.registry.dir;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  private entryOrThrow(packId: string): PackEntry {
    const entry = this.registry.getEntry(packId);
    if (entry === undefined) throw new RoomError('not-found', `内容包不存在：${packId}`);
    return entry;
  }

  private dataEntryOrThrow(packId: string): PackEntry & { filePath: string } {
    const entry = this.entryOrThrow(packId);
    if (entry.source === 'builtin') {
      throw new RoomError(
        'conflict',
        `内置包「${packId}」只读，不能直接修改：请用 pack.import（strategy=rename）复制成数据目录包后再编辑`,
      );
    }
    if (entry.filePath === undefined) {
      throw new RoomError('conflict', `内容包「${packId}」没有数据文件路径（注册表状态异常），请先重扫内容包`);
    }
    return entry as PackEntry & { filePath: string };
  }

  /** `pack.detail`：完整包（深拷贝，防止调用方改内存里的注册表数据）。 */
  detail(params: PackDetailParams): PackDetailResult {
    const entry = this.entryOrThrow(params.packId);
    return { pack: clonePack(entry) };
  }

  /** `pack.update`：校验后写到 `<dir>/<packId>-<version>.trpgpack`，成功后 reload。 */
  async update(params: PackUpdateParams): Promise<PackUpdateResult> {
    const existing = this.registry.getEntry(params.packId);
    if (existing?.source === 'builtin') {
      throw new RoomError(
        'conflict',
        `内置包「${params.packId}」只读：请先 pack.import（strategy=rename）复制成数据目录包再编辑`,
      );
    }
    if (existing !== undefined && existing.source === 'data' && existing.filePath === undefined) {
      throw new RoomError('conflict', `内容包「${params.packId}」没有数据文件路径，请先重扫内容包`);
    }
    const migration = migratePack(params.pack);
    const migrationWarnings = [...migration.warnings];
    const pack = migration.pack as ContentPack;
    if (!isRecord(pack) || pack.packId !== params.packId) {
      throw new RoomError('bad-request', 'pack 缺少 packId 或与参数 packId 不一致（内置包不可改名：请用 pack.import strategy=rename）');
    }

    // 既有数据包的 assets/scripts 是二进制条目，客户端只传 pack.json：必须原样保留。
    let assets = new Map<string, Uint8Array>();
    let scripts = new Map<string, Uint8Array>();
    let previousWarnings: string[] = [];
    if (existing !== undefined && existing.source === 'data') {
      const decoded = await readPackFile(existing.filePath as string);
      if (!decoded.ok || decoded.pack === undefined) {
        throw new RoomError(
          'conflict',
          `读取现有内容包文件失败（未写入任何内容）：${decoded.errors.join('；')}`,
        );
      }
      assets = decoded.assets;
      scripts = decoded.scripts;
      previousWarnings = decoded.warnings;
    }
    const report = validatePack(pack, { assets, scripts });
    if (!report.ok) {
      throw new RoomError('bad-request', `内容包校验失败（未写入任何内容）：${report.errors.join('；')}`);
    }

    const targetPath = join(this.dir, trpgpackFileName(pack));
    let written;
    try {
      written = await writePackFile(targetPath, pack, { assets, scripts });
    } catch (error) {
      throw new RoomError(
        'bad-request',
        `内容包写入失败（已回滚，未产生半成品）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const warnings = [...migrationWarnings, ...previousWarnings, ...report.warnings];
    if (existing?.filePath !== undefined && existing.filePath !== targetPath) {
      await this.unlinkStale(existing.filePath, warnings);
    }
    await this.removeStaleDuplicates(params.packId, targetPath, warnings);
    const reloaded = this.registry.reload();
    const loaded = this.registry.getEntry(params.packId);
    if (loaded === undefined) {
      warnings.push(`写入成功但重扫后没有加载到「${params.packId}」：${reloaded.warnings.join('；') || '请检查数据目录'}`);
    } else if (loaded.contentHash !== written.contentHash) {
      warnings.push('重扫后加载到的内容与刚写入的不一致（数据目录可能有同名重复包），请检查数据目录');
    }
    this.log(`pack.update ${params.packId}@${pack.version} -> ${targetPath} (${written.bytes.length} bytes)`);
    return { packId: params.packId, version: pack.version, packHash: written.packHash, warnings };
  }

  /** `pack.export`：内置包现场编码（可复现），数据目录包读原始字节（packHash 与安装一致）。 */
  exportPack(params: PackExportParams): PackExportResult {
    const entry = this.entryOrThrow(params.packId);
    let bytes: Uint8Array;
    if (entry.source === 'data') {
      if (entry.filePath === undefined || !existsSync(entry.filePath)) {
        throw new RoomError('conflict', `内容包「${params.packId}」的数据文件不存在，请先重扫内容包`);
      }
      bytes = new Uint8Array(readFileSync(entry.filePath));
    } else {
      try {
        bytes = packToTrpgpack(entry.pack);
      } catch (error) {
        throw new RoomError(
          'conflict',
          `内置包导出失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      fileName: trpgpackFileName(entry.pack),
      b64: Buffer.from(bytes).toString('base64'),
      bytes: bytes.length,
      packHash: packHashOfBytes(bytes),
    };
  }
  /** `pack.import`：同 id 冲突按 strategy 处理（拒绝 / 覆盖数据包 / 另存 `-copy-N`）。 */
  async importPack(params: PackImportParams): Promise<PackImportResult> {
    const bytes = decodeBase64(params.b64, '导入包内容');
    const decoded = decodePackBytes(bytes);
    const warnings = [...decoded.warnings];
    let pack = decoded.pack;
    const existing = this.registry.getEntry(pack.packId);
    const builtinConflict = existing?.source === 'builtin';
    let action: PackImportResult['action'] = 'created';

    if (params.strategy === 'reject' && (existing !== undefined || existsSync(join(this.dir, trpgpackFileName(pack))))) {
      const installed = existing !== undefined ? `版本 ${existing.pack.version}` : '数据目录已有同名文件';
      throw new RoomError(
        'conflict',
        `内容包「${pack.packId}」已安装（${installed}）：请改用 strategy=overwrite（覆盖数据目录包）或 strategy=rename（另存副本）`,
      );
    }

    if (params.strategy === 'overwrite' && builtinConflict) {
      throw new RoomError(
        'conflict',
        `内置包「${pack.packId}」不可覆盖（内置包永远优先）：请改用 strategy=rename 另存为数据目录包`,
      );
    }

    if (params.strategy === 'rename') {
      const newPackId = await this.nextCopyPackId(pack.packId);
      pack = { ...pack, packId: newPackId };
      // 清单里如果写了 packId，必须同步改，否则 validatePack 报「清单 packId 与 pack.json 不一致」
      const manifestBytes = decoded.assets.get(ASSET_MANIFEST_ENTRY);
      if (manifestBytes !== undefined) {
        const parsed = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
        if (!parsed.ok || parsed.manifest === undefined) {
          throw new RoomError('bad-request', `导入包的 assets/manifest.json 不合法：${parsed.errors.map((item) => item.message).join('；')}`);
        }
        const manifest: AssetManifest = { ...parsed.manifest, packId: newPackId };
        decoded.assets.set(ASSET_MANIFEST_ENTRY, new TextEncoder().encode(stringifyManifest(manifest)));
      }
      action = 'renamed';
      warnings.push(`发现同 id 冲突，已另存为「${newPackId}」`);
    } else if (existing !== undefined && existing.source === 'data') {
      action = 'overwritten';
    }

    const targetPath = join(this.dir, trpgpackFileName(pack));
    let written;
    try {
      if (action === 'renamed') {
        // 改过 packId/清单：走编码 + 全量校验路径（不是原始字节）
        written = await writePackFile(targetPath, pack, { assets: decoded.assets, scripts: decoded.scripts });
      } else {
        // 覆盖/新建：原始字节原子落盘，packHash 与来源一致
        written = await writePackBytesFile(targetPath, bytes);
      }
    } catch (error) {
      throw new RoomError(
        'bad-request',
        `内容包导入写入失败（未产生半成品）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (existing?.filePath !== undefined && existing.filePath !== targetPath) {
      await this.unlinkStale(existing.filePath, warnings);
    }
    await this.removeStaleDuplicates(pack.packId, targetPath, warnings);
    const reloaded = this.registry.reload();
    const loaded = this.registry.getEntry(pack.packId);
    if (loaded === undefined) {
      warnings.push(`写入成功但重扫后没有加载到「${pack.packId}」：${reloaded.warnings.join('；') || '请检查数据目录'}`);
    }
    this.log(`pack.import ${action} ${pack.packId}@${pack.version} (${written.bytes} bytes)`);
    return { packId: pack.packId, version: pack.version, action, warnings };
  }

  /** `pack.assetPut`：归一化图片 → 更新 manifest + 资产条目 → 原子重写包 → reload。 */
  async assetPut(params: PackAssetPutParams): Promise<PackAssetPutResult> {
    const entry = this.dataEntryOrThrow(params.packId);
    const decoded = await readPackFile(entry.filePath);
    if (!decoded.ok || decoded.pack === undefined) {
      throw new RoomError('conflict', `读取现有内容包失败：${decoded.errors.join('；')}`);
    }
    const pack = decoded.pack;
    const assets = decoded.assets;
    const scripts = decoded.scripts;

    const rawBytes = decodeBase64(params.b64, '图片内容');
    const target = (params.meta?.target ?? KIND_TO_TARGET[params.kind]) as PackAssetTargetId;
    const targetId = target as NormalizeTargetId;
    const normalized = normalizeImage(rawBytes, targetId, {
      ...(params.meta?.rows !== undefined || params.meta?.cols !== undefined
        ? {
            ...(params.meta.rows !== undefined ? { rows: params.meta.rows } : {}),
            ...(params.meta.cols !== undefined ? { cols: params.meta.cols } : {}),
          }
        : {}),
      ...(MAP_TARGETS.has(target) ? { maxBytes: BACKGROUND_MAX_BYTES[target as 'battle-map' | 'world-map'] } : {}),
    });
    if (
      !normalized.ok ||
      normalized.bytes === undefined ||
      normalized.format === undefined ||
      normalized.sha256 === undefined
    ) {
      throw new RoomError(
        'bad-request',
        `图片校验/归一化失败（按 ${target} 档）：${normalized.errors[0] ?? '未知原因'}`,
      );
    }

    // ---- manifest：有则解析（校验过包所以应当是合法清单），没有则新建 ----
    const manifestBytes = assets.get(ASSET_MANIFEST_ENTRY);
    let manifest: AssetManifest;
    if (manifestBytes !== undefined) {
      const parsed = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
      if (!parsed.ok || parsed.manifest === undefined) {
        throw new RoomError(
          'conflict',
          `现有资产清单不合法（未写入任何内容）：${parsed.errors.map((item) => item.message).join('；')}`,
        );
      }
      manifest = parsed.manifest;
    } else {
      manifest = createManifest(pack.packId);
    }
    const existingAsset = findAsset(manifest, params.assetId);
    const file = pickAssetFilePath(
      manifest,
      params.kind,
      params.assetId,
      normalized.format,
      existingAsset?.format === normalized.format ? existingAsset.file : undefined,
    );
    const built = buildAssetEntry({
      assetId: params.assetId,
      file,
      format: normalized.format,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.bytes.length,
      sha256: normalized.sha256,
      kind: params.kind,
      ...(params.meta?.style !== undefined ? { style: params.meta.style } : {}),
      ...(params.meta?.seed !== undefined ? { seed: params.meta.seed } : {}),
      ...(params.meta?.prompt !== undefined ? { prompt: params.meta.prompt } : {}),
      createdAt: new Date(this.now()).toISOString(),
    });
    if (!built.ok || built.entry === undefined) {
      throw new RoomError(
        'bad-request',
        `资产条目校验失败（未写入任何内容）：${built.errors.map((item) => item.message).join('；')}`,
      );
    }
    const nextAssets = manifest.assets.filter((asset) => asset.assetId !== params.assetId);
    nextAssets.push(built.entry);
    const nextManifest: AssetManifest = {
      schemaVersion: manifest.schemaVersion,
      ...(manifest.packId !== undefined ? { packId: manifest.packId } : {}),
      assets: nextAssets,
    };
    // 同 assetId 替换：旧文件名若变化，删掉旧条目（避免孤立文件 + 文件名唯一性冲突）
    if (existingAsset !== undefined && existingAsset.file !== file) {
      assets.delete(existingAsset.file);
    }
    assets.set(file, normalized.bytes);
    assets.set(ASSET_MANIFEST_ENTRY, new TextEncoder().encode(stringifyManifest(nextManifest)));

    const report = validatePack(pack, { assets, scripts });
    if (!report.ok) {
      throw new RoomError('bad-request', `资产更新后内容包校验失败（未写入任何内容）：${report.errors.join('；')}`);
    }
    try {
      await writePackFile(entry.filePath, pack, { assets, scripts });
    } catch (error) {
      throw new RoomError(
        'bad-request',
        `资产写入失败（已回滚，未产生半成品）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.registry.reload();
    this.log(`pack.assetPut ${params.packId}/${params.assetId} -> ${file} (${normalized.bytes.length} bytes)`);
    return {
      assetId: params.assetId,
      sha256: normalized.sha256,
      bytes: normalized.bytes.length,
      manifestUpdated: true,
    };
  }

  /** `pack.assetDelete`：被 `pack.json` 引用的资产拒绝删除（要先解除引用，避免包校验失败）。 */
  async assetDelete(params: PackAssetDeleteParams): Promise<PackAssetDeleteResult> {
    const entry = this.dataEntryOrThrow(params.packId);
    const decoded = await readPackFile(entry.filePath);
    if (!decoded.ok || decoded.pack === undefined) {
      throw new RoomError('conflict', `读取现有内容包失败：${decoded.errors.join('；')}`);
    }
    const pack = decoded.pack;
    const assets = decoded.assets;
    const scripts = decoded.scripts;
    const manifestBytes = assets.get(ASSET_MANIFEST_ENTRY);
    if (manifestBytes === undefined) return { removed: false };
    const parsed = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    if (!parsed.ok || parsed.manifest === undefined) {
      throw new RoomError('conflict', `现有资产清单不合法：${parsed.errors.map((item) => item.message).join('；')}`);
    }
    const manifest = parsed.manifest;
    const asset = findAsset(manifest, params.assetId);
    if (asset === undefined) return { removed: false };
    const references = referencesToAsset(pack, manifest, params.assetId);
    if (references.length > 0) {
      throw new RoomError(
        'conflict',
        `资产「${params.assetId}」仍被 pack.json 引用（${references.join('；')}），拒绝删除：请先解除引用再删`,
      );
    }
    const nextManifest: AssetManifest = {
      schemaVersion: manifest.schemaVersion,
      ...(manifest.packId !== undefined ? { packId: manifest.packId } : {}),
      assets: manifest.assets.filter((candidate) => candidate.assetId !== params.assetId),
    };
    assets.delete(asset.file);
    assets.set(ASSET_MANIFEST_ENTRY, new TextEncoder().encode(stringifyManifest(nextManifest)));
    const report = validatePack(pack, { assets, scripts });
    if (!report.ok) {
      throw new RoomError('bad-request', `删除资产后内容包校验失败（未写入任何内容）：${report.errors.join('；')}`);
    }
    try {
      await writePackFile(entry.filePath, pack, { assets, scripts });
    } catch (error) {
      throw new RoomError(
        'bad-request',
        `删除资产写入失败（已回滚，未产生半成品）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.registry.reload();
    this.log(`pack.assetDelete ${params.packId}/${params.assetId} (removed ${asset.file})`);
    return { removed: true };
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private async unlinkStale(filePath: string, warnings: string[]): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      warnings.push(`旧包文件删除失败（不影响新包）：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  /**
   * 清掉数据目录里同 packId 的陈旧 `.trpgpack`（文件名排序可能让别的同名文件先被加载，
   * 导致新写入"看起来没生效"）。只删解码后 packId 相同的文件，不碰别人的包。
   */
  private async removeStaleDuplicates(packId: string, keepPath: string, warnings: string[]): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((name) => name.toLowerCase().endsWith('.trpgpack'));
    } catch {
      return;
    }
    for (const name of names) {
      const filePath = join(this.dir, name);
      if (filePath === keepPath) continue;
      try {
        const bytes = new Uint8Array(await readFile(filePath));
        const decoded = trpgpackToPack(bytes);
        if (decoded.ok && decoded.pack?.packId === packId) {
          await unlink(filePath);
          warnings.push(`已清理数据目录里的同 id 陈旧包文件：${name}`);
        }
      } catch {
        /* 坏文件留给 registry 报 warning，不在这里删 */
      }
    }
  }

  /** 冲突「另存副本」：`<base>-copy-1`、`-copy-2`…（不撞内置包/已加载包/同名文件）。 */
  private async nextCopyPackId(basePackId: string): Promise<string> {
    const taken = new Set<string>();
    for (const entry of this.registry.list()) taken.add(entry.pack.packId);
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    for (let index = 1; index <= 99; index += 1) {
      const candidate = `${basePackId}-copy-${index}`;
      if (taken.has(candidate)) continue;
      if (names.some((name) => name.toLowerCase().startsWith(`${candidate}-`) && name.toLowerCase().endsWith('.trpgpack'))) {
        continue;
      }
      return candidate;
    }
    throw new RoomError('conflict', `无法为「${basePackId}」生成副本 id（-copy-1..99 都被占用了）`);
  }
}
