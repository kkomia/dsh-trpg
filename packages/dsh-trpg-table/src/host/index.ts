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
import {
  GmManager,
  type GmAgentCtxLike,
  type GmCreateAgent,
  type GmHandleLike,
} from './gm/runtime.ts';

export const name = 'dsh-trpg-table';

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
  agents?: {
    create(options: { sessionId: string; setup: (agentCtx: GmAgentCtxLike) => void }): Promise<GmHandleLike>;
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
  const service = new RoomService({
    onRoomCreated: (roomId) => {
      void managerRef.current?.ensureRoom(roomId);
    },
    onPlayerAction: (info) => {
      managerRef.current?.onPlayerAction(info);
    },
  });

  let http: RoomHttpServer;
  try {
    http = createRoomHttpServer({ port, bindHost, log, service });
  } catch (error) {
    log(`room server init failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const createAgent: GmCreateAgent = async ({ sessionId, setup }) => {
    if (!ctx.agents) throw new Error('当前 DSH 没有 agents 服务，无法启动 AI GM');
    return ctx.agents.create({ sessionId, setup });
  };

  const manager = new GmManager({
    roomService: service,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log,
  });
  managerRef.current = manager;

  const offSessionEvent = ctx.on?.('session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: string } | undefined;
    const event = args[1] as { type?: string; data?: unknown } | undefined;
    if (!session?.id || !event?.type) return;
    manager.onSessionEvent(session.id, { type: event.type, data: event.data });
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
    } catch {
      /* ignore */
    }
    void manager.dispose();
    void http.close();
  });
}
