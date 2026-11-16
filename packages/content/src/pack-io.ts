/**
 * 内容包文件读写（Node 侧，`node:fs`）。
 *
 * 只做「字节 ↔ 文件 / 目录」的搬运，校验/编解码全部复用 `pack-zip.ts` / `pack.ts`：
 * - `readPackFile`     读 `.trpgpack`（zip）→ 解码 + 校验，不落盘；
 * - `readPackJsonFile` 读源码目录里的 `pack.json`（含同目录 `assets/` 与 `rules/scripts/`），同样走 migrate + validate；
 * - `writePackFile`    校验后原子写 `.trpgpack`（临时文件 + rename，坏包不留半成品）；
 * - `importPackFile`   解包到 `<target>/<packId>/pack.json`（+ `assets/` + `rules/scripts/`），供 CLI / 工坊使用。
 *
 * 规则脚本（M9.3）：源码目录形状是 `<dir>/rules/scripts/*.js`，与 zip 条目路径一致；
 * 读取时把脚本内容交给 `validatePack()` 校验 `pack.rules.scripts` 的 sha256。
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
import { ASSET_MANIFEST_ENTRY } from './asset-manifest.ts';
import {
  SCRIPT_ENTRY_PREFIX,
  isSafeScriptPath,
  normalizePackScripts,
  type PackScriptsInput,
} from './pack-scripts.ts';

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
  /** 同目录下扫描到的规则脚本路径（`rules/scripts/*.js`）。 */
  scriptPaths: string[];
  /** 规则脚本字节（默认总是读取：脚本很小，且校验 sha256 必须要内容）。 */
  scripts: Map<string, Uint8Array>;
}

export interface PackJsonReadOptions {
  /** 是否把 assets/ 下的文件读进内存（导出时需要；只看校验结果时关闭）。 */
  loadAssets?: boolean;
  /** 是否读取 `rules/scripts/` 下的脚本源码（默认 true；校验 sha256 需要）。 */
  loadScripts?: boolean;
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
  /** 落盘的规则脚本路径（`rules/scripts/*.js`）。 */
  scriptPaths: string[];
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
      scripts: new Map(),
      filePath,
    };
  }
  const bytes = new Uint8Array(await readFile(filePath));
  return { ...trpgpackToPack(bytes), filePath };
}

/** 读取源码目录里的 `pack.json`（并收集同目录 `assets/**`、`rules/scripts/**`）。 */
export async function readPackJsonFile(
  filePath: string,
  options: PackJsonReadOptions = {},
): Promise<PackJsonReadResult> {
  const assetPaths: string[] = [];
  const assets = new Map<string, Uint8Array>();
  const scriptPaths: string[] = [];
  const scripts = new Map<string, Uint8Array>();
  const empty = (errors: string[]): PackJsonReadResult => ({
    ok: false,
    errors,
    warnings: [],
    filePath,
    assetPaths,
    assets,
    scriptPaths,
    scripts,
  });
  const info = await stat(filePath).catch(() => undefined);
  if (!info || !info.isFile()) {
    return empty([`pack.json 不存在或不是普通文件：${filePath}`]);
  }
  let parsed: unknown;
  try {
    const text = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/u, '');
    parsed = JSON.parse(text);
  } catch (error) {
    return empty([`pack.json 解析失败：${error instanceof Error ? error.message : String(error)}`]);
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
  // 规则脚本：`<dir>/rules/scripts/**.js`（zip 条目路径与源码目录一致）
  const scriptRoot = join(dirname(filePath), ...SCRIPT_ENTRY_PREFIX.replace(/\/+$/u, '').split('/'));
  const scriptRootInfo = await stat(scriptRoot).catch(() => undefined);
  if (scriptRootInfo?.isDirectory()) {
    const files = await walkFiles(scriptRoot);
    for (const absolutePath of files) {
      const relativePath = relative(scriptRoot, absolutePath).split(/[\\/]+/u).join('/');
      const scriptPath = `${SCRIPT_ENTRY_PREFIX}${relativePath}`;
      if (!isSafeScriptPath(scriptPath)) continue;
      scriptPaths.push(scriptPath);
      if (options.loadScripts !== false) scripts.set(scriptPath, new Uint8Array(await readFile(absolutePath)));
    }
    scriptPaths.sort();
  }
  // 资产清单：不加载全部素材字节时也要读 manifest（很小），让清单结构/引用/file 存在性仍被校验
  let assetManifestText: string | undefined;
  if (assetPaths.includes(ASSET_MANIFEST_ENTRY) && !assets.has(ASSET_MANIFEST_ENTRY)) {
    try {
      assetManifestText = await readFile(
        join(dirname(filePath), ...ASSET_MANIFEST_ENTRY.split('/')),
        'utf8',
      );
    } catch (error) {
      return empty([
        `assets/manifest.json 读取失败：${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  const migration = migratePack(parsed);
  const report = validatePack(migration.pack, {
    ...(options.loadAssets ? { assets } : assetManifestText !== undefined ? { assetPaths, assetManifestText } : { assetPaths }),
    ...(options.loadScripts === false ? {} : { scripts }),
  });
  const warnings = [...migration.warnings, ...report.warnings];
  if (!report.ok || !report.value) {
    return { ok: false, errors: report.errors, warnings, filePath, assetPaths, assets, scriptPaths, scripts };
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
    scriptPaths,
    scripts,
  };
}

/** 校验并原子写 `.trpgpack`（临时文件 + rename）。 */
export async function writePackFile(
  filePath: string,
  pack: ContentPack,
  options: { assets?: AssetsInput; scripts?: PackScriptsInput } = {},
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

/** 把 pack 写成源码目录形状：`<dir>/pack.json` + `<dir>/assets/**` + `<dir>/rules/scripts/**`（便于 diff/评审）。 */
export async function writePackJsonFile(
  dirPath: string,
  pack: ContentPack,
  options: { assets?: AssetsInput; scripts?: PackScriptsInput } = {},
): Promise<{ packJsonPath: string; assetPaths: string[]; scriptPaths: string[] }> {
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
  // 规则脚本：落到 `<dir>/rules/scripts/*.js`（与 zip 条目路径一致）
  const scriptPaths: string[] = [];
  if (options.scripts !== undefined) {
    // 复用 pack-scripts 的规范化：路径/大小/sha256 一次校验，写盘内容与清单同源
    const normalized = normalizePackScripts(options.scripts);
    for (const [scriptPath, entry] of normalized) {
      const absolutePath = join(dirPath, ...scriptPath.split('/'));
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, Buffer.from(entry.code, 'utf8'));
      scriptPaths.push(scriptPath);
    }
    scriptPaths.sort();
  }
  return { packJsonPath, assetPaths, scriptPaths };
}

/**
 * 导入 `.trpgpack`：解到 `<target>/<packId>/`（`pack.json` + `assets/**` + `rules/scripts/**`）。
 * 先全量解码校验（含规则脚本 sha256），失败不落盘；目标已存在时覆盖同名文件（v1 CLI 行为）。
 */
export async function importPackFile(
  filePath: string,
  targetDir: string,
  options: { assets?: boolean } = {},
): Promise<ImportPackResult> {
  const decoded = await readPackFile(filePath);
  if (!decoded.ok || !decoded.pack) {
    return { ok: false, errors: decoded.errors, warnings: decoded.warnings, assetPaths: [], scriptPaths: [] };
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
  // 规则脚本：解码期已按 pack.rules.scripts 校验过 sha256，这里原样落盘（脚本很小，不受 --no-assets 影响）
  const scriptPaths: string[] = [];
  for (const [scriptPath, data] of decoded.scripts) {
    if (!isSafeScriptPath(scriptPath)) continue;
    const absolutePath = join(outputDir, ...scriptPath.split('/'));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, data);
    scriptPaths.push(scriptPath);
  }
  scriptPaths.sort();
  return {
    ok: true,
    errors: [],
    warnings: decoded.warnings,
    packId: pack.packId,
    version: pack.version,
    outputDir,
    packJsonPath,
    assetPaths,
    scriptPaths,
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
