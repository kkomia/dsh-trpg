/**
 * 纯 JS sha256（零依赖、无 `node:crypto`）。
 *
 * 为什么自己写：内容包会被打进浏览器 bundle（client 半边 import `@dsh-trpg/content`），
 * 而 `packages/content/src/pack-zip.ts` 里的 `node:crypto` 版本不能进浏览器；规则脚本的
 * sha256（`rules/scripts/*.js`，见 docs/RULES-MODEL §3/§6/§10）需要在**导入/导出的纯数据层**
 * 校验，所以这里给一份可在任何 JS 运行时跑的实现。
 *
 * 只做一件事：`sha256Hex(text | bytes)` → 64 位小写十六进制。
 * 已用 FIPS 180-2 / RFC 6234 官方测试向量覆盖（见 test/sha256.test.ts）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_HASH = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

const HEX_DIGITS = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += `${HEX_DIGITS[(byte >>> 4) & 0xf] ?? '0'}${HEX_DIGITS[byte & 0xf] ?? '0'}`;
  return out;
}

/** 计算 sha256 原始 32 字节摘要（大端）。 */
export function sha256Bytes(input: Uint8Array | string): Uint8Array {
  const message = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // 填充：0x80 + 若干 0x00，使 (length + 1 + pad + 8) % 64 === 0，末尾 8 字节为大端位长度。
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >>> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  // 位长度高 32 位（>512 MiB 的输入才会用到，这里保持正确性）
  const highBits = Math.floor(bitLength / 0x100000000);
  padded[paddedLength - 8] = (highBits >>> 24) & 0xff;
  padded[paddedLength - 7] = (highBits >>> 16) & 0xff;
  padded[paddedLength - 6] = (highBits >>> 8) & 0xff;
  padded[paddedLength - 5] = highBits & 0xff;
  padded[paddedLength - 4] = (bitLength >>> 24) & 0xff;
  padded[paddedLength - 3] = (bitLength >>> 16) & 0xff;
  padded[paddedLength - 2] = (bitLength >>> 8) & 0xff;
  padded[paddedLength - 1] = bitLength & 0xff;

  const hash = new Uint32Array(INITIAL_HASH);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      w[index] =
        (((padded[base] ?? 0) << 24) |
          ((padded[base + 1] ?? 0) << 16) |
          ((padded[base + 2] ?? 0) << 8) |
          (padded[base + 3] ?? 0)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = w[index - 15] as number;
      const w2 = w[index - 2] as number;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
    }
    let a = hash[0] as number;
    let b = hash[1] as number;
    let c = hash[2] as number;
    let d = hash[3] as number;
    let e = hash[4] as number;
    let f = hash[5] as number;
    let g = hash[6] as number;
    let h = hash[7] as number;
    for (let index = 0; index < 64; index += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + (K[index] as number) + (w[index] as number)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = ((hash[0] as number) + a) >>> 0;
    hash[1] = ((hash[1] as number) + b) >>> 0;
    hash[2] = ((hash[2] as number) + c) >>> 0;
    hash[3] = ((hash[3] as number) + d) >>> 0;
    hash[4] = ((hash[4] as number) + e) >>> 0;
    hash[5] = ((hash[5] as number) + f) >>> 0;
    hash[6] = ((hash[6] as number) + g) >>> 0;
    hash[7] = ((hash[7] as number) + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  for (let index = 0; index < 8; index += 1) {
    const word = hash[index] as number;
    digest[index * 4] = (word >>> 24) & 0xff;
    digest[index * 4 + 1] = (word >>> 16) & 0xff;
    digest[index * 4 + 2] = (word >>> 8) & 0xff;
    digest[index * 4 + 3] = word & 0xff;
  }
  return digest;
}

/** 计算 sha256 的 64 位小写十六进制（字符串按 UTF-8 编码）。 */
export function sha256Hex(input: Uint8Array | string): string {
  return toHex(sha256Bytes(input));
}
