/**
 * 规则脚本沙箱（docs/RULES-MODEL §6/§10）。
 *
 * 边界与保证：
 * - `node:vm` 独立 context，`codeGeneration: {strings:false, wasm:false}`（禁 eval / new Function）；
 * - 脚本按 **CommonJS** 包装：只注入局部 `module` / `exports`，**没有** `require` / `import` / `process` /
 *   `setTimeout` / `Date`（不读系统时钟）/ 完整 `Math`（只给 floor/ceil/round/abs/min/max/pow，
 *   无 random）；`console` 映射到日志队列；
 * - 每次加载用 `node:crypto` 的 sha256 校验源码，**不符直接拒绝**（返回 integrity 失败，不执行代码）；
 * - 单次钩子执行超时（默认 200ms）→ 返回 timeout 失败，不再让脚本继续跑；
 * - 钩子经 `call()` 调用：入参 JSON 化传递，返回值 JSON 化取回；宿主能力通过一次性 bridge 注入，
 *   bridge 在调用脚本里第一行就被从全局摘掉，钩子内部拿不到宿主函数对象（`node:vm` 不是强安全边界，
 *   按 §10 只防误伤与失控脚本，不防恶意作者）。
 */
import { createHash } from 'node:crypto';
import { createContext, runInContext, type Context } from 'node:vm';
import { HOOK_NAMES, SHA256_PATTERN, type HookName } from '../types.ts';

export const SANDBOX_DEFAULT_TIMEOUT_MS = 200;
export const SANDBOX_MAX_RESULT_BYTES = 64 * 1024;
export const SANDBOX_MAX_LOG_LINES = 200;
export const SANDBOX_MAX_STACK_LINES = 5;

export interface ScriptSource {
  file: string;
  code: string;
  sha256: string;
}

export type SandboxFailureKind =
  | 'integrity'
  | 'source'
  | 'syntax'
  | 'throw'
  | 'timeout'
  | 'shape'
  | 'missing';

export interface SandboxFailure {
  kind: SandboxFailureKind;
  message: string;
  /** 堆栈前 {@link SANDBOX_MAX_STACK_LINES} 行（空数组 = 无堆栈）。 */
  stack: string[];
}

export interface SandboxLogEntry {
  level: 'log' | 'warn' | 'error';
  text: string;
}

export interface ScriptLoadReport {
  file: string;
  sha256: string;
  ok: boolean;
  /** 该文件实际导出的已知钩子名。 */
  hooks: HookName[];
  error?: SandboxFailure;
}

export interface SandboxCallResult {
  ok: boolean;
  value?: unknown;
  logs: SandboxLogEntry[];
  failure?: SandboxFailure;
}

/** 注入沙箱的宿主能力对象（`ctx` 是纯数据；其余是每次调用安全的宿主函数）。 */
export interface SandboxBridge {
  ctx: unknown;
  [name: string]: unknown;
}

export interface ScriptSandbox {
  /** 加载一个脚本文件；sha256 不符或语法/执行错误时 ok=false，不注册任何钩子。 */
  load(script: ScriptSource): ScriptLoadReport;
  /** 脚本注册表里是否有该钩子。 */
  has(hook: string): boolean;
  listHooks(): HookName[];
  /** 调用钩子；永不抛错（错误/超时统一放进 failure）。 */
  call(hook: string, args: readonly unknown[], bridge: SandboxBridge): SandboxCallResult;
  dispose(): void;
}

export interface SandboxOptions {
  /** 单次执行超时（加载 + 每次钩子调用），默认 200ms。 */
  timeoutMs?: number;
  maxResultBytes?: number;
}

/** 计算脚本内容的 sha256（小写 hex）。M9.3 打包/加载校验共用。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return SANDBOX_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 10), 5000);
}

function stackLines(error: unknown): string[] {
  const raw = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  if (raw.length === 0) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, SANDBOX_MAX_STACK_LINES);
}

function sliceText(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 沙箱 bootstrap（宿主可信代码；在其中把危险全局删掉、装受限 Math/console）。 */
function buildBootstrap(maxLogLines: number): string {
  return `(function () {
  var MAX_LOG_LINES = ${Math.trunc(maxLogLines)};
  var logs = [];
  function describe(value) {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'function') return '[function]';
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }
  function collect(args) {
    var parts = [];
    for (var i = 0; i < args.length; i += 1) parts.push(describe(args[i]));
    return parts.join(' ');
  }
  function push(level) {
    return function () {
      var text = collect(arguments);
      if (text.length > 500) text = text.slice(0, 500) + '…';
      logs.push({ level: level, text: text });
      if (logs.length > MAX_LOG_LINES) logs.shift();
    };
  }
  globalThis.console = { log: push('log'), info: push('log'), warn: push('warn'), error: push('error') };
  var mathApi = {
    floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
    min: Math.min, max: Math.max, pow: Math.pow
  };
  globalThis.Math = mathApi;
  globalThis.Date = undefined;
  globalThis.eval = undefined;
  globalThis.Function = undefined;
  globalThis.__logs = logs;
  globalThis.__rulesHooks = {};
  globalThis.__makeRuleCtx = function (bridge) {
    return {
      roll: function (expression) { return bridge.roll(String(expression)); },
      rng: function () { return bridge.rng(); },
      attr: function (id) { return bridge.attr(String(id)); },
      derived: function (key) { return bridge.derived(String(key)); },
      resource: {
        get: function (id) { return bridge.resourceGet(String(id)); },
        spend: function (id, amount) { return bridge.resourceSpend(String(id), Number(amount)); }
      },
      sheet: {
        get: function (path) { return bridge.sheetGet(String(path)); },
        set: function (path, value) { return bridge.sheetSet(String(path), value); }
      },
      equipment: {
        list: function () { return bridge.equipmentList(); },
        stats: function (statId) { return bridge.equipmentStats(String(statId)); }
      },
      effects: {
        apply: function (effect) { return bridge.effectsApply(effect); },
        remove: function (id) { return bridge.effectsRemove(String(id)); }
      },
      tables: { pick: function (tableId) { return bridge.tablesPick(String(tableId)); } },
      log: function (text) { return bridge.log(String(text)); },
      actor: bridge.ctx.actor,
      action: bridge.ctx.action,
      target: bridge.ctx.target,
      space: bridge.ctx.space,
      turn: bridge.ctx.turn,
      derivedAll: bridge.ctx.derived
    };
  };
})()`;
}

function buildLoadScript(code: string): string {
  return `(function () {
  try {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports) {
${code}
    })(module, exports);
    var exported = module.exports;
    if (exported === null || (typeof exported !== 'object' && typeof exported !== 'function')) {
      return JSON.stringify({ status: 'error', message: '脚本没有导出任何钩子（请用 module.exports = { hookName: fn }）', stack: '' });
    }
    var names = [];
    for (var key in exported) {
      if (typeof exported[key] === 'function') {
        __rulesHooks[String(key)] = exported[key];
        names.push(String(key));
      }
    }
    if (names.length === 0) {
      return JSON.stringify({ status: 'error', message: '脚本没有导出任何钩子函数（请用 module.exports = { hookName: fn }）', stack: '' });
    }
    return JSON.stringify({ status: 'ok', hooks: names });
  } catch (error) {
    return JSON.stringify({
      status: 'error',
      message: String(error && error.message !== undefined ? error.message : error),
      stack: String(error && error.stack ? error.stack : '')
    });
  }
})()`;
}

function buildCallScript(hook: string, argsJson: string): string {
  return `(function () {
  try {
    var bridge = __hostBridge;
    __hostBridge = undefined;
    var fn = __rulesHooks[${JSON.stringify(hook)}];
    if (typeof fn !== 'function') return JSON.stringify({ status: 'missing' });
    var ctx = __makeRuleCtx(bridge);
    var args = JSON.parse(${JSON.stringify(argsJson)});
    var value = fn.apply(null, [ctx].concat(args));
    var text = JSON.stringify(value === undefined ? null : value);
    if (typeof text !== 'string') return JSON.stringify({ status: 'unserializable' });
    return JSON.stringify({ status: 'ok', value: text });
  } catch (error) {
    return JSON.stringify({
      status: 'error',
      message: String(error && error.message !== undefined ? error.message : error),
      stack: String(error && error.stack ? error.stack : '')
    });
  }
})()`;
}

function readStatus(raw: unknown): { status: 'ok'; value: string } | { status: 'missing' } | { status: 'unserializable' } | { status: 'error'; message: string; stack: string } | { status: 'invalid' } {
  if (typeof raw !== 'string') return { status: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { status: 'invalid' };
    const record = parsed as Record<string, unknown>;
    if (record.status === 'ok' && typeof record.value === 'string') return { status: 'ok', value: record.value };
    if (record.status === 'missing') return { status: 'missing' };
    if (record.status === 'unserializable') return { status: 'unserializable' };
    if (record.status === 'error') {
      return {
        status: 'error',
        message: typeof record.message === 'string' ? record.message : '脚本抛出了未知错误',
        stack: typeof record.stack === 'string' ? record.stack : '',
      };
    }
    return { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

function toFailure(kind: SandboxFailureKind, message: string, stack: string[]): SandboxFailure {
  return { kind, message: sliceText(message), stack: stack.slice(0, SANDBOX_MAX_STACK_LINES) };
}

function splitStack(text: unknown): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, SANDBOX_MAX_STACK_LINES);
}

type LoadStatus =
  | { status: 'ok'; hooks: string[] }
  | { status: 'error'; message: string; stack: string }
  | { status: 'invalid' };

function readLoadStatus(raw: unknown): LoadStatus {
  if (typeof raw !== 'string') return { status: 'invalid' };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { status: 'invalid' };
    const record = parsed as Record<string, unknown>;
    if (record.status === 'ok') {
      const hooks = Array.isArray(record.hooks)
        ? record.hooks.filter((name): name is string => typeof name === 'string')
        : [];
      return { status: 'ok', hooks };
    }
    if (record.status === 'error') {
      return {
        status: 'error',
        message: typeof record.message === 'string' ? record.message : '脚本加载失败',
        stack: typeof record.stack === 'string' ? record.stack : '',
      };
    }
    return { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

function failureFromError(error: unknown): SandboxFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    const message = error instanceof Error ? error.message : '脚本执行超时';
    return toFailure('timeout', message, []);
  }
  const message = error instanceof Error ? error.message : String(error);
  return toFailure('throw', message, stackLines(error));
}

function collectLogs(context: Context): SandboxLogEntry[] {
  try {
    const raw = runInContext('JSON.stringify(__logs.splice(0, __logs.length))', context, { timeout: 1000 });
    if (typeof raw !== 'string') return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SandboxLogEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.text !== 'string') continue;
      const level: SandboxLogEntry['level'] = record.level === 'warn' ? 'warn' : record.level === 'error' ? 'error' : 'log';
      out.push({ level, text: sliceText(record.text) });
    }
    return out.slice(0, SANDBOX_MAX_LOG_LINES);
  } catch {
    return [];
  }
}

/**
 * 创建脚本沙箱。一个沙箱共享一个 vm context（脚本之间可通过 `__rulesHooks` 注册钩子），
 * 由运行时按 `rules.scripts` 映射调用。
 */
export function createScriptSandbox(options: SandboxOptions = {}): ScriptSandbox {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxResultBytes = typeof options.maxResultBytes === 'number' && options.maxResultBytes > 0
    ? Math.trunc(options.maxResultBytes)
    : SANDBOX_MAX_RESULT_BYTES;
  const context = createContext(
    {},
    {
      name: 'dsh-trpg-rules',
      codeGeneration: { strings: false, wasm: false },
    },
  );
  runInContext(buildBootstrap(SANDBOX_MAX_LOG_LINES), context, { timeout: Math.max(1000, timeoutMs) });
  // 加载期产生的日志直接丢弃（脚本顶层不应有副作用输出）
  collectLogs(context);

  const known = new Set<string>(HOOK_NAMES);
  let disposed = false;

  const load = (script: ScriptSource): ScriptLoadReport => {
    const report: ScriptLoadReport = { file: '', sha256: '', ok: false, hooks: [] };
    if (disposed) {
      return { ...report, error: toFailure('source', '沙箱已释放', []) };
    }
    if (
      typeof script !== 'object' ||
      script === null ||
      typeof script.file !== 'string' ||
      typeof script.code !== 'string' ||
      typeof script.sha256 !== 'string'
    ) {
      return { ...report, error: toFailure('source', '脚本来源必须是 { file, code, sha256 }', []) };
    }
    report.file = script.file;
    report.sha256 = script.sha256;
    if (!SHA256_PATTERN.test(script.sha256)) {
      return { ...report, error: toFailure('integrity', `脚本 ${script.file} 的 sha256 格式非法（需 64 位小写十六进制）`, []) };
    }
    const actual = sha256Hex(script.code);
    if (actual !== script.sha256) {
      return {
        ...report,
        error: toFailure(
          'integrity',
          `脚本 ${script.file} 的 sha256 与清单不符（清单 ${script.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），拒绝加载`,
          [],
        ),
      };
    }
    let raw: unknown;
    try {
      raw = runInContext(buildLoadScript(script.code), context, { filename: script.file, timeout: timeoutMs });
    } catch (error) {
      const failure = failureFromError(error);
      return {
        ...report,
        error: failure.kind === 'timeout'
          ? toFailure('timeout', `脚本 ${script.file} 加载超时（>${timeoutMs}ms）`, [])
          : toFailure('syntax', failure.message, failure.stack),
      };
    }
    collectLogs(context);
    const status = readLoadStatus(raw);
    if (status.status !== 'ok') {
      if (status.status === 'error') {
        return { ...report, error: toFailure('throw', `脚本 ${script.file} 加载失败：${status.message}`, splitStack(status.stack)) };
      }
      return { ...report, error: toFailure('throw', `脚本 ${script.file} 的加载结果无法解析`, []) };
    }
    report.ok = true;
    report.hooks = status.hooks.filter((name): name is HookName => known.has(name));
    return report;
  };

  const has = (hook: string): boolean => {
    if (disposed) return false;
    try {
      return runInContext(`typeof __rulesHooks[${JSON.stringify(hook)}] === 'function'`, context, { timeout: 1000 }) === true;
    } catch {
      return false;
    }
  };

  const listHooks = (): HookName[] => {
    const out: HookName[] = [];
    for (const hook of HOOK_NAMES) if (has(hook)) out.push(hook);
    return out;
  };

  const call = (hook: string, args: readonly unknown[], bridge: SandboxBridge): SandboxCallResult => {
    if (disposed) {
      return { ok: false, logs: [], failure: toFailure('source', '沙箱已释放', []) };
    }
    let argsJson: string;
    try {
      argsJson = JSON.stringify(Array.isArray(args) ? args : []);
    } catch {
      return { ok: false, logs: [], failure: toFailure('shape', `钩子 ${hook} 的入参无法 JSON 序列化`, []) };
    }
    try {
      (context as unknown as Record<string, unknown>).__hostBridge = bridge;
    } catch {
      return { ok: false, logs: [], failure: toFailure('source', '无法向沙箱注入宿主能力', []) };
    }
    // 兜底清理：正常路径里脚本第一行就会把它摘掉
    const clearBridge = (): void => {
      try {
        (context as unknown as Record<string, unknown>).__hostBridge = undefined;
      } catch {
        /* 忽略 */
      }
    };
    let raw: unknown;
    try {
      raw = runInContext(buildCallScript(hook, argsJson), context, { filename: `<hook:${hook}>`, timeout: timeoutMs });
    } catch (error) {
      clearBridge();
      const failure = failureFromError(error);
      const logs = collectLogs(context);
      if (failure.kind === 'timeout') {
        return { ok: false, logs, failure: toFailure('timeout', `钩子 ${hook} 执行超时（>${timeoutMs}ms）`, []) };
      }
      return { ok: false, logs, failure };
    }
    clearBridge();
    const logs = collectLogs(context);
    const status = readStatus(raw);
    if (status.status === 'missing') {
      return { ok: false, logs, failure: toFailure('missing', `钩子 ${hook} 未导出`, []) };
    }
    if (status.status === 'unserializable') {
      return { ok: false, logs, failure: toFailure('shape', `钩子 ${hook} 的返回值无法 JSON 序列化（不能含函数/循环引用）`, []) };
    }
    if (status.status === 'error') {
      return {
        ok: false,
        logs,
        failure: toFailure('throw', status.message, status.stack.split('\n').map((line) => line.trim()).slice(0, SANDBOX_MAX_STACK_LINES)),
      };
    }
    if (status.status !== 'ok') {
      return { ok: false, logs, failure: toFailure('shape', `钩子 ${hook} 的返回值格式非法`, []) };
    }
    if (status.value.length > maxResultBytes) {
      return {
        ok: false,
        logs,
        failure: toFailure('shape', `钩子 ${hook} 的返回负载 ${status.value.length} 字节超过上限 ${maxResultBytes}`, []),
      };
    }
    try {
      const value: unknown = JSON.parse(status.value);
      return { ok: true, value, logs };
    } catch {
      return { ok: false, logs, failure: toFailure('shape', `钩子 ${hook} 的返回值无法解析`, []) };
    }
  };

  return {
    load,
    has,
    listHooks,
    call,
    dispose(): void {
      disposed = true;
    },
  };
}
