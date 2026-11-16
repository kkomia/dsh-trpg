/**
 * DiceFrame 角色卡（`schema_version: 2`）→ 玩家本地卡库（engine `CharacterCard`）导入适配（M9.6b 客户端）。
 *
 * 为什么不直接存适配器返回的 `trpg.card/1` 卡实例：本地卡库（`cards.ts`，localStorage
 * `dsh-trpg:cards:v1`）与落座上传路径都用 engine 旧形状（`CharacterCard`）；房间内如果配了规则包，
 * host 会用自己的 `migrateLegacyCard` 把它迁成卡实例（M9.4 已实现）。所以这里做一层
 * 「卡实例 → engine 卡」的最小映射：身份/六属性/技能熟练/资源上限/攻击/背包/叙事字段。
 *
 * 规则数据来自当前内容工坊选中的内容包（`pack.rules`，缺省内置包 dnd5e-lite）；
 * 没有 rules 段时无法做字段映射，直接给可读错误。**不读文件、不联网、零新增依赖**。
 */
import {
  isDiceFrameCard,
  adaptDiceFrameCard,
  DICEFRAME_ATTRIBUTE_ALIASES,
  DICEFRAME_RESOURCE_ALIASES,
  type DiceFrameLoreEntry,
} from '../../../rules/src/adapters/diceframe.ts';
import { cardLevel } from '../../../rules/src/sheet.ts';
import type { CardInstance, RulePack } from '../../../rules/src/types.ts';
import {
  ABILITIES,
  SKILL_ABILITY,
  validateCharacterCard,
  type Ability,
  type AttackProfile,
  type CharacterCard,
  type SkillId,
} from '@dsh-trpg/engine';

export type DiceFrameImportResult =
  | {
      ok: true;
      /** 可直接存进本地卡库的 engine 卡（id 稳定：`diceframe-<hash>`）。 */
      card: CharacterCard;
      warnings: string[];
      /** 卡内世界书片段：卡里不放（有 GM 可见性规则），提示另导到世界书。 */
      personalLore: DiceFrameLoreEntry[];
      rulesId: string;
      rulesVersion: string;
    }
  | { ok: false; errors: string[]; warnings: string[] };

/** 外部 JSON 是否是 DiceFrame 角色卡（含 `schema_version` 缺失时的特征嗅探）。 */
export function isDiceFrameJson(raw: unknown): boolean {
  return isDiceFrameCard(raw);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_\-:：·.]+/g, '');
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

function stringField(card: CardInstance, id: string): string | undefined {
  const value = card.fields[id];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 卡实例属性 → engine 六属性（规则属性 id/name 命中别名表时映射；否则默认 10）。 */
function engineAbilities(rules: RulePack, card: CardInstance): Record<Ability, number> {
  const scores = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const direct = card.attributes[ability];
    if (typeof direct === 'number' && Number.isFinite(direct)) {
      scores[ability] = clampNumber(direct, 1, 30);
      continue;
    }
    const aliases = new Set((DICEFRAME_ATTRIBUTE_ALIASES[ability] ?? []).map(normalizeKey));
    const declared = rules.sheet.attributes.find(
      (attribute) => aliases.has(normalizeKey(attribute.id)) || aliases.has(normalizeKey(attribute.name)),
    );
    const value = declared === undefined ? undefined : card.attributes[declared.id];
    scores[ability] = typeof value === 'number' && Number.isFinite(value) ? clampNumber(value, 1, 30) : 10;
  }
  return scores;
}

/** 卡实例资源 → HP 上限（按规则 resources 的 hp 别名匹配；没有则按体质估算）。 */
function hpMaxOf(rules: RulePack, card: CardInstance, constitutionModifier: number, level: number): number {
  const aliases = new Set((DICEFRAME_RESOURCE_ALIASES.hp ?? []).map(normalizeKey));
  const hpDef = rules.sheet.resources.find(
    (resource) => aliases.has(normalizeKey(resource.id)) || aliases.has(normalizeKey(resource.name)),
  );
  const state = hpDef === undefined ? undefined : card.resources[hpDef.id];
  if (state !== undefined && typeof state.max === 'number' && Number.isFinite(state.max)) {
    return clampNumber(state.max, 1, 999);
  }
  if (state !== undefined && typeof state.current === 'number' && Number.isFinite(state.current)) {
    return clampNumber(state.current, 1, 999);
  }
  return clampNumber(8 + constitutionModifier + (level - 1) * 5, 1, 999);
}

/** 规则包攻击动作 → engine 攻击档案（最多 3 条；没有攻击动作时给一条徒手）。 */
function attacksOf(rules: RulePack, scores: Record<Ability, number>): AttackProfile[] {
  const ability: Ability = scores.str >= scores.dex ? 'str' : 'dex';
  const attacks: AttackProfile[] = rules.actions
    .filter((action) => action.kind === 'attack')
    .slice(0, 3)
    .map((action) => {
      const dice = action.damage?.dice ?? '1d6';
      const range = action.targeting?.range;
      return {
        name: action.name,
        ability,
        proficient: true,
        damage: /^\d+d\d+([+-]\d+)?$/i.test(dice) ? dice : '1d6',
        range: range === 'near' || range === 'far' ? range : 'engaged',
      } satisfies AttackProfile;
    });
  if (attacks.length === 0) {
    attacks.push({ name: '徒手攻击', ability, proficient: true, damage: '1d2', range: 'engaged' });
  }
  return attacks;
}

/** 装备实例 → 背包条目（按名字合并数量）。 */
function inventoryOf(card: CardInstance): Array<{ name: string; qty: number; effect?: string }> {
  const byName = new Map<string, { name: string; qty: number; effect?: string }>();
  for (const instance of card.equipmentInstances) {
    const rawName = typeof instance.name === 'string' ? instance.name.trim() : '';
    const name = rawName.length > 0 ? rawName : '未命名装备';
    const existing = byName.get(name);
    if (existing !== undefined) {
      existing.qty += 1;
      continue;
    }
    const note = typeof instance.note === 'string' && instance.note.trim().length > 0 ? instance.note.trim() : undefined;
    byName.set(name, { name, qty: 1, ...(note !== undefined ? { effect: note } : {}) });
  }
  return [...byName.values()];
}

/**
 * 卡实例 → engine 本地卡（纯函数；输出经 `validateCharacterCard` 兜底校验）。
 * 调用方通常是 `importDiceFrameAsLocalCard`；单独导出便于单测。
 */
export function cardInstanceToLocalCard(
  card: CardInstance,
  rules: RulePack,
): { ok: true; card: CharacterCard } | { ok: false; errors: string[] } {
  const level = clampNumber(cardLevel(card), 1, 20);
  const scores = engineAbilities(rules, card);
  const activeSkills = card.skills
    .filter((skill) => skill.proficient === true && skill.id in SKILL_ABILITY)
    .map((skill) => skill.id as SkillId);
  const attacks = attacksOf(rules, scores);
  const publicSummary = stringField(card, 'publicSummary') ?? '';
  const appearance = stringField(card, 'appearance');
  const personality = stringField(card, 'personality');
  const background = stringField(card, 'background');
  const localCard: CharacterCard = {
    schemaVersion: 1,
    id: card.cardId,
    identity: {
      name: stringField(card, 'name') ?? card.cardId,
      race: stringField(card, 'race') ?? '未知种族',
      class: stringField(card, 'class') ?? '冒险者',
      level,
      ...(background !== undefined ? { background } : {}),
    },
    abilities: scores,
    proficiency: {
      bonus: clampNumber(2 + Math.floor((level - 1) / 4), 2, 9),
      skills: activeSkills,
      saves: [],
    },
    combat: {
      ac: clampNumber(10 + abilityModifier(scores.dex), 1, 40),
      hpMax: hpMaxOf(rules, card, abilityModifier(scores.con), level),
      initiativeBonus: abilityModifier(scores.dex),
      attacks,
    },
    inventory: inventoryOf(card),
    publicSummary,
    ...(appearance !== undefined ? { appearance } : {}),
    ...(personality !== undefined ? { personality } : {}),
    source: { ruleId: card.rulesId, ruleVersion: card.rulesVersion, moduleId: null },
  };
  const report = validateCharacterCard(localCard);
  if (!report.ok || !report.value) {
    return { ok: false, errors: report.errors.map((error) => `本地卡校验失败：${error}`) };
  }
  return { ok: true, card: report.value };
}

/**
 * 导入入口：外部 JSON（已 `JSON.parse`）→ 检测 DiceFrame → 适配 → 本地卡。
 * 失败返回可读中文错误（不是 DiceFrame / 版本不对 / 映射失败）。
 */
export function importDiceFrameAsLocalCard(raw: unknown, rules: RulePack | null | undefined): DiceFrameImportResult {
  if (rules === null || rules === undefined) {
    return { ok: false, errors: ['当前内容包没有 rules 段：无法把 DiceFrame 卡映射到规则字段（请选择带规则的包，如内置 core-guimuya）'], warnings: [] };
  }
  if (!isDiceFrameCard(raw)) {
    return {
      ok: false,
      errors: ['不是 DiceFrame 角色卡（需要 schema_version: 2；普通 trpg.card JSON 请用「导入卡 JSON」入口）'],
      warnings: [],
    };
  }
  const adapted = adaptDiceFrameCard(raw, rules);
  if (!adapted.ok) return { ok: false, errors: adapted.errors, warnings: adapted.warnings };
  const converted = cardInstanceToLocalCard(adapted.card, rules);
  if (!converted.ok) return { ok: false, errors: converted.errors, warnings: adapted.warnings };
  return {
    ok: true,
    card: converted.card,
    warnings: adapted.warnings,
    personalLore: adapted.personalLore,
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
  };
}

/** 文本入口（UI 文件/粘贴框）：JSON 解析失败也给可读中文。 */
export function importDiceFrameText(text: string, rules: RulePack | null | undefined): DiceFrameImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['不是合法的 JSON 文本（无法解析）'], warnings: [] };
  }
  return importDiceFrameAsLocalCard(parsed, rules);
}
