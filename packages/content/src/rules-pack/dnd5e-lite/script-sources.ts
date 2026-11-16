/**
 * dnd5e-lite 规则包的脚本**源码**（`{ file, code, sha256 }`），供宿主/CLI/测试读取。
 *
 * 只在 Node 侧使用（`scripts/content-pack.mjs` 导出内置包、pack 测试、数值对照测试）；
 * 浏览器 client bundle 不 import 本模块（content 的主入口不 re-export 它），
 * 因此脚本源码不会进玩家端构建产物。
 */
import { DND5E_LITE_SCRIPT_CODES } from './scripts.embedded.ts';
import { DND5E_LITE_SCRIPT_FILES, DND5E_LITE_SCRIPT_HASH_BY_FILE, type Dnd5eLiteScriptKey } from './script-hashes.ts';
import type { PackScriptSource } from '../../pack-scripts.ts';

/** 一条已生成的脚本来源：路径 + 源码 + **必有的** sha256（可直接当运行时 `ScriptSourceInput` 用）。 */
export interface Dnd5eLiteScriptSource extends PackScriptSource {
  sha256: string;
}

/** 四个脚本的 `{ file, code, sha256 }` 列表（顺序与 `DND5E_LITE_SCRIPT_FILES` 一致）。 */
export const DND5E_LITE_SCRIPT_SOURCES: readonly Dnd5eLiteScriptSource[] = (
  Object.keys(DND5E_LITE_SCRIPT_FILES) as Dnd5eLiteScriptKey[]
).map((key) => {
  const file = DND5E_LITE_SCRIPT_FILES[key];
  const code = DND5E_LITE_SCRIPT_CODES[file];
  const sha256 = DND5E_LITE_SCRIPT_HASH_BY_FILE[file];
  if (code === undefined || sha256 === undefined) {
    throw new Error(`dnd5e-lite 规则包缺少脚本源码或哈希：${file}（请重新运行 scripts/embed-dnd5e-scripts.mjs）`);
  }
  return { file, code, sha256 };
});

/** 脚本路径 → 源码（只读）。 */
export const DND5E_LITE_SCRIPT_CODE_BY_FILE: Readonly<Record<string, string>> = { ...DND5E_LITE_SCRIPT_CODES };
