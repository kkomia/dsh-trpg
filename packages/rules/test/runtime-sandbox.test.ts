/** M9.2：node:vm 脚本沙箱边界（sha256 / CommonJS / 受限 globals / 超时）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScriptSandbox,
  HookDispatcher,
  sha256Hex,
  type SandboxBridge,
} from '../src/index.ts';

function loadOne(code: string, fileName = 'hooks.js') {
  const sandbox = createScriptSandbox({ timeoutMs: 100 });
  const report = sandbox.load({ file: `rules/scripts/${fileName}`, code, sha256: sha256Hex(code) });
  return { sandbox, report };
}

function emptyBridge(ctx: Record<string, unknown> = {}): SandboxBridge {
  return { ctx };
}

// ---------------------------------------------------------------------------
// 完整性
// ---------------------------------------------------------------------------

test('沙箱：sha256 与清单不符时拒绝加载（不执行代码）', () => {
  const sandbox = createScriptSandbox();
  const code = 'module.exports = { onEvent: function () { return { log: "ran" }; } };';
  const report = sandbox.load({ file: 'rules/scripts/x.js', code, sha256: sha256Hex('别的内容') });
  assert.equal(report.ok, false);
  assert.equal(report.error?.kind, 'integrity');
  assert.match(report.error?.message ?? '', /sha256/);
  assert.equal(sandbox.has('onEvent'), false);
  sandbox.dispose();
});

test('沙箱：sha256 格式非法时拒绝加载', () => {
  const sandbox = createScriptSandbox();
  const report = sandbox.load({ file: 'rules/scripts/x.js', code: 'module.exports = {}', sha256: 'NOT-A-SHA' });
  assert.equal(report.ok, false);
  assert.equal(report.error?.kind, 'integrity');
  sandbox.dispose();
});

test('沙箱：sha256Hex 与 node:crypto 结果一致（64 位小写）', async () => {
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update('module.exports = {}', 'utf8').digest('hex');
  assert.equal(sha256Hex('module.exports = {}'), expected);
  assert.match(sha256Hex('abc'), /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// 加载 / 导出
// ---------------------------------------------------------------------------

test('沙箱：合法脚本导出钩子（module.exports = {...}）', () => {
  const { sandbox, report } = loadOne(
    'module.exports = { resolveCheck: function (ctx, req) { return { total: 1, success: true }; } };',
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.hooks, ['resolveCheck']);
  assert.equal(sandbox.has('resolveCheck'), true);
  assert.equal(sandbox.has('resolveAttack'), false);
  sandbox.dispose();
});

test('沙箱：exports.xxx 写法同样可导出多个钩子', () => {
  const { sandbox, report } = loadOne(
    'exports.onEvent = function () { return {}; };\nexports.onRoundStart = function () { return {}; };',
  );
  assert.equal(report.ok, true);
  assert.deepEqual([...report.hooks].sort(), ['onEvent', 'onRoundStart']);
  sandbox.dispose();
});

test('沙箱：加载期抛错会返回错误报告', () => {
  const { report } = loadOne('throw new Error("加载就炸");');
  assert.equal(report.ok, false);
  assert.match(report.error?.message ?? '', /加载就炸/);
});

test('沙箱：import 语法被语法错误拒绝', () => {
  const { report } = loadOne('import fs from "node:fs";\nmodule.exports = {};');
  assert.equal(report.ok, false);
  assert.equal(report.error?.kind, 'syntax');
});

test('沙箱：脚本必须导出函数', () => {
  const { report } = loadOne('module.exports = {};');
  assert.equal(report.ok, false);
  assert.match(report.error?.message ?? '', /没有导出/);
});

test('沙箱：多文件钩子合并到同一注册表', () => {
  const sandbox = createScriptSandbox();
  const codeA = 'module.exports = { validateSheet: function () { return []; } };';
  const codeB = 'module.exports = { computeDerived: function () { return { ac: 11 }; } };';
  assert.equal(sandbox.load({ file: 'rules/scripts/a.js', code: codeA, sha256: sha256Hex(codeA) }).ok, true);
  assert.equal(sandbox.load({ file: 'rules/scripts/b.js', code: codeB, sha256: sha256Hex(codeB) }).ok, true);
  assert.ok(sandbox.listHooks().includes('validateSheet'));
  assert.ok(sandbox.listHooks().includes('computeDerived'));
  sandbox.dispose();
});

// ---------------------------------------------------------------------------
// 调用：传参 / 返回值 / 错误 / 超时
// ---------------------------------------------------------------------------

test('沙箱：钩子收到 ctx 与 JSON 入参，返回值取回', () => {
  const { sandbox } = loadOne(
    'module.exports = { onEvent: function (ctx, event) { return { echo: event.kind, turn: ctx.turn.round }; } };',
  );
  const bridge = emptyBridge({ turn: { round: 3 } });
  const result = sandbox.call('onEvent', [{ kind: 'turn/start' }], bridge);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { echo: 'turn/start', turn: 3 });
  sandbox.dispose();
});

test('沙箱：钩子抛错返回 throw 失败（不崩宿主）', () => {
  const { sandbox } = loadOne('module.exports = { resolveCheck: function () { throw new Error("炸了"); } };');
  const result = sandbox.call('resolveCheck', [], emptyBridge());
  assert.equal(result.ok, false);
  assert.equal(result.failure?.kind, 'throw');
  assert.match(result.failure?.message ?? '', /炸了/);
  sandbox.dispose();
});

test('沙箱：死循环触发超时并返回 timeout 失败', () => {
  const { sandbox } = loadOne('module.exports = { resolveCheck: function () { while (true) {} } };');
  const started = Date.now();
  const result = sandbox.call('resolveCheck', [], emptyBridge());
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.failure?.kind, 'timeout');
  assert.ok(elapsed >= 50, `超时应至少耗时 50ms，实际 ${elapsed}ms`);
  sandbox.dispose();
});

test('沙箱：超时后沙箱仍可用（后续调用正常）', () => {
  const { sandbox } = loadOne(
    'module.exports = { onEvent: function () { return { ok: 1 }; } };',
  );
  const result = sandbox.call('onEvent', [], emptyBridge());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { ok: 1 });
  sandbox.dispose();
});

test('沙箱：循环返回值（无法 JSON 化）被拒绝', () => {
  const { sandbox } = loadOne(
    'module.exports = { onEvent: function () { var a = {}; a.self = a; return a; } };',
  );
  const result = sandbox.call('onEvent', [], emptyBridge());
  assert.equal(result.ok, false);
  assert.ok(result.failure?.kind === 'shape' || result.failure?.kind === 'throw');
  sandbox.dispose();
});

// ---------------------------------------------------------------------------
// 受限 globals
// ---------------------------------------------------------------------------

test('沙箱：没有 process/require/module 全局/import/eval/Function', () => {
  const { sandbox } = loadOne(
    `module.exports = {
      onEvent: function () {
        return {
          process: typeof process,
          require: typeof require,
          globalProcess: typeof globalThis.process,
          evalType: typeof eval,
          functionType: typeof Function,
          dateType: typeof Date,
          bridgeType: typeof globalThis.__hostBridge,
        };
      }
    };`,
  );
  const result = sandbox.call('onEvent', [], emptyBridge());
  assert.equal(result.ok, true, JSON.stringify(result.failure));
  assert.deepEqual(result.value, {
    process: 'undefined',
    require: 'undefined',
    globalProcess: 'undefined',
    evalType: 'undefined',
    functionType: 'undefined',
    dateType: 'undefined',
    bridgeType: 'undefined',
  });
  sandbox.dispose();
});

test('沙箱：Math 被裁剪（无 random/sqrt/PI，保留 floor 等）', () => {
  const { sandbox } = loadOne(
    `module.exports = {
      onEvent: function () {
        return {
          random: typeof Math.random,
          sqrt: typeof Math.sqrt,
          pi: typeof Math.PI,
          floor: Math.floor(2.9),
          max: Math.max(1, 5),
          pow: Math.pow(2, 3),
        };
      }
    };`,
  );
  const result = sandbox.call('onEvent', [], emptyBridge());
  assert.equal(result.ok, true, JSON.stringify(result.failure));
  assert.deepEqual(result.value, { random: 'undefined', sqrt: 'undefined', pi: 'undefined', floor: 2, max: 5, pow: 8 });
  sandbox.dispose();
});

test('沙箱：console 输出进日志队列而不污染宿主 stdout', () => {
  const { sandbox } = loadOne(
    'module.exports = { onEvent: function () { console.log("规则日志", 42); console.warn("小心"); return {}; } };',
  );
  const result = sandbox.call('onEvent', [], emptyBridge());
  assert.equal(result.ok, true);
  assert.deepEqual(result.logs, [
    { level: 'log', text: '规则日志 42' },
    { level: 'warn', text: '小心' },
  ]);
  sandbox.dispose();
});

test('沙箱：ctx 能力桥接（roll / sheet.get / log）可用', () => {
  const { sandbox } = loadOne(
    `module.exports = {
      onEvent: function (ctx) {
        var roll = ctx.roll("1d6");
        ctx.log("掷出 " + roll.total);
        return { dice: roll.dice.length, sheet: ctx.sheet.get("resources.hp.current") };
      }
    };`,
  );
  const bridge: SandboxBridge = {
    ctx: {},
    roll: () => ({ expr: '1d6', dice: [4], modifier: 0, total: 4 }),
    sheetGet: () => 17,
    log: () => undefined,
  };
  const result = sandbox.call('onEvent', [], bridge);
  assert.equal(result.ok, true, JSON.stringify(result.failure));
  assert.deepEqual(result.value, { dice: 1, sheet: 17 });
  sandbox.dispose();
});
