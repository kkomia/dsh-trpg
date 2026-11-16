/**
 * 内容包文件读写（Node 侧，`node:fs`）。
 *
 * 只做「字节 ↔ 文件 / 目录」的搬运，校验/编解码全部复用 `pack-zip.ts` / `pack.ts`：
 * - `readPackFile`     读 `.trpgpack`（zip）→ 解码 + 校验，不落盘；
 * - `readPackJsonFile` 读源码目录里的 `pack.json`（含同目录 `assets/`），同样走 migrate + validate；
 * - `writePackFile`    校验后原子写 `.trpgpack`（临时文件 + rename，坏包不留半成品）；
 * - `importPackFile`   解包到 `<target>/<packId>/pack.json`（+ `assets/`），供 CLI / 工坊使用。
 *
 * 该模块含 node:fs，不进入浏览器 bundle；从 `@dsh-trpg/content/pack-io` 子路径导入。
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  contentHashOfPack,
  packHashOfBytes,
  packToTrpgpack,
  trpgpackFileName,
  trpgpackToPack,
  type AssetsInput,
  type TrpgpackDecodeResult,
} from './pack-zip.ts';
import { isSafePackAssetPath, migratePack, validatePack, type ContentPack } from './pack.ts';

export interface PackFileReadResult extends TrpgpackDecodeResult {
  /** 实际读取的文件路径（绝对或相对，取决于入参）。 */
  filePath: string;
}

export interface PackJsonReadResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  pack?: ContentPack;
  contentHash?: string;
  /** 读取的 pack.json 路径。 */
  filePath: string;
  /** 同目录下扫描到的素材路径（`assets/...`）。 */
  assetPaths: string[];
  /** `loadAssets: true` 时带出素材字节，供「源码目录 → .trpgpack」导出。 */
  assets: Map<string, Uint8Array>;
}

export interface PackJsonReadOptions {
  /** 是否把 assets/ 下的文件读进内存（导出时需要；只看校验结果时关闭）。 */
  loadAssets?: boolean;
}

export interface PackFileWriteResult {
  filePath: string;
  packId: string;
  version: string;
  bytes: Uint8Array;
  /** sha256(规范化 pack.json)，供房间快照记录。 */
  contentHash: string;
  /** sha256(zip 字节)，用于断言导出可复现。 */
  packHash: string;
}

export interface ImportPackResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  packId?: string;
  version?: string;
  /** 落点目录：`<target>/<packId>/`。 */
  outputDir?: string;
  packJsonPath?: string;
  assetPaths: string[];
  contentHash?: string;
}

/** 读取 `.trpgpack` 文件并解码校验（不落盘）。 */
export async function readPackFile(filePath: string): Promise<PackFileReadResult> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info || !info.isFile()) {
    return {
      ok: false,
      errors: [`文件不存在或不是普通文件：${filePath}`],
      warnings: [],
      assets: new Map(),
      filePath,
    };
  }
  const bytes = new Uint8Array(await readFile(filePath));
  return { ...trpgpackToPack(bytes), filePath };
}

/** 读取源码目录里的 `pack.json`（并收集同目录 `assets/**` 用于素材引用校验）。 */
export async function readPackJsonFile(
  filePath: string,
  options: PackJsonReadOptions = {},
): Promise<PackJsonReadResult> {
  const assetPaths: string[] = [];
  const assets = new Map<string, Uint8Array>();
  const info = await stat(filePath).catch(() => undefined);
  if (!info || !info.isFile()) {
    return {
      ok: false,
      errors: [`pack.json 不存在或不是普通文件：${filePath}`],
      warnings: [],
      filePath,
      assetPaths,
      assets,
    };
  }
  let parsed: unknown;
  try {
    const text = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/u, '');
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      errors: [`pack.json 解析失败：${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
      filePath,
      assetPaths,
      assets,
    };
  }
  const assetRoot = join(dirname(filePath), 'assets');
  const assetRootInfo = await stat(assetRoot).catch(() => undefined);
  if (assetRootInfo?.isDirectory()) {
    const files = await walkFiles(assetRoot);
    for (const absolutePath of files) {
      const assetPath = ['assets', ...relative(assetRoot, absolutePath).split(/[\\/]+/u)].join('/');
      assetPaths.push(assetPath);
      if (options.loadAssets) assets.set(assetPath, new Uint8Array(await readFile(absolutePath)));
    }
    assetPaths.sort();
  }
  const migration = migratePack(parsed);
  const report = validatePack(migration.pack, { assetPaths });
  const warnings = [...migration.warnings, ...report.warnings];
  if (!report.ok || !report.value) {
    return { ok: false, errors: report.errors, warnings, filePath, assetPaths, assets };
  }
  return {
    ok: true,
    errors: [],
    warnings,
    pack: report.value,
    contentHash: contentHashOfPack(report.value),
    filePath,
    assetPaths,
    assets,
  };
}

/** 校验并原子写 `.trpgpack`（临时文件 + rename）。 */
export async function writePackFile(
  filePath: string,
  pack: ContentPack,
  options: { assets?: AssetsInput } = {},
): Promise<PackFileWriteResult> {
  const bytes = packToTrpgpack(pack, options);
  const targetDir = dirname(filePath);
  await mkdir(targetDir, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return {
    filePath,
    packId: pack.packId,
    version: pack.version,
    bytes,
    contentHash: contentHashOfPack(pack),
    packHash: packHashOfBytes(bytes),
  };
}

/** 把 pack 写成源码目录形状：`<dir>/pack.json` + `<dir>/assets/**`（便于 diff/评审）。 */
export async function writePackJsonFile(
  dirPath: string,
  pack: ContentPack,
  options: { assets?: AssetsInput } = {},
): Promise<{ packJsonPath: string; assetPaths: string[] }> {
  await mkdir(dirPath, { recursive: true });
  const packJsonPath = join(dirPath, 'pack.json');
  await writeFile(packJsonPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  const assetPaths: string[] = [];
  if (options.assets !== undefined) {
    const entries = options.assets instanceof Map ? [...options.assets.entries()] : Object.entries(options.assets);
    for (const [assetPath, data] of entries) {
      if (!isSafePackAssetPath(assetPath)) {
        throw new Error(`素材路径非法（必须是以 assets/ 开头的相对路径）：${assetPath}`);
      }
      const absolutePath = join(dirPath, ...assetPath.split('/'));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      assetPaths.push(assetPath);
    }
    assetPaths.sort();
  }
  return { packJsonPath, assetPaths };
}

/**
 * 导入 `.trpgpack`：解到 `<target>/<packId>/`（`pack.json` + `assets/**`）。
 * 先全量解码校验，失败不落盘；目标已存在时覆盖同名 `pack.json`（v1 CLI 行为，M8.2 再做冲突策略）。
 */
export async function importPackFile(
  filePath: string,
  targetDir: string,
  options: { assets?: boolean } = {},
): Promise<ImportPackResult> {
  const decoded = await readPackFile(filePath);
  if (!decoded.ok || !decoded.pack) {
    return { ok: false, errors: decoded.errors, warnings: decoded.warnings, assetPaths: [] };
  }
  const pack = decoded.pack;
  const outputDir = join(targetDir, pack.packId);
  const { packJsonPath } = await writePackJsonFile(outputDir, pack, {});
  const assetPaths: string[] = [];
  if (options.assets !== false) {
    for (const [assetPath, data] of decoded.assets) {
      if (!isSafePackAssetPath(assetPath)) continue;
      const absolutePath = join(outputDir, ...assetPath.split('/'));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, data);
      assetPaths.push(assetPath);
    }
  }
  assetPaths.sort();
  return {
    ok: true,
    errors: [],
    warnings: decoded.warnings,
    packId: pack.packId,
    version: pack.version,
    outputDir,
    packJsonPath,
    assetPaths,
    contentHash: decoded.contentHash,
  };
}

/** 建议的导出文件名：`<packId>-<version>.trpgpack`。 */
export function suggestedPackFileName(pack: ContentPack): string {
  return trpgpackFileName(pack);
}

async function walkFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(absolutePath, depth + 1)));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}
