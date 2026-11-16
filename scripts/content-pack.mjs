#!/usr/bin/env node
/**
 * 内容包 CLI（M8.1 / M9.3）：`.trpgpack` / `pack.json` 的校验、导出、导入、查看。
 *
 * 用法：
 *   node scripts/content-pack.mjs validate <file.trpgpack|pack.json|目录>
 *   node scripts/content-pack.mjs export --pack <packId|pack.json|目录> [--out <file>] [--verify]
 *   node scripts/content-pack.mjs import <file.trpgpack> [--target <dir>] [--no-assets]
 *   node scripts/content-pack.mjs inspect <file.trpgpack|pack.json|目录>
 *
 * 规则包（M9.3）：带 `rules` 段的内容包，脚本源码是独立条目 `rules/scripts/*.js`。
 * - 导出内置包时从 `@dsh-trpg/content/rules-pack` 取脚本源码，写进 zip；
 * - 导入时脚本落到 `<target>/<packId>/rules/scripts/`；
 * - validate/inspect 会校验并展示规则包与脚本数量。
 *
 * 兼容 CONTENT-MODEL §6.1 的旧写法：
 *   node scripts/content-pack.mjs <file>                        # = validate
 *   node scripts/content-pack.mjs --pack <dir> -o <file>        # = export
 *   node scripts/content-pack.mjs --verify <file>               # 重导出并比对字节
 *
 * 校验失败退出码为 1（CI/脚本可直接判断），输出全中文错误。
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CORE_PACKS } from '../packages/content/src/index.ts';
import {
  importPackFile,
  readPackFile,
  readPackJsonFile,
  suggestedPackFileName,
  writePackFile,
} from '../packages/content/src/pack-io.ts';
import { packToTrpgpack, trpgpackToPack } from '../packages/content/src/pack-zip.ts';
import { builtinScriptSources } from '../packages/content/src/rules-pack/index.ts';

const USAGE = `内容包 CLI（M8.1）

用法：
  node scripts/content-pack.mjs validate <file.trpgpack|pack.json|目录>
  node scripts/content-pack.mjs export --pack <packId|pack.json|目录> [--out <file>] [--verify]
  node scripts/content-pack.mjs import <file.trpgpack> [--target <dir>] [--no-assets]
  node scripts/content-pack.mjs inspect <file.trpgpack|pack.json|目录>

内置包：${CORE_PACKS.map((pack) => pack.packId).join(', ')}

示例：
  node scripts/content-pack.mjs export --pack core-guimuya --out dist/core-guimuya-1.0.0.trpgpack --verify
  node scripts/content-pack.mjs validate dist/core-guimuya-1.0.0.trpgpack
  node scripts/content-pack.mjs import dist/core-guimuya-1.0.0.trpgpack --target content/packs
  node scripts/content-pack.mjs inspect dist/core-guimuya-1.0.0.trpgpack
`;

class UsageError extends Error {}

function printUsage(exitCode = 0) {
  console.log(USAGE);
  process.exitCode = exitCode;
}

function fail(message, details = []) {
  console.error(`✘ ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  process.exitCode = 1;
}

function printWarnings(warnings = []) {
  for (const warning of warnings) console.warn(`  ⚠ ${warning}`);
}

function parseArgs(list) {
  const options = { _: [] };
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg === '--') continue;
    if (arg === '--pack') options.pack = list[++index];
    else if (arg === '--out' || arg === '-o') options.out = list[++index];
    else if (arg === '--target' || arg === '-t') options.target = list[++index];
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--no-assets') options.noAssets = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new UsageError(`未知参数：${arg}`);
    else options._.push(arg);
  }
  return options;
}

/** 统一读取一个路径：目录 → 目录/pack.json；.json → 源码 JSON；其它 → .trpgpack。 */
async function loadPackFromPath(targetPath) {
  const info = await stat(targetPath).catch(() => undefined);
  if (!info) {
    return {
      ok: false,
      errors: [`路径不存在：${targetPath}`],
      warnings: [],
      assets: new Map(),
      scripts: new Map(),
      filePath: targetPath,
    };
  }
  if (info.isDirectory()) {
    return readPackJsonFile(join(targetPath, 'pack.json'), { loadAssets: true });
  }
  if (extname(targetPath).toLowerCase() === '.json') {
    return readPackJsonFile(targetPath, { loadAssets: true });
  }
  return readPackFile(targetPath);
}

function summarizeScripts(scripts) {
  if (!scripts || scripts.size === 0) return '无';
  return `${scripts.size} 个（${[...scripts.keys()].join('、')}）`;
}

function summarize(pack) {
  const gmCount = pack.lorebook.entries.filter((entry) => entry.visibility === 'gm').length;
  const rules = pack.rules
    ? `、规则包 ${pack.rules.rulesId}@${pack.rules.rulesVersion}（动作 ${pack.rules.actions.length}、物品 ${pack.rules.items?.length ?? 0}）`
    : '、无内联规则包';
  return (
    `${pack.packId} ${pack.version}「${pack.name}」` +
    `— 模组 ${pack.modules.length}、世界书 ${pack.lorebook.entries.length} 条（${gmCount} GM）、角色卡 ${pack.cards.length} 张${rules}`
  );
}

async function resolvePack(reference) {
  const builtin = CORE_PACKS.find((pack) => pack.packId === reference);
  if (builtin) {
    // 内置包：脚本源码从 `@dsh-trpg/content/rules-pack` 取（不进浏览器 bundle）
    const builtinScripts = builtin.rules ? builtinScriptSources(builtin.rules.rulesId) : undefined;
    const scripts = new Map((builtinScripts ?? []).map((source) => [source.file, source.code]));
    return {
      ok: true,
      pack: builtin,
      warnings: [],
      filePath: `<builtin:${builtin.packId}>`,
      assets: new Map(),
      scripts,
    };
  }
  const loaded = await loadPackFromPath(reference);
  if (!loaded.ok || !loaded.pack) {
    return {
      ok: false,
      errors: loaded.errors,
      warnings: loaded.warnings,
      filePath: reference,
      assets: new Map(),
      scripts: new Map(),
    };
  }
  return { ...loaded, ok: true };
}

async function commandValidate(args) {
  const options = parseArgs(args);
  if (options.help) return printUsage(0);
  const target = options._[0];
  if (!target) return printUsage(1);
  const result = await loadPackFromPath(target);
  printWarnings(result.warnings);
  if (!result.ok || !result.pack) {
    return fail(`校验失败：${target}`, result.errors);
  }
  console.log(`✔ 校验通过：${summarize(result.pack)}`);
  console.log(`  来源：${result.filePath}`);
  if (result.contentHash) console.log(`  contentHash：${result.contentHash}`);
  if (result.packHash) console.log(`  packHash：${result.packHash}`);
}

async function verifyReproducible(bytes) {
  const decoded = trpgpackToPack(bytes);
  if (!decoded.ok || !decoded.pack) {
    fail('可复现校验失败：导出的 zip 无法重新解码', decoded.errors);
    return;
  }
  const again = packToTrpgpack(decoded.pack, { assets: decoded.assets, scripts: decoded.scripts });
  if (Buffer.compare(Buffer.from(again), Buffer.from(bytes)) === 0) {
    console.log(`✔ 可复现：重导出字节一致（packHash ${decoded.packHash}）`);
  } else {
    fail('可复现校验失败：重导出字节与文件不一致（时间戳/顺序/压缩级别可能不稳定）');
  }
}

async function commandExport(argv) {
  const options = parseArgs(argv);
  if (options.help) return printUsage(0);
  const reference = options.pack ?? options._[0];
  if (!reference) return printUsage(1);
  const resolved = await resolvePack(reference);
  printWarnings(resolved.warnings);
  if (!resolved.ok || !resolved.pack) {
    return fail(`导出失败：无法加载内容包 ${reference}`, resolved.errors);
  }
  const pack = resolved.pack;
  const outPath = options.out ?? join('dist', suggestedPackFileName(pack));
  try {
    const result = await writePackFile(outPath, pack, { assets: resolved.assets, scripts: resolved.scripts });
    console.log(`✔ 已导出：${result.filePath}（${result.bytes.length} 字节）`);
    console.log(`  packId：${result.packId}  version：${result.version}`);
    console.log(`  规则脚本：${summarizeScripts(resolved.scripts)}`);
    console.log(`  contentHash：${result.contentHash}`);
    console.log(`  packHash：${result.packHash}`);
    if (options.verify) await verifyReproducible(result.bytes);
  } catch (error) {
    fail(`导出失败：${outPath}`, [error instanceof Error ? error.message : String(error)]);
  }
}

async function commandImport(args) {
  const options = parseArgs(args);
  if (options.help) return printUsage(0);
  const source = options._[0];
  if (!source) return printUsage(1);
  if (!source.toLowerCase().endsWith('.trpgpack')) {
    console.warn(`  ⚠ 文件扩展名不是 .trpgpack（仍按 ZIP 内容包解析）：${source}`);
  }
  const target = options.target ?? 'content/packs';
  const result = await importPackFile(source, target, { assets: !options.noAssets });
  printWarnings(result.warnings);
  if (!result.ok) return fail(`导入失败：${source}`, result.errors);
  console.log(`✔ 已导入：${result.packId} ${result.version} → ${result.outputDir}`);
  console.log(`  pack.json：${result.packJsonPath}`);
  console.log(`  素材：${options.noAssets ? '已跳过' : `${result.assetPaths.length} 个`}`);
  console.log(`  规则脚本：${result.scriptPaths.length} 个${result.scriptPaths.length > 0 ? `（${result.scriptPaths.join('、')}）` : ''}`);
  if (result.contentHash) console.log(`  contentHash：${result.contentHash}`);
}

async function commandInspect(args) {
  const options = parseArgs(args);
  if (options.help) return printUsage(0);
  const target = options._[0];
  if (!target) return printUsage(1);
  const result = await loadPackFromPath(target);
  if (!result.ok || !result.pack) {
    printWarnings(result.warnings);
    return fail(`无法检查（内容包不合法）：${target}`, result.errors);
  }
  printWarnings(result.warnings);
  const pack = result.pack;
  console.log(`内容包：${pack.packId} ${pack.version} — ${pack.name}`);
  console.log(`  作者：${pack.author}${pack.license ? `（${pack.license}）` : ''}`);
  console.log(`  规则系统：${pack.ruleSystem.id}（${pack.ruleSystem.name}）`);
  if (pack.rules) {
    const rules = pack.rules;
    const scriptFiles = new Set(Object.values(rules.scripts ?? {}).map((ref) => ref?.file).filter(Boolean));
    console.log(
      `  规则包：${rules.rulesId} ${rules.rulesVersion}「${rules.name}」— ` +
        `属性 ${rules.sheet.attributes.length}、技能 ${rules.sheet.skills.length}、状态 ${rules.sheet.statuses.length}、` +
        `动作 ${rules.actions.length}、公式 ${Object.keys(rules.formulas).length}、物品 ${rules.items?.length ?? 0}`,
    );
    console.log(`  规则脚本：${scriptFiles.size} 个${scriptFiles.size > 0 ? `（${[...scriptFiles].join('、')}）` : ''}`);
  } else {
    console.log('  规则包：无内联 rules 段（引用宿主内置规则）');
  }
  console.log(`  默认模组：${pack.defaultModuleId}`);
  if (pack.description) console.log(`  描述：${pack.description}`);
  for (const module of pack.modules) {
    console.log(`  模组：${module.moduleId} — ${module.title}`);
    console.log(
      `    Lv ${module.level.join('–')} / ${module.playerCount.join('–')} 人 / ${module.durationMinutes} 分钟 / 起始场景 ${module.startSceneId}`,
    );
    console.log(`    场景 ${module.scenes.length}：`);
    for (const scene of module.scenes) {
      const parts = [];
      if (scene.checks && scene.checks.length > 0) parts.push(`判定 ${scene.checks.length}`);
      if (scene.encounterIds && scene.encounterIds.length > 0) parts.push(`遭遇 ${scene.encounterIds.length}`);
      if (scene.rewardIds && scene.rewardIds.length > 0) parts.push(`奖励 ${scene.rewardIds.length}`);
      if (scene.loreIds && scene.loreIds.length > 0) parts.push(`世界书 ${scene.loreIds.length}`);
      console.log(`      - ${scene.sceneId} ${scene.title}${parts.length > 0 ? `（${parts.join('、')}）` : ''}`);
    }
    console.log(
      `    模组级：NPC ${module.npcs.length}、遭遇 ${module.encounters.length}、奖励 ${module.rewards.length}、秘密 ${module.secrets.length}`,
    );
  }
  const entries = pack.lorebook.entries;
  const gmCount = entries.filter((entry) => entry.visibility === 'gm').length;
  console.log(
    `  世界书：${pack.lorebook.lorebookId} — ${entries.length} 条（${entries.length - gmCount} 公开 / ${gmCount} GM）`,
  );
  console.log(`  角色卡：${pack.cards.length} 张`);
  for (const card of pack.cards) {
    console.log(
      `    - ${card.cardId} ${card.identity.name}（${card.identity.race} ${card.identity.class} Lv${card.identity.level}）`,
    );
  }
  const assets = result.assets ?? new Map();
  let assetBytes = 0;
  for (const data of assets.values()) assetBytes += data.length;
  const assetNames = assets.size > 0 ? [...assets.keys()] : (result.assetPaths ?? []);
  console.log(`  素材：${assetNames.length} 个${assetBytes > 0 ? `（${assetBytes} 字节）` : ''}`);
  const scripts = result.scripts ?? new Map();
  const scriptNames = scripts.size > 0 ? [...scripts.keys()] : (result.scriptPaths ?? []);
  let scriptBytes = 0;
  for (const data of scripts.values()) scriptBytes += data.length;
  console.log(`  规则脚本条目：${scriptNames.length} 个${scriptBytes > 0 ? `（${scriptBytes} 字节）` : ''}`);
  if (pack.icon) console.log(`  图标：${pack.icon}`);
  if (result.contentHash) console.log(`  contentHash：${result.contentHash}`);
  if (result.packHash) console.log(`  packHash：${result.packHash}`);
  console.log(`  来源：${result.filePath}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const [firstArg, ...rest] = argv;
  const command = firstArg === '--' ? rest.shift() : firstArg;
  if (!command || command === '--help' || command === '-h' || command === 'help') return printUsage(0);
  if (command === 'validate') return commandValidate(rest);
  if (command === 'export') return commandExport(rest);
  if (command === 'import') return commandImport(rest);
  if (command === 'inspect') return commandInspect(rest);
  if (command === '--pack' || command === '-o' || command === '--out') return commandExport(argv);
  if (command === '--verify') {
    const source = rest[0];
    if (!source) return printUsage(1);
    const info = await stat(source).catch(() => undefined);
    if (!info) return fail(`文件不存在：${source}`);
    await verifyReproducible(new Uint8Array(await readFile(source)));
    return undefined;
  }
  if (!command.startsWith('-')) return commandValidate(argv);
  return printUsage(1);
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    fail(error.message);
    printUsage(1);
  } else {
    fail(`内容包 CLI 出错：${error instanceof Error ? error.message : String(error)}`);
    if (process.env.DSH_TRPG_DEBUG) console.error(error);
  }
}
