/**
 * dnd5e-lite 规则包的脚本清单（路径 + sha256），只依赖预计算的哈希常量。
 *
 * `rules.ts` 从这里取 `scripts` 段；因为本模块只读 `DND5E_LITE_SCRIPT_HASHES`（字面量），
 * 脚本源码常量不会随 client bundle 一起被打包（构建后用 `scripts/build.mjs` 检查产物可验证）。
 */
import { DND5E_LITE_SCRIPT_HASHES } from './scripts.embedded.ts';
import type { ScriptRef } from '../../rules-bridge.ts';

/** 四个脚本文件在 zip / 源码目录里的路径（与 `scripts/*.js` 文件名一一对应）。 */
export const DND5E_LITE_SCRIPT_FILES = {
  sheet: 'rules/scripts/sheet.js',
  combat: 'rules/scripts/combat.js',
  events: 'rules/scripts/events.js',
  progression: 'rules/scripts/progression.js',
} as const;

export type Dnd5eLiteScriptKey = keyof typeof DND5E_LITE_SCRIPT_FILES;

/** 取一个脚本的 `{ file, sha256 }` 引用；哈希表由 `scripts/embed-dnd5e-scripts.mjs` 生成。 */
export function dnd5eScriptRef(file: string): ScriptRef {
  const sha256 = DND5E_LITE_SCRIPT_HASHES[file];
  if (sha256 === undefined) {
    throw new Error(`dnd5e-lite 规则包没有脚本「${file}」的 sha256（请重新运行 scripts/embed-dnd5e-scripts.mjs）`);
  }
  return { file, sha256 };
}

/** 脚本路径 → sha256（只读副本，供测试/工具比对）。 */
export const DND5E_LITE_SCRIPT_HASH_BY_FILE: Readonly<Record<string, string>> = { ...DND5E_LITE_SCRIPT_HASHES };
