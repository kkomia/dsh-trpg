#!/usr/bin/env node
/**
 * DiceFrame 角色卡 → 内部卡 JSON 转换 CLI（M8.5a 可选工具）。
 *
 * 用法：
 *   node scripts/import-diceframe-card.mjs <diceframe-card.json> [--rules <trpg.rules/1.json>] [--out <card.json>]
 *   node scripts/import-diceframe-card.mjs <card.json> --lite        # 显式指定内置 dnd5e-lite（默认也是它）
 *
 * 做了什么：读 JSON → `isDiceFrameCard` 版本/特征守卫 → `adaptDiceFrameCard`
 * （`validateCard` 兜底）→ 输出 `trpg.card/1` 内部卡 JSON（含 `origin: diceframe:<rule_id>` 与稳定
 * `diceframe-<hash>` cardId）。warnings 走 stderr，不污染 stdout 的卡 JSON（便于管道）。
 *
 * 退出码：0 = 成功；1 = 适配失败/文件或参数错误。零新依赖（Node 24 直接跑 TS 源码）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { diceFrameToRulesCardJson } from '../packages/rules/src/adapters/diceframe.ts';
import { validateRulePack } from '../packages/rules/src/validate-rules.ts';
import { DND5E_LITE_RULES } from '../packages/content/src/rules-pack/dnd5e-lite/rules.ts';

const USAGE = `DiceFrame 角色卡转换（M8.5a）

用法：
  node scripts/import-diceframe-card.mjs <diceframe-card.json> [--rules <trpg.rules/1.json>] [--out <card.json>]

选项：
  --rules <file>  目标规则包 JSON（trpg.rules/1）；缺省用内置 dnd5e-lite
  --lite          显式使用内置 dnd5e-lite
  --out <file>    输出内部卡 JSON；缺省写 stdout
  -h, --help      显示本帮助
`;

function fail(message) {
  console.error(`✘ ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--rules') options.rules = argv[++index];
    else if (arg === '--out' || arg === '-o') options.out = argv[++index];
    else if (arg === '--lite') options.lite = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`未知选项：${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${label}读取失败：${path}（${error.message}）`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${path}（${error.message}）`);
  }
}

async function loadRules(options) {
  if (options.rules === undefined) return { pack: DND5E_LITE_RULES, source: '内置 dnd5e-lite' };
  const raw = await readJson(options.rules, '规则包');
  const validated = validateRulePack(raw);
  if (!validated.ok || validated.value === undefined) {
    throw new Error(`规则包校验失败：\n- ${validated.errors.join('\n- ')}`);
  }
  for (const warning of validated.warnings) console.warn(`  ⚠ 规则包：${warning}`);
  return { pack: validated.value, source: options.rules };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true || options.positional.length === 0) {
    console.log(USAGE);
    process.exitCode = options.help === true ? 0 : 1;
    return;
  }
  const inputPath = options.positional[0];
  const raw = await readJson(inputPath, 'DiceFrame 卡');
  const { pack, source } = await loadRules(options);
  const result = diceFrameToRulesCardJson(raw, pack);
  if (!result.ok) {
    fail(`适配失败（${result.errors.length} 个问题）：`);
    for (const error of result.errors) console.error(`  - ${error}`);
    for (const warning of result.warnings) console.warn(`  ⚠ ${warning}`);
    return;
  }
  for (const warning of result.warnings) console.warn(`  ⚠ ${warning}`);
  if (result.personalLore.length > 0) {
    console.warn(`  ℹ 随卡世界书 ${result.personalLore.length} 条没有写入卡，需另走世界书导入流程`);
  }
  const outputPath = options.out !== undefined ? resolve(options.out) : undefined;
  if (outputPath === undefined) {
    process.stdout.write(result.json);
    return;
  }
  await writeFile(outputPath, result.json, 'utf8');
  console.log(`✔ 已转换：${resolve(inputPath)} → ${outputPath}`);
  console.log(`  规则包：${source}（${pack.rulesId}@${pack.rulesVersion}）`);
  console.log(`  内部 cardId：${result.card.cardId}；warning ${result.warnings.length} 条`);
}

main().catch((error) => fail(error.message));
