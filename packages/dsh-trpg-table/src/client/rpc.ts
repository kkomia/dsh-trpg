/**
 * 跑团桌 Client 半边：RPC 调用（与 host 的 `/trpg/rpc` 约定）。
 *
 * 单独成文件是为了让 M9.4 的规则数据层（rules-store）复用同一套错误处理，
 * 不把规则/投影逻辑塞回 index.ts。
 */

export interface RpcResult<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

/** 与 host 约定的客户端版本（兼容提示用；不参与鉴权）。 */
export const CLIENT_VERSION = '0.3.0';

/**
 * 调一次 host RPC：`ok:false` 时抛出带 host 中文 message 的 Error，
 * 调用方原样展示即可（不翻译、不改写成英文）。
 */
export async function callRpc<T>(base: string, method: string, params: unknown, token?: string): Promise<T> {
  const response = await fetch(`${base.replace(/\/+$/, '')}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, token, clientVersion: CLIENT_VERSION }),
  });
  const payload = (await response.json()) as RpcResult<T>;
  if (!payload.ok) throw new Error(payload.error?.message ?? `RPC 失败：${method}`);
  return payload.result as T;
}

/** 把任意异常压成可读中文（host 的 message 已经是中文人话，原样透出）。 */
export function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
