/**
 * 跑团桌 Host 半边（M3）：局域网房间服务 + AI GM。
 *
 * - HTTP + SSE，绑 0.0.0.0（默认 45871），独立于 DSH Web 端口；
 * - 房间状态机在 @dsh-trpg/rooms；
 * - AI GM：建房后创建 DSH Agent 会话，玩家行动串行喂给 GM，GM 的叙事广播回房间；
 *   GM 的工具在这里执行引擎结算（掷骰/检定/私密消息/世界书）。
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GUIMUYA_LOREBOOK, GUIMUYA_MODULE } from '@dsh-trpg/content';
import { RoomService } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from './room-http.ts';
import { RoomPersistence } from './persistence.ts';
import { GmManager, type GmAgentCtxLike, type GmCreateAgent, type GmHandleLike } from './gm/runtime.ts';
import { SubagentGmManager, type SubagentsLike } from './gm/subagent-gm.ts';

export const name = 'dsh-trpg-table';

/**
 * agents 是 AI GM 的可选依赖：用 ctx.inject 惰性获取，DSH 没有该服务时
 * 房间/联机功能照常工作，只是 AI GM 模式会给出「无法启动」提示。
 */

const DEFAULT_PORT = 45871;
const DEFAULT_HOST = '0.0.0.0';

export interface TrpgConfig {
  /** 监听端口；默认 45871。 */
  port?: number;
  /** 监听地址；默认 0.0.0.0（局域网可访问）。 */
  bindHost?: string;
  /** 同时存在的房间上限；默认 8。 */
  maxRooms?: number;
}

/** DSH Host 上下文的结构化最小面（不 import Harness 包，保持插件可独立安装）。 */
export interface HostCtxLike {
  effect(fn: () => () => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
  /** Cordis 的嵌套注入：只在依赖可用时回调，插件本身无需声明硬依赖。 */
  inject?(deps: string[], callback: (scoped: unknown) => void | (() => void)): () => void;
}

export interface ToolsScope {
  tools: { register(definition: unknown): unknown };
}

export interface SubagentsScope {
  subagents: SubagentsLike;
}

export interface SessionControllerScope {
  sessionController: {
    create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
    resolveAgent(sessionId: string): Promise<{
      agent?: {
        id: string;
        ctx: GmAgentCtxLike;
        followup?(input: { content: Array<{ type: string; text: string }>; source: { kind: string } }): void | Promise<void>;
        whenIdle?(): Promise<void>;
      };
    } | { error?: unknown }>;
    prompt?(request: {
      requestId: string;
      sessionId: string;
      mode: 'queue' | 'steer';
      content: Array<{ type: string; text: string }>;
    }): Promise<{ accepted: boolean }>;
    selectModel?(request: {
      sessionId: string;
      provider: string;
      model: string;
      reasoningEffort?: string;
    }): Promise<{ selected?: unknown }>;
    cancel?(request: { sessionId: string }): unknown;
  };
}

export interface AgentsScope {
  agents: {
    create(options: {
      sessionId: string;
      setup: (agentCtx: GmAgentCtxLike) => void;
      agentOptions?: { provider: string; model: string; reasoningEffort?: string };
      meta?: { cwd?: string; parentSession?: string; isSeeded?: boolean; origin?: 'subagent'; delegationDepth?: number; agentPreset?: string };
    }): Promise<GmHandleLike>;
    list?(): Array<{ id: string }>;
  };
}

export interface ModelScope {
  agentDefaultModel?: {
    currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined;
  };
}

function log(message: string): void {
  console.log(`[dsh-trpg-table] ${message}`);
}

function readPort(): number {
  const raw = process.env.DSH_TRPG_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

export function apply(ctx: HostCtxLike, config: TrpgConfig = {}): void {
  const port = config.port ?? readPort();
  const bindHost = config.bindHost ?? DEFAULT_HOST;

  const managerRef: { current: GmManager | null } = { current: null };
  const subagentRef: { current: SubagentGmManager | null } = { current: null };
  const persistence = new RoomPersistence({ log });
  let restoredRooms: string[] = [];
  const service = new RoomService({
    maxRooms: config.maxRooms ?? 8,
    onRoomCreated: (roomId) => {
      if (subagentRef.current) subagentRef.current.ensureRoom(roomId);
      else void managerRef.current?.ensureRoom(roomId);
    },
    onPlayerAction: (info) => {
      if (subagentRef.current) subagentRef.current.onPlayerAction(info);
      else managerRef.current?.onPlayerAction(info);
    },
    onChanged: () => persistence.schedule(),
  });

  // 续团：先从磁盘恢复上一轮 DSH 的房间，再启动 HTTP 服务。
  try {
    const restored = persistence.restoreInto(service);
    persistence.attach(service);
    if (restored > 0) {
      restoredRooms = service.snapshotAll().map((snapshot) => snapshot.room.id);
      log(`restored ${restored} room(s) from disk`);
    }
  } catch (error) {
    log(`room restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let http: RoomHttpServer;
  try {
    http = createRoomHttpServer({ port, bindHost, log, service });
  } catch (error) {
    log(`room server init failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // 惰性获取 agents / 默认模型 / 会话控制器：插件不声明硬依赖，缺服务时只是 AI GM 起不来。
  let agentsService: AgentsScope['agents'] | null = null;
  let defaultModel: ModelScope['agentDefaultModel'] | null = null;
  let sessionController: SessionControllerScope['sessionController'] | null = null;
  let toolsService: ToolsScope['tools'] | null = null;
  let subagentsService: SubagentsLike | null = null;
  ctx.inject?.(['tools'], (scoped) => {
    toolsService = (scoped as ToolsScope).tools ?? null;
    queueMicrotask(() => setupSubagentGm());
    return () => {
      toolsService = null;
    };
  });
  ctx.inject?.(['subagents'], (scoped) => {
    subagentsService = (scoped as SubagentsScope).subagents ?? null;
    queueMicrotask(() => setupSubagentGm());
    return () => {
      subagentsService = null;
    };
  });
  ctx.inject?.(['agents'], (scoped) => {
    agentsService = (scoped as AgentsScope).agents;
    log('agents service acquired: AI GM enabled');
    return () => {
      agentsService = null;
    };
  });
  ctx.inject?.(['agentDefaultModel'], (scoped) => {
    defaultModel = (scoped as ModelScope).agentDefaultModel ?? null;
    return () => {
      defaultModel = null;
    };
  });
  ctx.inject?.(['sessionController'], (scoped) => {
    sessionController = (scoped as SessionControllerScope).sessionController ?? null;
    log('sessionController acquired: GM 会话将走普通会话通道');
    return () => {
      sessionController = null;
    };
  });

  const gmSessionIds = new Set<string>();
  const turnWaiters = new Map<string, Array<() => void>>();

  /** 统一的会话事件处理：drerelease waiters、上报错误、转发给对应 GM 房间。 */
  const forwardSessionEvent = (args: unknown[]): void => {
    const session = args[0] as { id?: string } | undefined;
    const event = args[1] as { type?: string; data?: unknown; seq?: number } | undefined;
    if (!session?.id || !event?.type) return;
    if (event.type === 'turn/end') {
      const waiters = turnWaiters.get(session.id);
      if (waiters) {
        turnWaiters.delete(session.id);
        for (const resolve of waiters) resolve();
      }
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
      if (reason && reason.kind !== 'completed') {
        forwardSessionError(session.id, `回合结束原因：${reason.kind}${reason.error?.message ? `（${reason.error.message}）` : ''}`);
      }
    }
    managerRef.current?.onSessionEvent(session.id, { type: event.type, data: event.data, seq: event.seq });
  };

  /** 同一会话短时间内的重复错误只播报一次（根监听 + agent.ctx 监听可能各收到一份）。 */
  const recentErrorKeys = new Map<string, number>();
  const forwardSessionError = (sessionId: string, message: string): void => {
    const key = `${sessionId}:${message}`;
    const now = Date.now();
    const last = recentErrorKeys.get(key) ?? 0;
    if (now - last < 5000) return;
    recentErrorKeys.set(key, now);
    if (recentErrorKeys.size > 200) recentErrorKeys.clear();
    managerRef.current?.onSessionEvent(sessionId, { type: 'gm-error', data: { message } });
  };

  const attachSessionListener = (agentCtx: unknown): (() => void) => {
    const ctxLike = agentCtx as { on?: (event: string, listener: (...args: unknown[]) => void) => () => void } | undefined;
    try {
      return ctxLike?.on?.('session/event', (...args: unknown[]) => forwardSessionEvent(args)) ?? (() => {});
    } catch {
      return () => {};
    }
  };
  const createAgent: GmCreateAgent = async ({ sessionId, setup }) => {
    const debugDir = process.env.DSH_TRPG_DEBUG_DIR ?? 'D:\\gitlab\\dsh-trpg\\.tmp';
    const forceOff = existsSync(join(debugDir, 'gm-effort-off.flag'));
    const providerOverrideFile = join(debugDir, 'gm-provider.flag');
    const providerOverride = existsSync(providerOverrideFile)
      ? (await import('node:fs')).readFileSync(providerOverrideFile, 'utf8').trim()
      : '';
    const selection = defaultModel?.currentSelection?.();
    const effective = selection
      ? { provider: providerOverride || selection.provider, model: selection.model }
      : providerOverride
        ? { provider: providerOverride, model: 'deepseek-flash' }
        : undefined;
    const effort = forceOff ? 'off' : selection?.reasoningEffort;
    const routeBase = effective
      ? `${effective.provider}/${effective.model}${effort ? `@${effort}` : ''}${forceOff ? ' [debug-off]' : ''}`
      : 'default';

    // 首选：走 Web UI 同款的普通会话通道（sessionController），模型请求上下文完整。
    if (sessionController) {
      const created = await sessionController.create({});
      const resolved = await sessionController.resolveAgent(created.sessionId);
      const agent = (resolved as { agent?: { id: string; ctx: GmAgentCtxLike; followup?: unknown; whenIdle?: () => Promise<void> } }).agent;
      if (!agent) throw new Error('sessionController 无法解析 GM 会话的 Agent');
      // UI 新建会话的流程：先显式选模型，再注册工具/提示词，再 prompt。
      if (effective && sessionController.selectModel) {
        try {
          await sessionController.selectModel({
            sessionId: created.sessionId,
            provider: effective.provider,
            model: effective.model,
            ...(effort ? { reasoningEffort: effort } : {}),
          });
        } catch (error) {
          log(`GM selectModel failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      setup(agent.ctx);
      const offAgentSession = attachSessionListener(agent.ctx);
      const controller = sessionController;
      const sid = created.sessionId;
      const liveAgent = agent as unknown as {
        followup?: (input: { content: Array<{ type: string; text: string }>; source: { kind: string } }) => void | Promise<void>;
        whenIdle?: () => Promise<void>;
      };
      gmSessionIds.add(sid);
      return {
        sessionId: sid,
        route: `${routeBase} [sessionController]`,
        agent: {
          followup: async (input) => {
            if (typeof liveAgent.followup === 'function') {
              await liveAgent.followup(input);
              return;
            }
            if (controller.prompt) {
              await controller.prompt({ requestId: randomUUID(), sessionId: sid, mode: 'queue', content: input.content });
            }
          },
          whenIdle: async () => {
            if (typeof liveAgent.whenIdle === 'function') {
              await liveAgent.whenIdle();
              return;
            }
            await new Promise<void>((resolve) => {
              const list = turnWaiters.get(sid) ?? [];
              list.push(resolve);
              turnWaiters.set(sid, list);
              setTimeout(resolve, 90000);
            });
          },
        },
        dispose: () => {
          turnWaiters.delete(sid);
          try {
            offAgentSession();
          } catch {
            /* ignore */
          }
          try {
            sessionController?.cancel?.({ sessionId: sid });
          } catch {
            /* ignore */
          }
        },
      };
    }

    // 回退：直接创建 Agent（旧路径；模型传输可能不可用，故仅作兜底）。
    if (!agentsService) throw new Error('当前 DSH 没有可用的 Agent 服务，无法启动 AI GM');
    const agentOptions = effective
      ? { provider: effective.provider, model: effective.model, ...(effort ? { reasoningEffort: effort } : {}) }
      : undefined;
    const handle = await agentsService.create({ sessionId, setup, ...(agentOptions ? { agentOptions } : {}) });
    gmSessionIds.add(sessionId);
    const offAgentSession = attachSessionListener((handle.agent as { ctx?: unknown }).ctx);
    return {
      ...handle,
      route: `${routeBase} [agents]`,
      dispose: async () => {
        offAgentSession();
        await handle.dispose();
      },
    };
  };

  /**
   * 首选 AI GM 后端：DSH subagent 通道（子 Agent 继承宿主会话的模型请求上下文）。
   * 依赖 tools/subagents/agents 三个服务都就绪后才会启用。
   */
  function setupSubagentGm(): void {
    if (subagentRef.current || !subagentsService || !toolsService || !agentsService) return;
    const subagentManager: SubagentGmManager = new SubagentGmManager({
      subagents: subagentsService,
      roomService: service,
      module: GUIMUYA_MODULE,
      lorebook: GUIMUYA_LOREBOOK,
      getParents: (): Array<{ id: string }> => {
        const live: Array<{ id: string }> = agentsService?.list?.() ?? [];
        return live.filter((agent) => !gmSessionIds.has(agent.id) && !subagentManager.isChild(agent.id));
      },
      log,
      registerTool: (definition) => toolsService?.register(definition),
    });
    subagentManager.registerTools();
    subagentRef.current = subagentManager;
    log('subagent GM channel ready');
    for (const roomId of restoredRooms) subagentManager.ensureRoom(roomId, { opening: false });
  }

  const manager = new GmManager({
    roomService: service,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log,
  });
  managerRef.current = manager;
  setupSubagentGm();

  // 恢复的 AI 房间：subagent 通道优先，否则拉起 GM 会话。
  for (const roomId of restoredRooms) {
    void manager.ensureRoom(roomId);
  }

  const offSessionEvent = ctx.on?.('session/event', (...args: unknown[]) => {
    forwardSessionEvent(args);
  });

  const offAgentError = ctx.on?.('agent/error', (...args: unknown[]) => {
    const payload = args[0] as { agent?: { id?: string }; turn?: number; step?: number; error?: unknown } | undefined;
    const sessionId = payload?.agent?.id;
    if (!sessionId) return;
    const error = payload?.error as { message?: string; code?: string; status?: number; requestId?: string } | undefined;
    const message = error
      ? `${error.message ?? String(error)}${error.code ? ` [${error.code}]` : ''}${error.status ? ` HTTP ${error.status}` : ''}`
      : String(payload?.error ?? 'unknown');
    manager.onSessionEvent(sessionId, { type: 'gm-error', data: { message, turn: payload?.turn, step: payload?.step } });
  });

  const offSignIn = ctx.on?.('deepseek-account/model-sign-in-required', () => {
    manager.broadcastAlert('DeepSeek 账号需要重新登录（设置 → 账号），登录后 AI GM 才能继续。', 'error');
  });

  const offSessionError = ctx.on?.('api-session/error', (...args: unknown[]) => {
    const sessionId = args[0] as string | undefined;
    const message = String(args[1] ?? 'unknown');
    if (sessionId) manager.onSessionEvent(sessionId, { type: 'gm-error', data: { message } });
  });

  http.server.on('error', (error: NodeJS.ErrnoException) => {
    log(`room server error on ${bindHost}:${port}: ${error.code ?? ''} ${error.message}`);
  });
  http.server.listen(port, bindHost, () => {
    log(`room server listening on http://${bindHost}:${port}`);
  });

  ctx.effect(() => () => {
    log('room server stopping');
    try {
      offSessionEvent?.();
      offAgentError?.();
      offSignIn?.();
      offSessionError?.();
    } catch {
      /* ignore */
    }
    try {
      persistence.close();
    } catch {
      /* ignore */
    }
    void subagentRef.current?.dispose();
    void manager.dispose();
    void http.close();
  });
}
