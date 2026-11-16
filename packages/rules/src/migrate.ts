/**
 * 旧 engine 角色卡（`CharacterCard` schemaVersion: 1）→ 新卡实例（`trpg.card/1`）。
 *
 * 映射口径（docs/RULES-MODEL §11.2）：
 * - `abilities` → `attributes`（同名 id；超出新规则范围会裁剪并 warning）
 * - `combat.hpMax` → `resources.hp.current`（max 只是缓存，一并写 hpMax）
 * - `identity.level` → `fields.level`（公式变量 `level` 的来源，卡 schema 本身没有 level 字段）
 * - `inventory` → `equipmentInstances`（按 `rules.items[]` 的 name/itemId 匹配词条/槽位，
 *   匹配不到时退到 `accepts: ["*"]` 的通配槽位；仍无法映射 → warning）
 * - `proficiency.skills` → `skills[{ id, proficient }]`
 * - `combat.ac` / `hpMax` 派生值 → 丢弃（AC 由公式 + 装备重算；HP 上限由公式重算）
 * - `spells.slots` → 规则包声明了 `mana` 资源时折算为 current，否则 warning
 * - `source` → `origin`（保留旧引用，便于追查）
 * - 身份/摘要/外貌/性格 → `fields`（规则包声明了同名 text 字段才写，否则 warning）
 */
import {
  CARD_SCHEMA_VERSION,
  LEVEL_FIELD_ID,
  type CardInstance,
  type CardResourceState,
  type CardSkillState,
  type EquipmentInstanceDef,
  type LegacyCharacterCard,
  type MigrateResult,
  type RulePack,
  type RulePackItemDef,
} from './types.ts';
import { validateCard } from './sheet.ts';

/** 旧卡 HP 迁移到的约定资源 id。 */
export const LEGACY_HP_RESOURCE_ID = 'hp';
/** 旧卡法术位迁移到的约定资源 id。 */
export const LEGACY_MANA_RESOURCE_ID = 'mana';

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
  return typeof value === 'string' && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function totalSpellSlots(slots: Record<string, unknown> | undefined): number {
  if (slots === undefined) return 0;
  let total = 0;
  for (const value of Object.values(slots)) {
    if (isFiniteNumber(value) && value > 0) total += Math.floor(value);
  }
  return total;
}

function slotAcceptsTags(slotAccepts: readonly string[], tags: readonly string[]): boolean {
  if (slotAccepts.includes('*')) return true;
  return tags.some((tag) => slotAccepts.includes(tag));
}

/**
 * 迁移旧卡。`ok=true` 时 `card` 必须通过 `validateCard(rules, card)`；
 * 无法映射的信息进 `warnings`（人话中文），硬错误进 `errors`。
 */
export function migrateLegacyCard(legacy: unknown, rules: RulePack): MigrateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(legacy)) {
    return { ok: false, errors: ['旧卡必须是对象'], warnings };
  }
  if (legacy.schemaVersion !== 1) {
    return { ok: false, errors: ['旧卡 schemaVersion 必须为 1（engine CharacterCard）'], warnings };
  }
  const legacyId = isNonEmptyString(legacy.id) ? legacy.id : undefined;
  if (legacyId === undefined) errors.push('旧卡 id 必填且必须是非空字符串');
  const abilities = asRecord(legacy.abilities);
  if (abilities === undefined) errors.push('旧卡 abilities 必须是对象');
  if (errors.length > 0) return { ok: false, errors, warnings };
  const source = legacy as unknown as LegacyCharacterCard;
  const legacyAbilities = abilities ?? {};

  // ---- 属性 --------------------------------------------------------------
  const attributes: Record<string, number> = {};
  const declaredAttributeIds = new Set(rules.sheet.attributes.map((attribute) => attribute.id));
  for (const attribute of rules.sheet.attributes) {
    const raw = legacyAbilities[attribute.id];
    if (isFiniteNumber(raw)) {
      let value = raw;
      if (value < attribute.min) {
        warnings.push(`属性「${attribute.name}」（${attribute.id}）=${value} 低于新规则下限 ${attribute.min}，已裁剪为 ${attribute.min}`);
        value = attribute.min;
      } else if (value > attribute.max) {
        warnings.push(`属性「${attribute.name}」（${attribute.id}）=${value} 高于新规则上限 ${attribute.max}，已裁剪为 ${attribute.max}`);
        value = attribute.max;
      }
      attributes[attribute.id] = value;
    } else if (raw !== undefined) {
      warnings.push(`旧卡属性「${attribute.id}」不是数值，使用默认值 ${attribute.default}`);
      attributes[attribute.id] = attribute.default;
    } else {
      warnings.push(`旧卡没有属性「${attribute.name}」（${attribute.id}），使用默认值 ${attribute.default}`);
      attributes[attribute.id] = attribute.default;
    }
  }
  for (const [abilityId, value] of Object.entries(legacyAbilities)) {
    if (declaredAttributeIds.has(abilityId)) continue;
    if (isFiniteNumber(value)) {
      warnings.push(`旧卡属性「${abilityId}」在新规则包中没有对应属性，值 ${value} 已丢弃`);
    }
  }

  // ---- 等级 / 身份 / 摘要 → fields ---------------------------------------
  const fields: Record<string, string | number> = {};
  const fieldById = new Map(rules.sheet.fields.map((field) => [field.id, field]));
  const identity = asRecord(legacy.identity);
  const writeTextField = (fieldId: string, raw: unknown, label: string): void => {
    if (!isNonEmptyString(raw)) return;
    const def = fieldById.get(fieldId);
    if (def === undefined) {
      warnings.push(`旧卡 ${label}（${fieldId}）无法映射：规则包没有声明字段「${fieldId}」`);
      return;
    }
    if (def.kind !== 'text') {
      warnings.push(`旧卡 ${label}（${fieldId}）无法写入：规则包字段不是 text 类型（${def.kind}）`);
      return;
    }
    fields[fieldId] = raw;
  };
  const rawLevel = identity?.level;
  const maxLevel = rules.progression?.maxLevel ?? 20;
  let level = isFiniteNumber(rawLevel) && rawLevel >= 1 ? Math.floor(rawLevel) : 1;
  if (rawLevel !== undefined && (!isFiniteNumber(rawLevel) || rawLevel < 1)) {
    warnings.push(`旧卡 identity.level 非法（${String(rawLevel)}），按 1 级迁移`);
  }
  if (level > maxLevel) {
    warnings.push(`旧卡等级 ${level} 超过规则包 maxLevel=${maxLevel}，已裁剪`);
    level = maxLevel;
  }
  const levelDef = fieldById.get(LEVEL_FIELD_ID);
  if (levelDef !== undefined && levelDef.kind !== 'number') {
    warnings.push(`规则包字段「${LEVEL_FIELD_ID}」不是 number 类型，等级未写入卡 fields（公式 level 将按 1 计算）`);
  } else {
    fields[LEVEL_FIELD_ID] = level;
  }
  if (identity !== undefined) {
    writeTextField('name', identity.name, 'identity.name');
    writeTextField('race', identity.race, 'identity.race');
    writeTextField('class', identity.class, 'identity.class');
    writeTextField('background', identity.background, 'identity.background');
  }
  writeTextField('publicSummary', source.publicSummary, 'publicSummary');
  writeTextField('appearance', source.appearance, 'appearance');
  writeTextField('personality', source.personality, 'personality');

  // ---- 资源 --------------------------------------------------------------
  const resources: Record<string, CardResourceState> = {};
  const declaredResourceIds = new Set(rules.sheet.resources.map((resource) => resource.id));
  const hpMax = isRecord(legacy.combat) && isPositiveInteger(legacy.combat.hpMax) ? legacy.combat.hpMax : undefined;
  const hpResource = rules.sheet.resources.find((resource) => resource.id === LEGACY_HP_RESOURCE_ID);
  if (hpResource !== undefined) {
    if (hpMax !== undefined) {
      resources[hpResource.id] = { current: hpMax, max: hpMax };
    } else {
      warnings.push('旧卡没有合法 combat.hpMax，生命当前值按 0 迁移');
      resources[hpResource.id] = { current: 0 };
    }
  } else if (hpMax !== undefined) {
    warnings.push(`旧卡 combat.hpMax（${hpMax}）无法映射：规则包没有 "${LEGACY_HP_RESOURCE_ID}" 资源`);
  }
  const legacySpells = asRecord(legacy.spells);
  const manaResource = rules.sheet.resources.find((resource) => resource.id === LEGACY_MANA_RESOURCE_ID);
  const spellSlotCount = totalSpellSlots(asRecord(legacySpells?.slots));
  if (manaResource !== undefined) {
    resources[manaResource.id] = { current: spellSlotCount };
    if (spellSlotCount > 0) warnings.push(`旧卡法术位已折算为资源「${manaResource.name}」（${LEGACY_MANA_RESOURCE_ID}）当前值 ${spellSlotCount}（法术环位细节已丢失）`);
  } else if (spellSlotCount > 0) {
    const slotSummary = Object.entries(asRecord(legacySpells?.slots) ?? {})
      .filter(([, value]) => isFiniteNumber(value) && value > 0)
      .map(([ring, value]) => `${ring} 环 ×${String(value)}`)
      .join('、');
    warnings.push(`旧卡法术位（${slotSummary}）无法映射：规则包没有 "${LEGACY_MANA_RESOURCE_ID}" 资源`);
  }
  if (Array.isArray(legacySpells?.known) && legacySpells.known.length > 0) {
    warnings.push(`旧卡已知法术列表（${legacySpells.known.join(', ')}）已丢弃：新模型由 rules.actions[] 的 kind=spell 派生`);
  }
  for (const resource of rules.sheet.resources) {
    if (resources[resource.id] !== undefined) continue;
    if (!declaredResourceIds.has(resource.id)) continue;
    resources[resource.id] = { current: 0 };
    warnings.push(`资源「${resource.name}」（${resource.id}）没有旧卡来源，当前值按 0 迁移`);
  }

  // ---- 技能 --------------------------------------------------------------
  const legacySkills = Array.isArray(source.proficiency?.skills) ? source.proficiency.skills : [];
  const declaredSkillIds = new Set(rules.sheet.skills.map((skill) => skill.id));
  const skills: CardSkillState[] = rules.sheet.skills.map((skill) => ({
    id: skill.id,
    proficient: legacySkills.includes(skill.id),
    bonus: 0,
  }));
  for (const legacySkillId of legacySkills) {
    if (typeof legacySkillId !== 'string') continue;
    if (!declaredSkillIds.has(legacySkillId)) {
      warnings.push(`旧卡技能熟练「${legacySkillId}」在新规则包中没有对应技能，已丢弃`);
    }
  }
  const legacySaves = Array.isArray(source.proficiency?.saves) ? source.proficiency.saves : [];
  if (legacySaves.length > 0) {
    warnings.push(`旧卡豁免熟练（${legacySaves.join('/')}）在规则包模型中没有对应字段，已丢弃（豁免改为 formulas 计算）`);
  }

  // ---- 背包 → 装备实例 ---------------------------------------------------
  const equipmentInstances: EquipmentInstanceDef[] = [];
  const slots = rules.sheet.equipment.slots;
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const slotUsage = new Map<string, number>();
  const items = rules.items ?? [];
  const itemByName = new Map<string, RulePackItemDef>();
  for (const item of items) {
    itemByName.set(item.itemId, item);
    if (!itemByName.has(item.name)) itemByName.set(item.name, item);
  }
  const findSlot = (item: RulePackItemDef | undefined): string | undefined => {
    if (item !== undefined && Array.isArray(item.equipSlot)) {
      for (const slotId of item.equipSlot) {
        const slot = slotById.get(slotId);
        if (slot !== undefined && slotAcceptsTags(slot.accepts, item.tags ?? [])) return slot.id;
      }
    }
    const tags = item?.tags ?? [];
    const matched = slots.find((slot) => slotAcceptsTags(slot.accepts, tags));
    return matched?.id;
  };
  const inventory = Array.isArray(source.inventory) ? source.inventory : [];
  inventory.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`旧卡 inventory[${index}] 不是对象，已跳过`);
      return;
    }
    const name = isNonEmptyString(entry.name) ? entry.name : undefined;
    if (name === undefined) {
      warnings.push(`旧卡 inventory[${index}] 没有物品名，已跳过`);
      return;
    }
    const qty = isPositiveInteger(entry.qty) ? entry.qty : 1;
    const effect = typeof entry.effect === 'string' && entry.effect.length > 0 ? entry.effect : undefined;
    const itemDef = itemByName.get(name);
    const slotId = findSlot(itemDef);
    if (slotId === undefined) {
      if (itemDef === undefined) {
        warnings.push(`旧卡物品「${name}」无法映射：规则包 items[] 没有该物品且没有 accepts:["*"] 的通配槽位，已丢弃`);
      } else {
        warnings.push(`旧卡物品「${name}」无法映射：没有可接受其标签 [${(itemDef.tags ?? []).join(', ')}] 的装备槽，已丢弃`);
      }
      return;
    }
    const slot = slotById.get(slotId);
    if (slot === undefined) return;
    const limit = slot.count ?? 1;
    const used = slotUsage.get(slotId) ?? 0;
    const remaining = Math.max(0, limit - used);
    if (remaining === 0) {
      warnings.push(`旧卡物品「${name}」未能迁移：装备槽「${slot.name}」（${slotId}）已满 ${limit} 件`);
      return;
    }
    const count = Math.min(qty, remaining);
    if (count < qty) {
      warnings.push(`旧卡物品「${name}」数量 ${qty}，装备槽「${slot.name}」只剩 ${remaining} 件，已迁移 ${count} 件`);
    }
    if (itemDef === undefined) {
      warnings.push(`旧卡物品「${name}」不在规则包 items[] 中，已按通配槽位「${slot.name}」迁移（无词条${effect !== undefined ? `，效果文本「${effect}」以备注保留` : ''}）`);
    }
    for (let copy = 0; copy < count; copy += 1) {
      const instance: EquipmentInstanceDef = {
        instanceId: `ins_${equipmentInstances.length + 1}`,
        slot: slotId,
        name: itemDef?.name ?? name,
        tags: [...(itemDef?.tags ?? [])],
        stats: { ...(itemDef?.stats ?? {}) },
        ...(effect !== undefined ? { note: effect } : itemDef?.description !== undefined ? { note: itemDef.description } : {}),
      };
      equipmentInstances.push(instance);
      slotUsage.set(slotId, (slotUsage.get(slotId) ?? 0) + 1);
    }
  });
  if (inventory.length === 0) {
    // 旧卡没背包不是问题，不产生 warning
  }

  // ---- 来源 → origin -----------------------------------------------------
  let origin: CardInstance['origin'];
  if (isRecord(legacy.source)) {
    const ruleId = isNonEmptyString(legacy.source.ruleId) ? legacy.source.ruleId : undefined;
    const moduleId = isNonEmptyString(legacy.source.moduleId) ? legacy.source.moduleId : undefined;
    if (ruleId !== undefined) {
      origin = { packId: ruleId, ...(moduleId !== undefined ? { moduleId } : {}) };
      const legacyRuleVersion = isNonEmptyString(legacy.source.ruleVersion) ? legacy.source.ruleVersion : undefined;
      if (legacyRuleVersion !== undefined && legacyRuleVersion !== rules.rulesVersion) {
        warnings.push(`旧卡规则版本 ${legacyRuleVersion} 与目标规则包版本 ${rules.rulesVersion} 不同，已按目标版本迁移`);
      }
    }
  }

  // ---- 组装 --------------------------------------------------------------
  const card: CardInstance = {
    schemaVersion: CARD_SCHEMA_VERSION,
    cardId: legacyId as string,
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    attributes,
    resources,
    fields,
    equipmentInstances,
    skills,
    statuses: [],
    ...(origin !== undefined ? { origin } : {}),
  };
  const validationErrors = validateCard(rules, card);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      card,
      errors: validationErrors.map((message) => `迁移结果未通过卡校验：${message}`),
      warnings,
    };
  }
  return { ok: true, card, errors, warnings };
}
