/**
 * 运行时内部小工具（纯函数，零依赖）。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

export function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

/** JSON 化深拷贝（保证快照/事件负载是纯 JSON，不含 undefined 与类实例）。 */
export function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 深拷贝（纯数据用；比 JSON 化保留 undefined 语义）。 */
export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** 把未知值压成中文可读错误文本。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
