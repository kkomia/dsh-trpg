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
  type RoomStateResult,
  type RoomView,
  type RollParams,
  type RollResult,
  type RpcError,
  type SayParams,
  type SayResult,
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
  /** 房间创建完成回调（启动 AI GM 运行时用）。 */
  onRoomCreated?: (roomId: string) => void;
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
  private readonly onRoomCreated?: (roomId: string) => void;

  constructor(options: RoomServiceOptions = {}) {
    this.maxRooms = options.maxRooms ?? 8;
    this.maxEvents = options.maxEvents ?? 5000;
    this.now = options.now ?? Date.now;
    this.onPlayerAction = options.onPlayerAction;
    this.onRoomCreated = options.onRoomCreated;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  createRoom(rawParams: unknown): CreateRoomResult {
    const params = this.parse(validateCreateRoom(rawParams));
    if (this.rooms.size >= this.maxRooms) {
      throw new RoomError('conflict', '房间数已达上限，请先关闭一个房间');
    }
    const room: RoomRecord = {
      id: randomUUID(),
      title: params.title,
      gmMode: params.gmMode,
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
    try {
      this.onRoomCreated?.(room.id);
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
    return {
      roomId: room.id,
      title: room.title,
      phase: room.phase,
      gmMode: room.gmMode,
      locked: room.locked,
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

export type { GameEvent, RoomView };
