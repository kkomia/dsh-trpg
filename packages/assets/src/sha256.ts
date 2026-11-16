/**
 * sha256 指纹工具（node:crypto，零外部依赖）。
 *
 * 资产的 `sha256` 是整个资产管线的内容寻址锚：归一化去重、manifest 校验、
 * host 端 immutable/ETag、客户端 IndexedDB 缓存 key 全部用它。因此这里只做
 * 一件最简单的事：对字节（或 UTF-8 文本）算小写十六进制 sha256。
 */

import { createHash } from 'node:crypto';

export type Sha256Input = Uint8Array | ArrayBuffer | string;

/**
 * 计算 sha256 小写十六进制摘要。
 * - `string` 按 UTF-8 编码后求值（与文件落盘字节一致）；
 * - `Uint8Array` / `ArrayBuffer` 按原始字节求值。
 */
export function sha256Hex(input: Sha256Input): string {
  const hash = createHash('sha256');
  if (typeof input === 'string') {
    hash.update(input, 'utf8');
  } else if (input instanceof Uint8Array) {
    hash.update(input);
  } else {
    hash.update(new Uint8Array(input));
  }
  return hash.digest('hex');
}

/** 取 sha256 前 n 个十六进制字符（ETag / iconUrl 的 `?h=` 用），n 默认 16。 */
export function sha256Short(input: Sha256Input, length = 16): string {
  const size = Math.max(1, Math.min(64, Math.trunc(length)));
  return sha256Hex(input).slice(0, size);
}
