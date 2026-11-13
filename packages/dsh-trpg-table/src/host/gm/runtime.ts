/**
 * AI GM 运行时：为每个房间创建一个 DSH Agent 会话，把玩家行动喂给 GM，
 * 再把 GM 的叙事文本广播回房间。
 *
 * 依赖全部以接口注入（createAgent / roomService / module / lorebook），
 * 因此可以用假 Agent 在单测里跑完整编排，而真实实现在 host/index.ts 里对接 DSH。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LorebookDef, ModuleDef } from '@dsh-trpg/content';
import type { GameEvent } from '@dsh-trpg/protocol';
import type { PlayerActionInfo, RoomService } from '@dsh-trpg/rooms';
import { buildGmSystemPrompt, buildTurnPrompt, type PromptEvent, type PromptPlayer } from './prompt.ts';
import { createGmTools } from './tools.ts';
import { CombatRuntime } from './combat.ts';

/** DSH Agent 的结构化最小面（不 import Harness 包，保持第三方插件可安装）。 */
export interface GmAgentCtxLike {
  tools: { register(definition: unknown): () => void };
  systemPrompt: {
    section(section: unknown): () => void;
    suppressRuntimeContext?(): () => void;
  };
}

export interface GmAgentLike {
  followup(input: { content: Array<{ type: 'text'; text: string }>; source: { kind: string } }): void | Promise<void>;
  whenIdle?(): Promise<void>;
}

export interface GmHandleLike {
  agent: GmAgentLike;
  dispose(): void | Promise<void>;
  /** 实际使用的模型路线（诊断用，例如 deepseek-account/deepseek-flash）。 */
  route?: string;
  /** 真实会话 id（平台可能自己创建会话，例如 sessionController 路径）。 */
  sessionId?: string;
}

export type GmCreateAgent = (options: {
  sessionId: string;
  setup: (agentCtx: GmAgentCtxLike) => void;
}) => Promise<GmHandleLike>;

export interface GmRuntimeOptions {
  roomId: string;
  roomService: RoomService;
  module: ModuleDef;
  lorebook: LorebookDef;
  createAgent: GmCreateAgent;
  log?: (message: string) => void;
}

/** 一条 assistant 消息里提取纯文本（忽略 reasoning / tool-call 块）。 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text?: string } => typeof block === 'object' && block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
    .trim();
}

/** 房间事件 → GM 可读的一行摘要（用于「最近事件」）。 */
export function eventToPromptEvent(event: GameEvent): PromptEvent | null {
  switch (event.kind) {
    case 'narration': {
      const payload = event.payload as { speaker: string; speakerName?: string; text: string };
      return { seq: event.seq, kind: '叙事', to: event.to, text: `${payload.speakerName ?? (payload.speaker === 'gm' ? 'GM' : '玩家')}：${payload.text}` };
    }
    case 'dice': {
      const payload = event.payload as {
        expression: string;
        dice: number[];
        modifier: number;
        total: number;
        label?: string;
        rollerName: string;
        check?: { name: string; dc: number; success: boolean };
      };
      const check = payload.check ? `（${payload.check.name} DC ${payload.check.dc} → ${payload.check.success ? '成功' : '失败'}）` : '';
      return {
        seq: event.seq,
        kind: '掷骰',
        to: event.to,
        text: `${payload.rollerName} ${payload.label ?? payload.expression}：${payload.expression} = ${payload.total}${check}`,
      };
    }
    case 'alert': {
      const payload = event.payload as { text: string };
      return { seq: event.seq, kind: '系统', to: event.to, text: payload.text };
    }
    case 'room':
      return null;
    default:
      return { seq: event.seq, kind: event.kind, to: event.to, text: JSON.stringify(event.payload).slice(0, 120) };
  }
}

export class GmRuntime {
  readonly roomId: string;
  private _sessionId: string;
  readonly combat: CombatRuntime;
  private handle: GmHandleLike | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly options: GmRuntimeOptions;
  private lastEventSeq = 0;

  get sessionId(): string {
    return this._sessionId;
  }

  constructor(options: GmRuntimeOptions) {
    this.options = options;
    this.roomId = options.roomId;
    this._sessionId = randomUUID();
    this.combat = new CombatRuntime({ roomService: options.roomService, roomId: options.roomId, log: options.log });
  }

  /** 创建 GM 会话并注册该 Agent 专属的工具与系统提示。 */
  async start(): Promise<void> {
    const { module, lorebook, createAgent, roomService, roomId, log } = this.options;
    const debugDir = process.env.DSH_TRPG_DEBUG_DIR ?? 'D:\\gitlab\\dsh-trpg\\.tmp';
    const bare = existsSync(join(debugDir, 'gm-bare.flag'));
    const systemPrompt = buildGmSystemPrompt(module, lorebook);
    this.handle = await createAgent({
      sessionId: this.sessionId,
      setup: (agentCtx) => {
        if (!bare) {
          for (const tool of createGmTools({ roomService, roomId, lorebook, combat: this.combat })) {
            agentCtx.tools.register(tool);
          }
          agentCtx.systemPrompt.section({
            name: 'trpg-gm',
            order: 900,
            complete: true,
            interpolate: false,
            text: () => systemPrompt,
          });
        }
        try {
          agentCtx.systemPrompt.suppressRuntimeContext?.();
        } catch {
          /* 老版本没有这个能力时忽略 */
        }
      },
    });
    if (bare) {
      try {
        roomService.gmAlert(roomId, '调试模式：裸 GM Agent（无工具/无系统提示）', 'warning');
      } catch {
        /* ignore */
      }
    }
    if (this.handle.sessionId) this._sessionId = this.handle.sessionId;
    log?.(`GM agent started for room ${roomId} (session ${this.sessionId})${this.handle.route ? ` model=${this.handle.route}` : ''}`);
    try {
      this.options.roomService.gmAlert(this.roomId, `GM 会话已就绪${this.handle.route ? `（模型 ${this.handle.route}）` : '（未取到默认模型）'}`, 'info');
    } catch {
      /* ignore */
    }
  }

  /** 开局：让 GM 朗读场景一开头（AI GM 模式下建房后自动触发）。 */
  notifyOpening(): void {
    if (this.disposed) return;
    this.queue = this.queue
      .then(async () => {
        if (this.disposed || !this.handle) return;
        const prompt = [
          '【开场】游戏开始。请朗读模组第一幕的开场，用 2–6 句把玩家引入剧情；',
          '不要替任何玩家角色写行动或台词，结尾抛出一个需要玩家回应的情境。',
        ].join('');
        await this.handle.agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } });
        await this.handle.agent.whenIdle?.();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`GM opening failed: ${message}`);
      });
  }

  /** 玩家行动入队：串行喂给 GM，避免多人同时行动把对话搅乱。 */
  notifyPlayerAction(info: PlayerActionInfo): void {
    if (this.disposed) return;
    this.queue = this.queue
      .then(async () => {
        if (this.disposed || !this.handle) return;
        const prompt = this.buildTurnPrompt(info);
        await this.handle.agent.followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } });
        await this.handle.agent.whenIdle?.();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`GM turn failed: ${message}`);
        try {
          this.options.roomService.gmAlert(this.roomId, `AI GM 这回合没接上（${message}），再发一次试试。`, 'warning');
        } catch {
          /* 房间可能已关闭 */
        }
      });
  }

  /** 拼一次行动的 prompt（公开方法便于单测断言）。 */
  buildTurnPrompt(info: PlayerActionInfo): string {
    const { module, roomService, roomId } = this.options;
    const room = roomService.gmView(roomId);
    const party: PromptPlayer[] = roomService.gmParty(roomId).map((player) => ({
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
      .gmRecentEvents(roomId, 12)
      .map(eventToPromptEvent)
      .filter((event): event is PromptEvent => event !== null);
    return buildTurnPrompt({
      module,
      roomTitle: room.title,
      actor: { playerName: info.playerName, characterName: info.characterName },
      actionText: info.text,
      private: info.private,
      party,
      recent,
    });
  }

  /** DSH 会话事件 → 把 GM 的叙事广播到房间。 */
  onSessionEvent(event: { type: string; data?: unknown; seq?: number }): void {
    if (this.disposed) return;
    if (event.type !== 'gm-error' && typeof event.seq === 'number') {
      if (event.seq <= this.lastEventSeq) return;
      this.lastEventSeq = event.seq;
    }
    if (event.type === 'gm-error') {
      const data = event.data as { message?: string } | undefined;
      const message = data?.message ?? 'unknown';
      this.options.log?.(`GM agent error: ${message}`);
      try {
        this.options.roomService.gmAlert(this.roomId, `AI GM 出错：${message}`, 'error');
      } catch {
        /* ignore */
      }
      return;
    }
    if (event.type !== 'assistant/message') return;
    const data = event.data as { message?: unknown } | undefined;
    const text = extractAssistantText(data?.message);
    if (!text) return;
    try {
      this.options.roomService.gmNarrate(this.roomId, text);
    } catch (error) {
      this.options.log?.(`GM narration broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 等待当前队列里的 GM 回合处理完（测试与优雅关闭用）。 */
  async whenIdle(): Promise<void> {
    await this.queue;
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.queue;
    } catch {
      /* 已在队列里处理 */
    }
    try {
      await this.handle?.dispose();
    } catch {
      /* 已卸载 */
    }
    this.handle = null;
  }
}

export interface GmManagerOptions {
  roomService: RoomService;
  module: ModuleDef;
  lorebook: LorebookDef;
  createAgent: GmCreateAgent;
  log?: (message: string) => void;
}

/** 房间 → GM 运行时；会话事件按 sessionId 路由回对应房间。 */
export class GmManager {
  private readonly runtimes = new Map<string, GmRuntime>();
  private readonly bySession = new Map<string, GmRuntime>();
  private readonly options: GmManagerOptions;

  constructor(options: GmManagerOptions) {
    this.options = options;
  }

  /** 房间创建后调用；AI GM 模式才会起会话。失败只影响 AI，不影响房间本身。 */
  async ensureRoom(roomId: string): Promise<void> {
    if (this.runtimes.has(roomId)) return;
    let mode: string;
    try {
      mode = this.options.roomService.gmModeOf(roomId);
    } catch {
      return;
    }
    if (mode !== 'ai') return;
    const runtime = new GmRuntime({
      roomId,
      roomService: this.options.roomService,
      module: this.options.module,
      lorebook: this.options.lorebook,
      createAgent: this.options.createAgent,
      log: this.options.log,
    });
    this.runtimes.set(roomId, runtime);
    try {
      await runtime.start();
      this.bySession.set(runtime.sessionId, runtime);
      this.options.roomService.gmNarrate(roomId, `AI 主持人已就位。《${this.options.module.title}》即将开始。`);
      runtime.notifyOpening();
    } catch (error) {
      this.runtimes.delete(roomId);
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`GM agent start failed for room ${roomId}: ${message}`);
      try {
        this.options.roomService.gmAlert(roomId, `AI GM 启动失败：${message}`, 'error');
      } catch {
        /* ignore */
      }
    }
  }

  /** 向所有 AI 房间广播一条系统提示（账号/服务级故障用）。 */
  broadcastAlert(text: string, level: 'info' | 'warning' | 'error' = 'warning'): void {
    for (const runtime of this.runtimes.values()) {
      try {
        this.options.roomService.gmAlert(runtime.roomId, text, level);
      } catch {
        /* 房间可能已关闭 */
      }
    }
  }

  onPlayerAction(info: PlayerActionInfo): void {
    const runtime = this.runtimes.get(info.roomId);
    if (!runtime) return;
    runtime.notifyPlayerAction(info);
  }

  onSessionEvent(sessionId: string, event: { type: string; data?: unknown; seq?: number }): void {
    this.bySession.get(sessionId)?.onSessionEvent(event);
  }

  /** 当前活跃的 GM 会话 id（诊断/测试用）。 */
  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }

  async dispose(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.bySession.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
  }
}
