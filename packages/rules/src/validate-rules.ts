/**
 * 规则包校验：`validateRulePack(input)` → `{ ok, value?, errors[], warnings[] }`。
 *
 * 校验哲学（与 packages/content 的 validatePack 一致）：
 * - 一次聚合全部问题，错误给人话中文并带路径定位（`sheet.attributes[1].max`）；
 * - 结构错误 = error；可容忍的缺省/建议 = warning；
 * - 引用完整性是重点：公式变量、动作花费、zone/battleMap、脚本钩子名与路径；
 * - 不读文件、不联网、不执行脚本（sha256 与脚本内容校验留给 host 的包加载器）。
 */
import { compileFormula, type FormulaIssue, type FormulaNode, type FormulaScope } from './formula.ts';
import {
  ACTION_KINDS,
  DICE_PATTERN,
  DURATION_UNITS,
  DISTANCE_MODES,
  FIELD_KINDS,
  HOOK_NAMES,
  ID_PATTERN,
  PATH_ID_PATTERN,
  RANGE_BANDS,
  ROUND_LIMIT_ACTIONS,
  RULE_LIMITS,
  RULE_PACK_SCHEMA_VERSION,
  SCRIPT_PATH_PREFIX,
  SEMVER_PATTERN,
  SHA256_PATTERN,
  SPACE_MODELS,
  SPAWN_SIDES,
  STACKING_MODES,
  STATUS_STACKING_MODES,
  TARGETING_SIDES,
  TARGETING_TYPES,
  TIME_MODELS,
  type ActionCost,
  type ActionDamage,
  type ActionDef,
  type ActionKind,
  type ActionResourceCost,
  type ActionTargeting,
  type AreaDef,
  type AttributeDef,
  type BattleMapDef,
  type BattleSpawnDef,
  type CoverDef,
  type DistanceMode,
  type EquipmentDef,
  type EquipmentSlotDef,
  type EquipmentStatDef,
  type FieldDef,
  type FieldKind,
  type MigrationDef,
  type ObstacleDef,
  type ProgressionDef,
  type ResourceDef,
  type RollTableDef,
  type RulePack,
  type RulePackItemDef,
  type RulePackScripts,
  type RulePackUi,
  type ScriptRef,
  type SheetDef,
  type SkillDef,
  type SpaceDef,
  type SpaceModel,
  type SpawnSide,
  type StackingMode,
  type StatusDef,
  type TargetingSide,
  type TargetingType,
  type TerrainDef,
  type TimeDef,
  type TurnDef,
  type TurnResourceDef,
  type UiGroupDef,
  type UiItemCategoryDef,
  type UiRarityDef,
  type ValidateResult,
  type ZoneConnectionDef,
  type ZoneDef,
  type ZoneHotspotDef,
} from './types.ts';

// ---------------------------------------------------------------------------
// 公开选项
// ---------------------------------------------------------------------------

export interface ValidateRulePackOptions {
  /** true = 把 warning 也视为失败（严格模式，CI/落盘前用）。 */
  strict?: boolean;
  /** 额外允许的钩子名（正常不应使用；留给未来版本兼容）。 */
  extraHookNames?: readonly string[];
  /** 额外允许的顶层字段（正常不应使用）。 */
  extraTopLevelKeys?: readonly string[];
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

interface Ctx {
  errors: string[];
  warnings: string[];
}

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'rulesId',
  'rulesVersion',
  'name',
  'description',
  'sheet',
  'actions',
  'turn',
  'progression',
  'tables',
  'ui',
  'formulas',
  'scripts',
  'space',
  'time',
  'items',
  'migrations',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function error(ctx: Ctx, path: string, message: string): void {
  ctx.errors.push(`${path}: ${message}`);
}

function warn(ctx: Ctx, path: string, message: string): void {
  ctx.warnings.push(`${path}: ${message}`);
}

function formatCompileIssues(path: string, issues: FormulaIssue[]): string[] {
  return issues.map((issue) => `${path}: 第 ${issue.position} 列 ${issue.message}`);
}

function pushCompileErrors(ctx: Ctx, path: string, issues: FormulaIssue[]): void {
  for (const line of formatCompileIssues(path, issues)) ctx.errors.push(line);
}

function readId(
  value: unknown,
  path: string,
  ctx: Ctx,
  kind: 'id' | 'path' = 'id',
): string | undefined {
  if (!isNonEmptyString(value)) {
    error(ctx, path, '必填且必须是非空字符串');
    return undefined;
  }
  const pattern = kind === 'path' ? PATH_ID_PATTERN : ID_PATTERN;
  if (!pattern.test(value)) {
    error(
      ctx,
      path,
      `"${value}" 不是合法 ${kind === 'path' ? '点分 id' : 'id'}（允许字母/数字/下划线/中文开头，可含 -${kind === 'path' ? '，可用 . 分段' : ''}）`,
    );
    return undefined;
  }
  return value;
}

function readUniqueId(
  id: string | undefined,
  path: string,
  seen: Set<string>,
  ctx: Ctx,
  label: string,
): string | undefined {
  if (id === undefined) return undefined;
  if (seen.has(id)) {
    error(ctx, path, `重复的${label} "${id}"`);
    return undefined;
  }
  seen.add(id);
  return id;
}

function readOptionalString(value: unknown, path: string, ctx: Ctx): string | undefined {
  if (value === undefined) return undefined;
  if (!isNonEmptyString(value)) {
    error(ctx, path, '必须是非空字符串');
    return undefined;
  }
  return value;
}

// ---------------------------------------------------------------------------
// sheet
// ---------------------------------------------------------------------------

interface SheetOutcome {
  sheet: SheetDef;
  attributeIds: string[];
  resourceIds: string[];
  numberFieldIds: string[];
  slotIds: string[];
  statIds: string[];
  skillIds: string[];
  statusIds: string[];
}

function validateAttributes(raw: unknown, ctx: Ctx): { defs: AttributeDef[]; ids: string[] } {
  const defs: AttributeDef[] = [];
  const ids: string[] = [];
  if (!Array.isArray(raw)) {
    error(ctx, 'sheet.attributes', '必须是数组（至少 0 项）');
    return { defs, ids };
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `sheet.attributes[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '属性 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const min = isFiniteNumber(value.min) ? value.min : undefined;
    if (min === undefined) error(ctx, `${path}.min`, '必须是数值');
    const max = isFiniteNumber(value.max) ? value.max : undefined;
    if (max === undefined) error(ctx, `${path}.max`, '必须是数值');
    const defaultValue = isFiniteNumber(value.default) ? value.default : undefined;
    if (defaultValue === undefined) error(ctx, `${path}.default`, '必须是数值');
    if (min !== undefined && max !== undefined) {
      if (min > max) error(ctx, `${path}.min`, `不能大于 max（min=${min}, max=${max}）`);
      else if (min === max) warn(ctx, `${path}.min`, 'min 与 max 相等，属性将只有一个合法值');
    }
    if (defaultValue !== undefined && min !== undefined && max !== undefined && min <= max) {
      if (defaultValue < min || defaultValue > max) {
        error(ctx, `${path}.default`, `必须在 [${min}, ${max}] 范围内（当前 ${defaultValue}）`);
      }
    }
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (id === undefined) return;
    ids.push(id);
    defs.push({
      id,
      name: name ?? id,
      min: min ?? 0,
      max: max ?? 0,
      default: defaultValue ?? 0,
      ...(icon !== undefined ? { icon } : {}),
    });
  });
  return { defs, ids };
}

function validateResources(raw: unknown, ctx: Ctx): { defs: ResourceDef[]; ids: string[] } {
  const defs: ResourceDef[] = [];
  const ids: string[] = [];
  if (raw === undefined) {
    warn(ctx, 'sheet.resources', '未声明资源（没有生命/真气等资源条）');
    return { defs, ids };
  }
  if (!Array.isArray(raw)) {
    error(ctx, 'sheet.resources', '必须是数组');
    return { defs, ids };
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `sheet.resources[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '资源 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const formula = isNonEmptyString(value.formula) ? value.formula : undefined;
    if (!formula) error(ctx, `${path}.formula`, '必填且必须是非空字符串（命名公式名或内联表达式）');
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (id === undefined) return;
    ids.push(id);
    defs.push({ id, name: name ?? id, formula: formula ?? '', ...(icon !== undefined ? { icon } : {}) });
  });
  return { defs, ids };
}

function validateFields(raw: unknown, ctx: Ctx): { defs: FieldDef[]; numberIds: string[] } {
  const defs: FieldDef[] = [];
  const numberIds: string[] = [];
  if (raw === undefined) {
    warn(ctx, 'sheet.fields', '未声明自由字段（身份/摘要等只能由内容包或宿主兜底）');
    return { defs, numberIds };
  }
  if (!Array.isArray(raw)) {
    error(ctx, 'sheet.fields', '必须是数组');
    return { defs, numberIds };
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `sheet.fields[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '字段 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const kindValue = value.kind;
    const kind = typeof kindValue === 'string' && (FIELD_KINDS as readonly string[]).includes(kindValue)
      ? (kindValue as FieldKind)
      : undefined;
    if (kind === undefined) error(ctx, `${path}.kind`, `必须是 ${FIELD_KINDS.join('/')} 之一`);
    let options: string[] | undefined;
    if (value.options !== undefined) {
      if (!Array.isArray(value.options)) {
        error(ctx, `${path}.options`, '必须是字符串数组');
      } else if (kind === 'enum') {
        if (value.options.length === 0) {
          error(ctx, `${path}.options`, 'kind=enum 时 options 不能为空');
        } else {
          const seenOptions = new Set<string>();
          const parsed: string[] = [];
          value.options.forEach((option, optionIndex) => {
            if (!isNonEmptyString(option)) {
              error(ctx, `${path}.options[${optionIndex}]`, '必须是非空字符串');
              return;
            }
            if (seenOptions.has(option)) {
              error(ctx, `${path}.options[${optionIndex}]`, `重复的枚举值 "${option}"`);
              return;
            }
            seenOptions.add(option);
            parsed.push(option);
          });
          options = parsed;
        }
      } else {
        warn(ctx, `${path}.options`, '只有 kind=enum 的字段需要 options，已忽略');
      }
    } else if (kind === 'enum') {
      error(ctx, `${path}.options`, 'kind=enum 时必填且非空');
    }
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (id === undefined) return;
    if (kind === 'number') numberIds.push(id);
    defs.push({
      id,
      name: name ?? id,
      kind: kind ?? 'text',
      ...(options !== undefined ? { options } : {}),
      ...(icon !== undefined ? { icon } : {}),
    });
  });
  return { defs, numberIds };
}

function validateEquipment(raw: unknown, ctx: Ctx): { def: EquipmentDef; slotIds: string[]; statIds: string[] } {
  const empty: EquipmentDef = { slots: [], stats: [] };
  if (raw === undefined) {
    warn(ctx, 'sheet.equipment', '未声明装备段，按无装备槽/无词条处理（如需要请写 { slots: [], stats: [] }）');
    return { def: empty, slotIds: [], statIds: [] };
  }
  if (!isRecord(raw)) {
    error(ctx, 'sheet.equipment', '必须是对象');
    return { def: empty, slotIds: [], statIds: [] };
  }
  const slots: EquipmentSlotDef[] = [];
  const slotIds: string[] = [];
  if (raw.slots !== undefined) {
    if (!Array.isArray(raw.slots)) {
      error(ctx, 'sheet.equipment.slots', '必须是数组');
    } else {
      const seen = new Set<string>();
      raw.slots.forEach((value, index) => {
        const path = `sheet.equipment.slots[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '槽位 id');
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
        const accepts: string[] = [];
        if (!Array.isArray(value.accepts)) {
          error(ctx, `${path}.accepts`, '必须是标签数组且非空');
        } else if (value.accepts.length === 0) {
          error(ctx, `${path}.accepts`, '不能为空（要接受任意物品请写 ["*"]）');
        } else {
          value.accepts.forEach((tag, tagIndex) => {
            if (!isNonEmptyString(tag)) {
              error(ctx, `${path}.accepts[${tagIndex}]`, '必须是非空字符串');
              return;
            }
            accepts.push(tag);
          });
          if (accepts.includes('*') && accepts.length > 1) {
            warn(ctx, `${path}.accepts`, '包含通配符 "*" 时其余标签不会生效');
          }
        }
        let count: number | undefined;
        if (value.count !== undefined) {
          if (!isPositiveInteger(value.count)) {
            error(ctx, `${path}.count`, '必须是正整数');
          } else {
            count = value.count;
          }
        }
        const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
        if (id === undefined) return;
        slotIds.push(id);
        slots.push({
          id,
          name: name ?? id,
          accepts,
          ...(count !== undefined ? { count } : {}),
          ...(icon !== undefined ? { icon } : {}),
        });
      });
    }
  }
  const stats: EquipmentStatDef[] = [];
  const statIds: string[] = [];
  if (raw.stats !== undefined) {
    if (!Array.isArray(raw.stats)) {
      error(ctx, 'sheet.equipment.stats', '必须是数组');
    } else {
      const seen = new Set<string>();
      raw.stats.forEach((value, index) => {
        const path = `sheet.equipment.stats[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '词条 id');
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
        const stackingValue = value.stacking;
        const stacking = typeof stackingValue === 'string' && (STACKING_MODES as readonly string[]).includes(stackingValue)
          ? (stackingValue as StackingMode)
          : undefined;
        if (stacking === undefined) error(ctx, `${path}.stacking`, `必须是 ${STACKING_MODES.join('/')} 之一`);
        const min = value.min === undefined ? undefined : isFiniteNumber(value.min) ? value.min : undefined;
        if (value.min !== undefined && min === undefined) error(ctx, `${path}.min`, '必须是数值');
        const max = value.max === undefined ? undefined : isFiniteNumber(value.max) ? value.max : undefined;
        if (value.max !== undefined && max === undefined) error(ctx, `${path}.max`, '必须是数值');
        if (min !== undefined && max !== undefined && min > max) {
          error(ctx, `${path}.min`, `不能大于 max（min=${min}, max=${max}）`);
        }
        const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
        if (id === undefined) return;
        statIds.push(id);
        stats.push({
          id,
          name: name ?? id,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          stacking: stacking ?? 'add',
          ...(icon !== undefined ? { icon } : {}),
        });
      });
    }
  }
  let stackingLabels: Record<string, string> | undefined;
  if (raw.stacking !== undefined) {
    if (!isRecord(raw.stacking)) {
      error(ctx, 'sheet.equipment.stacking', '必须是对象（叠法展示名映射）');
    } else {
      stackingLabels = {};
      for (const [key, label] of Object.entries(raw.stacking)) {
        if (!isNonEmptyString(label)) {
          error(ctx, `sheet.equipment.stacking.${key}`, '展示名必须是非空字符串');
          continue;
        }
        stackingLabels[key] = label;
      }
    }
  }
  return {
    def: { slots, stats, ...(stackingLabels !== undefined ? { stacking: stackingLabels } : {}) },
    slotIds,
    statIds,
  };
}

function validateSkills(raw: unknown, attributeIds: readonly string[], ctx: Ctx): { defs: SkillDef[]; ids: string[] } {
  const defs: SkillDef[] = [];
  const ids: string[] = [];
  if (raw === undefined) {
    warn(ctx, 'sheet.skills', '未声明技能（检定只能走属性或钩子）');
    return { defs, ids };
  }
  if (!Array.isArray(raw)) {
    error(ctx, 'sheet.skills', '必须是数组');
    return { defs, ids };
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `sheet.skills[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '技能 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const attribute = isNonEmptyString(value.attribute) ? value.attribute : undefined;
    if (attribute === undefined) {
      error(ctx, `${path}.attribute`, '必填且必须是非空字符串');
    } else if (!attributeIds.includes(attribute)) {
      error(ctx, `${path}.attribute`, `引用了未声明的属性 "${attribute}"`);
    }
    const formula = readOptionalString(value.formula, `${path}.formula`, ctx);
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (id === undefined) return;
    ids.push(id);
    defs.push({
      id,
      name: name ?? id,
      attribute: attribute ?? '',
      ...(formula !== undefined ? { formula } : {}),
      ...(icon !== undefined ? { icon } : {}),
    });
  });
  return { defs, ids };
}

function validateStatuses(raw: unknown, ctx: Ctx): { defs: StatusDef[]; ids: string[] } {
  const defs: StatusDef[] = [];
  const ids: string[] = [];
  if (raw === undefined) {
    warn(ctx, 'sheet.statuses', '未声明状态（中毒/倒地等状态无法使用）');
    return { defs, ids };
  }
  if (!Array.isArray(raw)) {
    error(ctx, 'sheet.statuses', '必须是数组');
    return { defs, ids };
  }
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `sheet.statuses[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '状态 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    let duration: number | undefined;
    if (value.duration !== undefined) {
      if (!isPositiveInteger(value.duration)) {
        error(ctx, `${path}.duration`, '必须是正整数（回合数）');
      } else {
        duration = value.duration;
      }
    }
    let stacking: string | undefined;
    if (value.stacking !== undefined) {
      if (!isNonEmptyString(value.stacking)) {
        error(ctx, `${path}.stacking`, '必须是非空字符串');
      } else {
        stacking = value.stacking;
        if (!(STATUS_STACKING_MODES as readonly string[]).includes(stacking)) {
          warn(ctx, `${path}.stacking`, `未知叠法 "${stacking}"（常见：${STATUS_STACKING_MODES.join('/')}）`);
        }
      }
    }
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (id === undefined) return;
    ids.push(id);
    defs.push({
      id,
      name: name ?? id,
      ...(duration !== undefined ? { duration } : {}),
      ...(stacking !== undefined ? { stacking } : {}),
      ...(icon !== undefined ? { icon } : {}),
    });
  });
  return { defs, ids };
}

function validateSheet(raw: unknown, ctx: Ctx): SheetOutcome {
  const attributes = validateAttributes(isRecord(raw) ? raw.attributes : undefined, ctx);
  const resources = validateResources(isRecord(raw) ? raw.resources : undefined, ctx);
  const fields = validateFields(isRecord(raw) ? raw.fields : undefined, ctx);
  const equipment = validateEquipment(isRecord(raw) ? raw.equipment : undefined, ctx);
  const skills = validateSkills(isRecord(raw) ? raw.skills : undefined, attributes.ids, ctx);
  const statuses = validateStatuses(isRecord(raw) ? raw.statuses : undefined, ctx);
  if (!isRecord(raw)) {
    error(ctx, 'sheet', '规则包缺少 sheet 段（必须声明卡面数据）');
  }
  return {
    sheet: {
      attributes: attributes.defs,
      resources: resources.defs,
      fields: fields.defs,
      equipment: equipment.def,
      skills: skills.defs,
      statuses: statuses.defs,
    },
    attributeIds: attributes.ids,
    resourceIds: resources.ids,
    numberFieldIds: fields.numberIds,
    slotIds: equipment.slotIds,
    statIds: equipment.statIds,
    skillIds: skills.ids,
    statusIds: statuses.ids,
  };
}

// ---------------------------------------------------------------------------
// formulas
// ---------------------------------------------------------------------------

interface FormulaOutcome {
  formulas: Record<string, string>;
  formulaNames: Set<string>;
  compiled: Map<string, FormulaNode>;
  scope: FormulaScope;
}

function validateFormulas(raw: unknown, scope: FormulaScope, ctx: Ctx): FormulaOutcome {
  const formulas: Record<string, string> = {};
  const formulaNames = new Set<string>();
  const compiled = new Map<string, FormulaNode>();
  if (raw === undefined) {
    warn(ctx, 'formulas', '规则包没有 formulas 段（资源上限/命中/伤害等公式机制不可用）');
    return { formulas, formulaNames, compiled, scope };
  }
  if (!isRecord(raw)) {
    error(ctx, 'formulas', '必须是对象（公式名 → 表达式字符串）');
    return { formulas, formulaNames, compiled, scope };
  }
  for (const [name, source] of Object.entries(raw)) {
    const path = `formulas.${name}`;
    if (!PATH_ID_PATTERN.test(name)) {
      error(ctx, path, `公式名 "${name}" 不合法（允许字母/数字/下划线/中文，可含 . 与 -）`);
      continue;
    }
    if (typeof source !== 'string') {
      error(ctx, path, '公式必须是字符串');
      continue;
    }
    formulas[name] = source;
    formulaNames.add(name);
    const result = compileFormula(source, scope);
    if (!result.ok) {
      pushCompileErrors(ctx, path, result.errors);
      continue;
    }
    compiled.set(name, result.ast);
  }
  if (Object.keys(formulas).length === 0 && ctx.errors.length === 0) {
    warn(ctx, 'formulas', '公式表为空');
  }
  return { formulas, formulaNames, compiled, scope };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

interface EconomicCostRef {
  path: string;
  key: string;
  value: number;
}

interface ActionOutcome {
  actions: ActionDef[];
  actionIds: Set<string>;
  economicRefs: EconomicCostRef[];
}

function validateActionCost(
  raw: unknown,
  path: string,
  resourceIds: ReadonlySet<string>,
  ctx: Ctx,
  economicRefs: EconomicCostRef[],
): ActionCost | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    error(ctx, path, '必须是对象（行动经济/资源花费）');
    return undefined;
  }
  const cost: ActionCost = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'resource') {
      if (typeof value === 'string') {
        if (!resourceIds.has(value)) {
          error(ctx, `${path}.resource`, `引用了未声明的资源 "${value}"`);
          continue;
        }
        cost.resource = value;
        continue;
      }
      if (!isRecord(value)) {
        error(ctx, `${path}.resource`, '必须是资源 id 字符串或 { id, amount } 对象');
        continue;
      }
      const resourceId = isNonEmptyString(value.id) ? value.id : undefined;
      if (resourceId === undefined) {
        error(ctx, `${path}.resource.id`, '必填且必须是非空字符串');
        continue;
      }
      if (!resourceIds.has(resourceId)) {
        error(ctx, `${path}.resource.id`, `引用了未声明的资源 "${resourceId}"`);
        continue;
      }
      const amount = value.amount === undefined ? 1 : value.amount;
      if (!isPositiveInteger(amount)) {
        error(ctx, `${path}.resource.amount`, '必须是正整数');
        continue;
      }
      const resourceCost: ActionResourceCost = { id: resourceId, amount };
      cost.resource = resourceCost;
      continue;
    }
    if (!isPositiveInteger(value)) {
      error(ctx, `${path}.${key}`, '必须是正整数（行动经济消耗次数）');
      continue;
    }
    economicRefs.push({ path: `${path}.${key}`, key, value });
    cost[key] = value;
  }
  return cost;
}

function validateTargeting(raw: unknown, path: string, ctx: Ctx): ActionTargeting | undefined {
  if (!isRecord(raw)) {
    error(ctx, path, '必填且必须是对象 { type, range, sides }');
    return undefined;
  }
  const typeValue = raw.type;
  const type =
    typeof typeValue === 'string' && (TARGETING_TYPES as readonly string[]).includes(typeValue)
      ? (typeValue as TargetingType)
      : undefined;
  if (type === undefined) error(ctx, `${path}.type`, `必须是 ${TARGETING_TYPES.join('/')} 之一`);
  let range: number | (typeof RANGE_BANDS)[number] | undefined;
  if (typeof raw.range === 'number') {
    if (!isPositiveInteger(raw.range)) error(ctx, `${path}.range`, '格数必须是正整数');
    else range = raw.range;
  } else if (typeof raw.range === 'string') {
    if (!(RANGE_BANDS as readonly string[]).includes(raw.range)) {
      error(ctx, `${path}.range`, `必须是距离档位 ${RANGE_BANDS.join('/')} 之一或正整数格数`);
    } else {
      range = raw.range as (typeof RANGE_BANDS)[number];
    }
  } else {
    error(ctx, `${path}.range`, '必填：距离档位字符串或正整数格数');
  }
  const sidesValue = raw.sides;
  const sides =
    typeof sidesValue === 'string' && (TARGETING_SIDES as readonly string[]).includes(sidesValue)
      ? (sidesValue as TargetingSide)
      : undefined;
  if (sides === undefined) error(ctx, `${path}.sides`, `必须是 ${TARGETING_SIDES.join('/')} 之一`);
  return { type: type ?? 'single', range: range ?? 'engaged', sides: sides ?? 'enemy' };
}

function validateActions(
  raw: unknown,
  ctx: Ctx,
  formulaNames: ReadonlySet<string>,
  resourceIds: ReadonlySet<string>,
): ActionOutcome {
  const actions: ActionDef[] = [];
  const actionIds = new Set<string>();
  const economicRefs: EconomicCostRef[] = [];
  if (raw === undefined) {
    warn(ctx, 'actions', '规则包没有 actions 段（没有任何可用动作）');
    return { actions, actionIds, economicRefs };
  }
  if (!Array.isArray(raw)) {
    error(ctx, 'actions', '必须是数组');
    return { actions, actionIds, economicRefs };
  }
  raw.forEach((value, index) => {
    const path = `actions[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const actionId = readUniqueId(
      readId(value.actionId, `${path}.actionId`, ctx, 'path'),
      `${path}.actionId`,
      actionIds,
      ctx,
      '动作 id',
    );
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const kindValue = value.kind;
    const kind =
      typeof kindValue === 'string' && (ACTION_KINDS as readonly string[]).includes(kindValue)
        ? (kindValue as ActionKind)
        : undefined;
    if (kind === undefined) error(ctx, `${path}.kind`, `必须是 ${ACTION_KINDS.join('/')} 之一`);
    const cost = validateActionCost(value.cost, `${path}.cost`, resourceIds, ctx, economicRefs);
    const targeting = validateTargeting(value.targeting, `${path}.targeting`, ctx);
    let toHit: string | undefined;
    if (value.toHit !== undefined) {
      if (!isNonEmptyString(value.toHit)) {
        error(ctx, `${path}.toHit`, '必须是公式名字符串');
      } else if (!formulaNames.has(value.toHit)) {
        error(ctx, `${path}.toHit`, `引用了未定义的公式 "${value.toHit}"`);
      } else {
        toHit = value.toHit;
      }
    }
    let damage: ActionDamage | undefined;
    if (value.damage !== undefined) {
      if (!isRecord(value.damage)) {
        error(ctx, `${path}.damage`, '必须是对象 { formula?, dice? }');
      } else {
        damage = {};
        let hasSomething = false;
        if (value.damage.formula !== undefined) {
          if (!isNonEmptyString(value.damage.formula)) {
            error(ctx, `${path}.damage.formula`, '必须是公式名字符串');
          } else if (!formulaNames.has(value.damage.formula)) {
            error(ctx, `${path}.damage.formula`, `引用了未定义的公式 "${value.damage.formula}"`);
          } else {
            damage.formula = value.damage.formula;
            hasSomething = true;
          }
        }
        if (value.damage.dice !== undefined) {
          if (!isNonEmptyString(value.damage.dice)) {
            error(ctx, `${path}.damage.dice`, '必须是骰子表达式字符串（如 1d8）');
          } else if (!DICE_PATTERN.test(value.damage.dice)) {
            error(ctx, `${path}.damage.dice`, `"${value.damage.dice}" 不是合法骰子表达式（如 d20 / 1d8 / 2d6+3）`);
          } else {
            damage.dice = value.damage.dice;
            hasSomething = true;
          }
        }
        if (!hasSomething && value.damage.formula === undefined && value.damage.dice === undefined) {
          warn(ctx, `${path}.damage`, 'damage 既没有 formula 也没有 dice，命中后没有伤害');
        }
      }
    }
    let description: string | undefined;
    if (value.description === undefined) {
      error(ctx, `${path}.description`, '必填（没有描述可写空字符串）');
    } else if (typeof value.description !== 'string') {
      error(ctx, `${path}.description`, '必须是字符串');
    } else {
      description = value.description;
      if (description.length === 0) warn(ctx, `${path}.description`, '描述为空');
    }
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (actionId === undefined) return;
    actions.push({
      actionId,
      name: name ?? actionId,
      kind: kind ?? 'custom',
      ...(cost !== undefined ? { cost } : {}),
      targeting: targeting ?? { type: 'single', range: 'engaged', sides: 'enemy' },
      ...(toHit !== undefined ? { toHit } : {}),
      ...(damage !== undefined ? { damage } : {}),
      description: description ?? '',
      ...(icon !== undefined ? { icon } : {}),
    });
  });
  return { actions, actionIds, economicRefs };
}

// ---------------------------------------------------------------------------
// turn（行动经济）
// ---------------------------------------------------------------------------

interface TurnOutcome {
  turn: TurnDef;
  turnResourceIds: Set<string>;
  movementId?: string;
}

function validateTurn(raw: unknown, ctx: Ctx, formulaNames: ReadonlySet<string>): TurnOutcome {
  const empty: TurnDef = { resources: [] };
  const turnResourceIds = new Set<string>();
  if (raw === undefined) {
    warn(ctx, 'turn', '规则包没有 turn 段，按「不限制行动次数」处理');
    return { turn: empty, turnResourceIds };
  }
  if (!isRecord(raw)) {
    error(ctx, 'turn', '必须是对象');
    return { turn: empty, turnResourceIds };
  }
  const resources: TurnResourceDef[] = [];
  if (raw.resources !== undefined) {
    if (!Array.isArray(raw.resources)) {
      error(ctx, 'turn.resources', '必须是数组');
    } else {
      raw.resources.forEach((value, index) => {
        const path = `turn.resources[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, turnResourceIds, ctx, '行动经济资源 id');
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
        let count: number | undefined;
        for (const field of ['count', 'perTurn'] as const) {
          if (value[field] === undefined) continue;
          if (!isPositiveInteger(value[field])) {
            error(ctx, `${path}.${field}`, '必须是正整数（每回合回满次数）');
          } else if (field === 'count') {
            count = value[field] as number;
          } else if (count === undefined) {
            count = value[field] as number;
          } else if (count !== value[field]) {
            warn(ctx, `${path}.perTurn`, `与 count 不一致（${String(value[field])}），以 count=${count} 为准`);
          }
        }
        let perTurnFormula: string | undefined;
        if (value.perTurnFormula !== undefined) {
          if (!isNonEmptyString(value.perTurnFormula)) {
            error(ctx, `${path}.perTurnFormula`, '必须是公式名字符串');
          } else if (!formulaNames.has(value.perTurnFormula)) {
            error(ctx, `${path}.perTurnFormula`, `引用了未定义的公式 "${value.perTurnFormula}"`);
          } else {
            perTurnFormula = value.perTurnFormula;
          }
        }
        if (count === undefined && perTurnFormula === undefined) {
          warn(ctx, path, '既没有 count/perTurn 也没有 perTurnFormula，每回合可用次数无法确定');
        }
        const unit = readOptionalString(value.unit, `${path}.unit`, ctx);
        const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
        if (id === undefined) return;
        resources.push({
          id,
          name: name ?? id,
          ...(count !== undefined ? { count } : {}),
          ...(perTurnFormula !== undefined ? { perTurnFormula } : {}),
          ...(unit !== undefined ? { unit } : {}),
          ...(icon !== undefined ? { icon } : {}),
        });
      });
    }
  } else {
    warn(ctx, 'turn.resources', '没有声明每回合资源，按「不限制行动次数」处理');
  }
  let movement: TurnDef['movement'];
  let movementId: string | undefined;
  if (raw.movement !== undefined) {
    if (!isRecord(raw.movement)) {
      error(ctx, 'turn.movement', '必须是对象');
    } else {
      const id = readId(raw.movement.id, 'turn.movement.id', ctx);
      const name = isNonEmptyString(raw.movement.name) ? raw.movement.name : undefined;
      if (!name) error(ctx, 'turn.movement.name', '必填且必须是非空字符串');
      let cells: number | undefined;
      if (raw.movement.cells !== undefined) {
        if (!isPositiveInteger(raw.movement.cells)) error(ctx, 'turn.movement.cells', '必须是正整数格数');
        else cells = raw.movement.cells;
      }
      let meters: number | undefined;
      if (raw.movement.meters !== undefined) {
        if (!isFiniteNumber(raw.movement.meters) || raw.movement.meters <= 0) {
          error(ctx, 'turn.movement.meters', '必须是正数');
        } else {
          meters = raw.movement.meters;
        }
      }
      let perTurnFormula: string | undefined;
      if (raw.movement.perTurnFormula !== undefined) {
        if (!isNonEmptyString(raw.movement.perTurnFormula)) {
          error(ctx, 'turn.movement.perTurnFormula', '必须是公式名字符串');
        } else if (!formulaNames.has(raw.movement.perTurnFormula)) {
          error(ctx, 'turn.movement.perTurnFormula', `引用了未定义的公式 "${raw.movement.perTurnFormula}"`);
        } else {
          perTurnFormula = raw.movement.perTurnFormula;
        }
      }
      if (cells === undefined && meters === undefined && perTurnFormula === undefined) {
        warn(ctx, 'turn.movement', '没有声明 cells/meters/perTurnFormula，移动力无法确定');
      }
      if (id !== undefined) {
        if (turnResourceIds.has(id)) {
          error(ctx, 'turn.movement.id', `与行动经济资源 id 重复 "${id}"`);
        } else {
          movementId = id;
          turnResourceIds.add(id);
        }
      }
      if (id !== undefined) {
        movement = {
          id,
          name: name ?? id,
          ...(cells !== undefined ? { cells } : {}),
          ...(meters !== undefined ? { meters } : {}),
          ...(perTurnFormula !== undefined ? { perTurnFormula } : {}),
        };
      }
    }
  }
  let refill: string | undefined;
  if (raw.refill !== undefined) {
    if (!isNonEmptyString(raw.refill)) {
      error(ctx, 'turn.refill', '必须是非空字符串');
    } else {
      refill = raw.refill;
      if (raw.refill !== 'turnStart') warn(ctx, 'turn.refill', `v1 只支持 "turnStart"，"${raw.refill}" 会被忽略`);
    }
  }
  let endTurn: TurnDef['endTurn'];
  if (raw.endTurn !== undefined) {
    if (!isRecord(raw.endTurn)) {
      error(ctx, 'turn.endTurn', '必须是对象');
    } else {
      endTurn = {};
      if (raw.endTurn.trigger !== undefined) {
        if (raw.endTurn.trigger !== 'player' && raw.endTurn.trigger !== 'auto') {
          error(ctx, 'turn.endTurn.trigger', '必须是 "player" 或 "auto"');
        } else {
          endTurn.trigger = raw.endTurn.trigger;
        }
      }
    }
  }
  return {
    turn: {
      resources,
      ...(movement !== undefined ? { movement } : {}),
      ...(refill !== undefined ? { refill } : {}),
      ...(endTurn !== undefined ? { endTurn } : {}),
    },
    turnResourceIds,
    ...(movementId !== undefined ? { movementId } : {}),
  };
}

// ---------------------------------------------------------------------------
// scripts（钩子声明；只校验形状/白名单/路径，不验文件内容）
// ---------------------------------------------------------------------------

function validateScriptFile(value: unknown, path: string, ctx: Ctx): string | undefined {
  if (!isNonEmptyString(value)) {
    error(ctx, path, '必须是非空字符串（rules/scripts/**.js 相对路径）');
    return undefined;
  }
  const problems: string[] = [];
  if (value.includes('\\')) problems.push('必须使用 / 分隔路径');
  if (value.startsWith('/')) problems.push('不允许绝对路径');
  if (/^[A-Za-z]:/.test(value)) problems.push('不允许盘符绝对路径');
  if (!value.startsWith(SCRIPT_PATH_PREFIX)) problems.push(`必须位于 "${SCRIPT_PATH_PREFIX}" 下`);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..')) problems.push('不允许路径穿越（..）');
  if (segments.some((segment) => segment === '.')) problems.push('不允许 "." 路径段');
  if (segments.some((segment) => segment === '')) problems.push('不允许空路径段');
  if (!value.endsWith('.js')) problems.push('脚本必须是 .js 文件');
  if (problems.length > 0) {
    error(ctx, path, `"${value}" 非法：${problems.join('；')}`);
    return undefined;
  }
  return value;
}

function validateScripts(
  raw: unknown,
  ctx: Ctx,
  options: ValidateRulePackOptions,
): RulePackScripts | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    error(ctx, 'scripts', '必须是对象（钩子名 → { file, sha256 }）');
    return undefined;
  }
  const allowed = new Set<string>([
    ...(HOOK_NAMES as readonly string[]),
    ...((options.extraHookNames ?? []) as readonly string[]),
  ]);
  const scripts: RulePackScripts = {};
  const entries = Object.entries(raw);
  if (entries.length > RULE_LIMITS.maxScripts) {
    error(ctx, 'scripts', `脚本数量 ${entries.length} 超过上限 ${RULE_LIMITS.maxScripts}`);
  }
  for (const [hookName, value] of entries) {
    const path = `scripts.${hookName}`;
    if (!allowed.has(hookName)) {
      error(ctx, path, `未知钩子 "${hookName}"（允许：${[...allowed].join(' / ')}）`);
      continue;
    }
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象 { file, sha256 }');
      continue;
    }
    const file = validateScriptFile(value.file, `${path}.file`, ctx);
    let sha256: string | undefined;
    if (value.sha256 === undefined) {
      error(ctx, `${path}.sha256`, '必填（脚本 sha256，64 位小写十六进制）');
    } else if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
      error(ctx, `${path}.sha256`, '必须是 64 位小写十六进制 sha256');
    } else {
      sha256 = value.sha256;
    }
    if (file !== undefined && sha256 !== undefined) {
      (scripts as Record<string, ScriptRef>)[hookName] = { file, sha256 };
    }
  }
  return scripts;
}

// ---------------------------------------------------------------------------
// space（zone-grid）
// ---------------------------------------------------------------------------

const TERRAIN_CELL_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5#.~+*/:-]{1,32}$/;

interface ZoneLite {
  zoneId: string;
  parentZoneId?: string;
  connections: Array<{ to: string; path: string }>;
  battleMapId?: string;
}

interface SpawnLite {
  path: string;
  side?: SpawnSide;
  cells: Array<[number, number]>;
  monsterId?: string;
}

function validateUnits(raw: unknown, ctx: Ctx): SpaceDef['units'] {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    if (raw.length === 0) {
      error(ctx, 'space.units', '必须是非空字符串或 { cell, name } 对象');
      return undefined;
    }
    return raw;
  }
  if (!isRecord(raw)) {
    error(ctx, 'space.units', '必须是展示单位字符串（m/ft/格）或 { cell, name } 对象');
    return undefined;
  }
  const cell = raw.cell === undefined ? undefined : isFiniteNumber(raw.cell) && raw.cell > 0 ? raw.cell : undefined;
  if (raw.cell !== undefined && cell === undefined) error(ctx, 'space.units.cell', '必须是正数');
  const name = readOptionalString(raw.name, 'space.units.name', ctx);
  return { ...(cell !== undefined ? { cell } : {}), ...(name !== undefined ? { name } : {}) };
}

function validateTerrains(raw: unknown, ctx: Ctx): { defs: TerrainDef[]; ids: Set<string> } {
  const defs: TerrainDef[] = [];
  const ids = new Set<string>();
  if (raw === undefined) return { defs, ids };
  if (!Array.isArray(raw)) {
    error(ctx, 'space.terrains', '必须是数组');
    return { defs, ids };
  }
  raw.forEach((value, index) => {
    const path = `space.terrains[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, ids, ctx, '地形 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const moveCost = value.moveCost === undefined ? undefined : isFiniteNumber(value.moveCost) ? value.moveCost : undefined;
    if (value.moveCost !== undefined && moveCost === undefined) error(ctx, `${path}.moveCost`, '必须是数值');
    const blocksMove = value.blocksMove === undefined ? undefined : typeof value.blocksMove === 'boolean' ? value.blocksMove : undefined;
    if (value.blocksMove !== undefined && blocksMove === undefined) error(ctx, `${path}.blocksMove`, '必须是布尔值');
    const blocksSight = value.blocksSight === undefined ? undefined : typeof value.blocksSight === 'boolean' ? value.blocksSight : undefined;
    if (value.blocksSight !== undefined && blocksSight === undefined) error(ctx, `${path}.blocksSight`, '必须是布尔值');
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    if (id === undefined) return;
    defs.push({
      id,
      name: name ?? id,
      ...(moveCost !== undefined ? { moveCost } : {}),
      ...(blocksMove !== undefined ? { blocksMove } : {}),
      ...(blocksSight !== undefined ? { blocksSight } : {}),
      ...(icon !== undefined ? { icon } : {}),
    });
  });
  return { defs, ids };
}

function validateCovers(raw: unknown, ctx: Ctx): { defs: CoverDef[]; ids: Set<string> } {
  const defs: CoverDef[] = [];
  const ids = new Set<string>();
  if (raw === undefined) return { defs, ids };
  if (!Array.isArray(raw)) {
    error(ctx, 'space.covers', '必须是数组');
    return { defs, ids };
  }
  raw.forEach((value, index) => {
    const path = `space.covers[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, ids, ctx, '掩体 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    const defenseBonus = value.defenseBonus === undefined ? undefined : isFiniteNumber(value.defenseBonus) ? value.defenseBonus : undefined;
    if (value.defenseBonus !== undefined && defenseBonus === undefined) error(ctx, `${path}.defenseBonus`, '必须是数值');
    let tags: string[] | undefined;
    if (value.tags !== undefined) {
      if (!Array.isArray(value.tags)) {
        error(ctx, `${path}.tags`, '必须是字符串数组');
      } else {
        tags = [];
        value.tags.forEach((tag, tagIndex) => {
          if (isNonEmptyString(tag)) tags?.push(tag);
          else error(ctx, `${path}.tags[${tagIndex}]`, '必须是非空字符串');
        });
      }
    }
    if (id === undefined) return;
    defs.push({
      id,
      name: name ?? id,
      ...(defenseBonus !== undefined ? { defenseBonus } : {}),
      ...(tags !== undefined ? { tags } : {}),
    });
  });
  return { defs, ids };
}

function validateZones(raw: unknown, ctx: Ctx): { defs: ZoneDef[]; lites: ZoneLite[]; ids: Set<string> } {
  const defs: ZoneDef[] = [];
  const lites: ZoneLite[] = [];
  const ids = new Set<string>();
  if (raw === undefined) return { defs, lites, ids };
  if (!Array.isArray(raw)) {
    error(ctx, 'space.zones', '必须是数组');
    return { defs, lites, ids };
  }
  raw.forEach((value, index) => {
    const path = `space.zones[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const zoneId = readUniqueId(readId(value.zoneId, `${path}.zoneId`, ctx, 'path'), `${path}.zoneId`, ids, ctx, '区域 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    let parentZoneId: string | undefined;
    if (value.parentZoneId !== undefined && value.parentZoneId !== null) {
      if (!isNonEmptyString(value.parentZoneId)) error(ctx, `${path}.parentZoneId`, '必须是 zoneId 字符串或 null');
      else parentZoneId = value.parentZoneId;
    }
    let tags: string[] | undefined;
    if (value.tags !== undefined) {
      if (!Array.isArray(value.tags)) {
        error(ctx, `${path}.tags`, '必须是字符串数组');
      } else {
        tags = [];
        value.tags.forEach((tag, tagIndex) => {
          if (isNonEmptyString(tag)) tags?.push(tag);
          else error(ctx, `${path}.tags[${tagIndex}]`, '必须是非空字符串');
        });
      }
    }
    const connections: ZoneConnectionDef[] = [];
    const connectionRefs: Array<{ to: string; path: string }> = [];
    if (value.connections !== undefined) {
      if (!Array.isArray(value.connections)) {
        error(ctx, `${path}.connections`, '必须是数组');
      } else {
        value.connections.forEach((connection, connectionIndex) => {
          const connectionPath = `${path}.connections[${connectionIndex}]`;
          if (!isRecord(connection)) {
            error(ctx, connectionPath, '必须是对象 { to, kind?, distance? }');
            return;
          }
          const to = isNonEmptyString(connection.to) ? connection.to : undefined;
          if (to === undefined) {
            error(ctx, `${connectionPath}.to`, '必填且必须是非空字符串');
            return;
          }
          const kind = readOptionalString(connection.kind, `${connectionPath}.kind`, ctx);
          const distance = connection.distance === undefined
            ? undefined
            : isFiniteNumber(connection.distance) && connection.distance >= 0
              ? connection.distance
              : undefined;
          if (connection.distance !== undefined && distance === undefined) {
            error(ctx, `${connectionPath}.distance`, '必须是非负数值');
          }
          connections.push({ to, ...(kind !== undefined ? { kind } : {}), ...(distance !== undefined ? { distance } : {}) });
          connectionRefs.push({ to, path: connectionPath });
        });
      }
    }
    let battleMapId: string | undefined;
    if (value.battleMapId !== undefined && value.battleMapId !== null) {
      if (!isNonEmptyString(value.battleMapId)) error(ctx, `${path}.battleMapId`, '必须是 mapId 字符串或 null');
      else battleMapId = value.battleMapId;
    }
    let hotspot: ZoneHotspotDef | undefined;
    if (value.hotspot !== undefined) {
      if (!isRecord(value.hotspot)) {
        error(ctx, `${path}.hotspot`, '必须是对象 { x, y }');
      } else {
        const x = isFiniteNumber(value.hotspot.x) ? value.hotspot.x : undefined;
        const y = isFiniteNumber(value.hotspot.y) ? value.hotspot.y : undefined;
        if (x === undefined || x < 0 || x > 1) error(ctx, `${path}.hotspot.x`, '必须是 0–1 的归一化坐标');
        if (y === undefined || y < 0 || y > 1) error(ctx, `${path}.hotspot.y`, '必须是 0–1 的归一化坐标');
        const w = value.hotspot.w === undefined ? undefined : isFiniteNumber(value.hotspot.w) && value.hotspot.w > 0 ? value.hotspot.w : undefined;
        if (value.hotspot.w !== undefined && w === undefined) error(ctx, `${path}.hotspot.w`, '必须是正数');
        const h = value.hotspot.h === undefined ? undefined : isFiniteNumber(value.hotspot.h) && value.hotspot.h > 0 ? value.hotspot.h : undefined;
        if (value.hotspot.h !== undefined && h === undefined) error(ctx, `${path}.hotspot.h`, '必须是正数');
        const icon = readOptionalString(value.hotspot.icon, `${path}.hotspot.icon`, ctx);
        if (x !== undefined && y !== undefined && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
          hotspot = { x, y, ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}), ...(icon !== undefined ? { icon } : {}) };
        }
      }
    }
    const description = readOptionalString(value.description, `${path}.description`, ctx);
    if (zoneId === undefined) return;
    defs.push({
      zoneId,
      name: name ?? zoneId,
      ...(parentZoneId !== undefined ? { parentZoneId } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(connections.length > 0 ? { connections } : {}),
      ...(battleMapId !== undefined ? { battleMapId } : {}),
      ...(hotspot !== undefined ? { hotspot } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    lites.push({
      zoneId,
      ...(parentZoneId !== undefined ? { parentZoneId } : {}),
      connections: connectionRefs,
      ...(battleMapId !== undefined ? { battleMapId } : {}),
    });
  });
  return { defs, lites, ids };
}

function validateObstacle(
  raw: unknown,
  path: string,
  cols: number,
  rows: number,
  terrainIds: ReadonlySet<string>,
  coverIds: ReadonlySet<string>,
  ctx: Ctx,
): ObstacleDef | undefined {
  if (!isRecord(raw)) {
    error(ctx, path, '必须是对象 { x, y, w?, h? }');
    return undefined;
  }
  const x = isInteger(raw.x) ? raw.x : undefined;
  const y = isInteger(raw.y) ? raw.y : undefined;
  if (x === undefined) error(ctx, `${path}.x`, '必须是整数格坐标');
  if (y === undefined) error(ctx, `${path}.y`, '必须是整数格坐标');
  const w = raw.w === undefined ? 1 : isPositiveInteger(raw.w) ? raw.w : undefined;
  if (raw.w !== undefined && w === undefined) error(ctx, `${path}.w`, '必须是正整数');
  const h = raw.h === undefined ? 1 : isPositiveInteger(raw.h) ? raw.h : undefined;
  if (raw.h !== undefined && h === undefined) error(ctx, `${path}.h`, '必须是正整数');
  if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
    if (x < 0 || y < 0 || x + w > cols || y + h > rows) {
      error(ctx, path, `越界：障碍 ${w}×${h} @ (${x},${y}) 超出 ${cols}×${rows} 地图`);
    }
  }
  let terrain: string | undefined;
  if (raw.terrain !== undefined) {
    if (!isNonEmptyString(raw.terrain)) {
      error(ctx, `${path}.terrain`, '必须是非空字符串（地形 id）');
    } else if (terrainIds.size > 0 && !terrainIds.has(raw.terrain)) {
      error(ctx, `${path}.terrain`, `引用了未声明的地形 "${raw.terrain}"`);
    } else {
      terrain = raw.terrain;
    }
  }
  let coverId: string | undefined;
  if (raw.coverId !== undefined) {
    if (!isNonEmptyString(raw.coverId)) {
      error(ctx, `${path}.coverId`, '必须是非空字符串（掩体 id）');
    } else if (!coverIds.has(raw.coverId)) {
      error(ctx, `${path}.coverId`, `引用了未声明的掩体 "${raw.coverId}"`);
    } else {
      coverId = raw.coverId;
    }
  }
  const kind = readOptionalString(raw.kind, `${path}.kind`, ctx);
  if (x === undefined || y === undefined) return undefined;
  return {
    x,
    y,
    ...(w !== undefined ? { w } : {}),
    ...(h !== undefined ? { h } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(terrain !== undefined ? { terrain } : {}),
    ...(coverId !== undefined ? { coverId } : {}),
  };
}

function validateBattleMaps(
  raw: unknown,
  ctx: Ctx,
  zoneIds: ReadonlySet<string>,
  terrainIds: ReadonlySet<string>,
  coverIds: ReadonlySet<string>,
): { defs: BattleMapDef[]; ids: Set<string> } {
  const defs: BattleMapDef[] = [];
  const ids = new Set<string>();
  if (raw === undefined) return { defs, ids };
  if (!Array.isArray(raw)) {
    error(ctx, 'space.battleMaps', '必须是数组');
    return { defs, ids };
  }
  if (raw.length > RULE_LIMITS.maxBattleMaps) {
    error(ctx, 'space.battleMaps', `地图数量 ${raw.length} 超过上限 ${RULE_LIMITS.maxBattleMaps}`);
  }
  if (terrainIds.size === 0) {
    warn(ctx, 'space.terrains', '未声明地形表：terrain 单元格按自由字符串（图例字符）校验');
  }
  raw.forEach((value, index) => {
    const path = `space.battleMaps[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const mapId = readUniqueId(readId(value.mapId, `${path}.mapId`, ctx, 'path'), `${path}.mapId`, ids, ctx, '地图 id');
    let zoneId: string | undefined;
    if (value.zoneId !== undefined && value.zoneId !== null) {
      if (!isNonEmptyString(value.zoneId)) {
        error(ctx, `${path}.zoneId`, '必须是 zoneId 字符串或 null');
      } else if (!zoneIds.has(value.zoneId)) {
        error(ctx, `${path}.zoneId`, `引用了不存在的区域 "${value.zoneId}"`);
      } else {
        zoneId = value.zoneId;
      }
    }
    const cols = isInteger(value.cols) && value.cols >= 1 && value.cols <= RULE_LIMITS.maxMapCols ? value.cols : undefined;
    if (cols === undefined) {
      error(ctx, `${path}.cols`, `必须是 1–${RULE_LIMITS.maxMapCols} 的整数`);
    }
    const rows = isInteger(value.rows) && value.rows >= 1 && value.rows <= RULE_LIMITS.maxMapRows ? value.rows : undefined;
    if (rows === undefined) {
      error(ctx, `${path}.rows`, `必须是 1–${RULE_LIMITS.maxMapRows} 的整数`);
    }
    let terrain: string[][] | undefined;
    if (value.terrain !== undefined) {
      if (!Array.isArray(value.terrain)) {
        error(ctx, `${path}.terrain`, '必须是 terrain 矩阵（rows 行 × cols 列）');
      } else if (cols !== undefined && rows !== undefined) {
        if (value.terrain.length !== rows) {
          error(ctx, `${path}.terrain`, `行数 ${value.terrain.length} 与 rows=${rows} 不一致`);
        }
        const matrix: string[][] = [];
        value.terrain.forEach((rowValue, rowIndex) => {
          const rowPath = `${path}.terrain[${rowIndex}]`;
          if (!Array.isArray(rowValue)) {
            error(ctx, rowPath, '必须是数组');
            matrix.push([]);
            return;
          }
          if (rowValue.length !== cols) {
            error(ctx, rowPath, `列数 ${rowValue.length} 与 cols=${cols} 不一致`);
          }
          const row: string[] = [];
          rowValue.forEach((cell, colIndex) => {
            if (!isNonEmptyString(cell)) {
              error(ctx, `${rowPath}[${colIndex}]`, '必须是非空字符串（地形 id 或图例字符）');
              row.push('');
              return;
            }
            if (terrainIds.size > 0) {
              if (!terrainIds.has(cell)) {
                error(ctx, `${rowPath}[${colIndex}]`, `引用了未声明的地形 "${cell}"`);
              }
            } else if (!TERRAIN_CELL_PATTERN.test(cell)) {
              error(ctx, `${rowPath}[${colIndex}]`, `"${cell}" 不是合法地形字符（建议单字符图例或 terrains[].id）`);
            }
            row.push(cell);
          });
          matrix.push(row);
        });
        terrain = matrix;
      }
    }
    const obstacles: ObstacleDef[] = [];
    if (value.obstacles !== undefined) {
      if (!Array.isArray(value.obstacles)) {
        error(ctx, `${path}.obstacles`, '必须是数组');
      } else if (cols !== undefined && rows !== undefined) {
        value.obstacles.forEach((obstacle, obstacleIndex) => {
          const parsed = validateObstacle(
            obstacle,
            `${path}.obstacles[${obstacleIndex}]`,
            cols,
            rows,
            terrainIds,
            coverIds,
            ctx,
          );
          if (parsed !== undefined) obstacles.push(parsed);
        });
      }
    }
    const spawns: BattleSpawnDef[] = [];
    const spawnLites: SpawnLite[] = [];
    if (value.spawns !== undefined) {
      if (!Array.isArray(value.spawns)) {
        error(ctx, `${path}.spawns`, '必须是数组');
      } else if (cols !== undefined && rows !== undefined) {
        let totalCells = 0;
        value.spawns.forEach((spawn, spawnIndex) => {
          const spawnPath = `${path}.spawns[${spawnIndex}]`;
          if (!isRecord(spawn)) {
            error(ctx, spawnPath, '必须是对象（{ team, cells } 或 { x, y, side }）');
            return;
          }
          const teamRaw = spawn.team ?? spawn.side;
          const side =
            typeof teamRaw === 'string' && (SPAWN_SIDES as readonly string[]).includes(teamRaw)
              ? (teamRaw as SpawnSide)
              : undefined;
          if (side === undefined) {
            error(ctx, spawnPath, `必须声明 team（或 side）且为 ${SPAWN_SIDES.join('/')} 之一`);
          }
          const cells: Array<[number, number]> = [];
          if (spawn.cells !== undefined) {
            if (!Array.isArray(spawn.cells)) {
              error(ctx, `${spawnPath}.cells`, '必须是 [[x,y], …] 坐标数组');
            } else {
              spawn.cells.forEach((cell, cellIndex) => {
                if (!Array.isArray(cell) || cell.length !== 2) {
                  error(ctx, `${spawnPath}.cells[${cellIndex}]`, '必须是 [x, y] 两元组');
                  return;
                }
                const x = cell[0];
                const y = cell[1];
                if (!isInteger(x) || !isInteger(y)) {
                  error(ctx, `${spawnPath}.cells[${cellIndex}]`, '坐标必须是整数');
                  return;
                }
                if (x < 0 || y < 0 || x >= cols || y >= rows) {
                  error(ctx, `${spawnPath}.cells[${cellIndex}]`, `坐标 (${x},${y}) 越界（地图 ${cols}×${rows}）`);
                  return;
                }
                cells.push([x, y]);
              });
            }
          } else if (spawn.x !== undefined || spawn.y !== undefined) {
            const x = isInteger(spawn.x) ? spawn.x : undefined;
            const y = isInteger(spawn.y) ? spawn.y : undefined;
            if (x === undefined || y === undefined) {
              error(ctx, spawnPath, '坐标写法需要同时给出整数 x 与 y');
            } else if (x < 0 || y < 0 || x >= cols || y >= rows) {
              error(ctx, spawnPath, `坐标 (${x},${y}) 越界（地图 ${cols}×${rows}）`);
            } else {
              cells.push([x, y]);
            }
          } else {
            error(ctx, spawnPath, '必须给出 cells 或 x/y');
          }
          totalCells += cells.length;
          const label = readOptionalString(spawn.label, `${spawnPath}.label`, ctx);
          const monsterId = readOptionalString(spawn.monsterId, `${spawnPath}.monsterId`, ctx);
          if (cells.length > 0) {
            spawns.push({
              ...(side !== undefined ? { team: side } : {}),
              cells,
              ...(label !== undefined ? { label } : {}),
              ...(monsterId !== undefined ? { monsterId } : {}),
            });
            spawnLites.push({ path: spawnPath, ...(side !== undefined ? { side } : {}), cells, ...(monsterId !== undefined ? { monsterId } : {}) });
          }
        });
        if (totalCells > RULE_LIMITS.maxSpawnPoints) {
          error(ctx, `${path}.spawns`, `出生点总数 ${totalCells} 超过单图上限 ${RULE_LIMITS.maxSpawnPoints}`);
        }
        // 出生点互不重叠
        const occupied = new Map<string, string>();
        for (const spawnLite of spawnLites) {
          for (const [x, y] of spawnLite.cells) {
            const key = `${x},${y}`;
            const previous = occupied.get(key);
            if (previous !== undefined) {
              error(ctx, spawnLite.path, `出生点与 ${previous} 重叠：格 (${x},${y}) 被重复占用`);
            } else {
              occupied.set(key, spawnLite.path);
            }
          }
        }
      }
    }
    let calibration: BattleMapDef['calibration'];
    if (value.calibration !== undefined) {
      if (!isRecord(value.calibration)) {
        error(ctx, `${path}.calibration`, '必须是对象');
      } else {
        calibration = {};
        for (const field of ['offsetX', 'offsetY', 'cellPx', 'scale'] as const) {
          if (value.calibration[field] === undefined) continue;
          if (!isFiniteNumber(value.calibration[field])) {
            error(ctx, `${path}.calibration.${field}`, '必须是数值');
          } else {
            calibration[field] = value.calibration[field] as number;
          }
        }
      }
    }
    const backgroundAssetId = readOptionalString(value.backgroundAssetId, `${path}.backgroundAssetId`, ctx);
    const name = readOptionalString(value.name, `${path}.name`, ctx);
    if (mapId === undefined) return;
    defs.push({
      mapId,
      ...(zoneId !== undefined ? { zoneId } : {}),
      cols: cols ?? 0,
      rows: rows ?? 0,
      ...(terrain !== undefined ? { terrain } : {}),
      ...(obstacles.length > 0 ? { obstacles } : {}),
      ...(spawns.length > 0 ? { spawns } : {}),
      ...(backgroundAssetId !== undefined ? { backgroundAssetId } : {}),
      ...(calibration !== undefined ? { calibration } : {}),
      ...(name !== undefined ? { name } : {}),
    });
  });
  return { defs, ids };
}

function validateSpace(raw: unknown, ctx: Ctx): SpaceDef | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    error(ctx, 'space', '必须是对象');
    return undefined;
  }
  const modelValue = raw.model;
  const model =
    typeof modelValue === 'string' && (SPACE_MODELS as readonly string[]).includes(modelValue)
      ? (modelValue as SpaceModel)
      : undefined;
  if (model === undefined) error(ctx, 'space.model', `必须是 ${SPACE_MODELS.join('/')} 之一`);
  const units = validateUnits(raw.units, ctx);
  let distanceMode: DistanceMode | undefined;
  if (raw.distanceMode !== undefined) {
    if (typeof raw.distanceMode !== 'string' || !(DISTANCE_MODES as readonly string[]).includes(raw.distanceMode)) {
      error(ctx, 'space.distanceMode', `必须是 ${DISTANCE_MODES.join('/')} 之一`);
    } else {
      distanceMode = raw.distanceMode as DistanceMode;
    }
  }
  let grid: { cellMeters?: number } | undefined;
  if (raw.grid !== undefined) {
    if (!isRecord(raw.grid)) {
      error(ctx, 'space.grid', '必须是对象 { cellMeters? }');
    } else {
      grid = {};
      if (raw.grid.cellMeters !== undefined) {
        if (!isFiniteNumber(raw.grid.cellMeters) || raw.grid.cellMeters <= 0) {
          error(ctx, 'space.grid.cellMeters', '必须是正数（米）');
        } else {
          grid.cellMeters = raw.grid.cellMeters;
        }
      }
    }
  }
  let world: SpaceDef['world'];
  if (raw.world !== undefined) {
    if (!isRecord(raw.world)) {
      error(ctx, 'space.world', '必须是对象');
    } else {
      world = {};
      const backgroundAssetId = readOptionalString(raw.world.backgroundAssetId, 'space.world.backgroundAssetId', ctx);
      if (backgroundAssetId !== undefined) world.backgroundAssetId = backgroundAssetId;
      for (const field of ['width', 'height'] as const) {
        if (raw.world[field] === undefined) continue;
        if (!isPositiveInteger(raw.world[field])) error(ctx, `space.world.${field}`, '必须是正整数像素');
        else world[field] = raw.world[field] as number;
      }
    }
  }
  const terrains = validateTerrains(raw.terrains, ctx);
  const covers = validateCovers(raw.covers, ctx);
  const zones = validateZones(raw.zones, ctx);
  const battleMaps = validateBattleMaps(raw.battleMaps, ctx, zones.ids, terrains.ids, covers.ids);
  // 区域引用校验
  for (const zone of zones.lites) {
    if (zone.parentZoneId !== undefined) {
      if (!zones.ids.has(zone.parentZoneId)) {
        error(ctx, `space.zones`, `区域 "${zone.zoneId}" 的 parentZoneId 指向不存在的区域 "${zone.parentZoneId}"`);
      } else if (zone.parentZoneId === zone.zoneId) {
        error(ctx, `space.zones`, `区域 "${zone.zoneId}" 的 parentZoneId 不能指向自己`);
      }
    }
    for (const connection of zone.connections) {
      if (!zones.ids.has(connection.to)) {
        error(ctx, connection.path, `连接指向不存在的区域 "${connection.to}"`);
      }
    }
    if (zone.battleMapId !== undefined && !battleMaps.ids.has(zone.battleMapId)) {
      error(ctx, `space.zones`, `区域 "${zone.zoneId}" 的 battleMapId 指向不存在的地图 "${zone.battleMapId}"`);
    }
  }
  // 父子循环
  const parentMap = new Map<string, string | undefined>();
  for (const zone of zones.lites) parentMap.set(zone.zoneId, zone.parentZoneId);
  const reportedCycles = new Set<string>();
  for (const zone of zones.lites) {
    const chain = new Set<string>();
    let current: string | undefined = zone.zoneId;
    while (current !== undefined) {
      if (chain.has(current)) {
        if (!reportedCycles.has(current)) {
          reportedCycles.add(current);
          error(ctx, 'space.zones', `区域父子关系形成循环：${[...chain, current].join(' → ')}`);
        }
        break;
      }
      chain.add(current);
      current = parentMap.get(current);
    }
  }
  // 地图 ↔ 区域反向引用一致性（warning，不阻断）
  const zoneById = new Map(zones.lites.map((zone) => [zone.zoneId, zone]));
  for (const map of battleMaps.defs) {
    if (typeof map.zoneId !== 'string') continue;
    const zone = zoneById.get(map.zoneId);
    if (zone?.battleMapId !== undefined && zone.battleMapId !== map.mapId) {
      warn(ctx, `space.battleMaps`, `地图 "${map.mapId}" 声明 zoneId="${map.zoneId}"，但该区域的 battleMapId 指向 "${zone.battleMapId}"`);
    }
  }
  let areas: AreaDef[] | undefined;
  if (raw.areas !== undefined) {
    if (!Array.isArray(raw.areas)) {
      error(ctx, 'space.areas', '必须是数组');
    } else {
      areas = [];
      const seenAreas = new Set<string>();
      raw.areas.forEach((value, index) => {
        const path = `space.areas[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const areaId = readUniqueId(readId(value.areaId, `${path}.areaId`, ctx, 'path'), `${path}.areaId`, seenAreas, ctx, '区域效果 id');
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
        const effect = readOptionalString(value.effect, `${path}.effect`, ctx);
        if (areaId === undefined) return;
        areas?.push({ areaId, name: name ?? areaId, ...(effect !== undefined ? { effect } : {}) });
      });
    }
  }
  if (model === 'none' && ((raw.zones !== undefined && Array.isArray(raw.zones) && raw.zones.length > 0) || (raw.battleMaps !== undefined && Array.isArray(raw.battleMaps) && raw.battleMaps.length > 0))) {
    warn(ctx, 'space.model', 'model="none" 时 zones/battleMaps 数据不会被使用');
  }
  return {
    model: model ?? 'none',
    ...(units !== undefined ? { units } : {}),
    ...(distanceMode !== undefined ? { distanceMode } : {}),
    ...(grid !== undefined ? { grid } : {}),
    ...(world !== undefined ? { world } : {}),
    ...(zones.defs.length > 0 ? { zones: zones.defs } : {}),
    ...(battleMaps.defs.length > 0 ? { battleMaps: battleMaps.defs } : {}),
    ...(terrains.defs.length > 0 ? { terrains: terrains.defs } : {}),
    ...(covers.defs.length > 0 ? { covers: covers.defs } : {}),
    ...(areas !== undefined ? { areas } : {}),
  };
}

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

function validateTime(raw: unknown, ctx: Ctx): TimeDef | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    error(ctx, 'time', '必须是对象');
    return undefined;
  }
  const modelValue = raw.model;
  const model =
    typeof modelValue === 'string' && (TIME_MODELS as readonly string[]).includes(modelValue)
      ? (modelValue as TimeDef['model'])
      : undefined;
  if (model === undefined) error(ctx, 'time.model', `必须是 ${TIME_MODELS.join('/')} 之一`);
  let durationUnit: TimeDef['durationUnit'];
  if (raw.durationUnit !== undefined) {
    if (typeof raw.durationUnit !== 'string' || !(DURATION_UNITS as readonly string[]).includes(raw.durationUnit)) {
      error(ctx, 'time.durationUnit', `v1 只支持 ${DURATION_UNITS.join('/')}（时间只按回合计）`);
    } else {
      durationUnit = raw.durationUnit as TimeDef['durationUnit'];
    }
  }
  let defaultMaxRounds: number | undefined;
  if (raw.defaultMaxRounds !== undefined) {
    if (!isPositiveInteger(raw.defaultMaxRounds)) error(ctx, 'time.defaultMaxRounds', '必须是正整数回合数');
    else defaultMaxRounds = raw.defaultMaxRounds;
  }
  let onRoundLimit: TimeDef['onRoundLimit'];
  if (raw.onRoundLimit !== undefined) {
    if (typeof raw.onRoundLimit !== 'string' || !(ROUND_LIMIT_ACTIONS as readonly string[]).includes(raw.onRoundLimit)) {
      error(ctx, 'time.onRoundLimit', `必须是 ${ROUND_LIMIT_ACTIONS.join('/')} 之一`);
    } else {
      onRoundLimit = raw.onRoundLimit as TimeDef['onRoundLimit'];
    }
  }
  if (model === 'none' && (defaultMaxRounds !== undefined || onRoundLimit !== undefined)) {
    warn(ctx, 'time.model', 'model="none" 时 defaultMaxRounds/onRoundLimit 不会生效');
  }
  return {
    model: model ?? 'none',
    ...(durationUnit !== undefined ? { durationUnit } : {}),
    ...(defaultMaxRounds !== undefined ? { defaultMaxRounds } : {}),
    ...(onRoundLimit !== undefined ? { onRoundLimit } : {}),
  };
}

// ---------------------------------------------------------------------------
// progression / tables / items / ui / migrations（较轻量）
// ---------------------------------------------------------------------------

function validateProgression(raw: unknown, ctx: Ctx): ProgressionDef | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    error(ctx, 'progression', '必须是对象');
    return undefined;
  }
  let maxLevel: number | undefined;
  if (raw.maxLevel !== undefined) {
    if (!isPositiveInteger(raw.maxLevel)) error(ctx, 'progression.maxLevel', '必须是正整数');
    else maxLevel = raw.maxLevel;
  }
  let xpTable: number[] | undefined;
  if (raw.xpTable !== undefined) {
    if (!Array.isArray(raw.xpTable)) {
      error(ctx, 'progression.xpTable', '必须是数字数组');
    } else {
      xpTable = [];
      let previous = -1;
      raw.xpTable.forEach((value, index) => {
        if (!isNonNegativeInteger(value)) {
          error(ctx, `progression.xpTable[${index}]`, '必须是非负整数');
          return;
        }
        if (value < previous) {
          error(ctx, `progression.xpTable[${index}]`, `必须单调不减（前一项 ${previous}）`);
        }
        previous = value;
        xpTable?.push(value);
      });
    }
  }
  let grants: ProgressionDef['grants'];
  if (raw.grants !== undefined) {
    if (!Array.isArray(raw.grants)) {
      error(ctx, 'progression.grants', '必须是数组');
    } else {
      grants = [];
      raw.grants.forEach((value, index) => {
        const path = `progression.grants[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const atLevel = isPositiveInteger(value.atLevel) ? value.atLevel : undefined;
        if (atLevel === undefined) error(ctx, `${path}.atLevel`, '必须是正整数等级');
        if (atLevel !== undefined && maxLevel !== undefined && atLevel > maxLevel) {
          error(ctx, `${path}.atLevel`, `超过 maxLevel=${maxLevel}`);
        }
        const skillPoints = value.skillPoints === undefined
          ? undefined
          : isNonNegativeInteger(value.skillPoints)
            ? value.skillPoints
            : undefined;
        if (value.skillPoints !== undefined && skillPoints === undefined) {
          error(ctx, `${path}.skillPoints`, '必须是非负整数');
        }
        const note = readOptionalString(value.note, `${path}.note`, ctx);
        if (atLevel === undefined) return;
        grants?.push({ atLevel, ...(skillPoints !== undefined ? { skillPoints } : {}), ...(note !== undefined ? { note } : {}) });
      });
    }
  }
  return {
    ...(maxLevel !== undefined ? { maxLevel } : {}),
    ...(xpTable !== undefined ? { xpTable } : {}),
    ...(grants !== undefined ? { grants } : {}),
  };
}

function validateTables(raw: unknown, itemIds: ReadonlySet<string>, ctx: Ctx): RollTableDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    error(ctx, 'tables', '必须是数组');
    return undefined;
  }
  const defs: RollTableDef[] = [];
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `tables[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const tableId = readUniqueId(readId(value.tableId, `${path}.tableId`, ctx, 'path'), `${path}.tableId`, seen, ctx, '表 id');
    const roll = isNonEmptyString(value.roll) ? value.roll : undefined;
    if (roll === undefined) error(ctx, `${path}.roll`, '必填且必须是骰子表达式字符串（如 1d100）');
    else if (!DICE_PATTERN.test(roll)) error(ctx, `${path}.roll`, `"${roll}" 不是合法骰子表达式`);
    const entries: RollTableDef['entries'] = [];
    if (!Array.isArray(value.entries)) {
      error(ctx, `${path}.entries`, '必须是数组');
    } else if (value.entries.length === 0) {
      error(ctx, `${path}.entries`, '不能为空');
    } else {
      const intervals: Array<{ min: number; max: number; path: string }> = [];
      value.entries.forEach((entry, entryIndex) => {
        const entryPath = `${path}.entries[${entryIndex}]`;
        if (!isRecord(entry)) {
          error(ctx, entryPath, '必须是对象');
          return;
        }
        const min = isInteger(entry.min) ? entry.min : undefined;
        const max = isInteger(entry.max) ? entry.max : undefined;
        if (min === undefined) error(ctx, `${entryPath}.min`, '必须是整数');
        if (max === undefined) error(ctx, `${entryPath}.max`, '必须是整数');
        if (min !== undefined && max !== undefined && min > max) {
          error(ctx, `${entryPath}.min`, `不能大于 max（min=${min}, max=${max}）`);
        }
        let itemId: string | undefined;
        if (entry.itemId !== undefined) {
          if (!isNonEmptyString(entry.itemId)) error(ctx, `${entryPath}.itemId`, '必须是非空字符串');
          else {
            itemId = entry.itemId;
            if (itemIds.size > 0 && !itemIds.has(itemId)) {
              warn(ctx, `${entryPath}.itemId`, `引用了不在 items[] 内的物品 "${itemId}"（可能来自内容包）`);
            }
          }
        }
        const note = readOptionalString(entry.note, `${entryPath}.note`, ctx);
        const weight = entry.weight === undefined ? undefined : isFiniteNumber(entry.weight) && entry.weight > 0 ? entry.weight : undefined;
        if (entry.weight !== undefined && weight === undefined) error(ctx, `${entryPath}.weight`, '必须是正数');
        if (min !== undefined && max !== undefined && min <= max) {
          intervals.push({ min, max, path: entryPath });
          entries.push({ min, max, ...(itemId !== undefined ? { itemId } : {}), ...(weight !== undefined ? { weight } : {}), ...(note !== undefined ? { note } : {}) });
        }
      });
      intervals.sort((a, b) => a.min - b.min);
      for (let i = 1; i < intervals.length; i += 1) {
        const current = intervals[i];
        const previous = intervals[i - 1];
        if (current !== undefined && previous !== undefined && current.min <= previous.max) {
          error(ctx, current.path, `区间 [${current.min}, ${current.max}] 与 ${previous.path} 重叠`);
        }
      }
    }
    const description = readOptionalString(value.description, `${path}.description`, ctx);
    if (tableId === undefined) return;
    defs.push({ tableId, roll: roll ?? '1d100', entries, ...(description !== undefined ? { description } : {}) });
  });
  return defs;
}

function validateItems(
  raw: unknown,
  ctx: Ctx,
  statIds: ReadonlySet<string>,
  slotIds: ReadonlySet<string>,
  actionIds: ReadonlySet<string>,
): RulePackItemDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    error(ctx, 'items', '必须是数组');
    return undefined;
  }
  const defs: RulePackItemDef[] = [];
  const seen = new Set<string>();
  raw.forEach((value, index) => {
    const path = `items[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const itemId = readUniqueId(readId(value.itemId, `${path}.itemId`, ctx, 'path'), `${path}.itemId`, seen, ctx, '物品 id');
    const name = isNonEmptyString(value.name) ? value.name : undefined;
    if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
    let tags: string[] | undefined;
    if (value.tags !== undefined) {
      if (!Array.isArray(value.tags)) {
        error(ctx, `${path}.tags`, '必须是字符串数组');
      } else {
        tags = [];
        value.tags.forEach((tag, tagIndex) => {
          if (isNonEmptyString(tag)) tags?.push(tag);
          else error(ctx, `${path}.tags[${tagIndex}]`, '必须是非空字符串');
        });
      }
    }
    let stats: Record<string, number> | undefined;
    if (value.stats !== undefined) {
      if (!isRecord(value.stats)) {
        error(ctx, `${path}.stats`, '必须是 词条 id → 数值 的对象');
      } else {
        stats = {};
        for (const [statId, statValue] of Object.entries(value.stats)) {
          if (!isFiniteNumber(statValue)) {
            error(ctx, `${path}.stats.${statId}`, '必须是数值');
            continue;
          }
          if (statIds.size > 0 && !statIds.has(statId)) {
            error(ctx, `${path}.stats.${statId}`, `引用了未声明的词条 "${statId}"`);
            continue;
          }
          stats[statId] = statValue;
        }
      }
    }
    let equipSlot: string[] | undefined;
    if (value.equipSlot !== undefined) {
      if (!Array.isArray(value.equipSlot)) {
        error(ctx, `${path}.equipSlot`, '必须是槽位 id 数组');
      } else {
        equipSlot = [];
        value.equipSlot.forEach((slot, slotIndex) => {
          if (!isNonEmptyString(slot)) {
            error(ctx, `${path}.equipSlot[${slotIndex}]`, '必须是非空字符串');
            return;
          }
          if (!slotIds.has(slot)) {
            error(ctx, `${path}.equipSlot[${slotIndex}]`, `引用了未声明的装备槽 "${slot}"`);
            return;
          }
          equipSlot?.push(slot);
        });
      }
    }
    let useAction: string | undefined;
    if (value.useAction !== undefined) {
      if (!isNonEmptyString(value.useAction)) {
        error(ctx, `${path}.useAction`, '必须是非空字符串（动作 id）');
      } else {
        useAction = value.useAction;
        if (actionIds.size > 0 && !actionIds.has(useAction)) {
          warn(ctx, `${path}.useAction`, `引用了不在 actions[] 内的动作 "${useAction}"（可能由钩子处理）`);
        }
      }
    }
    const rarity = readOptionalString(value.rarity, `${path}.rarity`, ctx);
    const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
    const description = readOptionalString(value.description, `${path}.description`, ctx);
    let stackable: boolean | undefined;
    if (value.stackable !== undefined) {
      if (typeof value.stackable !== 'boolean') error(ctx, `${path}.stackable`, '必须是布尔值');
      else stackable = value.stackable;
    }
    if (itemId === undefined) return;
    defs.push({
      itemId,
      name: name ?? itemId,
      ...(icon !== undefined ? { icon } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(rarity !== undefined ? { rarity } : {}),
      ...(stats !== undefined ? { stats } : {}),
      ...(equipSlot !== undefined ? { equipSlot } : {}),
      ...(stackable !== undefined ? { stackable } : {}),
      ...(useAction !== undefined ? { useAction } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  });
  return defs;
}

function validateUi(raw: unknown, ctx: Ctx): RulePackUi | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    error(ctx, 'ui', '必须是对象');
    return undefined;
  }
  let groups: UiGroupDef[] | undefined;
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups)) {
      error(ctx, 'ui.groups', '必须是数组');
    } else {
      groups = [];
      const seen = new Set<string>();
      raw.groups.forEach((value, index) => {
        const path = `ui.groups[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '分组 id');
        const title = isNonEmptyString(value.title) ? value.title : undefined;
        if (!title) error(ctx, `${path}.title`, '必填且必须是非空字符串');
        const fields: string[] = [];
        if (!Array.isArray(value.fields)) {
          error(ctx, `${path}.fields`, '必须是字符串数组');
        } else {
          value.fields.forEach((field, fieldIndex) => {
            if (isNonEmptyString(field)) fields.push(field);
            else error(ctx, `${path}.fields[${fieldIndex}]`, '必须是非空字符串');
          });
        }
        if (id === undefined) return;
        groups?.push({ id, title: title ?? id, fields });
      });
    }
  }
  let itemCategories: UiItemCategoryDef[] | undefined;
  if (raw.itemCategories !== undefined) {
    if (!Array.isArray(raw.itemCategories)) {
      error(ctx, 'ui.itemCategories', '必须是数组');
    } else {
      itemCategories = [];
      const seen = new Set<string>();
      raw.itemCategories.forEach((value, index) => {
        const path = `ui.itemCategories[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '物品分类 id');
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
        const icon = readOptionalString(value.icon, `${path}.icon`, ctx);
        let tags: string[] | undefined;
        if (value.tags !== undefined) {
          if (!Array.isArray(value.tags)) error(ctx, `${path}.tags`, '必须是字符串数组');
          else tags = value.tags.filter((tag): tag is string => isNonEmptyString(tag));
        }
        if (id === undefined) return;
        itemCategories?.push({ id, name: name ?? id, ...(icon !== undefined ? { icon } : {}), ...(tags !== undefined ? { tags } : {}) });
      });
    }
  }
  let rarities: UiRarityDef[] | undefined;
  if (raw.rarities !== undefined) {
    if (!Array.isArray(raw.rarities)) {
      error(ctx, 'ui.rarities', '必须是数组');
    } else {
      rarities = [];
      const seen = new Set<string>();
      raw.rarities.forEach((value, index) => {
        const path = `ui.rarities[${index}]`;
        if (!isRecord(value)) {
          error(ctx, path, '必须是对象');
          return;
        }
        const id = readUniqueId(readId(value.id, `${path}.id`, ctx), `${path}.id`, seen, ctx, '稀有度 id');
        const name = isNonEmptyString(value.name) ? value.name : undefined;
        if (!name) error(ctx, `${path}.name`, '必填且必须是非空字符串');
        const color = readOptionalString(value.color, `${path}.color`, ctx);
        if (id === undefined) return;
        rarities?.push({ id, name: name ?? id, ...(color !== undefined ? { color } : {}) });
      });
    }
  }
  let templates: RulePackUi['templates'];
  if (raw.templates !== undefined) {
    if (!isRecord(raw.templates)) {
      error(ctx, 'ui.templates', '必须是对象（模板名 → 字段名数组）');
    } else {
      templates = {};
      for (const [templateId, fields] of Object.entries(raw.templates)) {
        if (!Array.isArray(fields)) {
          error(ctx, `ui.templates.${templateId}`, '必须是字符串数组');
          continue;
        }
        const parsed: string[] = [];
        fields.forEach((field, fieldIndex) => {
          if (isNonEmptyString(field)) parsed.push(field);
          else error(ctx, `ui.templates.${templateId}[${fieldIndex}]`, '必须是非空字符串');
        });
        templates[templateId] = parsed;
      }
    }
  }
  let worldMap: RulePackUi['worldMap'];
  if (raw.worldMap !== undefined) {
    if (!isRecord(raw.worldMap)) {
      error(ctx, 'ui.worldMap', '必须是对象');
    } else {
      worldMap = {};
      if (raw.worldMap.labelMode !== undefined) {
        if (raw.worldMap.labelMode !== 'always' && raw.worldMap.labelMode !== 'hover' && raw.worldMap.labelMode !== 'never') {
          error(ctx, 'ui.worldMap.labelMode', '必须是 always/hover/never 之一');
        } else {
          worldMap.labelMode = raw.worldMap.labelMode;
        }
      }
      for (const field of ['showConnections', 'currentZonePulse', 'exploredOnly'] as const) {
        if (raw.worldMap[field] === undefined) continue;
        if (typeof raw.worldMap[field] !== 'boolean') error(ctx, `ui.worldMap.${field}`, '必须是布尔值');
        else worldMap[field] = raw.worldMap[field] as boolean;
      }
    }
  }
  let battleGrid: RulePackUi['battleGrid'];
  if (raw.battleGrid !== undefined) {
    if (!isRecord(raw.battleGrid)) {
      error(ctx, 'ui.battleGrid', '必须是对象');
    } else {
      battleGrid = {};
      if (raw.battleGrid.gridOpacity !== undefined) {
        if (!isFiniteNumber(raw.battleGrid.gridOpacity) || raw.battleGrid.gridOpacity < 0 || raw.battleGrid.gridOpacity > 1) {
          error(ctx, 'ui.battleGrid.gridOpacity', '必须是 0–1 的数值');
        } else {
          battleGrid.gridOpacity = raw.battleGrid.gridOpacity;
        }
      }
      if (raw.battleGrid.tokenSize !== undefined) {
        if (raw.battleGrid.tokenSize !== 'auto' && !isFiniteNumber(raw.battleGrid.tokenSize)) {
          error(ctx, 'ui.battleGrid.tokenSize', '必须是 "auto" 或数值');
        } else {
          battleGrid.tokenSize = raw.battleGrid.tokenSize as 'auto' | number;
        }
      }
      for (const field of ['showMoveRange', 'showDistanceOnHover', 'showCoverMarkers'] as const) {
        if (raw.battleGrid[field] === undefined) continue;
        if (typeof raw.battleGrid[field] !== 'boolean') error(ctx, `ui.battleGrid.${field}`, '必须是布尔值');
        else battleGrid[field] = raw.battleGrid[field] as boolean;
      }
    }
  }
  return {
    ...(groups !== undefined ? { groups } : {}),
    ...(itemCategories !== undefined ? { itemCategories } : {}),
    ...(rarities !== undefined ? { rarities } : {}),
    ...(templates !== undefined ? { templates } : {}),
    ...(worldMap !== undefined ? { worldMap } : {}),
    ...(battleGrid !== undefined ? { battleGrid } : {}),
  };
}

function validateMigrations(raw: unknown, ctx: Ctx): MigrationDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    error(ctx, 'migrations', '必须是数组');
    return undefined;
  }
  const defs: MigrationDef[] = [];
  raw.forEach((value, index) => {
    const path = `migrations[${index}]`;
    if (!isRecord(value)) {
      error(ctx, path, '必须是对象');
      return;
    }
    const fromVersion = isNonEmptyString(value.fromVersion) ? value.fromVersion : undefined;
    if (fromVersion === undefined) error(ctx, `${path}.fromVersion`, '必填且必须是非空字符串');
    const toVersion = isNonEmptyString(value.toVersion) ? value.toVersion : undefined;
    if (toVersion === undefined) error(ctx, `${path}.toVersion`, '必填且必须是非空字符串');
    const note = readOptionalString(value.note, `${path}.note`, ctx);
    if (fromVersion === undefined || toVersion === undefined) return;
    defs.push({ fromVersion, toVersion, ...(note !== undefined ? { note } : {}) });
  });
  return defs;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function validateRulePack(input: unknown, options: ValidateRulePackOptions = {}): ValidateResult<RulePack> {
  if (!isRecord(input)) {
    return { ok: false, errors: ['规则包必须是对象'], warnings: [] };
  }
  const ctx: Ctx = { errors: [], warnings: [] };
  // 顶层字段
  const allowedKeys = new Set<string>([...TOP_LEVEL_KEYS, ...(options.extraTopLevelKeys ?? [])]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) warn(ctx, key, '未知顶层字段，已忽略');
  }
  if (input.schemaVersion !== RULE_PACK_SCHEMA_VERSION) {
    error(ctx, 'schemaVersion', `必须为 "${RULE_PACK_SCHEMA_VERSION}"`);
  }
  let rulesId = '';
  if (!isNonEmptyString(input.rulesId)) {
    error(ctx, 'rulesId', '必填且必须是非空字符串');
  } else if (!ID_PATTERN.test(input.rulesId)) {
    error(ctx, 'rulesId', `"${input.rulesId}" 不是合法 id`);
  } else {
    rulesId = input.rulesId;
  }
  let rulesVersion = '';
  if (!isNonEmptyString(input.rulesVersion)) {
    error(ctx, 'rulesVersion', '必填且必须是非空字符串');
  } else if (!SEMVER_PATTERN.test(input.rulesVersion)) {
    error(ctx, 'rulesVersion', `"${input.rulesVersion}" 必须是语义化版本号（如 2.0.0）`);
  } else {
    rulesVersion = input.rulesVersion;
  }
  let name = '';
  if (!isNonEmptyString(input.name)) {
    error(ctx, 'name', '必填且必须是非空字符串');
  } else {
    name = input.name;
  }
  let description: string | undefined;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') error(ctx, 'description', '必须是字符串');
    else description = input.description;
  }
  // 各段
  const sheetOutcome = validateSheet(input.sheet, ctx);
  const scope: FormulaScope = {
    attributes: sheetOutcome.attributeIds,
    resources: sheetOutcome.resourceIds,
    fields: sheetOutcome.numberFieldIds,
    stats: sheetOutcome.statIds,
    skills: sheetOutcome.skillIds,
  };
  const formulaOutcome = validateFormulas(input.formulas, scope, ctx);
  // 资源上限公式引用
  sheetOutcome.sheet.resources.forEach((resource, index) => {
    const path = `sheet.resources[${index}].formula`;
    if (formulaOutcome.formulaNames.has(resource.formula)) return;
    const inline = compileFormula(resource.formula, scope);
    if (inline.ok) {
      warn(ctx, path, `使用了内联表达式 "${resource.formula}"，建议在 formulas 里定义命名公式`);
    } else {
      pushCompileErrors(ctx, path, inline.errors);
    }
  });
  // 技能内联公式
  sheetOutcome.sheet.skills.forEach((skill, index) => {
    if (skill.formula === undefined) return;
    const result = compileFormula(skill.formula, scope);
    if (!result.ok) pushCompileErrors(ctx, `sheet.skills[${index}].formula`, result.errors);
  });
  const resourceIdSet = new Set(sheetOutcome.resourceIds);
  const actionOutcome = validateActions(input.actions, ctx, formulaOutcome.formulaNames, resourceIdSet);
  const turnOutcome = validateTurn(input.turn, ctx, formulaOutcome.formulaNames);
  // 动作花费 → 行动经济资源 id
  for (const ref of actionOutcome.economicRefs) {
    if (!turnOutcome.turnResourceIds.has(ref.key)) {
      error(ctx, ref.path, `花费了行动经济资源 "${ref.key}"，但 turn 段没有声明该 id（已声明：${[...turnOutcome.turnResourceIds].join('/') || '无'}）`);
    }
  }
  const scripts = validateScripts(input.scripts, ctx, options);
  const space = validateSpace(input.space, ctx);
  const time = validateTime(input.time, ctx);
  const progression = validateProgression(input.progression, ctx);
  const statIdSet = new Set(sheetOutcome.statIds);
  const slotIdSet = new Set(sheetOutcome.slotIds);
  const items = validateItems(input.items, ctx, statIdSet, slotIdSet, actionOutcome.actionIds);
  const itemIdSet = new Set((items ?? []).map((item) => item.itemId));
  const tables = validateTables(input.tables, itemIdSet, ctx);
  const ui = validateUi(input.ui, ctx);
  const migrations = validateMigrations(input.migrations, ctx);
  // 组装
  const value: RulePack = {
    schemaVersion: RULE_PACK_SCHEMA_VERSION,
    rulesId,
    rulesVersion,
    name,
    ...(description !== undefined ? { description } : {}),
    sheet: sheetOutcome.sheet,
    actions: actionOutcome.actions,
    turn: turnOutcome.turn,
    formulas: formulaOutcome.formulas,
    ...(progression !== undefined ? { progression } : {}),
    ...(tables !== undefined ? { tables } : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(scripts !== undefined ? { scripts } : {}),
    ...(space !== undefined ? { space } : {}),
    ...(time !== undefined ? { time } : {}),
    ...(items !== undefined ? { items } : {}),
    ...(migrations !== undefined ? { migrations } : {}),
  };
  if (ctx.errors.length === 0 && options.strict === true && ctx.warnings.length > 0) {
    return {
      ok: false,
      errors: ctx.warnings.map((warning) => `[严格模式] ${warning}`),
      warnings: ctx.warnings,
    };
  }
  const ok = ctx.errors.length === 0;
  return {
    ok,
    errors: ctx.errors,
    warnings: ctx.warnings,
    ...(ok ? { value } : {}),
  };
}
