/**
 * M9.6b 协议层：规则校验 / 规则测试台 2 个工坊 RPC 的方法表、参数校验与常量契约。
 *
 * 只锁协议契约与中文错误；实际校验/试跑行为在 host 的 `rules-workshop` / `rules-rpc` 测试里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACK_WORKSHOP_LIMITS,
  RULES_TEST_KINDS,
  RULES_TEST_LIMITS,
  isRpcMethod,
  validateRulesTest,
  validateRulesValidate,
  validateRpcRequest,
} from '../src/index.ts';

function errorOf(result: { ok: boolean; error?: string }): string {
  assert.equal(result.ok, false, '预期校验失败');
  return result.error ?? '';
}

const DRAFT = {
  schemaVersion: 'trpg.pack/1',
  packId: 'test-pack',
  rules: { schemaVersion: 'trpg.rules/1' },
};

// ---------------------------------------------------------------------------
// 方法表 / 信封
// ---------------------------------------------------------------------------

test('RPC：rules.validate / rules.test 进入方法表，信封放行', () => {
  for (const method of ['rules.validate', 'rules.test'] as const) {
    assert.equal(isRpcMethod(method), true, `${method} 应进入方法表`);
    assert.equal(validateRpcRequest({ method, params: {}, token: 't' }).ok, true, `${method} 信封应放行`);
  }
  assert.equal(isRpcMethod('rules.run'), false);
  assert.equal(isRpcMethod('rule.validate'), false);
});

test('RPC 常量：测试台 kind 三档、单次请求上限 12', () => {
  assert.deepEqual([...RULES_TEST_KINDS], ['check', 'action', 'derived']);
  assert.equal(RULES_TEST_LIMITS.maxRequests, 12);
});

// ---------------------------------------------------------------------------
// rules.validate
// ---------------------------------------------------------------------------

test('rules.validate：最小参数通过（只校验已安装包）', () => {
  const result = validateRulesValidate({ packId: 'core-guimuya' });
  assert.equal(result.ok, true);
  assert.equal(result.value?.packId, 'core-guimuya');
  assert.equal(result.value?.pack, undefined, '没传草稿时不应带 pack');
});

test('rules.validate：packId 非法给中文错误', () => {
  assert.match(errorOf(validateRulesValidate(undefined)), /缺少参数/);
  assert.match(errorOf(validateRulesValidate({ packId: 'Core_Guimuya' })), /packId 必须是小写 slug/);
  assert.match(errorOf(validateRulesValidate({})), /packId/);
});

test('rules.validate：草稿 pack 通过且原样透传', () => {
  const result = validateRulesValidate({ packId: 'test-pack', pack: DRAFT });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.pack, DRAFT);
});

test('rules.validate：草稿 packId 与参数不一致给定位错误', () => {
  const result = validateRulesValidate({ packId: 'other-pack', pack: DRAFT });
  assert.match(errorOf(result), /pack\.packId 必须与参数 packId 一致/);
});

test('rules.validate：草稿 pack 必须是对象 / 不能过大', () => {
  assert.match(errorOf(validateRulesValidate({ packId: 'test-pack', pack: [] })), /必须是对象/);
  assert.match(errorOf(validateRulesValidate({ packId: 'test-pack', pack: 'x' })), /必须是对象/);
  const huge = { ...DRAFT, description: 'x'.repeat(PACK_WORKSHOP_LIMITS.maxPackJsonBytes + 10) };
  assert.match(errorOf(validateRulesValidate({ packId: 'test-pack', pack: huge })), /过大/);
});

// ---------------------------------------------------------------------------
// rules.test
// ---------------------------------------------------------------------------

test('rules.test：最小检定请求通过，可选字段按需保留', () => {
  const result = validateRulesTest({
    packId: 'core-guimuya',
    requests: [{ kind: 'check', skillId: 'athletics', dc: 12 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value?.requests.length, 1);
  assert.deepEqual(result.value?.requests[0], { kind: 'check', skillId: 'athletics', dc: 12 });
  assert.equal(result.value?.seed, undefined);
  assert.equal(result.value?.pack, undefined);
});

test('rules.test：requests 为空 / 超上限 / 非数组都拒绝', () => {
  assert.match(errorOf(validateRulesTest({ packId: 'core-guimuya' })), /requests 必须是数组/);
  assert.match(errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [] })), /不能为空/);
  const tooMany = Array.from({ length: 13 }, () => ({ kind: 'derived' }));
  assert.match(errorOf(validateRulesTest({ packId: 'core-guimuya', requests: tooMany })), /过多/);
});

test('rules.test：kind 非法 / action 缺 actionId 给可读错误', () => {
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'attack' }] })),
    /kind 必须是 check \/ action \/ derived/,
  );
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'action' }] })),
    /需要 actionId/,
  );
});

test('rules.test：dc / mods / mode 边界校验', () => {
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'check', dc: 61 }] })),
    /dc 必须是 0–60 的整数/,
  );
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'check', dc: 1.5 }] })),
    /dc 必须是 0–60 的整数/,
  );
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'check', mods: 101 }] })),
    /mods 必须是 -100–100 的整数/,
  );
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'check', mode: 'lucky' }] })),
    /mode 必须是 normal/,
  );
});

test('rules.test：seed / 草稿 pack / 布尔位置参数校验', () => {
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'derived' }], seed: 2 ** 31 })),
    /seed 必须是 0–2147483647 的整数/,
  );
  assert.match(
    errorOf(validateRulesTest({ packId: 'other', requests: [{ kind: 'derived' }], pack: DRAFT })),
    /pack\.packId 必须与参数 packId 一致/,
  );
  const ok = validateRulesTest({ packId: 'test-pack', requests: [{ kind: 'derived' }], pack: DRAFT, seed: 7 });
  assert.equal(ok.ok, true);
  assert.equal(ok.value?.seed, 7);
  assert.deepEqual(ok.value?.pack, DRAFT);
  assert.match(
    errorOf(validateRulesTest({ packId: 'core-guimuya', requests: [{ kind: 'derived', actorCardId: 3 }] })),
    /actorCardId 必须是字符串/,
  );
});

test('rules.test：多条请求按顺序保留（含 actor/target 与 action 参数）', () => {
  const result = validateRulesTest({
    packId: 'core-guimuya',
    requests: [
      { kind: 'derived', actorCardId: 'card_aqing' },
      { kind: 'check', attributeId: 'str', dc: 10, mode: 'advantage', mods: 2 },
      { kind: 'action', actionId: 'attack.melee', targetId: 'card_aqing', dc: 15 },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.value?.requests.length, 3);
  assert.deepEqual(result.value?.requests[2], { kind: 'action', actionId: 'attack.melee', targetId: 'card_aqing', dc: 15 });
});
