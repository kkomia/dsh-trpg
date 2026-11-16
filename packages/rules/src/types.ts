/**
 * 规则包（`trpg.rules/1`）/ 卡实例（`trpg.card/1`）/ 投影 DTO 的类型与常量。
 *
 * 契约来源：docs/RULES-MODEL.md §3/§4/§5、docs/UI-CONTRACT.md §6。
 * 实现约束（M9.1）：纯类型 + 常量，零外部依赖；**不使用 enum / namespace / 参数属性**
 * （Node 的 TS 类型剥离不支持这些语法），所以枚举一律用 `as const` 元组 + 联合类型。
 */

// ---------------------------------------------------------------------------
// schema 版本
// ---------------------------------------------------------------------------

export const RULE_PACK_SCHEMA_VERSION = 'trpg.rules/1' as const;
export type RulePackSchemaVersion = typeof RULE_PACK_SCHEMA_VERSION;

export const CARD_SCHEMA_VERSION = 'trpg.card/1' as const;
export type CardSchemaVersion = typeof CARD_SCHEMA_VERSION;

/** 旧 engine 角色卡（`CharacterCard` schemaVersion: 1）迁移入口的版本号。 */
export const LEGACY_CARD_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// id / 路径规范
// ---------------------------------------------------------------------------

/**
 * 规则包内 id 规范（docs/RULES-MODEL §3）：字母/数字/下划线/中文开头，后续允许 `-`。
 * namespace 内唯一。
 */
export const ID_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5-]*$/;

/**
 * 允许点分段的 id（actionId=`attack.melee`、tableId=`loot.common`、zoneId、mapId、itemId）。
 * 每段仍满足 {@link ID_PATTERN}。
 */
export const PATH_ID_PATTERN =
  /^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5-]*(\.[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5-]*)*$/;

/** 语义化版本（允许 prerelease / build 后缀，如 `2.0.0`、`1.0.0-rc.1`）。 */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 骰子表达式（只校验形状，真正掷骰在 M9.2 核心运行时）：`d20`、`1d8`、`2d6+3`。 */
export const DICE_PATTERN = /^\d*d\d+(?:[+-]\d+)?$/i;

/** 规则包脚本必须是 `rules/scripts/` 下的相对 `.js` 路径。 */
export const SCRIPT_PATH_PREFIX = 'rules/scripts/';

/** 脚本 sha256（小写十六进制，64 位）。 */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// 枚举型联合（const 元组 + union；不要改成 enum）
// ---------------------------------------------------------------------------

export const HOOK_NAMES = [
  // 核心 8
  'validateSheet',
  'computeDerived',
  'resolveCheck',
  'resolveAttack',
  'resolveDamage',
  'onEvent',
  'onLevelUp',
  'generateLoot',
  // 可选迁移钩子
  'migrateSheet',
  // 场地 / 时间 / 上限 9
  'computeDistance',
  'onMove',
  'onEnterZone',
  'onLeaveZone',
  'computeCover',
  'onTimeAdvance',
  'onRoundStart',
  'onRoundEnd',
  'onRoundLimit',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** 核心 8 钩子（不带 `migrateSheet`）。 */
export const CORE_HOOK_NAMES: readonly HookName[] = [
  'validateSheet',
  'computeDerived',
  'resolveCheck',
  'resolveAttack',
  'resolveDamage',
  'onEvent',
  'onLevelUp',
  'generateLoot',
];

/** 场地 / 时间 / 上限 9 钩子。 */
export const SCENE_HOOK_NAMES: readonly HookName[] = [
  'computeDistance',
  'onMove',
  'onEnterZone',
  'onLeaveZone',
  'computeCover',
  'onTimeAdvance',
  'onRoundStart',
  'onRoundEnd',
  'onRoundLimit',
];

export const DISTANCE_MODES = ['chebyshev', 'manhattan', 'dnd5e', 'euclid'] as const;
export type DistanceMode = (typeof DISTANCE_MODES)[number];

export const SPACE_MODELS = ['none', 'zone', 'grid', 'zone-grid'] as const;
export type SpaceModel = (typeof SPACE_MODELS)[number];

export const TIME_MODELS = ['round', 'none'] as const;
export type TimeModel = (typeof TIME_MODELS)[number];

export const ROUND_LIMIT_ACTIONS = ['end', 'draw', 'overtime'] as const;
export type RoundLimitAction = (typeof ROUND_LIMIT_ACTIONS)[number];

/** v1 时间片唯一单位（docs/RULES-MODEL §3 time）。 */
export const DURATION_UNITS = ['round'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const STACKING_MODES = ['add', 'max', 'min', 'unique'] as const;
export type StackingMode = (typeof STACKING_MODES)[number];

/** 状态叠加语义（文档只给了 refresh 示例，这里放宽为字符串 + 已知集，未知值仅 warning）。 */
export const STATUS_STACKING_MODES = ['refresh', 'stack', 'replace', 'none'] as const;
export type StatusStackingMode = (typeof STATUS_STACKING_MODES)[number];

export const FIELD_KINDS = ['text', 'number', 'enum'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export const ACTION_KINDS = ['attack', 'skill', 'spell', 'custom'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const TARGETING_TYPES = ['self', 'single', 'multi', 'area', 'all', 'none'] as const;
export type TargetingType = (typeof TARGETING_TYPES)[number];

export const TARGETING_SIDES = ['self', 'ally', 'enemy', 'any', 'all'] as const;
export type TargetingSide = (typeof TARGETING_SIDES)[number];

export const RANGE_BANDS = ['engaged', 'near', 'far'] as const;
export type RangeBand = (typeof RANGE_BANDS)[number];

/** 目标距离：theater-of-mind 档位，或格子数（space 场景）。 */
export type TargetingRange = RangeBand | number;

export const SPAWN_SIDES = ['player', 'enemy', 'neutral'] as const;
export type SpawnSide = (typeof SPAWN_SIDES)[number];

/** 公式白名单函数。 */
export const FORMULA_FUNCTIONS = ['min', 'max', 'floor', 'ceil', 'round', 'abs', 'clamp'] as const;
export type FormulaFunctionName = (typeof FORMULA_FUNCTIONS)[number];

/** 公式允许的变量命名空间（`attr.x` / `derived.x` / ...）。 */
export const FORMULA_NAMESPACES = [
  'attr',
  'derived',
  'equip',
  'skill',
  'sheet',
  'resource',
  'space',
  'time',
] as const;
export type FormulaNamespace = (typeof FORMULA_NAMESPACES)[number];

/** 不带命名空间的公式变量。 */
export const FORMULA_BASE_VARIABLES = ['level', 'proficiency'] as const;
export type FormulaBaseVariable = (typeof FORMULA_BASE_VARIABLES)[number];

/** `skill.<key>` 里由结算上下文注入、不要求规则包声明技能 id 的保留键。 */
export const SKILL_CONTEXT_KEYS = ['proficient', 'bonus'] as const;
export type SkillContextKey = (typeof SKILL_CONTEXT_KEYS)[number];

/** `space.<key>` 由核心运行时注入（docs/RULES-MODEL §3 space 末尾）。 */
export const SPACE_FORMULA_KEYS = ['hops', 'cells', 'meters'] as const;
export type SpaceFormulaKey = (typeof SPACE_FORMULA_KEYS)[number];

/** `time.<key>` 由核心运行时注入（v1 只有回合相关键）。 */
export const TIME_FORMULA_KEYS = ['round', 'segment', 'day'] as const;
export type TimeFormulaKey = (typeof TIME_FORMULA_KEYS)[number];

// ---------------------------------------------------------------------------
// 上限（docs/RULES-MODEL §3 / §6 / §10）
// ---------------------------------------------------------------------------

export const RULE_LIMITS = {
  /** 单张战斗图宽高上限。 */
  maxMapCols: 32,
  maxMapRows: 32,
  /** 一个规则包内战斗地图上限。 */
  maxBattleMaps: 64,
  /** 单张地图出生点 token 上限。 */
  maxSpawnPoints: 20,
  /** 规则包脚本数量上限。 */
  maxScripts: 32,
  /** 公式源码长度上限（防病态输入）。 */
  maxFormulaLength: 1024,
  /** 公式 AST 递归深度上限。 */
  maxFormulaDepth: 64,
} as const;

// ---------------------------------------------------------------------------
// 卡面字段约定（卡实例 schema 本身没有身份字段，身份落在 fields 里）
// ---------------------------------------------------------------------------

/** 卡 `fields` 里约定存放等级（number）的键：公式变量 `level` 的来源。 */
export const LEVEL_FIELD_ID = 'level';

/** 迁移器写入卡 `fields` 的身份键（规则包声明了同名 field 时才会写）。 */
export const IDENTITY_FIELD_IDS = [
  'name',
  'race',
  'class',
  'background',
  'publicSummary',
  'appearance',
  'personality',
] as const;

// ---------------------------------------------------------------------------
// Rule Pack 数据形状
// ---------------------------------------------------------------------------

export interface AttributeDef {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  icon?: string;
}

export interface ResourceDef {
  id: string;
  name: string;
  /** 命名公式名（如 `hpMax`），也接受内联表达式（校验时给 warning）。 */
  formula: string;
  icon?: string;
}

export interface FieldDef {
  id: string;
  name: string;
  kind: FieldKind;
  /** kind=`enum` 时必填且非空。 */
  options?: string[];
  icon?: string;
}

export interface EquipmentSlotDef {
  id: string;
  name: string;
  /** 物品标签白名单；`*` 表示任意。非空。 */
  accepts: string[];
  /** 可选件数，默认 1。 */
  count?: number;
  icon?: string;
}

export interface EquipmentStatDef {
  id: string;
  name: string;
  min?: number;
  max?: number;
  stacking: StackingMode;
  icon?: string;
}

export interface EquipmentDef {
  slots: EquipmentSlotDef[];
  stats: EquipmentStatDef[];
  /** 叠加方式的展示名：`{ add: '相加', max: '取最大', ... }`。 */
  stacking?: Record<string, string>;
}

export interface SkillDef {
  id: string;
  name: string;
  /** 关联属性 id（必须在 `sheet.attributes[]` 内）。 */
  attribute: string;
  /** 可选的内联加值公式（不写则用 `formulas.check` / 属性调整兜底）。 */
  formula?: string;
  icon?: string;
}

export interface StatusDef {
  id: string;
  name: string;
  /** 持续回合数（`time.durationUnit`，v1 = round）。 */
  duration?: number;
  stacking?: StatusStackingMode | string;
  icon?: string;
}

export interface SheetDef {
  attributes: AttributeDef[];
  resources: ResourceDef[];
  fields: FieldDef[];
  equipment: EquipmentDef;
  skills: SkillDef[];
  statuses: StatusDef[];
}

export interface ActionResourceCost {
  id: string;
  amount?: number;
}

/**
 * 动作花费。行动经济：键 = `turn.resources[].id`（如 `action`/`bonus`/`ap`），值 = 次数。
 * 角色资源：`resource` 写资源 id（字符串）或 `{ id, amount }`。
 */
export interface ActionCost {
  action?: number;
  resource?: string | ActionResourceCost;
  [economicResourceId: string]: number | string | ActionResourceCost | undefined;
}

export interface ActionTargeting {
  type: TargetingType;
  range: TargetingRange;
  sides: TargetingSide;
}

export interface ActionDamage {
  /** 命名公式名（伤害加值）。 */
  formula?: string;
  /** 骰子表达式字符串，如 `1d8`。 */
  dice?: string;
}

export interface ActionDef {
  actionId: string;
  name: string;
  kind: ActionKind;
  cost?: ActionCost;
  targeting: ActionTargeting;
  /** 命中/检定公式名（必须在 `formulas` 内）。 */
  toHit?: string;
  damage?: ActionDamage;
  description: string;
  icon?: string;
}

export interface TurnResourceDef {
  id: string;
  name: string;
  /** 每回合回满次数（M9.1 契约字段）。 */
  count?: number;
  /** docs 别名，等价 count。 */
  perTurn?: number;
  /** 由命名公式算每回合数值（如移动力）。 */
  perTurnFormula?: string;
  unit?: string;
  icon?: string;
}

export interface TurnMovementDef {
  id: string;
  name: string;
  /** 每回合移动格数。 */
  cells?: number;
  /** 每回合移动米数（与 cells 二选一）。 */
  meters?: number;
  perTurnFormula?: string;
  unit?: string;
}

export interface TurnEndOptions {
  trigger?: 'player' | 'auto';
}

export interface TurnDef {
  resources: TurnResourceDef[];
  movement?: TurnMovementDef;
  /** 目前只支持 turnStart（docs）。 */
  refill?: string;
  endTurn?: TurnEndOptions;
}

export interface ProgressionGrantDef {
  atLevel: number;
  skillPoints?: number;
  note?: string;
}

export interface ProgressionDef {
  maxLevel?: number;
  xpTable?: number[];
  grants?: ProgressionGrantDef[];
}

export interface RollTableEntryDef {
  min: number;
  max: number;
  itemId?: string;
  weight?: number;
  note?: string;
}

export interface RollTableDef {
  tableId: string;
  roll: string;
  entries: RollTableEntryDef[];
  description?: string;
}

/** 世界物品库（docs/RULES-MODEL §3 `items[]`；迁移旧卡 inventory 时用）。 */
export interface RulePackItemDef {
  itemId: string;
  name: string;
  icon?: string;
  tags?: string[];
  rarity?: string;
  stats?: Record<string, number>;
  /** 可穿槽位 id；空 = 不可装备。 */
  equipSlot?: string[];
  stackable?: boolean;
  useAction?: string;
  description?: string;
}

export interface MigrationDef {
  fromVersion: string;
  toVersion: string;
  note?: string;
}

export interface UiGroupDef {
  id: string;
  title: string;
  fields: string[];
}

export interface UiItemCategoryDef {
  id: string;
  name: string;
  icon?: string;
  tags?: string[];
}

export interface UiRarityDef {
  id: string;
  name: string;
  color?: string;
}

export interface UiTemplatesDef {
  sheetCompact?: string[];
  itemCard?: string[];
  [templateId: string]: string[] | undefined;
}

export interface UiWorldMapOptions {
  labelMode?: 'always' | 'hover' | 'never';
  showConnections?: boolean;
  currentZonePulse?: boolean;
  exploredOnly?: boolean;
}

export interface UiBattleGridOptions {
  gridOpacity?: number;
  tokenSize?: 'auto' | number;
  showMoveRange?: boolean;
  showDistanceOnHover?: boolean;
  showCoverMarkers?: boolean;
}

export interface RulePackUi {
  groups?: UiGroupDef[];
  itemCategories?: UiItemCategoryDef[];
  rarities?: UiRarityDef[];
  templates?: UiTemplatesDef;
  worldMap?: UiWorldMapOptions;
  battleGrid?: UiBattleGridOptions;
}

export interface ScriptRef {
  /** `rules/scripts/**.js` 相对路径。 */
  file: string;
  sha256: string;
}

export type RulePackScripts = Partial<Record<HookName, ScriptRef>>;

// --- space -----------------------------------------------------------------

export interface SpaceUnitsDef {
  /** 一格对应的展示单位数值（如 1.5 m）。 */
  cell?: number;
  /** 展示单位名（`m` / `ft` / `格`）。 */
  name?: string;
}

export interface GridDef {
  /** 战棋格默认格宽（米）。 */
  cellMeters?: number;
}

export interface WorldMapDef {
  backgroundAssetId?: string;
  width?: number;
  height?: number;
}

export interface ZoneConnectionDef {
  to: string;
  kind?: string;
  distance?: number;
}

export interface ZoneHotspotDef {
  x: number;
  y: number;
  w?: number;
  h?: number;
  icon?: string;
}

export interface ZoneDef {
  zoneId: string;
  name: string;
  parentZoneId?: string | null;
  tags?: string[];
  connections?: ZoneConnectionDef[];
  battleMapId?: string | null;
  hotspot?: ZoneHotspotDef;
  description?: string;
}

export interface TerrainDef {
  id: string;
  name: string;
  moveCost?: number;
  blocksMove?: boolean;
  blocksSight?: boolean;
  icon?: string;
}

export interface CoverDef {
  id: string;
  name: string;
  defenseBonus?: number;
  tags?: string[];
}

export interface AreaDef {
  areaId: string;
  name: string;
  shape?: 'circle' | 'rect' | 'zone' | 'line';
  radius?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  effect?: string;
}

export interface ObstacleDef {
  x: number;
  y: number;
  w?: number;
  h?: number;
  kind?: string;
  terrain?: string;
  coverId?: string;
}

/**
 * 出生点。兼容两种写法：
 * - 契约写法：`{ team: 'player', cells: [[1,4],[1,5]] }`
 * - docs 写法：`{ x: 1, y: 7, side: 'player', label: '入口' }`
 */
export interface BattleSpawnDef {
  team?: SpawnSide;
  side?: SpawnSide;
  cells?: Array<[number, number]>;
  x?: number;
  y?: number;
  label?: string;
  monsterId?: string;
}

export interface BattleMapCalibrationDef {
  offsetX?: number;
  offsetY?: number;
  cellPx?: number;
  scale?: number;
}

export interface BattleMapDef {
  mapId: string;
  zoneId?: string | null;
  cols: number;
  rows: number;
  /** rows × cols 地形 id 矩阵（行优先）。 */
  terrain?: string[][];
  obstacles?: ObstacleDef[];
  spawns?: BattleSpawnDef[];
  backgroundAssetId?: string;
  calibration?: BattleMapCalibrationDef;
  name?: string;
}

export interface SpaceDef {
  model: SpaceModel;
  /** 展示单位：字符串（`m`/`ft`/`格`）或 `{ cell, name }`。 */
  units?: string | SpaceUnitsDef;
  distanceMode?: DistanceMode;
  grid?: GridDef;
  world?: WorldMapDef;
  zones?: ZoneDef[];
  battleMaps?: BattleMapDef[];
  terrains?: TerrainDef[];
  covers?: CoverDef[];
  areas?: AreaDef[];
}

// --- time ------------------------------------------------------------------

export interface TimeDef {
  model: TimeModel;
  durationUnit?: DurationUnit;
  defaultMaxRounds?: number;
  onRoundLimit?: RoundLimitAction;
}

// --- pack ------------------------------------------------------------------

export interface RulePack {
  schemaVersion: RulePackSchemaVersion;
  rulesId: string;
  rulesVersion: string;
  name: string;
  description?: string;
  sheet: SheetDef;
  actions: ActionDef[];
  turn: TurnDef;
  progression?: ProgressionDef;
  tables?: RollTableDef[];
  ui?: RulePackUi;
  /** 命名公式：公式名 → 表达式源码。 */
  formulas: Record<string, string>;
  scripts?: RulePackScripts;
  space?: SpaceDef;
  time?: TimeDef;
  items?: RulePackItemDef[];
  migrations?: MigrationDef[];
}

// ---------------------------------------------------------------------------
// 卡实例（trpg.card/1）
// ---------------------------------------------------------------------------

export interface CardResourceState {
  current: number;
  /** 只是缓存/参考，权威上限由主机按公式算。 */
  max?: number;
}

/** 装备实例：物品定义在规则包/内容包里，实例只存差异。 */
export interface EquipmentInstanceDef {
  instanceId: string;
  slot: string;
  name?: string;
  tags: string[];
  /** 词条 id → 数值（实例化时的快照）。 */
  stats: Record<string, number>;
  note?: string;
}

export interface CardSkillState {
  id: string;
  proficient?: boolean;
  bonus?: number;
}

export interface CardStatusState {
  id: string;
  stacks?: number;
  remaining?: number;
}

export interface CardOrigin {
  packId: string;
  moduleId?: string;
}

export interface CardSpriteSheetFrameDef {
  name: string;
  index: number;
}

export interface CardSpriteSheetDef {
  assetId: string;
  rows: number;
  cols: number;
  frameSize: number;
  frames: CardSpriteSheetFrameDef[];
}

/** 形象资产引用（docs/UI-CONTRACT §8；卡只存引用）。 */
export interface CardAssetsDef {
  avatar?: string;
  portrait?: string;
  portraitVariants?: Record<string, string>;
  spriteSheet?: CardSpriteSheetDef;
}

export interface CardInstance {
  schemaVersion: CardSchemaVersion;
  cardId: string;
  rulesId: string;
  rulesVersion: string;
  attributes: Record<string, number>;
  resources: Record<string, CardResourceState>;
  fields: Record<string, string | number>;
  equipmentInstances: EquipmentInstanceDef[];
  skills: CardSkillState[];
  statuses: CardStatusState[];
  notes?: string;
  origin?: CardOrigin;
  /** 契约字段：形象/立绘资产引用。 */
  avatarAssetId?: string;
  portraitAssetId?: string;
  /** docs 扩展写法（与 avatarAssetId/portraitAssetId 等价，校验时二者皆可）。 */
  assets?: CardAssetsDef;
}

// ---------------------------------------------------------------------------
// 旧 engine 卡（schemaVersion: 1）——迁移输入
// ---------------------------------------------------------------------------

export interface LegacyAttackProfile {
  name: string;
  ability: string;
  proficient?: boolean;
  damage: string;
  range: string;
  damageType?: string;
  note?: string;
}

export interface LegacyCharacterCard {
  schemaVersion: 1;
  id: string;
  identity: {
    name: string;
    race?: string;
    class?: string;
    level?: number;
    background?: string;
  };
  owner?: { playerId?: string | null; displayName?: string };
  abilities: Record<string, number>;
  proficiency?: { bonus?: number; skills?: string[]; saves?: string[] };
  combat?: {
    ac?: number;
    hpMax?: number;
    initiativeBonus?: number;
    attacks?: LegacyAttackProfile[];
  };
  spells?: { ability?: string; slots?: Record<string, number>; known?: string[] };
  inventory?: Array<{ name: string; qty?: number; effect?: string }>;
  publicSummary?: string;
  appearance?: string;
  personality?: string;
  source?: { ruleId?: string; ruleVersion?: string; moduleId?: string | null };
}

// ---------------------------------------------------------------------------
// 投影 DTO（主机算好下发的卡面数据；docs/UI-CONTRACT §6 的 SheetView 子集 + 物化）
// ---------------------------------------------------------------------------

export interface AttributeProjection {
  id: string;
  name: string;
  value: number;
  /** 派生调整值（来自 `derived.mod.<id>`，没有则不填）。 */
  mod?: number;
  icon?: string;
}

export interface ResourceProjection {
  id: string;
  name: string;
  current: number;
  max: number;
  /** 资源上限来源公式（命名公式名或内联表达式）。 */
  formula?: string;
  icon?: string;
}

export interface EquipmentItemProjection {
  instanceId: string;
  name: string;
  tags: string[];
  stats: Record<string, number>;
  note?: string;
}

export interface EquipmentSlotProjection {
  slotId: string;
  name: string;
  accepts: string[];
  count: number;
  icon?: string;
  items: EquipmentItemProjection[];
}

export interface EquipmentStatTotalProjection {
  statId: string;
  name: string;
  total: number;
  icon?: string;
}

export interface EquipmentStatTracePart {
  sourceId: string;
  sourceName: string;
  value: number;
  /** 该来源采用的叠法：`add` / `max` / `min` / `unique`。 */
  stack: string;
}

export interface EquipmentStatTrace {
  statId: string;
  total: number;
  parts: EquipmentStatTracePart[];
}

export interface EquipmentProjection {
  slots: EquipmentSlotProjection[];
  statTotals: EquipmentStatTotalProjection[];
  /** 扁平化词条总值（公式求值上下文 `equip.*` 直接用）。 */
  statValues: Record<string, number>;
  trace: EquipmentStatTrace[];
}

export interface SkillProjection {
  id: string;
  name: string;
  attribute?: string;
  total: number;
  proficient: boolean;
  bonus: number;
  icon?: string;
}

export interface ActionCostProjection {
  /** 行动经济消耗：`turn.resources[].id` → 次数。 */
  turn?: Record<string, number>;
  resource?: { id: string; amount: number };
}

export interface ActionProjection {
  actionId: string;
  name: string;
  kind: ActionKind;
  available: boolean;
  /** 不可用原因（中文人话），available=true 时缺省。 */
  reason?: string;
  cost?: ActionCostProjection;
  description?: string;
  icon?: string;
  toHit?: string;
  damage?: ActionDamage;
}

export interface StatusProjection {
  id: string;
  name: string;
  stacks?: number;
  remaining?: number;
  icon?: string;
}

export interface SheetIdentityProjection {
  name: string;
  level: number;
  race?: string;
  class?: string;
}

/** 背包投影（M9.1 预留：卡实例暂不存背包，先给稳定空形状）。 */
export interface InventoryItemProjection {
  instanceId: string;
  name: string;
  tags: string[];
  qty: number;
  stats?: Record<string, number>;
  note?: string;
}

export interface InventoryCategoryProjection {
  id: string;
  name: string;
  icon?: string;
  count: number;
}

export interface InventoryProjection {
  items: InventoryItemProjection[];
  categories: InventoryCategoryProjection[];
  capacity?: { used: number; max: number; unit?: string };
}

export interface SheetProjection {
  cardId: string;
  rulesId: string;
  rulesVersion: string;
  identity: SheetIdentityProjection;
  /** 属性扁平映射（`attr.<id>` 的展示值）。 */
  values: Record<string, number>;
  attributes: AttributeProjection[];
  resources: ResourceProjection[];
  derived: Record<string, number | string>;
  equipment: EquipmentProjection;
  skills: SkillProjection[];
  actions: ActionProjection[];
  statuses: StatusProjection[];
  fields: Record<string, string | number>;
  inventory: InventoryProjection;
  /** 投影过程中的降级/求值失败说明（不影响 DTO 形状）。 */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 校验结果类型
// ---------------------------------------------------------------------------

export interface ValidateResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
  warnings: string[];
}

export interface MigrateResult {
  ok: boolean;
  card?: CardInstance;
  errors: string[];
  warnings: string[];
}
