/**
 * 内置示例规则包头（Node 侧入口，**不从 `@dsh-trpg/content` 主入口 re-export**）。
 *
 * 为什么单独一个入口：本模块会带出规则脚本源码（`script-sources.ts`），而内容包主入口
 * 会被打进浏览器 client bundle；docs/RULES-MODEL §8 要求玩家端构建产物不含规则脚本。
 * 宿主 / CLI / 测试需要脚本源码时从这里导入。
 */
import type { RulePack, ScriptRef } from '../rules-bridge.ts';
import type { PackScriptSource } from '../pack-scripts.ts';
import { DND5E_LITE_RULES, DND5E_LITE_RULES_ID, DND5E_LITE_SCRIPT_REFS } from './dnd5e-lite/rules.ts';
import { DND5E_LITE_SCRIPT_SOURCES } from './dnd5e-lite/script-sources.ts';

export {
  DND5E_LITE_ITEMS,
  DND5E_LITE_RULES,
  DND5E_LITE_RULES_ID,
  DND5E_LITE_RULES_NAME,
  DND5E_LITE_RULES_VERSION,
  DND5E_LITE_SCRIPT_REFS,
} from './dnd5e-lite/rules.ts';
export {
  DND5E_LITE_SCRIPT_FILES,
  DND5E_LITE_SCRIPT_HASH_BY_FILE,
  dnd5eScriptRef,
  type Dnd5eLiteScriptKey,
} from './dnd5e-lite/script-hashes.ts';
export {
  DND5E_LITE_SCRIPT_CODE_BY_FILE,
  DND5E_LITE_SCRIPT_SOURCES,
  type Dnd5eLiteScriptSource,
} from './dnd5e-lite/script-sources.ts';

/** 内置规则包注册表（按 `rulesId` 查脚本源码，导出内置内容包时用）。 */
export const BUILTIN_RULES_SCRIPTS: Readonly<Record<string, readonly PackScriptSource[]>> = {
  [DND5E_LITE_RULES_ID]: DND5E_LITE_SCRIPT_SOURCES,
};

/** 按 `rulesId` 取内置规则脚本源码；没有内置脚本时返回 undefined。 */
export function builtinScriptSources(rulesId: string): readonly PackScriptSource[] | undefined {
  return BUILTIN_RULES_SCRIPTS[rulesId];
}

/** 按规则包取内置规则脚本源码（`pack.rules` 来自内容包）。 */
export function scriptSourcesForRules(rules: RulePack | undefined): readonly PackScriptSource[] | undefined {
  if (rules === undefined) return undefined;
  return builtinScriptSources(rules.rulesId);
}

/** 内置规则包脚本引用（`{ file, sha256 }`；写包清单/对照测试用）。 */
export function builtinScriptRefsForRules(rules: RulePack | undefined): readonly ScriptRef[] {
  if (rules === undefined || rules.rulesId !== DND5E_LITE_RULES_ID) return [];
  return DND5E_LITE_SCRIPT_REFS;
}
