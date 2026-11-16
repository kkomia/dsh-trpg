/**
 * 跨包边界：内容包只依赖 `@dsh-trpg/rules` 的**纯数据层**（类型 + 规则包校验），
 * 不经过它的主入口。
 *
 * 为什么不用 `import { validateRulePack } from '@dsh-trpg/rules'`：rules 包主入口
 * `export * from './runtime/index.ts'` 会把 `node:vm` / `node:crypto` 的脚本沙箱与种子骰
 * 一起拉进来，而 `@dsh-trpg/content` 会被打进浏览器 client bundle（`scripts/build.mjs`
 * 的 client 半边 import 了 `@dsh-trpg/content`），node: 内置模块在浏览器里解析失败。
 * 这里用仓库内相对路径直接引纯模块，等价于「rules 包的 schema 子路径导出」；
 * 若将来在 rules 的 package.json 里补 `./schema` 子路径导出，可替换成包名导入。
 */
export {
  RULE_PACK_SCHEMA_VERSION,
  SHA256_PATTERN,
  SCRIPT_PATH_PREFIX,
  type ActionDef,
  type CardInstance,
  type CardSkillState,
  type CardStatusState,
  type EquipmentDef,
  type EquipmentInstanceDef,
  type FieldDef,
  type HookName,
  type RulePack,
  type RulePackItemDef,
  type RulePackScripts,
  type ScriptRef,
  type SheetDef,
  type SkillDef,
  type StatusDef,
  type ValidateResult,
} from '../../rules/src/types.ts';

export { validateRulePack, type ValidateRulePackOptions } from '../../rules/src/validate-rules.ts';
