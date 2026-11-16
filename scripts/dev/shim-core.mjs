/**
 * M9.5c 开发用 ComfyUI → OpenAI 协议 shim 的**纯映射逻辑**（无网络、无服务端状态）。
 *
 * 目的：本机 ComfyUI 出图 → 工坊「AI 生图」按 OpenAI 兼容协议跑通（归一化/预览/落盘链路不变）。
 * 协议约定见 `packages/assets/src/openai-shim/README.md`；本文件只做可单测的翻译层：
 *
 * - 请求校验与映射：`buildImagePlan`（model/prompt/size/n/seed/response_format/扩展参数）；
 * - 提示词拆分：`splitPrompt` / `resolvePrompt`（`Avoid：` 段 ↔ 独立 negative_prompt）；
 * - 工作流填充：`fillWorkflowTemplate`（占位符 + 按节点 class_type 的可选覆盖）；
 * - 响应拼装：`extractHistoryImages` / `buildImagesResponse` / `buildChatCompletion`；
 * - `--fake` 模式素材：`fakePng`（确定性最小 PNG）/ `fakeSvg`（合法 128×128 SVG）。
 *
 * 零 npm 依赖；只允许 `node:` 内置模块。**不进插件产物、不被生产代码 import。**
 */
import { deflateSync } from 'node:zlib';

/** OpenAI `size` → ComfyUI 空 latent 尺寸（契约 §2.1：三档都对 64 对齐，不许偷偷取整）。 */
export const SUPPORTED_SIZES = Object.freeze({
  '1024x1024': Object.freeze({ width: 1024, height: 1024, target: 'pixel-32（32× 整数倍）' }),
  '512x512': Object.freeze({ width: 512, height: 512, target: 'icon-128（4× 整数倍）' }),
  '768x1024': Object.freeze({ width: 768, height: 1024, target: 'portrait / variant' }),
});

/** 默认模型名（OpenAI 客户端请求里带的 `model`；shim 只用它选工作流）。 */
export const DEFAULT_IMAGE_MODEL = 'sd-xl';

/** 默认 ComfyUI 基础地址（只允许本机）。 */
export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

/** shim 默认监听（只绑 loopback；README §4：绝不能监听 0.0.0.0）。 */
export const DEFAULT_SHIM_HOST = '127.0.0.1';
export const DEFAULT_SHIM_PORT = 8099;

/** 客户端生图超时 120s（契约 §2.3）；shim 轮询上限必须更短（README §5）。 */
export const DEFAULT_CLIENT_TIMEOUT_MS = 120_000;
export const DEFAULT_POLL_TIMEOUT_MS = 100_000;
export const DEFAULT_POLL_INTERVAL_MS = 750;

export const MAX_CANDIDATES = 4;
export const MAX_SEED = 2 ** 31 - 1;

/** 可读的 4xx/5xx 错误（服务端把它映射成 `{error:{message,type,code}}`）。 */
export class ShimError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} code 机器可读错误码（如 unsupported_size）
   * @param {string} message 中文可读原因
   * @param {string} [type] OpenAI 错误 type
   */
  constructor(status, code, message, type = 'invalid_request_error') {
    super(message);
    this.name = 'ShimError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// 请求映射
// ---------------------------------------------------------------------------

/** 解析并校验 OpenAI `size`；不支持的档位直接 400（不偷偷取整，像素风才不会被非整数倍缩放）。 */
export function parseSize(size) {
  if (size === undefined || size === null) return { ...SUPPORTED_SIZES['1024x1024'] };
  if (typeof size !== 'string' || !isNonEmptyString(size)) {
    throw new ShimError(400, 'unsupported_size', `不支持的 size：${JSON.stringify(size)}（支持 ${Object.keys(SUPPORTED_SIZES).join(' / ')}）`);
  }
  const key = size.trim().toLowerCase();
  const mapped = SUPPORTED_SIZES[key];
  if (mapped === undefined) {
    throw new ShimError(
      400,
      'unsupported_size',
      `不支持的 size：${size}（支持 ${Object.keys(SUPPORTED_SIZES).join(' / ')}；不做取整，避免像素风出现非整数倍缩放）`,
    );
  }
  return { ...mapped };
}

/** 从提示词里拆出 `Avoid：…` 负向段（契约 §2.2：客户端默认把负向追加进 prompt）。 */
export function splitPrompt(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const match = /(?:^|\r?\n)\s*Avoid\s*[:：]\s*([\s\S]*)$/iu.exec(text);
  if (match === null) return { positive: text.trim(), negative: '' };
  const negative = (match[1] ?? '').trim();
  const positive = text.slice(0, match.index).trim();
  return { positive, negative };
}

/**
 * 解析提示词：独立 `negative_prompt` 优先；没有时从 prompt 的 `Avoid：` 段提取。
 * 返回 { positive, negative }（两者都 trim，可能为空串）。
 */
export function resolvePrompt(body) {
  const explicit = typeof body?.negative_prompt === 'string' ? body.negative_prompt.trim() : '';
  const split = splitPrompt(body?.prompt);
  return {
    positive: split.positive,
    negative: explicit.length > 0 ? explicit : split.negative,
  };
}

/** 归一化 seed：缺省随机；非法值 400（不静默改成随机，避免不可复现）。 */
export function normalizeSeed(seed, random = Math.random) {
  if (seed === undefined || seed === null) {
    return Math.floor(random() * (MAX_SEED + 1)) % (MAX_SEED + 1);
  }
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new ShimError(400, 'invalid_seed', `seed 必须是 0..${MAX_SEED} 的整数，实际为 ${JSON.stringify(seed)}`);
  }
  return seed;
}

/** 可选的数值扩展参数（steps / cfg_scale）：给了就校验范围，缺省不覆盖工作流默认值。 */
function optionalNumber(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ShimError(400, 'invalid_parameter', `${name} 必须是数字，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 校验 OpenAI 生图请求并翻译成「生成计划」：
 * `{ model, positive, negative, width, height, count, seeds, steps?, cfgScale?, sampler?, checkpoint? }`。
 * 不合法抛 `ShimError`（400）。
 */
export function buildImagePlan(body, options = {}) {
  if (!isRecord(body)) throw new ShimError(400, 'invalid_request', '请求体必须是 JSON 对象');
  if (!isNonEmptyString(body.prompt)) throw new ShimError(400, 'empty_prompt', 'prompt 不能为空（工坊会把正向模板 + Avoid 段拼进来）');
  if (body.response_format !== undefined && body.response_format !== 'b64_json') {
    throw new ShimError(400, 'unsupported_response_format', `只支持 response_format="b64_json"，实际为 ${JSON.stringify(body.response_format)}`);
  }
  const model = isNonEmptyString(body.model) ? body.model.trim() : (options.defaultModel ?? DEFAULT_IMAGE_MODEL);
  if (Array.isArray(options.knownModels) && options.knownModels.length > 0 && !options.knownModels.includes(model)) {
    throw new ShimError(400, 'unknown_model', `未知 model：${model}（已配置 ${options.knownModels.join(' / ')}）`);
  }

  const size = parseSize(body.size);
  const countRaw = body.n === undefined || body.n === null ? 1 : body.n;
  if (typeof countRaw !== 'number' || !Number.isInteger(countRaw) || countRaw < 1 || countRaw > MAX_CANDIDATES) {
    throw new ShimError(400, 'invalid_n', `n 必须是 1..${MAX_CANDIDATES} 的整数，实际为 ${JSON.stringify(body.n)}`);
  }
  const prompt = resolvePrompt(body);
  const baseSeed = normalizeSeed(body.seed, options.random ?? Math.random);
  const seeds = Array.from({ length: countRaw }, (_, index) => (baseSeed + index) % (MAX_SEED + 1));
  const steps = optionalNumber(body.steps, 'steps');
  const cfgScale = optionalNumber(body.cfg_scale, 'cfg_scale');
  const sampler = isNonEmptyString(body.sampler) ? body.sampler.trim() : undefined;
  const checkpoint = isNonEmptyString(options.checkpoint) ? options.checkpoint : undefined;
  return {
    model,
    positive: prompt.positive,
    negative: prompt.negative,
    width: size.width,
    height: size.height,
    count: countRaw,
    seeds,
    ...(steps !== undefined ? { steps } : {}),
    ...(cfgScale !== undefined ? { cfgScale } : {}),
    ...(sampler !== undefined ? { sampler } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
  };
}

// ---------------------------------------------------------------------------
// 工作流填充
// ---------------------------------------------------------------------------

const PLACEHOLDERS = Object.freeze({
  '{{prompt}}': 'positive',
  '{{positive_prompt}}': 'positive',
  '{{negative_prompt}}': 'negative',
  '{{seed}}': 'seed',
  '{{width}}': 'width',
  '{{height}}': 'height',
  '{{n}}': 'count',
  '{{steps}}': 'steps',
  '{{cfg_scale}}': 'cfgScale',
  '{{sampler}}': 'sampler',
  '{{model}}': 'model',
  '{{checkpoint}}': 'checkpoint',
});

function planValue(plan, key, seed) {
  switch (key) {
    case 'positive':
      return plan.positive;
    case 'negative':
      return plan.negative;
    case 'seed':
      return seed;
    case 'width':
      return plan.width;
    case 'height':
      return plan.height;
    case 'count':
      return plan.count;
    case 'steps':
      return plan.steps;
    case 'cfgScale':
      return plan.cfgScale;
    case 'sampler':
      return plan.sampler;
    case 'model':
      return plan.model;
    case 'checkpoint':
      return plan.checkpoint;
    default:
      return undefined;
  }
}

function replacePlaceholdersInString(text, plan, seed) {
  const trimmed = text.trim();
  const exactKey = Object.keys(PLACEHOLDERS).find((token) => token === trimmed);
  if (exactKey !== undefined) {
    const value = planValue(plan, PLACEHOLDERS[exactKey], seed);
    if (value === undefined || value === null) return text; // 可选参数缺省 → 保留原样（不写 undefined）
    return value;
  }
  let output = text;
  for (const [token, key] of Object.entries(PLACEHOLDERS)) {
    if (!output.includes(token)) continue;
    const value = planValue(plan, key, seed);
    if (value === undefined || value === null) continue;
    output = output.replaceAll(token, String(value));
  }
  return output;
}

function fillPlaceholders(node, plan, seed) {
  if (Array.isArray(node)) return node.map((item) => fillPlaceholders(item, plan, seed));
  if (isRecord(node)) {
    /** @type {Record<string, unknown>} */
    const output = {};
    for (const [key, value] of Object.entries(node)) output[key] = fillPlaceholders(value, plan, seed);
    return output;
  }
  if (typeof node === 'string') return replacePlaceholdersInString(node, plan, seed);
  return node;
}

/**
 * 把 API 格式工作流模板填成可提交给 ComfyUI `/prompt` 的 JSON（深拷贝，不改模板）：
 *
 * 1. **占位符**（推荐自定义模板用）：任意字符串里出现 `{{prompt}}` / `{{negative_prompt}}` /
 *    `{{seed}}` / `{{width}}` / `{{height}}` / `{{n}}` / `{{steps}}` / `{{cfg_scale}}` /
 *    `{{sampler}}` / `{{model}}` / `{{checkpoint}}` 会被替换（整串占位保留数字类型）；
 * 2. **按节点 class_type 覆盖**（内置默认模板走这条）：模板里没有用占位符时，
 *    - `CLIPTextEncode`：第一个节点收正向、第二个收负向；
 *    - `EmptyLatentImage`（或 `EmptySD3LatentImage`）：width/height/batch_size；
 *    - `KSampler`：seed/steps/cfg/sampler_name；
 *    - `CheckpointLoaderSimple`：ckpt_name（只有计划里给了 checkpoint 才覆盖）。
 *
 * @param {Record<string, any>} template ComfyUI API 格式工作流（node id → {class_type, inputs}）
 * @param {ReturnType<typeof buildImagePlan>} plan
 * @param {number} [seed] 本轮种子（多候选时逐张调用；缺省用 plan.seeds[0]）
 * @returns {Record<string, any>} 新的工作流对象
 */
export function fillWorkflowTemplate(template, plan, seed = plan.seeds[0] ?? 0) {
  if (!isRecord(template)) throw new ShimError(500, 'invalid_workflow', '工作流模板必须是 ComfyUI API 格式的 JSON 对象');
  const workflow = fillPlaceholders(template, plan, seed);
  if (!isRecord(workflow)) throw new ShimError(500, 'invalid_workflow', '工作流模板必须是 ComfyUI API 格式的 JSON 对象');

  /** @type {Array<[string, Record<string, any>]>} */
  const entries = Object.entries(workflow).filter(([, node]) => isRecord(node));
  let textEncoderIndex = 0;
  for (const [, node] of entries) {
    const inputs = isRecord(node.inputs) ? node.inputs : undefined;
    if (inputs === undefined) continue;
    switch (node.class_type) {
      case 'CLIPTextEncode': {
        const nextText = textEncoderIndex === 0 ? plan.positive : textEncoderIndex === 1 ? plan.negative : undefined;
        textEncoderIndex += 1;
        if (nextText !== undefined && typeof inputs.text === 'string' && !inputs.text.includes('{{')) {
          inputs.text = nextText;
        }
        break;
      }
      case 'EmptyLatentImage':
      case 'EmptySD3LatentImage': {
        inputs.width = plan.width;
        inputs.height = plan.height;
        // 多候选由 shim 逐张提交（README §2），单次提交只出 1 张，避免 n×n 张重复生成
        inputs.batch_size = 1;
        break;
      }
      case 'KSampler': {
        inputs.seed = seed;
        if (plan.steps !== undefined) inputs.steps = plan.steps;
        if (plan.cfgScale !== undefined) inputs.cfg = plan.cfgScale;
        if (plan.sampler !== undefined) inputs.sampler_name = plan.sampler;
        break;
      }
      case 'CheckpointLoaderSimple': {
        if (isNonEmptyString(plan.checkpoint)) inputs.ckpt_name = plan.checkpoint;
        break;
      }
      default:
        break;
    }
  }
  return workflow;
}

// ---------------------------------------------------------------------------
// 响应拼装
// ---------------------------------------------------------------------------

/** 从 `GET /history/<id>` 的响应里取第一张输出图 `{filename, subfolder, type}`；没有返回 undefined。 */
export function extractFirstImage(historyEntry) {
  if (!isRecord(historyEntry)) return undefined;
  const status = isRecord(historyEntry.status) ? historyEntry.status : undefined;
  if (status !== undefined && status.status_str === 'error') {
    throw new ShimError(500, 'comfyui_execution_failed', 'ComfyUI 工作流执行失败（status=error）', 'upstream_error');
  }
  const outputs = isRecord(historyEntry.outputs) ? historyEntry.outputs : undefined;
  if (outputs === undefined) return undefined;
  for (const output of Object.values(outputs)) {
    if (!isRecord(output) || !Array.isArray(output.images) || output.images.length === 0) continue;
    const image = output.images[0];
    if (!isRecord(image) || typeof image.filename !== 'string' || image.filename.length === 0) continue;
    return {
      filename: image.filename,
      subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
      type: typeof image.type === 'string' ? image.type : 'output',
    };
  }
  return undefined;
}

/** 把若干张图（字节 + seed）拼成 OpenAI 生图响应（只给 b64_json，绝不回 url 替代，防 SSRF）。 */
export function buildImagesResponse(images, options = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new ShimError(500, 'no_image', 'ComfyUI 没有返回任何图片（工作流缺少 SaveImage/PreviewImage 输出？）', 'upstream_error');
  }
  return {
    created: options.created ?? Math.floor(Date.now() / 1000),
    ...(isNonEmptyString(options.model) ? { model: options.model } : {}),
    data: images.map((image) => ({
      b64_json: Buffer.from(image.bytes).toString('base64'),
      ...(typeof image.seed === 'number' ? { seed: image.seed } : {}),
    })),
  };
}

/** `--fake-svg` 的 chat completions 响应（与 assets 的 openai.ts 读取形状一致）。 */
export function buildChatCompletion(options = {}) {
  const content = options.svg ?? '';
  if (!isNonEmptyString(content)) throw new ShimError(500, 'empty_svg', 'fake SVG 内容为空');
  return {
    id: `chatcmpl-shim-${options.seed ?? 0}`,
    object: 'chat.completion',
    created: options.created ?? Math.floor(Date.now() / 1000),
    model: options.model ?? 'shim-fake-svg',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// --fake 模式：确定性 PNG / 合法 SVG（不依赖 @dsh-trpg/assets，保持纯脚本）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[index]) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 确定性 PRNG（mulberry32）：同一 seed 永远同一批像素。 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `--fake` 模式：按 seed 生成确定性的 RGBA PNG（最小 chunk 集：IHDR + IDAT + IEND）。
 * 用来在不启动 ComfyUI 的情况下联调「工坊生图 → 归一化 → 预览落盘」整条链路。
 * @param {{width?: number, height?: number, seed?: number}} [options]
 * @returns {Uint8Array}
 */
export function fakePng(options = {}) {
  const width = Math.trunc(options.width ?? 512);
  const height = Math.trunc(options.height ?? 512);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ShimError(400, 'invalid_size', `生成尺寸非法：${width}×${height}`);
  }
  const seed = options.seed ?? 0;
  const random = mulberry32(seed);
  const base = [Math.floor(random() * 200) + 40, Math.floor(random() * 200) + 40, Math.floor(random() * 200) + 40];
  const accent = [Math.floor(random() * 255), Math.floor(random() * 255), Math.floor(random() * 255)];
  const radius = Math.min(width, height) / 3;
  const centerX = width / 2;
  const centerY = height / 2;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let pointer = 0;
  for (let y = 0; y < height; y += 1) {
    raw[pointer] = 0; // 每行 filter=None（同输入同字节，便于复现）
    pointer += 1;
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const inCircle = dx * dx + dy * dy <= radius * radius;
      const stripe = (x + y + (seed % 97)) % 37 < 5;
      const color = inCircle ? accent : stripe ? [220, 220, 235] : base;
      raw[pointer] = color[0] ?? 0;
      raw[pointer + 1] = color[1] ?? 0;
      raw[pointer + 2] = color[2] ?? 0;
      raw[pointer + 3] = 255;
      pointer += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', deflateSync(raw, { level: 6 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** `--fake-svg` 模式：按 seed/prompt 生成确定性、白名单安全的 128×128 SVG 图标。 */
export function fakeSvg(options = {}) {
  const seed = options.seed ?? 0;
  const random = mulberry32(seed);
  const hue = Math.floor(random() * 360);
  const second = (hue + 40 + Math.floor(random() * 80)) % 360;
  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  const radius = 34 + Math.floor(random() * 10);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">',
    '<title>shim fake svg</title>',
    `<desc>seed ${seed} prompt ${prompt.slice(0, 60).replaceAll('<', ' ').replaceAll('>', ' ').replaceAll('&', ' ')}</desc>`,
    `<circle cx="64" cy="64" r="60" fill="hsl(${hue} 55% 38%)"/>`,
    `<circle cx="64" cy="64" r="${radius}" fill="hsl(${second} 70% 58%)"/>`,
    `<path d="M64 ${64 - radius} L${64 + radius} 64 L64 ${64 + radius} L${64 - radius} 64 Z" fill="hsl(${(hue + 180) % 360} 80% 70%)" opacity="0.85"/>`,
    '</svg>',
  ].join('');
}
