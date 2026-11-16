/**
 * SVG 白名单净化测试：合法图标通过 + 字节可复现；恶意/越界样本全部拒绝且原因中文可读。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSvg, SVG_LIMITS, SVG_NAMESPACE, SVG_VIEWBOX } from '../src/index.ts';
import { sha256Hex } from '../src/index.ts';

const VALID_ICON = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="256" height="256">
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff0000" stop-opacity="1"/>
      <stop offset="1" stop-color="#0000ff"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="112" height="112" rx="12" fill="url(#g1)"/>
  <path d="M32 96 L64 32 L96 96 Z" fill="#ffee00" stroke="#101010" stroke-width="4" stroke-linejoin="round"/>
</svg>`;

function expectRejected(source: string, messagePart?: string): string[] {
  const result = sanitizeSvg(source);
  assert.equal(result.ok, false, `应被拒绝但通过：${source.slice(0, 120)}`);
  assert.equal(result.svg, undefined);
  assert.ok(result.errors.length > 0, '拒绝时必须给出 errors');
  if (messagePart !== undefined) {
    assert.ok(
      result.errors.some((error) => error.includes(messagePart)),
      `错误信息应包含「${messagePart}」，实际：${result.errors.join(' | ')}`,
    );
  }
  return result.errors;
}

// ---------------------------------------------------------------------------
// 合法图标的通过 + 确定性
// ---------------------------------------------------------------------------

test('SVG 合法图标：通过并强制 viewBox/命名空间', () => {
  const result = sanitizeSvg(VALID_ICON);
  assert.equal(result.ok, true, result.errors.join(' | '));
  const svg = result.svg!;
  assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(svg.includes(`xmlns="${SVG_NAMESPACE}"`));
  assert.ok(svg.includes(`viewBox="${SVG_VIEWBOX}"`));
  assert.ok(!svg.includes('width="256"'), '根元素 width 必须剥离');
  assert.ok(!svg.includes('height="256"'), '根元素 height 必须剥离');
  assert.ok(svg.includes('<path'));
  assert.ok(svg.includes('url(#g1)'));
});

test('SVG 字节可复现：同一输入两次输出完全一致（sha256 稳定）', () => {
  const first = sanitizeSvg(VALID_ICON);
  const second = sanitizeSvg(VALID_ICON);
  assert.equal(first.ok, true);
  assert.equal(first.svg, second.svg);
  assert.equal(sha256Hex(first.svg!), sha256Hex(second.svg!));
});

test('SVG 属性顺序规范：属性乱序输入输出相同字节', () => {
  const left = sanitizeSvg(
    '<svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000" height="64" width="64" x="10" y="20"/></svg>',
  );
  const right = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect y="20" x="10" width="64" height="64" fill="#ff0000"/></svg>',
  );
  assert.equal(left.ok, true);
  assert.equal(left.svg, right.svg);
  assert.ok(left.svg!.includes('<rect x="10" y="20" width="64" height="64" fill="#ff0000"/>'));
});

test('SVG 属性名大小写容错：viewbox/GRADIENTUNITS 归一为规范名', () => {
  const result = sanitizeSvg(
    '<svg viewbox="0 0 128 128" xmlns="http://www.w3.org/2000/svg"><linearGradient id="a" gradientunits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.svg!.includes('gradientUnits="userSpaceOnUse"'));
});

test('SVG 输入 viewBox 非 128：根元素强制改写为 0 0 128 128', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#123456"/></svg>',
  );
  assert.equal(result.ok, true);
  assert.ok(result.svg!.includes('viewBox="0 0 128 128"'));
  assert.ok(!result.svg!.includes('0 0 64 64'));
});

test('SVG 允许 use + 内部 #fragment href（xlink:href 被改写为 href）', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128"><defs><path id="p" d="M0 0 L10 10"/></defs><use xlink:href="#p" x="4" y="4"/></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.svg!.includes('<use x="4" y="4" href="#p"/>'));
  assert.ok(!result.svg!.includes('xlink'));
});

test('SVG id/class 保留，未知属性静默丢弃', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g id="layer" class="icon" data-scene="x" aria-label="y"><rect width="10" height="10"/></g></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(result.svg!.includes('<g id="layer" class="icon">'));
  assert.ok(!result.svg!.includes('data-scene'));
  assert.ok(!result.svg!.includes('aria-label'));
});

// ---------------------------------------------------------------------------
// 拒绝：危险元素 / 属性 / 外链 / 实体
// ---------------------------------------------------------------------------

test('SVG script：拒绝（嵌套在 g 里也拒绝）', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g><script>alert(1)</script></g></svg>',
    'script',
  );
});

test('SVG foreignObject：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><foreignObject><div>hi</div></foreignObject></svg>',
    'foreignObject',
  );
});

test('SVG 内联事件 onclick：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect onclick="alert(1)" width="10" height="10"/></svg>',
    'onclick',
  );
});

test('SVG 根元素上的 onload：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 128 128"><rect width="1" height="1"/></svg>',
    'onload',
  );
});

test('SVG style 元素：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><style>.a{fill:red}</style><rect class="a" width="1" height="1"/></svg>',
    'style',
  );
});

test('SVG style 内联属性：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect style="fill:red" width="1" height="1"/></svg>',
    'style',
  );
});

test('SVG image 元素：拒绝（不代抓外链）', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image href="https://evil.example/x.png"/></svg>',
    'image',
  );
});

test('SVG animate/set 动画元素：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="1" height="1"><animate attributeName="x" to="10"/></rect></svg>',
    'animate',
  );
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><set attributeName="x" to="10"/></svg>',
    'set',
  );
});

test('SVG text 元素：拒绝（白名单外，图标不允许文字）', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><text x="0" y="0">字</text></svg>',
    'text',
  );
});

test('SVG 外部 href（https）：拒绝', () => {
  const errors = expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 128 128"><use xlink:href="https://evil.example/a.svg#x"/></svg>',
    '外部链接',
  );
  assert.ok(errors.length > 0);
});

test('SVG data: 外链：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><use href="data:image/svg+xml;base64,AAAA"/></svg>',
    'href',
  );
});

test('SVG 非法的 url() 外链：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect fill="url(http://evil.example/a.svg#x)" width="1" height="1"/></svg>',
    'url()',
  );
});

test('SVG 自定义实体：拒绝', () => {
  const errors = expectRejected(
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="&xxe;" height="1"/></svg>',
  );
  assert.ok(errors.some((error) => error.includes('DOCTYPE') || error.includes('ENTITY') || error.includes('实体')));
});

test('SVG DOCTYPE 声明：拒绝', () => {
  expectRejected(
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="1" height="1"/></svg>',
    'DOCTYPE',
  );
});

test('SVG 未定义实体引用（非 5 个内置实体）：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="&foo;" height="1"/></svg>',
    '实体',
  );
});

// ---------------------------------------------------------------------------
// 丢弃（不报错）：注释 / CDATA / title desc / 文本
// ---------------------------------------------------------------------------

test('SVG 注释被丢弃：输出不含注释且 ok', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><!-- 恶意注释 --><rect width="1" height="1"/></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(!result.svg!.includes('<!--'));
  assert.ok(!result.svg!.includes('恶意注释'));
});

test('SVG CDATA 被丢弃：输出不含 CDATA', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><desc><![CDATA[<script>x</script>]]></desc><rect width="1" height="1"/></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(!result.svg!.includes('CDATA'));
  assert.ok(!result.svg!.includes('script'));
});

test('SVG title/desc 被剥离（契约允许但仅元数据）', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><title>标题</title><desc>描述</desc><rect width="1" height="1"/></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(!result.svg!.includes('<title>'));
  assert.ok(!result.svg!.includes('<desc>'));
});

test('SVG 非空白文本节点被丢弃（不参与重建）', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><g>hello</g></svg>',
  );
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.ok(!result.svg!.includes('hello'));
});

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

test('SVG 元素数上限 300：超限拒绝', () => {
  const rects = '<rect width="1" height="1"/>'.repeat(301);
  const errors = expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${rects}</svg>`,
    '元素数超过上限',
  );
  assert.ok(errors.length > 0);
});

test('SVG 属性总数上限 2048：超限拒绝', () => {
  const rect = '<rect x="1" y="1" width="2" height="2" fill="#fff" stroke="#000" id="a" class="b"/>';
  const errors = expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${rect.repeat(290)}</svg>`,
    '属性总数超过上限',
  );
  assert.ok(errors.length > 0);
});

test('SVG 单路径点数上限 2000：超限拒绝', () => {
  const d = `M0 0 ${'L1 1 '.repeat(2001)}`;
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="${d}"/></svg>`,
    '坐标点数',
  );
});

test('SVG 文件体积上限 64 KiB：超限拒绝', () => {
  const huge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><title>${'a'.repeat(SVG_LIMITS.maxBytes + 10)}</title></svg>`;
  expectRejected(huge, '体积');
});

test('SVG 嵌套深度上限 32：超限拒绝', () => {
  const deep = `${'<g>'.repeat(40)}${'</g>'.repeat(40)}`;
  expectRejected(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${deep}</svg>`,
    '嵌套层级',
  );
});

// ---------------------------------------------------------------------------
// XML 语法错误 / 输入格式
// ---------------------------------------------------------------------------

test('SVG 畸形 XML（标签不闭合）：拒绝', () => {
  expectRejected('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>', '不匹配');
});

test('SVG 重复属性：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" x="2" width="1" height="1"/></svg>',
    '重复属性',
  );
});

test('SVG 多个根元素：拒绝', () => {
  expectRejected(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg><svg xmlns="http://www.w3.org/2000/svg"/>',
    '根元素',
  );
});

test('SVG 根元素非 svg：拒绝', () => {
  expectRejected('<html><body>hi</body></html>', '根元素');
});

test('SVG 空输入：拒绝', () => {
  expectRejected('', '空');
});

test('SVG 未闭合注释：拒绝', () => {
  expectRejected('<svg><!-- 没闭合');
});

test('SVG 字节输入非 UTF-8：拒绝', () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x3c, 0x73]);
  const result = sanitizeSvg(bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('UTF-8')));
});

test('SVG 字节输入合法 UTF-8：通过（与字符串输入同字节）', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="60" fill="#0f0"/></svg>';
  const fromString = sanitizeSvg(source);
  const fromBytes = sanitizeSvg(new TextEncoder().encode(source));
  assert.equal(fromString.ok, true);
  assert.equal(fromString.svg, fromBytes.svg);
});

test('SVG 自定义上限可收紧：maxElements=1 时多元素拒绝', () => {
  const result = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="1" height="1"/><circle cx="1" cy="1" r="1"/></svg>',
    { maxElements: 1 },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('元素数超过上限 1')));
});
