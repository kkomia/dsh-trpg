import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectFormulaRefs,
  compileFormula,
  evaluateFormula,
  type FormulaContext,
  type FormulaScope,
} from '../src/index.ts';

function evalOk(source: string, ctx: FormulaContext = {}): number {
  const compiled = compileFormula(source);
  assert.equal(
    compiled.ok,
    true,
    compiled.ok ? '' : compiled.errors.map((issue) => `${issue.position}:${issue.message}`).join('; '),
  );
  if (!compiled.ok) throw new Error('unreachable');
  const result = evaluateFormula(compiled.ast, ctx);
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

function compileErrorMessages(source: string, scope?: FormulaScope): string[] {
  const result = compileFormula(source, scope);
  assert.equal(result.ok, false, `预期编译失败：${source}`);
  return result.ok ? [] : result.errors.map((issue) => `${issue.position} ${issue.message}`);
}

// ---------------------------------------------------------------------------
// 算术与优先级
// ---------------------------------------------------------------------------

test('公式：乘法优先于加法', () => {
  assert.equal(evalOk('2 + 3 * 4'), 14);
});

test('公式：括号改变优先级', () => {
  assert.equal(evalOk('(2 + 3) * 4'), 20);
});

test('公式：减法左结合', () => {
  assert.equal(evalOk('10 - 3 - 2'), 5);
});

test('公式：除法左结合', () => {
  assert.equal(evalOk('20 / 2 / 5'), 2);
});

test('公式：一元负号', () => {
  assert.equal(evalOk('-5 + 3'), -2);
});

test('公式：连续一元负号', () => {
  assert.equal(evalOk('--4'), 4);
});

test('公式：运算符后可跟一元负号', () => {
  assert.equal(evalOk('2 * -3'), -6);
});

test('公式：除法是实数除法（7 / 2 = 3.5）', () => {
  assert.equal(evalOk('7 / 2'), 3.5);
});

test('公式：取整交给 floor（floor(7 / 2) = 3）', () => {
  assert.equal(evalOk('floor(7 / 2)'), 3);
});

test('公式：取模', () => {
  assert.equal(evalOk('7 % 4'), 3);
});

test('公式：负数取模沿用 JS 余数语义', () => {
  assert.equal(evalOk('-7 % 4'), -3);
});

test('公式：小数', () => {
  assert.equal(evalOk('1.5 * 2'), 3);
});

// ---------------------------------------------------------------------------
// 白名单函数
// ---------------------------------------------------------------------------

test('公式：floor / ceil / round / abs', () => {
  assert.equal(evalOk('floor(3.7) + ceil(3.2) + round(2.5) + abs(-4)'), 3 + 4 + 3 + 4);
});

test('公式：min / max 支持多参数', () => {
  assert.equal(evalOk('min(5, 2, 9) + max(5, 2, 9)'), 11);
});

test('公式：clamp 中值原样返回', () => {
  assert.equal(evalOk('clamp(5, 0, 10)'), 5);
});

test('公式：clamp 下界', () => {
  assert.equal(evalOk('clamp(-2, 0, 10)'), 0);
});

test('公式：clamp 上界', () => {
  assert.equal(evalOk('clamp(12, 0, 10)'), 10);
});

test('公式：函数可嵌套', () => {
  assert.equal(evalOk('max(1, min(3, 5) + floor(1.9))'), 4);
});

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------

test('公式：全部命名空间变量', () => {
  const value = evalOk(
    'attr.str + derived.mod.dex + equip.攻击 + skill.athletics + sheet.负重 + resource.hp + level + proficiency',
    {
      attr: { str: 3 },
      derived: { 'mod.dex': 2 },
      equip: { 攻击: 4 },
      skill: { athletics: 1 },
      sheet: { 负重: 5 },
      resource: { hp: 7 },
      level: 2,
      proficiency: 2,
    },
  );
  assert.equal(value, 26);
});

test('公式：skill.proficient / skill.bonus 结算上下文', () => {
  assert.equal(evalOk('skill.proficient * proficiency + skill.bonus', { skill: { proficient: 1, bonus: 2 }, proficiency: 3 }), 5);
});

test('公式：space / time 上下文', () => {
  assert.equal(evalOk('space.cells * 2 + time.round', { space: { cells: 3 }, time: { round: 2 } }), 8);
});

test('公式：derived 支持多点路径（扁平键 mod.dex）', () => {
  assert.equal(evalOk('derived.mod.dex + 1', { derived: { 'mod.dex': 4 } }), 5);
});

// ---------------------------------------------------------------------------
// 引用收集
// ---------------------------------------------------------------------------

test('公式：collectFormulaRefs 去重且保留首次出现顺序', () => {
  const compiled = compileFormula('attr.str + attr.str + equip.攻击 + clamp(derived.ac, 0, 40)');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const refs = collectFormulaRefs(compiled.ast);
  assert.deepEqual(refs.map((ref) => ref.path), ['attr.str', 'equip.攻击', 'derived.ac']);
  assert.deepEqual(refs.map((ref) => ref.namespace), ['attr', 'equip', 'derived']);
});

test('公式：常量没有变量引用', () => {
  const compiled = compileFormula('42');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  assert.deepEqual(compiled.refs, []);
});

// ---------------------------------------------------------------------------
// 编译期错误
// ---------------------------------------------------------------------------

test('公式：空公式报错', () => {
  const messages = compileErrorMessages('');
  assert.ok(messages.some((message) => message.includes('不能为空')));
});

test('公式：纯空白公式报错', () => {
  const messages = compileErrorMessages('   ');
  assert.ok(messages.some((message) => message.includes('不能为空')));
});

test('公式：未知裸变量报错并带列号', () => {
  const messages = compileErrorMessages('foo + 1');
  assert.ok(messages.some((message) => message.includes('未知变量') && message.includes('foo')));
  assert.ok(messages[0]?.startsWith('1 '), messages.join('; '));
});

test('公式：未知命名空间报错', () => {
  const messages = compileErrorMessages('mana.x + 1');
  assert.ok(messages.some((message) => message.includes('未知变量命名空间')));
});

test('公式：未知函数报错', () => {
  const messages = compileErrorMessages('sqrt(4)');
  assert.ok(messages.some((message) => message.includes('未知函数') && message.includes('sqrt')));
});

test('公式：白名单函数不加括号报错', () => {
  const messages = compileErrorMessages('min + 1');
  assert.ok(messages.some((message) => message.includes('必须以 "(" 调用')));
});

test('公式：作用域内未知属性报错', () => {
  const messages = compileErrorMessages('attr.str', { attributes: ['dex'] });
  assert.ok(messages.some((message) => message.includes('没有声明属性')));
});

test('公式：无作用域时接受任意属性 id（由校验器补作用域）', () => {
  assert.equal(evalOk('attr.str', { attr: { str: 5 } }), 5);
});

test('公式：作用域内未知技能报错', () => {
  const messages = compileErrorMessages('skill.arcana', { skills: ['stealth'] });
  assert.ok(messages.some((message) => message.includes('没有声明技能')));
});

test('公式：skill.proficient / skill.bonus 不需要技能声明', () => {
  const compiled = compileFormula('skill.proficient + skill.bonus', { skills: ['stealth'] });
  assert.equal(compiled.ok, true);
});

test('公式：作用域内未知数值字段报错', () => {
  const messages = compileErrorMessages('sheet.负重', { fields: ['level'] });
  assert.ok(messages.some((message) => message.includes('没有声明数值字段')));
});

test('公式：作用域内未知词条报错', () => {
  const messages = compileErrorMessages('equip.攻击', { stats: ['防御'] });
  assert.ok(messages.some((message) => message.includes('没有声明词条')));
});

test('公式：未知 space 键报错', () => {
  const messages = compileErrorMessages('space.foo');
  assert.ok(messages.some((message) => message.includes('space 可用键')));
});

test('公式：space 文档键合法', () => {
  assert.equal(evalOk('space.hops + space.meters', { space: { hops: 1, meters: 2 } }), 3);
});

test('公式：缺操作数报错并定位到末尾', () => {
  const messages = compileErrorMessages('1 + ');
  assert.ok(messages.some((message) => message.includes('缺少操作数')));
  assert.ok(messages.some((message) => message.startsWith('5 ')), messages.join('; '));
});

test('公式：括号不匹配报错', () => {
  const messages = compileErrorMessages('(1 + 2');
  assert.ok(messages.some((message) => message.includes('括号不匹配')));
});

test('公式：末尾多余内容报错', () => {
  const messages = compileErrorMessages('1 2');
  assert.ok(messages.some((message) => message.includes('多余内容')));
});

test('公式：一次聚合多个编译错误', () => {
  const messages = compileErrorMessages('foo + bar(1)');
  assert.ok(messages.length >= 2);
  assert.ok(messages.some((message) => message.includes('未知变量')));
  assert.ok(messages.some((message) => message.includes('未知函数')));
});

test('公式：clamp 参数个数错误', () => {
  const messages = compileErrorMessages('clamp(1, 2)');
  assert.ok(messages.some((message) => message.includes('clamp') && message.includes('3 个')));
});

test('公式：floor 参数个数错误', () => {
  const messages = compileErrorMessages('floor(1, 2)');
  assert.ok(messages.some((message) => message.includes('floor')));
});

test('公式：min 至少一个参数', () => {
  const messages = compileErrorMessages('min()');
  assert.ok(messages.some((message) => message.includes('min')));
});

test('公式：数字格式错误', () => {
  const messages = compileErrorMessages('1.');
  assert.ok(messages.some((message) => message.includes('小数点后缺少数字')));
});

test('公式：超长公式拒绝编译', () => {
  const messages = compileErrorMessages(`1${'+1'.repeat(600)}`);
  assert.ok(messages.some((message) => message.includes('过长')));
});

// ---------------------------------------------------------------------------
// 运行期错误
// ---------------------------------------------------------------------------

function evalError(source: string, ctx: FormulaContext = {}): string {
  const compiled = compileFormula(source);
  assert.equal(compiled.ok, true, compiled.ok ? '' : '预期编译成功');
  if (!compiled.ok) throw new Error('unreachable');
  const result = evaluateFormula(compiled.ast, ctx);
  assert.equal(result.ok, false, '预期运行期失败');
  return result.ok ? '' : result.error;
}

test('公式：运行期除零报错', () => {
  assert.ok(evalError('1 / 0').includes('除零'));
});

test('公式：运行期模零报错', () => {
  assert.ok(evalError('1 % 0').includes('模零'));
});

test('公式：运行期缺 key 报错', () => {
  const message = evalError('attr.str + 1');
  assert.ok(message.includes('缺少变量') && message.includes('attr.str'));
});

test('公式：运行期非数值报错', () => {
  const message = evalError('derived.ac', { derived: { ac: '高' } });
  assert.ok(message.includes('不是数值'));
});

test('公式：clamp 下界大于上界报错', () => {
  assert.ok(evalError('clamp(1, 5, 2)').includes('clamp 下界'));
});

test('公式：求值确定性（同 AST 同上下文结果一致）', () => {
  const compiled = compileFormula('derived.mod.dex * 2 + 1');
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const ctx: FormulaContext = { derived: { 'mod.dex': 3 } };
  const first = evaluateFormula(compiled.ast, ctx);
  const second = evaluateFormula(compiled.ast, ctx);
  assert.deepEqual(first, second);
});

test('公式：不用 eval / Function（源码不含危险构造即可编译）', () => {
  const messages = compileErrorMessages('eval(1)');
  assert.ok(messages.some((message) => message.includes('未知函数')));
});
