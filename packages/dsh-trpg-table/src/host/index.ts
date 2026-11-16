/**
 * 跑团桌 Host 半边（M3）：局域网房间服务 + AI GM。
 *
 * - HTTP + SSE，绑 0.0.0.0（默认 45871），独立于 DSH Web 端口；
 * - 房间状态机在 @dsh-trpg/rooms；
 * - AI GM：建房后创建 DSH Agent 会话，玩家行动串行喂给 GM，GM 的叙事广播回房间；
 *   GM 的工具在这里执行引擎结算（掷骰/检定/私密消息/世界书）。
 */
import { randomUUID } from 'node:crypto';
import { RoomError, RoomService } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from './room-http.ts';
import { RoomPersistence } from './persistence.ts';
import { PackRegistry } from './pack-registry.ts';
import { MediaService, RoomAssetStore } from './media/index.ts';
import { createStudio } from './studio/index.ts';
import { GmManager, type GmAgentCtxLike, type GmCreateAgent, type GmHandleLike, type GmContentResolver } from './gm/runtime.ts';
import { SubagentGmManager, type SubagentsLike } from './gm/subagent-gm.ts';
import { resetRevealedLore } from './gm/lore-reveal.ts';
import { TableSessionBridge } from './table-session.ts';

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
    }, signal?: AbortSignal): Promise<{ accepted: boolean }>;
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
    get?(id: string): { id: string; ctx: GmAgentCtxLike } | undefined;
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
  /** 内容包注册表：host 是内容权威，房间只按 {packId, moduleId} 引用。 */
  const registry = new PackRegistry({ log });
  /**
   * M9.5d 生图服务（`assets.generate`）：配置来自环境变量，没配置时给可读中文错误；
   * 开发/离线验证可用 `DSH_TRPG_MEDIA_FAKE=1`（等同 `--fake`）。
   */
  const media = new MediaService({ log });
  if (media.configured()) log(`media service ready (provider=${media.providerName})`);
  /** M9.5d 房间资产存储（`assets.upload` + `GET /trpg/room-assets/...`，与房间存档同父目录）。 */
  const roomAssets = new RoomAssetStore({ log });
  /**
   * M9.5e 工坊服务：地图/世界结构生成（AI 文本草稿 → 校验 → 程序化兜底）+ AI 底图 +
   * 内容包工坊 RPC（`pack.detail/update/export/import/assetPut/assetDelete`，全部仅 loopback+host token）。
   * 与生图服务共用同一套 OpenAI 兼容环境变量；`DSH_TRPG_MEDIA_FAKE=1` 时底图走内置假生成器。
   */
  const studio = createStudio({ registry, log });
  try {
    const loaded = registry.reload();
    log(`content packs ready: ${loaded.packs} pack(s)${loaded.warnings.length > 0 ? `, ${loaded.warnings.length} warning(s)` : ''}`);
  } catch (error) {
    // 注册表加载失败不应该拖垮房间服务：内置包已尽量加载，房间按降级内容开局。
    log(`content pack registry load failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  /** 会话原生牌桌桥（房间 ↔ DSH 会话）；服务就绪后创建。 */
  let tableBridge: TableSessionBridge | null = null;
  const service = new RoomService({
    maxRooms: config.maxRooms ?? 8,
    content: registry,
    // M9.4：内容包带 rules 段时房间自动建规则运行时（包内脚本源码由注册表解析）。
    rules: registry,
    onRoomCreated: (roomId, sessionId) => {
      // 会话原生牌桌：绑定会话后不再起 subagent GM（AI 就是会话 Agent）。
      if (sessionId && tableBridge) {
        void bindTableSession(roomId, sessionId);
        return;
      }
      if (subagentRef.current) subagentRef.current.ensureRoom(roomId);
      else void managerRef.current?.ensureRoom(roomId);
    },
    onPlayerAction: (info) => {
      // 绑定会话的房间：玩家行动直接进会话，由会话 Agent（AI GM）原生回复。
      if (tableBridge?.sessionOfRoom(info.roomId)) {
        tableBridge.promptAction(info.roomId, info);
        return;
      }
      if (subagentRef.current) subagentRef.current.onPlayerAction(info);
      else managerRef.current?.onPlayerAction(info);
    },
    onRoomClosed: (roomId) => {
      tableBridge?.unbind(roomId);
      // M8.4：本场「已揭示世界书」登记随房间一起释放。
      resetRevealedLore(roomId);
    },
    onChanged: () => persistence.schedule(),
  });

  /**
   * 按房间解析内容：房间只存 `{packId, moduleId}`，内容始终从注册表取。
   * 包缺失/降级（房间内容不可用）时回退到缺省内置包，保证 GM 提示不卡死。
   */
  const resolveGmContent: GmContentResolver = (roomId) => {
    let packId: string | undefined;
    let moduleId: string | undefined;
    try {
      const content = service.gmContent(roomId);
      packId = content.packId;
      moduleId = content.moduleId;
    } catch {
      /* 房间可能已关闭：走缺省包 */
    }
    const chosen =
      (packId ? registry.resolveLegacy(packId, moduleId) : undefined) ?? registry.resolveLegacy(registry.defaultPackId);
    if (!chosen) throw new Error('没有可用的内容包（内置包加载失败），无法启动 GM');
    return { module: chosen.module, lorebook: chosen.lorebook };
  };

  tableBridge = new TableSessionBridge({
    roomService: service,
    resolveContent: resolveGmContent,
    getAgent: (sessionId) => agentsService?.get?.(sessionId),
    prompt: async (sessionId, text) => {
      const controller = sessionController as unknown as {
        prompt?: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
      } | null;
      if (typeof controller?.prompt !== 'function') throw new Error('sessionController.prompt 不可用');
      await controller.prompt.call(
        controller,
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      );
    },
    log,
  });

  /**
   * 绑定房间到会话：先注册 GM 提示段/工具，成功后再写进房间状态；失败给出可见提示。
   * @param roomId - 房间 id。
   * @param sessionId - 会话 id。
   */
  const bindTableSession = async (roomId: string, sessionId: string): Promise<void> => {
    if (!tableBridge) return;
    const result = tableBridge.bind(roomId, sessionId);
    if (!result.ok) {
      log(`bind table session failed: ${result.error}`);
      try {
        service.gmAlert(roomId, result.error, 'error');
      } catch {
        /* 房间可能已关闭 */
      }
      return;
    }
    try {
      service.bindSession(roomId, sessionId);
      service.gmAlert(roomId, '牌桌已绑定到当前会话：AI GM 会直接在这里回话。', 'info');
    } catch (error) {
      log(`bind table session state failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };


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
    http = createRoomHttpServer({
      port,
      bindHost,
      log,
      service,
      contentCatalog: () => registry.publicCatalog(),
      // 只读资产端点：内容包 zip 里的 assets/** 由注册表按需提供（M9.5b）。
      assetOf: (packId, assetPath) => registry.assetOf(packId, assetPath),
      // M9.5d：玩家展示资产——生图（预览候选）与房间资产区（落座上传/无 token 只读）。
      media,
      roomAssets,
      // M9.5e：地图/世界生成 + 内容包工坊（loopback + host token 在 room-http 里校验）。
      studio,
      contentReload: () => {
        const reloaded = registry.reload();
        let recoveredRooms = 0;
        try {
          recoveredRooms = service.revalidateContent().recovered;
        } catch (error) {
          log(`content revalidate failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { ...reloaded, ...(recoveredRooms > 0 ? { recoveredRooms } : {}) };
      },
      bindSession: async (roomId, sessionId) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          tableBridge?.unbind(roomId);
          return { room: service.bindSession(roomId, null) };
        }
        const result = tableBridge ? tableBridge.bind(roomId, sessionId) : { ok: false as const, error: '牌桌桥未就绪' };
        if (!result.ok) throw new RoomError('bad-request', result.error);
        const room = service.bindSession(roomId, sessionId);
        try {
          service.gmAlert(roomId, '牌桌已绑定到这个会话：AI GM 会直接在这里回话。', 'info');
        } catch {
          /* ignore */
        }
        return { room };
      },
    });
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
    // 续团：恢复存档里已绑定会话的房间，在 Agent 服务就绪后重新挂上。
    for (const roomId of restoredRooms) {
      const sessionId = service.sessionOf(roomId);
      if (sessionId) void bindTableSession(roomId, sessionId);
    }
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
    tableBridge?.onSessionEvent(session.id, event.type, event.data);
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
    const selection = defaultModel?.currentSelection?.();
    const effective = selection ? { provider: selection.provider, model: selection.model } : undefined;
    const effort = selection?.reasoningEffort;
    const routeBase = effective ? `${effective.provider}/${effective.model}${effort ? `@${effort}` : ''}` : 'default';

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
      resolveContent: resolveGmContent,
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
    for (const roomId of restoredRooms) {
      if (service.sessionOf(roomId)) continue;
      subagentManager.ensureRoom(roomId, { opening: false });
    }
  }

  const manager = new GmManager({
    roomService: service,
    resolveContent: resolveGmContent,
    createAgent,
    log,
  });
  managerRef.current = manager;
  setupSubagentGm();

  // 恢复的 AI 房间：会话原生牌桌优先（绑定已由 agents 注入时完成重挂），其余走 subagent/旧 GM 通道。
  for (const roomId of restoredRooms) {
    if (service.sessionOf(roomId)) continue;
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
    tableBridge?.dispose();
    void subagentRef.current?.dispose();
    void manager.dispose();
    void http.close();
  });
}
