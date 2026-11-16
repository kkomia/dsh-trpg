/**
 * `@dsh-trpg/rules` 公共入口（M9.1 纯库）。
 *
 * - 类型与常量：`./types.ts`（规则包 trpg.rules/1、卡实例 trpg.card/1、投影 DTO）
 * - 受限公式：`./formula.ts`（词法/递归下降/求值；禁止 eval/Function/vm）
 * - 规则包校验：`./validate-rules.ts`（结构 + 引用完整性 + 场地/时间/行动经济）
 * - 卡：`./sheet.ts`（validateCard / buildSheetProjection / 词条聚合）
 * - 旧卡迁移：`./migrate.ts`
 * - 测试样例：`./fixtures.ts`
 *
 * M9.2 接入建议：核心运行时用 compileFormula/evaluateFormula + buildSheetProjection；
 * 沙箱/钩子调度/回合推进不在此包。
 */
export * from './types.ts';
export * from './formula.ts';
export * from './validate-rules.ts';
export * from './sheet.ts';
export * from './migrate.ts';
export * from './fixtures.ts';
