/**
 * 可复现随机数（splitmix32）。
 *
 * 为什么不用 Math.random：跑团需要复盘、回放和反作弊——同一次掷骰在日志里必须可验证。
 * 引擎的随机数由「房间种子 + 掷骰序号」派生，事件日志记录序号，重放结果一致。
 */
export interface Rng {
  /** 返回 [0, maxExclusive) 的整数。 */
  nextInt(maxExclusive: number): number;
  /** 返回 [0, 1) 的浮点数。 */
  nextFloat(): number;
  /** 当前内部状态，便于调试与快照。 */
  state(): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    z = (z ^ (z >>> 15)) >>> 0;
    return z;
  };
  return {
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
      }
      return nextUint32() % maxExclusive;
    },
    nextFloat(): number {
      return nextUint32() / 0x100000000;
    },
    state(): number {
      return state >>> 0;
    },
  };
}

/** 掷一个 n 面骰。 */
export function rollDie(sides: number, rng: Rng): number {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new RangeError(`die sides must be an integer >= 2, got ${sides}`);
  }
  return rng.nextInt(sides) + 1;
}

/** 由房间种子 + 掷骰序号派生单个掷骰的种子，保证每次掷骰可独立回放。 */
export function deriveRollSeed(roomSeed: number, rollIndex: number): number {
  return (Math.imul(roomSeed >>> 0, 0x85ebca6b) ^ Math.imul(rollIndex + 1, 0xc2b2ae35)) >>> 0;
}
