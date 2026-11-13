/**
 * 骰子表达式解析与掷骰。
 *
 * v1 支持：`d20`、`1d8`、`2d6+3`、`1d8 - 1`（允许空格，N 省略时按 1 计）。
 * 不支持多骰组（如 `1d6+2d8`）——战斗结算里由调用方组合，避免解析歧义。
 */

export interface DiceExpression {
  count: number;
  sides: number;
  modifier: number;
  source: string;
}

const DICE_PATTERN = /^\s*(?:(\d+)\s*)?d\s*(\d+)\s*(?:([+-])\s*(\d+)\s*)?$/i;

export function parseDiceExpression(source: string): DiceExpression {
  const match = DICE_PATTERN.exec(source);
  if (!match) {
    throw new SyntaxError(`invalid dice expression: ${JSON.stringify(source)}`);
  }
  const count = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
  const sides = Number.parseInt(match[2] as string, 10);
  const modifier = match[3] === undefined ? 0 : Number.parseInt(match[4] as string, 10) * (match[3] === '-' ? -1 : 1);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError(`dice count must be 1-100, got ${count}`);
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
    throw new RangeError(`dice sides must be 2-1000, got ${sides}`);
  }
  return { count, sides, modifier, source: source.trim() };
}

export interface RollResult {
  expression: string;
  dice: number[];
  modifier: number;
  total: number;
}

/** 掷骰；rng 由调用方提供（见 rng.ts），保证可回放。 */
export function rollDice(
  expression: string | DiceExpression,
  rng: { nextInt(maxExclusive: number): number },
): RollResult {
  const parsed = typeof expression === 'string' ? parseDiceExpression(expression) : expression;
  const dice: number[] = [];
  for (let i = 0; i < parsed.count; i += 1) {
    dice.push(rng.nextInt(parsed.sides) + 1);
  }
  const total = dice.reduce((sum, die) => sum + die, 0) + parsed.modifier;
  return { expression: parsed.source, dice, modifier: parsed.modifier, total };
}

// ---------------------------------------------------------------------------
// 检定
// ---------------------------------------------------------------------------

export type CheckMode = 'normal' | 'advantage' | 'disadvantage';

export interface CheckRequest {
  /** 总加值：属性调整 + 熟练（若熟练）+ 其他。 */
  modifier: number;
  dc: number;
  mode?: CheckMode;
  /** 失败也返回骰面（默认真）；某些暗骰需要隐藏，交给上层投影决定。 */
}

export interface CheckResult {
  kind: 'check';
  mode: CheckMode;
  rolls: number[];
  d20: number;
  modifier: number;
  total: number;
  dc: number;
  success: boolean;
  critical: boolean;
  fumble: boolean;
}

/** 掷 d20 检定。优势/劣势取两骰之一，且不叠加（只由 mode 决定）。 */
export function rollCheck(
  request: CheckRequest,
  rng: { nextInt(maxExclusive: number): number },
): CheckResult {
  const mode: CheckMode = request.mode ?? 'normal';
  const count = mode === 'normal' ? 1 : 2;
  const rolls: number[] = [];
  for (let i = 0; i < count; i += 1) rolls.push(rng.nextInt(20) + 1);
  const d20 =
    mode === 'advantage'
      ? Math.max(...rolls)
      : mode === 'disadvantage'
        ? Math.min(...rolls)
        : (rolls[0] as number);
  const total = d20 + request.modifier;
  return {
    kind: 'check',
    mode,
    rolls,
    d20,
    modifier: request.modifier,
    total,
    dc: request.dc,
    success: total >= request.dc,
    critical: d20 === 20,
    fumble: d20 === 1,
  };
}

export function abilityModifier(score: number): number {
  if (!Number.isInteger(score)) throw new RangeError(`ability score must be an integer, got ${score}`);
  return Math.floor((score - 10) / 2);
}
