/**
 * 内置内容包 `core-guimuya`（鬼木崖·异光，1.0.0）。
 *
 * 由仓库里现有的源码内容组装（4 张预制卡、`modules/guimuya.json`、`lorebooks/guimuya.json`）：
 * 走 `migratePack()` 一次性迁移到 `trpg.pack/1`（`id → *Id`、场景内联遭遇/奖励上移、
 * `scene.lore → scene.loreIds` 等），再用 `assertContentPack()` 兜底校验 —— 内容写坏了会
 * 在 import 时就抛带全部中文错误的异常，而不是运行时静默失效。
 *
 * M9.3 起包内带 `rules` 段（`DND5E_LITE_RULES`）：规则数据内联在 `pack.json`，
 * 规则脚本仍是独立 zip 条目 `rules/scripts/*.js`（`pack.rules.scripts` 只记 file+sha256）。
 *
 * 注意：本模块**不 import 脚本源码**——它会被打进浏览器 client bundle（client 只用包元数据/卡），
 * 脚本源码只在 Node 侧（`@dsh-trpg/content/rules-pack`、`scripts/content-pack.mjs`、测试）读取。
 * 因此内置包在这里只做「规则数据段」的结构校验；脚本 sha256 完整性在**导出/导入/加载**时校验
 * （`packToTrpgpack` / `trpgpackToPack` / `readPackJsonFile` 都会带上脚本条目）。
 */
import aqingCard from '../../cards/aqing.json' with { type: 'json' };
import bailuCard from '../../cards/bailu.json' with { type: 'json' };
import xuanzhenCard from '../../cards/xuanzhen.json' with { type: 'json' };
import sujiuCard from '../../cards/sujiu.json' with { type: 'json' };
import guimuyaLorebook from '../../lorebooks/guimuya.json' with { type: 'json' };
import guimuyaModule from '../../modules/guimuya.json' with { type: 'json' };
import { assertContentPack, migratePack, type ContentPack } from '../pack.ts';
import { RULE_SYSTEM } from '../rule-system.ts';
import { DND5E_LITE_RULES } from '../rules-pack/dnd5e-lite/rules.ts';

export const CORE_GUIMUYA_PACK_ID = 'core-guimuya';
export const CORE_GUIMUYA_PACK_VERSION = '1.0.0';
export const CORE_GUIMUYA_PACK_NAME = '鬼木崖·异光';
export const CORE_GUIMUYA_PACK_AUTHOR = 'dsh-trpg contributors';
export const CORE_GUIMUYA_MODULE_ID = 'guimuya';

const legacyBundle = {
  packId: CORE_GUIMUYA_PACK_ID,
  name: CORE_GUIMUYA_PACK_NAME,
  version: CORE_GUIMUYA_PACK_VERSION,
  author: CORE_GUIMUYA_PACK_AUTHOR,
  description: '45 分钟中式奇幻短模组：接悬赏 → 探古洞 → 破邪阵。',
  license: 'MIT',
  ruleSystem: RULE_SYSTEM,
  defaultModuleId: CORE_GUIMUYA_MODULE_ID,
  modules: [guimuyaModule],
  lorebook: guimuyaLorebook,
  cards: [aqingCard, bailuCard, xuanzhenCard, sujiuCard],
};

const migration = migratePack(legacyBundle);

/** 迁移过程发现的可读提示（作者可据此检查旧字段；内置内容当前应无致命项）。 */
export const CORE_GUIMUYA_PACK_MIGRATION_WARNINGS: readonly string[] = migration.warnings;

/** 内置内容包（`trpg.pack/1` 规范化形状 + 内联 `rules` 段）。 */
export const CORE_GUIMUYA_PACK: ContentPack = assertContentPack({
  ...(migration.pack as Record<string, unknown>),
  rules: DND5E_LITE_RULES,
});

/** 内置包注册表（M8.2 的 pack registry 直接从这里起步）。 */
export const CORE_PACKS: readonly ContentPack[] = [CORE_GUIMUYA_PACK];
