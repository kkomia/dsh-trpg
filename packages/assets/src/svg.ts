/**
 * 极简 SVG 解析 + **重建式白名单净化**（零外部依赖）。
 *
 * 设计原则（[docs/UI-CONTRACT.md](../../../docs/UI-CONTRACT.md) §2.2/§11）：
 * - **不保留原字符串**：解析成极简 AST 后，只按白名单重建，输出不含任何原样片段；
 * - 允许元素：`svg/g/path/rect/circle/ellipse/line/polyline/polygon/defs/
 *   linearGradient/radialGradient/stop/clipPath/use`；
 * - 属性白名单 + 固定顺序 → 同一输入永远同字节（可复现、可缓存、可 diff）；
 * - 拒绝：`script/foreignObject/image/use 的外链/a/animate 系列动画/set/style/filter/...`、
 *   `on*` 事件属性、非 `#fragment` 的 `href/xlink:href`、`data:`/`javascript:`/外部 `url()`、
 *   `<!DOCTYPE`/`<!ENTITY`、自定义实体；注释、CDATA、title/desc 与文本节点直接丢弃；
 * - 根元素强制 `viewBox="0 0 128 128"`，只保留 `xmlns="http://www.w3.org/2000/svg"`；
 * - 上限：输入 ≤ 64 KiB、元素 ≤ 300、单路径点 ≤ 2000、属性总数 ≤ 2048、嵌套 ≤ 32。
 *
 * 客户端一律用 `<img src=…>` 渲染（不 inline），本函数是落盘前的唯一闸门。
 */

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const SVG_VIEWBOX = '0 0 128 128';
export const SVG_XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** 白名单净化硬边界（与 UI-CONTRACT §2.2 一致）。 */
export const SVG_LIMITS = {
  /** 输入 / 输出 SVG 字节上限 */
  maxBytes: 64 * 1024,
  /** 元素总数上限 */
  maxElements: 300,
  /** 单条路径/折线的坐标点上限 */
  maxPathPoints: 2000,
  /** 属性总数上限（防止 300 个元素 × 大量属性撑爆体积） */
  maxAttributes: 2048,
  /** 嵌套深度上限 */
  maxDepth: 32,
} as const;

export interface SvgSanitizeResult {
  ok: boolean;
  /** 净化后的规范 SVG 文本（ok=false 时缺席）。 */
  svg?: string;
  /** 中文错误原因（可多条；全部可读、可回显给作者）。 */
  errors: string[];
}

export interface SvgSanitizeOptions {
  maxBytes?: number;
  maxElements?: number;
  maxPathPoints?: number;
  maxAttributes?: number;
  maxDepth?: number;
}

/** 允许的元素（大小写敏感，SVG 规范元素名）。 */
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'use',
]);

/** 允许但整棵丢弃的元数据元素（契约允许 title/desc，但它们不参与渲染）。 */
const IGNORED_ELEMENTS = new Set(['title', 'desc']);

/** 明确危险/禁止的元素（给更精确的中文原因）。 */
const REJECTED_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'image',
  'a',
  'animate',
  'animatetransform',
  'animatemotion',
  'set',
  'style',
  'filter',
  'iframe',
  'object',
  'embed',
  'text',
  'tspan',
  'textpath',
  'symbol',
  'pattern',
  'mask',
  'marker',
  'discard',
  'handler',
  'listener',
  'audio',
  'video',
  'canvas',
  'math',
]);

/** 属性白名单（也是重建时的固定输出顺序）。 */
const ATTRIBUTE_ORDER = [
  'id',
  'class',
  'd',
  'points',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'viewBox',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'fill-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'clip-path',
  'href',
] as const;

/** 小写名 → 规范名（容忍 AI 输出 `viewbox`、`GRADIENTUNITS` 等大小写偏差）。 */
const ATTRIBUTE_CANONICAL = new Map<string, string>();
for (const name of ATTRIBUTE_ORDER) {
  ATTRIBUTE_CANONICAL.set(name.toLowerCase(), name);
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

class SvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgError';
  }
}

// ---------------------------------------------------------------------------
// 极简 XML 解析
// ---------------------------------------------------------------------------

interface XmlAttribute {
  name: string;
  value: string;
}

interface XmlElement {
  name: string;
  attributes: XmlAttribute[];
  children: XmlElement[];
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const NAME_CHAR_PATTERN = /[A-Za-z0-9_.:-]/;

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const amp = text.indexOf('&', index);
    if (amp === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, amp);
    const semi = text.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) {
      throw new SvgError('SVG 含未闭合的实体引用：请改用 &amp; 等标准写法');
    }
    const token = text.slice(amp + 1, semi);
    const decoded = XML_ENTITIES[token];
    if (decoded === undefined) {
      throw new SvgError(
        `SVG 含不支持的实体引用 &${token};（只允许 &amp; &lt; &gt; &quot; &apos;，拒绝 DOCTYPE/自定义实体）`,
      );
    }
    out += decoded;
    index = semi + 1;
  }
  return out;
}

interface StartTag {
  name: string;
  attributes: XmlAttribute[];
  selfClosing: boolean;
  endIndex: number;
}

function parseStartTag(source: string, start: number): StartTag {
  let index = start + 1;
  const nameStart = index;
  while (index < source.length && NAME_CHAR_PATTERN.test(source[index]!)) index += 1;
  const name = source.slice(nameStart, index);
  if (!NAME_PATTERN.test(name)) {
    throw new SvgError('SVG 解析失败：非法的元素名（接近位置 ' + start + '）');
  }

  const attributes: XmlAttribute[] = [];
  const seen = new Set<string>();
  for (;;) {
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    if (index >= source.length) {
      throw new SvgError(`SVG 解析失败：标签 <${name}> 未闭合`);
    }
    const char = source[index]!;
    if (char === '>') {
      return { name, attributes, selfClosing: false, endIndex: index + 1 };
    }
    if (char === '/' && source[index + 1] === '>') {
      return { name, attributes, selfClosing: true, endIndex: index + 2 };
    }

    const attributeStart = index;
    while (index < source.length && NAME_CHAR_PATTERN.test(source[index]!)) index += 1;
    const name2 = source.slice(attributeStart, index);
    if (name2.length === 0 || !NAME_PATTERN.test(name2)) {
      throw new SvgError(`SVG 解析失败：标签 <${name}> 的属性名非法`);
    }
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    if (source[index] !== '=') {
      throw new SvgError(`SVG 解析失败：属性 ${name2} 缺少 "=" 与值`);
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index]!)) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      throw new SvgError(`SVG 解析失败：属性 ${name2} 的值必须用引号包裹`);
    }
    index += 1;
    const valueStart = index;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '<') {
        throw new SvgError(`SVG 解析失败：属性 ${name2} 的值含非法字符 "<"`);
      }
      index += 1;
    }
    if (index >= source.length) {
      throw new SvgError(`SVG 解析失败：属性 ${name2} 的值未闭合`);
    }
    const rawValue = source.slice(valueStart, index);
    index += 1;
    if (seen.has(name2)) {
      throw new SvgError(`SVG 解析失败：元素 <${name}> 出现重复属性 ${name2}`);
    }
    seen.add(name2);
    attributes.push({ name: name2, value: decodeEntities(rawValue) });
  }
}

function validateText(text: string, inElement: boolean): void {
  if (text.trim().length === 0) return;
  decodeEntities(text);
  if (!inElement) {
    throw new SvgError('SVG 解析失败：根元素之外出现文本内容');
  }
  // 允许元素内的文本在重建时丢弃（SVG 图形元素不需要文本节点）
}

function parseXml(source: string): XmlElement {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const append = (element: XmlElement): void => {
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push(element);
      return;
    }
    if (root !== null) {
      throw new SvgError('SVG 解析失败：文档只能有一个根元素');
    }
    root = element;
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt === -1) {
      validateText(source.slice(index), stack.length > 0);
      break;
    }
    if (lt > index) validateText(source.slice(index, lt), stack.length > 0);
    index = lt;

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end === -1) throw new SvgError('SVG 解析失败：注释未闭合');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end === -1) throw new SvgError('SVG 解析失败：CDATA 未闭合');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2);
      if (end === -1) throw new SvgError('SVG 解析失败：处理指令未闭合');
      index = end + 2;
      continue;
    }
    if (source.startsWith('<!', index)) {
      throw new SvgError('SVG 含 <!DOCTYPE 或 <!ENTITY 声明：v1 一律拒绝（防外部实体注入）');
    }
    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index + 2);
      if (end === -1) throw new SvgError('SVG 解析失败：结束标签未闭合');
      const closeName = source.slice(index + 2, end).trim();
      const top = stack.pop();
      if (top === undefined) {
        throw new SvgError(`SVG 解析失败：多余的结束标签 </${closeName}>`);
      }
      if (top.name !== closeName) {
        throw new SvgError(`SVG 解析失败：结束标签 </${closeName}> 与 <${top.name}> 不匹配`);
      }
      index = end + 1;
      continue;
    }

    const tag = parseStartTag(source, index);
    const element: XmlElement = { name: tag.name, attributes: tag.attributes, children: [] };
    append(element);
    if (!tag.selfClosing) stack.push(element);
    index = tag.endIndex;
  }

  if (stack.length > 0) {
    throw new SvgError(`SVG 解析失败：元素 <${stack[stack.length - 1]!.name}> 未闭合`);
  }
  if (root === null) throw new SvgError('SVG 文档为空或缺少根元素');
  return root;
}

// ---------------------------------------------------------------------------
// 白名单重建
// ---------------------------------------------------------------------------

interface SanitizeContext {
  errors: string[];
  elementCount: number;
  attributeCount: number;
  maxElements: number;
  maxAttributes: number;
  maxPathPoints: number;
  maxDepth: number;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function countNumbers(value: string): number {
  const matches = value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  return matches === null ? 0 : matches.length;
}

function rejectAttribute(context: SanitizeContext, _elementName: string, reason: string): void {
  if (context.errors.length < 20) context.errors.push(reason);
}

/** 校验单个属性值不携带外部资源引用；返回 false 表示应丢弃。 */
function checkAttributeValue(
  context: SanitizeContext,
  elementName: string,
  attributeName: string,
  value: string,
): boolean {
  const lowered = value.toLowerCase();
  if (lowered.includes('javascript:') || lowered.includes('data:') || lowered.includes('vbscript:')) {
    rejectAttribute(
      context,
      elementName,
      `SVG 元素 <${elementName}> 的属性 ${attributeName} 含外链协议（data:/javascript:），已拒绝`,
    );
    return false;
  }
  if (/url\s*\(/i.test(value) && !/^url\(\s*#[A-Za-z0-9_.:-]+\s*\)$/i.test(value.trim())) {
    rejectAttribute(
      context,
      elementName,
      `SVG 元素 <${elementName}> 的属性 ${attributeName} 含外部 url()：只允许 url(#内部片段)`,
    );
    return false;
  }
  return true;
}

interface RebuiltElement {
  name: string;
  attributes: Array<[string, string]>;
  children: RebuiltElement[];
}

function rebuildElement(
  context: SanitizeContext,
  element: XmlElement,
  depth: number,
  isRoot: boolean,
): RebuiltElement | null {
  if (depth > context.maxDepth) {
    if (context.errors.length < 20) {
      context.errors.push(`SVG 嵌套层级超过上限 ${context.maxDepth}`);
    }
    return null;
  }

  const loweredName = element.name.toLowerCase();
  if (!ALLOWED_ELEMENTS.has(element.name)) {
    if (IGNORED_ELEMENTS.has(element.name)) return null;
    const message = REJECTED_ELEMENTS.has(loweredName)
      ? `SVG 含被禁止的元素 <${element.name}>（script/foreignObject/style/image 等一律拒绝）`
      : `SVG 含不允许的元素 <${element.name}>（不在白名单内）`;
    if (context.errors.length < 20) context.errors.push(message);
    return null;
  }

  context.elementCount += 1;
  if (context.elementCount > context.maxElements) {
    if (context.errors.length < 20) {
      context.errors.push(`SVG 元素数超过上限 ${context.maxElements}`);
    }
    return null;
  }

  const collected = new Map<string, string>();

  for (const attribute of element.attributes) {
    const lowered = attribute.name.toLowerCase();

    if (lowered.startsWith('on')) {
      rejectAttribute(
        context,
        element.name,
        `SVG 元素 <${element.name}> 含内联事件属性 ${attribute.name}（一律拒绝）`,
      );
      continue;
    }
    if (lowered === 'style') {
      rejectAttribute(
        context,
        element.name,
        `SVG 元素 <${element.name}> 含内联 style 属性（一律拒绝）`,
      );
      continue;
    }
    if (lowered === 'xmlns') {
      if (!isRoot) {
        rejectAttribute(context, element.name, 'SVG 只允许根元素声明 xmlns');
        continue;
      }
      if (attribute.value !== SVG_NAMESPACE) {
        rejectAttribute(
          context,
          element.name,
          `SVG 的 xmlns 必须是 ${SVG_NAMESPACE}，实际是 ${attribute.value}`,
        );
        continue;
      }
      continue; // 根元素的 xmlns 由重建器统一写入
    }
    if (lowered === 'xmlns:xlink') {
      continue; // 丢弃命名空间声明，重建时把 xlink:href 统一改写成 href
    }
    if (lowered === 'href' || lowered === 'xlink:href') {
      if (!/^#[A-Za-z0-9_.:-]+$/.test(attribute.value)) {
        rejectAttribute(
          context,
          element.name,
          `SVG 元素 <${element.name}> 的 ${attribute.name} 只允许指向文档内片段（#id），拒绝外部链接：${attribute.value.slice(0, 80)}`,
        );
        continue;
      }
      if (!checkAttributeValue(context, element.name, attribute.name, attribute.value)) continue;
      collected.set('href', attribute.value);
      continue;
    }

    const canonical = ATTRIBUTE_CANONICAL.get(lowered);
    if (canonical === undefined) continue; // 白名单外属性静默丢弃（重建式净化的核心）
    if (canonical === 'viewBox' && !isRoot) continue; // 只允许根元素 viewBox（根上强制 128）
    if (collected.has(canonical)) continue;
    if (!checkAttributeValue(context, element.name, canonical, attribute.value)) continue;
    if (canonical === 'd' || canonical === 'points') {
      const points = Math.ceil(countNumbers(attribute.value) / 2);
      if (points > context.maxPathPoints) {
        if (context.errors.length < 20) {
          context.errors.push(
            `SVG 元素 <${element.name}> 的 ${canonical} 坐标点数 ${points} 超过上限 ${context.maxPathPoints}`,
          );
        }
        continue;
      }
    }
    context.attributeCount += 1;
    if (context.attributeCount > context.maxAttributes) {
      if (context.errors.length < 20) {
        context.errors.push(`SVG 属性总数超过上限 ${context.maxAttributes}`);
      }
      break;
    }
    collected.set(canonical, attribute.value);
  }

  const rebuilt: RebuiltElement = {
    name: element.name,
    attributes: [],
    children: [],
  };

  if (isRoot) {
    rebuilt.attributes.push(['xmlns', SVG_NAMESPACE]);
    rebuilt.attributes.push(['viewBox', SVG_VIEWBOX]);
  } else {
    for (const name of ATTRIBUTE_ORDER) {
      if (name === 'viewBox') continue;
      const value = collected.get(name);
      if (value !== undefined) rebuilt.attributes.push([name, value]);
    }
  }

  for (const child of element.children) {
    const rebuiltChild = rebuildElement(context, child, depth + 1, false);
    if (rebuiltChild !== null) rebuilt.children.push(rebuiltChild);
  }

  return rebuilt;
}

function renderElement(element: RebuiltElement, depth: number): string {
  const padding = '  '.repeat(depth);
  const attributes = element.attributes
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  if (element.children.length === 0) {
    return `${padding}<${element.name}${attributes}/>`;
  }
  const inner = element.children.map((child) => renderElement(child, depth + 1)).join('\n');
  return `${padding}<${element.name}${attributes}>\n${inner}\n${padding}</${element.name}>`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function toUtf8Text(source: string | Uint8Array, maxBytes: number): string {
  if (typeof source === 'string') {
    const byteLength = utf8ByteLength(source);
    if (byteLength > maxBytes) {
      throw new SvgError(`SVG 体积 ${byteLength} 字节超过上限 ${maxBytes} 字节`);
    }
    return source;
  }
  if (!(source instanceof Uint8Array)) {
    throw new SvgError('SVG 输入必须是字符串或 Uint8Array');
  }
  if (source.length > maxBytes) {
    throw new SvgError(`SVG 体积 ${source.length} 字节超过上限 ${maxBytes} 字节`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch {
    throw new SvgError('SVG 不是合法的 UTF-8 文本');
  }
}

/**
 * 白名单净化 SVG：解析 → 重建 → 规范属性序 → 固定 viewBox。
 *
 * 同一输入（同一字符串/字节）永远得到同一输出字符串，因此 sha256 稳定。
 * 失败时返回 `{ ok:false, errors[] }`，错误为可直接展示的中文原因。
 */
export function sanitizeSvg(
  source: string | Uint8Array,
  options: SvgSanitizeOptions = {},
): SvgSanitizeResult {
  const maxBytes = options.maxBytes ?? SVG_LIMITS.maxBytes;
  const maxElements = options.maxElements ?? SVG_LIMITS.maxElements;
  const maxPathPoints = options.maxPathPoints ?? SVG_LIMITS.maxPathPoints;
  const maxAttributes = options.maxAttributes ?? SVG_LIMITS.maxAttributes;
  const maxDepth = options.maxDepth ?? SVG_LIMITS.maxDepth;

  const errors: string[] = [];
  try {
    const text = toUtf8Text(source, maxBytes);
    const root = parseXml(text);
    if (root.name !== 'svg') {
      errors.push(`SVG 根元素必须是 <svg>，实际是 <${root.name}>`);
      return { ok: false, errors };
    }
    const context: SanitizeContext = {
      errors,
      elementCount: 0,
      attributeCount: 0,
      maxElements,
      maxAttributes,
      maxPathPoints,
      maxDepth,
    };
    const rebuilt = rebuildElement(context, root, 0, true);
    if (errors.length > 0 || rebuilt === null) {
      return { ok: false, errors };
    }
    const svg = `${SVG_XML_DECLARATION}\n${renderElement(rebuilt, 0)}\n`;
    const outputBytes = utf8ByteLength(svg);
    if (outputBytes > maxBytes) {
      errors.push(`净化后 SVG 体积 ${outputBytes} 字节超过上限 ${maxBytes} 字节`);
      return { ok: false, errors };
    }
    return { ok: true, svg, errors: [] };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { ok: false, errors };
  }
}
