/**
 * 打包可安装的 DSH 插件 tgz（M5）。
 *
 * 用法：node scripts/pack-plugin.mjs
 * 产物：dist/dsh-trpg-table-<version>.tgz
 *
 * 打包用 DSH 自带的 pnpm（无需全局 node/pnpm）：脚本会从 DSH 运行时目录
 * 里找 pnpm.mjs，用当前 node 执行 `pnpm pack`。朋友们在 DSH「插件 → 添加插件」
 * 里粘贴本地文件路径或收到这个 tgz 即可安装。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'packages', 'dsh-trpg-table');
const distDir = join(root, 'dist');
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');

function findPnpm() {
  const candidates = [];
  const runtimes = join(dshHome, 'dsh-runtimes');
  if (existsSync(runtimes)) {
    for (const name of readdirSync(runtimes)) {
      candidates.push(join(runtimes, name, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'));
    }
  }
  if (process.env.DSH_PNPM) candidates.unshift(process.env.DSH_PNPM);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('找不到 DSH 自带的 pnpm；可设置 DSH_PNPM=<pnpm.mjs 路径> 重试');
  return found;
}

function main() {
  const version = JSON.parse(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', join(pluginDir, 'package.json')], {
    encoding: 'utf8',
  })).version;
  mkdirSync(distDir, { recursive: true });
  const pnpm = findPnpm();
  console.log(`[pack] pnpm: ${pnpm}`);
  console.log(`[pack] packing dsh-trpg-table@${version} → dist/`);
  execFileSync(process.execPath, [pnpm, 'pack', '--pack-destination', distDir], {
    cwd: pluginDir,
    stdio: 'inherit',
  });
  const tgz = join(distDir, `dsh-trpg-table-${version}.tgz`);
  if (!existsSync(tgz)) throw new Error(`打包未生成预期文件：${tgz}`);
  console.log(`[pack] OK ${tgz} (${(statSync(tgz).size / 1024).toFixed(0)} KB)`);
  console.log('[pack] 朋友安装：DSH → 插件 → 添加插件（本地 tgz），或 `dsh plugin add <tgz 路径>`');
}

main();
