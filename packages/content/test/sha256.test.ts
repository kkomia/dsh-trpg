/**
 * 纯 JS sha256（`packages/content/src/sha256.ts`）的测试。
 *
 * 为什么要自测：`@dsh-trpg/content` 会被打进浏览器 client bundle，不能 import `node:crypto`；
 * 规则脚本完整性（`pack.rules.scripts[].sha256`）依赖这份实现，哈希算错 = 好坏脚本都放行/都拒绝。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Bytes, sha256Hex } from '../src/sha256.ts';
import { DND5E_LITE_SCRIPT_SOURCES } from '../src/rules-pack/index.ts';

function nodeSha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

test('sha256: FIPS 180-2 / RFC 6234 官方向量', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '空字符串',
  );
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '"abc"');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    '56 字节向量',
  );
  assert.equal(
    sha256Hex('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    '100 万字节 a',
  );
});

test('sha256: 与 node:crypto 对 UTF-8 中文/emoji 一致', () => {
  const samples = ['鬼木崖·异光', '阿青', 'dnd5e-lite 规则包 v2.0.0', '🎲 TRPG 跑团', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64)];
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), nodeSha256(sample), `应一致：${sample.slice(0, 20)}`);
  }
});

test('sha256: 字符串与 UTF-8 字节输入等价，输出 64 位小写十六进制', () => {
  const text = '规则脚本\n第二行\t制表符';
  const bytes = new TextEncoder().encode(text);
  assert.equal(sha256Hex(text), sha256Hex(bytes));
  assert.deepEqual([...sha256Bytes(text)], [...sha256Bytes(bytes)]);
  const hex = sha256Hex(text);
  assert.match(hex, /^[a-f0-9]{64}$/u);
  assert.equal(sha256Bytes(text).length, 32);
});

test('sha256: 换行风格与内容差异都会被区分（脚本完整性依赖它）', () => {
  assert.notEqual(sha256Hex('a\nb'), sha256Hex('a\r\nb'), 'LF 与 CRLF 必须是不同哈希');
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'));
  assert.notEqual(sha256Hex('abc'), sha256Hex('abc\n'));
});

test('sha256: 内置规则脚本的清单哈希与源码一致（embedded 生成器的口径）', () => {
  assert.equal(DND5E_LITE_SCRIPT_SOURCES.length, 4);
  for (const source of DND5E_LITE_SCRIPT_SOURCES) {
    assert.equal(source.sha256, nodeSha256(source.code), `${source.file} 的 sha256`);
    assert.equal(sha256Hex(source.code), source.sha256, `${source.file} 的纯 JS sha256 应与清单一致`);
    assert.match(source.sha256, /^[a-f0-9]{64}$/u);
  }
});
