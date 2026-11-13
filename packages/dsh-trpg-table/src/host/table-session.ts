/**
 * 会话原生牌桌桥：把房间绑定到房主正在使用的 DSH 会话（「对话即牌桌」）。
 *
 * 与 subagent GM 的区别：
 * - GM 就是这个会话的 Agent：住客的系统提示段（GM 人格 + 模组 + 硬规则）注册在会话 Agent 上；
 * - 玩家行动 → `sessionController.prompt` 注入为会话里的用户消息，AI 的原生回复就是 GM 叙事；
 * - 会话里每条 assistant 文本再作为 GM 旁白广播回房间（玩家端/战报用）。
 *
 * 注意（本机实测）：只有**正在被 DSH 页面驱动（live）**的会话才能完成模型请求；
 * 由插件新建/恢复的会话会 `DeepSeek Messages transport failed`。所以绑定要求会话已打开。
 */
import type { LorebookDef, ModuleDef } from '@dsh-trpg/content';
import type { PlayerActionInfo, RoomService } from '@dsh-trpg/rooms';
import { buildGmSystemPrompt } from './gm/prompt.ts';
import { createGmTools } from './gm/tools.ts';
import { CombatRuntime } from './gm/combat.ts';
import { extractAssistantText } from './gm/runtime.ts';

/** 牌桌工具名前缀：避开 subagent GM 的全局同名工具。 */
const TABLE_TOOL_PREFIX = 'trpg_';

/** 会话 Agent 的最小结构面（不 import Harness 包）。 */
export interface TableAgentLike {
  id: string;
  ctx: {
    tools: { register(definition: unknown): () => void };
    systemPrompt: { section(section: unknown): () => void };
  };
}

export interface TableSessionDeps {
  roomService: RoomService;
  module: ModuleDef;
  lorebook: LorebookDef;
  /** 按会话 id 取当前存活的 Agent（没有说明会话没打开）。 */
  getAgent: (sessionId: string) => TableAgentLike | undefined;
  /** 把一段文本作为用户消息送进会话。 */
  prompt: (sessionId: string, text: string) => Promise<void>;
  log?: (message: string) => void;
}

interface Binding {
  roomId: string;
  sessionId: string;
  dispose: () => void;
}

export class TableSessionBridge {
  private readonly bindings = new Map<string, Binding>();
  private readonly sessionRooms = new Map<string, string>();
  private readonly deps: TableSessionDeps;

  constructor(deps: TableSessionDeps) {
    this.deps = deps;
  }

  /** 该会话是否被某个房间绑定为牌桌。 */
  isBoundSession(sessionId: string): boolean {
    return this.sessionRooms.has(sessionId);
  }

  /** 房间绑定的会话 id。 */
  sessionOfRoom(roomId: string): string | undefined {
    return this.bindings.get(roomId)?.sessionId;
  }

  /**
   * 把房间绑定到一个会话：在会话 Agent 上注册 GM 提示段与 GM 工具。
   * @param roomId - 房间 id。
   * @param sessionId - 会话 id。
   * @returns ok 或可读失败原因（例如会话未打开）。
   */
  bind(roomId: string, sessionId: string): { ok: true } | { ok: false; error: string } {
    const existing = this.bindings.get(roomId);
    if (existing?.sessionId === sessionId) return { ok: true };
    if (existing) this.unbind(roomId);

    const agent = this.deps.getAgent(sessionId);
    if (!agent) {
      return {
        ok: false,
        error: '这个会话当前没有活动的 AI（可能没有在 DSH 里打开）。请先打开该会话再开团。',
      };
    }

    const disposers: Array<() => void> = [];
    try {
      const combat = new CombatRuntime({ roomService: this.deps.roomService, roomId, log: this.deps.log });
      // 工具名加前缀：避免与 subagent GM 的全局工具（带 generation 后缀/同名）冲突，
      // 同时把映射交给系统提示，保证 GM 看到的就是实际注册的名字。
      const toolNames: Record<string, string> = {};
      for (const tool of createGmTools({ roomService: this.deps.roomService, roomId, lorebook: this.deps.lorebook, combat })) {
        const definition = tool as { name?: unknown };
        if (typeof definition.name !== 'string') continue;
        const prefixed = { ...(tool as unknown as Record<string, unknown>), name: `${TABLE_TOOL_PREFIX}${definition.name}` };
        toolNames[definition.name] = `${TABLE_TOOL_PREFIX}${definition.name}`;
        disposers.push(agent.ctx.tools.register(prefixed));
      }
      disposers.push(
        agent.ctx.systemPrompt.section({
          name: `trpg-gm-${roomId}`,
          order: 900,
          complete: false,
          interpolate: false,
          text: () => buildGmSystemPrompt(this.deps.module, this.deps.lorebook, toolNames),
        }),
      );
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      return { ok: false, error: `注册 GM 提示/工具失败：${error instanceof Error ? error.message : String(error)}` };
    }

    const binding: Binding = {
      roomId,
      sessionId,
      dispose: () => {
        for (const dispose of disposers.reverse()) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
      },
    };
    this.bindings.set(roomId, binding);
    this.sessionRooms.set(sessionId, roomId);
    this.deps.log?.(`table session bound: room=${roomId} session=${sessionId}`);
    return { ok: true };
  }

  /** 解绑房间（房间关闭/换会话时调用）。 */
  unbind(roomId: string): void {
    const binding = this.bindings.get(roomId);
    if (!binding) return;
    this.bindings.delete(roomId);
    this.sessionRooms.delete(binding.sessionId);
    binding.dispose();
    this.deps.log?.(`table session unbound: room=${roomId} session=${binding.sessionId}`);
  }

  /**
   * 玩家行动入会话：注入为一条用户消息，由会话 Agent（GM）原生回复。
   * @param roomId - 房间 id。
   * @param info - 房间服务提供的玩家行动。
   */
  promptAction(roomId: string, info: PlayerActionInfo): void {
    const binding = this.bindings.get(roomId);
    if (!binding) return;
    const who = info.characterName ?? info.playerName;
    const tag = info.private ? '（悄悄话给 GM）' : '';
    const text = `【${who}】${info.text}${tag}`;
    void this.deps.prompt(binding.sessionId, text).catch((error: unknown) => {
      this.deps.log?.(`table session prompt failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        this.deps.roomService.gmAlert(roomId, `AI GM 回复失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      } catch {
        /* ignore */
      }
    });
  }

  /**
   * 会话事件 → 房间：把 AI 的回复作为 GM 旁白广播（玩家端/战报可见）。
   * @param sessionId - 事件所属会话。
   * @param type - 会话事件类型。
   * @param data - 事件数据。
   */
  onSessionEvent(sessionId: string, type: string | undefined, data: unknown): void {
    if (!type) return;
    const roomId = this.sessionRooms.get(sessionId);
    if (!roomId) return;
    if (type === 'assistant/message') {
      const text = extractAssistantText((data as { message?: unknown } | undefined)?.message);
      if (text.length > 0) {
        try {
          this.deps.roomService.gmNarrate(roomId, text);
        } catch {
          /* 房间可能已关闭 */
        }
      }
      return;
    }
    if (type === 'turn/end') {
      const reason = (data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
      if (reason && reason.kind !== 'completed') {
        try {
          this.deps.roomService.gmAlert(roomId, `AI GM 回合异常结束：${reason.kind}${reason.error?.message ? `（${reason.error.message}）` : ''}`, 'error');
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** 插件卸载时释放全部绑定。 */
  dispose(): void {
    for (const roomId of [...this.bindings.keys()]) this.unbind(roomId);
  }
}
