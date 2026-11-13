/**
 * 内容包入口：规则数据 + 预制角色卡 + 世界书 + 首个模组。
 *
 * 角色卡/世界书/模组以 JSON 存放（内容作者可直接编辑），这里统一加载并导出。
 */
import type { CharacterCard } from '@dsh-trpg/engine';
import aqingCard from '../cards/aqing.json' with { type: 'json' };
import bailuCard from '../cards/bailu.json' with { type: 'json' };
import xuanzhenCard from '../cards/xuanzhen.json' with { type: 'json' };
import sujiuCard from '../cards/sujiu.json' with { type: 'json' };
import guimuyaLorebook from '../lorebooks/guimuya.json' with { type: 'json' };
import guimuyaModule from '../modules/guimuya.json' with { type: 'json' };
import type { LorebookDef, ModuleDef } from './schema.ts';

export * from './schema.ts';
export { RACES } from './rules/races.ts';
export { CLASSES } from './rules/classes.ts';
export { SPELLS, SPELL_BY_ID } from './rules/spells.ts';
export { MONSTERS } from './rules/monsters.ts';
export { ITEMS } from './rules/items.ts';

export const RULE_ID = 'dnd5e-lite';
export const RULE_VERSION = '1.0';

/** 预制角色卡（4 张，对应 v1 的四个职业）。owner 未分配，进房时由服务端绑定玩家。 */
export const CARDS: CharacterCard[] = [aqingCard, bailuCard, xuanzhenCard, sujiuCard] as unknown as CharacterCard[];

/** 首个原创模组「鬼木崖·异光」。 */
export const GUIMUYA_MODULE = guimuyaModule as unknown as ModuleDef;

/** 模组配套世界书。 */
export const GUIMUYA_LOREBOOK = guimuyaLorebook as unknown as LorebookDef;

export const CONTENT_VERSION = '0.1.0';
