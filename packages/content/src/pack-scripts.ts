/**
 * 规则脚本（`rules/scripts/**.js`）在内容包里的承载与完整性校验。
 *
 * 契约（docs/RULES-MODEL §3/§6/§10）：
 * - `pack.rules.scripts`（钩子名 → `{ file, sha256 }`）只记**引用与哈希**，脚本源码是 zip 里的独立条目
 *   `rules/scripts/*.js`，不内联进 `pack.json`（便于 diff、独立分发、单独审阅）；
 * - 导出/导入时必须校验「清单声明的文件都存在」且「sha256 与内容一致」，不一致拒绝打包/加载；
 * - 脚本路径只允许 `rules/scripts/` 下的相对 `.js`（不允许 `..` / 盘符 / 反斜杠）。
 *
 * 本模块是纯数据层（只用自带 sha256），浏览器与 Node 通用。
 */
import { sha256Hex } from './sha256.ts';
import { SCRIPT_PATH_PREFIX, type RulePack } from './rules-bridge.ts';

/** 脚本条目在 zip（与源码目录）里的路径前缀。 */
export const SCRIPT_ENTRY_PREFIX = SCRIPT_PATH_PREFIX;

/** 脚本上限（docs/RULES-MODEL §10：单包脚本 ≤ 32 个 / ≤ 256 KiB）。 */
export const SCRIPT_LIMITS = {
  maxScripts: 32,
  maxEntryBytes: 256 * 1024,
  maxTotalBytes: 256 * 1024,
} as const;

/** 一条脚本：路径 + 源码 + sha256（sha256 缺省时按源码算）。 */
export interface PackScriptSource {
  file: string;
  code: string;
  sha256?: string;
}

/** 规范化后的脚本条目。 */
export interface PackScriptEntry {
  file: string;
  code: string;
  sha256: string;
}

/** 脚本输入：Map / Record（路径 → UTF-8 字节或字符串）/ 数组。 */
export type PackScriptsInput =
  | Map<string, Uint8Array | string>
  | Record<string, Uint8Array | string>
  | readonly PackScriptSource[];

/** 脚本路径/内容不合法（由 pack-zip 转成 `PackValidationError`，保持对外错误形状一致）。 */
export class PackScriptError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`规则脚本不合法（${errors.length} 个问题）：\n- ${errors.join('\n- ')}`);
    this.name = 'PackScriptError';
    this.errors = errors;
  }
}

/** 脚本路径是否合法：`rules/scripts/**.js` 的相对路径。 */
export function isSafeScriptPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith(SCRIPT_ENTRY_PREFIX)) return false;
  if (!path.endsWith('.js')) return false;
  if (path.length <= SCRIPT_ENTRY_PREFIX.length + '.js'.length) return false;
  if (path.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
  }
  return true;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

function decodeScript(file: string, data: Uint8Array | string): string {
  if (typeof data === 'string') return data.replace(/^\uFEFF/u, '');
  try {
    return utf8Decoder.decode(data).replace(/^\uFEFF/u, '');
  } catch {
    throw new PackScriptError([`脚本 "${file}" 不是合法 UTF-8 文本`]);
  }
}

/**
 * 规范化脚本输入（校验路径/大小/重复，计算 sha256）。
 * 不合法直接抛 {@link PackScriptError}（调用方决定是拒绝打包还是汇总错误）。
 */
export function normalizePackScripts(input: PackScriptsInput | undefined): Map<string, PackScriptEntry> {
  const output = new Map<string, PackScriptEntry>();
  if (input === undefined) return output;
  const errors: string[] = [];
  const rawEntries: Array<{ file: unknown; data: Uint8Array | string | undefined; sha256?: unknown }> = [];
  if (Array.isArray(input)) {
    for (const item of input as readonly PackScriptSource[]) {
      rawEntries.push({
        file: (item as PackScriptSource | undefined)?.file,
        data: (item as PackScriptSource | undefined)?.code,
        sha256: (item as PackScriptSource | undefined)?.sha256,
      });
    }
  } else {
    const entries = input instanceof Map ? [...input.entries()] : Object.entries(input);
    for (const [file, data] of entries) rawEntries.push({ file, data });
  }

  let totalBytes = 0;
  for (const raw of rawEntries) {
    const file = typeof raw.file === 'string' ? raw.file.replaceAll('\\', '/') : '';
    if (!isSafeScriptPath(file)) {
      errors.push(`脚本路径非法（必须是 ${SCRIPT_ENTRY_PREFIX} 下的相对 .js 路径）：${String(raw.file)}`);
      continue;
    }
    if (output.has(file)) {
      errors.push(`脚本路径重复：${file}`);
      continue;
    }
    let code: string;
    try {
      code = decodeScript(file, raw.data as Uint8Array | string);
    } catch (error) {
      errors.push(error instanceof PackScriptError ? (error.errors[0] as string) : `脚本 "${file}" 无法读取`);
      continue;
    }
    const bytes = utf8Encoder.encode(code).length;
    if (bytes > SCRIPT_LIMITS.maxEntryBytes) {
      errors.push(`脚本 "${file}" 过大：${bytes} 字节，上限 ${SCRIPT_LIMITS.maxEntryBytes} 字节（§10）`);
      continue;
    }
    totalBytes += bytes;
    const sha256 = sha256Hex(code);
    if (raw.sha256 !== undefined && raw.sha256 !== sha256) {
      errors.push(`脚本 "${file}" 的 sha256 与内容不符（声明 ${String(raw.sha256).slice(0, 12)}…，实际 ${sha256.slice(0, 12)}…）`);
      continue;
    }
    output.set(file, { file, code, sha256 });
  }
  if (output.size > SCRIPT_LIMITS.maxScripts) {
    errors.push(`脚本数量 ${output.size} 超过上限 ${SCRIPT_LIMITS.maxScripts}（§10）`);
  }
  if (totalBytes > SCRIPT_LIMITS.maxTotalBytes) {
    errors.push(`脚本总量 ${totalBytes} 字节超过上限 ${SCRIPT_LIMITS.maxTotalBytes} 字节（§10）`);
  }
  if (errors.length > 0) throw new PackScriptError(errors);
  return output;
}

/** 规则包声明的脚本引用：文件 → { sha256, hooks[] }。 */
export function declaredScriptRefs(rules: RulePack | undefined): Map<string, { sha256: string; hooks: string[] }> {
  const refs = new Map<string, { sha256: string; hooks: string[] }>();
  const scripts = rules?.scripts;
  if (scripts === undefined || scripts === null || typeof scripts !== 'object') return refs;
  for (const [hook, ref] of Object.entries(scripts)) {
    if (ref === null || typeof ref !== 'object') continue;
    const file = (ref as { file?: unknown }).file;
    const sha256 = (ref as { sha256?: unknown }).sha256;
    if (typeof file !== 'string' || typeof sha256 !== 'string') continue;
    const existing = refs.get(file);
    if (existing === undefined) refs.set(file, { sha256, hooks: [hook] });
    else existing.hooks.push(hook);
  }
  return refs;
}

export interface PackScriptVerifyReport {
  errors: string[];
  warnings: string[];
  /** 规范化后的脚本条目（校验失败时可能是部分结果）。 */
  entries: Map<string, PackScriptEntry>;
}

/**
 * 校验 `pack.rules.scripts` 与脚本条目的一致性。
 *
 * - 传入 `input === undefined`：只做结构校验、**跳过** sha256（不报错也不告警）——
 *   这是「没有读到脚本字节」的调用方（如 host 列内置包）的降级路径；真正的包边界
 *   （`packToTrpgpack` / `trpgpackToPack` / `readPackJsonFile`）总会把脚本字节传进来。
 * - 传入了脚本：清单里的每个文件必须存在且 sha256 一致，否则 error；
 *   未被任何钩子引用的脚本条目给 warning（不阻断，便于作者暂存草稿）。
 */
export function verifyPackScripts(
  rules: RulePack | undefined,
  input: PackScriptsInput | undefined,
): PackScriptVerifyReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const declared = declaredScriptRefs(rules);
  for (const file of declared.keys()) {
    if (!isSafeScriptPath(file)) {
      errors.push(`规则包 scripts 引用的脚本路径非法：${file}`);
    }
  }
  let entries = new Map<string, PackScriptEntry>();
  if (input === undefined) return { errors, warnings, entries };
  try {
    entries = normalizePackScripts(input);
  } catch (error) {
    if (error instanceof PackScriptError) errors.push(...error.errors);
    else errors.push(error instanceof Error ? error.message : String(error));
    return { errors, warnings, entries };
  }
  for (const [file, ref] of declared) {
    const entry = entries.get(file);
    if (entry === undefined) {
      errors.push(`规则包引用的脚本 "${file}"（钩子 ${ref.hooks.join('/')}）不在包内，拒绝打包/加载`);
      continue;
    }
    if (entry.sha256 !== ref.sha256) {
      errors.push(
        `脚本 "${file}" 的 sha256 与规则包清单不符（清单 ${ref.sha256.slice(0, 12)}…，实际 ${entry.sha256.slice(0, 12)}…）`,
      );
    }
  }
  for (const file of entries.keys()) {
    if (!declared.has(file)) warnings.push(`孤立脚本（规则包 scripts 未引用，不阻断）：${file}`);
  }
  return { errors, warnings, entries };
}
