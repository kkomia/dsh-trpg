/**
 * 跑团桌 Host 半边（M2）：把房间服务开到局域网。
 *
 * - HTTP + SSE，绑 0.0.0.0（默认端口 45871），独立于 DSH Web 端口；
 * - 房间状态机在 @dsh-trpg/rooms，AI GM 编排（M3）与存档（M4）会接在这里。
 */
import { createRoomHttpServer, type RoomHttpServer } from './room-http.ts';

export const name = 'dsh-trpg-table';

const DEFAULT_PORT = 45871;
const DEFAULT_HOST = '0.0.0.0';

export interface TrpgConfig {
  /** 监听端口；默认 45871。 */
  port?: number;
  /** 监听地址；默认 0.0.0.0（局域网可访问）。 */
  bindHost?: string;
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

export function apply(ctx: { effect: (fn: () => () => void) => void }, config: TrpgConfig = {}): void {
  const port = config.port ?? readPort();
  const bindHost = config.bindHost ?? DEFAULT_HOST;
  let http: RoomHttpServer;
  try {
    http = createRoomHttpServer({ port, bindHost, log });
  } catch (error) {
    log(`room server init failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  http.server.on('error', (error: NodeJS.ErrnoException) => {
    log(`room server error on ${bindHost}:${port}: ${error.code ?? ''} ${error.message}`);
  });
  http.server.listen(port, bindHost, () => {
    log(`room server listening on http://${bindHost}:${port}`);
  });

  ctx.effect(() => () => {
    log('room server stopping');
    void http.close();
  });
}
