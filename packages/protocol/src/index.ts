/**
 * 跑团桌房间协议 v1（M2）。
 *
 * 约束（见 docs/DESIGN.md §7）：
 * - 与 DSH 解耦：DSH 客户端、未来 QQ/网页 adapter 都只认这套 RPC + SSE。
 * - 行动/角色身份由服务端绑定（token → playerId），客户端只提交文本。
 * - 事件带单调递增 seq；断线重连用 lastSeq 补发。
 * - 私密事件在服务端投影阶段决定接收者（to），客户端无法伪造。
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * 缺省内容包（内置包）与缺省模组：旧客户端不传 `packId`/`moduleId` 时按这套引用建房
 * （CONTENT-MODEL §2.6「都缺省 = 内置包 core-guimuya + 其默认模组」）。
 * 实际默认值以 host 的 pack registry 为准，这两个常量是协议层兜底常量。
 */
export const DEFAULT_CONTENT_PACK_ID = 'core-guimuya';
export const DEFAULT_CONTENT_MODULE_ID = 'guimuya';

export type PlayerId = string;
export type RoomId = string;
export type Seq = number;

export type RoomPhase = 'lobby' | 'playing' | 'paused' | 'ended';
export type GMMode = 'ai' | 'human';

/** 事件接收者：全桌 / 仅 GM（含房主）/ 单个玩家。GM 永远能看到所有事件。 */
export type EventTarget = 'all' | 'gm' | PlayerId;

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export interface RoomPlayerView {
  playerId: PlayerId;
  displayName: string;
  seat: 'gm' | 'player';
  online: boolean;
  characterName?: string;
  characterSummary?: string;
}

export interface RoomView {
  roomId: RoomId;
  title: string;
  /** 绑定为牌桌的 DSH 会话 id（原生对话即牌桌）。 */
  sessionId?: string;
  phase: RoomPhase;
  gmMode: GMMode;
  locked: boolean;
  /** 只有房主（host 身份）能看到邀请码。 */
  inviteCode?: string;
  /** 当前场景进度（真人 GM / AI 推进后可显示）。 */
  scene?: { sceneId: string; title?: string };
  /** 房间引用的内容（host 是内容权威，房间只存引用，不复制内容）。 */
  content?: RoomContentView;
  /** 该模组的场景公开摘要（GM 控制台场景下拉用；只含 sceneId + 公开标题）。 */
  scenes?: RoomSceneSummary[];
  /**
   * 房间引用的规则包（M9.4）：缺省 = 内容包没带 rules 段（老房间/纯叙事团），
   * 此时 sheet/combat/worldmap 命令返回中文错误，客户端隐藏规则相关面板。
   */
  rules?: RoomRulesView;
  players: RoomPlayerView[];
  createdAt: number;
}

/** 房间规则包视图（公开元数据；不含规则正文/脚本）。 */
export interface RoomRulesView {
  rulesId: string;
  rulesVersion: string;
  /** 规则包展示名。 */
  name?: string;
  /** true = 规则不可用/版本漂移/运行态恢复失败：房间仍可续团，但规则命令按降级处理。 */
  degraded?: boolean;
}

/** 房间引用的内容：`{ packId, moduleId }` 的解析结果（脱敏投影，不含模组内容）。 */
export interface RoomContentView {
  packId: string;
  packVersion: string;
  moduleId: string;
  /** 包展示名（可选；包缺失时可能没有）。 */
  packName?: string;
  /** 模组标题（可选；包缺失时可能没有）。 */
  moduleTitle?: string;
  /**
   * true = host 上找不到该包/模组，或内容版本与快照不一致：房间已降级续团，
   * GM 提示回退到内置内容包。玩家端只做提示，不要按缺失包渲染。
   */
  degraded?: boolean;
}

/** 场景公开摘要（GM 控制台场景下拉）。 */
export interface RoomSceneSummary {
  sceneId: string;
  title: string;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/**
 * 事件 kind：
 * - 旧值（M2–M8）：room / narration / dice / alert / scene / combat / private / award；
 * - M9.4 规则投影：`sheet/update`（某人卡面投影更新，只投本人 + GM）、
 *   `combat/update`（战棋/世界地图状态更新，全桌）、`rules/error`（规则钩子错误/降级，全桌）。
 */
export type EventKind =
  | 'room'
  | 'narration'
  | 'dice'
  | 'alert'
  | 'scene'
  | 'combat'
  | 'private'
  | 'award'
  | 'sheet/update'
  | 'combat/update'
  | 'rules/error';

export interface GameEvent<K extends EventKind = EventKind, P = unknown> {
  v: typeof PROTOCOL_VERSION;
  kind: K;
  seq: Seq;
  at: number;
  to: EventTarget;
  payload: P;
}

export interface NarrationPayload {
  /** gm = AI/真人 GM 旁白；player = 玩家行动；system = 系统提示。 */
  speaker: 'gm' | 'player' | 'system';
  speakerName?: string;
  playerId?: PlayerId;
  text: string;
}

export interface DicePayload {
  expression: string;
  dice: number[];
  modifier: number;
  total: number;
  label?: string;
  rollerName: string;
  playerId: PlayerId;
  private: boolean;
  /** 检定结果（M3 战斗接入后使用）。 */
  check?: {
    kind: 'ability' | 'skill' | 'attack' | 'save';
    name: string;
    dc: number;
    success: boolean;
  };
}

export interface AlertPayload {
  level: 'info' | 'warning' | 'error';
  text: string;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export interface RpcRequest {
  method: RpcMethod;
  params?: unknown;
  token?: string;
  /** 客户端版本，便于以后做兼容性提示。 */
  clientVersion?: string;
}

export interface RpcError {
  code:
    | 'bad-request'
    | 'unauthorized'
    | 'forbidden'
    | 'not-found'
    | 'room-locked'
    | 'invalid-card'
    | 'invalid-expression'
    | 'conflict'
    | 'internal';
  message: string;
}

export type RpcResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: RpcError };

export type RpcMethod =
  | 'room.create'
  | 'room.join'
  | 'room.state'
  | 'room.seat'
  | 'room.roll'
  | 'room.say'
  | 'room.leave'
  | 'room.kick'
  | 'room.lock'
  | 'room.list'
  | 'host.session'
  | 'gm.narrate'
  | 'gm.secret'
  | 'gm.scene'
  | 'gm.award'
  | 'room.close'
  | 'room.closeAll'
  | 'room.bind'
  | 'content.list'
  | 'content.reload'
  // ---- M9.4 规则投影与命令（host 结算；客户端只发意图） ----
  | 'sheet.get'
  | 'sheet.equip'
  | 'sheet.unequip'
  | 'sheet.useItem'
  | 'combat.view'
  | 'combat.start'
  | 'combat.useAction'
  | 'combat.move'
  | 'combat.endTurn'
  | 'combat.rollCheck'
  | 'combat.end'
  | 'worldmap.get';

export interface CreateRoomParams {
  title: string;
  gmMode: GMMode;
  /** 开局即绑定的 DSH 会话 id（房主当前打牌的会话）；缺省为不绑定。 */
  sessionId?: string;
  /** 内容包 id；缺省 = host 的缺省包（内置包 core-guimuya）。 */
  packId?: string;
  /** 模组 id；缺省 = 该包的 defaultModuleId。 */
  moduleId?: string;
}

/** 把房间绑定到（或解绑）一个 DSH 会话。 */
export interface BindSessionParams {
  /** 要作为牌桌的会话 id；传 null / 空串表示解绑。 */
  sessionId?: string | null;
}

export interface BindSessionResult {
  room: RoomView;
}

export interface CreateRoomResult {
  room: RoomView;
  hostToken: string;
  inviteCode: string;
}

export interface JoinRoomParams {
  inviteCode: string;
  playerName: string;
  characterCard?: unknown;
}

export interface JoinRoomResult {
  room: RoomView;
  playerId: PlayerId;
  playerToken: string;
}

export interface SeatParams {
  characterCard: unknown;
}

export interface RollParams {
  expression: string;
  label?: string;
  private?: boolean;
}

export interface SayParams {
  text: string;
  /** true = 悄悄话给 GM，不进公共叙事。 */
  private?: boolean;
}

export interface KickParams {
  playerId: PlayerId;
}

export interface LockParams {
  locked: boolean;
}

/** 真人 GM：向全桌发一段旁白。 */
export interface GmNarrateParams {
  text: string;
}

/** 真人 GM：给某位玩家发私密信息。 */
export interface GmSecretParams {
  playerId: PlayerId;
  text: string;
}

/** 真人 GM：推进场景（模组场景 id + 标题，端上用于展示进度）。 */
export interface GmSceneParams {
  sceneId: string;
  title?: string;
}

/** 真人 GM：结算奖励（经验/物品），只在该玩家的视图里展示。 */
export interface GmAwardParams {
  playerId: PlayerId;
  xp: number;
  items?: string[];
  note?: string;
}

export interface ScenePayload {
  sceneId: string;
  title?: string;
  /** 由谁推进的场景（host = 真人 GM）。 */
  by: 'host' | 'ai';
}

export interface AwardPayload {
  playerId: PlayerId;
  playerName: string;
  xp: number;
  items: string[];
  note?: string;
  private: true;
}

export interface HostSessionParams {
  roomId: RoomId;
}

export interface RoomStateResult {
  room: RoomView;
}

export interface RollResult {
  event: GameEvent<'dice', DicePayload>;
}

export interface SayResult {
  event: GameEvent<'narration', NarrationPayload>;
}

export interface RoomListResult {
  rooms: Array<{ roomId: RoomId; title: string; phase: RoomPhase; gmMode: GMMode; players: number }>;
}

// ---------------------------------------------------------------------------
// 内容包目录（content.list / content.reload）
// ---------------------------------------------------------------------------

/** 模组摘要（公开字段；不含场景内容、GM 备注、秘密、遭遇/判定等）。 */
export interface CatalogModuleSummary {
  moduleId: string;
  title: string;
  level: [number, number];
  playerCount: [number, number];
  sceneCount: number;
}

/**
 * 内容包的**脱敏投影**（给玩家/客户端选包用）：只有元数据与计数，
 * 绝不包含 gmNotes / secrets / encounters / checks / rewards / 世界书正文。
 */
export interface CatalogPack {
  packId: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  ruleSystem: { id: string; name: string };
  defaultModuleId: string;
  modules: CatalogModuleSummary[];
  /** pack 内置预制卡数量（不展开卡内容）。 */
  cardCount: number;
  /** 世界书条目数量（不展开条目内容）。 */
  loreCount: number;
  /** builtin = 随插件内置；data = 数据目录里的 .trpgpack。 */
  source: 'builtin' | 'data';
}

/** `content.list` 结果；玩家可调、只读。 */
export interface ContentListResult {
  packs: CatalogPack[];
}

/** `content.reload` 结果（仅 loopback + host token）：重扫数据目录后的清单概要。 */
export interface ContentReloadResult {
  packs: number;
  /** 可读警告：坏包、重复 packId、被忽略的条目等。 */
  warnings: string[];
  /** 重扫后从降级恢复的房间数。 */
  recoveredRooms?: number;
}

// ---------------------------------------------------------------------------
// 规则投影与命令（M9.4，docs/RULES-MODEL §8/§9、docs/UI-CONTRACT §5/§6）
//
// 口径：全部由 host 按房间规则运行时算好后下发，客户端零规则计算、零本地预测；
// `available=false` 的动作置灰并显示 `reason`（中文人话）。
// ---------------------------------------------------------------------------

/** 图标/资产引用：`@pack:assets/...` | `@local:<assetId>` | `@room:<roomId>/<assetId>`。 */
export type IconRef = string;

/** 计算过程 trace（点击展开；客户端不自行推导）。 */
export interface TraceView {
  /** 中文人话行（骰面/公式/中间值）。 */
  lines: string[];
  /** 结构化中间值。 */
  data: Record<string, unknown>;
}

/** 骰面记录（伤害骰/检定骰）。 */
export interface DiceRollView {
  expression: string;
  dice: number[];
  modifier: number;
  total: number;
}

/**
 * 物品卡（装备界面与背包界面共用）。
 * `equippedSlot` 缺省 = 在背包里（未装备）。
 */
export interface ItemCardView {
  instanceId: string;
  itemId: string;
  name: string;
  icon?: IconRef;
  rarity?: string;
  /** 稀有度展示名（来自规则包 `ui.rarities[]`）。 */
  rarityName?: string;
  tags: string[];
  stats: Array<{ statId: string; name: string; value: number; icon?: IconRef }>;
  description?: string;
  /** 当前装备槽 id；缺省 = 背包中。 */
  equippedSlot?: string;
  /** 堆叠数量（v1 每实例 1 件，预留给消耗品堆叠）。 */
  count: number;
}

/** 装备槽（槽位栅格由规则包 `sheet.equipment.slots[]` 生成，不写死部位）。 */
export interface EquipmentSlotView {
  slotId: string;
  name: string;
  accepts: string[];
  /** 该槽已放件数。 */
  count: number;
  /** 该槽容量（`slots[].count`，缺省 1）。 */
  capacity: number;
  icon?: IconRef;
  /** 第一件（兼容旧字段；空槽缺省）。 */
  item?: ItemCardView;
  /** 该槽全部物品。 */
  items: ItemCardView[];
}

/** 词条总览（词条叠加后的总值）。 */
export interface EquipmentStatTotalView {
  statId: string;
  name: string;
  total: number;
  icon?: IconRef;
}

/** 装备视图：槽位 + 词条总览 + 全部物品（已装备 + 背包，`equippedSlot` 区分）。 */
export interface EquipmentView {
  slots: EquipmentSlotView[];
  statTotals: EquipmentStatTotalView[];
  items: ItemCardView[];
  /** 词条来源分解：哪件装备贡献多少、叠法是什么（客户端的「来源分解」）。 */
  trace?: Array<{
    statId: string;
    total: number;
    parts: Array<{ sourceId: string; sourceName: string; value: number; stack: string }>;
  }>;
}

/** 背包视图（v1 与装备共用物品实例；容量只有规则包定义时才给）。 */
export interface InventoryView {
  items: ItemCardView[];
  capacity?: { used: number; max: number; unit?: string };
  weight?: { used: number; max?: number; unit?: string };
}

/** 属性栅格（图标 + 主值 + 调整值都在 `derived` 里）。 */
export interface SheetAttributeValues {
  attributes: Record<string, number>;
  derived: Record<string, number | string>;
}

export interface SheetSkillView {
  id: string;
  name: string;
  attribute?: string;
  total: number;
  proficient: boolean;
  bonus?: number;
  icon?: IconRef;
}

export interface SheetStatusView {
  id: string;
  name: string;
  stacks?: number;
  remaining?: number;
  icon?: IconRef;
}

export interface SheetActionCostView {
  /** 行动经济消耗：`turn.resources[].id` → 次数。 */
  turn?: Record<string, number>;
  /** 角色资源消耗。 */
  resource?: { id: string; amount: number };
}

export interface SheetActionTargetingView {
  type: 'self' | 'single' | 'multi' | 'area' | 'all' | 'none';
  range: 'engaged' | 'near' | 'far' | number;
  sides: 'self' | 'ally' | 'enemy' | 'any' | 'all';
}

/** 动作按钮（`available=false` 置灰并显示 `reason`；客户端只提交 `actionId` 意图）。 */
export interface SheetActionView {
  actionId: string;
  name: string;
  kind: 'attack' | 'skill' | 'spell' | 'custom';
  icon?: IconRef;
  available: boolean;
  reason?: string;
  cost: SheetActionCostView;
  targeting: SheetActionTargetingView;
  description?: string;
}

/** 人物界面卡面投影（host 权威；`sheet.get` 返回）。 */
export interface SheetView {
  cardId: string;
  /** 卡归属玩家（房主自己落座时是 `'host'`）。 */
  playerId: PlayerId;
  /** 规则运行时里的行动者 id（战斗/移动命令的 `actorId` 用它）。 */
  actorId: string;
  rulesId: string;
  rulesVersion: string;
  identity: { name: string; level: number; race?: string; class?: string };
  values: SheetAttributeValues;
  resources: Array<{ id: string; name: string; current: number; max: number; icon?: IconRef }>;
  fields: Record<string, string | number>;
  equipment: EquipmentView;
  skills: SheetSkillView[];
  statuses: SheetStatusView[];
  actions: SheetActionView[];
  /** 背包物品（与 `equipment.items` 同源，便于背包页直接用）。 */
  items: ItemCardView[];
  /** 投影过程中的降级说明（公式求值失败、缺字段等）。 */
  warnings: string[];
}

// --- 世界地图 --------------------------------------------------------------

export interface WorldMapZoneConnectionView {
  to: string;
  kind?: string;
  distance?: number;
}

export interface WorldMapHotspotView {
  x: number;
  y: number;
  w?: number;
  h?: number;
  icon?: IconRef;
}

export interface WorldMapZoneView {
  zoneId: string;
  name: string;
  parentZoneId?: string;
  hotspot?: WorldMapHotspotView;
  connections: WorldMapZoneConnectionView[];
  /** 是否队伍当前所在区域（高亮 + 脉冲）。 */
  current: boolean;
  battleMapId?: string;
  description?: string;
  /** v1 不做视野迷雾：一律 true；预留给后续版本。 */
  explored: boolean;
}

/** 队伍在地图上的位置（按行动者；格子坐标只在有战斗地图时给）。 */
export interface WorldMapPartyPositionView {
  /** 队伍当前区域（第一个有区域位置的行动者）。 */
  zoneId?: string;
  members: Array<{ actorId: string; playerId?: PlayerId; name: string; zoneId?: string; x?: number; y?: number }>;
}

/** 世界地图页投影（`worldmap.get` 返回；不参与格子级判定）。 */
export interface WorldMapView {
  backgroundAssetId?: string;
  width?: number;
  height?: number;
  zones: WorldMapZoneView[];
  partyPosition: WorldMapPartyPositionView;
  currentZoneId?: string;
  warnings?: string[];
}

// --- 战棋战斗视图 ----------------------------------------------------------

export type CombatTeam = 'player' | 'enemy' | 'neutral';

export interface CombatHpView {
  current: number;
  max?: number;
}

export interface CombatPositionView {
  x: number;
  y: number;
  zoneId?: string;
}

export interface CombatTokenView {
  actorId: string;
  name: string;
  team: CombatTeam;
  playerId?: PlayerId;
  x?: number;
  y?: number;
  zoneId?: string;
  hp?: CombatHpView;
  dead: boolean;
  active: boolean;
}

export interface CombatInitiativeView {
  actorId: string;
  name: string;
  team: CombatTeam;
  playerId?: PlayerId;
  /** 先攻总值（d20 + 加值）。 */
  initiative: number;
  /** d20 骰面。 */
  roll: number;
  hp?: CombatHpView;
  dead: boolean;
  active: boolean;
}

export interface CombatObstacleView {
  x: number;
  y: number;
  w: number;
  h: number;
  terrain?: string;
  kind?: string;
  coverId?: string;
}

/** 行动经济条（完全由 `turn.resources[]` + `turn.movement` 生成，不写死「动作/附赠」）。 */
export interface CombatActionEconomyEntryView {
  id: string;
  name: string;
  current: number;
  max: number;
  unit?: string;
  icon?: IconRef;
}

export interface CombatActionEconomyView {
  /** 当前行动者；未开战时为 null。 */
  actorId: string | null;
  remaining: CombatActionEconomyEntryView[];
}

export interface CombatTerrainLegendView {
  id: string;
  name: string;
  icon?: IconRef;
  blocksMove?: boolean;
  blocksSight?: boolean;
}

export interface CombatTimeView {
  round: number;
  segment: number;
  day: number;
}

/**
 * 战棋战斗视图（`combat.view` / `combat/update` 返回）。
 * 无空间模型的规则包（`space.model = "none"`）也返回稳定形状：cols/rows = 0、terrain 空数组。
 */
export interface CombatView {
  active: boolean;
  mapId?: string;
  zoneId?: string;
  cols: number;
  rows: number;
  cellMeters: number;
  distanceMode: 'chebyshev' | 'manhattan' | 'dnd5e' | 'euclid';
  /** 地形 id 矩阵（权威；底图只是皮肤）。 */
  terrain: string[][];
  obstacles: CombatObstacleView[];
  /** actorId → 当前占位（只含有格子位置的行动者）。 */
  positions: Record<string, CombatPositionView>;
  tokens: CombatTokenView[];
  initiative: CombatInitiativeView[];
  round: number;
  maxRounds: number;
  activeActorId: string | null;
  activePlayerId?: PlayerId;
  actionEconomy: CombatActionEconomyView;
  time: CombatTimeView;
  terrainLegend: CombatTerrainLegendView[];
  overtime?: boolean;
  limitAction?: 'end' | 'draw' | 'overtime';
  endedReason?: string;
  warnings?: string[];
}

// --- 命令回包 --------------------------------------------------------------

/** `sheet.get` 参数：玩家不传 = 看自己的卡；房主可指定 playerId/actorId 看任意人的卡。 */
export interface SheetGetParams {
  playerId?: PlayerId;
  actorId?: string;
}

export interface SheetGetResult {
  sheet: SheetView;
  inventory: InventoryView;
}

/** `sheet.equip`：把某件物品装到 `slotId`（校验 accepts/件数/换装合法性）。 */
export interface SheetEquipParams {
  slotId: string;
  instanceId: string;
  playerId?: PlayerId;
  actorId?: string;
}

/** `sheet.unequip`：把物品从槽位卸下（回背包）。 */
export interface SheetUnequipParams {
  slotId: string;
  instanceId: string;
  playerId?: PlayerId;
  actorId?: string;
}

/** `sheet.useItem`：使用物品（效果走规则包的 `items[].useAction`）。 */
export interface SheetUseItemParams {
  instanceId: string;
  targetId?: string;
  playerId?: PlayerId;
  actorId?: string;
}

/** 物品使用结算回包（`sheet.useItem`）。 */
export interface ItemUseOutcomeView {
  instanceId: string;
  itemId?: string;
  name: string;
  /** 用后是否从卡/背包移除（v1：规则包 items[].stackable 未实现堆叠，统一移除一件）。 */
  consumed: boolean;
  removedFrom?: 'slot' | 'bag';
  action?: ActionOutcomeView;
}

export interface SheetCommandResult {
  sheet: SheetView;
  inventory: InventoryView;
  /** 本次命令产生的规则事件 kind（供客户端做小特效）。 */
  events?: string[];
  item?: ItemUseOutcomeView;
}

export interface CombatViewParams {}

export interface CombatViewResult {
  combat: CombatView;
}

/** 开战时可临时加入的敌对/中立行动者（卡缺省 = host 按规则包生成一张杂兵卡）。 */
export interface CombatStartEnemyParams {
  name: string;
  /** 新卡（trpg.card/1）或旧 engine 卡（schemaVersion: 1，host 迁移）。 */
  card?: unknown;
  team?: 'enemy' | 'neutral';
  actorId?: string;
  cell?: { x: number; y: number };
  zoneId?: string;
}

export interface CombatStartParams {
  actorIds?: string[];
  maxRounds?: number;
  mapId?: string;
  reason?: string;
  enemies?: CombatStartEnemyParams[];
}

export interface CombatStartResult {
  combat: CombatView;
  /** 先攻骰面。 */
  rolls: DiceRollView[];
}

export interface CombatUseActionParams {
  actionId: string;
  targetId?: string;
  playerId?: PlayerId;
  actorId?: string;
  options?: {
    mods?: number;
    mode?: 'normal' | 'advantage' | 'disadvantage';
    dc?: number;
    skillId?: string;
    distance?: number;
  };
}

/** 一次动作的结算结果（命中/伤害/检定/花费/骰面/trace）。 */
export interface ActionOutcomeView {
  actorId: string;
  actionId: string;
  actionName: string;
  kind: string;
  targetId?: string;
  hit?: boolean;
  crit?: boolean;
  damage?: {
    amount: number;
    absorbedByTempHp: number;
    hpBefore: number;
    hpAfter: number;
    dead: boolean;
  };
  check?: CheckView;
  cost: SheetActionCostView;
  turn: Record<string, number>;
  autoEndedTurn: boolean;
  rolls: DiceRollView[];
  events: string[];
  trace: TraceView;
}

export interface CombatUseActionResult {
  combat: CombatView;
  action: ActionOutcomeView;
  /** 行动者视角的卡面（HP/资源/行动经济已更新）。 */
  sheet?: SheetView;
}

export interface CombatMoveParams {
  to: { zoneId?: string; cell?: { x: number; y: number } };
  playerId?: PlayerId;
  actorId?: string;
  via?: string;
}

export interface MoveOutcomeView {
  actorId: string;
  from: { zoneId?: string; cell?: { x: number; y: number } };
  to: { zoneId?: string; cell?: { x: number; y: number } };
  cost: number;
  remaining: number | null;
  path: Array<{ x: number; y: number }>;
  trace: TraceView;
}

export interface CombatMoveResult {
  combat: CombatView;
  move: MoveOutcomeView;
}

export interface CombatEndTurnParams {
  actorId?: string;
  playerId?: string;
}

export interface CombatEndTurnResult {
  combat: CombatView;
}

/** 检定结果（人物页「检定」按钮 / 战斗内检定）。 */
export interface CheckView {
  actorId: string;
  targetId?: string;
  kind: string;
  skillId?: string;
  attributeId?: string;
  dc: number;
  mode: 'normal' | 'advantage' | 'disadvantage';
  d20: number | null;
  modifier: number;
  total: number;
  success: boolean;
  crit: boolean;
  fumble: boolean;
  degree: 'crit' | 'success' | 'fail' | 'fumble';
  rolls: DiceRollView[];
  trace: TraceView;
}

export interface CombatRollCheckParams {
  actorId?: string;
  playerId?: string;
  targetId?: string;
  skillId?: string;
  attributeId?: string;
  /** `attribute` / `skill` / `save` / `opposed` / `custom`（由规则包定义）。 */
  kind?: string;
  dc?: number;
  mods?: number;
  mode?: 'normal' | 'advantage' | 'disadvantage';
  reason?: string;
}

export interface CombatRollCheckResult {
  check: CheckView;
}

export interface CombatEndParams {
  reason?: string;
}

export interface CombatEndResult {
  combat: CombatView;
}

export interface WorldMapGetParams {}

export interface WorldMapGetResult {
  worldMap: WorldMapView;
}

// --- 事件负载 --------------------------------------------------------------

/** `sheet/update`：只投本人（GM 也可见）。 */
export interface SheetUpdatePayload {
  playerId: PlayerId;
  actorId: string;
  sheet: SheetView;
  /** 触发来源的规则事件 kind。 */
  cause?: string;
  runtimeSeq?: number;
}

/** `combat/update`：全桌可见的战棋/世界地图状态。 */
export interface CombatUpdatePayload {
  combat: CombatView;
  /** 本次更新伴随的规则事件 kind。 */
  causes?: string[];
  runtimeSeq?: number;
}

/** `rules/error`：规则钩子出错/降级（全桌可见；客户端显示提示，别停摆）。 */
export interface RulesErrorPayload {
  hook?: string;
  /** 失败类型：throw / timeout / shape / integrity / syntax / limit。 */
  kind?: string;
  message: string;
  /** 中文人话提示。 */
  text: string;
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// 校验（手写守卫，零依赖）
// ---------------------------------------------------------------------------

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function fail<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 可选的非空短字符串（id 类字段）。 */
function isOptionalShortId(value: unknown, max = 64): boolean {
  return value === undefined || (isNonEmptyString(value) && value.length <= max);
}

const METHODS: readonly RpcMethod[] = [
  'room.create',
  'room.join',
  'room.state',
  'room.seat',
  'room.roll',
  'room.say',
  'room.leave',
  'room.kick',
  'room.lock',
  'room.list',
  'host.session',
  'gm.narrate',
  'gm.secret',
  'gm.scene',
  'gm.award',
  'room.close',
  'room.closeAll',
  'room.bind',
  'content.list',
  'content.reload',
  'sheet.get',
  'sheet.equip',
  'sheet.unequip',
  'sheet.useItem',
  'combat.view',
  'combat.start',
  'combat.useAction',
  'combat.move',
  'combat.endTurn',
  'combat.rollCheck',
  'combat.end',
  'worldmap.get',
];

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && (METHODS as readonly string[]).includes(value);
}

export function validateRpcRequest(input: unknown): ValidationResult<RpcRequest> {
  if (!isRecord(input)) return fail('RPC 请求必须是对象');
  if (!isRpcMethod(input.method)) return fail(`未知 RPC 方法：${String(input.method)}`);
  if (input.token !== undefined && typeof input.token !== 'string') return fail('token 必须是字符串');
  if (input.params !== undefined && !isRecord(input.params)) return fail('params 必须是对象');
  return { ok: true, value: input as unknown as RpcRequest };
}

export function validateCreateRoom(params: unknown): ValidationResult<CreateRoomParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.title)) return fail('房间标题必填');
  if (params.title.length > 60) return fail('房间标题过长（最多 60 字）');
  if (params.gmMode !== 'ai' && params.gmMode !== 'human') return fail('gmMode 必须是 ai 或 human');
  if (params.sessionId !== undefined && !isNonEmptyString(params.sessionId)) return fail('sessionId 必须是非空字符串');
  if (!isOptionalShortId(params.packId)) return fail('packId 必须是非空字符串（最多 64 字符）');
  if (!isOptionalShortId(params.moduleId)) return fail('moduleId 必须是非空字符串（最多 64 字符）');
  return { ok: true, value: params as unknown as CreateRoomParams };
}

export function validateBindSession(params: unknown): ValidationResult<BindSessionParams> {
  if (!isRecord(params)) return fail('缺少参数');
  const sessionId = params.sessionId;
  if (sessionId !== undefined && sessionId !== null && !isNonEmptyString(sessionId)) {
    return fail('sessionId 必须是非空字符串或 null');
  }
  return { ok: true, value: params as unknown as BindSessionParams };
}

export function validateJoin(params: unknown): ValidationResult<JoinRoomParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.inviteCode)) return fail('邀请码必填');
  if (!isNonEmptyString(params.playerName)) return fail('玩家名必填');
  if (params.playerName.length > 30) return fail('玩家名过长（最多 30 字）');
  return { ok: true, value: params as unknown as JoinRoomParams };
}

export function validateRoll(params: unknown): ValidationResult<RollParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.expression)) return fail('骰子表达式必填');
  if (params.expression.length > 40) return fail('骰子表达式过长');
  if (params.private !== undefined && typeof params.private !== 'boolean') return fail('private 必须是布尔值');
  return { ok: true, value: params as unknown as RollParams };
}

export function validateSay(params: unknown): ValidationResult<SayParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.text)) return fail('内容不能为空');
  if (params.text.length > 3000) return fail('内容过长（最多 3000 字）');
  if (params.private !== undefined && typeof params.private !== 'boolean') return fail('private 必须是布尔值');
  return { ok: true, value: params as unknown as SayParams };
}

export function validateGmNarrate(params: unknown): ValidationResult<GmNarrateParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.text)) return fail('旁白不能为空');
  if (params.text.length > 3000) return fail('旁白过长（最多 3000 字）');
  return { ok: true, value: params as unknown as GmNarrateParams };
}

export function validateGmSecret(params: unknown): ValidationResult<GmSecretParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.playerId)) return fail('缺少 playerId');
  if (!isNonEmptyString(params.text)) return fail('私密内容不能为空');
  if (params.text.length > 2000) return fail('私密内容过长（最多 2000 字）');
  return { ok: true, value: params as unknown as GmSecretParams };
}

export function validateGmScene(params: unknown): ValidationResult<GmSceneParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.sceneId)) return fail('缺少 sceneId');
  if (params.title !== undefined && typeof params.title !== 'string') return fail('title 必须是字符串');
  return { ok: true, value: params as unknown as GmSceneParams };
}

export function validateGmAward(params: unknown): ValidationResult<GmAwardParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.playerId)) return fail('缺少 playerId');
  if (typeof params.xp !== 'number' || !Number.isFinite(params.xp) || params.xp < 0 || params.xp > 100000) {
    return fail('xp 必须是 0-100000 的数字');
  }
  if (params.items !== undefined && (!Array.isArray(params.items) || params.items.some((item) => typeof item !== 'string'))) {
    return fail('items 必须是字符串数组');
  }
  return { ok: true, value: params as unknown as GmAwardParams };
}

// ---------------------------------------------------------------------------
// 校验：M9.4 规则投影 / 命令参数
// ---------------------------------------------------------------------------

/** 空参数命令（`combat.view` / `worldmap.get`）：undefined 或 `{}` 都合法。 */
function acceptEmptyParams<T>(params: unknown): ValidationResult<T> {
  if (params === undefined || params === null) return { ok: true, value: {} as T };
  if (!isRecord(params)) return fail('参数必须是对象');
  return { ok: true, value: params as unknown as T };
}

/** 可选行动者选择器（`playerId` / `actorId`）：玩家只能指向自己，host 可指向任意人。 */
function selectorError(params: Record<string, unknown>): string | undefined {
  if (params.playerId !== undefined && !isNonEmptyString(params.playerId)) return 'playerId 必须是非空字符串';
  if (params.actorId !== undefined && !isNonEmptyString(params.actorId)) return 'actorId 必须是非空字符串';
  return undefined;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalDiceMode(value: unknown): boolean {
  return value === undefined || value === 'normal' || value === 'advantage' || value === 'disadvantage';
}

/** `sheet.get` 参数校验。 */
export function validateSheetGet(params: unknown): ValidationResult<SheetGetParams> {
  if (params !== undefined && params !== null && !isRecord(params)) return fail('参数必须是对象');
  const value = (params ?? {}) as Record<string, unknown>;
  const error = selectorError(value);
  if (error !== undefined) return fail(error);
  return { ok: true, value: value as unknown as SheetGetParams };
}

/** `sheet.equip` 参数校验。 */
export function validateSheetEquip(params: unknown): ValidationResult<SheetEquipParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.slotId)) return fail('缺少 slotId（目标装备槽）');
  if (!isNonEmptyString(params.instanceId)) return fail('缺少 instanceId（要装备的物品）');
  const error = selectorError(params);
  if (error !== undefined) return fail(error);
  return { ok: true, value: params as unknown as SheetEquipParams };
}

/** `sheet.unequip` 参数校验。 */
export function validateSheetUnequip(params: unknown): ValidationResult<SheetUnequipParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.slotId)) return fail('缺少 slotId（要卸下的装备槽）');
  if (!isNonEmptyString(params.instanceId)) return fail('缺少 instanceId（要卸下的物品）');
  const error = selectorError(params);
  if (error !== undefined) return fail(error);
  return { ok: true, value: params as unknown as SheetUnequipParams };
}

/** `sheet.useItem` 参数校验。 */
export function validateSheetUseItem(params: unknown): ValidationResult<SheetUseItemParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.instanceId)) return fail('缺少 instanceId（要使用的物品）');
  if (params.targetId !== undefined && !isNonEmptyString(params.targetId)) return fail('targetId 必须是非空字符串');
  const error = selectorError(params);
  if (error !== undefined) return fail(error);
  return { ok: true, value: params as unknown as SheetUseItemParams };
}

/** `combat.view` 参数校验（空参数）。 */
export function validateCombatView(params: unknown): ValidationResult<CombatViewParams> {
  return acceptEmptyParams<CombatViewParams>(params);
}

/** `combat.start` 参数校验（开战；`enemies` 给 host 侧临时加入的敌对行动者）。 */
export function validateCombatStart(params: unknown): ValidationResult<CombatStartParams> {
  if (params !== undefined && params !== null && !isRecord(params)) return fail('参数必须是对象');
  const value = (params ?? {}) as Record<string, unknown>;
  if (value.actorIds !== undefined) {
    if (!Array.isArray(value.actorIds) || value.actorIds.some((id) => !isNonEmptyString(id))) {
      return fail('actorIds 必须是非空字符串数组');
    }
    if (value.actorIds.length > 64) return fail('actorIds 过多（最多 64 个）');
  }
  if (value.maxRounds !== undefined) {
    if (typeof value.maxRounds !== 'number' || !Number.isInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 999) {
      return fail('maxRounds 必须是 1–999 的整数');
    }
  }
  if (value.mapId !== undefined && !isNonEmptyString(value.mapId)) return fail('mapId 必须是非空字符串');
  if (value.reason !== undefined && typeof value.reason !== 'string') return fail('reason 必须是字符串');
  if (value.enemies !== undefined) {
    if (!Array.isArray(value.enemies)) return fail('enemies 必须是数组');
    if (value.enemies.length > 32) return fail('enemies 过多（最多 32 个）');
    for (const enemy of value.enemies) {
      if (!isRecord(enemy)) return fail('enemies 的每一项必须是对象');
      if (!isNonEmptyString(enemy.name)) return fail('enemies[].name 必填');
      if (enemy.name.length > 30) return fail('enemies[].name 过长（最多 30 字）');
      if (enemy.team !== undefined && enemy.team !== 'enemy' && enemy.team !== 'neutral') {
        return fail('enemies[].team 必须是 enemy 或 neutral');
      }
      if (enemy.actorId !== undefined && !isNonEmptyString(enemy.actorId)) return fail('enemies[].actorId 必须是非空字符串');
      if (enemy.zoneId !== undefined && !isNonEmptyString(enemy.zoneId)) return fail('enemies[].zoneId 必须是非空字符串');
      if (enemy.cell !== undefined) {
        if (!isRecord(enemy.cell) || typeof enemy.cell.x !== 'number' || typeof enemy.cell.y !== 'number') {
          return fail('enemies[].cell 必须是 { x, y } 数值坐标');
        }
      }
      if (enemy.card !== undefined && !isRecord(enemy.card)) return fail('enemies[].card 必须是对象');
    }
  }
  return { ok: true, value: value as unknown as CombatStartParams };
}

/** `combat.useAction` 参数校验。 */
export function validateCombatUseAction(params: unknown): ValidationResult<CombatUseActionParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.actionId)) return fail('缺少 actionId（要使用的动作）');
  if (params.actionId.length > 64) return fail('actionId 过长（最多 64 字符）');
  if (params.targetId !== undefined && !isNonEmptyString(params.targetId)) return fail('targetId 必须是非空字符串');
  const error = selectorError(params);
  if (error !== undefined) return fail(error);
  if (params.options !== undefined) {
    if (!isRecord(params.options)) return fail('options 必须是对象');
    const options = params.options;
    if (!isOptionalFiniteNumber(options.mods)) return fail('options.mods 必须是数值');
    if (!isOptionalDiceMode(options.mode)) return fail('options.mode 必须是 normal/advantage/disadvantage');
    if (!isOptionalFiniteNumber(options.dc)) return fail('options.dc 必须是数值');
    if (options.skillId !== undefined && !isNonEmptyString(options.skillId)) return fail('options.skillId 必须是非空字符串');
    if (!isOptionalFiniteNumber(options.distance)) return fail('options.distance 必须是数值');
  }
  return { ok: true, value: params as unknown as CombatUseActionParams };
}

/** `combat.move` 参数校验（目标是 `{ zoneId }` 或 `{ cell: { x, y } }`）。 */
export function validateCombatMove(params: unknown): ValidationResult<CombatMoveParams> {
  if (!isRecord(params)) return fail('缺少参数');
  const to = params.to;
  if (!isRecord(to)) return fail('缺少 to（移动目标：{ zoneId } 或 { cell: { x, y } }）');
  const hasZone = to.zoneId !== undefined;
  const hasCell = to.cell !== undefined;
  if (!hasZone && !hasCell) return fail('to 必须给出 zoneId 或 cell');
  if (hasZone && !isNonEmptyString(to.zoneId)) return fail('to.zoneId 必须是非空字符串');
  if (hasCell) {
    if (!isRecord(to.cell) || typeof to.cell.x !== 'number' || typeof to.cell.y !== 'number') {
      return fail('to.cell 必须是 { x, y } 数值坐标');
    }
    if (!Number.isInteger(to.cell.x) || !Number.isInteger(to.cell.y)) return fail('to.cell 的 x/y 必须是整数');
  }
  if (params.via !== undefined && !isNonEmptyString(params.via)) return fail('via 必须是非空字符串');
  const error = selectorError(params);
  if (error !== undefined) return fail(error);
  return { ok: true, value: params as unknown as CombatMoveParams };
}

/** `combat.endTurn` 参数校验。 */
export function validateCombatEndTurn(params: unknown): ValidationResult<CombatEndTurnParams> {
  if (params !== undefined && params !== null && !isRecord(params)) return fail('参数必须是对象');
  const value = (params ?? {}) as Record<string, unknown>;
  if (value.actorId !== undefined && !isNonEmptyString(value.actorId)) return fail('actorId 必须是非空字符串');
  if (value.playerId !== undefined && !isNonEmptyString(value.playerId)) return fail('playerId 必须是非空字符串');
  return { ok: true, value: value as unknown as CombatEndTurnParams };
}

/** `combat.rollCheck` 参数校验。 */
export function validateCombatRollCheck(params: unknown): ValidationResult<CombatRollCheckParams> {
  if (params !== undefined && params !== null && !isRecord(params)) return fail('参数必须是对象');
  const value = (params ?? {}) as Record<string, unknown>;
  const error = selectorError(value);
  if (error !== undefined) return fail(error);
  if (value.targetId !== undefined && !isNonEmptyString(value.targetId)) return fail('targetId 必须是非空字符串');
  if (value.skillId !== undefined && !isNonEmptyString(value.skillId)) return fail('skillId 必须是非空字符串');
  if (value.attributeId !== undefined && !isNonEmptyString(value.attributeId)) return fail('attributeId 必须是非空字符串');
  if (value.kind !== undefined && !isNonEmptyString(value.kind)) return fail('kind 必须是非空字符串');
  if (value.reason !== undefined && typeof value.reason !== 'string') return fail('reason 必须是字符串');
  if (value.dc !== undefined) {
    if (typeof value.dc !== 'number' || !Number.isInteger(value.dc) || value.dc < 0 || value.dc > 60) {
      return fail('dc 必须是 0–60 的整数');
    }
  }
  if (!isOptionalFiniteNumber(value.mods)) return fail('mods 必须是数值');
  if (!isOptionalDiceMode(value.mode)) return fail('mode 必须是 normal/advantage/disadvantage');
  return { ok: true, value: value as unknown as CombatRollCheckParams };
}

/** `combat.end` 参数校验。 */
export function validateCombatEnd(params: unknown): ValidationResult<CombatEndParams> {
  if (params !== undefined && params !== null && !isRecord(params)) return fail('参数必须是对象');
  const value = (params ?? {}) as Record<string, unknown>;
  if (value.reason !== undefined && typeof value.reason !== 'string') return fail('reason 必须是字符串');
  return { ok: true, value: value as unknown as CombatEndParams };
}

/** `worldmap.get` 参数校验（空参数）。 */
export function validateWorldMapGet(params: unknown): ValidationResult<WorldMapGetParams> {
  return acceptEmptyParams<WorldMapGetParams>(params);
}

/** 事件的 SSE 线格式。 */
export function encodeSseEvent(event: GameEvent): string {
  return `event: game\ndata: ${JSON.stringify(event)}\n\n`;
}
