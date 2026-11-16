/**
 * 内容包入口：规则数据 + 预制角色卡 + 世界书 + 首个模组。
 *
 * M8 起三块内容统一为「内容包（Content Pack）」，源码 JSON 在
 * `cards/`、`modules/`、`lorebooks/`，由 `packs/core-guimuya.ts` 组装成内置包
 * `CORE_GUIMUYA_PACK`；本文件再通过 D12 适配函数反推出旧的 `CARDS` / `GUIMUYA_MODULE` /
 * `GUIMUYA_LOREBOOK`，保证宿主与既有测试的导入形状不变。
 *
 * 注意：zip 编解码（`pack-zip.ts` / `zip.ts`）与文件读写（`pack-io.ts`）包含 node:zlib /
 * node:crypto / node:fs，**不从这里导出**，以免被打进浏览器 bundle；host 侧请从
 * `@dsh-trpg/content/pack-zip`、`@dsh-trpg/content/pack-io` 子路径导入。
 */
import type { CharacterCard } from '@dsh-trpg/engine';
import type { LorebookDef, ModuleDef } from './schema.ts';
import {
  toCharacterCard,
  toLegacyLorebook,
  toLegacyModuleDef,
  type PackModuleDef,
} from './pack.ts';
import { CORE_GUIMUYA_PACK } from './packs/core-guimuya.ts';

export * from './schema.ts';
export * from './pack.ts';
export * from './asset-manifest.ts';
export * from './rule-system.ts';
export * from './packs/core-guimuya.ts';
export { RACES } from './rules/races.ts';
export { CLASSES } from './rules/classes.ts';
export { SPELLS, SPELL_BY_ID } from './rules/spells.ts';
export { MONSTERS } from './rules/monsters.ts';
export { ITEMS } from './rules/items.ts';

/** 内置包唯一模组（`modules[0]`；v1 包恒为 1 个模组）。 */
function coreModule(): PackModuleDef {
  const module = CORE_GUIMUYA_PACK.modules[0];
  if (!module) throw new Error('内置包 core-guimuya 缺少模组（modules 为空）');
  return module;
}

/** 预制角色卡（4 张，对应 v1 的四个职业）。owner 未分配，进房时由服务端绑定玩家。 */
export const CARDS: CharacterCard[] = CORE_GUIMUYA_PACK.cards.map((card) => toCharacterCard(card));

/** 旧文档里的别名（CONTENT-MODEL §9 兼容导出）；与 `CARDS` 同一数组。 */
export const PRESET_CARDS: CharacterCard[] = CARDS;

/** 首个原创模组「鬼木崖·异光」（旧 `ModuleDef` 形状，由 pack 反推）。 */
export const GUIMUYA_MODULE: ModuleDef = toLegacyModuleDef(coreModule(), CORE_GUIMUYA_PACK.ruleSystem);

/** 模组配套世界书（旧 `LorebookDef` 形状，由 pack 反推）。 */
export const GUIMUYA_LOREBOOK: LorebookDef = toLegacyLorebook(CORE_GUIMUYA_PACK.lorebook);

export const CONTENT_VERSION = '0.1.0';
