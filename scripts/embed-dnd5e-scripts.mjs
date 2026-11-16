#!/usr/bin/env node
/**
 * 把 dnd5e-lite 规则脚本内联成 TS 字符串常量（维护用生成器，构建时不需要跑）。
 *
 * 为什么需要它：`@dsh-trpg/content` 会被打进浏览器 client bundle，不能 import `node:fs`
 * 去读 `rules/scripts/*.js`；而脚本又必须是**独立文件**（docs/RULES-MODEL §3/§10：
 * `pack.rules.scripts` 只记 file+sha256，zip 内 `rules/scripts/*.js` 是独立条目）。
 * 所以源码真相留在 `scripts/*.js`，本脚本把它们与预计算 sha256 内联到 `scripts.embedded.ts` 并提交：
 * 运行时不读文件、不重新计算；只有改脚本时手动重跑本生成器。
 *
 * 用法：
 *   node scripts/embed-dnd5e-scripts.mjs            # 重新生成 scripts.embedded.ts
 *   node scripts/embed-dnd5e-scripts.mjs --check    # 只比对（CI/维护用），不一致退出码 1
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../packages/content/src/sha256.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packDir = join(root, 'packages', 'content', 'src', 'rules-pack', 'dnd5e-lite');
const scriptsDir = join(packDir, 'scripts');
const outputPath = join(packDir, 'scripts.embedded.ts');

/** 4 个脚本文件 → 必须导出的钩子（漏导出会让 rules.scripts 引用的钩子缺失）。 */
const SCRIPTS = [
  { name: 'sheet.js', constName: 'DND5E_LITE_SHEET_JS', hooks: ['validateSheet', 'computeDerived'] },
  { name: 'combat.js', constName: 'DND5E_LITE_COMBAT_JS', hooks: ['resolveCheck', 'resolveAttack', 'resolveDamage'] },
  { name: 'events.js', constName: 'DND5E_LITE_EVENTS_JS', hooks: ['onEvent'] },
  { name: 'progression.js', constName: 'DND5E_LITE_PROGRESSION_JS', hooks: ['onLevelUp', 'generateLoot'] },
];

/** §6 沙箱：脚本里不许出现的东西（生成期硬闸，避免把危险代码带进规则包）。 */
const FORBIDDEN = [
  { pattern: /\brequire\s*\(/u, reason: '不允许 require()（沙箱不提供）' },
  { pattern: /^\s*import\s+/mu, reason: '不允许 import（脚本是 CommonJS 模块）' },
  { pattern: /\bprocess\s*\./u, reason: '不允许 process（沙箱不提供）' },
  { pattern: /\bnew\s+Date\b/u, reason: '不允许 Date（不读系统时钟）' },
  { pattern: /\bDate\s*\.\s*now/u, reason: '不允许 Date.now（不读系统时钟）' },
  { pattern: /Math\s*\.\s*random/u, reason: '不允许 Math.random（随机只能 ctx.roll / ctx.rng）' },
  { pattern: /\beval\s*\(/u, reason: '不允许 eval' },
  { pattern: /\bnew\s+Function\b/u, reason: '不允许 new Function' },
  { pattern: /\bglobalThis\b/u, reason: '不允许访问 globalThis' },
];

/** 统一换行（CRLF → LF）并保证文件以单个换行结尾，保证 sha256 跨平台稳定。 */
function normalizeSource(text) {
  const unified = text.replace(/\r\n?/gu, '\n');
  return unified.endsWith('\n') ? unified : `${unified}\n`;
}

/**
 * 去掉注释后再做禁词检查：脚本头部注释会解释「不要用 Math.random / Date」，
 * 那是文档不是代码。只剥块注释与行首 `//`（字符串里出现 // 的情况本仓库脚本没有）。
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/^[ \t]*\/\/[^\n]*/gmu, ' ');
}

function emitStringConst(constName, code) {
  // 单个 JSON 字符串字面量（而不是 [..].join('\n')）：顶层初始化没有函数调用，
  // esbuild 才能把它当无副作用代码裁掉，避免脚本源码被拖进 client bundle。
  return `export const ${constName} = ${JSON.stringify(code)};\n`;
}

async function build() {
  const entries = [];
  for (const script of SCRIPTS) {
    const sourcePath = join(scriptsDir, script.name);
    const raw = await readFile(sourcePath, 'utf8');
    const code = normalizeSource(raw);
    const codeWithoutComments = stripComments(code);
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(codeWithoutComments)) {
        throw new Error(`${script.name}: ${rule.reason}`);
      }
    }
    for (const hook of script.hooks) {
      if (!code.includes(`${hook}: ${hook}`)) {
        throw new Error(`${script.name}: 没有按「${hook}: ${hook}」导出钩子（module.exports 的键必须与钩子同名）`);
      }
    }
    entries.push({ ...script, code, sha256: sha256Hex(code), file: `rules/scripts/${script.name}` });
  }

  const lines = [];
  lines.push('/* 由 scripts/embed-dnd5e-scripts.mjs 生成 —— 请勿手改。 */');
  lines.push('/**');
  lines.push(' * dnd5e-lite 规则脚本的源码与 sha256（内联常量）。');
  lines.push(' *');
  lines.push(' * 源码唯一真相：packages/content/src/rules-pack/dnd5e-lite/scripts/*.js');
  lines.push(' * 重新生成：node scripts/embed-dnd5e-scripts.mjs');
  lines.push(' *');
  lines.push(' * 为什么内联：content 会被打进浏览器 client bundle，不能 import node:fs 读脚本文件；');
  lines.push(' * sha256 预计算成字面量，rules.ts 只引用哈希表，脚本代码常量不会被 client bundle 拖进去。');
  lines.push(' */');
  lines.push('');
  for (const entry of entries) {
    lines.push(emitStringConst(entry.constName, entry.code));
  }
  lines.push('/** 脚本路径 → 源码（`rules/scripts/*.js`，与 zip 条目路径一致）。 */');
  lines.push('export const DND5E_LITE_SCRIPT_CODES: Readonly<Record<string, string>> = {');
  for (const entry of entries) lines.push(`  '${entry.file}': ${entry.constName},`);
  lines.push('};');
  lines.push('');
  lines.push('/** 脚本路径 → sha256（生成期按源码计算，供 rules.scripts 清单与导入校验使用）。 */');
  lines.push('export const DND5E_LITE_SCRIPT_HASHES: Readonly<Record<string, string>> = {');
  for (const entry of entries) lines.push(`  '${entry.file}': '${entry.sha256}',`);
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

const expected = await build();

if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8').catch(() => '');
  if (existing !== expected) {
    console.error('✘ scripts.embedded.ts 与 scripts/*.js 不一致，请运行：node scripts/embed-dnd5e-scripts.mjs');
    process.exitCode = 1;
  } else {
    console.log('✔ scripts.embedded.ts 与 scripts/*.js 一致');
  }
} else {
  await writeFile(outputPath, expected, 'utf8');
  const hashes = [...expected.matchAll(/'rules\/scripts\/[a-z]+\.js': '([a-f0-9]{64})'/gu)].map((match) => match[1]);
  console.log(`✔ 已生成 ${outputPath}`);
  for (const hash of hashes) console.log(`  sha256 ${hash}`);
}
