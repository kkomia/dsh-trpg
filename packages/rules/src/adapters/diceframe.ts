/**
 * DiceFrame 角色卡库（`schema_version: 2`）→ 内部卡实例（`trpg.card/1`）适配器（M8.5a）。
 *
 * 背景：DiceFrame 是独立 AI 跑团引擎的卡库格式，字段命名与语义都和本项目的卡实例不同
 * （`character_name` / `attributes` / `skills` / `equipment` / `rule_id` …，见 docs/CONTENT-MODEL §2.5）。
 * 本模块只做**纯数据适配**：不改 UI、不读文件、不引 `node:` 模块（客户端侧也可直接复用）。
 *
 * 版本守卫（docs/CONTENT-MODEL §7「DiceFrame 格式漂移」）：
 * - 只认 `schema_version === 2`；其它版本直接拒绝，不尝试猜测；
 * - 缺少 `schema_version` 时用特征字段嗅探（`character_name` + `attributes` 等），识别成功给 warning，
 *   识别失败直接拒绝。
 *
 * 映射口径：
 * - **属性**：外部属性名按「规则包 `id`/`name` → {@link DICEFRAME_ATTRIBUTE_ALIASES} 中英文别名」解析。
 *   规则包声明了但外部没有 → `default` + warning；外部有但规则包没有 → warning 后丢弃（不写未声明属性，
 *   否则 `validateCard` 会拒绝）；值非数值 → `default` + warning；**数值越界不静默裁剪**，原样写入后由
 *   `validateCard` 报错（导入报告能看到原始值，避免数据被悄悄改小）。
 * - **技能**：外部 `skills[]`（也接受 `{ 技能名: 数值 }` 映射写法）按规则包 `skills[].id/name` →
 *   {@link DICEFRAME_SKILL_ALIASES} 解析；未映射 warning 丢弃。`proficient` 原样保留；显式
 *   `bonus`/`modifier`/`加值` 原样写 `bonus`；只有 `value` 时把数值原样写 `bonus` 并逐条 warning
 *   （DiceFrame 的技能值是自由规则 0–100 口径，**不做单位换算**——不猜）。
 * - **装备/物品**：`equipment[]` + `inventory[]` → `equipmentInstances[]`。按名称/`itemId` 匹配
 *   `rules.items[]`：命中则用物品定义的 `tags`/`stats`/`equipSlot`；**未命中只保留 name/tags/note**
 *   （`tags` 由外部 `type`/物品名关键词推导）并 warning，不注入词条。槽位按「外部 `slot` →
 *   {@link DICEFRAME_EQUIPMENT_SLOT_ALIASES} → 物品 `equipSlot` → 可接受标签的槽位」顺序解析；
 *   没有可放置槽位或槽位容量不足 → warning 丢弃/截断。`qty` 按件展开，受槽位 `count` 上限约束。
 *   外部 `quality`/`damage`/`effect` 只进 `note`，不伪造词条。
 * - **资源**：`hp`/`mana`/`qi` 等按规则包 `resources[].id/name` → {@link DICEFRAME_RESOURCE_ALIASES}
 *   映射外部字段（`resources` 对象、顶层同名字段、`combat.hpMax`）。外部当前值优先；没有当前值时
 *   用规则包的资源上限公式求值取上限作为当前值（与「当前值取外部字段或上限」一致）；公式依赖钩子
 *   派生值求不出来 → 当前值 0 + warning（与 `migrateLegacyCard` 口径一致）。外部无法映射的资源值
 *   warning 后丢弃；`max` 只在外部提供或公式可求值时写入（权威上限仍由主机实时算）。
 * - **叙事字段**：`character_name`/`race`/`class`/`background`/`publicSummary`/`appearance`/
 *   `personality`/`level` → `fields`，仅当目标规则包声明了同名 `text`/`number` 字段时写入，否则 warning
 *   （`level` 与 `migrateLegacyCard` 一致：缺省 1，超 `progression.maxLevel` 裁剪）。
 * - **世界书**：外部 `worldbook`/`lore`/`lorebook` 等片段**不写入角色卡**，统一放进返回值的
 *   `personalLore[]` 并给 warning，由使用方走世界书导入流程（卡是玩家可见的，世界书有 GM 条目与
 *   可见性规则，混进卡里会泄漏）。
 * - **来源**：`origin = { packId: 'diceframe:<rule_id>' }`（docs/CONTENT-MODEL §2.5 的
 *   `source.ruleId = "diceframe:freeform_wuxia"` 标注口径），无 `rule_id` 时 `packId: 'diceframe'`。
 * - **cardId**：`diceframe-<16 位 hex>` 由「外部 `id`（缺省用卡内容指纹）+ 目标 `rulesId`」稳定派生：
 *   同一张外部卡重复导入得到同一个 `cardId`，不同规则包下互不相同，也不会和本地 `card_*` 撞号。
 * - **硬校验**：组装完调用 `validateCard(rules, card)`；失败返回 `ok:false` + 中文错误数组（适配器
 *   自己的映射 warning 仍一并返回，便于一次性修卡）。
 *
 * 扩展方式：属性/技能/资源/槽位的别名表都是本文件顶部的独立 `as const` 数据（按 `规则包 id → 别名[]`
 * 组织）；新增规则包或中文叫法只需扩表，不需要改解析逻辑。
 */
import { compileFormula, evaluateFormula, type FormulaContext } from '../formula.ts';
import { validateCard } from '../sheet.ts';
import {
  CARD_SCHEMA_VERSION,
  LEVEL_FIELD_ID,
  type CardInstance,
  type CardResourceState,
  type CardSkillState,
  type EquipmentInstanceDef,
  type EquipmentSlotDef,
  type FieldDef,
  type RulePack,
  type RulePackItemDef,
} from '../types.ts';

// ---------------------------------------------------------------------------
// 常量 / 别名表（可扩展点）
// ---------------------------------------------------------------------------

/** 适配器唯一接受的 DiceFrame 角色卡库版本。 */
export const DICEFRAME_SCHEMA_VERSION = 2;

/**
 * 属性别名表：`规则包属性 id（d20 惯例）→ 中英文别名`。
 *
 * 解析顺序：先按目标规则包属性的 `id`/`name` 精确（规范化后）匹配；再按本表找到目标规则包里
 * 对应同一属性的 id（例如规则包用 `strength` 之类自定义 id 时，靠 `力量` 别名回填）。
 * 不在表内的自定义属性只能靠目标规则包自己的 id/name 命中，否则丢弃并 warning。
 */
export const DICEFRAME_ATTRIBUTE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  str: ['str', 'strength', '力量', '力', '筋力', '强壮'],
  dex: ['dex', 'dexterity', '敏捷', '灵巧', '身法'],
  con: ['con', 'constitution', '体质', '体魄', '耐力', '筋骨'],
  int: ['int', 'intelligence', '智力', '智识', '悟性', '聪慧'],
  wis: ['wis', 'wisdom', '感知', '洞察', '心性', '精神'],
  cha: ['cha', 'charisma', '魅力', '仪态', '风采', '气度'],
};

/**
 * 技能别名表：`规则包技能 id（d20 惯例）→ 中英文别名`。
 * 未列出的自定义技能只能靠目标规则包 `skills[].id/name` 命中；DiceFrame 自由规则里的招式名
 * （如「霜起」「踏雪」）通常映射不到 d20 技能，会走 warning 丢弃口径。
 */
export const DICEFRAME_SKILL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  athletics: ['athletics', '运动', '体术', '力气'],
  acrobatics: ['acrobatics', '体操', '杂技', '轻功'],
  sleight_of_hand: ['sleight_of_hand', 'sleightofhand', 'sleight', '巧手', '手上功夫'],
  stealth: ['stealth', '隐匿', '潜行', '藏匿'],
  arcana: ['arcana', '奥秘', '秘法', '奥法'],
  history: ['history', '历史', '学识'],
  investigation: ['investigation', '调查', '搜查'],
  nature: ['nature', '自然', '博物'],
  religion: ['religion', '宗教', '神学'],
  animal_handling: ['animal_handling', 'animalhandling', '驯兽', '驭兽'],
  insight: ['insight', '洞悉', '察言观色'],
  medicine: ['medicine', '医药', '医术'],
  perception: ['perception', '察觉', '观察', '感知'],
  survival: ['survival', '生存', '野外生存'],
  deception: ['deception', '欺瞒', '欺骗', '诈术'],
  intimidation: ['intimidation', '威吓', '恐吓'],
  performance: ['performance', '表演', '演艺'],
  persuasion: ['persuasion', '游说', '说服', '交涉'],
};

/**
 * 资源别名表：`规则包资源 id（d20 惯例）→ 中英文别名`。
 * 同一资源的上限键按「前缀 max / 最大 / 上限，后缀 max / 上限」组合自动派生（见内部实现）。
 */
export const DICEFRAME_RESOURCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  hp: ['hp', 'hitpoints', 'hit_points', 'health', 'life', '生命', '生命值', '血量'],
  mana: ['mana', 'mp', 'magicpoint', 'magicpoints', 'spellslot', 'spellslots', 'spell_slots', '法力', '法力值', '魔力', '法术位', '蓝量'],
  qi: ['qi', 'chi', 'ki', 'inner', 'innerforce', '内力', '真气', '气', '灵气'],
  stamina: ['stamina', '体力', '耐力', '精力'],
  sanity: ['sanity', 'san', '理智', '理智值', '精神值'],
  energy: ['energy', '能量', '能量值'],
};

/**
 * 装备槽别名表（**语义 id** → 中英文别名）。语义 id 不要求与规则包槽位 id 一致：
 * 先按目标规则包槽位 `id/name` 精确匹配，再按本表语义组匹配（例如 `main_hand` → `mainHand`）。
 */
export const DICEFRAME_EQUIPMENT_SLOT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  mainHand: ['main_hand', 'mainhand', 'main hand', 'primary', 'main', 'weapon', '主手', '武器', '右手'],
  offHand: ['off_hand', 'offhand', 'off hand', 'secondary', 'off', 'shield', '副手', '左手', '盾牌'],
  body: ['body', 'armor', 'armour', 'chest', 'torso', 'bodyarmor', '身上', '护甲', '身体', '躯干', '衣服'],
  trinket: ['trinket', 'accessory', 'misc', 'other', 'ring', 'amulet', '随身', '饰品', '配件', '杂物', '杂项'],
};

/** DiceFrame `equipment[].type` → 内部物品标签（匹配不到 `rules.items[]` 时用）。 */
export const DICEFRAME_ITEM_TYPE_TAGS: Readonly<Record<string, readonly string[]>> = {
  weapon: ['weapon:melee'],
  armor: ['armor'],
  shield: ['armor'],
  consumable: ['consumable'],
  tool: ['tool'],
  treasure: ['treasure'],
  misc: ['misc'],
};

/** 远程武器名称关键词（外部没有 `type` 细分时，用名称推导 `weapon:ranged`）。 */
const RANGED_WEAPON_NAME_HINTS = ['弓', '弩', '箭', '铳', '镖', '飞刀', '暗器', '投掷', '弹弓', '火枪', 'bow', 'crossbow', 'gun', 'dart', 'sling', 'throwing'];

/** 背包物品名关键词 → 标签（匹配不到 `rules.items[]` 时用）。 */
const CONSUMABLE_NAME_HINTS = ['药', '丹', '草', '散', '膏', '丸', '液', '粮', '食', '水', '酒', '果', '肉', '香', '露', '恢复', 'heal', 'potion', 'food', 'ration'];
const TOOL_NAME_HINTS = ['工具', '火折', '绳', '灯', '钥', '地图', '笔', '纸', '镜', '囊', '袋', '匣', '盒', '铲', '稿', 'tool', 'rope', 'lamp', 'key', 'map'];

/** DiceFrame 卡里可能承载世界书片段的字段名（只读取，不写卡）。 */
const LORE_FIELD_NAMES = ['worldbook', 'world_book', 'worldBook', 'lore', 'lorebook', 'lore_book', 'personalLore', 'personal_lore'] as const;

/** 外部卡身份类字段：只在外部没有显式 `fields` 时兜底写。 */
const IDENTITY_TEXT_KEYS = {
  name: ['character_name'],
  race: ['race', 'race_name'],
  class: ['class', 'class_name'],
  background: ['background'],
  publicSummary: ['publicSummary', 'public_summary'],
  appearance: ['appearance', 'looks'],
  personality: ['personality', 'temperament'],
} as const;

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

/** 未写入角色卡、需另走世界书导入流程的 DiceFrame 世界书片段。 */
export interface DiceFrameLoreEntry {
  /** 来源字段名（`worldbook` / `lore` / …），便于回溯。 */
  source: string;
  title?: string;
  /** 关键词（外部 `keys` / `keywords` / `trigger`）。 */
  keys: string[];
  content: string;
}

export interface DiceFrameAdaptOk {
  ok: true;
  /** 通过 `validateCard` 的内部卡实例（纯 JSON 值，可直接序列化入包/入库）。 */
  card: CardInstance;
  warnings: string[];
  /** 外部卡随附的世界书片段（**没有写进卡**；空数组表示没有）。 */
  personalLore: DiceFrameLoreEntry[];
}

export interface DiceFrameAdaptFail {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type DiceFrameAdaptResult = DiceFrameAdaptOk | DiceFrameAdaptFail;

export interface DiceFrameCardJsonOk extends DiceFrameAdaptOk {
  /** 内部卡 JSON 文本（缩进 2、结尾换行），可直接写 `.json` 文件。 */
  json: string;
}

export type DiceFrameCardJsonResult = DiceFrameCardJsonOk | DiceFrameAdaptFail;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 别名规范化：去空白/下划线/横线/冒号/点，转小写（`Sleight_of_Hand` → `sleightofhand`）。 */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-:：·.]+/g, '');
}

function readStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isNonEmptyString(value)) return value.trim();
  }
  return undefined;
}

function readNumberField(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isFiniteNumber(value)) return value;
  }
  return undefined;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value);
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 位（确定性、零依赖、浏览器可用）；输出 16 位小写 hex。 */
function stableHash64(input: string): string {
  let hash = FNV64_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash ^ BigInt(input.charCodeAt(index))) * FNV64_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 由外部卡稳定派生内部 `cardId`（`diceframe-<hash>`）；同一外部卡 + 同一规则包结果恒定。 */
function deriveCardId(input: Record<string, unknown>, rules: RulePack): string {
  const externalId = readStringField(input, ['id']);
  let seed: string;
  if (externalId !== undefined) {
    seed = `diceframe|id:${externalId}|rules:${rules.rulesId}`;
  } else {
    const name = readStringField(input, ['character_name']) ?? '';
    const attributes = isRecord(input.attributes)
      ? JSON.stringify(
          Object.entries(input.attributes)
            .map(([key, value]) => [normalizeKey(key), value] as const)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        )
      : '';
    const skills = Array.isArray(input.skills)
      ? input.skills
          .map((entry) => (isRecord(entry) ? (readStringField(entry, ['name', 'id', 'skill']) ?? '') : typeof entry === 'string' ? entry : ''))
          .join(',')
      : '';
    const items = Array.isArray(input.equipment)
      ? input.equipment.map((entry) => (isRecord(entry) ? (readStringField(entry, ['name']) ?? '') : '')).join(',')
      : '';
    seed = `diceframe|name:${name}|attrs:${attributes}|skills:${skills}|items:${items}|rules:${rules.rulesId}`;
  }
  return `diceframe-${stableHash64(seed)}`;
}

/** 通用的「规则包 id/name + 别名表」索引：规范化键 → 规则包内 id。 */
function buildAliasIndex(
  defs: readonly { id: string; name: string }[],
  aliases: Readonly<Record<string, readonly string[]>>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const def of defs) {
    const idKey = normalizeKey(def.id);
    if (!index.has(idKey)) index.set(idKey, def.id);
    const nameKey = normalizeKey(def.name);
    if (!index.has(nameKey)) index.set(nameKey, def.id);
  }
  for (const aliasList of Object.values(aliases)) {
    const target = defs.find((def) => {
      const idKey = normalizeKey(def.id);
      const nameKey = normalizeKey(def.name);
      return aliasList.some((alias) => {
        const key = normalizeKey(alias);
        return key === idKey || key === nameKey;
      });
    });
    if (target === undefined) continue;
    for (const alias of aliasList) {
      const key = normalizeKey(alias);
      if (!index.has(key)) index.set(key, target.id);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// 资源别名索引 / 候选
// ---------------------------------------------------------------------------

interface ResourceAliasEntry {
  id: string;
  currentKeys: Set<string>;
  maxKeys: Set<string>;
}

function buildResourceAliasEntries(rules: RulePack): ResourceAliasEntry[] {
  return rules.sheet.resources.map((resource) => {
    const baseKeys = new Set<string>([normalizeKey(resource.id), normalizeKey(resource.name)]);
    for (const aliasList of Object.values(DICEFRAME_RESOURCE_ALIASES)) {
      if (!aliasList.some((alias) => baseKeys.has(normalizeKey(alias)))) continue;
      for (const alias of aliasList) baseKeys.add(normalizeKey(alias));
    }
    const currentKeys = new Set(baseKeys);
    const maxKeys = new Set<string>();
    for (const key of baseKeys) {
      maxKeys.add(normalizeKey(`max${key}`));
      maxKeys.add(normalizeKey(`${key}max`));
      maxKeys.add(normalizeKey(`最大${key}`));
      maxKeys.add(normalizeKey(`${key}上限`));
      maxKeys.add(normalizeKey(`上限${key}`));
    }
    return { id: resource.id, currentKeys, maxKeys };
  });
}

interface ExternalResourceCandidate {
  /** 人话来源（`resources.hp` / 顶层 `hp` / `combat.hpMax`）。 */
  source: string;
  key: string;
  normalized: string;
  current?: number;
  max?: number;
  /** 是否来自显式 `resources` 对象（未映射时给 warning，顶层散字段不给）。 */
  explicit: boolean;
}

interface ExternalResourceState {
  current?: number;
  max?: number;
}

/**
 * 收集外部资源候选：
 * 1. 显式 `resources` 对象（键任意，允许自定义资源 id；值可以是数字或 `{current,max}`）；
 * 2. 顶层同名字段（只收数字值，避免把 `gold`/`level` 之类误当资源——它们不在别名表里）；
 * 3. `combat.hpMax`（旧导出/混合导出里常见的上限写法）。
 */
function collectExternalResourceCandidates(
  input: Record<string, unknown>,
  warnings: string[],
): ExternalResourceCandidate[] {
  const candidates: ExternalResourceCandidate[] = [];
  const resourcesRaw = input.resources;
  if (resourcesRaw !== undefined) {
    if (!isRecord(resourcesRaw)) {
      warnings.push('外部卡 resources 不是对象，已忽略');
    } else {
      for (const [key, value] of Object.entries(resourcesRaw)) {
        if (isFiniteNumber(value)) {
          candidates.push({ source: `resources.${key}`, key, normalized: normalizeKey(key), current: value, explicit: true });
          continue;
        }
        if (isRecord(value)) {
          const current = readNumberField(value, ['current', 'value', 'currentValue', '当前值', '当前']);
          const max = readNumberField(value, ['max', 'maximum', 'maxValue', '上限', '最大值']);
          if (current === undefined && max === undefined) {
            warnings.push(`外部资源「${key}」既没有 current 也没有 max，已忽略`);
            continue;
          }
          candidates.push({
            source: `resources.${key}`,
            key,
            normalized: normalizeKey(key),
            ...(current !== undefined ? { current } : {}),
            ...(max !== undefined ? { max } : {}),
            explicit: true,
          });
          continue;
        }
        warnings.push(`外部资源「${key}」的值不是数值或 {current,max} 对象，已忽略`);
      }
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === 'resources' || key === 'attributes' || key === 'identity') continue;
    if (isFiniteNumber(value)) {
      candidates.push({ source: key, key, normalized: normalizeKey(key), current: value, explicit: false });
    }
  }
  const combat = isRecord(input.combat) ? input.combat : undefined;
  if (combat !== undefined) {
    const hpMax = readNumberField(combat, ['hpMax', 'maxHp', 'hp_max', 'max_hp']);
    if (hpMax !== undefined) {
      candidates.push({ source: 'combat.hpMax', key: 'hpMax', normalized: normalizeKey('hpMax'), max: hpMax, explicit: false });
    }
  }
  return candidates;
}

/** 把候选值分配到目标规则包声明的资源；无法映射的显式资源给 warning。 */
function matchExternalResources(
  candidates: readonly ExternalResourceCandidate[],
  entries: readonly ResourceAliasEntry[],
  warnings: string[],
): Map<string, ExternalResourceState> {
  const matched = new Map<string, ExternalResourceState>();
  for (const candidate of candidates) {
    let hit = false;
    for (const entry of entries) {
      if (entry.currentKeys.has(candidate.normalized)) {
        hit = true;
        const state = matched.get(entry.id) ?? {};
        if (state.current === undefined && candidate.current !== undefined) state.current = candidate.current;
        if (state.max === undefined && candidate.max !== undefined) state.max = candidate.max;
        matched.set(entry.id, state);
        break;
      }
      if (entry.maxKeys.has(candidate.normalized)) {
        hit = true;
        const state = matched.get(entry.id) ?? {};
        // 纯数字形式的上限键（如 `max_hp: 14`）在收集阶段只有 current 字段，这里按上限落账。
        const maxValue = candidate.max ?? candidate.current;
        if (state.max === undefined && maxValue !== undefined) state.max = maxValue;
        matched.set(entry.id, state);
        break;
      }
    }
    if (!hit && candidate.explicit) {
      warnings.push(`外部资源「${candidate.key}」（来源 ${candidate.source}）在目标规则包没有对应资源，值已丢弃`);
    }
  }
  return matched;
}

/** 适配期尽力求值资源上限公式（依赖钩子 `derived.*` 的公式会失败，交给主机实时算）。 */
function evaluateResourceMaxFormula(
  rules: RulePack,
  formulaRef: string,
  context: FormulaContext,
): { ok: true; value: number } | { ok: false; error: string } {
  const source = rules.formulas[formulaRef] ?? formulaRef;
  const compiled = compileFormula(source);
  if (!compiled.ok) {
    return { ok: false, error: compiled.errors.map((issue) => issue.message).join('；') };
  }
  const result = evaluateFormula(compiled.ast, context);
  if (!result.ok) return { ok: false, error: result.error };
  if (!Number.isFinite(result.value)) return { ok: false, error: '结果不是有限数' };
  return { ok: true, value: Math.max(0, Math.floor(result.value)) };
}

// ---------------------------------------------------------------------------
// 技能解析
// ---------------------------------------------------------------------------

interface ExternalSkill {
  name: string;
  bonus?: number;
  value?: number;
  proficient?: boolean;
}

function readExternalSkillEntry(record: Record<string, unknown>, name: string): ExternalSkill {
  const bonus = readNumberField(record, ['bonus', 'modifier', 'mod', '加值', '调整值']);
  const value = readNumberField(record, ['value', 'score', '数值', '值']);
  const proficientRaw = record.proficient ?? record.proficiency ?? record['熟练'];
  const proficient = typeof proficientRaw === 'boolean' ? proficientRaw : undefined;
  return {
    name,
    ...(bonus !== undefined ? { bonus } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(proficient !== undefined ? { proficient } : {}),
  };
}

/** 解析外部技能：数组（规范）或 `{ 技能名: 数值 | {value,bonus,proficient} }`（常见变体）。 */
function parseExternalSkills(raw: unknown, warnings: string[]): ExternalSkill[] {
  const skills: ExternalSkill[] = [];
  if (raw === undefined) return skills;
  if (Array.isArray(raw)) {
    raw.forEach((entry, index) => {
      const label = `skills[${index}]`;
      if (typeof entry === 'string') {
        if (entry.trim().length > 0) skills.push({ name: entry.trim() });
        else warnings.push(`外部卡 ${label} 是空字符串，已跳过`);
        return;
      }
      if (!isRecord(entry)) {
        warnings.push(`外部卡 ${label} 不是对象或技能名，已跳过`);
        return;
      }
      const name = readStringField(entry, ['name', 'id', 'skill', 'skill_name', '技能', '名称']);
      if (name === undefined) {
        warnings.push(`外部卡 ${label} 缺少技能名，已跳过`);
        return;
      }
      skills.push(readExternalSkillEntry(entry, name));
    });
    return skills;
  }
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (isFiniteNumber(value)) {
        skills.push({ name: key, bonus: value });
      } else if (isRecord(value)) {
        skills.push(readExternalSkillEntry(value, key));
      } else {
        warnings.push(`外部卡 skills.${key} 的值不是数值或对象，已跳过`);
      }
    }
    return skills;
  }
  warnings.push('外部卡 skills 既不是数组也不是对象，已忽略');
  return skills;
}

/** 技能状态 + 逐条映射（未映射 warning；value 无换算原样进 bonus 也给 warning）。 */
function buildSkillStates(
  rules: RulePack,
  externalSkills: readonly ExternalSkill[],
  warnings: string[],
): CardSkillState[] {
  const states = new Map<string, CardSkillState>();
  for (const skill of rules.sheet.skills) {
    states.set(skill.id, { id: skill.id, proficient: false, bonus: 0 });
  }
  const skillIndex = buildAliasIndex(rules.sheet.skills, DICEFRAME_SKILL_ALIASES);
  for (const external of externalSkills) {
    const skillId = skillIndex.get(normalizeKey(external.name));
    if (skillId === undefined) {
      warnings.push(`外部卡技能「${external.name}」在目标规则包没有对应技能，已丢弃（效果文本未保留）`);
      continue;
    }
    const state = states.get(skillId);
    if (state === undefined) continue;
    if (external.proficient === true) state.proficient = true;
    if (external.bonus !== undefined) {
      state.bonus = (state.bonus ?? 0) + external.bonus;
    } else if (external.value !== undefined) {
      state.bonus = (state.bonus ?? 0) + external.value;
      warnings.push(
        `外部卡技能「${external.name}」的数值 ${external.value} 按原值写入 bonus（DiceFrame 技能值是自由规则口径，未做单位换算，请核对目标规则包数值）`,
      );
    }
  }
  return rules.sheet.skills.map((skill) => states.get(skill.id) as CardSkillState);
}

// ---------------------------------------------------------------------------
// 装备 / 物品解析
// ---------------------------------------------------------------------------

interface ExternalItem {
  kind: 'equipment' | 'inventory';
  name: string;
  qty: number;
  type?: string;
  slot?: string;
  quality?: string;
  damage?: number;
  effect?: string;
  label: string;
}

function collectExternalItems(input: Record<string, unknown>, warnings: string[]): ExternalItem[] {
  const items: ExternalItem[] = [];
  const equipment = input.equipment;
  if (equipment !== undefined) {
    if (!Array.isArray(equipment)) {
      warnings.push('外部卡 equipment 不是数组，已忽略');
    } else {
      equipment.forEach((entry, index) => {
        const label = `equipment[${index}]`;
        if (!isRecord(entry)) {
          warnings.push(`外部卡 ${label} 不是对象，已跳过`);
          return;
        }
        const name = readStringField(entry, ['name', '名称', 'item_name']);
        if (name === undefined) {
          warnings.push(`外部卡 ${label} 缺少物品名，已跳过`);
          return;
        }
        const qtyRaw = readNumberField(entry, ['qty', 'quantity', '数量']);
        const qty = isPositiveInteger(qtyRaw) ? Math.floor(qtyRaw) : 1;
        const type = readStringField(entry, ['type', '类型']);
        const slot = readStringField(entry, ['slot', '槽位']);
        const quality = readStringField(entry, ['quality', '品质']);
        const damage = readNumberField(entry, ['damage', '伤害']);
        const effect = readStringField(entry, ['effect', 'description', '效果']);
        items.push({
          kind: 'equipment',
          name,
          qty,
          label,
          ...(type !== undefined ? { type } : {}),
          ...(slot !== undefined ? { slot } : {}),
          ...(quality !== undefined ? { quality } : {}),
          ...(damage !== undefined ? { damage } : {}),
          ...(effect !== undefined ? { effect } : {}),
        });
      });
    }
  }
  const inventory = input.inventory;
  if (inventory !== undefined) {
    const entries: Array<[string, unknown]> = Array.isArray(inventory)
      ? inventory.map((entry, index) => [String(index), entry] as [string, unknown])
      : isRecord(inventory)
        ? Object.entries(inventory)
        : [];
    if (!Array.isArray(inventory) && !isRecord(inventory)) {
      warnings.push('外部卡 inventory 不是数组/对象，已忽略');
    } else {
      for (const [key, entry] of entries) {
        const label = Array.isArray(inventory) ? `inventory[${key}]` : `inventory.${key}`;
        // 映射写法 `{ 物品名: qty }`
        if (!Array.isArray(inventory)) {
          if (isFiniteNumber(entry) && entry > 0) {
            items.push({ kind: 'inventory', name: key, qty: Math.floor(entry), label });
            continue;
          }
          if (isRecord(entry)) {
            const qtyRaw = readNumberField(entry, ['qty', 'quantity', '数量']);
            const effect = readStringField(entry, ['effect', 'description', '效果']);
            items.push({
              kind: 'inventory',
              name: key,
              qty: isPositiveInteger(qtyRaw) ? Math.floor(qtyRaw) : 1,
              label,
              ...(effect !== undefined ? { effect } : {}),
            });
            continue;
          }
          warnings.push(`外部卡 ${label} 的值不是数量或对象，已跳过`);
          continue;
        }
        if (!isRecord(entry)) {
          warnings.push(`外部卡 ${label} 不是对象，已跳过`);
          continue;
        }
        const name = readStringField(entry, ['name', '名称', 'item_name']);
        if (name === undefined) {
          warnings.push(`外部卡 ${label} 缺少物品名，已跳过`);
          continue;
        }
        const qtyRaw = readNumberField(entry, ['qty', 'quantity', '数量']);
        const effect = readStringField(entry, ['effect', 'description', '效果']);
        items.push({
          kind: 'inventory',
          name,
          qty: isPositiveInteger(qtyRaw) ? Math.floor(qtyRaw) : 1,
          label,
          ...(effect !== undefined ? { effect } : {}),
        });
      }
    }
  }
  return items;
}

function buildItemIndex(items: readonly RulePackItemDef[] | undefined): Map<string, RulePackItemDef> {
  const index = new Map<string, RulePackItemDef>();
  for (const item of items ?? []) {
    const idKey = normalizeKey(item.itemId);
    if (!index.has(idKey)) index.set(idKey, item);
    const nameKey = normalizeKey(item.name);
    if (!index.has(nameKey)) index.set(nameKey, item);
  }
  return index;
}

function slotAcceptsTags(slot: EquipmentSlotDef, tags: readonly string[]): boolean {
  return slot.accepts.includes('*') || tags.some((tag) => slot.accepts.includes(tag));
}

function slotHasRoom(slot: EquipmentSlotDef, usage: ReadonlyMap<string, number>): boolean {
  return (usage.get(slot.id) ?? 0) < (slot.count ?? 1);
}

function resolveExternalSlotCandidates(rules: RulePack, externalSlot: string): EquipmentSlotDef[] {
  const slots = rules.sheet.equipment.slots;
  const key = normalizeKey(externalSlot);
  const direct = slots.filter((slot) => normalizeKey(slot.id) === key || normalizeKey(slot.name) === key);
  if (direct.length > 0) return direct;
  for (const [semanticId, aliases] of Object.entries(DICEFRAME_EQUIPMENT_SLOT_ALIASES)) {
    const keys = new Set<string>([normalizeKey(semanticId), ...aliases.map((alias) => normalizeKey(alias))]);
    if (!keys.has(key)) continue;
    return slots.filter((slot) => keys.has(normalizeKey(slot.id)) || keys.has(normalizeKey(slot.name)));
  }
  return [];
}

function deriveExternalTags(raw: ExternalItem): string[] {
  if (raw.kind === 'equipment') {
    const type = raw.type === undefined ? '' : normalizeKey(raw.type);
    const mapped = DICEFRAME_ITEM_TYPE_TAGS[type];
    if (type === 'weapon') {
      const nameKey = normalizeKey(raw.name);
      const ranged = RANGED_WEAPON_NAME_HINTS.some((hint) => nameKey.includes(normalizeKey(hint)));
      return [ranged ? 'weapon:ranged' : 'weapon:melee'];
    }
    if (mapped !== undefined) return [...mapped];
    return ['misc'];
  }
  const nameKey = normalizeKey(raw.name);
  if (CONSUMABLE_NAME_HINTS.some((hint) => nameKey.includes(normalizeKey(hint)))) return ['consumable'];
  if (TOOL_NAME_HINTS.some((hint) => nameKey.includes(normalizeKey(hint)))) return ['tool'];
  return ['misc'];
}

function buildItemNote(itemDef: RulePackItemDef | undefined, raw: ExternalItem): string | undefined {
  if (itemDef !== undefined) return raw.effect ?? itemDef.description;
  const parts: string[] = [];
  if (raw.effect !== undefined) parts.push(raw.effect);
  if (raw.kind === 'equipment') {
    const meta: string[] = [];
    if (raw.type !== undefined) meta.push(`类型 ${raw.type}`);
    if (raw.quality !== undefined) meta.push(`品质 ${raw.quality}`);
    if (raw.damage !== undefined) meta.push(`伤害 ${raw.damage}`);
    parts.push(`DiceFrame 装备${meta.length > 0 ? `（${meta.join('，')}）` : ''}`);
  } else {
    parts.push('DiceFrame 物品（未匹配规则包物品定义）');
  }
  return parts.join('；');
}

/** 按「外部槽位 → 物品 equipSlot → 任意可接受标签槽位」选一个还有容量的槽位。 */
function pickEquipmentSlot(
  rules: RulePack,
  itemDef: RulePackItemDef | undefined,
  raw: ExternalItem,
  tags: readonly string[],
  usage: ReadonlyMap<string, number>,
): EquipmentSlotDef | undefined {
  const slots = rules.sheet.equipment.slots;
  const acceptable = (slot: EquipmentSlotDef): boolean => slotAcceptsTags(slot, tags) && slotHasRoom(slot, usage);
  if (raw.slot !== undefined) {
    const candidate = resolveExternalSlotCandidates(rules, raw.slot).find(acceptable);
    if (candidate !== undefined) return candidate;
  }
  if (itemDef?.equipSlot !== undefined) {
    for (const slotId of itemDef.equipSlot) {
      const slot = slots.find((candidate) => candidate.id === slotId);
      if (slot !== undefined && acceptable(slot)) return slot;
    }
  }
  return slots.find(acceptable);
}

function buildEquipmentInstances(
  rules: RulePack,
  externalItems: readonly ExternalItem[],
  warnings: string[],
): EquipmentInstanceDef[] {
  const instances: EquipmentInstanceDef[] = [];
  const usage = new Map<string, number>();
  const itemIndex = buildItemIndex(rules.items);
  for (const raw of externalItems) {
    const itemDef = itemIndex.get(normalizeKey(raw.name));
    const matchedTags = itemDef?.tags !== undefined && itemDef.tags.length > 0 ? [...itemDef.tags] : [];
    const tags = matchedTags.length > 0 ? matchedTags : deriveExternalTags(raw);
    const note = buildItemNote(itemDef, raw);
    let created = 0;
    for (let copy = 0; copy < raw.qty; copy += 1) {
      const slot = pickEquipmentSlot(rules, itemDef, raw, tags, usage);
      if (slot === undefined) break;
      usage.set(slot.id, (usage.get(slot.id) ?? 0) + 1);
      instances.push({
        instanceId: `ins_df_${instances.length + 1}`,
        slot: slot.id,
        name: itemDef?.name ?? raw.name,
        tags: [...tags],
        stats: itemDef?.stats !== undefined ? { ...itemDef.stats } : {},
        ...(note !== undefined ? { note } : {}),
      });
      created += 1;
    }
    const tagLabel = `[${tags.join(', ')}]`;
    if (created === 0) {
      if (itemDef === undefined) {
        warnings.push(
          `外部卡物品「${raw.name}」（${raw.label}）无法映射：规则包 items[] 没有该物品，且没有可接受其标签 ${tagLabel} 的装备槽，已丢弃`,
        );
      } else {
        warnings.push(
          `外部卡物品「${raw.name}」（${raw.label}）无法映射：没有可接受其标签 ${tagLabel} 的装备槽（或槽位已满），已丢弃`,
        );
      }
    } else if (created < raw.qty) {
      warnings.push(
        `外部卡物品「${raw.name}」数量 ${raw.qty}，可放置的装备槽容量不足，已放入 ${created} 件（单件物品不堆叠，超出部分丢弃）`,
      );
    } else if (itemDef === undefined) {
      const slotName = rules.sheet.equipment.slots.find((slot) => slot.id === instances[instances.length - 1]?.slot)?.name;
      warnings.push(
        `外部卡物品「${raw.name}」不在规则包 items[] 中：已放入「${slotName ?? '装备槽'}」，仅保留名称/标签，未注入词条`,
      );
    }
  }
  return instances;
}

// ---------------------------------------------------------------------------
// 世界书片段
// ---------------------------------------------------------------------------

function readLoreKeys(record: Record<string, unknown>): string[] {
  const raw = record.keys ?? record.keywords ?? record.key ?? record.trigger ?? record['关键词'];
  if (typeof raw === 'string' && raw.trim().length > 0) return [raw.trim()];
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim());
  }
  return [];
}

function readLoreContent(record: Record<string, unknown>): string | undefined {
  return readStringField(record, ['content', 'text', 'body', 'description', 'entry', 'summary', '内容', '正文']);
}

function collectLoreEntries(field: string, raw: unknown, warnings: string[]): DiceFrameLoreEntry[] {
  if (typeof raw === 'string') {
    return raw.trim().length > 0 ? [{ source: field, keys: [], content: raw.trim() }] : [];
  }
  if (Array.isArray(raw)) {
    const entries: DiceFrameLoreEntry[] = [];
    raw.forEach((value, index) => {
      if (typeof value === 'string') {
        if (value.trim().length > 0) entries.push({ source: field, keys: [], content: value.trim() });
        return;
      }
      if (!isRecord(value)) {
        warnings.push(`外部卡世界书字段「${field}」第 ${index + 1} 条不是字符串/对象，已跳过`);
        return;
      }
      const content = readLoreContent(value);
      if (content === undefined) {
        warnings.push(`外部卡世界书字段「${field}」第 ${index + 1} 条缺少 content/正文，已跳过`);
        return;
      }
      const title = readStringField(value, ['title', 'name', '标题', '名称']);
      entries.push({
        source: field,
        ...(title !== undefined ? { title } : {}),
        keys: readLoreKeys(value),
        content,
      });
    });
    return entries;
  }
  if (isRecord(raw)) {
    if (Array.isArray(raw.entries)) return collectLoreEntries(field, raw.entries, warnings);
    const content = readLoreContent(raw);
    if (content === undefined) {
      warnings.push(`外部卡世界书字段「${field}」无法解析（缺 content/entries），已跳过`);
      return [];
    }
    const title = readStringField(raw, ['title', 'name', '标题', '名称']);
    return [{ source: field, ...(title !== undefined ? { title } : {}), keys: readLoreKeys(raw), content }];
  }
  warnings.push(`外部卡世界书字段「${field}」格式无法识别，已跳过`);
  return [];
}

function collectPersonalLore(input: Record<string, unknown>, warnings: string[]): DiceFrameLoreEntry[] {
  const entries: DiceFrameLoreEntry[] = [];
  for (const field of LORE_FIELD_NAMES) {
    const raw = input[field];
    if (raw === undefined) continue;
    const parsed = collectLoreEntries(field, raw, warnings);
    if (parsed.length === 0) continue;
    entries.push(...parsed);
    warnings.push(
      `外部卡含世界书片段「${field}」（${parsed.length} 条），没有写入角色卡；请用世界书导入流程单独导入（卡是玩家可见的）`,
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 叙事字段
// ---------------------------------------------------------------------------

function writeTextField(
  fieldById: ReadonlyMap<string, FieldDef>,
  fields: Record<string, string | number>,
  warnings: string[],
  fieldId: string,
  label: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const def = fieldById.get(fieldId);
  if (def === undefined) {
    warnings.push(`外部卡${label}无法映射：目标规则包没有声明字段「${fieldId}」，已丢弃`);
    return;
  }
  if (def.kind !== 'text') {
    warnings.push(`外部卡${label}无法写入：目标规则包字段「${def.name}」（${fieldId}）不是 text 类型（${def.kind}）`);
    return;
  }
  fields[fieldId] = value;
}

/** 外部显式 `fields` 对象 → 目标规则包声明过的同名字段（类型不匹配跳过；不在包里的一律不猜）。 */
function applyExternalFields(
  externalFields: unknown,
  fieldById: ReadonlyMap<string, FieldDef>,
  fields: Record<string, string | number>,
): void {
  if (!isRecord(externalFields)) return;
  for (const [fieldId, value] of Object.entries(externalFields)) {
    const def = fieldById.get(fieldId);
    if (def === undefined) continue;
    if (def.kind === 'text') {
      if (isNonEmptyString(value)) fields[fieldId] = value.trim();
    } else if (def.kind === 'number') {
      if (isFiniteNumber(value)) fields[fieldId] = value;
    } else if (typeof value === 'string' && (def.options ?? []).includes(value)) {
      fields[fieldId] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// 适配入口
// ---------------------------------------------------------------------------

/** 是否是 DiceFrame 角色卡（`schema_version === 2`，或缺少版本时的特征字段嗅探）。 */
export function isDiceFrameCard(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (input.schema_version !== undefined) return input.schema_version === DICEFRAME_SCHEMA_VERSION;
  if (typeof input.character_name !== 'string') return false;
  if (!isRecord(input.attributes)) return false;
  return (
    typeof input.rule_id === 'string' ||
    isRecord(input.identity) ||
    Array.isArray(input.skills) ||
    Array.isArray(input.equipment)
  );
}

/**
 * DiceFrame 角色卡 → 内部卡实例。
 *
 * 纯函数：同输入同规则包 → 同结果（含 `cardId`）；不修改入参。
 * `ok:true` 时返回的 `card` 已通过 `validateCard(rules, card)`。
 */
export function adaptDiceFrameCard(input: unknown, rules: RulePack): DiceFrameAdaptResult {
  const warnings: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['DiceFrame 角色卡必须是 JSON 对象'], warnings };
  }
  const version = input.schema_version;
  if (version !== undefined && version !== DICEFRAME_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`DiceFrame 角色卡 schema_version 必须为整数 2（适配器只认版本 2，当前 ${formatValue(version)}）`],
      warnings,
    };
  }
  if (version === undefined) {
    if (!isDiceFrameCard(input)) {
      return { ok: false, errors: ['不是 DiceFrame 角色卡：缺少 schema_version，且特征字段不足（需要 character_name + attributes 等）'], warnings };
    }
    warnings.push('外部卡缺少 schema_version，按特征字段识别为 DiceFrame 角色卡（建议补 schema_version: 2）');
  }

  const errors: string[] = [];
  const characterName = readStringField(input, ['character_name']);
  if (characterName === undefined) errors.push('DiceFrame 角色卡缺少 character_name（角色名）');
  const rawAttributes = input.attributes;
  if (!isRecord(rawAttributes)) errors.push('DiceFrame 角色卡 attributes 必须是对象（属性 id → 数值）');
  if (errors.length > 0 || characterName === undefined || !isRecord(rawAttributes)) {
    return { ok: false, errors, warnings };
  }

  // ---- 属性 --------------------------------------------------------------
  const attributes: Record<string, number> = {};
  const attributeIndex = buildAliasIndex(rules.sheet.attributes, DICEFRAME_ATTRIBUTE_ALIASES);
  const assignedAttributes = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(rawAttributes)) {
    const attributeId = attributeIndex.get(normalizeKey(rawKey));
    if (attributeId === undefined) {
      warnings.push(`外部卡属性「${rawKey}」在目标规则包没有对应属性，值 ${formatValue(rawValue)} 已丢弃`);
      continue;
    }
    if (assignedAttributes.has(attributeId)) {
      warnings.push(`外部卡属性「${rawKey}」与其它字段重复映射到「${attributeId}」，保留先出现的值`);
      continue;
    }
    if (!isFiniteNumber(rawValue)) {
      const def = rules.sheet.attributes.find((attribute) => attribute.id === attributeId);
      const fallbackValue = def?.default ?? 0;
      warnings.push(`外部卡属性「${rawKey}」不是数值（${formatValue(rawValue)}），使用默认值 ${fallbackValue}`);
      attributes[attributeId] = fallbackValue;
      assignedAttributes.add(attributeId);
      continue;
    }
    attributes[attributeId] = rawValue;
    assignedAttributes.add(attributeId);
  }
  for (const attribute of rules.sheet.attributes) {
    if (attributes[attribute.id] !== undefined) continue;
    attributes[attribute.id] = attribute.default;
    warnings.push(`外部卡没有属性「${attribute.name}」（${attribute.id}），使用默认值 ${attribute.default}`);
  }

  // ---- 叙事字段 / 等级 ---------------------------------------------------
  const fieldById = new Map<string, FieldDef>(rules.sheet.fields.map((field) => [field.id, field]));
  const fields: Record<string, string | number> = {};
  applyExternalFields(input.fields, fieldById, fields);
  const identity = isRecord(input.identity) ? input.identity : undefined;
  const fallback = (keys: readonly string[], identityKeys: readonly string[] = []): string | undefined => {
    const direct = readStringField(input, keys);
    if (direct !== undefined) return direct;
    return identity === undefined ? undefined : readStringField(identity, identityKeys);
  };
  writeTextField(fieldById, fields, warnings, 'name', '姓名', characterName);
  writeTextField(fieldById, fields, warnings, 'race', '种族', fallback(IDENTITY_TEXT_KEYS.race, ['origin']));
  writeTextField(fieldById, fields, warnings, 'class', '职业', fallback(IDENTITY_TEXT_KEYS.class, ['archetype']));
  writeTextField(fieldById, fields, warnings, 'background', '背景', fallback(IDENTITY_TEXT_KEYS.background, ['background']));
  writeTextField(fieldById, fields, warnings, 'publicSummary', '公开摘要', readStringField(input, IDENTITY_TEXT_KEYS.publicSummary));
  writeTextField(fieldById, fields, warnings, 'appearance', '外貌', readStringField(input, IDENTITY_TEXT_KEYS.appearance));
  writeTextField(fieldById, fields, warnings, 'personality', '性格', readStringField(input, IDENTITY_TEXT_KEYS.personality));

  const maxLevel = rules.progression?.maxLevel ?? 20;
  const externalFieldsRaw = isRecord(input.fields) ? input.fields : undefined;
  const rawLevel =
    input.level !== undefined
      ? input.level
      : externalFieldsRaw !== undefined && externalFieldsRaw[LEVEL_FIELD_ID] !== undefined
        ? externalFieldsRaw[LEVEL_FIELD_ID]
        : undefined;
  let level = 1;
  if (isFiniteNumber(rawLevel)) {
    level = Math.max(1, Math.floor(rawLevel));
    if (level > maxLevel) {
      warnings.push(`外部卡等级 ${level} 超过目标规则包 maxLevel=${maxLevel}，已裁剪`);
      level = maxLevel;
    }
  } else if (rawLevel !== undefined) {
    warnings.push(`外部卡 level 不是数值（${formatValue(rawLevel)}），按 1 级适配`);
  }
  const levelDef = fieldById.get(LEVEL_FIELD_ID);
  if (levelDef !== undefined && levelDef.kind !== 'number') {
    warnings.push(`目标规则包字段「${LEVEL_FIELD_ID}」不是 number 类型，等级未写入卡 fields（公式 level 将按 1 计算）`);
  } else {
    fields[LEVEL_FIELD_ID] = level;
  }

  // ---- 资源 --------------------------------------------------------------
  const resourceEntries = buildResourceAliasEntries(rules);
  const candidates = collectExternalResourceCandidates(input, warnings);
  const matchedResources = matchExternalResources(candidates, resourceEntries, warnings);
  const resourceContext: FormulaContext = {
    attr: attributes,
    derived: {},
    equip: {},
    level,
    proficiency: 2,
    skill: {},
    sheet: Object.fromEntries(
      Object.entries(fields).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    ),
    resource: {},
  };
  const resources: Record<string, CardResourceState> = {};
  const resourceMax: Record<string, number> = {};
  for (const resource of rules.sheet.resources) {
    const external = matchedResources.get(resource.id) ?? {};
    let formulaMax: number | undefined;
    let formulaError: string | undefined;
    if (external.current === undefined || external.max === undefined) {
      const evaluated = evaluateResourceMaxFormula(rules, resource.formula, {
        ...resourceContext,
        resource: { ...resourceMax },
      });
      if (evaluated.ok) formulaMax = evaluated.value;
      else formulaError = evaluated.error;
    }
    let current = external.current;
    if (current === undefined) {
      if (formulaMax !== undefined) {
        current = formulaMax;
        warnings.push(`外部卡资源「${resource.name}」（${resource.id}）没有外部当前值，按上限公式结果 ${formulaMax} 作为当前值`);
      } else if (external.max !== undefined) {
        current = external.max;
        warnings.push(`外部卡资源「${resource.name}」（${resource.id}）只有外部上限 ${external.max}，当前值按上限处理`);
      } else {
        current = 0;
        warnings.push(
          `外部卡资源「${resource.name}」（${resource.id}）没有外部当前值，且上限公式「${resource.formula}」无法求值${formulaError !== undefined ? `（${formulaError}）` : ''}，当前值按 0 处理`,
        );
      }
    }
    const max = formulaMax ?? external.max;
    const state: CardResourceState = { current, ...(max !== undefined ? { max } : {}) };
    resources[resource.id] = state;
    if (max !== undefined) resourceMax[resource.id] = max;
  }

  // ---- 技能 --------------------------------------------------------------
  const externalSkills = parseExternalSkills(input.skills, warnings);
  const skills = buildSkillStates(rules, externalSkills, warnings);

  // ---- 装备 / 物品 -------------------------------------------------------
  const externalItems = collectExternalItems(input, warnings);
  const equipmentInstances = buildEquipmentInstances(rules, externalItems, warnings);

  // ---- 关键物品 / 货币（内部卡无对应字段，给 warning 不猜测） -------------
  const keyItems = Array.isArray(input.key_items)
    ? input.key_items.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
    : [];
  if (keyItems.length > 0) {
    warnings.push(`外部卡关键物品（${keyItems.join('、')}）没有映射：内部卡模型没有关键物品字段，已忽略`);
  }
  const currency = isRecord(input.currency) ? readNumberField(input.currency, ['amount']) : undefined;
  const gold = readNumberField(input, ['gold']) ?? currency;
  if (gold !== undefined && gold > 0) {
    warnings.push(`外部卡货币（${gold}）没有映射：内部卡模型没有货币字段，已忽略`);
  }

  // ---- 世界书（不写卡） --------------------------------------------------
  const personalLore = collectPersonalLore(input, warnings);

  // ---- 来源 / cardId -----------------------------------------------------
  const externalRuleId = readStringField(input, ['rule_id', 'ruleId']);
  const externalRuleName = readStringField(input, ['rule_name', 'ruleName']);
  const externalRuleVersion = readStringField(input, ['rule_version', 'ruleVersion']);
  const origin = { packId: externalRuleId !== undefined ? `diceframe:${externalRuleId}` : 'diceframe' };
  if (externalRuleId !== undefined) {
    if (externalRuleId !== rules.rulesId) {
      warnings.push(
        `外部卡规则「${externalRuleName ?? externalRuleId}${externalRuleVersion !== undefined ? ` ${externalRuleVersion}` : ''}」与目标规则包「${rules.name}」（${rules.rulesId}）不同，已按目标规则包适配（来源记为「${origin.packId}」）`,
      );
    } else if (externalRuleVersion !== undefined && externalRuleVersion !== rules.rulesVersion) {
      warnings.push(`外部卡规则版本 ${externalRuleVersion} 与目标规则包版本 ${rules.rulesVersion} 不同，已按目标版本适配`);
    }
  }

  const card: CardInstance = {
    schemaVersion: CARD_SCHEMA_VERSION,
    cardId: deriveCardId(input, rules),
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    attributes,
    resources,
    fields,
    equipmentInstances,
    skills,
    statuses: [],
    origin,
  };
  const validationErrors = validateCard(rules, card);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      errors: validationErrors.map((message) => `适配结果未通过卡校验：${message}`),
      warnings,
    };
  }
  return { ok: true, card, warnings, personalLore };
}

/**
 * 适配 DiceFrame 卡并输出可直接入包/入本地卡库的卡 JSON。
 *
 * `ok:true` 时 `card` 是内部卡实例、`json` 是同一张卡的 JSON 文本（缩进 2、结尾换行），
 * 已带 `origin`（`diceframe:<rule_id>`）与稳定 `cardId`；`ok:false` 时不产出 JSON。
 */
export function diceFrameToRulesCardJson(input: unknown, rules: RulePack): DiceFrameCardJsonResult {
  const adapted = adaptDiceFrameCard(input, rules);
  if (!adapted.ok) return adapted;
  return {
    ...adapted,
    json: `${JSON.stringify(adapted.card, null, 2)}\n`,
  };
}
