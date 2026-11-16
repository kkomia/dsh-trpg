/**
 * 受限公式语言：词法 → 递归下降解析 → AST 求值。
 *
 * 语法（docs/RULES-MODEL §5）：
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := '-' factor | primary
 *   primary := number | path | func '(' args ')' | '(' expr ')'
 *   path    := id ('.' id)+ | 'level' | 'proficiency'
 *   func    := min | max | floor | ceil | round | abs | clamp
 *
 * 明确不做：eval / Function / vm / 字符串 / 布尔 / 比较 / 赋值 / 随机 / 时间 / 副作用。
 * 求值确定性：纯函数，同样 AST + 同样 ctx 必得同样结果。
 */
import {
  FORMULA_BASE_VARIABLES,
  FORMULA_FUNCTIONS,
  FORMULA_NAMESPACES,
  RULE_LIMITS,
  SKILL_CONTEXT_KEYS,
  SPACE_FORMULA_KEYS,
  TIME_FORMULA_KEYS,
  type FormulaFunctionName,
  type FormulaNamespace,
} from './types.ts';

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

export interface FormulaIssue {
  /** 中文人话错误。 */
  message: string;
  /** 1-based 列号（指向出问题的 token 起始位置）。 */
  position: number;
}

export type FormulaBinaryOperator = '+' | '-' | '*' | '/' | '%';

export type FormulaNode =
  | { type: 'number'; value: number; position: number }
  | { type: 'ref'; path: string; segments: string[]; position: number }
  | { type: 'unary'; operator: '-'; operand: FormulaNode; position: number }
  | {
      type: 'binary';
      operator: FormulaBinaryOperator;
      left: FormulaNode;
      right: FormulaNode;
      position: number;
    }
  | { type: 'call'; name: string; args: FormulaNode[]; position: number };

/** 公式引用的变量（`attr.str`、`derived.mod.dex`、`skill.proficient` …）。 */
export interface FormulaRef {
  /** 完整路径，如 `derived.mod.dex`。 */
  path: string;
  /** 命名空间根，如 `derived`；裸变量（level/proficiency）的 root 为空字符串。 */
  namespace: FormulaNamespace | '';
  /** 点分后的各段。 */
  segments: string[];
}

/**
 * 编译期的声明作用域：传了哪个数组，就按哪个数组校验对应命名空间的 id。
 * 不传（或某字段缺省）= 只校验命名空间与路径形状，不校验 id 是否存在。
 * `derived.*` 由钩子产出，默认不限制；`space.*` / `time.*` 默认按文档注入键限制。
 */
export interface FormulaScope {
  attributes?: readonly string[];
  resources?: readonly string[];
  /** 只允许 number 类型自由字段（公式里不能读文本/枚举）。 */
  fields?: readonly string[];
  /** 装备词条（`sheet.equipment.stats[]`）id。 */
  stats?: readonly string[];
  skills?: readonly string[];
  derivedKeys?: readonly string[];
  spaceKeys?: readonly string[];
  timeKeys?: readonly string[];
}

export interface FormulaCompileOk {
  ok: true;
  source: string;
  ast: FormulaNode;
  /** 去重后的变量引用（按首次出现顺序）。 */
  refs: FormulaRef[];
}

export interface FormulaCompileError {
  ok: false;
  errors: FormulaIssue[];
}

export type FormulaCompileResult = FormulaCompileOk | FormulaCompileError;

export interface FormulaEvalOk {
  ok: true;
  value: number;
}

export interface FormulaEvalError {
  ok: false;
  error: string;
}

export type FormulaEvalResult = FormulaEvalOk | FormulaEvalError;

/** 求值上下文：由主机按卡实例/派生值/结算上下文注入。缺 key 视为运行期错误。 */
export interface FormulaContext {
  attr?: Record<string, number>;
  derived?: Record<string, number | string>;
  equip?: Record<string, number>;
  /** `skill.<id>`、`skill.proficient`、`skill.bonus`。 */
  skill?: Record<string, number>;
  sheet?: Record<string, number>;
  resource?: Record<string, number>;
  space?: Record<string, number>;
  time?: Record<string, number>;
  level?: number;
  proficiency?: number;
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type TokenKind = 'number' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  kind: TokenKind;
  /** 原始文本（number 是源码片段；eof 为空字符串）。 */
  text: string;
  /** 1-based 列号。 */
  position: number;
}

interface TokenizeResult {
  tokens: Token[];
  errors: FormulaIssue[];
}

const IDENT_START = /[A-Za-z_\u4e00-\u9fa5]/;
const IDENT_PART = /[A-Za-z0-9_\u4e00-\u9fa5]/;

export function tokenizeFormula(source: string): TokenizeResult {
  const tokens: Token[] = [];
  const errors: FormulaIssue[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      index += 1;
      continue;
    }
    const position = index + 1;
    if (ch >= '0' && ch <= '9') {
      let end = index + 1;
      while (end < source.length && source[end] !== undefined && /[0-9]/.test(source[end] as string)) {
        end += 1;
      }
      if (source[end] === '.') {
        end += 1;
        const fractionStart = end;
        while (end < source.length && source[end] !== undefined && /[0-9]/.test(source[end] as string)) {
          end += 1;
        }
        if (end === fractionStart) {
          errors.push({ message: '数字格式错误：小数点后缺少数字', position });
        }
      }
      tokens.push({ kind: 'number', text: source.slice(index, end), position });
      index = end;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let end = index + 1;
      while (end < source.length) {
        const next = source[end];
        if (next === undefined || !IDENT_PART.test(next)) break;
        end += 1;
      }
      tokens.push({ kind: 'identifier', text: source.slice(index, end), position });
      index = end;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: ch, position });
      index += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ch, position });
      index += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', text: ch, position });
      index += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '.') {
      tokens.push({ kind: 'operator', text: ch, position });
      index += 1;
      continue;
    }
    errors.push({ message: `公式中出现无法识别的字符 "${ch}"`, position });
    index += 1;
  }
  tokens.push({ kind: 'eof', text: '', position: source.length + 1 });
  return { tokens, errors };
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface ParserState {
  tokens: Token[];
  index: number;
  errors: FormulaIssue[];
  depth: number;
}

const ARITY_TEXT: Record<FormulaFunctionName, string> = {
  min: '至少 1 个',
  max: '至少 1 个',
  floor: '1 个',
  ceil: '1 个',
  round: '1 个',
  abs: '1 个',
  clamp: '3 个',
};

function isFunctionName(name: string): name is FormulaFunctionName {
  return (FORMULA_FUNCTIONS as readonly string[]).includes(name);
}

function isBaseVariable(name: string): boolean {
  return (FORMULA_BASE_VARIABLES as readonly string[]).includes(name);
}

function isNamespace(value: string): value is FormulaNamespace {
  return (FORMULA_NAMESPACES as readonly string[]).includes(value);
}

function peek(state: ParserState): Token {
  return state.tokens[state.index] ?? { kind: 'eof', text: '', position: 1 };
}

function advance(state: ParserState): Token {
  const token = peek(state);
  if (token.kind !== 'eof') state.index += 1;
  return token;
}

function enterDepth(state: ParserState, position: number): boolean {
  state.depth += 1;
  if (state.depth > RULE_LIMITS.maxFormulaDepth) {
    pushError(state, `公式嵌套超过 ${RULE_LIMITS.maxFormulaDepth} 层`, position);
    return false;
  }
  return true;
}

function leaveDepth(state: ParserState): void {
  state.depth -= 1;
}

function pushError(state: ParserState, message: string, position: number): void {
  state.errors.push({ message, position });
}

/** 解析表达式入口（内部用），失败时返回占位 number 节点以便继续聚合错误。 */
function parseExpression(state: ParserState, scope: FormulaScope | undefined): FormulaNode {
  if (!enterDepth(state, peek(state).position)) {
    leaveDepth(state);
    return { type: 'number', value: 0, position: peek(state).position };
  }
  let left = parseTerm(state, scope);
  for (;;) {
    const token = peek(state);
    if (token.kind !== 'operator' || (token.text !== '+' && token.text !== '-')) break;
    advance(state);
    const right = parseTerm(state, scope);
    left = { type: 'binary', operator: token.text, left, right, position: token.position };
  }
  leaveDepth(state);
  return left;
}

function parseTerm(state: ParserState, scope: FormulaScope | undefined): FormulaNode {
  if (!enterDepth(state, peek(state).position)) {
    leaveDepth(state);
    return { type: 'number', value: 0, position: peek(state).position };
  }
  let left = parseFactor(state, scope);
  for (;;) {
    const token = peek(state);
    if (token.kind !== 'operator' || (token.text !== '*' && token.text !== '/' && token.text !== '%')) break;
    advance(state);
    const right = parseFactor(state, scope);
    left = { type: 'binary', operator: token.text, left, right, position: token.position };
  }
  leaveDepth(state);
  return left;
}

function parseFactor(state: ParserState, scope: FormulaScope | undefined): FormulaNode {
  if (!enterDepth(state, peek(state).position)) {
    leaveDepth(state);
    return { type: 'number', value: 0, position: peek(state).position };
  }
  const token = peek(state);
  if (token.kind === 'operator' && token.text === '-') {
    advance(state);
    const operand = parseFactor(state, scope);
    leaveDepth(state);
    return { type: 'unary', operator: '-', operand, position: token.position };
  }
  const node = parsePrimary(state, scope);
  leaveDepth(state);
  return node;
}

function parsePrimary(state: ParserState, scope: FormulaScope | undefined): FormulaNode {
  const token = peek(state);
  if (token.kind === 'number') {
    advance(state);
    const value = Number.parseFloat(token.text);
    return { type: 'number', value, position: token.position };
  }
  if (token.kind === 'lparen') {
    advance(state);
    const node = parseExpression(state, scope);
    const close = peek(state);
    if (close.kind !== 'rparen') {
      pushError(state, '括号不匹配：缺少 ")"', token.position);
      return node;
    }
    advance(state);
    return node;
  }
  if (token.kind === 'identifier') {
    advance(state);
    const segments: string[] = [token.text];
    while (peek(state).kind === 'operator' && peek(state).text === '.') {
      const dot = advance(state);
      const next = peek(state);
      if (next.kind !== 'identifier') {
        pushError(state, `"." 后缺少标识符`, dot.position);
        break;
      }
      advance(state);
      segments.push(next.text);
    }
    // 函数调用：单段标识符 + '('
    if (segments.length === 1 && peek(state).kind === 'lparen') {
      return parseCall(state, token, scope);
    }
    if (segments.length > 1 && peek(state).kind === 'lparen') {
      pushError(state, `不支持点分名函数调用 "${segments.join('.')}"`, token.position);
    }
    const path = segments.join('.');
    validateReference(state, path, segments, token.position, scope);
    return { type: 'ref', path, segments, position: token.position };
  }
  if (token.kind === 'rparen') {
    pushError(state, '括号不匹配：多余的 ")"', token.position);
    advance(state);
    return { type: 'number', value: 0, position: token.position };
  }
  if (token.kind === 'comma') {
    pushError(state, '逗号只能出现在函数参数之间', token.position);
    advance(state);
    return { type: 'number', value: 0, position: token.position };
  }
  if (token.kind === 'eof') {
    pushError(state, '公式不完整：缺少操作数', token.position);
    return { type: 'number', value: 0, position: token.position };
  }
  // operator
  pushError(state, `"${token.text}" 位置缺少操作数`, token.position);
  advance(state);
  return { type: 'number', value: 0, position: token.position };
}

function parseCall(state: ParserState, nameToken: Token, scope: FormulaScope | undefined): FormulaNode {
  const name = nameToken.text;
  advance(state); // consume '('
  const args: FormulaNode[] = [];
  if (peek(state).kind !== 'rparen') {
    for (;;) {
      args.push(parseExpression(state, scope));
      if (peek(state).kind === 'comma') {
        advance(state);
        continue;
      }
      break;
    }
  }
  if (peek(state).kind !== 'rparen') {
    pushError(state, `函数 ${name} 的参数缺少 ")"`, nameToken.position);
  } else {
    advance(state);
  }
  if (!isFunctionName(name)) {
    pushError(
      state,
      `未知函数 "${name}"（允许：${FORMULA_FUNCTIONS.join('/')}）`,
      nameToken.position,
    );
    return { type: 'call', name, args, position: nameToken.position };
  }
  const minArgs = name === 'min' || name === 'max' ? 1 : name === 'clamp' ? 3 : 1;
  const maxArgs = name === 'min' || name === 'max' ? Number.POSITIVE_INFINITY : name === 'clamp' ? 3 : 1;
  if (args.length < minArgs) {
    pushError(state, `函数 ${name} 需要 ${ARITY_TEXT[name]}参数，实际 ${args.length} 个`, nameToken.position);
  } else if (args.length > maxArgs) {
    pushError(state, `函数 ${name} 只接受 ${ARITY_TEXT[name]}参数，实际 ${args.length} 个`, nameToken.position);
  }
  return { type: 'call', name, args, position: nameToken.position };
}

function validateReference(
  state: ParserState,
  path: string,
  segments: string[],
  position: number,
  scope: FormulaScope | undefined,
): void {
  const root = segments[0] ?? '';
  if (segments.length === 1) {
    if (isBaseVariable(root)) return;
    if (isFunctionName(root)) {
      pushError(state, `函数 "${root}" 必须以 "(" 调用`, position);
      return;
    }
    pushError(state, `未知变量 "${root}"`, position);
    return;
  }
  if (!isNamespace(root)) {
    pushError(
      state,
      `未知变量命名空间 "${root}"（允许：${FORMULA_NAMESPACES.join('/')}）`,
      position,
    );
    return;
  }
  const namespace: FormulaNamespace = root;
  const key = segments[1] ?? '';
  if (namespace !== 'derived' && segments.length > 2) {
    pushError(state, `变量 "${path}" 只支持两级（${namespace}.<id>）`, position);
    return;
  }
  if (namespace === 'derived') {
    if (scope?.derivedKeys !== undefined && !scope.derivedKeys.includes(segments.slice(1).join('.'))) {
      pushError(state, `未知派生值 "${segments.slice(1).join('.')}"`, position);
    }
    return;
  }
  const scopeMap: Partial<Record<FormulaNamespace, readonly string[] | undefined>> = {
    attr: scope?.attributes,
    resource: scope?.resources,
    sheet: scope?.fields,
    equip: scope?.stats,
    skill: scope?.skills,
    space: scope?.spaceKeys ?? SPACE_FORMULA_KEYS,
    time: scope?.timeKeys ?? TIME_FORMULA_KEYS,
  };
  if (namespace === 'skill' && (SKILL_CONTEXT_KEYS as readonly string[]).includes(key)) return;
  const declared = scopeMap[namespace];
  if (declared === undefined) return;
  if (!declared.includes(key)) {
    if (namespace === 'attr') {
      pushError(state, `未知变量 "${path}"：规则包没有声明属性 "${key}"`, position);
    } else if (namespace === 'resource') {
      pushError(state, `未知变量 "${path}"：规则包没有声明资源 "${key}"`, position);
    } else if (namespace === 'sheet') {
      pushError(state, `未知变量 "${path}"：规则包没有声明数值字段 "${key}"`, position);
    } else if (namespace === 'equip') {
      pushError(state, `未知变量 "${path}"：规则包没有声明词条 "${key}"`, position);
    } else if (namespace === 'skill') {
      pushError(state, `未知变量 "${path}"：规则包没有声明技能 "${key}"`, position);
    } else if (namespace === 'space') {
      pushError(
        state,
        `未知变量 "${path}"（space 可用键：${(scope?.spaceKeys ?? SPACE_FORMULA_KEYS).join('/')}）`,
        position,
      );
    } else {
      pushError(
        state,
        `未知变量 "${path}"（time 可用键：${(scope?.timeKeys ?? TIME_FORMULA_KEYS).join('/')}）`,
        position,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 编译入口
// ---------------------------------------------------------------------------

function sortAndDedupeIssues(issues: FormulaIssue[]): FormulaIssue[] {
  const seen = new Set<string>();
  const unique: FormulaIssue[] = [];
  for (const issue of issues) {
    const marker = `${issue.position}:${issue.message}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    unique.push(issue);
  }
  unique.sort((a, b) => a.position - b.position || a.message.localeCompare(b.message));
  return unique;
}

export function compileFormula(source: string, scope?: FormulaScope): FormulaCompileResult {
  if (typeof source !== 'string') {
    return { ok: false, errors: [{ message: '公式必须是字符串', position: 1 }] };
  }
  if (source.length > RULE_LIMITS.maxFormulaLength) {
    return {
      ok: false,
      errors: [
        {
          message: `公式过长（${source.length} 字符，上限 ${RULE_LIMITS.maxFormulaLength}）`,
          position: RULE_LIMITS.maxFormulaLength + 1,
        },
      ],
    };
  }
  if (source.trim().length === 0) {
    return { ok: false, errors: [{ message: '公式不能为空', position: 1 }] };
  }
  const tokenized = tokenizeFormula(source);
  const state: ParserState = {
    tokens: tokenized.tokens,
    index: 0,
    errors: [...tokenized.errors],
    depth: 0,
  };
  const ast = parseExpression(state, scope);
  const leftover = peek(state);
  if (leftover.kind !== 'eof') {
    pushError(state, `公式末尾有多余内容 "${leftover.text}"`, leftover.position);
  }
  const errors = sortAndDedupeIssues(state.errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, source, ast, refs: collectFormulaRefs(ast) };
}

// ---------------------------------------------------------------------------
// 引用收集
// ---------------------------------------------------------------------------

function walkRefs(node: FormulaNode, out: FormulaRef[], seen: Set<string>): void {
  switch (node.type) {
    case 'number':
      return;
    case 'ref': {
      if (!seen.has(node.path)) {
        seen.add(node.path);
        const root = node.segments[0] ?? '';
        out.push({
          path: node.path,
          namespace: node.segments.length > 1 && isNamespace(root) ? root : '',
          segments: [...node.segments],
        });
      }
      return;
    }
    case 'unary':
      walkRefs(node.operand, out, seen);
      return;
    case 'binary':
      walkRefs(node.left, out, seen);
      walkRefs(node.right, out, seen);
      return;
    case 'call':
      for (const arg of node.args) walkRefs(arg, out, seen);
      return;
  }
}

/** 收集 AST 内去重后的变量引用（按首次出现顺序）。 */
export function collectFormulaRefs(ast: FormulaNode): FormulaRef[] {
  const out: FormulaRef[] = [];
  walkRefs(ast, out, new Set<string>());
  return out;
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

class FormulaEvalFailure extends Error {
  position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = 'FormulaEvalFailure';
    this.position = position;
  }
}

function finite(value: number, position: number): number {
  if (!Number.isFinite(value)) {
    throw new FormulaEvalFailure('计算结果不是有限数值', position);
  }
  return value;
}

function readRecord(
  record: Record<string, number> | Record<string, number | string> | undefined,
  key: string,
): number | string | undefined {
  if (record === undefined) return undefined;
  return (record as Record<string, number | string>)[key];
}

function resolveReference(node: Extract<FormulaNode, { type: 'ref' }>, ctx: FormulaContext): number {
  const segments = node.segments;
  const path = node.path;
  let value: number | string | undefined;
  if (segments.length === 1) {
    const name = segments[0] ?? '';
    if (name === 'level') value = ctx.level;
    else if (name === 'proficiency') value = ctx.proficiency;
    else throw new FormulaEvalFailure(`未知变量 "${path}"`, node.position);
  } else {
    const root = segments[0] ?? '';
    const key = segments.length > 2 ? segments.slice(1).join('.') : (segments[1] ?? '');
    if (root === 'attr') value = readRecord(ctx.attr, key);
    else if (root === 'derived') value = readRecord(ctx.derived, key);
    else if (root === 'equip') value = readRecord(ctx.equip, key);
    else if (root === 'skill') value = readRecord(ctx.skill, key);
    else if (root === 'sheet') value = readRecord(ctx.sheet, key);
    else if (root === 'resource') value = readRecord(ctx.resource, key);
    else if (root === 'space') value = readRecord(ctx.space, key);
    else if (root === 'time') value = readRecord(ctx.time, key);
    else throw new FormulaEvalFailure(`未知变量命名空间 "${root}"`, node.position);
  }
  if (value === undefined) {
    throw new FormulaEvalFailure(`缺少变量 "${path}"`, node.position);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FormulaEvalFailure(`变量 "${path}" 不是数值`, node.position);
  }
  return value;
}

function evalNode(node: FormulaNode, ctx: FormulaContext, depth: number): number {
  if (depth > RULE_LIMITS.maxFormulaDepth) {
    throw new FormulaEvalFailure(`求值嵌套超过 ${RULE_LIMITS.maxFormulaDepth} 层`, node.position);
  }
  switch (node.type) {
    case 'number':
      return finite(node.value, node.position);
    case 'ref':
      return resolveReference(node, ctx);
    case 'unary': {
      const operand = evalNode(node.operand, ctx, depth + 1);
      return finite(-operand, node.position);
    }
    case 'binary': {
      const left = evalNode(node.left, ctx, depth + 1);
      const right = evalNode(node.right, ctx, depth + 1);
      if (node.operator === '+') return finite(left + right, node.position);
      if (node.operator === '-') return finite(left - right, node.position);
      if (node.operator === '*') return finite(left * right, node.position);
      if (node.operator === '/') {
        if (right === 0) throw new FormulaEvalFailure('除零', node.position);
        return finite(left / right, node.position);
      }
      if (right === 0) throw new FormulaEvalFailure('模零（对 0 取余）', node.position);
      return finite(left % right, node.position);
    }
    case 'call': {
      const values = node.args.map((arg) => evalNode(arg, ctx, depth + 1));
      const name = node.name;
      if (name === 'floor') return finite(Math.floor(values[0] ?? 0), node.position);
      if (name === 'ceil') return finite(Math.ceil(values[0] ?? 0), node.position);
      if (name === 'round') return finite(Math.round(values[0] ?? 0), node.position);
      if (name === 'abs') return finite(Math.abs(values[0] ?? 0), node.position);
      if (name === 'min') return finite(Math.min(...values), node.position);
      if (name === 'max') return finite(Math.max(...values), node.position);
      if (name === 'clamp') {
        const value = values[0] ?? 0;
        const low = values[1] ?? 0;
        const high = values[2] ?? 0;
        if (low > high) {
          throw new FormulaEvalFailure(`clamp 下界 ${low} 大于上界 ${high}`, node.position);
        }
        return finite(Math.min(Math.max(value, low), high), node.position);
      }
      throw new FormulaEvalFailure(`未知函数 "${name}"`, node.position);
    }
  }
}

/** 求值。只接受编译产物 AST；运行期错误返回 `{ok:false,error}`，不抛异常。 */
export function evaluateFormula(ast: FormulaNode, ctx: FormulaContext): FormulaEvalResult {
  try {
    const value = evalNode(ast, ctx ?? {}, 0);
    if (!Number.isFinite(value)) return { ok: false, error: '计算结果不是有限数值' };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof FormulaEvalFailure) {
      return { ok: false, error: `第 ${error.position} 列：${error.message}` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
