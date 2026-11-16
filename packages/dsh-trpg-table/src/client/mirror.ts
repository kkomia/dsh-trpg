/**
 * 玩家侧镜像的客户端数据层（M7，浏览器 bundle）：只做同源 fetch 与文案映射，
 * **不 import 任何 node/host 模块**（client bundle 不能引入 host 服务）。
 *
 * 接口由本机插件 host 挂在 DSH Web 服务器上（`/api/dsh-trpg-table/mirror`）：
 * - `start` 入房后启动镜像（幂等）；
 * - `status` 轮询状态（未加入/连接中/已连接 N 条/错误）；
 * - `stop` 退房/关房时停止。
 */

/** 本机镜像控制接口前缀（与 host/local-api.ts 保持一致）。 */
export const MIRROR_API_PATH = '/api/dsh-trpg-table/mirror';

/** 镜像状态视图（host 返回的结构化摘要，全部字段可缺省）。 */
export interface MirrorStatusView {
  state?: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'stopped' | 'unavailable' | string;
  roomId?: string;
  roomTitle?: string;
  sessionId?: string;
  synced?: number;
  lastSeq?: number;
  error?: string;
}

/** 启动镜像的入参（从 localStorage 会话 + 房间视图拼出）。 */
export interface MirrorStartInput {
  base: string;
  roomId: string;
  token: string;
  playerName?: string;
  roomTitle?: string;
}

/** 客户端镜像接口。 */
export interface MirrorApi {
  start(input: MirrorStartInput): Promise<MirrorStatusView>;
  status(roomId?: string): Promise<MirrorStatusView>;
  stop(roomId?: string): Promise<MirrorStatusView>;
}

/** 本机镜像接口不可用时的状态（精简宿主/非 Web 宿主/插件未重载）。 */
function unavailable(error: string): MirrorStatusView {
  return { state: 'unavailable', error };
}

/**
 * 创建镜像接口客户端。
 * @param fetchImpl - fetch 实现（缺省用全局 fetch；测试注入假实现）。
 */
export function createMirrorApi(fetchImpl?: typeof fetch): MirrorApi {
  const doFetch = (): typeof fetch | undefined => fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const request = async (path: string, init: RequestInit = {}): Promise<MirrorStatusView> => {
    const fetcher = doFetch();
    if (fetcher === undefined) return unavailable('当前宿主没有 fetch（镜像需要 Web/桌面宿主）');
    try {
      const response = await fetcher(`${MIRROR_API_PATH}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        credentials: 'same-origin',
      });
      let body: unknown = undefined;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const envelope = body !== null && typeof body === 'object'
        ? body as { ok?: unknown; status?: unknown; error?: { message?: unknown } }
        : undefined;
      if (envelope?.status !== undefined && envelope.status !== null && typeof envelope.status === 'object') {
        return envelope.status as MirrorStatusView;
      }
      if (response.ok && envelope?.ok === true) return { state: 'idle' };
      const message = typeof envelope?.error?.message === 'string'
        ? envelope.error.message
        : `镜像接口返回 HTTP ${response.status}`;
      return unavailable(message);
    } catch (error) {
      return unavailable(`本机镜像接口不可用：${error instanceof Error ? error.message : String(error)}（插件可能未重载或宿主不支持）`);
    }
  };
  return {
    start: (input) => request('/start', { method: 'POST', body: JSON.stringify(input) }),
    status: (roomId) => request(`/status${roomId !== undefined ? `?roomId=${encodeURIComponent(roomId)}` : ''}`),
    stop: (roomId) => request('/stop', { method: 'POST', body: JSON.stringify(roomId !== undefined ? { roomId } : {}) }),
  };
}

/** 会话最小面（StoredSession）。 */
export interface MirrorSessionView {
  base?: string;
  roomId?: string;
  playerToken?: string;
  playerName?: string;
}

/**
 * 是否需要自动启动镜像：只有**玩家身份**（playerToken）需要；房主本机已有牌桌会话。
 * @param session - localStorage 会话。
 */
export function shouldAutoStartMirror(session: MirrorSessionView | null | undefined): boolean {
  return typeof session?.playerToken === 'string'
    && session.playerToken.length > 0
    && typeof session.roomId === 'string'
    && session.roomId.length > 0
    && typeof session.base === 'string'
    && session.base.length > 0;
}

/** 组装启动参数；房主/缺字段返回 undefined。 */
export function mirrorStartInput(
  session: MirrorSessionView | null | undefined,
  roomTitle?: string,
): MirrorStartInput | undefined {
  if (!shouldAutoStartMirror(session) || session === null || session === undefined) return undefined;
  return {
    base: session.base as string,
    roomId: session.roomId as string,
    token: session.playerToken as string,
    ...(session.playerName !== undefined ? { playerName: session.playerName } : {}),
    ...(typeof roomTitle === 'string' && roomTitle.length > 0 ? { roomTitle } : {}),
  };
}

/** 状态卡文案。 */
export interface MirrorStatusText {
  kind: 'idle' | 'ok' | 'busy' | 'bad';
  text: string;
}

/**
 * 镜像状态 → 右栏卡片文案（中文，一句话）。
 * @param status - 最近一次状态（undefined = 还没查到）。
 * @param options - `isHost` = 当前身份是房主；`player` = 当前是玩家身份。
 */
export function mirrorStatusText(
  status: MirrorStatusView | null | undefined,
  options: { isHost?: boolean; player?: boolean } = {},
): MirrorStatusText {
  if (options.isHost === true) {
    return { kind: 'idle', text: '本机为房主：当前绑定的会话就是牌桌，无需镜像' };
  }
  if (options.player !== true) return { kind: 'idle', text: '镜像：未加入房间' };
  if (status === null || status === undefined) return { kind: 'idle', text: '镜像：准备中…' };
  switch (status.state) {
    case 'connecting':
      return { kind: 'busy', text: '镜像：连接房主中…' };
    case 'reconnecting':
      return { kind: 'busy', text: `镜像：重连中${status.error !== undefined ? `（${status.error}）` : '…'}` };
    case 'live':
      return { kind: 'ok', text: `镜像：已连接，已同步 ${status.synced ?? 0} 条` };
    case 'stopped':
      return { kind: 'idle', text: `镜像：已停止${status.error !== undefined ? `（${status.error}）` : ''}` };
    case 'error':
      return { kind: 'bad', text: `镜像失败：${status.error ?? '未知错误'}` };
    case 'unavailable':
      return { kind: 'bad', text: `镜像不可用：${status.error ?? '当前宿主不支持本地镜像会话'}` };
    case 'idle':
      return { kind: 'idle', text: '镜像：未启动' };
    default:
      return { kind: 'idle', text: `镜像：${status.state ?? '未知状态'}` };
  }
}

/** 镜像失败时的兜底提示（P0：右栏实时记录仍可用）。 */
export const MIRROR_FALLBACK_HINT = '镜像不可用时可继续用本卡片的实时记录（P0 兜底）；修复后重新加入房间即可。';
