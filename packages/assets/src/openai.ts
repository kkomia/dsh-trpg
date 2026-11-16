/**
 * OpenAI 兼容客户端（文本出 SVG + 生图）+ 提示词模板。
 *
 * 只针对 **OpenAI 兼容协议**（[docs/UI-CONTRACT.md](../../../docs/UI-CONTRACT.md) §2.2/§2.3）：
 * - 文本：`POST {baseUrl}/v1/chat/completions` → `choices[0].message.content` → 剥 Markdown 围栏；
 * - 生图：`POST {baseUrl}/v1/images/generations`，`response_format: 'b64_json'` → `data[*].b64_json` →
 *   bytes；**只接受 b64_json**，后端只回 url 时明确报错（不代抓外链，避免 SSRF）；
 * - `baseUrl` 归一化：末尾 `/v1` 与 `/` 自动剥离，端点统一拼 `/v1/...`；
 * - 超时默认 120s（AbortController）；**仅网络错误 / 5xx 重试 1 次**，4xx 不重试；
 * - 错误映射为中文可读 `OpenAIClientError`（`code` 供程序分支，`message` 给作者看）；
 * - `fetchImpl` 可注入：生产用宿主 fetch，单测全 mock，**本库自身不发起任何隐式网络请求**。
 */

// ---------------------------------------------------------------------------
// 可注入的 fetch 最小接口（不依赖 DOM lib，也不绑死 undici 类型）
// ---------------------------------------------------------------------------

export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

export type OpenAIErrorCode =
  | 'config'
  | 'no-fetch'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'rate-limit'
  | 'not-found'
  | 'server'
  | 'http'
  | 'invalid-response'
  | 'unsupported';

/** OpenAI 兼容接口错误（`message` 中文可读，`code` 供上层分支/重试策略）。 */
export class OpenAIClientError extends Error {
  code: OpenAIErrorCode;
  status?: number;
  retryable: boolean;

  constructor(code: OpenAIErrorCode, message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'OpenAIClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}

export interface OpenAICompatConfig {
  /** 兼容接口地址，如 `https://api.openai.com` 或 `https://api.openai.com/v1`（末尾 /v1 自动剥离）。 */
  baseUrl: string;
  apiKey?: string;
  /** 文本模型（出 SVG），如 `gpt-4o-mini`。 */
  textModel?: string;
  /** 生图模型，如 `sd-xl` / `dall-e-3`。 */
  imageModel?: string;
  /** 注入 fetch；不注入时用全局 fetch（Node 18+ / 浏览器自带）。 */
  fetchImpl?: FetchLike;
  /** 单次请求超时（毫秒），默认 120000。 */
  timeoutMs?: number;
  /** 失败重试次数（仅网络错误 / 5xx），默认 1。 */
  retries?: number;
  /** 追加请求头（如自定义鉴权头）。 */
  headers?: Record<string, string>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTextOptions {
  /** 用户提示词（与 messages 二选一或叠加）。 */
  prompt?: string;
  /** 系统提示（模板可直接放这里）。 */
  system?: string;
  messages?: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatTextResult {
  /** 已剥 Markdown 围栏与前后废话的正文（SVG 源码或文本）。 */
  content: string;
  model?: string;
  usage?: unknown;
  raw: unknown;
}

export interface GenerateImageOptions {
  prompt: string;
  /** 请求尺寸，默认 `1024x1024`（像素风 1024 / 图标 512 / 立绘 768x1024，见契约 §2.3）。 */
  size?: string;
  /** 候选数量，默认 1（多候选只用于预览，n>1）。 */
  n?: number;
  model?: string;
  /** 种子（后端支持时透传，回读写 manifest 便于复现）。 */
  seed?: number | null;
  /** 负向提示词：默认以 `Avoid：` 段追加进 prompt；后端支持独立 negative_prompt 时用 extra 透传。 */
  negativePrompt?: string;
  /**
   * 后端扩展字段透传（`negative_prompt/steps/cfg_scale/sampler` 等）。
   * 若 extra 里给了 `negative_prompt`，则负向提示词走独立字段、不再拼进 prompt。
   */
  extra?: Record<string, unknown>;
}

export interface GeneratedImage {
  /** 解码后的图片字节（通常是 PNG，交给归一化器再验）。 */
  bytes: Uint8Array;
  /** 原始 b64（调试/复现用）。 */
  b64: string;
  seed: number | null;
}

export interface GenerateImageResult {
  images: GeneratedImage[];
  model?: string;
  raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snippet(text: string, limit = 300): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`;
}

/** `baseUrl` 归一化：去掉末尾 `/`、去掉末尾 `/v1`（调用方常在配置里带 /v1）。 */
export function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new OpenAIClientError('config', 'OpenAI 兼容接口缺少 baseUrl（baseUrl 不能为空）');
  }
  let normalized = baseUrl.trim();
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.replace(/\/v1$/i, '');
  normalized = normalized.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) {
    throw new OpenAIClientError(
      'config',
      `baseUrl 必须以 http:// 或 https:// 开头，实际为「${baseUrl}」`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Markdown 围栏 / 前后废话剥离
// ---------------------------------------------------------------------------

/** 剥掉 Markdown 代码围栏；若正文里包着 `<svg>…</svg>`，只保留 SVG 文档本体。 */
export function stripMarkdownFences(text: string): string {
  if (typeof text !== 'string') return '';
  let value = text.trim();
  const fenced = value.match(/```[^\n]*\n([\s\S]*?)\n?```/);
  if (fenced !== null) {
    value = fenced[1]!.trim();
  } else if (value.startsWith('```')) {
    value = value.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const svgStart = value.search(/<\s*svg\b/i);
  if (svgStart >= 0) {
    const lower = value.toLowerCase();
    const svgEnd = lower.lastIndexOf('</svg>');
    if (svgEnd > svgStart) {
      return value.slice(svgStart, svgEnd + '</svg>'.length).trim();
    }
    return value.slice(svgStart).trim();
  }
  return value;
}

function decodeBase64Payload(b64: string, index: number): Uint8Array {
  const compact = b64.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new OpenAIClientError(
      'invalid-response',
      `生图接口返回的 data[${index}].b64_json 不是合法 Base64`,
    );
  }
  const padded = compact.length % 4 === 0 ? compact : compact + '='.repeat(4 - (compact.length % 4));
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length === 0) {
    throw new OpenAIClientError(
      'invalid-response',
      `生图接口返回的 data[${index}].b64_json 解码后为空`,
    );
  }
  return new Uint8Array(bytes);
}

function resolveSeed(item: unknown, raw: unknown, requested: number | null | undefined): number | null {
  if (isRecord(item) && typeof item.seed === 'number' && Number.isFinite(item.seed)) {
    return Math.trunc(item.seed);
  }
  if (isRecord(raw) && typeof raw.seed === 'number' && Number.isFinite(raw.seed)) {
    return Math.trunc(raw.seed);
  }
  if (typeof requested === 'number' && Number.isInteger(requested) && requested >= 0) return requested;
  return null;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class OpenAICompatClient {
  readonly baseUrl: string;
  readonly chatEndpoint: string;
  readonly imagesEndpoint: string;
  private readonly apiKey: string | undefined;
  private readonly textModel: string | undefined;
  private readonly imageModel: string | undefined;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(config: OpenAICompatConfig) {
    if (config === null || typeof config !== 'object') {
      throw new OpenAIClientError('config', 'OpenAI 兼容客户端配置必须是对象');
    }
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.chatEndpoint = `${this.baseUrl}/v1/chat/completions`;
    this.imagesEndpoint = `${this.baseUrl}/v1/images/generations`;
    this.apiKey = config.apiKey;
    this.textModel = config.textModel;
    this.imageModel = config.imageModel;
    const defaultFetch =
      typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as FetchLike) : undefined;
    this.fetchImpl = config.fetchImpl ?? defaultFetch;
    const timeoutMs = config.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new OpenAIClientError('config', `timeoutMs 必须是正整数，收到 ${String(config.timeoutMs)}`);
    }
    this.timeoutMs = timeoutMs;
    const retries = config.retries ?? 1;
    if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
      throw new OpenAIClientError('config', `retries 必须是 0–5 的整数，收到 ${String(config.retries)}`);
    }
    this.retries = retries;
    this.extraHeaders = { ...(config.headers ?? {}) };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private httpError(status: number, bodyText: string, url: string): OpenAIClientError {
    const detail = bodyText.trim().length > 0 ? `；响应：${snippet(bodyText)}` : '';
    if (status === 401 || status === 403) {
      return new OpenAIClientError(
        'auth',
        `接口鉴权失败（HTTP ${status}）：请检查 API Key 是否正确、是否有该模型权限${detail}`,
        status,
        false,
      );
    }
    if (status === 404) {
      return new OpenAIClientError(
        'not-found',
        `接口不存在（HTTP 404）：请检查 baseUrl 是否正确（应形如 https://api.example.com，无需写 /v1）；实际请求 ${url}${detail}`,
        status,
        false,
      );
    }
    if (status === 429) {
      return new OpenAIClientError(
        'rate-limit',
        `请求过于频繁或额度不足（HTTP 429）：请稍后重试或检查配额${detail}`,
        status,
        false,
      );
    }
    if (status >= 500) {
      return new OpenAIClientError(
        'server',
        `模型服务端错误（HTTP ${status}）：已重试仍失败，请稍后再试${detail}`,
        status,
        true,
      );
    }
    return new OpenAIClientError(
      'http',
      `接口请求失败（HTTP ${status}）：${snippet(bodyText) || '无响应内容'}`,
      status,
      false,
    );
  }

  private async postJson(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const fetchImpl = this.fetchImpl;
    if (fetchImpl === undefined) {
      throw new OpenAIClientError(
        'no-fetch',
        '当前运行环境没有可用的 fetch：请注入 fetchImpl（宿主 fetch）后再调用 OpenAI 兼容接口',
      );
    }
    const url = `${this.baseUrl}/v1${path}`;
    const body = JSON.stringify(payload);
    const maxAttempts = this.retries + 1;
    let lastNetworkMessage = '';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response: FetchResponseLike;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: this.headers(),
            body,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new OpenAIClientError(
              'timeout',
              `请求超时（${Math.round(this.timeoutMs / 1000)} 秒）：POST ${url}`,
            );
          }
          lastNetworkMessage = `网络错误：无法请求模型接口（POST ${url}）：${errorMessage(error)}`;
          if (attempt + 1 < maxAttempts) continue;
          throw new OpenAIClientError('network', lastNetworkMessage, undefined, true);
        }

        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          if (controller.signal.aborted) {
            throw new OpenAIClientError(
              'timeout',
              `请求超时（${Math.round(this.timeoutMs / 1000)} 秒）：POST ${url}`,
            );
          }
          lastNetworkMessage = `网络错误：读取模型接口响应失败：${errorMessage(error)}`;
          if (attempt + 1 < maxAttempts) continue;
          throw new OpenAIClientError('network', lastNetworkMessage, undefined, true);
        }

        if (!response.ok) {
          if (response.status >= 500 && attempt + 1 < maxAttempts) continue;
          throw this.httpError(response.status, text, url);
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new OpenAIClientError(
            'invalid-response',
            `模型接口返回的不是合法 JSON（HTTP ${response.status}）：${snippet(text) || '空响应'}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw new OpenAIClientError('network', lastNetworkMessage || '网络请求失败（未知原因）');
  }

  /** 文本生成（用于 AI 出 SVG）：返回剥完围栏的 content 字符串。 */
  async chatText(options: ChatTextOptions): Promise<ChatTextResult> {
    const model = options.model ?? this.textModel;
    if (model === undefined || model.length === 0) {
      throw new OpenAIClientError(
        'config',
        '未配置文本模型（textModel）：请在客户端配置里填写 textModel，或在调用时传 model',
      );
    }
    const messages: ChatMessage[] = [];
    if (options.system !== undefined && options.system.length > 0) {
      messages.push({ role: 'system', content: options.system });
    }
    if (options.messages !== undefined) messages.push(...options.messages);
    if (options.prompt !== undefined && options.prompt.length > 0) {
      messages.push({ role: 'user', content: options.prompt });
    }
    if (messages.length === 0) {
      throw new OpenAIClientError('config', 'chatText 需要 prompt / messages / system 至少一个');
    }

    const payload: Record<string, unknown> = { model, messages };
    if (options.temperature !== undefined) payload.temperature = options.temperature;
    if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;

    const raw = await this.postJson('/chat/completions', payload);
    if (!isRecord(raw)) {
      throw new OpenAIClientError('invalid-response', '模型接口返回的不是 JSON 对象');
    }
    const choices = raw.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new OpenAIClientError('invalid-response', '模型接口返回缺少 choices[0]');
    }
    const first = choices[0];
    if (!isRecord(first)) {
      throw new OpenAIClientError('invalid-response', '模型接口返回的 choices[0] 不是对象');
    }
    const message = first.message;
    if (!isRecord(message)) {
      throw new OpenAIClientError('invalid-response', '模型接口返回缺少 choices[0].message');
    }
    const content = message.content;
    if (typeof content !== 'string') {
      throw new OpenAIClientError(
        'invalid-response',
        '模型接口返回的 choices[0].message.content 不是字符串（多模态分段无法作为 SVG 文本使用）',
      );
    }
    const stripped = stripMarkdownFences(content);
    if (stripped.length === 0) {
      throw new OpenAIClientError('invalid-response', '模型接口返回的正文为空');
    }
    return {
      content: stripped,
      ...(typeof raw.model === 'string' ? { model: raw.model } : { model }),
      usage: raw.usage,
      raw,
    };
  }

  /** AI 生图：只接受 `data[*].b64_json` → 字节；后端只回 url 时明确报错（不代抓外链）。 */
  async generateImage(options: GenerateImageOptions): Promise<GenerateImageResult> {
    if (options === null || typeof options !== 'object' || typeof options.prompt !== 'string' || options.prompt.trim().length === 0) {
      throw new OpenAIClientError('config', 'generateImage 需要非空 prompt');
    }
    const model = options.model ?? this.imageModel;
    if (model === undefined || model.length === 0) {
      throw new OpenAIClientError(
        'config',
        '未配置生图模型（imageModel）：请在客户端配置里填写 imageModel，或在调用时传 model',
      );
    }
    const extra = options.extra ?? {};
    const hasSeparateNegative =
      typeof extra.negative_prompt === 'string' && extra.negative_prompt.length > 0;
    const prompt = hasSeparateNegative
      ? options.prompt.trim()
      : appendNegativePrompt(options.prompt, options.negativePrompt);

    const payload: Record<string, unknown> = {
      ...extra,
      model,
      prompt,
      size: options.size ?? '1024x1024',
      n: options.n ?? 1,
      response_format: 'b64_json',
    };
    if (typeof options.seed === 'number' && options.seed !== null) {
      if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2 ** 31 - 1) {
        throw new OpenAIClientError('config', `seed 必须是 0..2147483647 的整数，收到 ${String(options.seed)}`);
      }
      payload.seed = options.seed;
    }

    const raw = await this.postJson('/images/generations', payload);
    if (!isRecord(raw)) {
      throw new OpenAIClientError('invalid-response', '生图接口返回的不是 JSON 对象');
    }
    const data = raw.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new OpenAIClientError('invalid-response', '生图接口返回缺少 data 数组');
    }

    const images: GeneratedImage[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const item = data[index];
      if (!isRecord(item)) {
        throw new OpenAIClientError('invalid-response', `生图接口返回的 data[${index}] 不是对象`);
      }
      const b64 = item.b64_json;
      if (typeof b64 !== 'string' || b64.trim().length === 0) {
        if (typeof item.url === 'string' && item.url.length > 0) {
          throw new OpenAIClientError(
            'unsupported',
            '生图接口只返回了图片 URL（response_format=b64_json 未生效）：为防 SSRF 不代抓外链，请让后端返回 b64_json',
          );
        }
        throw new OpenAIClientError(
          'invalid-response',
          `生图接口返回缺少 data[${index}].b64_json`,
        );
      }
      images.push({
        bytes: decodeBase64Payload(b64, index),
        b64,
        seed: resolveSeed(item, raw, options.seed),
      });
    }

    return {
      images,
      ...(typeof raw.model === 'string' ? { model: raw.model } : { model }),
      raw,
    };
  }
}

/** 创建 OpenAI 兼容客户端的便捷入口。 */
export function createOpenAICompatClient(config: OpenAICompatConfig): OpenAICompatClient {
  return new OpenAICompatClient(config);
}

// ---------------------------------------------------------------------------
// 提示词模板（§2.2 AI SVG / §2.3 AI 生图；全部支持四个变量）
// ---------------------------------------------------------------------------

/** 默认负向约束（`Avoid:` 段，§2.2）。 */
export const NEGATIVE_PROMPT =
  '文字、水印、边框、照片、3D 渲染、渐变背景、多个主体、模糊';

export interface PromptVariables {
  name?: string;
  tags?: string | string[];
  description?: string;
  artDirection?: string;
}

/** 角色提示词输入（头像/立绘；额外字段会拼进描述）。 */
export interface PromptCharacter extends PromptVariables {
  race?: string;
  characterClass?: string;
  level?: number;
  role?: string;
  appearance?: string;
}

export const SVG_ICON_PROMPT = `你是 2D 游戏图标设计师。只输出一个 SVG 文档，不要 Markdown 代码块，不要解释。
主题：{{name}}；标签：{{tags}}；描述：{{description}}；风格：{{artDirection}}
硬约束：viewBox="0 0 128 128"；单一主体居中；2–3 主色 + 1 强调色；闭合路径；不使用 <text>；
不使用外链与 <script>/<foreignObject>/<image>/<filter>；总元素 ≤ 300。
Avoid：${NEGATIVE_PROMPT}。`;

export const PIXEL_ICON_PROMPT = `你是像素风游戏图标设计师。生成「{{name}}」的 16-bit 像素图标。
标签：{{tags}}；描述：{{description}}；美术方向：{{artDirection}}
硬约束：1024×1024 画布；按 32×32 逻辑网格整数倍绘制；硬边、无抗锯齿、无模糊；限色板（≤ 32 色）；
单一主体居中、占画面约 70%；纯色纯平背景（四角同色，便于去背）；无文字、无边框、无渐变。
Avoid：${NEGATIVE_PROMPT}。`;

export const GAME2D_ICON_PROMPT = `你是 2D 游戏图标设计师。生成「{{name}}」的扁平 2D 图标。
标签：{{tags}}；描述：{{description}}；美术方向：{{artDirection}}
硬约束：512×512 画布；扁平 2D 上色、粗描边、双色阴影、剪影清晰；单一主体居中；
纯色背景（四角同色，便于去背）；无文字、无水印、无边框、无照片感。
Avoid：${NEGATIVE_PROMPT}。`;

export const PORTRAIT_PROMPT = `你是 2D 游戏角色立绘设计师。生成半身角色立绘。
角色：{{name}}；特征：{{tags}}；描述：{{description}}；美术方向：{{artDirection}}
硬约束：3:4 竖幅（768×1024）；半身构图、头部完整、目光平视；扁平 2D 上色 + 勾勒；
纯色背景（可选去背）；单角色居中；无文字、无水印、无多重角色。
Avoid：${NEGATIVE_PROMPT}。`;

export const AVATAR_PROMPT = `你是 2D 游戏角色头像设计师。生成 1:1 方形角色头像。
角色：{{name}}；特征：{{tags}}；描述：{{description}}；美术方向：{{artDirection}}
硬约束：正方形构图（目标 256×256）；头肩特写、五官清晰、正面或 3/4 侧脸；扁平 2D 上色；
纯色背景（可选去背）；单角色居中；无文字、无水印、无边框。
Avoid：${NEGATIVE_PROMPT}。`;

/** 供工坊模板变量面板使用的模板表。 */
export const PROMPT_TEMPLATES = {
  svg: SVG_ICON_PROMPT,
  'pixel-32': PIXEL_ICON_PROMPT,
  'game-2d': GAME2D_ICON_PROMPT,
  portrait: PORTRAIT_PROMPT,
  avatar: AVATAR_PROMPT,
} as const;

function cleanVariable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function tagsToText(tags: string | string[] | undefined): string | undefined {
  if (tags === undefined) return undefined;
  const list = Array.isArray(tags) ? tags : [tags];
  const filtered = list.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  return filtered.length === 0 ? undefined : filtered.join('、');
}

/** 渲染提示词模板：替换 `{{name}}/{{tags}}/{{description}}/{{artDirection}}`，缺省给占位文案。 */
export function renderPromptTemplate(template: string, variables: PromptVariables = {}): string {
  const values: Record<string, string> = {
    name: cleanVariable(variables.name) ?? '（未命名主体）',
    tags: cleanVariable(tagsToText(variables.tags)) ?? '（无标签）',
    description: cleanVariable(variables.description) ?? '（无描述）',
    artDirection: cleanVariable(variables.artDirection) ?? '2D 游戏美术，干净描边，单一主体',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? '（未填写）');
}

/** 把负向提示词以 `Avoid：` 段追加进 prompt（不重复追加已含的同一条）。 */
export function appendNegativePrompt(prompt: string, negativePrompt?: string): string {
  const base = typeof prompt === 'string' ? prompt.trim() : '';
  if (negativePrompt === undefined || negativePrompt.trim().length === 0) return base;
  const negative = negativePrompt.trim();
  if (base.includes(negative)) return base;
  return `${base}\nAvoid：${negative}`;
}

function characterVariables(character: PromptCharacter): PromptVariables {
  const extras: string[] = [];
  if (cleanVariable(character.race) !== undefined) extras.push(`种族：${character.race!.trim()}`);
  if (cleanVariable(character.characterClass) !== undefined) {
    extras.push(`职业：${character.characterClass!.trim()}`);
  }
  if (character.level !== undefined) extras.push(`等级：${String(character.level)}`);
  if (cleanVariable(character.role) !== undefined) extras.push(`定位：${character.role!.trim()}`);
  if (cleanVariable(character.appearance) !== undefined) extras.push(`外貌：${character.appearance!.trim()}`);
  const descriptionParts: string[] = [];
  if (cleanVariable(character.description) !== undefined) descriptionParts.push(character.description!.trim());
  if (extras.length > 0) descriptionParts.push(extras.join('；'));
  return {
    ...(cleanVariable(character.name) === undefined ? {} : { name: character.name }),
    ...(character.tags === undefined ? {} : { tags: character.tags }),
    ...(descriptionParts.length === 0 ? {} : { description: descriptionParts.join('\n') }),
    ...(cleanVariable(character.artDirection) === undefined
      ? {}
      : { artDirection: character.artDirection }),
  };
}

/** AI SVG 图标提示词（§2.2 模板，输出 128×128 SVG）。 */
export function promptSvgIcon(item: PromptVariables): string {
  return renderPromptTemplate(SVG_ICON_PROMPT, item);
}

/** 像素风生图提示词（1024×1024 请求 → 归一化 32×32）。 */
export function promptPixelIcon(item: PromptVariables): string {
  return renderPromptTemplate(PIXEL_ICON_PROMPT, item);
}

/** 2D 游戏风图标生图提示词（512×512 请求 → 归一化 128×128）。 */
export function promptGame2dIcon(item: PromptVariables): string {
  return renderPromptTemplate(GAME2D_ICON_PROMPT, item);
}

/** 立绘生图提示词（768×1024）。 */
export function promptPortrait(character: PromptCharacter): string {
  return renderPromptTemplate(PORTRAIT_PROMPT, characterVariables(character));
}

/** 头像生图提示词（256×256）。 */
export function promptAvatar(character: PromptCharacter): string {
  return renderPromptTemplate(AVATAR_PROMPT, characterVariables(character));
}
