/**
 * 房间状态机（M2）：账号、玩家席、事件日志、可见性投影。
 *
 * 这一层不碰 HTTP/SSE，所以可以被单测直接驱动；HTTP 只是它的薄适配层。
 * 关键安全性质（对应 DESIGN §4 的五道锁）：
 * - token → principal 由服务端解析，客户端不能自称身份；
 * - 事件在「广播前」按 principal 投影，私密信息不会发到别人手上；
 * - GM（房主）看到全部事件，包括私骰与悄悄话；
 * - 只有房主能 kick/lock；邀请码只回给房主。
 *
 * M9.4：房间可挂一个规则运行时（`RoomRulesRoom`，内容包带 `rules` 段时启用）。
 * 协议层（room-http）只拿到投影 DTO 与中文错误，拿不到 RT 对象；host 侧 GM 编排
 * 走 `runtimeOf(roomId)`。无 rules 的房间保持 M2–M8 的旧行为。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createRng,
  deriveRollSeed,
  rollDice,
  rollSkillCheck,
  SKILL_NAME,
  validateCharacterCard,
  type CharacterCard,
  type Rng,
  type SkillId,
} from '@dsh-trpg/engine';
import {
  DEFAULT_CONTENT_MODULE_ID,
  DEFAULT_CONTENT_PACK_ID,
  PROTOCOL_VERSION,
  validateCombatEnd,
  validateCombatEndTurn,
  validateCombatMove,
  validateCombatRollCheck,
  validateCombatStart,
  validateCombatUseAction,
  validateCombatView,
  validateCreateRoom,
  validateCharacterAssetRefs,
  validateJoin,
  validateRoll,
  validateSay,
  validateSheetEquip,
  validateSheetGet,
  validateSheetUnequip,
  validateSheetUseItem,
  validateWorldMapGet,
  type ActionOutcomeView,
  type AlertPayload,
  type CharacterAssetRefInput,
  type CombatEndResult,
  type CombatEndTurnResult,
  type CombatMoveResult,
  type CombatRollCheckResult,
  type CombatStartResult,
  type CombatUpdatePayload,
  type CombatUseActionResult,
  type CombatView,
  type CombatViewResult,
  type CreateRoomParams,
  type CreateRoomResult,
  type DicePayload,
  type EventTarget,
  type GameEvent,
  type GMMode,
  type JoinRoomParams,
  type JoinRoomResult,
  type KickParams,
  type LockParams,
  type NarrationPayload,
  type PlayerId,
  type RoomAssetView,
  type RoomListResult,
  type RoomPhase,
  type RoomRulesView,
  type RoomSceneSummary,
  type RoomStateResult,
  type RoomView,
  type RollParams,
  type RollResult,
  type RulesErrorPayload,
  type SayParams,
  type SayResult,
  type ScenePayload,
  type AwardPayload,
  type Seq,
  type SheetCommandResult,
  type SheetGetResult,
  type SheetIdentityMediaView,
  type SheetUpdatePayload,
  type SheetView,
  type WorldMapGetResult,
} from '@dsh-trpg/protocol';
import type { ActorView, EquipmentInstanceDef, RuleRuntime, RuntimeEvent } from '@dsh-trpg/rules';
import { RoomError, roomErrorFromRule } from './errors.ts';
import {
  RoomRulesRoom,
  deriveRulesSeed,
  type RoomRulesInput,
  type RoomRulesResolver,
} from './rules-host.ts';
import {
  actionOutcomeOf,
  buildCombatMoveResult,
  buildCombatStartResult,
  buildCombatView,
  buildInventoryView,
  buildSheetResult,
  buildSheetView,
  buildWorldMapView,
  checkViewOf,
  findItemDef,
  planEquip,
  planUnequip,
  synthesizeEnemyCard,
  type RuleViewOptions,
} from './rules-view.ts';

export { RoomError, roomErrorFromRule } from './errors.ts';
export type {
  RoomRulePosition,
  RoomRuleScript,
  RoomRulesInput,
  RoomRulesResolver,
  RoomRuleSeatInput,
  RoomRuleSeatResult,
} from './rules-host.ts';
export { deriveRulesSeed, hashRules, RoomRulesRoom, toCardInstance } from './rules-host.ts';


const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;

/** 规则运行时事件 → SSE 的映射（turn/damage 等战斗相关事件统一推 `combat/update`）。 */
const COMBAT_BROADCAST_EVENTS: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'round/start',
  'round/end',
  'round/limit',
  'combat/start',
  'combat/end',
  'action/before',
  'action/after',
  'damage/after',
  'move',
  'death',
  'status/tick',
  'time/advance',
  'zone/enter',
  'zone/leave',
  'loot',
  'table/roll',
  'level/up',
]);

/** 规则包不可用/启动失败时记的降级信息（写进 RoomView.rules 与快照）。 */
interface RoomRulesDown {
  view: RoomRulesView;
  rulesHash?: string;
  warnings: string[];
}

/** 房间引用的内容解析结果（由 host 的 pack registry 实现；rooms 包因此不依赖 @dsh-trpg/content）。 */
export interface RoomContentModule {
  packId: string;
  /** 包版本（semver），续团时用于检测内容漂移。 */
  packVersion: string;
  packName?: string;
  moduleId: string;
  moduleTitle: string;
  /** 内容指纹：sha256(规范化 pack.json)，用于检测「同版本内容被替换」。 */
  contentHash: string;
  /** 模组场景公开摘要（只含 sceneId 与公开标题）。 */
  scenes: RoomSceneSummary[];
}

/**
 * 内容解析器：host 启动时注入（内置包 + 数据目录 .trpgpack 的注册表）。
 * 不注入时房间按缺省引用记账、不校验存在性（向后兼容旧调用/单测）。
 */
export interface RoomContentResolver {
  /** 缺省包 id（旧客户端/旧快照的兜底，通常是内置包）。 */
  readonly defaultPackId: string;
  /** 解析包内模组；moduleId 缺省用该包的 defaultModuleId。找不到返回 undefined。 */
  resolveModule(packId: string, moduleId?: string): RoomContentModule | undefined;
  /** 包是否已安装（用于区分「包不存在」与「模组不存在」的可读错误）。 */
  hasPack?(packId: string): boolean;
}

/** 房间记录里的内容引用 + 派生场景快照（只存引用，不复制整包内容）。 */
export interface RoomContentState {
  packId: string;
  packVersion: string;
  moduleId: string;
  contentHash: string;
  packName?: string;
  moduleTitle?: string;
  scenes: RoomSceneSummary[];
  /** true = host 上找不到该包/模组（或版本已变），房间以降级方式续团。 */
  degraded?: boolean;
}

/** 存档里的内容引用（字段与 `RoomContentState` 一致，独立声明避免存档受运行时字段影响）。 */
export interface RoomSnapshotContent {
  packId: string;
  packVersion: string;
  moduleId: string;
  contentHash: string;
  packName?: string;
  moduleTitle?: string;
  scenes?: RoomSceneSummary[];
  degraded?: boolean;
}

/** 存档结构（JSON 可序列化；v1）。 */
export interface RoomSnapshot {
  schemaVersion: 1;
  savedAt: number;
  room: {
    id: string;
    title: string;
    gmMode: GMMode;
    phase: RoomPhase;
    inviteCode: string;
    hostToken: string;
    locked: boolean;
    seed: number;
    rollIndex: number;
    seq: Seq;
    /** 绑定为牌桌的 DSH 会话 id。 */
    sessionId?: string;
    createdAt: number;
    scene?: { sceneId: string; title?: string };
    /** 内容引用 + 派生场景快照（M8.2 起；旧快照缺省视为内置包默认模组）。 */
    content?: RoomSnapshotContent;
    /**
     * 规则引用 + 运行态快照（M9.4）：房间启用规则运行时才有。
     * - `rulesId/rulesVersion/rulesHash/rulesSeed` 记复现环境（种子写死，续团不重新派发）；
     * - `ruleState` = `RuleRuntime.exportState()`（纯 JSON），恢复时 `importState`；
     * - `ruleBags` = host 侧背包（卸下的物品实例，key = actorId）。
     */
    rulesId?: string;
    rulesVersion?: string;
    rulesHash?: string;
    rulesSeed?: number;
    ruleState?: unknown;
    ruleBags?: Record<string, EquipmentInstanceDef[]>;
    players: Array<{
      id: string;
      name: string;
      token: string;
      seat: 'gm' | 'player';
      character?: CharacterCard;
      /** 座位上的规则卡原始数据（M9.4；旧卡或新卡实例）。 */
      ruleCard?: unknown;
      /** 落座时上传的展示资产引用（M9.5d；只存引用/URL，不复制字节）。 */
      characterAssets?: CharacterAssetRefInput[];
      joinedAt: number;
    }>;
    events: GameEvent[];
  };
}

export type Principal =
  | { kind: 'host'; roomId: string }
  | { kind: 'player'; roomId: string; playerId: PlayerId };

interface PlayerRecord {
  id: PlayerId;
  name: string;
  token: string;
  seat: 'gm' | 'player';
  character?: CharacterCard;
  /**
   * 座位上的规则卡原始数据（M9.4）：旧 engine 卡或新卡实例（`trpg.card/1`）。
   * 房间层只用 `character` 做旧视图/GM 提示；规则运行时按 `ruleCard` 实例化。
   */
  ruleCard?: unknown;
  /** 落座时上传的展示资产引用（M9.5d；`assets.upload` 返回的 `{kind,variant?,sha256,url}`）。 */
  characterAssets?: CharacterAssetRefInput[];
  joinedAt: number;
  connections: number;
}

interface Listener {
  principal: Principal;
  notify: (event: GameEvent) => void;
}

interface RoomRecord {
  id: string;
  title: string;
  gmMode: GMMode;
  phase: RoomPhase;
  inviteCode: string;
  hostToken: string;
  locked: boolean;
  seed: number;
  rollIndex: number;
  seq: Seq;
  events: GameEvent[];
  players: Map<PlayerId, PlayerRecord>;
  listeners: Set<Listener>;
  createdAt: number;
  scene?: { sceneId: string; title?: string };
  /** 内容引用 + 派生场景快照（host 内容权威，房间只存引用）。 */
  content: RoomContentState;
  /** 绑定为牌桌的 DSH 会话 id（原生对话即牌桌）。 */
  sessionId?: string;
}

export interface PlayerActionInfo {
  roomId: string;
  playerId: PlayerId;
  playerName: string;
  characterName?: string;
  text: string;
  private: boolean;
}

export interface RoomServiceOptions {
  /** 房间数上限（防止误开一堆）。 */
  maxRooms?: number;
  /** 事件日志上限（SSE 补发用）；超出后丢弃最旧事件。 */
  maxEvents?: number;
  now?: () => number;
  /** 玩家提交行动/发言时回调（AI GM 编排用）。 */
  onPlayerAction?: (info: PlayerActionInfo) => void;
  /** 房间创建完成回调（启动 AI GM 运行时用）；建房时带上的会话 id 一并回调。 */
  onRoomCreated?: (roomId: string, sessionId?: string) => void;
  /** 房间关闭回调（释放会话绑定等资源）。 */
  onRoomClosed?: (roomId: string) => void;
  /** 房间状态有任何变更（用于存档 debounce）。 */
  onChanged?: () => void;
  /** 内容解析器（host 注入 pack registry）；缺省时按内置包缺省引用记账、不校验存在性。 */
  content?: RoomContentResolver;
  /**
   * 规则解析器（host 注入 pack registry）：内容包带 `rules` 段时房间创建规则运行时。
   * 缺省 = 不启用规则（旧行为：卡面/战斗命令返回中文错误，其余功能照常）。
   */
  rules?: RoomRulesResolver;
  /**
   * 规则种子派生盐（同一次 host 启动内固定；缺省每次构造随机）。
   * 房间种子 = `deriveRulesSeed(roomId, seedSalt)`，派生结果写进快照，续团按快照恢复。
   */
  seedSalt?: string;
}

function randomToken(): string {
  return randomBytes(24).toString('base64url');
}

function randomInviteCode(): string {
  const bytes = randomBytes(6);
  let code = '';
  for (let index = 0; index < 6; index += 1) {
    code += INVITE_ALPHABET[(bytes[index] as number) % INVITE_ALPHABET.length];
  }
  return code;
}

function visibleTo(principal: Principal, event: GameEvent): boolean {
  if (principal.kind === 'host') return true;
  return event.to === 'all' || event.to === principal.playerId;
}

export class RoomService {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly tokens = new Map<string, Principal>();
  private readonly maxRooms: number;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly onPlayerAction?: (info: PlayerActionInfo) => void;
  private readonly onRoomCreated?: (roomId: string, sessionId?: string) => void;
  private readonly onRoomClosed?: (roomId: string) => void;
  private readonly onChanged?: () => void;
  private readonly content?: RoomContentResolver;
  private readonly rulesResolver?: RoomRulesResolver;
  private readonly seedSalt: string;
  /** 房间 → 规则运行时容器（内容包带 rules 时才建）。 */
  private readonly ruleRooms = new Map<string, RoomRulesRoom>();
  /** 房间 → 规则不可用/降级信息（规则包缺失、脚本加载失败、快照不兼容）。 */
  private readonly ruleDown = new Map<string, RoomRulesDown>();

  constructor(options: RoomServiceOptions = {}) {
    this.maxRooms = options.maxRooms ?? 8;
    this.maxEvents = options.maxEvents ?? 5000;
    this.now = options.now ?? Date.now;
    this.onPlayerAction = options.onPlayerAction;
    this.onRoomCreated = options.onRoomCreated;
    this.onRoomClosed = options.onRoomClosed;
    this.onChanged = options.onChanged;
    this.content = options.content;
    this.rulesResolver = options.rules;
    this.seedSalt = options.seedSalt ?? randomBytes(8).toString('hex');
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  createRoom(rawParams: unknown): CreateRoomResult {
    const params = this.parse(validateCreateRoom(rawParams));
    if (this.rooms.size >= this.maxRooms) {
      throw new RoomError('conflict', '房间数已达上限，请先关闭一个房间');
    }
    const content = this.resolveContentForCreate(params);
    const room: RoomRecord = {
      id: randomUUID(),
      title: params.title,
      gmMode: params.gmMode,
      ...(typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? { sessionId: params.sessionId.trim() }
        : {}),
      content,
      phase: 'lobby',
      inviteCode: this.uniqueInviteCode(),
      hostToken: randomToken(),
      locked: false,
      seed: randomBytes(4).readUInt32LE(0),
      rollIndex: 0,
      seq: 0,
      events: [],
      players: new Map(),
      listeners: new Set(),
      createdAt: this.now(),
    };
    this.rooms.set(room.id, room);
    this.tokens.set(room.hostToken, { kind: 'host', roomId: room.id });
    // 内容包带 rules 段 → 建规则运行时（失败只降级，不卡建房）；先于首帧 room 事件，视图里就带 rules。
    this.createRulesForRoom(room);
    const event = this.emit(room, 'room', 'all', this.publicView(room));
    void event;
    if (content.degraded) {
      this.emit(room, 'alert', 'all', {
        level: 'warning',
        text: '内容包不可用，房间已按降级内容开局：GM 提示会回退到内置内容包；导入对应 .trpgpack 后可重扫内容包。',
      } satisfies AlertPayload);
    }
    try {
      this.onRoomCreated?.(room.id, room.sessionId);
    } catch {
      /* 房间创建回调失败不影响建房 */
    }
    return { room: this.viewFor(room, { kind: 'host', roomId: room.id }), hostToken: room.hostToken, inviteCode: room.inviteCode };
  }

  /** 房主页面（loopback）重新拿回自己的 host token。 */
  hostSession(roomId: string): { hostToken: string; room: RoomView } {
    const room = this.requireRoom(roomId);
    return { hostToken: room.hostToken, room: this.viewFor(room, { kind: 'host', roomId: room.id }) };
  }

  /**
   * 把房间绑定到（或解绑）一个 DSH 会话：绑定后这就是「原生对话即牌桌」的会话。
   * @param roomId - 房间 id。
   * @param sessionId - 会话 id；null/空串解绑。
   * @returns 更新后的房间视图（host 视角）。
   */
  bindSession(roomId: string, sessionId: string | null | undefined): RoomView {
    const room = this.requireRoom(roomId);
    const next = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
    if (next) room.sessionId = next;
    else delete room.sessionId;
    this.emit(room, 'room', 'all', this.publicView(room));
    return this.viewFor(room, { kind: 'host', roomId: room.id });
  }

  /** 房间当前绑定的会话 id（未绑定返回 undefined）。 */
  sessionOf(roomId: string): string | undefined {
    return this.requireRoom(roomId).sessionId;
  }

  join(rawParams: unknown): JoinRoomResult {
    const params = this.parse(validateJoin(rawParams));
    const room = this.findByInvite(params.inviteCode);
    if (room.locked) throw new RoomError('room-locked', '房间已锁定，暂时不能加入');
    if (room.players.size >= MAX_PLAYERS) throw new RoomError('conflict', '玩家席已满');

    const player: PlayerRecord = {
      id: randomUUID(),
      name: params.playerName.trim(),
      token: randomToken(),
      seat: 'player',
      joinedAt: this.now(),
      connections: 0,
    };
    if (params.characterCard !== undefined) {
      const seated = this.parseSeatCard(params.characterCard);
      if (seated.character !== undefined) player.character = seated.character;
      player.ruleCard = seated.ruleCard;
    }
    room.players.set(player.id, player);
    this.tokens.set(player.token, { kind: 'player', roomId: room.id, playerId: player.id });
    if (player.ruleCard !== undefined) this.attachPlayerToRules(room, player);
    this.emit(room, 'alert', 'all', { level: 'info', text: `${player.name} 加入了房间` } satisfies AlertPayload);
    this.emit(room, 'room', 'all', this.publicView(room));
    return {
      room: this.viewFor(room, { kind: 'player', roomId: room.id, playerId: player.id }),
      playerId: player.id,
      playerToken: player.token,
    };
  }

  /** token → principal；无效 token 抛 unauthorized。 */
  login(token: string | undefined): Principal {
    if (!token) throw new RoomError('unauthorized', '缺少访问令牌');
    const principal = this.tokens.get(token);
    if (!principal) throw new RoomError('unauthorized', '令牌无效或已失效');
    const room = this.requireRoom(principal.roomId);
    if (principal.kind === 'player' && !room.players.has(principal.playerId)) {
      throw new RoomError('unauthorized', '你已被移出房间');
    }
    return principal;
  }

  leave(principal: Principal): { ok: true } {
    const room = this.requireRoom(principal.roomId);
    if (principal.kind === 'host') {
      // 房主断开连接不等于关房；在线状态由 SSE 连接维护。
      return { ok: true };
    }
    const player = room.players.get(principal.playerId);
    if (!player) return { ok: true };
    room.players.delete(player.id);
    this.tokens.delete(player.token);
    this.detachPlayerFromRules(room, player);
    this.emit(room, 'alert', 'all', { level: 'info', text: `${player.name} 离开了房间` } satisfies AlertPayload);
    this.emit(room, 'room', 'all', this.publicView(room));
    return { ok: true };
  }

  kick(principal: Principal, rawParams: unknown): RoomStateResult {
    this.requireHost(principal);
    const room = this.requireRoom(principal.roomId);
    const params = rawParams as KickParams;
    if (typeof params?.playerId !== 'string') throw new RoomError('bad-request', '缺少 playerId');
    const player = room.players.get(params.playerId);
    if (!player) throw new RoomError('not-found', '找不到该玩家');
    room.players.delete(player.id);
    this.tokens.delete(player.token);
    this.detachPlayerFromRules(room, player);
    this.emit(room, 'alert', 'gm', { level: 'info', text: `房主移除了 ${player.name}` } satisfies AlertPayload);
    this.emit(room, 'room', 'all', this.publicView(room));
    // 被踢玩家的连接收到最后一帧后关闭。
    this.closeListenersOf(room, player.id, '你已被房主移出房间');
    return { room: this.viewFor(room, principal) };
  }

  lock(principal: Principal, rawParams: unknown): RoomStateResult {
    this.requireHost(principal);
    const room = this.requireRoom(principal.roomId);
    const params = rawParams as LockParams;
    if (typeof params?.locked !== 'boolean') throw new RoomError('bad-request', '缺少 locked');
    room.locked = params.locked;
    this.emit(room, 'alert', 'all', {
      level: 'info',
      text: params.locked ? '房主锁定了房间' : '房主解锁了房间',
    } satisfies AlertPayload);
    this.emit(room, 'room', 'all', this.publicView(room));
    return { room: this.viewFor(room, principal) };
  }

  state(principal: Principal): RoomStateResult {
    const room = this.requireRoom(principal.roomId);
    return { room: this.viewFor(room, principal) };
  }

  list(): RoomListResult {
    return {
      rooms: [...this.rooms.values()].map((room) => ({
        roomId: room.id,
        title: room.title,
        phase: room.phase,
        gmMode: room.gmMode,
        players: room.players.size,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 席位与内容
  // -------------------------------------------------------------------------

  seat(principal: Principal, rawParams: unknown): RoomStateResult {
    const room = this.requireRoom(principal.roomId);
    const params = rawParams as { characterCard?: unknown; characterAssets?: unknown };
    if (!params || params.characterCard === undefined) throw new RoomError('bad-request', '缺少角色卡');
    const seated = this.parseSeatCard(params.characterCard);
    // M9.5d：落座可带展示资产引用（只存引用/URL，不复制字节；无效引用按 bad-request 拒绝）。
    const assetRefs = params.characterAssets !== undefined
      ? this.parse(validateCharacterAssetRefs(params.characterAssets))
      : undefined;
    const cardName = seated.character?.identity.name
      ?? readRuleCardName(seated.ruleCard)
      ?? '未命名角色';
    if (principal.kind === 'player') {
      const player = room.players.get(principal.playerId);
      if (!player) throw new RoomError('unauthorized', '你不在这个房间');
      if (seated.character !== undefined) player.character = seated.character;
      player.ruleCard = seated.ruleCard;
      player.seat = 'player';
      this.applyCharacterAssets(player, assetRefs);
      this.attachPlayerToRules(room, player);
      this.emit(room, 'alert', 'all', {
        level: 'info',
        text: `${player.name} 落座：${cardName}`,
      } satisfies AlertPayload);
    } else {
      // 房主落座 = 以 GM 身份占一个席位（AI GM 模式下房主也可以当玩家，M3 再细化）
      const hostPlayer: PlayerRecord = {
        id: 'host',
        name: '房主',
        token: room.hostToken,
        seat: 'gm',
        ...(seated.character !== undefined ? { character: seated.character } : {}),
        ruleCard: seated.ruleCard,
        joinedAt: this.now(),
        connections: 1,
      };
      this.applyCharacterAssets(hostPlayer, assetRefs);
      room.players.set('host', hostPlayer);
      this.attachPlayerToRules(room, hostPlayer);
      this.emit(room, 'alert', 'all', {
        level: 'info',
        text: `房主落座：${cardName}`,
      } satisfies AlertPayload);
    }
    this.emit(room, 'room', 'all', this.publicView(room));
    return { room: this.viewFor(room, principal) };
  }

  /**
   * 写入/清除座位的展示资产引用（M9.5d）。
   * `undefined` = 本次落座没带资产，保留既有引用（断线重连不重复上传）；空数组 = 显式清空。
   */
  private applyCharacterAssets(player: PlayerRecord, refs: CharacterAssetRefInput[] | undefined): void {
    if (refs === undefined) return;
    if (refs.length === 0) {
      delete player.characterAssets;
      return;
    }
    player.characterAssets = refs.map((ref) => ({ ...ref }));
  }

  roll(principal: Principal, rawParams: unknown): RollResult {
    const params = this.parse(validateRoll(rawParams));
    const room = this.requireRoom(principal.roomId);
    const player = principal.kind === 'player' ? room.players.get(principal.playerId) : undefined;

    room.rollIndex += 1;
    const rng: Rng = createRng(deriveRollSeed(room.seed, room.rollIndex));
    let rolled;
    try {
      rolled = rollDice(params.expression, rng);
    } catch (error) {
      throw new RoomError('invalid-expression', error instanceof Error ? error.message : '骰子表达式非法');
    }

    const isPrivate = params.private === true && principal.kind === 'player';
    const payload: DicePayload = {
      expression: rolled.expression,
      dice: rolled.dice,
      modifier: rolled.modifier,
      total: rolled.total,
      label: params.label,
      playerId: principal.kind === 'player' ? principal.playerId : 'host',
      rollerName: player ? player.name : 'GM',
      private: isPrivate,
    };
    const target: EventTarget = isPrivate ? (principal.playerId as string) : 'all';
    const event = this.emit(room, 'dice', target, payload);
    return { event };
  }

  say(principal: Principal, rawParams: unknown): SayResult {
    const params = this.parse(validateSay(rawParams));
    const room = this.requireRoom(principal.roomId);
    if (principal.kind === 'player') {
      const player = room.players.get(principal.playerId);
      if (!player) throw new RoomError('unauthorized', '你不在这个房间');
      const payload: NarrationPayload = {
        speaker: 'player',
        speakerName: player.name,
        playerId: player.id,
        text: params.text.trim(),
      };
      const target: EventTarget = params.private ? 'gm' : 'all';
      const event = this.emit(room, 'narration', target, payload);
      try {
        this.onPlayerAction?.({
          roomId: room.id,
          playerId: player.id,
          playerName: player.name,
          characterName: player.character?.identity.name ?? readRuleCardName(player.ruleCard),
          text: payload.text,
          private: params.private === true,
        });
      } catch {
        /* GM 回调失败不影响玩家动作落库 */
      }
      return { event };
    }
    const hostPlayer = room.players.get('host');
    const payload: NarrationPayload = {
      speaker: 'gm',
      speakerName: hostPlayer?.character?.identity.name ? `GM·${hostPlayer.character.identity.name}` : 'GM',
      text: params.text.trim(),
    };
    const target: EventTarget = params.private ? 'gm' : 'all';
    return { event: this.emit(room, 'narration', target, payload) };
  }

  // -------------------------------------------------------------------------
  // GM 编排面（内部 API：由受信任的 GM 运行时调用，不走 token 校验）
  // -------------------------------------------------------------------------

  gmExists(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  gmView(roomId: string): RoomView {
    return this.publicView(this.requireRoom(roomId));
  }

  /**
   * 房间当前的内容引用（GM 运行时按它到 pack registry 解析模组/世界书）。
   * 返回副本，含派生场景与降级标记。
   */
  gmContent(roomId: string): RoomContentState {
    const room = this.requireRoom(roomId);
    return cloneContentState(room.content);
  }

  /**
   * 内容包重扫后调用：对仍处于降级状态的房间重新解析内容引用。
   * 解析成功的房间清除 degraded 并广播提示；返回恢复数量。
   */
  revalidateContent(): { recovered: number } {
    const resolver = this.content;
    if (!resolver) return { recovered: 0 };
    let recovered = 0;
    for (const room of this.rooms.values()) {
      if (!room.content.degraded) continue;
      const resolved = resolver.resolveModule(room.content.packId, room.content.moduleId);
      if (!resolved) continue;
      room.content = contentStateFromModule(resolved);
      recovered += 1;
      // 之前因规则包/脚本不可用而降级的房间：内容恢复后尝试重新拉起规则运行时（失败仍降级）。
      if (!this.ruleRooms.has(room.id) && this.ruleDown.has(room.id)) {
        this.ruleDown.delete(room.id);
        this.createRulesForRoom(room);
        const rr = this.ruleRooms.get(room.id);
        if (rr !== undefined) {
          const players = [...room.players.values()].map((player) => ({
            playerId: player.id,
            name: player.name,
            ...(player.ruleCard !== undefined
              ? { card: player.ruleCard }
              : player.character !== undefined
                ? { card: player.character }
                : {}),
          }));
          rr.noteWarnings(rr.syncPlayers(players));
        }
      }
      this.emit(room, 'alert', 'all', {
        level: 'info',
        text: `内容包「${resolved.packName ?? resolved.packId}」已就绪，房间内容引用重新生效。`,
      } satisfies AlertPayload);
      this.emit(room, 'room', 'all', this.publicView(room));
    }
    return { recovered };
  }

  gmModeOf(roomId: string): GMMode {
    return this.requireRoom(roomId).gmMode;
  }

  gmPhase(roomId: string): RoomPhase {
    return this.requireRoom(roomId).phase;
  }

  /** GM 视角的玩家席（含完整角色卡，只给服务端 GM 运行时/工具用，不广播）。 */
  gmParty(roomId: string): Array<{ playerId: PlayerId; name: string; seat: 'gm' | 'player'; character?: CharacterCard }> {
    const room = this.requireRoom(roomId);
    return [...room.players.values()].map((player) => ({
      playerId: player.id,
      name: player.name,
      seat: player.seat,
      character: player.character ? structuredClone(player.character) : undefined,
    }));
  }

  /** 最近事件（含私密，GM 可见全部），用于组装 GM 上下文。 */
  gmRecentEvents(roomId: string, limit = 20): GameEvent[] {
    const room = this.requireRoom(roomId);
    return room.events.slice(-limit).map((event) => ({ ...event }));
  }

  gmNarrate(roomId: string, text: string, options: { to?: EventTarget; speakerName?: string } = {}): GameEvent<'narration', NarrationPayload> {
    const room = this.requireRoom(roomId);
    const payload: NarrationPayload = {
      speaker: 'gm',
      speakerName: options.speakerName ?? 'GM',
      text: text.trim(),
    };
    return this.emit(room, 'narration', options.to ?? 'all', payload);
  }

  gmSecret(roomId: string, playerId: PlayerId, text: string): GameEvent<'narration', NarrationPayload> {
    const room = this.requireRoom(roomId);
    if (!room.players.has(playerId)) throw new RoomError('not-found', '找不到该玩家');
    return this.emit(room, 'narration', playerId, {
      speaker: 'gm',
      speakerName: 'GM（私密）',
      text: text.trim(),
    } satisfies NarrationPayload);
  }

  gmAlert(roomId: string, text: string, level: AlertPayload['level'] = 'info'): GameEvent<'alert', AlertPayload> {
    const room = this.requireRoom(roomId);
    return this.emit(room, 'alert', 'all', { level, text } satisfies AlertPayload);
  }

  /** 房间种子（战斗运行时用于可复现掷骰）。 */
  gmRoomSeed(roomId: string): number {
    return this.requireRoom(roomId).seed;
  }

  /** 广播战斗面板状态（先攻/HP/当前行动者）。 */
  gmCombat(
    roomId: string,
    view: {
      round: number;
      activeId: string;
      activeName: string;
      order: Array<{ id: string; name: string; kind: 'pc' | 'monster'; hp: number; maxHp: number; ac: number; downed: boolean; dead: boolean }>;
    },
    note?: string,
  ): GameEvent<'combat', { view: typeof view; note?: string }> {
    const room = this.requireRoom(roomId);
    return this.emit(room, 'combat', 'all', { view, note });
  }

  /** 真人 GM：推进场景，广播 scene 事件并更新房间视图。 */
  gmScene(roomId: string, sceneId: string, title?: string): GameEvent<'scene', ScenePayload> {
    const room = this.requireRoom(roomId);
    room.scene = { sceneId, ...(title ? { title } : {}) };
    const event = this.emit(room, 'scene', 'all', { sceneId, title, by: 'host' } satisfies ScenePayload);
    this.emit(room, 'room', 'all', this.publicView(room));
    return event;
  }

  /** 真人 GM：把经验/物品奖励私发（并留一条公开提示）给某位玩家。 */
  gmAward(
    roomId: string,
    playerId: PlayerId,
    award: { xp: number; items?: string[]; note?: string },
  ): GameEvent<'award', AwardPayload> {
    const room = this.requireRoom(roomId);
    const player = room.players.get(playerId);
    if (!player) throw new RoomError('not-found', '找不到该玩家');
    const payload: AwardPayload = {
      playerId,
      playerName: player.name,
      xp: award.xp,
      items: award.items ?? [],
      note: award.note,
      private: true,
    };
    this.emit(room, 'alert', 'all', {
      level: 'info',
      text: `${player.name} 获得了奖励（详情见私信）`,
    } satisfies AlertPayload);
    return this.emit(room, 'award', playerId, payload);
  }

  /** GM 请求一次自由掷骰（例如伤害骰），走房间种子保证可复现。 */
  gmRoll(
    roomId: string,
    params: { expression: string; label?: string },
  ): GameEvent<'dice', DicePayload> {
    const room = this.requireRoom(roomId);
    room.rollIndex += 1;
    const rng = createRng(deriveRollSeed(room.seed, room.rollIndex));
    let rolled;
    try {
      rolled = rollDice(params.expression, rng);
    } catch (error) {
      throw new RoomError('invalid-expression', error instanceof Error ? error.message : '骰子表达式非法');
    }
    return this.emit(room, 'dice', 'all', {
      expression: rolled.expression,
      dice: rolled.dice,
      modifier: rolled.modifier,
      total: rolled.total,
      label: params.label,
      playerId: 'host',
      rollerName: 'GM',
      private: false,
    } satisfies DicePayload);
  }

  /** GM 对某玩家发起技能/属性检定：引擎掷骰、给出成败，并把骰面广播（或私发）。 */
  gmCheck(
    roomId: string,
    params: { playerId: PlayerId; skill: SkillId; dc: number; label?: string; private?: boolean },
  ): GameEvent<'dice', DicePayload> {
    const room = this.requireRoom(roomId);
    const player = room.players.get(params.playerId);
    if (!player) throw new RoomError('not-found', '找不到该玩家');
    if (!player.character) throw new RoomError('conflict', `${player.name} 还没有角色卡，先落座`);
    room.rollIndex += 1;
    const rng = createRng(deriveRollSeed(room.seed, room.rollIndex));
    const result = rollSkillCheck(
      {
        proficiency: player.character.proficiency.bonus,
        skills: player.character.proficiency.skills,
        saves: player.character.proficiency.saves,
      },
      player.character.abilities,
      params.skill,
      params.dc,
      rng,
    );
    const target: EventTarget = params.private === true ? player.id : 'all';
    return this.emit(room, 'dice', target, {
      expression: 'd20',
      dice: result.rolls,
      modifier: result.bonus,
      total: result.total,
      label: params.label ?? `${SKILL_NAME[params.skill]}检定`,
      playerId: player.id,
      rollerName: player.character.identity.name,
      private: params.private === true,
      check: {
        kind: 'skill',
        name: SKILL_NAME[params.skill],
        dc: params.dc,
        success: result.success,
      },
    } satisfies DicePayload);
  }

  // -------------------------------------------------------------------------
  // 规则投影与命令（M9.4；host 结算，客户端只发意图）
  // -------------------------------------------------------------------------

  /**
   * 房间的规则运行时（host 侧 GM 编排/工具用；协议层拿不到它）。
   * 房间不存在或没有规则运行时返回 undefined。
   */
  runtimeOf(roomId: string): RuleRuntime | undefined {
    if (!this.rooms.has(roomId)) return undefined;
    return this.ruleRooms.get(roomId)?.runtime;
  }

  /** `sheet.get`：读角色卡投影（玩家只能读自己的；房主可指定 playerId/actorId）。 */
  sheet(principal: Principal, rawParams: unknown): SheetGetResult {
    const params = this.parse(validateSheetGet(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const result = buildSheetResult(this.viewOptionsFor(rr), target.actorId);
    return { ...result, sheet: this.sheetWithMedia(room, result.sheet) };
  }

  /** `sheet.equip`：装备物品到指定槽位（校验 accepts/件数；换装后重算投影）。 */
  equip(principal: Principal, rawParams: unknown): SheetCommandResult {
    const params = this.parse(validateSheetEquip(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const actor = this.requireActorView(rr, target.actorId);
    const plan = planEquip(rr.rules, actor.card, rr.bagOf(target.actorId), params.slotId, params.instanceId);
    if (!plan.ok) throw new RoomError('bad-request', plan.error);
    const changed = rr.runtime.changeEquipment({ actorId: target.actorId, equipmentInstances: plan.instances });
    if (!changed.ok) throw roomErrorFromRule(changed.error);
    if (plan.fromBag) rr.removeFromBag(target.actorId, params.instanceId);
    const options = this.viewOptionsFor(rr);
    return {
      sheet: this.sheetWithMedia(room, buildSheetView(options, target.actorId)),
      inventory: buildInventoryView(options, target.actorId),
      events: ['equip/change'],
    };
  }

  /** `sheet.unequip`：卸下装备（物品进 host 侧背包，随快照保存）。 */
  unequip(principal: Principal, rawParams: unknown): SheetCommandResult {
    const params = this.parse(validateSheetUnequip(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const actor = this.requireActorView(rr, target.actorId);
    const plan = planUnequip(rr.rules, actor.card, params.slotId, params.instanceId);
    if (!plan.ok) throw new RoomError('bad-request', plan.error);
    const changed = rr.runtime.changeEquipment({ actorId: target.actorId, equipmentInstances: plan.instances });
    if (!changed.ok) throw roomErrorFromRule(changed.error);
    rr.addToBag(target.actorId, plan.removed);
    const options = this.viewOptionsFor(rr);
    return {
      sheet: this.sheetWithMedia(room, buildSheetView(options, target.actorId)),
      inventory: buildInventoryView(options, target.actorId),
      events: ['equip/change'],
    };
  }

  /** `sheet.useItem`：使用物品（效果走规则包 `items[].useAction`；成功后消耗一件）。 */
  useItem(principal: Principal, rawParams: unknown): SheetCommandResult {
    const params = this.parse(validateSheetUseItem(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const actor = this.requireActorView(rr, target.actorId);
    const equipped = (actor.card.equipmentInstances ?? []).find((instance) => instance.instanceId === params.instanceId);
    const bagItem = rr.bagOf(target.actorId).find((instance) => instance.instanceId === params.instanceId);
    const instance = equipped ?? bagItem;
    if (instance === undefined) {
      throw new RoomError('not-found', `没有编号为「${params.instanceId}」的物品`);
    }
    const def = findItemDef(rr.rules, instance);
    if (def === undefined) {
      throw new RoomError('bad-request', `物品「${instance.name ?? params.instanceId}」不在规则包 items[] 里，无法使用`);
    }
    if (def.useAction === undefined) {
      throw new RoomError('bad-request', `物品「${def.name}」没有可用效果（规则包未声明 useAction）`);
    }
    const used = rr.runtime.useAction({
      actorId: target.actorId,
      actionId: def.useAction,
      ...(params.targetId !== undefined ? { targetId: params.targetId } : {}),
    });
    if (!used.ok) throw roomErrorFromRule(used.error);
    // 用后消耗一件：装备里的从卡上移除，背包里的从背包移除（v1 不做堆叠合并）。
    let consumed = false;
    let removedFrom: 'slot' | 'bag' | undefined;
    if (equipped !== undefined) {
      const consumedChange = rr.runtime.changeEquipment({
        actorId: target.actorId,
        equipmentInstances: (actor.card.equipmentInstances ?? []).filter((candidate) => candidate.instanceId !== params.instanceId),
      });
      if (consumedChange.ok) {
        consumed = true;
        removedFrom = 'slot';
      }
    } else if (rr.removeFromBag(target.actorId, params.instanceId) !== undefined) {
      consumed = true;
      removedFrom = 'bag';
    }
    const options = this.viewOptionsFor(rr);
    return {
      sheet: this.sheetWithMedia(room, buildSheetView(options, target.actorId)),
      inventory: buildInventoryView(options, target.actorId),
      events: [...used.events],
      item: {
        instanceId: params.instanceId,
        itemId: def.itemId,
        name: def.name,
        consumed,
        ...(removedFrom !== undefined ? { removedFrom } : {}),
        action: this.actionOutcomeView(used),
      },
    };
  }

  /** `combat.view`：战棋/回合/行动经济视图（全桌可读）。 */
  combatView(principal: Principal): CombatViewResult {
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    return { combat: this.combatWithMedia(room, buildCombatView(this.viewOptionsFor(rr))) };
  }

  /** `combat.start`：开战（仅房主/GM）；可带 `enemies` 临时加入敌对行动者。 */
  startCombat(principal: Principal, rawParams: unknown): CombatStartResult {
    this.requireHost(principal);
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const params = this.parse(validateCombatStart(rawParams));
    const enemies = params.enemies ?? [];
    if (params.actorIds === undefined && rr.playerActors().length === 0 && enemies.length === 0) {
      throw new RoomError('conflict', '没有可以参战的角色（先让玩家落座，或用 enemies 加入敌人）');
    }
    const addedActorIds: string[] = [];
    try {
      for (let index = 0; index < enemies.length; index += 1) {
        addedActorIds.push(this.addEnemyActor(rr, enemies[index]!, params.mapId, index));
      }
      const started = rr.runtime.startCombat({
        ...(params.actorIds !== undefined ? { actorIds: params.actorIds } : {}),
        ...(params.maxRounds !== undefined ? { maxRounds: params.maxRounds } : {}),
        ...(params.mapId !== undefined ? { mapId: params.mapId } : {}),
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
      if (!started.ok) throw roomErrorFromRule(started.error);
      const result = buildCombatStartResult(this.viewOptionsFor(rr), started.rolls);
      return { ...result, combat: this.combatWithMedia(room, result.combat) };
    } catch (error) {
      // 开战失败：撤掉本次临时加入的敌人，保持运行时干净（避免半截战斗）
      for (const actorId of addedActorIds) {
        try {
          rr.runtime.removeActor(actorId);
        } catch {
          /* 已在先攻表里就保留 */
        }
      }
      throw error;
    }
  }

  /** `combat.useAction`：使用规则包动作（行动者必须是自己 / 房主代管；回合由运行时校验）。 */
  useAction(principal: Principal, rawParams: unknown): CombatUseActionResult {
    const params = this.parse(validateCombatUseAction(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const result = rr.runtime.useAction({
      actorId: target.actorId,
      actionId: params.actionId,
      ...(params.targetId !== undefined ? { targetId: params.targetId } : {}),
      ...(params.options !== undefined ? { options: { ...params.options } } : {}),
    });
    if (!result.ok) throw roomErrorFromRule(result.error);
    const options = this.viewOptionsFor(rr);
    return {
      combat: this.combatWithMedia(room, buildCombatView(options)),
      action: this.actionOutcomeView(result),
      sheet: this.sheetWithMedia(room, buildSheetView(options, target.actorId)),
    };
  }

  /** `combat.move`：移动（距离/地形/连通性/移动力由运行时校验）。 */
  move(principal: Principal, rawParams: unknown): CombatMoveResult {
    const params = this.parse(validateCombatMove(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const result = rr.runtime.move({
      actorId: target.actorId,
      to: {
        ...(params.to.zoneId !== undefined ? { zoneId: params.to.zoneId } : {}),
        ...(params.to.cell !== undefined ? { cell: { x: params.to.cell.x, y: params.to.cell.y } } : {}),
      },
      ...(params.via !== undefined ? { via: params.via } : {}),
    });
    if (!result.ok) throw roomErrorFromRule(result.error);
    const moved = buildCombatMoveResult(this.viewOptionsFor(rr), result);
    return { ...moved, combat: this.combatWithMedia(room, moved.combat) };
  }

  /** `combat.endTurn`：结束当前（或自己）的回合；跨轮自动走回合边界/回合上限。 */
  endTurn(principal: Principal, rawParams: unknown): CombatEndTurnResult {
    const params = this.parse(validateCombatEndTurn(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    let actorId: string | undefined;
    if (principal.kind === 'player') {
      const own = rr.actorIdOfPlayer(principal.playerId);
      if (params.playerId !== undefined && params.playerId !== principal.playerId) {
        throw new RoomError('forbidden', '不能结束别人的回合');
      }
      if (params.actorId !== undefined && own !== undefined && params.actorId !== own) {
        throw new RoomError('forbidden', '不能结束别人的回合');
      }
      if (own === undefined) throw new RoomError('conflict', '你还没有落座（先上传角色卡），没有可操作的回合');
      actorId = own;
    } else {
      actorId = params.actorId ?? (params.playerId !== undefined ? rr.actorIdOfPlayer(params.playerId) : rr.actorIdOfPlayer('host'));
    }
    const ended = rr.runtime.endTurn(actorId !== undefined ? { actorId } : {});
    if (!ended.ok) throw roomErrorFromRule(ended.error);
    return { combat: this.combatWithMedia(room, buildCombatView(this.viewOptionsFor(rr))) };
  }

  /** `combat.rollCheck`：检定（属性/技能/豁免；骰面与 trace 由运行时给出）。 */
  rollCheck(principal: Principal, rawParams: unknown): CombatRollCheckResult {
    const params = this.parse(validateCombatRollCheck(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const target = this.resolveTargetActor(principal, rr, params);
    const result = rr.runtime.rollCheck({
      actorId: target.actorId,
      ...(params.targetId !== undefined ? { targetId: params.targetId } : {}),
      ...(params.skillId !== undefined ? { skillId: params.skillId } : {}),
      ...(params.attributeId !== undefined ? { attributeId: params.attributeId } : {}),
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      ...(params.dc !== undefined ? { dc: params.dc } : {}),
      ...(params.mods !== undefined ? { mods: params.mods } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
    });
    if (!result.ok) throw roomErrorFromRule(result.error);
    return { check: checkViewOf(result) };
  }

  /** `combat.end`：收场（仅房主/GM）。 */
  endCombat(principal: Principal, rawParams: unknown): CombatEndResult {
    this.requireHost(principal);
    const params = this.parse(validateCombatEnd(rawParams));
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    const ended = rr.runtime.endCombat({ ...(params.reason !== undefined ? { reason: params.reason } : {}) });
    if (!ended.ok) throw roomErrorFromRule(ended.error);
    return { combat: this.combatWithMedia(room, buildCombatView(this.viewOptionsFor(rr))) };
  }

  /** `worldmap.get`：世界地图投影（底图/zone 热点/连线/队伍位置）。 */
  worldMap(principal: Principal): WorldMapGetResult {
    const room = this.requireRoom(principal.roomId);
    const rr = this.requireRulesRoom(room);
    return { worldMap: buildWorldMapView(this.viewOptionsFor(rr)) };
  }

  /** host 侧 GM 工具：临时加入一个敌对/中立行动者（不广播，开战后由战斗视图体现）。 */
  gmSpawnEnemy(
    roomId: string,
    spec: { name: string; card?: unknown; team?: 'enemy' | 'neutral'; actorId?: string; cell?: { x: number; y: number }; zoneId?: string },
  ): { actorId: string } {
    const room = this.requireRoom(roomId);
    const rr = this.requireRulesRoom(room);
    return { actorId: this.addEnemyActor(rr, spec, undefined, rr.playerActors().length) };
  }

  private actionOutcomeView(result: Parameters<typeof actionOutcomeOf>[0]): ActionOutcomeView {
    return actionOutcomeOf(result);
  }

  private viewOptionsFor(rr: RoomRulesRoom): RuleViewOptions {
    return {
      rules: rr.rules,
      runtime: rr.runtime,
      playerOf: (actorId) => rr.playerIdOfActor(actorId),
      bagOf: (actorId) => rr.bagOf(actorId),
    };
  }

  private requireRulesRoom(room: RoomRecord): RoomRulesRoom {
    const rr = this.ruleRooms.get(room.id);
    if (rr !== undefined) return rr;
    const down = this.ruleDown.get(room.id);
    if (down !== undefined) {
      throw new RoomError(
        'conflict',
        `房间规则「${down.view.rulesId}」当前不可用（${down.warnings[0] ?? '规则包未加载'}）：角色卡/战斗命令暂时无法结算`,
      );
    }
    throw new RoomError('conflict', '本房间没有规则运行时（内容包未带 rules 段）：角色卡/战斗命令不可用');
  }

  private requireActorView(rr: RoomRulesRoom, actorId: string): ActorView {
    const result = rr.runtime.getActor(actorId);
    if (!result.ok) throw roomErrorFromRule(result.error);
    return result.actor;
  }

  /** 命令/读取的目标行动者：玩家只能指向自己的行动者；房主可代管任意行动者。 */
  private resolveTargetActor(
    principal: Principal,
    rr: RoomRulesRoom,
    params: { playerId?: PlayerId; actorId?: string },
  ): { actorId: string; playerId?: PlayerId } {
    if (principal.kind === 'player') {
      if (params.playerId !== undefined && params.playerId !== principal.playerId) {
        throw new RoomError('forbidden', '不能操作别人的角色卡');
      }
      const own = rr.actorIdOfPlayer(principal.playerId);
      if (own === undefined) {
        throw new RoomError('conflict', '你还没有落座（先上传角色卡），没有可操作的角色');
      }
      if (params.actorId !== undefined && params.actorId !== own) {
        throw new RoomError('forbidden', '不能操作别人的角色');
      }
      return { actorId: own, playerId: principal.playerId };
    }
    const playerId = params.playerId ?? (params.actorId !== undefined ? rr.playerIdOfActor(params.actorId) : 'host');
    const actorId = params.actorId ?? (playerId !== undefined ? rr.actorIdOfPlayer(playerId) : undefined);
    if (actorId === undefined) {
      throw new RoomError('conflict', '房主还没有可操作的角色（先落座，或用 playerId/actorId 指定）');
    }
    return { actorId, ...(playerId !== undefined ? { playerId } : {}) };
  }

  private addEnemyActor(
    rr: RoomRulesRoom,
    spec: { name: string; card?: unknown; team?: 'enemy' | 'neutral'; actorId?: string; cell?: { x: number; y: number }; zoneId?: string },
    mapId: string | undefined,
    index: number,
  ): string {
    const actorId = spec.actorId ?? rr.nextNpcActorId();
    if (rr.hasActor(actorId)) throw new RoomError('conflict', `行动者「${actorId}」已在运行时里`);
    const converted = spec.card === undefined
      ? { card: synthesizeEnemyCard(rr.rules, spec.name, `npc_card_${actorId.replace(/[^A-Za-z0-9_-]/g, '_')}`), warnings: [] as string[], error: undefined as string | undefined }
      : rr.prepareCard(spec.card);
    if (converted.card === undefined) {
      throw new RoomError('bad-request', `敌人「${spec.name}」的卡无法使用：${converted.error ?? converted.warnings.join('；')}`);
    }
    const position = spec.cell !== undefined
      ? {
          cell: { x: Math.trunc(spec.cell.x), y: Math.trunc(spec.cell.y) },
          ...(spec.zoneId !== undefined ? { zoneId: spec.zoneId } : {}),
        }
      : (rr.enemySpawnCell(mapId, index) ?? (spec.zoneId !== undefined ? { zoneId: spec.zoneId } : undefined));
    const added = rr.runtime.addActor({
      card: converted.card,
      actorId,
      name: spec.name,
      team: spec.team ?? 'enemy',
      ...(position !== undefined ? { position } : {}),
    });
    if (!added.ok) throw roomErrorFromRule(added.error);
    return actorId;
  }

  // --- 规则运行时生命周期 ---------------------------------------------------

  /** 建房时按内容包解析规则并建运行时（失败降级：房间照常开局）。 */
  private createRulesForRoom(room: RoomRecord): void {
    const resolver = this.rulesResolver;
    if (resolver === undefined) return;
    let resolved: RoomRulesInput | undefined;
    try {
      resolved = resolver.resolveRules(room.content.packId, room.content.moduleId);
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined) return;
    const rulesSeed = deriveRulesSeed(room.id, this.seedSalt);
    try {
      const rr = new RoomRulesRoom({
        roomId: room.id,
        rules: resolved.rules,
        ...(resolved.scripts !== undefined ? { scripts: resolved.scripts } : {}),
        rulesSeed,
        ...(resolved.rulesHash !== undefined ? { rulesHash: resolved.rulesHash } : {}),
        onEvent: (event) => this.onRulesEvent(room, event),
      });
      this.ruleRooms.set(room.id, rr);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ruleDown.set(room.id, {
        view: {
          rulesId: resolved.rules.rulesId,
          rulesVersion: resolved.rules.rulesVersion,
          name: resolved.rules.name,
          degraded: true,
        },
        ...(resolved.rulesHash !== undefined ? { rulesHash: resolved.rulesHash } : {}),
        warnings: [message],
      });
      this.emit(room, 'alert', 'all', {
        level: 'warning',
        text: `规则运行时启动失败（${message}）：房间按无规则模式开局；检查内容包脚本后重扫内容包。`,
      } satisfies AlertPayload);
    }
  }

  /** 续团：解析规则 → 建运行时 → importState（不兼容/漂移降级并返回 warning 文案）。 */
  private restoreRulesForRoom(room: RoomRecord, source: RoomSnapshot['room']): string | undefined {
    const resolver = this.rulesResolver;
    const hadRules = source.rulesId !== undefined || source.ruleState !== undefined;
    if (resolver === undefined) {
      if (source.rulesId === undefined) return undefined;
      this.ruleDown.set(room.id, {
        view: { rulesId: source.rulesId, rulesVersion: source.rulesVersion ?? '0.0.0', degraded: true },
        ...(source.rulesHash !== undefined ? { rulesHash: source.rulesHash } : {}),
        warnings: ['host 没有注入规则解析器'],
      });
      return '房间记录了规则包，但 host 没有规则解析器：已按无规则模式续团（规则命令暂不可用）。';
    }
    let resolved: RoomRulesInput | undefined;
    try {
      resolved = resolver.resolveRules(room.content.packId, room.content.moduleId);
    } catch {
      resolved = undefined;
    }
    if (resolved === undefined) {
      if (!hadRules) return undefined;
      this.ruleDown.set(room.id, {
        view: { rulesId: source.rulesId ?? room.content.packId, rulesVersion: source.rulesVersion ?? '0.0.0', degraded: true },
        ...(source.rulesHash !== undefined ? { rulesHash: source.rulesHash } : {}),
        warnings: ['规则包在本机不可用'],
      });
      return `房间引用的规则包「${source.rulesId ?? room.content.packId}」在本机不可用：已按无规则模式续团；恢复对应内容包后重扫即可。`;
    }
    const rulesSeed = typeof source.rulesSeed === 'number' && Number.isFinite(source.rulesSeed) && source.rulesSeed >= 0
      ? Math.trunc(source.rulesSeed)
      : deriveRulesSeed(room.id, this.seedSalt);
    let rr: RoomRulesRoom;
    try {
      rr = new RoomRulesRoom({
        roomId: room.id,
        rules: resolved.rules,
        ...(resolved.scripts !== undefined ? { scripts: resolved.scripts } : {}),
        rulesSeed,
        ...(resolved.rulesHash !== undefined ? { rulesHash: resolved.rulesHash } : {}),
        onEvent: (event) => this.onRulesEvent(room, event),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ruleDown.set(room.id, {
        view: { rulesId: resolved.rules.rulesId, rulesVersion: resolved.rules.rulesVersion, name: resolved.rules.name, degraded: true },
        warnings: [message],
      });
      return `规则运行时启动失败（${message}）：已按无规则模式续团。`;
    }
    this.ruleRooms.set(room.id, rr);
    let alert: string | undefined;
    if (source.ruleBags !== undefined) rr.importBags(source.ruleBags);
    if (source.ruleState !== undefined) {
      const imported = rr.importRuleState(source.ruleState);
      if (!imported.ok) {
        rr.degraded = true;
        alert = `规则运行态快照无法导入（${imported.errors.join('；')}）：已按当前规则重建角色状态，续团结算从本机状态继续。`;
      }
    }
    const players = [...room.players.values()].map((player) => ({
      playerId: player.id,
      name: player.name,
      ...(player.ruleCard !== undefined
        ? { card: player.ruleCard }
        : player.character !== undefined
          ? { card: player.character }
          : {}),
    }));
    const syncWarnings = rr.syncPlayers(players);
    if (syncWarnings.length > 0) {
      rr.noteWarnings(syncWarnings);
      alert = `${alert !== undefined ? `${alert} ` : ''}${syncWarnings.slice(0, 2).join('；')}`;
    }
    if (source.rulesVersion !== undefined && source.rulesVersion !== resolved.rules.rulesVersion) {
      rr.degraded = true;
      alert = `房间规则包版本已变化（${source.rulesVersion} → ${resolved.rules.rulesVersion}）：已按本机版本继续，规则命令按新版本结算。`;
    } else if (
      source.rulesHash !== undefined &&
      resolved.rulesHash !== undefined &&
      source.rulesHash !== resolved.rulesHash
    ) {
      rr.degraded = true;
      alert = '房间规则包内容已变化（rulesHash 不一致）：已按本机现有规则继续；如需原版本请恢复对应内容包。';
    }
    return alert;
  }

  private disposeRulesRoom(roomId: string): void {
    const rr = this.ruleRooms.get(roomId);
    if (rr !== undefined) {
      rr.dispose();
      this.ruleRooms.delete(roomId);
    }
    this.ruleDown.delete(roomId);
  }

  private rulesViewFor(roomId: string): RoomRulesView | undefined {
    const rr = this.ruleRooms.get(roomId);
    if (rr !== undefined) {
      return {
        rulesId: rr.rules.rulesId,
        rulesVersion: rr.rules.rulesVersion,
        name: rr.rules.name,
        ...(rr.degraded ? { degraded: true } : {}),
      };
    }
    return this.ruleDown.get(roomId)?.view;
  }

  private snapshotRulesOf(
    room: RoomRecord,
  ): Pick<RoomSnapshot['room'], 'rulesId' | 'rulesVersion' | 'rulesHash' | 'rulesSeed' | 'ruleState' | 'ruleBags'> {
    const rr = this.ruleRooms.get(room.id);
    if (rr !== undefined) {
      return {
        rulesId: rr.rules.rulesId,
        rulesVersion: rr.rules.rulesVersion,
        rulesHash: rr.rulesHash,
        rulesSeed: rr.rulesSeed,
        ruleState: rr.exportRuleState(),
        ruleBags: rr.exportBags(),
      };
    }
    const down = this.ruleDown.get(room.id);
    if (down !== undefined) {
      return {
        rulesId: down.view.rulesId,
        rulesVersion: down.view.rulesVersion,
        ...(down.rulesHash !== undefined ? { rulesHash: down.rulesHash } : {}),
      };
    }
    return {};
  }

  private attachPlayerToRules(room: RoomRecord, player: PlayerRecord): void {
    const rr = this.ruleRooms.get(room.id);
    if (rr === undefined) return;
    const card = player.ruleCard ?? player.character;
    if (card === undefined) return;
    const added = rr.addPlayer({ playerId: player.id, name: player.name, card });
    if (added.error !== undefined) {
      this.emit(room, 'alert', 'all', {
        level: 'warning',
        text: `${player.name} 的角色卡未进入规则运行时：${added.error}`,
      } satisfies AlertPayload);
      return;
    }
    this.emitSheetUpdate(room, rr, player.id, 'room/seat');
  }

  private detachPlayerFromRules(room: RoomRecord, player: PlayerRecord): void {
    const rr = this.ruleRooms.get(room.id);
    if (rr === undefined) return;
    const removed = rr.removePlayer(player.id);
    if (removed.removed) return;
    if (removed.error !== undefined) {
      // 战斗中行动者保留在先攻表里：只记录，不打断离场流程。
      rr.noteWarnings([`${player.name}：${removed.error}`]);
    }
  }

  // --- 运行时事件 → SSE -----------------------------------------------------

  private onRulesEvent(room: RoomRecord, event: RuntimeEvent): void {
    if (!this.rooms.has(room.id)) return;
    const rr = this.ruleRooms.get(room.id);
    if (rr === undefined) return;
    const data: Record<string, unknown> = event.data ?? {};
    if (event.kind === 'rules/error') {
      const hook = typeof data.hook === 'string' ? data.hook : undefined;
      const failureKind = typeof data.kind === 'string' ? data.kind : undefined;
      const message = typeof data.message === 'string' ? data.message : '未知错误';
      const degraded = data.degraded === true;
      const payload: RulesErrorPayload = {
        ...(hook !== undefined ? { hook } : {}),
        ...(failureKind !== undefined ? { kind: failureKind } : {}),
        message,
        text: `规则钩子${hook !== undefined ? `「${hook}」` : ''}执行失败：${message}${degraded ? '（已降级为缺省结算）' : ''}`,
        ...(degraded ? { degraded: true } : {}),
      };
      this.emit(room, 'rules/error', 'all', payload);
      return;
    }
    if (event.kind === 'check') {
      this.emitRulesCheckDice(room, rr, data);
      return;
    }
    if (event.kind === 'equip/change') {
      const actorId = typeof data.actorId === 'string' ? data.actorId : undefined;
      const playerId = actorId !== undefined ? rr.playerIdOfActor(actorId) : undefined;
      if (playerId !== undefined) this.emitSheetUpdate(room, rr, playerId, event.kind, event.seq);
      return;
    }
    if (event.kind === 'damage/after' || event.kind === 'action/after' || event.kind === 'level/up') {
      const affected = event.kind === 'damage/after'
        ? (typeof data.targetId === 'string' ? data.targetId : undefined)
        : (typeof data.actorId === 'string' ? data.actorId : undefined);
      const playerId = affected !== undefined ? rr.playerIdOfActor(affected) : undefined;
      if (playerId !== undefined) this.emitSheetUpdate(room, rr, playerId, event.kind, event.seq);
    }
    if (COMBAT_BROADCAST_EVENTS.has(event.kind)) {
      this.emitCombatUpdate(room, rr, event.kind, event.seq);
    }
  }

  private emitSheetUpdate(room: RoomRecord, rr: RoomRulesRoom, playerId: PlayerId, cause: string, runtimeSeq?: number): void {
    const actorId = rr.actorIdOfPlayer(playerId);
    if (actorId === undefined) return;
    try {
      const sheet = this.sheetWithMedia(room, buildSheetView(this.viewOptionsFor(rr), actorId));
      const payload: SheetUpdatePayload = {
        playerId,
        actorId,
        sheet,
        cause,
        ...(runtimeSeq !== undefined ? { runtimeSeq } : {}),
      };
      this.emit(room, 'sheet/update', playerId, payload);
    } catch {
      /* 投影失败不影响广播/结算 */
    }
  }

  private emitCombatUpdate(room: RoomRecord, rr: RoomRulesRoom, cause: string, runtimeSeq: number): void {
    try {
      const payload: CombatUpdatePayload = {
        combat: this.combatWithMedia(room, buildCombatView(this.viewOptionsFor(rr))),
        causes: [cause],
        runtimeSeq,
      };
      this.emit(room, 'combat/update', 'all', payload);
    } catch {
      /* 投影失败不影响结算 */
    }
  }

  private emitRulesCheckDice(room: RoomRecord, rr: RoomRulesRoom, data: Record<string, unknown>): void {
    const actorId = typeof data.actorId === 'string' ? data.actorId : undefined;
    let actorName = 'GM';
    if (actorId !== undefined) {
      const actor = rr.runtime.getActor(actorId);
      if (actor.ok) actorName = actor.actor.name;
    }
    const rawRolls = Array.isArray(data.rolls) ? data.rolls : [];
    const firstRoll = rawRolls.find((roll): roll is Record<string, unknown> => typeof roll === 'object' && roll !== null);
    const dice = Array.isArray(firstRoll?.dice)
      ? (firstRoll.dice as unknown[]).filter((die): die is number => typeof die === 'number')
      : [];
    const d20 = typeof data.d20 === 'number' ? data.d20 : (dice[0] ?? 0);
    const total = typeof data.total === 'number' ? data.total : 0;
    const dc = typeof data.dc === 'number' ? data.dc : 0;
    const kindRaw = typeof data.kind === 'string' ? data.kind : 'check';
    const kind: NonNullable<DicePayload['check']>['kind'] = kindRaw === 'skill'
      ? 'skill'
      : kindRaw === 'save'
        ? 'save'
        : kindRaw === 'attack'
          ? 'attack'
          : 'ability';
    const playerId = actorId !== undefined ? (rr.playerIdOfActor(actorId) ?? 'host') : 'host';
    this.emit(room, 'dice', 'all', {
      expression: 'd20',
      dice,
      modifier: total - d20,
      total,
      label: `${kindRaw}检定`,
      playerId,
      rollerName: actorName,
      private: false,
      check: { kind, name: kindRaw, dc, success: data.success === true },
    } satisfies DicePayload);
  }



  // -------------------------------------------------------------------------
  // 事件流
  // -------------------------------------------------------------------------

  eventsSince(principal: Principal, lastSeq: number): GameEvent[] {
    const room = this.requireRoom(principal.roomId);
    return room.events.filter((event) => event.seq > lastSeq && visibleTo(principal, event)).map((event) => ({ ...event }));
  }

  /** 订阅可见事件；返回取消函数。SSE 连接与玩家在线状态由此维护。 */
  subscribe(principal: Principal, notify: (event: GameEvent) => void): () => void {
    const room = this.requireRoom(principal.roomId);
    const listener: Listener = { principal, notify };
    room.listeners.add(listener);
    if (principal.kind === 'player') {
      const player = room.players.get(principal.playerId);
      if (player) {
        player.connections += 1;
        if (player.connections === 1) this.emit(room, 'room', 'all', this.publicView(room));
      }
    }
    return () => {
      room.listeners.delete(listener);
      if (principal.kind === 'player') {
        const player = room.players.get(principal.playerId);
        if (player) {
          player.connections = Math.max(0, player.connections - 1);
          if (player.connections === 0) this.emit(room, 'room', 'all', this.publicView(room));
        }
      }
    };
  }

  /** 关闭所有房间（仅本机 loopback 运维入口；用于清场/测试）。 */
  closeAll(): { closed: number } {
    const ids = [...this.rooms.keys()];
    for (const roomId of ids) {
      try {
        this.closeRoom(roomId);
      } catch {
        /* 单个失败继续 */
      }
    }
    return { closed: ids.length };
  }

  /** 房主关闭房间（M4/M5：释放内存与存档文件）。 */
  closeRoom(roomId: string): { closed: true } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError('not-found', '房间不存在或已关闭');
    for (const player of room.players.values()) this.tokens.delete(player.token);
    this.tokens.delete(room.hostToken);
    for (const listener of room.listeners) {
      try {
        listener.notify({
          v: PROTOCOL_VERSION,
          kind: 'alert',
          seq: room.seq,
          at: this.now(),
          to: 'all',
          payload: { level: 'warning', text: '房主关闭了房间', close: true } as unknown as AlertPayload,
        });
      } catch {
        /* ignore */
      }
    }
    room.listeners.clear();
    this.disposeRulesRoom(roomId);
    this.rooms.delete(roomId);
    try {
      this.onRoomClosed?.(roomId);
    } catch {
      /* 关闭回调失败不影响关房 */
    }
    try {
      this.onChanged?.();
    } catch {
      /* ignore */
    }
    return { closed: true };
  }

  /** 存档：整间房的权威状态（含 token 与角色卡），用于 DSH 重启后续团。 */
  snapshotAll(): RoomSnapshot[] {
    return [...this.rooms.values()].map((room) => ({
      schemaVersion: 1,
      savedAt: this.now(),
      room: {
        id: room.id,
        title: room.title,
        gmMode: room.gmMode,
        phase: room.phase,
        inviteCode: room.inviteCode,
        hostToken: room.hostToken,
        locked: room.locked,
        seed: room.seed,
        rollIndex: room.rollIndex,
        seq: room.seq,
        createdAt: room.createdAt,
        ...(room.sessionId ? { sessionId: room.sessionId } : {}),
        ...(room.scene ? { scene: room.scene } : {}),
        content: snapshotContentOf(room.content),
        ...this.snapshotRulesOf(room),
        players: [...room.players.values()].map((player) => ({
          id: player.id,
          name: player.name,
          token: player.token,
          seat: player.seat,
          ...(player.character ? { character: player.character } : {}),
          ...(player.ruleCard !== undefined ? { ruleCard: player.ruleCard } : {}),
          ...(player.characterAssets !== undefined && player.characterAssets.length > 0
            ? { characterAssets: player.characterAssets.map((ref) => ({ ...ref })) }
            : {}),
          joinedAt: player.joinedAt,
        })),
        events: room.events.map((event) => ({ ...event })),
      },
    }));
  }

  /** 载入存档：重建房间与 token，在线状态清零，等待客户端重连。 */
  restore(snapshot: RoomSnapshot): boolean {
    if (!snapshot || snapshot.schemaVersion !== 1) return false;
    const source = snapshot.room;
    if (!source || typeof source.id !== 'string' || this.rooms.has(source.id)) return false;
    const players = new Map<PlayerId, PlayerRecord>();
    for (const player of source.players ?? []) {
      // 快照里的展示资产引用（M9.5d）：续团保留；坏引用只丢弃、不让恢复失败。
      const restoredAssets = validateCharacterAssetRefs(player.characterAssets);
      players.set(player.id, {
        id: player.id,
        name: player.name,
        token: player.token,
        seat: player.seat,
        ...(player.character ? { character: player.character } : {}),
        ...(player.ruleCard !== undefined ? { ruleCard: player.ruleCard } : {}),
        ...(restoredAssets.ok && (restoredAssets.value?.length ?? 0) > 0 ? { characterAssets: restoredAssets.value } : {}),
        joinedAt: player.joinedAt,
        connections: 0,
      });
    }
    const restoredContent = this.restoreContent(source.content);
    const room: RoomRecord = {
      id: source.id,
      title: source.title,
      gmMode: source.gmMode,
      phase: source.phase,
      inviteCode: source.inviteCode,
      hostToken: source.hostToken,
      locked: source.locked,
      seed: source.seed,
      rollIndex: source.rollIndex,
      seq: source.seq,
      events: (source.events ?? []).map((event) => ({ ...event })),
      players,
      listeners: new Set(),
      createdAt: source.createdAt,
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      ...(source.scene ? { scene: source.scene } : {}),
      content: restoredContent.content,
    };
    this.rooms.set(room.id, room);
    this.tokens.set(room.hostToken, { kind: 'host', roomId: room.id });
    for (const player of players.values()) {
      this.tokens.set(player.token, { kind: 'player', roomId: room.id, playerId: player.id });
    }
    // 包缺失/版本漂移：房间照样恢复（不卡死），用一条 GM 警告说明降级与补救方式。
    if (restoredContent.alert) {
      this.emit(room, 'alert', 'all', { level: 'warning', text: restoredContent.alert } satisfies AlertPayload);
    }
    // 规则运行态：能解析规则就重建运行时并 importState（不兼容则降级 + warning）。
    const rulesAlert = this.restoreRulesForRoom(room, source);
    if (rulesAlert !== undefined) {
      this.emit(room, 'alert', 'all', { level: 'warning', text: rulesAlert } satisfies AlertPayload);
    }
    return true;
  }

  /** 房间数（存档/诊断）。 */
  roomCount(): number {
    return this.rooms.size;
  }

  /** 当前在线人数（测试/诊断用）。 */
  diagnostics(): { rooms: number; events: number; tokens: number; listeners: number } {
    let events = 0;
    let listeners = 0;
    for (const room of this.rooms.values()) {
      events += room.events.length;
      listeners += room.listeners.size;
    }
    return { rooms: this.rooms.size, events, tokens: this.tokens.size, listeners };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private parse<T>(result: { ok: boolean; value?: T; error?: string }): T {
    if (!result.ok || result.value === undefined) throw new RoomError('bad-request', result.error ?? '参数非法');
    return result.value;
  }

  /**
   * 建房时解析内容引用：显式指定的包/模组必须存在（给中文错误）；
   * 缺省引用不可用时不卡建房，标记 degraded 让 GM 回退内置包。
   */
  private resolveContentForCreate(params: CreateRoomParams): RoomContentState {
    const resolver = this.content;
    const explicitPackId = params.packId?.trim();
    const explicitModuleId = params.moduleId?.trim();
    const defaultPackId = resolver?.defaultPackId ?? DEFAULT_CONTENT_PACK_ID;
    const packId = explicitPackId && explicitPackId.length > 0 ? explicitPackId : defaultPackId;
    const moduleId = explicitModuleId && explicitModuleId.length > 0 ? explicitModuleId : undefined;
    if (!resolver) {
      // 未注入内容解析器（旧调用/单测）：按缺省引用记账，不校验存在性。
      return {
        packId,
        packVersion: '0.0.0',
        moduleId: moduleId ?? DEFAULT_CONTENT_MODULE_ID,
        contentHash: '',
        scenes: [],
        ...(packId !== defaultPackId || moduleId !== undefined ? { degraded: true } : {}),
      };
    }
    const resolved = resolver.resolveModule(packId, moduleId);
    if (resolved) return contentStateFromModule(resolved);
    if (explicitPackId) {
      if (resolver.hasPack && !resolver.hasPack(packId)) {
        throw new RoomError('bad-request', `内容包 "${packId}" 不存在（可用内容包见 content.list）`);
      }
      throw new RoomError(
        'bad-request',
        `内容包 "${packId}" 里没有模组 "${moduleId ?? '（默认模组）'}"（该包可能只带默认模组）`,
      );
    }
    if (moduleId) {
      throw new RoomError('bad-request', `缺省内容包 "${packId}" 里没有模组 "${moduleId}"`);
    }
    // 缺省包自己不可用（内置包加载失败/内容损坏）：降级开局，不卡住房东。
    return {
      packId,
      packVersion: '0.0.0',
      moduleId: DEFAULT_CONTENT_MODULE_ID,
      contentHash: '',
      scenes: [],
      degraded: true,
    };
  }

  /**
   * 恢复时解析内容引用：
   * - 旧快照无 content 字段 → 按内置包默认模组补齐（向后兼容）；
   * - 包缺失/内容版本漂移 → 房间仍恢复，degraded + 返回警告文案（GM 回退内置包）。
   */
  private restoreContent(source?: RoomSnapshotContent): { content: RoomContentState; alert?: string } {
    const resolver = this.content;
    const defaultPackId = resolver?.defaultPackId ?? DEFAULT_CONTENT_PACK_ID;
    if (!source) {
      const resolved = resolver?.resolveModule(defaultPackId);
      if (resolved) return { content: contentStateFromModule(resolved) };
      return {
        content: {
          packId: defaultPackId,
          packVersion: '0.0.0',
          moduleId: DEFAULT_CONTENT_MODULE_ID,
          contentHash: '',
          scenes: [],
        },
      };
    }
    const base: RoomContentState = {
      packId: source.packId,
      packVersion: source.packVersion,
      moduleId: source.moduleId,
      contentHash: source.contentHash,
      ...(source.packName !== undefined ? { packName: source.packName } : {}),
      ...(source.moduleTitle !== undefined ? { moduleTitle: source.moduleTitle } : {}),
      scenes: (source.scenes ?? []).map((scene) => ({ sceneId: scene.sceneId, title: scene.title })),
      ...(source.degraded ? { degraded: true } : {}),
    };
    if (!resolver) return { content: base };
    const resolved = resolver.resolveModule(source.packId, source.moduleId);
    if (!resolved) {
      return {
        content: { ...base, degraded: true },
        alert:
          `内容包「${source.packId}」或模组「${source.moduleId}」在本机不可用，房间已降级恢复：` +
          'GM 提示回退到内置内容包。导入该 .trpgpack 后重扫内容包即可恢复原内容。',
      };
    }
    const content = contentStateFromModule(resolved);
    const versionChanged = resolved.packVersion !== source.packVersion;
    const hashChanged = source.contentHash.length > 0 && resolved.contentHash !== source.contentHash;
    if (versionChanged || hashChanged) {
      return {
        content: { ...content, degraded: true },
        alert:
          `房间引用的内容已变化（${source.packId} ${source.packVersion} → ${resolved.packVersion}），` +
          '已按本机现有内容继续；如需原版本请导入对应 .trpgpack 后重扫。',
      };
    }
    return { content };
  }

  /**
   * 座位卡解析（M9.4）：旧 engine 卡（`schemaVersion: 1`）照旧过 `validateCharacterCard`；
   * 新卡实例（`trpg.card/1`）房间层不校验规则字段（由规则运行时 `migrateLegacyCard`/`validateCard` 兜底），
   * 只留原始引用。两者都会写进 `player.ruleCard` 供规则运行时实例化。
   */
  private parseSeatCard(input: unknown): { character?: CharacterCard; ruleCard: unknown } {
    const report = validateCharacterCard(input);
    if (report.ok && report.value !== undefined) {
      return { character: report.value, ruleCard: input };
    }
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      if ((input as { schemaVersion?: unknown }).schemaVersion === 'trpg.card/1') {
        return { ruleCard: input };
      }
    }
    throw new RoomError('invalid-card', `角色卡校验失败：${report.errors.join('；')}`);
  }

  private requireRoom(roomId: string): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError('not-found', '房间不存在或已关闭');
    return room;
  }

  private findByInvite(inviteCode: string): RoomRecord {
    const normalized = inviteCode.trim().toUpperCase();
    for (const room of this.rooms.values()) {
      if (room.inviteCode === normalized) return room;
    }
    throw new RoomError('not-found', '邀请码不正确');
  }

  private requireHost(principal: Principal): void {
    if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能执行该操作');
  }

  private uniqueInviteCode(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = randomInviteCode();
      let taken = false;
      for (const room of this.rooms.values()) if (room.inviteCode === code) taken = true;
      if (!taken) return code;
    }
    throw new RoomError('internal', '邀请码生成失败');
  }

  private publicView(room: RoomRecord): RoomView {
    const content = room.content;
    const rules = this.rulesViewFor(room.id);
    const assets = this.roomAssetViews(room);
    return {
      roomId: room.id,
      title: room.title,
      ...(room.sessionId ? { sessionId: room.sessionId } : {}),
      phase: room.phase,
      gmMode: room.gmMode,
      locked: room.locked,
      ...(room.scene ? { scene: room.scene } : {}),
      ...(rules !== undefined ? { rules: { ...rules } } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      ...(content
        ? {
            content: {
              packId: content.packId,
              packVersion: content.packVersion,
              moduleId: content.moduleId,
              ...(content.packName !== undefined ? { packName: content.packName } : {}),
              ...(content.moduleTitle !== undefined ? { moduleTitle: content.moduleTitle } : {}),
              ...(content.degraded ? { degraded: true } : {}),
            },
            ...(content.scenes.length > 0 ? { scenes: content.scenes.map((scene) => ({ ...scene })) } : {}),
          }
        : {}),
      players: [...room.players.values()].map((player) => ({
        playerId: player.id,
        displayName: player.name,
        seat: player.seat,
        online: player.connections > 0 || player.id === 'host',
        characterName: player.character?.identity.name,
        characterSummary: player.character?.publicSummary,
      })),
      createdAt: room.createdAt,
    };
  }

  private viewFor(room: RoomRecord, principal: Principal): RoomView {
    const view = this.publicView(room);
    if (principal.kind === 'host') view.inviteCode = room.inviteCode;
    return view;
  }

  // -------------------------------------------------------------------------
  // M9.5d 玩家展示资产（只存引用/URL；字节在 host 的 room-assets 区）
  // -------------------------------------------------------------------------

  /** 房间资产列表：已落座玩家上传的展示资产（按 sha256 去重；队友可见）。 */
  private roomAssetViews(room: RoomRecord): RoomAssetView[] {
    const seen = new Set<string>();
    const views: RoomAssetView[] = [];
    for (const player of room.players.values()) {
      for (const ref of player.characterAssets ?? []) {
        if (ref.url === undefined || seen.has(ref.sha256)) continue;
        seen.add(ref.sha256);
        views.push({
          assetId: ref.sha256,
          kind: ref.kind,
          ...(ref.variant !== undefined ? { variant: ref.variant } : {}),
          sha256: ref.sha256,
          url: ref.url,
          ownerId: player.id,
        });
      }
    }
    return views;
  }

  /** 某玩家卡面的媒体投影（头像/立绘/变体/帧表；没有资产返回 undefined）。 */
  private mediaOfPlayer(room: RoomRecord, playerId: PlayerId | undefined): SheetIdentityMediaView | undefined {
    if (playerId === undefined) return undefined;
    const refs = room.players.get(playerId)?.characterAssets;
    if (refs === undefined || refs.length === 0) return undefined;
    const media: SheetIdentityMediaView = {};
    const variants: Array<{ variant: string; url: string }> = [];
    for (const ref of refs) {
      if (ref.url === undefined) continue;
      if (ref.kind === 'avatar') media.avatarUrl = ref.url;
      else if (ref.kind === 'portrait') media.portraitUrl = ref.url;
      else if (ref.kind === 'portraitVariant' && ref.variant !== undefined) variants.push({ variant: ref.variant, url: ref.url });
      else if (ref.kind === 'spriteSheet') {
        media.spriteSheet = {
          url: ref.url,
          rows: ref.meta?.rows ?? 4,
          cols: ref.meta?.cols ?? 4,
          frameSize: ref.meta?.frameSize ?? 128,
        };
      }
    }
    if (variants.length > 0) media.portraitVariants = variants;
    return Object.keys(media).length > 0 ? media : undefined;
  }

  /** 给卡面投影补上玩家媒体字段（不改变规则数值；同一房间内按 playerId 查）。 */
  private sheetWithMedia(room: RoomRecord, sheet: SheetView): SheetView {
    const media = this.mediaOfPlayer(room, sheet.playerId);
    if (media === undefined) return sheet;
    return { ...sheet, identity: { ...sheet.identity, ...media } };
  }

  /** 给战棋 token 补头像 URL（玩家落座上传过头像才有；敌人/中立没有）。 */
  private combatWithMedia(room: RoomRecord, combat: CombatView): CombatView {
    if (combat.tokens.length === 0) return combat;
    let changed = false;
    const tokens = combat.tokens.map((token) => {
      const media = token.playerId !== undefined ? this.mediaOfPlayer(room, token.playerId) : undefined;
      if (media?.avatarUrl === undefined) return token;
      changed = true;
      return { ...token, avatarUrl: media.avatarUrl };
    });
    return changed ? { ...combat, tokens } : combat;
  }

  private emit<K extends GameEvent['kind'], P>(room: RoomRecord, kind: K, to: EventTarget, payload: P): GameEvent<K, P> {
    const event: GameEvent = {
      v: PROTOCOL_VERSION,
      kind,
      seq: ++room.seq,
      at: this.now(),
      to,
      payload,
    };
    room.events.push(event);
    if (room.events.length > this.maxEvents) room.events.splice(0, room.events.length - this.maxEvents);
    for (const listener of [...room.listeners]) {
      if (visibleTo(listener.principal, event)) {
        try {
          listener.notify(event);
        } catch {
          /* 单个连接异常不影响广播 */
        }
      }
    }
    try {
      this.onChanged?.();
    } catch {
      /* 存档回调失败不影响广播 */
    }
    return event as GameEvent<K, P>;
  }

  private closeListenersOf(room: RoomRecord, playerId: PlayerId, message: string): void {
    for (const listener of [...room.listeners]) {
      if (listener.principal.kind !== 'player' || listener.principal.playerId !== playerId) continue;
      try {
        listener.notify({
          v: PROTOCOL_VERSION,
          kind: 'alert',
          seq: room.seq,
          at: this.now(),
          to: playerId,
          payload: { level: 'error', text: message, close: true } satisfies AlertPayload & { close: boolean },
        });
      } catch {
        /* ignore */
      }
      room.listeners.delete(listener);
    }
  }
}

/** 从座位卡原始数据里读展示名（旧 engine 卡 `identity.name` / 新卡实例 `fields.name`）。 */
function readRuleCardName(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as { identity?: { name?: unknown }; fields?: { name?: unknown } };
  const legacyName = record.identity?.name;
  if (typeof legacyName === 'string' && legacyName.length > 0) return legacyName;
  const fieldName = record.fields?.name;
  return typeof fieldName === 'string' && fieldName.length > 0 ? fieldName : undefined;
}

/** 解析结果 → 房间记录里的内容引用（派生场景只留公开字段）。 */
function contentStateFromModule(module: RoomContentModule): RoomContentState {
  return {
    packId: module.packId,
    packVersion: module.packVersion,
    moduleId: module.moduleId,
    contentHash: module.contentHash,
    ...(module.packName !== undefined ? { packName: module.packName } : {}),
    moduleTitle: module.moduleTitle,
    scenes: module.scenes.map((scene) => ({ sceneId: scene.sceneId, title: scene.title })),
  };
}

function cloneContentState(content: RoomContentState): RoomContentState {
  return { ...content, scenes: content.scenes.map((scene) => ({ ...scene })) };
}

/** 存档里的内容引用（深拷贝，避免存档与运行时状态共享引用）。 */
function snapshotContentOf(content: RoomContentState): RoomSnapshotContent {
  return cloneContentState(content);
}

export type { GameEvent, RoomView };
