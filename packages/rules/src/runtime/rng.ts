/**
 * 种子化随机（M9.2 确定性要求，docs/RULES-MODEL §6/§9/§10）。
 *
 * 推导式：`sha256(roomSeed : eventSeq : hookName : callIndex : counter)` → 取字节归一化。
 * - `roomSeed`：房间种子；
 * - `eventSeq`：本次随机发生时已广播的事件数（同一命令序列必然复现）；
 * - `hookName`：调用随机的作用域（`resolveCheck` / `initiative` / `default:resolveCheck` …）；
 * - `callIndex`：本次随机 session 的全局调用序号（快照记录 `rollCallSeq`）。
 *
 * 同一 session 内连续取数由 `counter` 递增区分，快照记录 `counter` 即可续算。
 * **禁止** `Math.random` / 系统时间：本文件只用 `node:crypto` 的 sha256。
 */
import { createHash } from 'node:crypto';

/** 随机派生的四个种子分量。 */
export interface RngSeedParts {
  roomSeed: number;
  eventSeq: number;
  hook: string;
  callIndex: number;
}

export interface RngState extends RngSeedParts {
  counter: number;
}

export interface RngSession {
  /** 只读种子分量（快照/日志用）。 */
  readonly seed: RngSeedParts;
  /** 已取数次数（下一次取数用它派生）。 */
  counter(): number;
  /** 取一个 uint32。 */
  nextUint32(): number;
  /** 取 [0,1) 浮点（48 位精度）。 */
  nextFloat(): number;
  /** 取 [0, maxExclusive) 整数。 */
  nextInt(maxExclusive: number): number;
  /** 掷一个 `sides` 面骰，返回 1..sides。 */
  nextDie(sides: number): number;
  state(): RngState;
}

/** 把房间种子归一化成 uint32；非法值抛 RangeError（确定性不允许 NaN）。 */
export function normalizeRoomSeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`房间种子必须是有限数值，收到 ${String(value)}`);
  }
  return Math.trunc(value) >>> 0;
}

function normalizeUint32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.trunc(value) >>> 0;
}

/** 派生 32 字节摘要（sha256）。纯函数，同样的 seed + counter 必得同样字节。 */
export function deriveRngBytes(seed: RngSeedParts, counter: number): Buffer {
  const text = `${normalizeUint32(seed.roomSeed)}:${normalizeUint32(seed.eventSeq)}:${String(seed.hook)}:${normalizeUint32(seed.callIndex)}:${normalizeUint32(counter)}`;
  return createHash('sha256').update(text, 'utf8').digest();
}

/** sha256 → [0,1) 的纯函数版本（不做 session 计数，供测试/工具核对）。 */
export function hashToUnitInterval(seed: RngSeedParts, counter = 0): number {
  const digest = deriveRngBytes(seed, counter);
  const value = digest.readUIntBE(0, 6);
  return value / 281474976710656; // 2^48
}

const TWO_POW_48 = 281474976710656;

/**
 * 创建一次随机 session。
 *
 * @param seed 四个种子分量（`hook` 用中文/英文均可，只要同一作用域稳定）
 * @param startCounter 已取数次数（快照续算用，默认 0）
 */
export function createSeededRng(seed: RngSeedParts, startCounter = 0): RngSession {
  const parts: RngSeedParts = {
    roomSeed: normalizeUint32(seed.roomSeed),
    eventSeq: normalizeUint32(seed.eventSeq),
    hook: String(seed.hook),
    callIndex: normalizeUint32(seed.callIndex),
  };
  let counter = Number.isFinite(startCounter) && startCounter > 0 ? Math.trunc(startCounter) : 0;

  const nextUint32 = (): number => {
    const digest = deriveRngBytes(parts, counter);
    counter += 1;
    return digest.readUInt32BE(0);
  };

  return {
    seed: parts,
    counter(): number {
      return counter;
    },
    nextUint32,
    nextFloat(): number {
      const digest = deriveRngBytes(parts, counter);
      counter += 1;
      return digest.readUIntBE(0, 6) / TWO_POW_48;
    },
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`maxExclusive 必须是正整数，收到 ${String(maxExclusive)}`);
      }
      return nextUint32() % maxExclusive;
    },
    nextDie(sides: number): number {
      if (!Number.isInteger(sides) || sides < 2) {
        throw new RangeError(`骰面数必须是 >=2 的整数，收到 ${String(sides)}`);
      }
      return (nextUint32() % sides) + 1;
    },
    state(): RngState {
      return { ...parts, counter };
    },
  };
}
