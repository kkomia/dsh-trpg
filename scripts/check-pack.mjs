/**
 * 发布前校验 `pnpm pack:plugin` 产出的 tgz 内容（0.1.0 发布检查表用）。
 *
 * 用法：
 *   node scripts/check-pack.mjs                 # 检查 dist/dsh-trpg-table-<包版本>.tgz
 *   node scripts/check-pack.mjs <tgz 路径>      # 检查指定 tgz
 *
 * 纯 Node 实现（node:zlib + 手写 tar 头解析），不依赖 tar/npm 命令；退出码 0 = 通过。
 *
 * 断言：
 *   1. 必备条目存在（host/client/locale/icon/patch/README/docs/LICENSE/package.json）；
 *   2. 不含开发产物（src、test、scripts、node_modules、.tmp、tsconfig、lock 等）；
 *   3. 包内 package.json 的 version 与文件名一致、license=MIT、dsh.bundle.patch 可解析。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'packages', 'dsh-trpg-table');
const pluginPkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
const tgz = process.argv[2] ?? join(root, 'dist', `dsh-trpg-table-${pluginPkg.version}.tgz`);

/** 期望存在的条目（相对 tar 根，`package/` 前缀）。 */
const REQUIRED = [
  'package/package.json',
  'package/lib/host.js',
  'package/lib/client.js',
  'package/locale/zh.json',
  'package/locale/en.json',
  'package/icon.svg',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/docs/DETAIL.md',
  'package/LICENSE',
];

/** 不得出现的条目（匹配包内相对路径）。 */
const FORBIDDEN = [
  { test: (p) => /(^|\/)(src|test|tests|scripts|node_modules|\.tmp|\.git|dist)\//.test(p), why: '开发目录不应打包' },
  { test: (p) => /\.test\.(ts|mjs|js)$/.test(p), why: '测试文件不应打包' },
  { test: (p) => /(^|\/)(tsconfig\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(p), why: '构建配置不应打包' },
  { test: (p) => /\.tgz$/.test(p), why: '不应嵌套 tgz' },
];

/** 解析 tar 八进制字段。 */
function octal(buf, start, length) {
  return parseInt(buf.slice(start, start + length).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
}

/**
 * 解包 gzip+tar，返回条目列表（name/size/data）。
 * 支持 ustar prefix、PAX 扩展头（typeflag 'x'）与 GNU 长文件名（typeflag 'L'）。
 * @param {Buffer} gz - tgz 字节。
 */
function parseTar(gz) {
  const buf = gunzipSync(gz);
  const entries = [];
  let offset = 0;
  let longName;
  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      offset += 512;
      continue;
    }
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
    let name = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (prefix.length > 0) name = `${prefix}/${name}`;
    const dataStart = offset + 512;
    const data = buf.slice(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      for (const line of data.toString('utf8').split('\n')) {
        if (/^\d+ path=/.test(line)) name = line.replace(/^\d+ path=/, '');
      }
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (longName !== undefined) {
      name = longName;
      longName = undefined;
    }
    if (type !== '0' && type !== '\0' && type !== '5') continue; // 跳过目录/链接/元数据
    if (name.endsWith('/')) continue;
    entries.push({ name, size, data });
  }
  return entries;
}

function fail(message) {
  console.error(`[check-pack] ✗ ${message}`);
  process.exitCode = 1;
}

function main() {
  if (!existsSync(tgz)) {
    console.error(`[check-pack] 找不到 tgz：${tgz}\n[check-pack] 先运行 node scripts/build.mjs && node scripts/pack-plugin.mjs（或 pnpm pack:plugin）`);
    process.exit(1);
  }
  const raw = readFileSync(tgz);
  const entries = parseTar(raw);
  const files = new Map(entries.map((entry) => [entry.name, entry.size]));
  const rel = (name) => name.replace(/^package\//, '');
  const totalSize = [...files.values()].reduce((sum, size) => sum + size, 0);
  const sizeKb = (statSync(tgz).size / 1024).toFixed(0);

  console.log(`[check-pack] tgz：${tgz}`);
  console.log(`[check-pack] 压缩 ${sizeKb} KB / 解包 ${(totalSize / 1024).toFixed(0)} KB / ${files.size} 个文件`);
  console.log('');
  for (const [name, size] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${String((size / 1024).toFixed(1)).padStart(7)} KB  ${name}`);
  }
  console.log('');

  let issues = 0;
  for (const required of REQUIRED) {
    if (!files.has(required)) {
      issues += 1;
      fail(`缺少必备条目：${required}`);
    }
  }
  for (const name of files.keys()) {
    const path = rel(name);
    for (const rule of FORBIDDEN) {
      if (rule.test(path)) {
        issues += 1;
        fail(`不应打包：${name}（${rule.why}）`);
      }
    }
  }

  const pkgEntry = entries.find((entry) => entry.name === 'package/package.json');
  if (pkgEntry !== undefined) {
    let packed;
    try {
      packed = JSON.parse(pkgEntry.data.toString('utf8'));
    } catch (error) {
      issues += 1;
      fail(`包内 package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (packed !== undefined) {
      const expectedVersion = `dsh-trpg-table-${pluginPkg.version}.tgz`;
      if (!tgz.endsWith(expectedVersion)) {
        issues += 1;
        fail(`tgz 文件名与版本不一致：期望 ${expectedVersion}，实际 ${tgz}`);
      }
      if (packed.version !== pluginPkg.version) {
        issues += 1;
        fail(`包内 version=${packed.version} 与源码 version=${pluginPkg.version} 不一致`);
      }
      if (packed.license !== 'MIT') {
        issues += 1;
        fail(`包内 license=${packed.license}，期望 MIT`);
      }
      if (packed.dsh?.bundle?.patch !== './cordis.patch.yml') {
        issues += 1;
        fail('包内 dsh.bundle.patch 缺失或不是 ./cordis.patch.yml');
      }
      if (!files.has('package/cordis.patch.yml')) {
        issues += 1;
        fail('dsh.bundle.patch 指向 cordis.patch.yml，但文件未打包');
      }
      if (packed.dsh?.client?.inject === undefined) {
        issues += 1;
        fail('dsh.client.inject 缺失（插件 client 半边需要声明会话 UI 依赖）');
      }
    }
  }

  if (issues > 0) {
    console.error(`\n[check-pack] ✗ ${issues} 项不符合发布要求`);
    process.exitCode = 1;
    return;
  }
  console.log('[check-pack] ✓ 内容符合发布要求（必备条目齐全、无开发产物、版本/许可证/patch 一致）');
}

main();
