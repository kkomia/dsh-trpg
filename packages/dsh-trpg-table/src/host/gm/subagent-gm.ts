/**
 * AI GM 的 subagent 通道（M3 实机验证后的正式方案）。
 *
 * 为什么不用「插件自建会话」：实机验证发现，插件自行创建的会话发起 DeepSeek 请求会
 * TRANSPORT 失败；而 DSH 自带 subagent 通道的子 Agent（继承宿主会话的请求上下文）正常。
 * 因此每个玩家行动 = 一次 subagent 激活，GM 上下文由本模块每回合组装。
 *
 * 工具以全局注册、按 childId→roomId 路由（AsyncLocalStorage 传递当前 child）。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PlayerActionInfo, RoomService } from '@dsh-trpg/rooms';
import { buildGmSystemPrompt, buildTurnPrompt, type PromptEvent, type PromptPlayer } from './prompt.ts';
import { createGmTools } from './tools.ts';
import { CombatRuntime } from './combat.ts';
import { eventToPromptEvent, type GmContentResolver } from './runtime.ts';

export interface LiveAgentLike {
  id: string;
}

export interface SubagentsLike {
  startActivation(spec: {
    provider: string;
    label?: string;
    name?: string;
    childId?: string;
    prompt: unknown;
    parent: unknown;
    delivery?: 'parent' | 'caller';
    signal?: AbortSignal;
    agentOptions?: Record<string, unknown>;
  }): Promise<{ childId: string; result?: Promise<unknown>; dispose?: () => void | Promise<void> }>;
}

export interface SubagentGmOptions {
  subagents: SubagentsLike;
  roomService: RoomService;
  /** 按房间解析当前模组/世界书（host 注入 pack registry）。 */
  resolveContent: GmContentResolver;
  /** 选择一个宿主活跃会话作为子 Agent 的父会话（可给多个候选，池满时轮换）。 */
  getParents: () => LiveAgentLike[];
  log?: (message: string) => void;
  /** ctx.tools.register（全局注册 GM 工具，插件级 effect）。 */
  registerTool: (definition: unknown) => unknown;
}

interface RoomChannel {
  combat: CombatRuntime;
  queue: Promise<void>;
  parentId?: string;
}

interface ActivationRoomContext {
  roomId: string;
}

/**
 * childId→roomId 的**进程级**注册表：GM 工具可能由上一次 HMR 世代注册，
 * 用 globalThis 共享映射，避免「工具包装器与新管理器不是同一实例」导致找不到房间。
 */
const CHILD_ROOMS_KEY = '__DSH_TRPG_CHILD_ROOMS__';
function childRoomRegistry(): Map<string, string> {
  const holder = globalThis as unknown as Record<string, Map<string, string> | undefined>;
  const existing = holder[CHILD_ROOMS_KEY];
  if (existing) return existing;
  const created = new Map<string, string>();
  holder[CHILD_ROOMS_KEY] = created;
  return created;
}

/** 从 subagent 激活结果里取叙事文本。 */
export function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (!result || typeof result !== 'object') return '';
  const obj = result as { output?: unknown; text?: unknown; message?: unknown; structured?: unknown };
  for (const candidate of [obj.output, obj.text, obj.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (Array.isArray(candidate)) {
      const text = candidate
        .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object')
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text).trim())
        .filter(Boolean)
        .join('\n\n');
      if (text) return text;
    }
    if (candidate && typeof candidate === 'object') {
      const nested = (candidate as { content?: unknown }).content;
      if (Array.isArray(nested)) {
        const text = nested
          .filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === 'object')
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text).trim())
          .filter(Boolean)
          .join('\n\n');
        if (text) return text;
      }
    }
  }
  return '';
}

export class SubagentGmManager {
  private readonly options: SubagentGmOptions;
  private readonly rooms = new Map<string, RoomChannel>();
  private readonly childRoom = new Map<string, string>();
  private readonly als = new AsyncLocalStorage<ActivationRoomContext>();
  private readonly activeActivations = new Set<() => void | Promise<void>>();
  private toolsRegistered = false;
  /**
   * 工具名加世代后缀：HMR 热重载时旧世代的同名工具可能仍留在注册表里，
   * 后缀保证模型调用的是本轮注册、绑定当前房间服务的那个包装器。
   */
  private readonly toolSuffix = `_${randomBytes(3).toString('hex')}`;
  private readonly toolNames: Record<string, string> = Object.fromEntries(
    ['roll_check', 'roll_dice', 'secret_note', 'reveal_lore', 'check_lore', 'list_party', 'start_combat', 'attack', 'next_turn', 'combat_status', 'end_combat'].map(
      (name) => [name, `${name}${this.toolSuffix}`],
    ),
  );

  constructor(options: SubagentGmOptions) {
    this.options = options;
  }

  /** 注册全局 GM 工具：按当前 childId 解析房间。 */
  registerTools(): void {
    if (this.toolsRegistered) return;
    this.toolsRegistered = true;
    const manager = this;
    const roomOf = (): string => {
      const context = manager.als.getStore();
      if (!context) throw new Error('GM 工具只能在 AI 回合内调用');
      return context.roomId;
    };
    const definitions = createGmTools({
      roomService: this.options.roomService,
      roomId: roomOf,
      // 每条工具调用时按房间解析世界书（不同房间可能引用不同内容包）。
      lorebook: () => this.options.resolveContent(roomOf()).lorebook,
      combat: () => manager.rooms.get(roomOf())?.combat,
    });
    for (const definition of definitions) {
      const wrapped = {
        ...definition,
        name: `${definition.name}${this.toolSuffix}`,
        execute: (args: Record<string, unknown>, exec?: { agent?: { session?: { id?: string } } }) => {
          const childId = exec?.agent?.session?.id;
          const globalRooms = childRoomRegistry();
          let roomId = childId ? (globalRooms.get(childId) ?? manager.childRoom.get(childId)) : manager.childRoom.get(childId ?? '');
          if (!roomId) {
            // 子 Agent 的会话 id 与激活 childId 未必一致：单回合在飞时直接路由到那个房间。
            const activeRooms = [...new Set([...globalRooms.values(), ...manager.childRoom.values()])];
            if (activeRooms.length === 1) roomId = activeRooms[0];
          }
          if (!roomId) {
            throw new Error(
              `GM 工具调用找不到对应房间（child=${childId ?? 'none'}；在飞房间=${[...new Set([...globalRooms.values(), ...manager.childRoom.values()])].join(',') || 'none'}）`,
            );
          }
          return manager.als.run({ roomId }, () => definition.execute(args));
        },
      };
      try {
        this.options.registerTool(wrapped);
      } catch (error) {
        this.options.log?.(`GM tool register failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 房间创建/恢复：准备战斗运行时；只有新建房间才自动开场（续团房间等玩家行动）。 */
  ensureRoom(roomId: string, options: { opening?: boolean } = {}): void {
    if (this.rooms.has(roomId)) return;
    const { module, lorebook } = this.options.resolveContent(roomId);
    const channel: RoomChannel = {
      combat: new CombatRuntime({ roomService: this.options.roomService, roomId, log: this.options.log }),
      queue: Promise.resolve(),
    };
    this.rooms.set(roomId, channel);
    this.options.roomService.gmNarrate(roomId, `AI 主持人已就位。《${module.title}》即将开始。`);
    if (options.opening === false) return;
    const opening = [
      buildGmSystemPrompt(module, lorebook, this.toolNames),
      '',
      '---',
      '',
      '【开场】游戏开始。请朗读模组第一幕的开场，用 2–6 句把玩家引入剧情；',
      '不要替任何玩家角色写行动或台词，结尾抛出一个需要玩家回应的情境。',
    ].join('\n');
    this.enqueue(roomId, opening);
  }

  onPlayerAction(info: PlayerActionInfo): void {
    if (!this.rooms.has(info.roomId)) return;
    this.enqueue(info.roomId, this.buildTurnText(info));
  }

  /** 组装一次行动的用户消息（系统守则 + 当前行动）。 */
  buildTurnText(info: PlayerActionInfo): string {
    const { roomService, resolveContent } = this.options;
    const { module, lorebook } = resolveContent(info.roomId);
    const room = roomService.gmView(info.roomId);
    const party: PromptPlayer[] = roomService.gmParty(info.roomId).map((player) => ({
      playerId: player.playerId,
      name: player.name,
      characterName: player.character?.identity.name,
      characterClass: player.character?.identity.class,
      level: player.character?.identity.level,
      hp: player.character?.combat.hpMax,
      hpMax: player.character?.combat.hpMax,
      ac: player.character?.combat.ac,
      publicSummary: player.character?.publicSummary,
    }));
    const recent = roomService
      .gmRecentEvents(info.roomId, 12)
      .map(eventToPromptEvent)
      .filter((event): event is PromptEvent => event !== null);
    const turn = buildTurnPrompt({
      module,
      roomTitle: room.title,
      actor: { playerName: info.playerName, characterName: info.characterName },
      actionText: info.text,
      private: info.private,
      party,
      recent,
    });
    return `${buildGmSystemPrompt(module, lorebook, this.toolNames)}\n\n---\n\n${turn}`;
  }

  private enqueue(roomId: string, promptText: string): void {
    const channel = this.rooms.get(roomId);
    if (!channel) return;
    channel.queue = channel.queue
      .then(() => this.runTurn(roomId, promptText))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`GM subagent turn failed: ${message}`);
        try {
          this.options.roomService.gmAlert(roomId, `AI GM 这回合没接上（${message}），再发一次试试。`, 'warning');
        } catch {
          /* 房间可能已关闭 */
        }
      });
  }

  private async runTurn(roomId: string, promptText: string): Promise<void> {
    const channel = this.rooms.get(roomId);
    const candidates = this.options.getParents();
    if (candidates.length === 0) throw new Error('没有可用的宿主会话作为 GM 父会话（请先在 DSH 里打开任意会话）');
    // 优先复用上次成功的父会话；池满（active child limit）时轮换下一个父会话。
    const ordered = channel?.parentId
      ? [...candidates].sort((a, b) => (a.id === channel.parentId ? -1 : b.id === channel.parentId ? 1 : 0))
      : candidates;
    let lastError: unknown;
    for (const parent of ordered) {
      const childId = randomUUID();
      const calledChildIds: string[] = [childId];
      this.childRoom.set(childId, roomId);
      // 关键：子 Agent 在 startActivation 返回前就可能开始执行工具调用，
      // 所以映射必须在调用**之前**写入进程级注册表。
      childRoomRegistry().set(childId, roomId);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180000);
        if (typeof timer.unref === 'function') timer.unref();
        let activation;
        try {
          activation = await this.options.subagents.startActivation({
            provider: 'spawn',
            label: 'trpg-gm',
            name: `gm-${childId.slice(0, 8)}`,
            childId,
            prompt: [{ type: 'text', text: promptText }],
            parent,
            delivery: 'caller',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (channel) channel.parentId = parent.id;
        // 用激活返回的真实 childId 建立进程级映射（工具调用时的 session id 以此为准）。
        const actualChildId = (activation as { childId?: string }).childId ?? childId;
        const globalRooms = childRoomRegistry();
        globalRooms.set(childId, roomId);
        globalRooms.set(actualChildId, roomId);
        this.childRoom.set(actualChildId, roomId);
        calledChildIds.push(actualChildId);
        const result = await (activation.result ?? Promise.resolve(undefined));
        const text = extractResultText(result);
        if (text) this.options.roomService.gmNarrate(roomId, text);
        else this.options.roomService.gmAlert(roomId, 'AI GM 这回合没有产出叙事。', 'warning');
        const disposer = () => activation.dispose?.();
        this.activeActivations.add(disposer);
        try {
          await disposer();
        } catch {
          /* ignore */
        } finally {
          this.activeActivations.delete(disposer);
        }
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const poolFull = /limit|active child|ACTIVATION_LIMIT|busy/i.test(message);
        this.options.log?.(`GM subagent turn failed on parent ${parent.id}: ${message}${poolFull ? '（轮换父会话）' : ''}`);
        if (!poolFull) throw error;
      } finally {
        const globalRooms = childRoomRegistry();
        for (const id of calledChildIds) {
          this.childRoom.delete(id);
          globalRooms.delete(id);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'GM 回合失败'));
  }

  /** 是否是本通道创建的子 Agent（父会话选择时排除）。 */
  isChild(sessionId: string): boolean {
    return this.childRoom.has(sessionId);
  }

  /** 房间关闭时清理运行时。 */
  closeRoom(roomId: string): void {
    this.rooms.delete(roomId);
  }

  async dispose(): Promise<void> {
    const pending = [...this.activeActivations];
    this.activeActivations.clear();
    this.rooms.clear();
    this.childRoom.clear();
    await Promise.allSettled(pending.map((dispose) => Promise.resolve(dispose())));
  }
}
