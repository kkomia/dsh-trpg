/**
 * 房间状态机（M2）：账号、玩家席、事件日志、可见性投影。
 *
 * 这一层不碰 HTTP/SSE，所以可以被单测直接驱动；HTTP 只是它的薄适配层。
 * 关键安全性质（对应 DESIGN §4 的五道锁）：
 * - token → principal 由服务端解析，客户端不能自称身份；
 * - 事件在「广播前」按 principal 投影，私密信息不会发到别人手上；
 * - GM（房主）看到全部事件，包括私骰与悄悄话；
 * - 只有房主能 kick/lock；邀请码只回给房主。
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
  validateCreateRoom,
  validateJoin,
  validateRoll,
  validateSay,
  type AlertPayload,
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
  type RoomListResult,
  type RoomPhase,
  type RoomSceneSummary,
  type RoomStateResult,
  type RoomView,
  type RollParams,
  type RollResult,
  type RpcError,
  type SayParams,
  type SayResult,
  type ScenePayload,
  type AwardPayload,
  type Seq,
} from '@dsh-trpg/protocol';

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;

export class RoomError extends Error {
  readonly code: RpcError['code'];
  constructor(code: RpcError['code'], message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
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
    players: Array<{
      id: string;
      name: string;
      token: string;
      seat: 'gm' | 'player';
      character?: CharacterCard;
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

  constructor(options: RoomServiceOptions = {}) {
    this.maxRooms = options.maxRooms ?? 8;
    this.maxEvents = options.maxEvents ?? 5000;
    this.now = options.now ?? Date.now;
    this.onPlayerAction = options.onPlayerAction;
    this.onRoomCreated = options.onRoomCreated;
    this.onRoomClosed = options.onRoomClosed;
    this.onChanged = options.onChanged;
    this.content = options.content;
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
    let character: CharacterCard | undefined;
    if (params.characterCard !== undefined) {
      character = this.parseCard(params.characterCard);
      player.character = character;
    }
    room.players.set(player.id, player);
    this.tokens.set(player.token, { kind: 'player', roomId: room.id, playerId: player.id });
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
    const params = rawParams as { characterCard?: unknown };
    if (!params || params.characterCard === undefined) throw new RoomError('bad-request', '缺少角色卡');
    const card = this.parseCard(params.characterCard);
    if (principal.kind === 'player') {
      const player = room.players.get(principal.playerId);
      if (!player) throw new RoomError('unauthorized', '你不在这个房间');
      player.character = card;
      player.seat = 'player';
      this.emit(room, 'alert', 'all', {
        level: 'info',
        text: `${player.name} 落座：${card.identity.name}`,
      } satisfies AlertPayload);
    } else {
      // 房主落座 = 以 GM 身份占一个席位（AI GM 模式下房主也可以当玩家，M3 再细化）
      const hostPlayer: PlayerRecord = {
        id: 'host',
        name: '房主',
        token: room.hostToken,
        seat: 'gm',
        character: card,
        joinedAt: this.now(),
        connections: 1,
      };
      room.players.set('host', hostPlayer);
      this.emit(room, 'alert', 'all', {
        level: 'info',
        text: `房主落座：${card.identity.name}`,
      } satisfies AlertPayload);
    }
    this.emit(room, 'room', 'all', this.publicView(room));
    return { room: this.viewFor(room, principal) };
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
          characterName: player.character?.identity.name,
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
        players: [...room.players.values()].map((player) => ({
          id: player.id,
          name: player.name,
          token: player.token,
          seat: player.seat,
          ...(player.character ? { character: player.character } : {}),
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
      players.set(player.id, {
        id: player.id,
        name: player.name,
        token: player.token,
        seat: player.seat,
        ...(player.character ? { character: player.character } : {}),
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

  private parseCard(input: unknown): CharacterCard {
    const report = validateCharacterCard(input);
    if (!report.ok || !report.value) {
      throw new RoomError('invalid-card', `角色卡校验失败：${report.errors.join('；')}`);
    }
    return report.value;
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
    return {
      roomId: room.id,
      title: room.title,
      ...(room.sessionId ? { sessionId: room.sessionId } : {}),
      phase: room.phase,
      gmMode: room.gmMode,
      locked: room.locked,
      ...(room.scene ? { scene: room.scene } : {}),
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
