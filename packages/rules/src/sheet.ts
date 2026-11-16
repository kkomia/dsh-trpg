/**
 * 卡实例（`trpg.card/1`）校验 + 卡面投影 DTO。
 *
 * 两条硬规则（docs/RULES-MODEL §4）：
 * - 卡只存「角色自己拥有的数据」；派生值（AC/HP 上限/命中/技能总加值/词条聚合）一律由主机实时算；
 * - 客户端只渲染投影，本文件产出的 `SheetProjection` 即主机算好的只读 DTO。
 *
 * M9.1 不做 `tickTime` / `advanceRound`（回合推进与钩子调度属于 M9.2 核心运行时）。
 */
import { compileFormula, evaluateFormula, type FormulaContext } from './formula.ts';
import {
  CARD_SCHEMA_VERSION,
  LEVEL_FIELD_ID,
  type ActionCostProjection,
  type ActionDef,
  type ActionProjection,
  type AttributeProjection,
  type CardInstance,
  type CardResourceState,
  type CardSkillState,
  type CardStatusState,
  type EquipmentInstanceDef,
  type EquipmentItemProjection,
  type EquipmentProjection,
  type EquipmentSlotProjection,
  type EquipmentStatTotalProjection,
  type EquipmentStatTrace,
  type EquipmentStatTracePart,
  type InventoryProjection,
  type ResourceProjection,
  type RulePack,
  type SheetProjection,
  type SkillProjection,
  type StatusProjection,
} from './types.ts';

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

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 卡 `fields.level` → 公式变量 `level`（缺省按 1 级）。 */
export function cardLevel(card: Pick<CardInstance, 'fields'>): number {
  const raw = card.fields[LEVEL_FIELD_ID];
  return isFiniteNumber(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

// ---------------------------------------------------------------------------
// validateCard
// ---------------------------------------------------------------------------

/**
 * 按规则包校验卡实例；返回中文错误数组（空数组 = 通过）。
 * 这是 host 侧的「schema + 数值范围」兜底；`validateSheet` 钩子（M9.2）在其后叠加规则逻辑。
 */
export function validateCard(rules: RulePack, card: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(card)) return ['角色卡必须是对象'];
  if (card.schemaVersion !== CARD_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须为 "${CARD_SCHEMA_VERSION}"`);
  }
  const cardId = isNonEmptyString(card.cardId) ? card.cardId : undefined;
  if (cardId === undefined) errors.push('cardId 必填且必须是非空字符串');
  if (!isNonEmptyString(card.rulesId)) {
    errors.push('rulesId 必填且必须是非空字符串');
  } else if (card.rulesId !== rules.rulesId) {
    errors.push(`rulesId 与规则包不一致（卡：${card.rulesId}，规则包：${rules.rulesId}）`);
  }
  if (!isNonEmptyString(card.rulesVersion)) {
    errors.push('rulesVersion 必填且必须是非空字符串');
  }

  // 属性：声明过的必须存在且在范围内
  const attributes = card.attributes;
  if (!isRecord(attributes)) {
    errors.push('attributes 必须是对象（属性 id → 数值）');
  } else {
    const declared = new Set(rules.sheet.attributes.map((attribute) => attribute.id));
    for (const attribute of rules.sheet.attributes) {
      const value = attributes[attribute.id];
      if (value === undefined) {
        errors.push(`缺少属性「${attribute.name}」（${attribute.id}）`);
        continue;
      }
      if (!isFiniteNumber(value)) {
        errors.push(`属性「${attribute.name}」（${attribute.id}）必须是数值`);
        continue;
      }
      if (value < attribute.min || value > attribute.max) {
        errors.push(`属性「${attribute.name}」（${attribute.id}）=${value} 超出规则范围 [${attribute.min}, ${attribute.max}]`);
      }
    }
    for (const key of Object.keys(attributes)) {
      if (!declared.has(key)) errors.push(`未声明的属性「${key}」`);
    }
  }

  // 资源：current 是唯一运行态
  const resources = card.resources;
  if (!isRecord(resources)) {
    errors.push('resources 必须是对象（资源 id → { current, max? }）');
  } else {
    const declared = new Set(rules.sheet.resources.map((resource) => resource.id));
    for (const resource of rules.sheet.resources) {
      const state = resources[resource.id];
      if (state === undefined) {
        errors.push(`缺少资源「${resource.name}」（${resource.id}）的当前值`);
        continue;
      }
      if (!isRecord(state)) {
        errors.push(`资源「${resource.name}」（${resource.id}）必须是 { current, max? } 对象`);
        continue;
      }
      if (!isFiniteNumber(state.current)) {
        errors.push(`资源「${resource.name}」（${resource.id}）的 current 必须是数值`);
      } else if (state.current < 0) {
        errors.push(`资源「${resource.name}」（${resource.id}）的 current 不能为负数（当前 ${state.current}）`);
      }
      if (state.max !== undefined && !isFiniteNumber(state.max)) {
        errors.push(`资源「${resource.name}」（${resource.id}）的 max 必须是数值`);
      }
    }
    for (const key of Object.keys(resources)) {
      if (!declared.has(key)) errors.push(`未声明的资源「${key}」`);
    }
  }

  // 自由字段：只校验声明过的字段的类型/枚举值；未知字段容忍（迁移会写 level 等约定键）
  if (card.fields !== undefined && !isRecord(card.fields)) {
    errors.push('fields 必须是对象（字段 id → 文本/数值）');
  } else if (isRecord(card.fields)) {
    for (const field of rules.sheet.fields) {
      const value = card.fields[field.id];
      if (value === undefined) continue;
      if (field.kind === 'text') {
        if (typeof value !== 'string') errors.push(`字段「${field.name}」（${field.id}）必须是文本`);
      } else if (field.kind === 'number') {
        if (!isFiniteNumber(value)) errors.push(`字段「${field.name}」（${field.id}）必须是数值`);
      } else if (field.kind === 'enum') {
        const options = field.options ?? [];
        if (typeof value !== 'string' || !options.includes(value)) {
          errors.push(`字段「${field.name}」（${field.id}）必须是枚举值之一：${options.join(' / ')}`);
        }
      }
    }
  }

  // 装备实例
  const slotById = new Map(rules.sheet.equipment.slots.map((slot) => [slot.id, slot]));
  const statById = new Map(rules.sheet.equipment.stats.map((stat) => [stat.id, stat]));
  if (card.equipmentInstances !== undefined && !Array.isArray(card.equipmentInstances)) {
    errors.push('equipmentInstances 必须是数组');
  } else if (Array.isArray(card.equipmentInstances)) {
    const seenInstanceIds = new Set<string>();
    const slotUsage = new Map<string, number>();
    card.equipmentInstances.forEach((rawInstance, index) => {
      const label = `equipmentInstances[${index}]`;
      if (!isRecord(rawInstance)) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      if (!isNonEmptyString(rawInstance.instanceId)) {
        errors.push(`${label}.instanceId 必填且必须是非空字符串`);
      } else if (seenInstanceIds.has(rawInstance.instanceId)) {
        errors.push(`${label}.instanceId 重复「${rawInstance.instanceId}」`);
      } else {
        seenInstanceIds.add(rawInstance.instanceId);
      }
      const instanceId = isNonEmptyString(rawInstance.instanceId) ? rawInstance.instanceId : label;
      const slotId = isNonEmptyString(rawInstance.slot) ? rawInstance.slot : undefined;
      const slot = slotId === undefined ? undefined : slotById.get(slotId);
      if (slotId === undefined) {
        errors.push(`${label}.slot 必填且必须是非空字符串`);
      } else if (slot === undefined) {
        errors.push(`${label}.slot 引用了未声明的装备槽「${slotId}」`);
      } else {
        slotUsage.set(slotId, (slotUsage.get(slotId) ?? 0) + 1);
      }
      const tags: string[] = [];
      if (!Array.isArray(rawInstance.tags)) {
        errors.push(`${label}.tags 必须是字符串数组`);
      } else {
        rawInstance.tags.forEach((tag, tagIndex) => {
          if (!isNonEmptyString(tag)) errors.push(`${label}.tags[${tagIndex}] 必须是非空字符串`);
          else tags.push(tag);
        });
      }
      if (slot !== undefined) {
        const accepts = slot.accepts;
        const matches = accepts.includes('*') || tags.some((tag) => accepts.includes(tag));
        if (!matches) {
          errors.push(
            `${label}（${instanceId}）的标签 [${tags.join(', ')}] 不能放入槽位「${slot.name}」（${slot.id}），可接受：${accepts.join(' / ')}`,
          );
        }
      }
      if (!isRecord(rawInstance.stats)) {
        errors.push(`${label}.stats 必须是对象（词条 id → 数值）`);
      } else {
        for (const [statId, value] of Object.entries(rawInstance.stats)) {
          const stat = statById.get(statId);
          if (stat === undefined) {
            errors.push(`${label}.stats 引用了未声明的词条「${statId}」`);
            continue;
          }
          if (!isFiniteNumber(value)) {
            errors.push(`${label}.stats.${statId} 必须是数值`);
            continue;
          }
          if (stat.min !== undefined && value < stat.min) {
            errors.push(`${label}.stats.${statId}=${value} 小于词条下限 ${stat.min}`);
          }
          if (stat.max !== undefined && value > stat.max) {
            errors.push(`${label}.stats.${statId}=${value} 大于词条上限 ${stat.max}`);
          }
        }
      }
      if (rawInstance.name !== undefined && !isNonEmptyString(rawInstance.name)) {
        errors.push(`${label}.name 必须是非空字符串`);
      }
      if (rawInstance.note !== undefined && typeof rawInstance.note !== 'string') {
        errors.push(`${label}.note 必须是字符串`);
      }
    });
    for (const slot of rules.sheet.equipment.slots) {
      const count = slotUsage.get(slot.id) ?? 0;
      const limit = slot.count ?? 1;
      if (count > limit) {
        errors.push(`装备槽「${slot.name}」（${slot.id}）最多 ${limit} 件，当前 ${count} 件`);
      }
    }
  }

  // 技能
  const skillIds = new Set(rules.sheet.skills.map((skill) => skill.id));
  if (card.skills !== undefined && !Array.isArray(card.skills)) {
    errors.push('skills 必须是数组');
  } else if (Array.isArray(card.skills)) {
    const seenSkills = new Set<string>();
    card.skills.forEach((rawSkill, index) => {
      const label = `skills[${index}]`;
      if (!isRecord(rawSkill)) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      const id = isNonEmptyString(rawSkill.id) ? rawSkill.id : undefined;
      if (id === undefined) {
        errors.push(`${label}.id 必填且必须是非空字符串`);
        return;
      }
      if (!skillIds.has(id)) errors.push(`${label}.id 引用了未声明的技能「${id}」`);
      if (seenSkills.has(id)) errors.push(`${label}.id 重复「${id}」`);
      seenSkills.add(id);
      if (rawSkill.proficient !== undefined && typeof rawSkill.proficient !== 'boolean') {
        errors.push(`${label}.proficient 必须是布尔值`);
      }
      if (rawSkill.bonus !== undefined && !isFiniteNumber(rawSkill.bonus)) {
        errors.push(`${label}.bonus 必须是数值`);
      }
    });
  }

  // 状态
  const statusIds = new Set(rules.sheet.statuses.map((status) => status.id));
  if (card.statuses !== undefined && !Array.isArray(card.statuses)) {
    errors.push('statuses 必须是数组');
  } else if (Array.isArray(card.statuses)) {
    card.statuses.forEach((rawStatus, index) => {
      const label = `statuses[${index}]`;
      if (!isRecord(rawStatus)) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      const id = isNonEmptyString(rawStatus.id) ? rawStatus.id : undefined;
      if (id === undefined) {
        errors.push(`${label}.id 必填且必须是非空字符串`);
        return;
      }
      if (!statusIds.has(id)) errors.push(`${label}.id 引用了未声明的状态「${id}」`);
      if (rawStatus.stacks !== undefined && !isPositiveInteger(rawStatus.stacks)) {
        errors.push(`${label}.stacks 必须是正整数`);
      }
      if (rawStatus.remaining !== undefined && !isNonNegativeInteger(rawStatus.remaining)) {
        errors.push(`${label}.remaining 必须是非负整数（剩余回合）`);
      }
    });
  }

  // 杂项
  if (card.notes !== undefined && typeof card.notes !== 'string') errors.push('notes 必须是字符串');
  if (card.origin !== undefined) {
    if (!isRecord(card.origin)) {
      errors.push('origin 必须是对象 { packId, moduleId? }');
    } else {
      if (!isNonEmptyString(card.origin.packId)) errors.push('origin.packId 必填且必须是非空字符串');
      if (card.origin.moduleId !== undefined && typeof card.origin.moduleId !== 'string') {
        errors.push('origin.moduleId 必须是字符串');
      }
    }
  }
  if (card.avatarAssetId !== undefined && !isNonEmptyString(card.avatarAssetId)) {
    errors.push('avatarAssetId 必须是非空字符串');
  }
  if (card.portraitAssetId !== undefined && !isNonEmptyString(card.portraitAssetId)) {
    errors.push('portraitAssetId 必须是非空字符串');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 装备词条聚合
// ---------------------------------------------------------------------------

export interface EquipmentStatsAggregate {
  /** 扁平化词条总值（`equip.*` 公式上下文直接用）。 */
  statValues: Record<string, number>;
  statTotals: EquipmentStatTotalProjection[];
  trace: EquipmentStatTrace[];
}

function aggregateValues(parts: EquipmentStatTracePart[], stacking: string): number {
  if (parts.length === 0) return 0;
  if (stacking === 'max' || stacking === 'unique') {
    let best = parts[0]?.value ?? 0;
    for (const part of parts) if (part.value > best) best = part.value;
    return best;
  }
  if (stacking === 'min') {
    let best = parts[0]?.value ?? 0;
    for (const part of parts) if (part.value < best) best = part.value;
    return best;
  }
  let total = 0;
  for (const part of parts) total += part.value;
  return total;
}

/**
 * 按 `sheet.equipment.stats[].stacking` 聚合装备实例词条：
 * - `add` 相加；
 * - `max` 取最大 / `min` 取最小；
 * - `unique` 「同名只生效最高一条」→ 取最高单件值（与 max 的展示语义不同，trace 里标 unique）。
 */
export function aggregateEquipmentStats(
  rules: RulePack,
  instances: readonly EquipmentInstanceDef[],
): EquipmentStatsAggregate {
  const partsByStat = new Map<string, EquipmentStatTracePart[]>();
  const statDefById = new Map(rules.sheet.equipment.stats.map((stat) => [stat.id, stat]));
  for (const instance of instances) {
    if (!isRecord(instance.stats)) continue;
    for (const [statId, value] of Object.entries(instance.stats)) {
      if (!isFiniteNumber(value)) continue;
      const stat = statDefById.get(statId);
      const part: EquipmentStatTracePart = {
        sourceId: instance.instanceId,
        sourceName: instance.name ?? instance.instanceId,
        value,
        stack: stat?.stacking ?? 'add',
      };
      const list = partsByStat.get(statId);
      if (list === undefined) partsByStat.set(statId, [part]);
      else list.push(part);
    }
  }
  const statValues: Record<string, number> = {};
  const statTotals: EquipmentStatTotalProjection[] = [];
  const trace: EquipmentStatTrace[] = [];
  for (const stat of rules.sheet.equipment.stats) {
    const parts = partsByStat.get(stat.id) ?? [];
    const total = aggregateValues(parts, stat.stacking);
    statValues[stat.id] = total;
    statTotals.push({ statId: stat.id, name: stat.name, total, ...(stat.icon !== undefined ? { icon: stat.icon } : {}) });
    trace.push({ statId: stat.id, total, parts });
    partsByStat.delete(stat.id);
  }
  // 卡里出现但规则包未声明的词条：容错聚合（add），validateCard 会报错
  for (const [statId, parts] of partsByStat) {
    const total = aggregateValues(parts, 'add');
    statValues[statId] = total;
    statTotals.push({ statId, name: statId, total });
    trace.push({ statId, total, parts });
  }
  return { statValues, statTotals, trace };
}

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

export type DerivedInput = Record<string, number | string>;

function buildEquipmentProjection(
  rules: RulePack,
  card: CardInstance,
  aggregate: EquipmentStatsAggregate,
  warnings: string[],
): EquipmentProjection {
  const slotById = new Map(rules.sheet.equipment.slots.map((slot) => [slot.id, slot]));
  const instancesBySlot = new Map<string, EquipmentInstanceDef[]>();
  if (Array.isArray(card.equipmentInstances)) {
    for (const instance of card.equipmentInstances) {
      if (!isRecord(instance)) continue;
      if (typeof instance.slot !== 'string') continue;
      if (!slotById.has(instance.slot)) {
        warnings.push(`装备实例「${instance.instanceId}」的槽位「${instance.slot}」未声明，投影时忽略`);
        continue;
      }
      const list = instancesBySlot.get(instance.slot);
      if (list === undefined) instancesBySlot.set(instance.slot, [instance]);
      else list.push(instance);
    }
  }
  const slots: EquipmentSlotProjection[] = rules.sheet.equipment.slots.map((slot) => {
    const items: EquipmentItemProjection[] = (instancesBySlot.get(slot.id) ?? []).map((instance) => ({
      instanceId: instance.instanceId,
      name: instance.name ?? instance.instanceId,
      tags: Array.isArray(instance.tags) ? instance.tags : [],
      stats: isRecord(instance.stats) ? { ...instance.stats } : {},
      ...(instance.note !== undefined ? { note: instance.note } : {}),
    }));
    return {
      slotId: slot.id,
      name: slot.name,
      accepts: [...slot.accepts],
      count: slot.count ?? 1,
      ...(slot.icon !== undefined ? { icon: slot.icon } : {}),
      items,
    };
  });
  return {
    slots,
    statTotals: aggregate.statTotals,
    statValues: aggregate.statValues,
    trace: aggregate.trace,
  };
}

function evaluateNamedFormula(
  rules: RulePack,
  formulaName: string,
  context: FormulaContext,
): { ok: true; value: number } | { ok: false; error: string } {
  const source = rules.formulas[formulaName];
  if (source === undefined) return { ok: false, error: `未定义的公式「${formulaName}」` };
  const compiled = compileFormula(source);
  if (!compiled.ok) {
    return { ok: false, error: compiled.errors.map((issue) => `第 ${issue.position} 列 ${issue.message}`).join('；') };
  }
  const result = evaluateFormula(compiled.ast, context);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: result.value };
}

function evaluateSourceFormula(
  source: string,
  context: FormulaContext,
): { ok: true; value: number } | { ok: false; error: string } {
  const compiled = compileFormula(source);
  if (!compiled.ok) {
    return { ok: false, error: compiled.errors.map((issue) => `第 ${issue.position} 列 ${issue.message}`).join('；') };
  }
  const result = evaluateFormula(compiled.ast, context);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: result.value };
}

/**
 * 组装主机权威的卡面投影。
 *
 * @param derivedInput `computeDerived` 钩子的产出（M9.2 提供；缺省 `{}`）。
 *                     `derived.mod.<attr>` 会被用于属性调整值与 `formulas.check` 的 `derived.mod`。
 */
export function buildSheetProjection(
  rules: RulePack,
  card: CardInstance,
  derivedInput?: DerivedInput,
): SheetProjection {
  const warnings: string[] = [];
  const derived: Record<string, number | string> = isRecord(derivedInput) ? { ...derivedInput } : {};
  const attributes: Record<string, number> = isRecord(card.attributes) ? { ...card.attributes } : {};
  const level = cardLevel(card);
  if (card.fields === undefined || !isFiniteNumber(card.fields[LEVEL_FIELD_ID])) {
    warnings.push(`卡没有数值字段「${LEVEL_FIELD_ID}」（等级），公式变量 level 按 1 计算`);
  }
  const aggregate = aggregateEquipmentStats(rules, Array.isArray(card.equipmentInstances) ? card.equipmentInstances : []);
  const baseContext: FormulaContext = {
    attr: attributes,
    derived,
    equip: aggregate.statValues,
    level,
  };
  // 熟练加值：优先命名公式 proficiency，其次 derived.proficiency，最后 d20 惯例 2
  let proficiency: number;
  if (rules.formulas.proficiency !== undefined) {
    const result = evaluateNamedFormula(rules, 'proficiency', baseContext);
    if (result.ok) {
      proficiency = result.value;
    } else {
      proficiency = 2;
      warnings.push(`公式 proficiency 求值失败：${result.error}；熟练加值按 2 处理`);
    }
  } else if (isFiniteNumber(derived.proficiency)) {
    proficiency = derived.proficiency;
  } else {
    proficiency = 2;
  }
  const context: FormulaContext = { ...baseContext, proficiency };

  // 资源上限（按声明顺序求值，允许引用之前资源的上限）
  const resourceMax: Record<string, number> = {};
  const resources: ResourceProjection[] = [];
  for (const resource of rules.sheet.resources) {
    const state: CardResourceState | undefined = isRecord(card.resources)
      ? (card.resources[resource.id] as CardResourceState | undefined)
      : undefined;
    let current = 0;
    if (state === undefined) {
      warnings.push(`卡缺少资源「${resource.name}」（${resource.id}），当前值按 0 处理`);
    } else if (isFiniteNumber(state.current)) {
      current = state.current;
    } else {
      warnings.push(`资源「${resource.name}」（${resource.id}）的 current 不是数值，按 0 处理`);
    }
    let max: number | undefined;
    const formulaResult = rules.formulas[resource.formula] !== undefined
      ? evaluateNamedFormula(rules, resource.formula, { ...context, resource: resourceMax })
      : evaluateSourceFormula(resource.formula, { ...context, resource: resourceMax });
    if (formulaResult.ok) {
      max = formulaResult.value;
    } else {
      warnings.push(`资源「${resource.name}」（${resource.id}）上限求值失败：${formulaResult.error}`);
      if (state !== undefined && isFiniteNumber(state.max)) max = state.max;
    }
    if (max === undefined) {
      warnings.push(`资源「${resource.name}」（${resource.id}）没有可用上限，按 0 处理`);
      max = 0;
    }
    resourceMax[resource.id] = max;
    resources.push({
      id: resource.id,
      name: resource.name,
      current,
      max,
      formula: resource.formula,
      ...(resource.icon !== undefined ? { icon: resource.icon } : {}),
    });
  }
  const resourceContext: FormulaContext = { ...context, resource: resourceMax };

  // 技能总加值
  const skillStateById = new Map<string, CardSkillState>();
  if (Array.isArray(card.skills)) {
    for (const state of card.skills) {
      if (isRecord(state) && typeof state.id === 'string' && !skillStateById.has(state.id)) {
        skillStateById.set(state.id, state);
      }
    }
    const declaredSkillIds = new Set(rules.sheet.skills.map((skill) => skill.id));
    for (const state of card.skills) {
      if (isRecord(state) && typeof state.id === 'string' && !declaredSkillIds.has(state.id)) {
        warnings.push(`卡上的技能「${state.id}」未在规则包声明，投影时忽略`);
      }
    }
  }
  const skills: SkillProjection[] = [];
  const skillTotals: Record<string, number> = {};
  let checkFallbackWarned = false;
  for (const skill of rules.sheet.skills) {
    const state = skillStateById.get(skill.id);
    const proficient = state?.proficient === true;
    const bonus = isFiniteNumber(state?.bonus) ? (state?.bonus ?? 0) : 0;
    const skillContext: FormulaContext = {
      ...resourceContext,
      skill: { ...skillTotals, proficient: proficient ? 1 : 0, bonus },
    };
    const attributeMod = skill.attribute === undefined ? undefined : derived[`mod.${skill.attribute}`];
    const mod = isFiniteNumber(attributeMod) ? attributeMod : (isFiniteNumber(derived.mod) ? derived.mod : 0);
    const derivedForSkill: Record<string, number | string> = { ...derived };
    if (!isFiniteNumber(derivedForSkill.mod)) derivedForSkill.mod = mod;
    const withMod: FormulaContext = { ...skillContext, derived: derivedForSkill };
    let total: number | undefined;
    if (skill.formula !== undefined) {
      const result = evaluateSourceFormula(skill.formula, withMod);
      if (result.ok) total = result.value;
      else warnings.push(`技能「${skill.name}」（${skill.id}）加值公式求值失败：${result.error}`);
    } else if (rules.formulas.check !== undefined) {
      const result = evaluateNamedFormula(rules, 'check', withMod);
      if (result.ok) total = result.value;
      else warnings.push(`技能「${skill.name}」（${skill.id}）使用公式 check 求值失败：${result.error}`);
    } else if (!checkFallbackWarned && rules.formulas.proficiency !== undefined) {
      checkFallbackWarned = true;
      warnings.push('规则包没有 formulas.check，技能总加值按「属性调整 + 熟练加值 + 额外加值」兜底计算');
    }
    if (total === undefined) {
      total = mod + (proficient ? proficiency : 0) + bonus;
    }
    skillTotals[skill.id] = total;
    skills.push({
      id: skill.id,
      name: skill.name,
      ...(skill.attribute !== undefined ? { attribute: skill.attribute } : {}),
      total,
      proficient,
      bonus,
      ...(skill.icon !== undefined ? { icon: skill.icon } : {}),
    });
  }

  // 动作可用性：卡内资源是否足够（行动经济状态属于战斗态，M9.1 不做判定）
  const actions: ActionProjection[] = rules.actions.map((action) => projectionAction(action, rules, card));
  // 状态
  const statuses: StatusProjection[] = [];
  const statusById = new Map(rules.sheet.statuses.map((status) => [status.id, status]));
  if (Array.isArray(card.statuses)) {
    for (const state of card.statuses) {
      if (!isRecord(state) || typeof state.id !== 'string') continue;
      const def = statusById.get(state.id);
      if (def === undefined) {
        warnings.push(`卡上的状态「${state.id}」未在规则包声明，投影时忽略`);
        continue;
      }
      statuses.push({
        id: def.id,
        name: def.name,
        ...(isFiniteNumber(state.stacks) ? { stacks: state.stacks } : {}),
        ...(isFiniteNumber(state.remaining) ? { remaining: state.remaining } : {}),
        ...(def.icon !== undefined ? { icon: def.icon } : {}),
      });
    }
  }

  // 属性投影
  const attributeProjections: AttributeProjection[] = rules.sheet.attributes.map((attribute) => {
    const value = isFiniteNumber(attributes[attribute.id]) ? (attributes[attribute.id] as number) : 0;
    const mod = derived[`mod.${attribute.id}`];
    return {
      id: attribute.id,
      name: attribute.name,
      value,
      ...(isFiniteNumber(mod) ? { mod } : {}),
      ...(attribute.icon !== undefined ? { icon: attribute.icon } : {}),
    };
  });

  // 身份（约定：fields.name / race / class / level）
  const fields: Record<string, string | number> = isRecord(card.fields) ? { ...card.fields } : {};
  const readField = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === 'string' ? value : undefined;
  };
  const identity = {
    name: readField('name') ?? card.cardId,
    level,
    ...(readField('race') !== undefined ? { race: readField('race') } : {}),
    ...(readField('class') !== undefined ? { class: readField('class') } : {}),
  };
  // 确保文档约定的身份字段集被引用（IDENTITY_FIELD_IDS 供 M9.2 迁移/编辑器复用）

  const inventory: InventoryProjection = { items: [], categories: [] };
  const equipment = buildEquipmentProjection(rules, card, aggregate, warnings);

  return {
    cardId: card.cardId,
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    identity,
    values: { ...attributes },
    attributes: attributeProjections,
    resources,
    derived,
    equipment,
    skills,
    actions,
    statuses,
    fields,
    inventory,
    warnings,
  };
}

function projectionAction(action: ActionDef, rules: RulePack, card: CardInstance): ActionProjection {
  const cost: ActionCostProjection = {};
  let resourceCost: { id: string; amount: number } | undefined;
  if (action.cost !== undefined) {
    const turnCosts: Record<string, number> = {};
    for (const [key, value] of Object.entries(action.cost)) {
      if (key === 'resource') {
        if (typeof value === 'string') resourceCost = { id: value, amount: 1 };
        else if (isRecord(value) && typeof value.id === 'string') {
          resourceCost = { id: value.id, amount: isFiniteNumber(value.amount) ? value.amount : 1 };
        }
        continue;
      }
      if (isFiniteNumber(value)) turnCosts[key] = value;
    }
    if (Object.keys(turnCosts).length > 0) cost.turn = turnCosts;
    if (resourceCost !== undefined) cost.resource = resourceCost;
  }
  let available = true;
  let reason: string | undefined;
  if (resourceCost !== undefined) {
    const resourceDef = rules.sheet.resources.find((resource) => resource.id === resourceCost.id);
    const resourceName = resourceDef?.name ?? resourceCost.id;
    const state = isRecord(card.resources) ? (card.resources[resourceCost.id] as CardResourceState | undefined) : undefined;
    if (state === undefined || !isFiniteNumber(state.current)) {
      available = false;
      reason = `缺少资源「${resourceName}」`;
    } else if (state.current < resourceCost.amount) {
      available = false;
      reason = `${resourceName}不足（需要 ${resourceCost.amount}，当前 ${state.current}）`;
    }
  }
  const hasCost = cost.turn !== undefined || cost.resource !== undefined;
  return {
    actionId: action.actionId,
    name: action.name,
    kind: action.kind,
    available,
    ...(reason !== undefined ? { reason } : {}),
    ...(hasCost ? { cost } : {}),
    ...(action.description !== undefined ? { description: action.description } : {}),
    ...(action.icon !== undefined ? { icon: action.icon } : {}),
    ...(action.toHit !== undefined ? { toHit: action.toHit } : {}),
    ...(action.damage !== undefined ? { damage: action.damage } : {}),
  };
}

/** 便捷：卡上的技能状态（给 M9.2 结算用）。 */
export function cardSkillState(card: CardInstance, skillId: string): CardSkillState | undefined {
  if (!Array.isArray(card.skills)) return undefined;
  return card.skills.find((state) => isRecord(state) && state.id === skillId);
}

/** 便捷：卡上的状态（给 M9.2 结算用）。 */
export function cardStatusStates(card: CardInstance): CardStatusState[] {
  return Array.isArray(card.statuses) ? card.statuses.filter((state) => isRecord(state)) : [];
}
