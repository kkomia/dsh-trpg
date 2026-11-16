/**
 * 骰子表达式解析与掷骰（M9.2）。
 *
 * 支持（比 M9.1 的 schema 校验形状更宽，仍保持简单可预期）：
 *   `d20` / `1d8` / `2d6+3` / `1d8-2` / `3`（纯加值）/ `-2` / `1d8+1d6+2`（多项相加）
 * 允许空格；不支持 `*` `/` 与多骰组嵌套（如 `(1d6)d6`）。
 *
 * 掷骰只接受 `RngSession`（种子化），因此同 seed 必得同骰面；本文件不碰 Math.random。
 */
import type { RngSession } from './rng.ts';

export interface DiceTerm {
  count: number;
  sides: number;
}

export interface ParsedDiceExpression {
  source: string;
  terms: DiceTerm[];
  /** 纯数值项之和（可为负）。 */
  modifier: number;
}

export interface DiceRoll {
  /** 原始表达式（trim 后）。 */
  expr: string;
  /** 所有骰面（按表达式顺序展开，不含加值）。 */
  dice: number[];
  modifier: number;
  total: number;
  terms: DiceTerm[];
}

export const DICE_LIMITS = {
  maxLength: 128,
  maxTerms: 12,
  maxCount: 100,
  minSides: 2,
  maxSides: 1000,
  maxModifier: 100000,
} as const;

function fail(expression: string, reason: string): never {
  throw new RangeError(`骰子表达式非法（${JSON.stringify(expression)}）：${reason}`);
}

/**
 * 解析骰子表达式。非法输入抛 RangeError（中文人话原因）。
 */
export function parseDiceExpression(expression: unknown): ParsedDiceExpression {
  if (typeof expression !== 'string') fail(String(expression), '必须是字符串');
  const source = expression.trim();
  if (source.length === 0) fail(source, '不能为空');
  if (source.length > DICE_LIMITS.maxLength) fail(source, `过长（${source.length} 字符，上限 ${DICE_LIMITS.maxLength}）`);

  const terms: DiceTerm[] = [];
  let modifier = 0;
  let index = 0;
  let expectedOperand = true;
  let sign = 1;
  let operandCount = 0;
  let sawDice = false;

  const readNumber = (): number | undefined => {
    const start = index;
    while (index < source.length) {
      const ch = source[index] as string;
      if (ch < '0' || ch > '9') break;
      index += 1;
    }
    if (index === start) return undefined;
    return Number.parseInt(source.slice(start, index), 10);
  };

  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t') {
      index += 1;
      continue;
    }
    if (ch === '+' || ch === '-') {
      if (expectedOperand) {
        // 表达式开头/运算符后的正负号
        if (ch === '-') sign = -sign;
        index += 1;
        continue;
      }
      sign = ch === '-' ? -1 : 1;
      expectedOperand = true;
      index += 1;
      continue;
    }
    if (!expectedOperand) fail(source, `位置 ${index + 1} 缺少运算符`);
    if (ch === 'd' || ch === 'D') {
      index += 1;
      const sides = readNumber();
      if (sides === undefined) fail(source, `"${ch}" 后缺少骰面数`);
      if (sides < DICE_LIMITS.minSides || sides > DICE_LIMITS.maxSides) {
        fail(source, `骰面数 ${sides} 超出允许范围 ${DICE_LIMITS.minSides}–${DICE_LIMITS.maxSides}`);
      }
      terms.push({ count: 1, sides });
      sawDice = true;
      operandCount += 1;
      expectedOperand = false;
      sign = 1;
      continue;
    }
    const value = readNumber();
    if (value === undefined) fail(source, `无法识别的字符 "${ch}"（位置 ${index + 1}）`);
    if (index < source.length && (source[index] === 'd' || source[index] === 'D')) {
      index += 1;
      const sides = readNumber();
      if (sides === undefined) fail(source, `"d" 后缺少骰面数`);
      if (value < 1 || value > DICE_LIMITS.maxCount) {
        fail(source, `骰子个数 ${value} 超出允许范围 1–${DICE_LIMITS.maxCount}`);
      }
      if (sides < DICE_LIMITS.minSides || sides > DICE_LIMITS.maxSides) {
        fail(source, `骰面数 ${sides} 超出允许范围 ${DICE_LIMITS.minSides}–${DICE_LIMITS.maxSides}`);
      }
      terms.push({ count: value, sides });
      sawDice = true;
      operandCount += 1;
      expectedOperand = false;
      sign = 1;
      continue;
    }
    // 纯数值项
    modifier += sign * value;
    sawDice = false;
    operandCount += 1;
    expectedOperand = false;
    sign = 1;
  }

  if (operandCount === 0) fail(source, '至少需要一项骰子或加值');
  if (expectedOperand) fail(source, '表达式末尾缺少操作数');
  if (Math.abs(modifier) > DICE_LIMITS.maxModifier) {
    fail(source, `加值 ${modifier} 超出允许范围 ±${DICE_LIMITS.maxModifier}`);
  }
  const totalTerms = terms.reduce((sum, term) => sum + term.count, 0);
  if (totalTerms > DICE_LIMITS.maxTerms * DICE_LIMITS.maxCount) {
    fail(source, '骰子项数过多');
  }
  if (terms.length > DICE_LIMITS.maxTerms) {
    fail(source, `骰子项 ${terms.length} 组超过上限 ${DICE_LIMITS.maxTerms}`);
  }
  if (!sawDice && terms.length === 0 && operandCount > 1) {
    // 纯数字相加已并入 modifier，合法
  }
  return { source, terms, modifier };
}

/** 形状校验（不抛错版本，供输入校验用）。 */
export function isDiceExpression(expression: unknown): boolean {
  try {
    parseDiceExpression(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * 掷骰。`expression` 可传字符串或已解析结果；骰面全部来自 `rng`。
 * 返回 `{dice, total, expr}`（额外带 modifier/terms，便于结构化日志）。
 */
export function rollDice(expression: string | ParsedDiceExpression, rng: RngSession): DiceRoll {
  const parsed = typeof expression === 'string' ? parseDiceExpression(expression) : expression;
  const dice: number[] = [];
  for (const term of parsed.terms) {
    for (let i = 0; i < term.count; i += 1) dice.push(rng.nextDie(term.sides));
  }
  const sum = dice.reduce((total, die) => total + die, 0);
  return {
    expr: parsed.source,
    dice,
    modifier: parsed.modifier,
    total: sum + parsed.modifier,
    terms: parsed.terms.map((term) => ({ ...term })),
  };
}
