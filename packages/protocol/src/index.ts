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
  /**
   * 房间资产列表（M9.5d）：已落座玩家上传的展示资产（头像/立绘/变体/帧表/图标），
   * 按 sha256 去重、只含引用与 URL，不含字节。缺省 = 本房间还没有展示资产。
   */
  assets?: RoomAssetView[];
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
  | 'worldmap.get'
  // ---- M9.5d 玩家角色资产（生图 / 落座上传；UI-CONTRACT §4.4/§4.5/§7.2/§8） ----
  | 'assets.generate'
  | 'assets.upload'
  // ---- M9.5e 地图/世界生成 + 内容包工坊（仅 loopback + host token；UI-CONTRACT §5.4/§5.5/§10） ----
  | 'map.generate'
  | 'world.generate'
  | 'pack.detail'
  | 'pack.update'
  | 'pack.export'
  | 'pack.import'
  | 'pack.assetPut'
  | 'pack.assetDelete'
  // ---- M9.6b 规则校验 / 规则测试台（工坊，仅 loopback + host token；RULES-MODEL §12） ----
  | 'rules.validate'
  | 'rules.test';

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
  /**
   * 落座时随卡提交的展示资产**引用**（M9.5d）：`assets.upload` 先上传字节，
   * 这里只传 `{kind, variant?, sha256, url?}`；host 不复制字节、只把引用写进房间视图/快照。
   * 未上传/上传失败的引用会被 host 丢弃（落座不阻断，客户端用几何徽记兜底）。
   */
  characterAssets?: CharacterAssetRefInput[];
}

// ---------------------------------------------------------------------------
// M9.5d 玩家角色资产与生图（UI-CONTRACT §4.4/§4.5/§7.2/§8）
//
// 口径：私卡资产默认在客户端 IndexedDB；落座只上传「展示用」白名单资产（≤8 文件 / ≤8 MiB），
// host 落盘到房间资产区（内容寻址、sha256 去重、immutable），房间关闭不删（续团保留）。
// 生成走 host 的 OpenAI 兼容服务（或玩家自备接口的 host 侧代发），候选先预览确认再上传。
// ---------------------------------------------------------------------------

/** 生图请求的目标类型（玩家头像/立绘/图标/帧表）。 */
export type MediaAssetKind = 'avatar' | 'portrait' | 'icon' | 'sprite';

/** 生图风格档：像素 32 图标 / 扁平 2D / AI SVG 图标。 */
export type MediaAssetStyle = 'pixel-32' | 'game-2d' | 'svg';

export const MEDIA_ASSET_KINDS: readonly MediaAssetKind[] = ['avatar', 'portrait', 'icon', 'sprite'];
export const MEDIA_ASSET_STYLES: readonly MediaAssetStyle[] = ['pixel-32', 'game-2d', 'svg'];

/** `assets.generate` 参数（玩家 + 房主可用；每玩家限流）。 */
export interface AssetsGenerateParams {
  kind: MediaAssetKind;
  style: MediaAssetStyle;
  /** 用户提示词（主体/风格/颜色/构图要求）。 */
  prompt: string;
  /** 主体名（角色名/图标主题），参与提示词模板的 `{{name}}`。 */
  subject?: string;
  /** 复现种子（后端支持时透传并回写）。 */
  seed?: number;
  /** 候选数量 1–4（缺省 1）。 */
  count?: number;
}

/** 单个生成候选（归一化后的标准档字节，base64；确认后由客户端走 `assets.upload`）。 */
export interface AssetsGenerateCandidate {
  /** 归一化后图片的 base64（PNG 或 SVG 文本字节）。 */
  b64: string;
  format: 'png' | 'svg';
  /** 标准档宽高（avatar 256 / portrait 768×1024 / icon 128·32 / sprite 帧表 512×512）。 */
  width: number;
  height: number;
  /** 归一化后字节的 sha256（内容寻址；与上传去重同口径）。 */
  sha256: string;
  /** 实际使用的完整提示词（可复现/生成历史）。 */
  prompt: string;
  seed?: number;
  style: MediaAssetStyle;
}

export interface AssetsGenerateResult {
  candidates: AssetsGenerateCandidate[];
  /** 服务来源（如 `openai-compat:<imageModel>` / `fake`）；缺省 = 未标注。 */
  provider?: string;
}

/** 落座上传的展示资产类型（白名单，UI-CONTRACT §4.5；私密字段永不上传）。 */
export type CharacterAssetKind = 'avatar' | 'portrait' | 'portraitVariant' | 'spriteSheet' | 'icon';

export const CHARACTER_ASSET_KINDS: readonly CharacterAssetKind[] = [
  'avatar',
  'portrait',
  'portraitVariant',
  'spriteSheet',
  'icon',
];

/** 落座上传限额（UI-CONTRACT §4.5：单卡 ≤8 个文件 / ≤8 MiB）。 */
export const ROOM_ASSET_LIMITS = {
  /** 单次上传（= 单卡展示资产）文件数上限。 */
  maxFiles: 8,
  /** 单次上传总字节上限 8 MiB。 */
  maxBytes: 8 * 1024 * 1024,
  /** 单文件 URL 长度上限（防注入）。 */
  maxUrlLength: 512,
  /** 变体名长度上限。 */
  maxVariantLength: 32,
} as const;

/** 帧表元数据（帧表必须给，用于切分校验与展示）。 */
export interface CharacterAssetMeta {
  /** 行数 1–8。 */
  rows?: number;
  /** 列数 1–8。 */
  cols?: number;
  /** 每格边长（px，16–256）。 */
  frameSize?: number;
}

export interface CharacterAssetUploadItem {
  kind: CharacterAssetKind;
  /** 变体名（`portraitVariant` 必填；建议固定集 idle/smile/sad/angry/attack）。 */
  variant?: string;
  /** 图片字节的 base64（只收 PNG/SVG）。 */
  b64: string;
  /** 帧表元数据（`spriteSheet` 必填）。 */
  meta?: CharacterAssetMeta;
}

/** `assets.upload` 参数（房间成员；token → 玩家）。 */
export interface AssetsUploadParams {
  assets: CharacterAssetUploadItem[];
}

/** 上传成功的资产引用（host 已落盘；后续 `seat` 只回传 `{kind, variant?, sha256, url}`）。 */
export interface AssetsUploadedAsset {
  /** 内容寻址 id（= sha256，同内容全房间唯一）。 */
  assetId: string;
  kind: CharacterAssetKind;
  variant?: string;
  sha256: string;
  /** 无 token 只读 URL：`/trpg/room-assets/<roomId>/<sha256>.<ext>`。 */
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export interface AssetsUploadResult {
  assets: AssetsUploadedAsset[];
}

/** 落座时提交的资产引用（`seat.characterAssets[]`；只传引用，不复制字节）。 */
export interface CharacterAssetRefInput {
  kind: CharacterAssetKind;
  variant?: string;
  /** 64 位小写十六进制 sha256（与 `assets.upload` 返回一致）。 */
  sha256: string;
  /** 上传返回的 URL（host 会按自家存储重算；客户端原样回传即可）。 */
  url?: string;
  /**
   * 帧表元数据（`spriteSheet` 用；host 落座时会按自家存储补全，
   * 客户端不上传也可以——上传过的 host 知道 rows/cols/frameSize）。
   */
  meta?: CharacterAssetMeta;
}

/** 房间资产列表条目（`RoomView.assets[]`：队友可见的展示资产引用）。 */
export interface RoomAssetView {
  assetId: string;
  kind: CharacterAssetKind;
  variant?: string;
  sha256: string;
  /** 无 token 只读 URL（immutable + ETag）。 */
  url: string;
  /** 归一化/落盘时的宽高（帧表为整表尺寸）。 */
  width?: number;
  height?: number;
  bytes?: number;
  /** 上传者（玩家 id / `host`）。 */
  ownerId?: PlayerId;
}

/** 角色卡面上的媒体投影（`SheetView.identity` 的 M9.5d 扩展；全部可选）。 */
export interface SheetIdentityMediaView {
  /** 头像 URL（玩家席/队伍面板用；缺省 → 客户端几何徽记）。 */
  avatarUrl?: string;
  /** 立绘 URL（人物界面 3:4 位；缺省回退头像）。 */
  portraitUrl?: string;
  /** 表情/动作变体（未配的按 `portraitUrl` 回退）。 */
  portraitVariants?: Array<{ variant: string; url: string }>;
  /** 精灵帧表（切分在归一化阶段完成；运行时不切）。 */
  spriteSheet?: { url: string; rows: number; cols: number; frameSize: number };
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
  identity: { name: string; level: number; race?: string; class?: string } & SheetIdentityMediaView;
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
  /** 头像 URL（M9.5d：玩家落座上传后由 host 下发；缺省 → 客户端用职业图标/几何徽记）。 */
  avatarUrl?: string;
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
  'assets.generate',
  'assets.upload',
  'map.generate',
  'world.generate',
  'pack.detail',
  'pack.update',
  'pack.export',
  'pack.import',
  'pack.assetPut',
  'pack.assetDelete',
  'rules.validate',
  'rules.test',
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

// ---------------------------------------------------------------------------
// 校验：M9.5d 玩家角色资产 / 生图
// ---------------------------------------------------------------------------

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** 变体名：小写字母数字 + `_`/`-`（`idle/smile/sad/angry/attack` 等）。 */
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** 房间资产 URL 只允许 host 的只读端点相对路径（拒绝绝对地址/协议/`//`/反斜杠/`..`）。 */
const ROOM_ASSET_URL_PREFIX = '/trpg/room-assets/';

/** base64 文本解码后的近似字节数（校验限额用；精确字节由 host 存储层再验）。 */
function approximateBase64Bytes(value: string): number {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

function isCharacterAssetKind(value: unknown): value is CharacterAssetKind {
  return typeof value === 'string' && (CHARACTER_ASSET_KINDS as readonly string[]).includes(value);
}

function isMediaAssetKind(value: unknown): value is MediaAssetKind {
  return typeof value === 'string' && (MEDIA_ASSET_KINDS as readonly string[]).includes(value);
}

function isMediaAssetStyle(value: unknown): value is MediaAssetStyle {
  return typeof value === 'string' && (MEDIA_ASSET_STYLES as readonly string[]).includes(value);
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** `assets.generate` 参数校验（玩家 + 房主可用；限流与配置由 host 的 MediaService 负责）。 */
export function validateAssetsGenerate(params: unknown): ValidationResult<AssetsGenerateParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isMediaAssetKind(params.kind)) {
    return fail(`kind 必须是 avatar / portrait / icon / sprite，收到 ${JSON.stringify(params.kind)}`);
  }
  if (!isMediaAssetStyle(params.style)) {
    return fail(`style 必须是 pixel-32 / game-2d / svg，收到 ${JSON.stringify(params.style)}`);
  }
  if (!isNonEmptyString(params.prompt)) return fail('prompt 不能为空');
  if (params.prompt.length > 2000) return fail('prompt 过长（最多 2000 字）');
  if (params.subject !== undefined) {
    if (typeof params.subject !== 'string') return fail('subject 必须是字符串');
    if (params.subject.length > 100) return fail('subject 过长（最多 100 字）');
  }
  if (params.seed !== undefined && !isBoundedInteger(params.seed, 0, 2 ** 31 - 1)) {
    return fail('seed 必须是 0–2147483647 的整数');
  }
  if (params.count !== undefined && !isBoundedInteger(params.count, 1, 4)) {
    return fail('count 必须是 1–4 的整数');
  }
  return { ok: true, value: params as unknown as AssetsGenerateParams };
}

/**
 * `assets.upload` 参数校验（房间成员）：白名单 kind、base64 文本、帧表 meta，
 * 单次 ≤8 个文件 / ≤8 MiB（按 base64 近似字节；host 存储层解码后再精确校验）。
 */
export function validateAssetsUpload(params: unknown): ValidationResult<AssetsUploadParams> {
  if (!isRecord(params)) return fail('缺少参数');
  const rawAssets = params.assets;
  if (!Array.isArray(rawAssets)) return fail('缺少 assets 数组');
  if (rawAssets.length === 0) return fail('assets 数组不能为空（至少上传 1 个资产）');
  if (rawAssets.length > ROOM_ASSET_LIMITS.maxFiles) {
    return fail(`单次最多上传 ${ROOM_ASSET_LIMITS.maxFiles} 个资产（当前 ${rawAssets.length} 个）：请删掉不用的表情或换更小的图`);
  }
  let totalBytes = 0;
  const assets: CharacterAssetUploadItem[] = [];
  for (let index = 0; index < rawAssets.length; index += 1) {
    const item = rawAssets[index];
    if (!isRecord(item)) return fail(`assets[${index}] 必须是对象`);
    if (!isCharacterAssetKind(item.kind)) {
      return fail(`assets[${index}].kind 必须是 avatar / portrait / portraitVariant / spriteSheet / icon`);
    }
    if (!isNonEmptyString(item.b64)) return fail(`assets[${index}].b64 不能为空（应为图片字节的 base64）`);
    if (item.variant !== undefined) {
      if (typeof item.variant !== 'string' || !VARIANT_PATTERN.test(item.variant)) {
        return fail(`assets[${index}].variant 非法（只能是字母/数字/_/-，最多 32 字符）`);
      }
    }
    if (item.kind === 'portraitVariant' && item.variant === undefined) {
      return fail(`assets[${index}] 是表情/动作变体，必须带 variant 名（如 idle / smile）`);
    }
    if (item.meta !== undefined) {
      if (!isRecord(item.meta)) return fail(`assets[${index}].meta 必须是对象`);
      if (item.meta.rows !== undefined && !isBoundedInteger(item.meta.rows, 1, 8)) {
        return fail(`assets[${index}].meta.rows 必须是 1–8 的整数`);
      }
      if (item.meta.cols !== undefined && !isBoundedInteger(item.meta.cols, 1, 8)) {
        return fail(`assets[${index}].meta.cols 必须是 1–8 的整数`);
      }
      if (item.meta.frameSize !== undefined && !isBoundedInteger(item.meta.frameSize, 16, 256)) {
        return fail(`assets[${index}].meta.frameSize 必须是 16–256 的整数`);
      }
    }
    if (item.kind === 'spriteSheet' && item.meta === undefined) {
      return fail(`assets[${index}] 是帧表，必须带 meta{rows,cols,frameSize}`);
    }
    totalBytes += approximateBase64Bytes(item.b64);
    assets.push(item as unknown as CharacterAssetUploadItem);
  }
  if (totalBytes > ROOM_ASSET_LIMITS.maxBytes) {
    const mb = (totalBytes / (1024 * 1024)).toFixed(2);
    return fail(`上传资产总量超限：当前约 ${mb} MB / 上限 8 MB；请删掉不用的表情或换更小的图`);
  }
  return { ok: true, value: { assets } };
}

/** 校验一条资产引用 URL：只允许 host 只读房间资产端点的相对路径。 */
function isSafeRoomAssetUrl(url: string): boolean {
  if (url.length > ROOM_ASSET_LIMITS.maxUrlLength) return false;
  if (!url.startsWith(ROOM_ASSET_URL_PREFIX)) return false;
  if (url.includes('\\')) return false;
  if (url.includes('//')) return false;
  if (/[\u0000-\u001f\u007f]/.test(url)) return false;
  const rest = url.slice(ROOM_ASSET_URL_PREFIX.length);
  const segments = rest.split('/');
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false;
  return true;
}

/**
 * 校验 `seat.characterAssets`（落座资产引用）：kind 白名单、sha256 64 位小写十六进制、
 * 可选 url 只允许 host 房间资产端点相对路径；同一 `kind+variant` 只允许一条。
 * `undefined`/`null` = 没有资产（合法），返回空数组。
 */
export function validateCharacterAssetRefs(input: unknown): ValidationResult<CharacterAssetRefInput[]> {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return fail('characterAssets 必须是数组');
  if (input.length > ROOM_ASSET_LIMITS.maxFiles) {
    return fail(`角色展示资产最多 ${ROOM_ASSET_LIMITS.maxFiles} 个文件（当前 ${input.length} 个）`);
  }
  const refs: CharacterAssetRefInput[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isRecord(item)) return fail(`characterAssets[${index}] 必须是对象`);
    if (!isCharacterAssetKind(item.kind)) {
      return fail(`characterAssets[${index}].kind 必须是 avatar / portrait / portraitVariant / spriteSheet / icon`);
    }
    const sha256 = item.sha256;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      return fail(`characterAssets[${index}].sha256 必须是 64 位小写十六进制 sha256`);
    }
    if (item.variant !== undefined && (typeof item.variant !== 'string' || !VARIANT_PATTERN.test(item.variant))) {
      return fail(`characterAssets[${index}].variant 非法（只能是字母/数字/_/-，最多 32 字符）`);
    }
    if (item.kind === 'portraitVariant' && item.variant === undefined) {
      return fail(`characterAssets[${index}] 是表情/动作变体，必须带 variant 名`);
    }
    if (item.url !== undefined) {
      if (typeof item.url !== 'string' || !isSafeRoomAssetUrl(item.url)) {
        return fail(`characterAssets[${index}].url 必须是 /trpg/room-assets/ 下的相对路径`);
      }
    }
    if (item.meta !== undefined) {
      if (!isRecord(item.meta)) return fail(`characterAssets[${index}].meta 必须是对象`);
      if (item.meta.rows !== undefined && !isBoundedInteger(item.meta.rows, 1, 8)) {
        return fail(`characterAssets[${index}].meta.rows 必须是 1–8 的整数`);
      }
      if (item.meta.cols !== undefined && !isBoundedInteger(item.meta.cols, 1, 8)) {
        return fail(`characterAssets[${index}].meta.cols 必须是 1–8 的整数`);
      }
      if (item.meta.frameSize !== undefined && !isBoundedInteger(item.meta.frameSize, 16, 256)) {
        return fail(`characterAssets[${index}].meta.frameSize 必须是 16–256 的整数`);
      }
    }
    const key = `${item.kind}:${item.variant ?? ''}`;
    if (seen.has(key)) return fail(`characterAssets 里同一 kind/variant 只能有一条引用（重复：${key}）`);
    seen.add(key);
    refs.push({
      kind: item.kind,
      ...(item.variant !== undefined ? { variant: item.variant as string } : {}),
      sha256,
      ...(item.url !== undefined ? { url: item.url as string } : {}),
      ...(item.meta !== undefined
        ? {
            meta: {
              ...(item.meta.rows !== undefined ? { rows: item.meta.rows as number } : {}),
              ...(item.meta.cols !== undefined ? { cols: item.meta.cols as number } : {}),
              ...(item.meta.frameSize !== undefined ? { frameSize: item.meta.frameSize as number } : {}),
            },
          }
        : {}),
    });
  }
  return { ok: true, value: refs };
}

/** 事件的 SSE 线格式。 */
export function encodeSseEvent(event: GameEvent): string {
  return `event: game\ndata: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// M9.5e 地图/世界生成 + 内容包工坊（docs/RULES-MODEL §3 生成小节、UI-CONTRACT §5.4/§5.5/§10）
// 这 8 个方法全部只允许 **loopback + host token**（作者操作，玩家不可调用）。
// ---------------------------------------------------------------------------

/** 战斗地图底图风格档（RULES-MODEL §3：`topdown-2d` / `pixel-topdown`）。 */
export type MapGenerateStyle = 'topdown-2d' | 'pixel-topdown';
export const MAP_GENERATE_STYLES: readonly MapGenerateStyle[] = ['topdown-2d', 'pixel-topdown'];

/** 世界地图底图风格档（v1 只有 2D 插画）。 */
export type WorldGenerateStyle = '2d-illustration';
export const WORLD_GENERATE_STYLES: readonly WorldGenerateStyle[] = ['2d-illustration'];

/** 结构来源：AI 文本草稿过校验（`ai`）或本机程序化兜底（`procedural`）。 */
export type MapGenerateMethod = 'ai' | 'procedural';

/**
 * 战棋格地形图例：**generator 与校验器共用同一份定义**（RULES-MODEL §3「校验器与程序兜底
 * 生成器共用同一套约束定义」）。`terrain[][]` 里每个格子是这里的单字符 key；
 * 落盘成 `space.battleMaps[].terrain` 时按 `id` 映射到规则包 `space.terrains[]` 的地形 id。
 */
export interface BattleTerrainSpec {
  /** 对应规则包 `space.terrains[].id`。 */
  id: string;
  /** 中文展示名。 */
  name: string;
  /** 是否可通行（`blocksMove` 的反面；BFS 连通性只看这个）。 */
  walkable: boolean;
  /** 移动力消耗（不可通行为 0）。 */
  moveCost: number;
}

export const BATTLE_TERRAIN_LEGEND: Readonly<Record<string, BattleTerrainSpec>> = {
  g: { id: 'floor', name: '草地', walkable: true, moveCost: 1 },
  '.': { id: 'floor', name: '地面', walkable: true, moveCost: 1 },
  r: { id: 'rubble', name: '碎石', walkable: true, moveCost: 2 },
  '+': { id: 'door', name: '门', walkable: true, moveCost: 1 },
  t: { id: 'tree', name: '树木', walkable: false, moveCost: 0 },
  '~': { id: 'water', name: '水域', walkable: false, moveCost: 0 },
  w: { id: 'wall', name: '岩壁', walkable: false, moveCost: 0 },
  '#': { id: 'wall', name: '墙', walkable: false, moveCost: 0 },
};

/** 合法地形字符（校验器与生成器共用；未知字符一律报错，不静默当墙）。 */
export const BATTLE_TERRAIN_CHARS: readonly string[] = Object.keys(BATTLE_TERRAIN_LEGEND);

/** 战棋结构硬约束（RULES-MODEL §3）。 */
export const BATTLE_STRUCTURE_LIMITS = {
  /** 单边 ≤ 32（1..32）。 */
  maxCols: 32,
  maxRows: 32,
  /** 单图 spawn ≤ 20。 */
  maxSpawns: 20,
  /** 单侧出生点上限（= 队伍人数上限）。 */
  maxSpawnSide: 8,
  /** 生成参数里的队伍人数 1..8。 */
  maxPartySize: 8,
} as const;

/** 出生点阵营（RULES-MODEL §3：`player/enemy/neutral`）。 */
export type BattleSpawnSide = 'player' | 'enemy' | 'neutral';
export const BATTLE_SPAWN_SIDES: readonly BattleSpawnSide[] = ['player', 'enemy', 'neutral'];

/** 战棋障碍矩形（RULES-MODEL §3 `obstacles[]`）。 */
export interface BattleStructureObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 覆盖格的地形字符（缺省 = 纯装饰，不改变地形）。 */
  terrain?: string;
  /** 掩体 id（对应规则包 `space.covers[].id`）。 */
  coverId?: string;
}

/** 战棋出生点（RULES-MODEL §3 `spawns[]`）。 */
export interface BattleStructureSpawn {
  x: number;
  y: number;
  side: BattleSpawnSide;
  label?: string;
  /** 关联怪物 id（敌方出生点可选；客户端/作者按规则包填）。 */
  monsterId?: string;
}

/** 战棋地图结构（唯一权威；底图只是皮肤）。 */
export interface BattleStructure {
  cols: number;
  rows: number;
  /** rows × cols 地形字符矩阵，行优先；每行长度必须 = cols。 */
  terrain: string[][];
  obstacles: BattleStructureObstacle[];
  spawns: BattleStructureSpawn[];
}

/** 生成的地图底图（已归一化到标准档：战斗图 1024×768 / 世界图 2048×1536）。 */
export interface GeneratedMapBackground {
  /** 归一化后 PNG 字节的 base64。 */
  b64: string;
  width: number;
  height: number;
  /** 归一化后字节的 sha256（内容寻址，与 `pack.assetPut` 同口径）。 */
  sha256: string;
  format: 'png';
}

export interface MapGenerateParams {
  /** 这一战在哪、谁在场、什么地形（作者自然语言；AI 只做草稿，结构仍需过校验器）。 */
  prompt: string;
  style: MapGenerateStyle;
  /** 列数 4..32；缺省按队伍人数推导。 */
  cols?: number;
  /** 行数 4..32；缺省按队伍人数推导。 */
  rows?: number;
  /** 玩家人数 1..8（决定玩家出生点数量）。 */
  partySize?: number;
  /** 复现种子 0..2^31-1；缺省按 prompt 派生（同 prompt 同结构）。 */
  seed?: number;
  /** 是否顺带生成 AI 底图（失败只进 warnings，不阻断结构）。 */
  withBackground?: boolean;
}

export interface MapGenerateResult {
  structure: BattleStructure;
  warnings: string[];
  method: MapGenerateMethod;
  background?: GeneratedMapBackground | null;
}

/** 世界地图热点（归一化坐标 0..1 的矩形；契约里 zone.hotspot 只存中心点，w/h 用于避让与渲染）。 */
export interface WorldZoneHotspot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 区域连线（双向各存一条；`kind` 决定渲染样式：道路实线 / 河流蓝 / 楼梯虚线）。 */
export interface WorldZoneConnection {
  to: string;
  kind?: string;
}

/** 世界地图区域（`space.zones[]` 的生成结构：热点 + 连线 + 可选描述）。 */
export interface WorldZoneStructure {
  /** 区域 id（包内唯一；允许中文，与规则包 zoneId 同规则）。 */
  zoneId: string;
  name: string;
  description?: string;
  hotspot: WorldZoneHotspot;
  connections: WorldZoneConnection[];
}

export interface WorldStructure {
  zones: WorldZoneStructure[];
  /** 世界地图底图资产引用占位：结构生成阶段恒为 null，底图由背景生图/`pack.assetPut` 另行落盘。 */
  background?: null;
}

export const WORLD_STRUCTURE_LIMITS = {
  minZones: 3,
  maxZones: 8,
  /** 热点宽高合理区间（归一化）。 */
  minHotspotSize: 0.02,
  maxHotspotSize: 0.6,
  /** 世界地图底图目标比例 4:3（2048×1536）。 */
  backgroundWidth: 2048,
  backgroundHeight: 1536,
} as const;

export interface WorldGenerateParams {
  prompt: string;
  /** 区域数量 3..8（缺省 5）。 */
  zoneCount?: number;
  /** 底图风格（缺省 `2d-illustration`）。 */
  style?: WorldGenerateStyle;
  /** 复现种子；缺省按 prompt 派生。 */
  seed?: number;
  /** 是否顺带生成 AI 底图（失败只进 warnings）。 */
  withBackground?: boolean;
}

export interface WorldGenerateResult {
  world: WorldStructure;
  warnings: string[];
  method: MapGenerateMethod;
  background?: GeneratedMapBackground | null;
}

// ---------------------------------------------------------------------------
// 内容包工坊（写操作只允许 loopback + host token）
// ---------------------------------------------------------------------------

/** 内容包资产种类（与 `assets/manifest.json` 的 `kind` 白名单一致）。 */
export const PACK_ASSET_KINDS = [
  'item',
  'action',
  'status',
  'resource',
  'attribute',
  'slot',
  'avatar',
  'portrait',
  'variant',
  'spritesheet',
  'npc',
  'cover',
] as const;
export type PackAssetKind = (typeof PACK_ASSET_KINDS)[number];

/** 资产归一化目标档（与 `@dsh-trpg/assets` 的 `NormalizeTargetId` 一致，工坊落盘用）。 */
export const PACK_ASSET_TARGETS = [
  'pixel-32',
  'icon-128',
  'avatar-256',
  'portrait',
  'variant',
  'spritesheet',
  'cover',
  'world-map',
  'battle-map',
] as const;
export type PackAssetTargetId = (typeof PACK_ASSET_TARGETS)[number];

/** 工坊资产落盘的附加元数据（都可选；缺省按 kind 映射目标档）。 */
export interface PackAssetPutMeta {
  /** 清单里的 `style` 字段（缺省 `imported`）。 */
  style?: string;
  seed?: number;
  /** AI 生成提示词（写入清单便于复现）。 */
  prompt?: string;
  /** 覆盖按 kind 推导的归一化目标档（如地图底图用 battle-map / world-map）。 */
  target?: PackAssetTargetId;
  /** 帧表行/列/单格尺寸（target=spritesheet 时用）。 */
  rows?: number;
  cols?: number;
  frameSize?: number;
}

export interface PackDetailParams {
  packId: string;
}

export interface PackDetailResult {
  /**
   * 完整内容包（`ContentPack`，含 rules/lorebook/modules/cards）。
   * 协议包不依赖 `@dsh-trpg/content`，这里按文档形状给出；客户端按 ContentPack 断言即可。
   */
  pack: unknown;
}

export interface PackUpdateParams {
  /** 目标包 id（= `pack.packId`；内置包不可改）。 */
  packId: string;
  /** 完整 `ContentPack`（host 侧 `validatePack()` 全量校验后再落盘）。 */
  pack: unknown;
}

export interface PackUpdateResult {
  packId: string;
  version: string;
  /** sha256(zip 字节)。 */
  packHash: string;
  warnings: string[];
}

export interface PackExportParams {
  packId: string;
}

export interface PackExportResult {
  /** `<packId>-<version>.trpgpack`。 */
  fileName: string;
  b64: string;
  bytes: number;
  packHash: string;
}

/** 同 id 冲突策略：拒绝 / 覆盖（仅数据目录包）/ 另存副本（新 packId 后缀 `-copy-N`）。 */
export type PackImportStrategy = 'reject' | 'overwrite' | 'rename';
export const PACK_IMPORT_STRATEGIES: readonly PackImportStrategy[] = ['reject', 'overwrite', 'rename'];

/** 导入动作：新建 / 覆盖已有数据包 / 因冲突另存为新 id。 */
export type PackImportAction = 'created' | 'overwritten' | 'renamed';

export interface PackImportParams {
  /** `.trpgpack` 文件字节的 base64。 */
  b64: string;
  /** 原始文件名（仅提示用；落盘名始终 `<packId>-<version>.trpgpack`）。 */
  fileName?: string;
  strategy: PackImportStrategy;
}

export interface PackImportResult {
  packId: string;
  version: string;
  action: PackImportAction;
  warnings: string[];
}

export interface PackAssetPutParams {
  packId: string;
  /** `<kind>.<scope>.<slug>`，包内唯一（同 id = 替换）。 */
  assetId: string;
  kind: PackAssetKind;
  /** 图片字节（PNG/SVG）的 base64；host 会按 kind 归一化后再落盘。 */
  b64: string;
  meta?: PackAssetPutMeta;
}

export interface PackAssetPutResult {
  assetId: string;
  /** 归一化后字节的 sha256。 */
  sha256: string;
  /** 归一化后字节数。 */
  bytes: number;
  manifestUpdated: true;
}

export interface PackAssetDeleteParams {
  packId: string;
  assetId: string;
}

export interface PackAssetDeleteResult {
  /** 是否真的删掉了一条资产（不存在时 false，幂等）。 */
  removed: boolean;
}

// ---------------------------------------------------------------------------
// M9.6b 规则校验 / 规则测试台（工坊 RPC，仅 loopback + host token）
//
// 权威口径（RULES-MODEL §3/§6/§12）：
// - `rules.validate`：只校验 `pack.rules` 段（validateRulePack）+ 脚本文件存在性/sha256；
//   可带**草稿 pack**（完整 pack.json）——校验草稿但不落盘，作者保存前先自检；
// - `rules.test`：用**临时规则运行时 + 样本卡**跑一遍（不建房间、不影响用户房间），
//   每条请求返回骰面 `rolls`、人话 `trace`、结构化 `result` 与可读错误；
// - 数值只来自运行时返回值（客户端不计算）。
// ---------------------------------------------------------------------------

/** 单条规则脚本的完整性校验结果（`rules.scripts` 清单 vs 主机上的实际脚本文件）。 */
export interface RulesScriptCheck {
  /** 引用该脚本的钩子名（同一文件可被多个钩子引用）。 */
  hook: string;
  /** 脚本文件路径（`rules/scripts/*.js`）。 */
  file: string;
  /** `rules.scripts[hook].sha256` 声明的 sha256。 */
  declaredSha256: string;
  /** 主机上实际脚本文件内容的 sha256（脚本缺失/无法读取时为 null）。 */
  actualSha256: string | null;
  exists: boolean;
  sha256Ok: boolean;
  /** 人话结论（中文；ok 时也给一句）。 */
  message: string;
}

export interface RulesValidateParams {
  packId: string;
  /**
   * 可选草稿：完整 `pack.json`（`ContentPack` 形状）。传了则校验**草稿**、不落盘；
   * 草稿的 `packId` 必须与参数一致。缺省校验已安装的包。
   */
  pack?: unknown;
}

export interface RulesValidateResult {
  /** 规则段与脚本清单全部通过（warnings 不影响 ok）。 */
  ok: boolean;
  errors: string[];
  warnings: string[];
  packId: string;
  /** `rules.rulesId`（包没有 rules 段时为 null）。 */
  rulesId: string | null;
  /** true = 校验的是草稿（未落盘）。 */
  draft: boolean;
  /** 脚本完整性逐条结果（无脚本时为空数组）。 */
  scripts: RulesScriptCheck[];
  durationMs: number;
}

/** 测试台请求类型：检定 / 动作 / 派生值。 */
export type RulesTestKind = 'check' | 'action' | 'derived';
export const RULES_TEST_KINDS: readonly RulesTestKind[] = ['check', 'action', 'derived'];

/** `rules.test` 的单条请求（全部字段可选，按 kind 解释）。 */
export interface RulesTestRequest {
  kind: RulesTestKind;
  /** 样本卡：`pack.cards[].cardId`；缺省取包内第一张卡，没有则用合成样本卡。 */
  actorCardId?: string;
  /** 目标：`pack.cards[].cardId`（作为敌方目标）；缺省用合成假人。 */
  targetId?: string;
  /** kind=action：要试跑的动作 id（`rules.actions[].actionId`）。 */
  actionId?: string;
  /** kind=check：技能 id（`rules.sheet.skills[].id`）。 */
  skillId?: string;
  /** kind=check：属性 id（`rules.sheet.attributes[].id`）。 */
  attributeId?: string;
  /** kind=check/action：DC（0–60，缺省 10 / 动作自身判定用）。 */
  dc?: number;
  /** 检定模式（优势/劣势）。 */
  mode?: 'normal' | 'advantage' | 'disadvantage';
  /** 额外加值（检定/动作判定用）。 */
  mods?: number;
}

export interface RulesTestParams {
  packId: string;
  /** 1–12 条请求；按顺序逐条独立跑（每条新建运行时，互不影响）。 */
  requests: RulesTestRequest[];
  /** 复现种子（0–2^31-1；缺省由 packId + rulesId 稳定派生）。 */
  seed?: number;
  /**
   * 可选草稿 pack（同 `rules.validate`）：试跑**未保存**的规则修改；脚本仍取自已安装包的
   * 脚本文件（`pack.update` 不写脚本字节），草稿里脚本 sha256 与实际文件不符会报可读错误。
   */
  pack?: unknown;
}

/** 运行时返回的骰面（与 `DiceRollRecord` 同口径）。 */
export interface RulesTestRoll {
  expr: string;
  dice: number[];
  modifier: number;
  total: number;
}

/** 运行时 trace：人话行 + 结构化中间值（只做展示，客户端不重算）。 */
export interface RulesTestTrace {
  lines: string[];
  data: Record<string, unknown>;
}

export interface RulesTestOutcome {
  /** 请求下标（从 0 起）。 */
  index: number;
  kind: RulesTestKind;
  /** 人话标题（如「技能检定：运动 DC 12」）。 */
  label: string;
  /** 本条是否成功（运行时报错 / 钩子报错= false，但仍带可读结果与 trace）。 */
  ok: boolean;
  rolls: RulesTestRoll[];
  trace: RulesTestTrace;
  /** 结构化结果（check = CheckResultData，action = ActionResultData，derived = 派生值表）。 */
  result: Record<string, unknown> | null;
  /** 可读错误（运行时报错 / 脚本钩子抛错或超时）。 */
  error?: { code: string; messageZh: string; hint?: string };
  durationMs: number;
}

export interface RulesTestResult {
  ok: boolean;
  packId: string;
  rulesId: string | null;
  seed: number;
  draft: boolean;
  /** 本次用的样本卡 id。 */
  sampleActorId: string | null;
  /** 样本卡来源：pack（包内卡）/ synthetic（合成卡）。 */
  sampleSource: 'pack' | 'synthetic' | null;
  /** 运行时事件摘要（人话；含 rules/error 与骰面）。 */
  events: string[];
  outcomes: RulesTestOutcome[];
  errors: string[];
  warnings: string[];
  durationMs: number;
}

/** 规则测试台的回数上限（一次请求最多跑 12 条，避免长脚本卡住工坊 RPC）。 */
export const RULES_TEST_LIMITS = {
  maxRequests: 12,
} as const;

/** 工坊 RPC 的资源上限（RPC 请求体 12 MiB 的既有约束内的可用余量）。 */
export const PACK_WORKSHOP_LIMITS = {
  /** `pack.assetPut` / `pack.import` 的 base64 近似字节上限（7.5 MiB）。 */
  maxBase64Bytes: 7.5 * 1024 * 1024,
  /** `pack.update` 的 pack JSON 序列化上限（4 MiB，与 zip 内 pack.json 上限一致）。 */
  maxPackJsonBytes: 4 * 1024 * 1024,
  maxPromptLength: 2000,
  maxAssetIdLength: 128,
} as const;

const PACK_ID_RPC_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ASSET_ID_RPC_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const WORLD_ZONE_ID_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5.-]{0,63}$/;

function isPackId(value: unknown): value is string {
  return typeof value === 'string' && PACK_ID_RPC_PATTERN.test(value);
}

/** `assetId` 与资产清单同口径：`<kind>.<scope>.<slug>`，禁止路径字符。 */
function isPackAssetId(value: unknown): value is string {
  if (typeof value !== 'string' || !ASSET_ID_RPC_PATTERN.test(value)) return false;
  if (value.length > PACK_WORKSHOP_LIMITS.maxAssetIdLength) return false;
  if (value.includes('..') || value.includes('/') || value.includes('\\')) return false;
  return value.split('.').length >= 2;
}

function isPackAssetKindValue(value: unknown): value is PackAssetKind {
  return typeof value === 'string' && (PACK_ASSET_KINDS as readonly string[]).includes(value);
}

function isPackAssetTarget(value: unknown): value is PackAssetTargetId {
  return typeof value === 'string' && (PACK_ASSET_TARGETS as readonly string[]).includes(value);
}

function isMapGenerateStyle(value: unknown): value is MapGenerateStyle {
  return typeof value === 'string' && (MAP_GENERATE_STYLES as readonly string[]).includes(value);
}

function isWorldGenerateStyle(value: unknown): value is WorldGenerateStyle {
  return typeof value === 'string' && (WORLD_GENERATE_STYLES as readonly string[]).includes(value);
}

function isImportStrategy(value: unknown): value is PackImportStrategy {
  return typeof value === 'string' && (PACK_IMPORT_STRATEGIES as readonly string[]).includes(value);
}

/** `map.generate` 参数校验（生成档：cols/rows 4..32、partySize 1..8、seed 0..2^31-1）。 */
export function validateMapGenerate(params: unknown): ValidationResult<MapGenerateParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.prompt)) return fail('prompt 不能为空（写清「这一战在哪、谁在场、什么地形」）');
  if (params.prompt.length > PACK_WORKSHOP_LIMITS.maxPromptLength) {
    return fail(`prompt 过长（最多 ${PACK_WORKSHOP_LIMITS.maxPromptLength} 字）`);
  }
  if (!isMapGenerateStyle(params.style)) {
    return fail(`style 必须是 ${MAP_GENERATE_STYLES.join(' / ')}，收到 ${JSON.stringify(params.style)}`);
  }
  if (params.cols !== undefined && !isBoundedInteger(params.cols, 4, BATTLE_STRUCTURE_LIMITS.maxCols)) {
    return fail(`cols 必须是 4–${BATTLE_STRUCTURE_LIMITS.maxCols} 的整数`);
  }
  if (params.rows !== undefined && !isBoundedInteger(params.rows, 4, BATTLE_STRUCTURE_LIMITS.maxRows)) {
    return fail(`rows 必须是 4–${BATTLE_STRUCTURE_LIMITS.maxRows} 的整数`);
  }
  if (params.partySize !== undefined && !isBoundedInteger(params.partySize, 1, BATTLE_STRUCTURE_LIMITS.maxPartySize)) {
    return fail(`partySize 必须是 1–${BATTLE_STRUCTURE_LIMITS.maxPartySize} 的整数`);
  }
  if (params.seed !== undefined && !isBoundedInteger(params.seed, 0, 2 ** 31 - 1)) {
    return fail('seed 必须是 0–2147483647 的整数');
  }
  if (params.withBackground !== undefined && typeof params.withBackground !== 'boolean') {
    return fail('withBackground 必须是布尔值');
  }
  return { ok: true, value: params as unknown as MapGenerateParams };
}

/** `world.generate` 参数校验（zoneCount 3..8）。 */
export function validateWorldGenerate(params: unknown): ValidationResult<WorldGenerateParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.prompt)) return fail('prompt 不能为空（写清世界/区域的风格与氛围）');
  if (params.prompt.length > PACK_WORKSHOP_LIMITS.maxPromptLength) {
    return fail(`prompt 过长（最多 ${PACK_WORKSHOP_LIMITS.maxPromptLength} 字）`);
  }
  if (
    params.zoneCount !== undefined &&
    !isBoundedInteger(params.zoneCount, WORLD_STRUCTURE_LIMITS.minZones, WORLD_STRUCTURE_LIMITS.maxZones)
  ) {
    return fail(`zoneCount 必须是 ${WORLD_STRUCTURE_LIMITS.minZones}–${WORLD_STRUCTURE_LIMITS.maxZones} 的整数`);
  }
  if (params.style !== undefined && !isWorldGenerateStyle(params.style)) {
    return fail(`style 必须是 ${WORLD_GENERATE_STYLES.join(' / ')}，收到 ${JSON.stringify(params.style)}`);
  }
  if (params.seed !== undefined && !isBoundedInteger(params.seed, 0, 2 ** 31 - 1)) {
    return fail('seed 必须是 0–2147483647 的整数');
  }
  if (params.withBackground !== undefined && typeof params.withBackground !== 'boolean') {
    return fail('withBackground 必须是布尔值');
  }
  return { ok: true, value: params as unknown as WorldGenerateParams };
}

export function validatePackDetail(params: unknown): ValidationResult<PackDetailParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  return { ok: true, value: { packId: params.packId } };
}

export function validatePackUpdate(params: unknown): ValidationResult<PackUpdateParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  if (!isRecord(params.pack)) return fail('pack 必须是对象（完整 pack.json）');
  if (params.pack.packId !== params.packId) {
    return fail(`pack.packId 必须与参数 packId 一致（参数 ${JSON.stringify(params.packId)}，pack ${JSON.stringify(params.pack.packId)}）`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(params.pack);
  } catch {
    return fail('pack 不是可序列化的 JSON 对象');
  }
  if (serialized.length > PACK_WORKSHOP_LIMITS.maxPackJsonBytes) {
    return fail(`pack 过大（序列化后 ${serialized.length} 字节，上限 ${PACK_WORKSHOP_LIMITS.maxPackJsonBytes}）`);
  }
  return { ok: true, value: { packId: params.packId, pack: params.pack } };
}

export function validatePackExport(params: unknown): ValidationResult<PackExportParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  return { ok: true, value: { packId: params.packId } };
}

/** `pack.import` 参数校验：base64 + 冲突策略（近似字节上限见 `PACK_WORKSHOP_LIMITS`）。 */
export function validatePackImport(params: unknown): ValidationResult<PackImportParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isNonEmptyString(params.b64)) return fail('b64 不能为空（应为 .trpgpack 文件字节的 base64）');
  const approximate = approximateBase64Bytes(params.b64);
  if (approximate > PACK_WORKSHOP_LIMITS.maxBase64Bytes) {
    return fail(
      `导入包过大：约 ${(approximate / (1024 * 1024)).toFixed(2)} MB / 上限 ${(
        PACK_WORKSHOP_LIMITS.maxBase64Bytes / (1024 * 1024)
      ).toFixed(1)} MB（RPC 请求体 12 MiB 的限制）`,
    );
  }
  if (params.fileName !== undefined) {
    if (typeof params.fileName !== 'string' || params.fileName.length > 255) {
      return fail('fileName 必须是字符串（最多 255 字符）');
    }
  }
  if (!isImportStrategy(params.strategy)) {
    return fail(`strategy 必须是 ${PACK_IMPORT_STRATEGIES.join(' / ')}，收到 ${JSON.stringify(params.strategy)}`);
  }
  return {
    ok: true,
    value: {
      b64: params.b64,
      strategy: params.strategy,
      ...(typeof params.fileName === 'string' ? { fileName: params.fileName } : {}),
    },
  };
}

/** `pack.assetPut` 参数校验：assetId/kind/base64/meta。 */
export function validatePackAssetPut(params: unknown): ValidationResult<PackAssetPutParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  if (!isPackAssetId(params.assetId)) {
    return fail('assetId 必须是 `<kind>.<scope>.<slug>`（只含字母/数字/_/./-，至少两段）');
  }
  if (!isPackAssetKindValue(params.kind)) {
    return fail(`kind 必须是 ${PACK_ASSET_KINDS.join(' / ')} 之一`);
  }
  if (!isNonEmptyString(params.b64)) return fail('b64 不能为空（应为图片字节的 base64）');
  const approximate = approximateBase64Bytes(params.b64);
  if (approximate > PACK_WORKSHOP_LIMITS.maxBase64Bytes) {
    return fail(
      `图片过大：约 ${(approximate / (1024 * 1024)).toFixed(2)} MB / 上限 ${(
        PACK_WORKSHOP_LIMITS.maxBase64Bytes / (1024 * 1024)
      ).toFixed(1)} MB`,
    );
  }
  let meta: PackAssetPutMeta | undefined;
  if (params.meta !== undefined) {
    if (!isRecord(params.meta)) return fail('meta 必须是对象');
    if (params.meta.target !== undefined && !isPackAssetTarget(params.meta.target)) {
      return fail(`meta.target 必须是 ${PACK_ASSET_TARGETS.join(' / ')} 之一`);
    }
    if (params.meta.style !== undefined) {
      if (typeof params.meta.style !== 'string' || params.meta.style.length > 48) {
        return fail('meta.style 必须是字符串（最多 48 字符）');
      }
    }
    if (params.meta.seed !== undefined && !isBoundedInteger(params.meta.seed, 0, 2 ** 31 - 1)) {
      return fail('meta.seed 必须是 0–2147483647 的整数');
    }
    if (params.meta.prompt !== undefined) {
      if (typeof params.meta.prompt !== 'string' || params.meta.prompt.length > 8000) {
        return fail('meta.prompt 必须是字符串（最多 8000 字符）');
      }
    }
    if (params.meta.rows !== undefined && !isBoundedInteger(params.meta.rows, 1, 8)) {
      return fail('meta.rows 必须是 1–8 的整数');
    }
    if (params.meta.cols !== undefined && !isBoundedInteger(params.meta.cols, 1, 8)) {
      return fail('meta.cols 必须是 1–8 的整数');
    }
    if (params.meta.frameSize !== undefined && !isBoundedInteger(params.meta.frameSize, 16, 256)) {
      return fail('meta.frameSize 必须是 16–256 的整数');
    }
    meta = params.meta as PackAssetPutMeta;
  }
  return {
    ok: true,
    value: {
      packId: params.packId,
      assetId: params.assetId,
      kind: params.kind,
      b64: params.b64,
      ...(meta !== undefined ? { meta } : {}),
    },
  };
}

export function validatePackAssetDelete(params: unknown): ValidationResult<PackAssetDeleteParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  if (!isPackAssetId(params.assetId)) return fail('assetId 必须是 `<kind>.<scope>.<slug>`');
  return { ok: true, value: { packId: params.packId, assetId: params.assetId } };
}

/** `rules.validate` / `rules.test` 共用的可选草稿 pack 校验（不落盘；只做形状与大小检查）。 */
function draftPackOf(value: unknown, packId: string, method: string): { found: boolean; pack?: unknown; error?: string } {
  if (value === undefined) return { found: false };
  if (!isRecord(value)) return { found: true, error: `${method} 的 pack 必须是对象（完整 pack.json 草稿）` };
  if (value.packId !== packId) {
    return {
      found: true,
      error: `${method} 草稿的 pack.packId 必须与参数 packId 一致（参数 ${JSON.stringify(packId)}，草稿 ${JSON.stringify(value.packId)}）`,
    };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { found: true, error: `${method} 草稿 pack 不是可序列化的 JSON 对象` };
  }
  if (serialized.length > PACK_WORKSHOP_LIMITS.maxPackJsonBytes) {
    return {
      found: true,
      error: `${method} 草稿 pack 过大（序列化后 ${serialized.length} 字节，上限 ${PACK_WORKSHOP_LIMITS.maxPackJsonBytes}）`,
    };
  }
  return { found: true, pack: value };
}

export function validateRulesValidate(params: unknown): ValidationResult<RulesValidateParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  const draft = draftPackOf(params.pack, params.packId, 'rules.validate');
  if (draft.error !== undefined) return fail(draft.error);
  return {
    ok: true,
    value: { packId: params.packId, ...(draft.found ? { pack: draft.pack } : {}) },
  };
}

function isRulesTestKind(value: unknown): value is RulesTestKind {
  return typeof value === 'string' && (RULES_TEST_KINDS as readonly string[]).includes(value);
}

function isCheckMode(value: unknown): value is NonNullable<RulesTestRequest['mode']> {
  return value === 'normal' || value === 'advantage' || value === 'disadvantage';
}

/** `rules.test` 参数校验：packId + requests[1..12]（kind/编号/DC/模式）+ 可选草稿与 seed。 */
export function validateRulesTest(params: unknown): ValidationResult<RulesTestParams> {
  if (!isRecord(params)) return fail('缺少参数');
  if (!isPackId(params.packId)) return fail('packId 必须是小写 slug（字母/数字/_/-，最多 64 字符）');
  if (!Array.isArray(params.requests)) return fail('requests 必须是数组（1–12 条 {kind, ...}）');
  if (params.requests.length === 0) return fail('requests 不能为空：至少 1 条（kind=check/action/derived）');
  if (params.requests.length > RULES_TEST_LIMITS.maxRequests) {
    return fail(`requests 过多（${params.requests.length} 条，上限 ${RULES_TEST_LIMITS.maxRequests}）`);
  }
  const requests: RulesTestRequest[] = [];
  for (let index = 0; index < params.requests.length; index += 1) {
    const raw = params.requests[index];
    if (!isRecord(raw)) return fail(`requests[${index}] 必须是对象`);
    if (!isRulesTestKind(raw.kind)) {
      return fail(`requests[${index}].kind 必须是 ${RULES_TEST_KINDS.join(' / ')}，收到 ${JSON.stringify(raw.kind)}`);
    }
    if (!isOptionalShortId(raw.actorCardId)) return fail(`requests[${index}].actorCardId 必须是字符串（最多 64 字符）`);
    if (!isOptionalShortId(raw.targetId)) return fail(`requests[${index}].targetId 必须是字符串（最多 64 字符）`);
    if (raw.kind === 'action') {
      if (!isNonEmptyString(raw.actionId)) return fail(`requests[${index}]（kind=action）需要 actionId`);
      if (raw.actionId.length > 128) return fail(`requests[${index}].actionId 过长（最多 128 字符）`);
    } else if (raw.actionId !== undefined && !isOptionalShortId(raw.actionId, 128)) {
      return fail(`requests[${index}].actionId 必须是字符串（最多 128 字符）`);
    }
    if (raw.skillId !== undefined && !isOptionalShortId(raw.skillId, 128)) {
      return fail(`requests[${index}].skillId 必须是字符串（最多 128 字符）`);
    }
    if (raw.attributeId !== undefined && !isOptionalShortId(raw.attributeId, 128)) {
      return fail(`requests[${index}].attributeId 必须是字符串（最多 128 字符）`);
    }
    if (raw.dc !== undefined && !isBoundedInteger(raw.dc, 0, 60)) return fail(`requests[${index}].dc 必须是 0–60 的整数`);
    if (raw.mode !== undefined && !isCheckMode(raw.mode)) {
      return fail(`requests[${index}].mode 必须是 normal / advantage / disadvantage`);
    }
    if (raw.mods !== undefined && !isBoundedInteger(raw.mods, -100, 100)) {
      return fail(`requests[${index}].mods 必须是 -100–100 的整数`);
    }
    requests.push({
      kind: raw.kind,
      ...(typeof raw.actorCardId === 'string' ? { actorCardId: raw.actorCardId } : {}),
      ...(typeof raw.targetId === 'string' ? { targetId: raw.targetId } : {}),
      ...(typeof raw.actionId === 'string' ? { actionId: raw.actionId } : {}),
      ...(typeof raw.skillId === 'string' ? { skillId: raw.skillId } : {}),
      ...(typeof raw.attributeId === 'string' ? { attributeId: raw.attributeId } : {}),
      ...(typeof raw.dc === 'number' ? { dc: raw.dc } : {}),
      ...(raw.mode !== undefined ? { mode: raw.mode as NonNullable<RulesTestRequest['mode']> } : {}),
      ...(typeof raw.mods === 'number' ? { mods: raw.mods } : {}),
    });
  }
  if (params.seed !== undefined && !isBoundedInteger(params.seed, 0, 2 ** 31 - 1)) {
    return fail('seed 必须是 0–2147483647 的整数');
  }
  const draft = draftPackOf(params.pack, params.packId, 'rules.test');
  if (draft.error !== undefined) return fail(draft.error);
  return {
    ok: true,
    value: {
      packId: params.packId,
      requests,
      ...(typeof params.seed === 'number' ? { seed: params.seed } : {}),
      ...(draft.found ? { pack: draft.pack } : {}),
    },
  };
}

/** 世界地图区域 id 是否合法（与规则包 `space.zones[].zoneId` 同规则）。 */
export function isWorldZoneId(value: unknown): value is string {
  return typeof value === 'string' && WORLD_ZONE_ID_PATTERN.test(value);
}
