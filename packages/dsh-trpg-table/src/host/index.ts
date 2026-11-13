/**
 * 跑团桌 Host 半边（M3）：局域网房间服务 + AI GM。
 *
 * - HTTP + SSE，绑 0.0.0.0（默认 45871），独立于 DSH Web 端口；
 * - 房间状态机在 @dsh-trpg/rooms；
 * - AI GM：建房后创建 DSH Agent 会话，玩家行动串行喂给 GM，GM 的叙事广播回房间；
 *   GM 的工具在这里执行引擎结算（掷骰/检定/私密消息/世界书）。
 */
import { GUIMUYA_LOREBOOK, GUIMUYA_MODULE } from '@dsh-trpg/content';
import { RoomService } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from './room-http.ts';
import { RoomPersistence } from './persistence.ts';
import {
  GmManager,
  type GmAgentCtxLike,
  type GmCreateAgent,
  type GmHandleLike,
} from './gm/runtime.ts';

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
}

/** DSH Host 上下文的结构化最小面（不 import Harness 包，保持插件可独立安装）。 */
export interface HostCtxLike {
  effect(fn: () => () => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
  /** Cordis 的嵌套注入：只在依赖可用时回调，插件本身无需声明硬依赖。 */
  inject?(deps: string[], callback: (scoped: AgentsScope) => void | (() => void)): () => void;
  agents?: AgentsScope['agents'];
}

export interface AgentsScope {
  agents: {
    create(options: {
      sessionId: string;
      setup: (agentCtx: GmAgentCtxLike) => void;
      agentOptions?: { provider: string; model: string; reasoningEffort?: string };
    }): Promise<GmHandleLike>;
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
  const persistence = new RoomPersistence({ log });
  let restoredRooms: string[] = [];
  const service = new RoomService({
    onRoomCreated: (roomId) => {
      void managerRef.current?.ensureRoom(roomId);
    },
    onPlayerAction: (info) => {
      managerRef.current?.onPlayerAction(info);
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

  // 惰性获取 agents / 默认模型服务：插件不声明硬依赖，缺服务时只是 AI GM 起不来。
  let agentsService: AgentsScope['agents'] | null = null;
  let defaultModel: ModelScope['agentDefaultModel'] | null = null;
  ctx.inject?.(['agents'], (scoped) => {
    agentsService = scoped.agents;
    log('agents service acquired: AI GM enabled');
    return () => {
      agentsService = null;
    };
  });
  ctx.inject?.(['agentDefaultModel'], (scoped) => {
    defaultModel = (scoped as unknown as ModelScope).agentDefaultModel ?? null;
    return () => {
      defaultModel = null;
    };
  });

  const createAgent: GmCreateAgent = async ({ sessionId, setup }) => {
    if (!agentsService) throw new Error('当前 DSH 没有 agents 服务，无法启动 AI GM');
    const selection = defaultModel?.currentSelection?.();
    const agentOptions = selection ? { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } : undefined;
    // 不显式传模型时，DSH 可能拒绝发起第一次请求（没有 model selection），所以优先用宿主默认模型。
    return agentsService.create({ sessionId, setup, ...(agentOptions ? { agentOptions } : {}) });
  };

  const manager = new GmManager({
    roomService: service,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log,
  });
  managerRef.current = manager;

  // 恢复的 AI 房间要重新拉起 GM 会话（上下文从存档事件继续）。
  for (const roomId of restoredRooms) {
    void manager.ensureRoom(roomId);
  }

  const offSessionEvent = ctx.on?.('session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined;
    const event = args[1] as { type?: string; data?: unknown } | undefined;
    if (!session?.id || !event?.type) return;
    manager.onSessionEvent(session.id, { type: event.type, data: event.data });
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
    } catch {
      /* ignore */
    }
    try {
      persistence.close();
    } catch {
      /* ignore */
    }
    void manager.dispose();
    void http.close();
  });
}
