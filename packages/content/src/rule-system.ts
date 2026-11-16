/**
 * 规则系统标识（内容包只引用规则，不内联规则数据，见 CONTENT-MODEL §2.4）。
 *
 * 规则数据（种族/职业/法术/怪物/物品）留在 `rules/*.ts`；pack.json 里只写
 * `ruleSystem: { id, name }`，这样同一个包可以按规则系统装到不同规则实现上。
 */
import type { PackRuleSystem } from './pack.ts';

export const RULE_ID = 'dnd5e-lite';
export const RULE_VERSION = '1.0';
export const RULE_SYSTEM_NAME = 'D&D 5e-lite';

/** 内置内容包使用的规则系统引用。 */
export const RULE_SYSTEM: PackRuleSystem = { id: RULE_ID, name: RULE_SYSTEM_NAME };
