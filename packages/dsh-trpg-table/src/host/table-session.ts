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
import {
  buildActionContext,
  buildGmSystemPrompt,
  currentSceneIndex,
  loreContextOfScene,
} from './gm/prompt.ts';
import { createGmTools } from './gm/tools.ts';
import { CombatRuntime } from './gm/combat.ts';
import { eventToPromptEvent, extractAssistantText } from './gm/runtime.ts';
import { revealedLoreIds } from './gm/lore-reveal.ts';

/** 会话原生牌桌的内容解析：按房间取当前模组/世界书（host 注入 pack registry）。 */
export type TableContentResolver = (roomId: string) => { module: ModuleDef; lorebook: LorebookDef };

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
  /** 按房间解析当前模组/世界书（房间只存 packId/moduleId 引用）。 */
  resolveContent: TableContentResolver;
  /** 按会话 id 取当前存活的 Agent（没有说明会话没打开）。 */
  getAgent: (sessionId: string) => TableAgentLike | undefined;
  /** 把一段文本作为用户消息送进会话。 */
  prompt: (sessionId: string, text: string) => Promise<void>;
  /**
   * 玩家行动注入会话前的旁路回调（M7 镜像投影用：登记 injectedText，把会话
   * user/message 认领成「谁的公开/私密行动」）。抛错不影响注入。
   */
  onActionInjected?: (roomId: string, info: PlayerActionInfo, injectedText: string) => void;
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
      const gmTools = createGmTools({
        roomService: this.deps.roomService,
        roomId,
        // 每次工具调用时按房间解析世界书/模组：房间可能引用数据目录里的其他内容包。
        lorebook: () => this.deps.resolveContent(roomId).lorebook,
        module: () => this.deps.resolveContent(roomId).module,
        combat,
        // 有规则运行时才注册通用规则工具；无运行时保留旧工具（兼容旧房间）。
        includeGenericTools: this.deps.roomService.runtimeOf(roomId) !== undefined,
        // 工具返回文本里的命令提示也用真实注册名（映射在注册循环里回填）。
        toolNames: () => toolNames,
      });
      for (const tool of gmTools) {
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
          // 每次渲染时解析：内容包重扫/房间降级回退/场景推进后，GM 提示自动跟上。
          text: () => {
            const { module, lorebook } = this.deps.resolveContent(roomId);
            let sceneId: string | undefined;
            try {
              sceneId = this.deps.roomService.gmView(roomId).scene?.sceneId;
            } catch {
              sceneId = undefined;
            }
            return buildGmSystemPrompt(module, lorebook, toolNames, {
              // 以「实际注册了通用工具」为准，避免提示里列出没注册的工具。
              hasRulesRuntime: toolNames.use_action !== undefined,
              loreContext: loreContextOfScene(module, sceneId, revealedLoreIds(roomId)),
            });
          },
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
   * 消息里附「本轮 GM 幕后备注」：当前场景的模组数据（判定/遭遇/奖励/节拍）+ 按行动检索到的
   * 世界书条目——原生会话的历史不随房间场景变化，所以每轮单独注入（玩家不可见，只是模型输入）。
   * @param roomId - 房间 id。
   * @param info - 房间服务提供的玩家行动。
   */
  promptAction(roomId: string, info: PlayerActionInfo): void {
    const binding = this.bindings.get(roomId);
    if (!binding) return;
    const who = info.characterName ?? info.playerName;
    const tag = info.private ? '（悄悄话给 GM）' : '';
    const base = `【${who}】${info.text}${tag}`;
    const text = `${base}${this.actionContextBlock(roomId, info)}`;
    try {
      this.deps.onActionInjected?.(roomId, info, text);
    } catch (error) {
      this.deps.log?.(`table session action mirror note failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    void this.deps.prompt(binding.sessionId, text).catch((error: unknown) => {
      this.deps.log?.(`table session prompt failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        this.deps.roomService.gmAlert(roomId, `AI GM 回复失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      } catch {
        /* ignore */
      }
    });
  }

  /** 本轮行动附带的 GM 幕后备注（模组场景数据 + 检索到的世界书）；没有内容时返回空串。 */
  private actionContextBlock(roomId: string, info: PlayerActionInfo): string {
    try {
      const { module, lorebook } = this.deps.resolveContent(roomId);
      const room = this.deps.roomService.gmView(roomId);
      const sceneIndex = currentSceneIndex(module, room.scene?.sceneId);
      const hasRulesRuntime = this.deps.roomService.runtimeOf(roomId) !== undefined;
      const recentActions = this.deps.roomService
        .gmRecentEvents(roomId, 8)
        .map(eventToPromptEvent)
        .filter((event): event is NonNullable<typeof event> => event !== null)
        .map((event) => event.text);
      const context = buildActionContext({
        module,
        lorebook,
        sceneIndex,
        ...(room.scene?.sceneId !== undefined ? { sceneId: room.scene.sceneId } : {}),
        actionText: info.text,
        recentActions,
        revealedIds: revealedLoreIds(roomId),
        hasRulesRuntime,
      });
      if (context.text.length === 0) return '';
      return `\n\n---\n\n【本轮 GM 幕后备注（玩家不可见，不要原样朗读）】\n${context.text}`;
    } catch (error) {
      this.deps.log?.(`table session context failed: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
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
