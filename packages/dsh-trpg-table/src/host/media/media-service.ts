/**
 * 生图服务（M9.5d）：玩家/房主的 `assets.generate` 后端。
 *
 * - 配置来自环境变量（可被构造参数覆盖）：
 *   `DSH_TRPG_OPENAI_BASE_URL` / `DSH_TRPG_OPENAI_API_KEY` /
 *   `DSH_TRPG_OPENAI_IMAGE_MODEL` / `DSH_TRPG_OPENAI_TEXT_MODEL`；
 * - 复用 `@dsh-trpg/assets` 的 OpenAI 兼容客户端 + 提示词模板 + `normalizeImage`：
 *   模型返回任意尺寸，host 强制归一化到标准档（avatar 256 / portrait 768×1024 /
 *   icon 128 或 32 / sprite 帧表 512，每格 128）；
 * - 无配置时返回可读中文错误（`conflict`），客户端据此引导「配置我自己的接口」；
 * - 每玩家滑动窗口限流（默认 3 次/分钟，可配）+ 单次候选 ≤4；
 * - 测试/开发注入点：`generator`（自定义/假生成器）与 `fake:true`（等同 `--fake`），
 *   也可用 `DSH_TRPG_MEDIA_FAKE=1` 打开，全程不需要网络。
 *
 * 本服务**不读写房间状态**，也不落盘：候选只回给请求者预览，确认后由客户端走 `assets.upload`。
 */
import {
  ASSET_TARGETS,
  NEGATIVE_PROMPT,
  OpenAICompatClient,
  OpenAIClientError,
  encodePng,
  normalizeImage,
  promptAvatar,
  promptGame2dIcon,
  promptPixelIcon,
  promptPortrait,
  promptSvgIcon,
  renderPromptTemplate,
  type FetchLike,
  type NormalizeTargetId,
} from '../../../../assets/src/index.ts';
import { RoomError } from '@dsh-trpg/rooms';
import type {
  AssetsGenerateCandidate,
  AssetsGenerateParams,
  AssetsGenerateResult,
  MediaAssetKind,
  MediaAssetStyle,
} from '@dsh-trpg/protocol';

// ---------------------------------------------------------------------------
// 可注入的生成器（测试全 mock；`--fake` 兼容）
// ---------------------------------------------------------------------------

/** 一次生图请求的完整口径（提示词已渲染、目标档已选定）。 */
export interface MediaRenderRequest {
  kind: MediaAssetKind;
  style: MediaAssetStyle;
  /** 已渲染的完整提示词。 */
  prompt: string;
  /** 候选数量 1–4。 */
  count: number;
  /** 归一化目标档。 */
  target: NormalizeTargetId;
  /** 生图接口请求尺寸（如 `1024x1024`）。 */
  size: string;
  /** 帧表参数（kind=sprite 时给）。 */
  sprite?: { rows: number; cols: number; frameSize: number };
  seed?: number;
}

/** 生成器返回的原始素材（未归一化；PNG 字节或 SVG 文本，按 magic 嗅探）。 */
export interface MediaRawImage {
  bytes?: Uint8Array;
  svg?: string;
  seed?: number;
}

export interface MediaRawResult {
  images: MediaRawImage[];
  /** 生成来源展示名（结果里的 `provider`）。 */
  provider?: string;
}

/** 候选生成器注入点：生产走 OpenAI 兼容客户端，单测注入 fake，`--fake` 用内置假生成器。 */
export type MediaAssetGenerator = (request: MediaRenderRequest) => MediaRawResult | Promise<MediaRawResult>;

/** 生图请求者（token 解析后的房间成员；房主记 `host`）。 */
export interface MediaPrincipal {
  roomId: string;
  playerId: string;
}

/** `room-http` 依赖的最小接口（方便注入假实现）。 */
export interface MediaAssetsService {
  generate(principal: MediaPrincipal, params: AssetsGenerateParams): Promise<AssetsGenerateResult>;
}

// ---------------------------------------------------------------------------
// 配置与限流
// ---------------------------------------------------------------------------

export interface MediaRateLimit {
  /** 窗口内最多几次（默认 3）。 */
  max: number;
  /** 窗口长度（毫秒，默认 60000 = 1 分钟）。 */
  windowMs: number;
}

export interface MediaServiceOptions {
  /** OpenAI 兼容接口地址（缺省读 `DSH_TRPG_OPENAI_BASE_URL`）。 */
  baseUrl?: string;
  /** API Key（缺省读 `DSH_TRPG_OPENAI_API_KEY`）。 */
  apiKey?: string;
  /** 生图模型（缺省读 `DSH_TRPG_OPENAI_IMAGE_MODEL`）。 */
  imageModel?: string;
  /** 文本模型（AI SVG 用；缺省读 `DSH_TRPG_OPENAI_TEXT_MODEL`）。 */
  textModel?: string;
  /** 注入 fetch（单测 fake fetch；缺省用全局 fetch）。 */
  fetchImpl?: FetchLike;
  /** 环境变量来源（测试注入；缺省 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** 直接注入候选生成器（优先于 fake / OpenAI；测试与自定义 provider）。 */
  generator?: MediaAssetGenerator;
  /** `--fake` 兼容开关：用内置假生成器（不需要任何配置/网络）。 */
  fake?: boolean;
  /** 每玩家限流（缺省 3 次/分钟；也可用 `DSH_TRPG_MEDIA_RATE_MAX` / `DSH_TRPG_MEDIA_RATE_WINDOW_MS`）。 */
  rateLimit?: Partial<MediaRateLimit>;
  /** 单次候选上限（硬上限 4）。 */
  maxCandidates?: number;
  /** 单次请求超时（毫秒，默认 120000）。 */
  timeoutMs?: number;
  /** 失败重试次数（仅网络/5xx；默认 1）。 */
  retries?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** provider 展示名前缀（缺省 `openai-compat`）。 */
  providerName?: string;
}

const DEFAULT_RATE_LIMIT: MediaRateLimit = { max: 3, windowMs: 60_000 };
const HARD_MAX_CANDIDATES = 4;

/** 滑动窗口限流（per key，内存态；host 重启清零，够用且无外部依赖）。 */
class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /**
   * 记一次请求。
   * @returns `undefined` = 允许；否则返回中文错误（含还要等多少秒）。
   */
  take(key: string): string | undefined {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      const waitSeconds = Math.max(1, Math.ceil(((list[0] ?? now) + this.windowMs - now) / 1000));
      return `生成请求太频繁：每 ${Math.round(this.windowMs / 1000)} 秒最多 ${this.max} 次，请 ${waitSeconds} 秒后再试`;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 2000) {
      for (const [candidate, at] of this.hits) {
        if (at.length === 0 || (at[at.length - 1] ?? 0) <= cutoff) this.hits.delete(candidate);
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 目标档与提示词
// ---------------------------------------------------------------------------

interface RenderPlan {
  target: NormalizeTargetId;
  size: string;
  sprite?: { rows: number; cols: number; frameSize: number };
}

/** 帧表统一 4×4、每格 128（契约 §8.2：整表 512，运行时不切分）。 */
const SPRITE_ROWS = 4;
const SPRITE_COLS = 4;
const SPRITE_FRAME_SIZE = ASSET_TARGETS.spritesheet.frameSize ?? 128;

/** kind + style → 归一化标准档 + 生图请求尺寸。 */
export function mediaRenderPlan(kind: MediaAssetKind, style: MediaAssetStyle): RenderPlan {
  if (style === 'svg' && kind !== 'icon') {
    throw new RoomError('bad-request', '风格 svg 只支持 icon 类型（头像/立绘/帧表请用 pixel-32 或 game-2d 生图风格）');
  }
  switch (kind) {
    case 'avatar':
      return { target: 'avatar-256', size: '1024x1024' };
    case 'portrait':
      return { target: 'portrait', size: '768x1024' };
    case 'icon':
      // 像素档要求按 32×32 逻辑网格整数倍绘制，请求 1024×1024 再降采样。
      if (style === 'pixel-32') return { target: 'pixel-32', size: '1024x1024' };
      return { target: 'icon-128', size: '512x512' };
    case 'sprite':
      return {
        target: 'spritesheet',
        size: '1024x1024',
        sprite: { rows: SPRITE_ROWS, cols: SPRITE_COLS, frameSize: SPRITE_FRAME_SIZE },
      };
  }
}

const STYLE_DIRECTION: Readonly<Record<MediaAssetStyle, string>> = {
  'pixel-32': '16-bit 像素风，硬边、限色板（≤32 色）、无抗锯齿、无模糊',
  'game-2d': '扁平 2D 游戏美术，粗描边、双色阴影、剪影清晰',
  svg: '简洁矢量图标，纯色平涂、几何轮廓、2–3 主色',
};

const SPRITE_SHEET_PROMPT = `你是 2D 游戏精灵帧表设计师。生成「{{name}}」的角色动作帧表。
描述：{{description}}；美术方向：{{artDirection}}
硬约束：${SPRITE_ROWS} 行 × ${SPRITE_COLS} 列等分网格，每格 ${SPRITE_FRAME_SIZE}×${SPRITE_FRAME_SIZE}；
同一角色、同一比例、朝下/侧面动作帧，不跨格、不重叠；
纯色纯平背景（四角同色，便于去背）；无文字、无水印、无边框。
Avoid：${NEGATIVE_PROMPT}。`;

/** 渲染生图提示词（复用 assets 包模板；帧表用本服务的网格模板）。 */
export function buildMediaPrompt(params: AssetsGenerateParams): string {
  const description = params.prompt.trim();
  const subject = params.subject?.trim() || description.slice(0, 40);
  const artDirection = STYLE_DIRECTION[params.style];
  const variables = { name: subject, description, artDirection };
  if (params.kind === 'avatar') return promptAvatar(variables);
  if (params.kind === 'portrait') return promptPortrait(variables);
  if (params.kind === 'sprite') return renderPromptTemplate(SPRITE_SHEET_PROMPT, variables);
  if (params.style === 'svg') return promptSvgIcon(variables);
  if (params.style === 'pixel-32') return promptPixelIcon(variables);
  return promptGame2dIcon(variables);
}

// ---------------------------------------------------------------------------
// 内置生成器：OpenAI 兼容客户端 / fake（--fake）
// ---------------------------------------------------------------------------

/** 内置 OpenAI 兼容生成器（生图走 images/generations；AI SVG 走 chat/completions）。 */
export function createOpenAIMediaGenerator(
  client: OpenAICompatClient,
  providerName = 'openai-compat',
): MediaAssetGenerator {
  return async (request) => {
    if (request.style === 'svg') {
      const images: MediaRawImage[] = [];
      for (let index = 0; index < request.count; index += 1) {
        const text = await client.chatText({ prompt: request.prompt });
        images.push({
          svg: text.content,
          ...(request.seed !== undefined ? { seed: request.seed + index } : {}),
        });
      }
      return { images, provider: `${providerName}:chat-completions` };
    }
    const result = await client.generateImage({
      prompt: request.prompt,
      size: request.size,
      n: request.count,
      negativePrompt: NEGATIVE_PROMPT,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    });
    return {
      images: result.images.map((image) => ({
        bytes: image.bytes,
        ...(image.seed !== null ? { seed: image.seed } : {}),
      })),
      provider: `${providerName}:${result.model ?? 'image'}`,
    };
  };
}

/** fake 生成器产出的小图边长（256 = 32/64/128 的整数倍，归一化不会糊）。 */
const FAKE_SIZE = 256;

/** 内置假 PNG（确定性四象限色块；用于 `--fake` / 单测，不依赖网络）。 */
export function fakeMediaPng(index = 0): Uint8Array {
  const rgba = new Uint8Array(FAKE_SIZE * FAKE_SIZE * 4);
  const palette = [
    [47, 111, 78, 255],
    [193, 122, 58, 255],
    [58, 82, 193, 255],
    [158, 58, 120, 255],
  ] as const;
  const half = FAKE_SIZE / 2;
  for (let y = 0; y < FAKE_SIZE; y += 1) {
    for (let x = 0; x < FAKE_SIZE; x += 1) {
      const quadrant = (x < half ? 0 : 1) + (y < half ? 0 : 2);
      const color = palette[(quadrant + index) % palette.length]!;
      const offset = (y * FAKE_SIZE + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
  return encodePng({ width: FAKE_SIZE, height: FAKE_SIZE, rgba });
}

/** 内置假 SVG（白色名单元素，可被 sanitizeSvg 接受）。 */
export function fakeMediaSvg(index = 0): string {
  const colors = ['#2f6f4e', '#c17a3a', '#3a52c1', '#9e3a78'];
  const color = colors[index % colors.length]!;
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" fill="${color}"/><circle cx="64" cy="64" r="24" fill="#ffffff"/></svg>`;
}

/** `--fake` 兼容的内置假生成器：无配置、无网络，返回确定性素材。 */
export function createFakeMediaGenerator(): MediaAssetGenerator {
  return (request) => {
    const images: MediaRawImage[] = [];
    for (let index = 0; index < request.count; index += 1) {
      const seed = (request.seed ?? 9000) + index;
      if (request.style === 'svg') images.push({ svg: fakeMediaSvg(index), seed });
      else images.push({ bytes: fakeMediaPng(index), seed });
    }
    return { images, provider: 'fake' };
  };
}

// ---------------------------------------------------------------------------
// MediaService
// ---------------------------------------------------------------------------

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 把 assets 包的错误翻成可读中文（`RoomError.code` 供客户端分支）。 */
function providerRoomError(error: unknown): RoomError {
  if (error instanceof RoomError) return error;
  if (error instanceof OpenAIClientError) {
    return new RoomError('conflict', `生图服务暂时不可用：${error.message}`);
  }
  return new RoomError('conflict', `生图失败：${error instanceof Error ? error.message : String(error)}`);
}

/**
 * 生图服务：配置 → 提示词 → 生成器 → 归一化标准档 → 候选（base64）。
 *
 * `generate` 只在内存里跑，不落盘；候选确认后由客户端调用 `assets.upload` 落房间资产区。
 */
export class MediaService implements MediaAssetsService {
  readonly enabled: boolean;
  readonly providerName: string;
  readonly baseUrl: string | undefined;
  readonly imageModel: string | undefined;
  readonly textModel: string | undefined;
  private readonly generator: MediaAssetGenerator | undefined;
  private readonly limiter: SlidingWindowLimiter;
  private readonly maxCandidates: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: MediaServiceOptions = {}) {
    const env = options.env ?? process.env;
    const baseUrl = options.baseUrl ?? envValue(env, 'DSH_TRPG_OPENAI_BASE_URL');
    const apiKey = options.apiKey ?? envValue(env, 'DSH_TRPG_OPENAI_API_KEY');
    const imageModel = options.imageModel ?? envValue(env, 'DSH_TRPG_OPENAI_IMAGE_MODEL');
    const textModel = options.textModel ?? envValue(env, 'DSH_TRPG_OPENAI_TEXT_MODEL');
    this.baseUrl = baseUrl;
    this.imageModel = imageModel;
    this.textModel = textModel;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.providerName = options.providerName ?? 'openai-compat';
    this.maxCandidates = Math.min(
      HARD_MAX_CANDIDATES,
      Math.max(1, Math.trunc(options.maxCandidates ?? HARD_MAX_CANDIDATES)),
    );
    const rateLimit: MediaRateLimit = {
      max: options.rateLimit?.max ?? positiveInteger(envValue(env, 'DSH_TRPG_MEDIA_RATE_MAX')) ?? DEFAULT_RATE_LIMIT.max,
      windowMs:
        options.rateLimit?.windowMs
        ?? positiveInteger(envValue(env, 'DSH_TRPG_MEDIA_RATE_WINDOW_MS'))
        ?? DEFAULT_RATE_LIMIT.windowMs,
    };
    this.limiter = new SlidingWindowLimiter(Math.max(1, rateLimit.max), Math.max(1000, rateLimit.windowMs), this.now);

    const fake = options.fake === true || envValue(env, 'DSH_TRPG_MEDIA_FAKE') === '1';
    if (options.generator !== undefined) {
      this.generator = options.generator;
    } else if (fake) {
      this.generator = createFakeMediaGenerator();
    } else if (baseUrl !== undefined) {
      // 只配了 baseUrl 也算「已配置」：具体模型缺省由 assets 客户端给可读错误（config）。
      const client = new OpenAICompatClient({
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(imageModel !== undefined ? { imageModel } : {}),
        ...(textModel !== undefined ? { textModel } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.retries !== undefined ? { retries: options.retries } : {}),
      });
      this.generator = createOpenAIMediaGenerator(client, this.providerName);
    } else {
      this.generator = undefined;
    }
    this.enabled = this.generator !== undefined;
    if (!this.enabled) {
      this.log('生图服务未配置（DSH_TRPG_OPENAI_BASE_URL / DSH_TRPG_OPENAI_IMAGE_MODEL 缺省）：assets.generate 将返回中文错误');
    }
  }

  /** 是否可用（未配置时 `assets.generate` 回可读中文错误，客户端引导自备接口）。 */
  configured(): boolean {
    return this.generator !== undefined;
  }

  /**
   * 生成候选（玩家/房主）：限流 → 提示词 → 生成 → 归一化标准档。
   *
   * @throws RoomError `conflict`（未配置/限流/模型失败/全部候选不合格）、`bad-request`（风格与类型不匹配）。
   */
  async generate(principal: MediaPrincipal, params: AssetsGenerateParams): Promise<AssetsGenerateResult> {
    const generator = this.generator;
    if (generator === undefined) {
      throw new RoomError(
        'conflict',
        '生图服务未配置：房主请在 host 环境变量里设置 DSH_TRPG_OPENAI_BASE_URL / DSH_TRPG_OPENAI_API_KEY / '
          + 'DSH_TRPG_OPENAI_IMAGE_MODEL（并可选 DSH_TRPG_OPENAI_TEXT_MODEL 用于 SVG 图标），'
          + '或改成玩家自备的 OpenAI 兼容接口',
      );
    }
    const limitError = this.limiter.take(`${principal.roomId}:${principal.playerId}`);
    if (limitError !== undefined) throw new RoomError('conflict', limitError);

    const plan = mediaRenderPlan(params.kind, params.style);
    const prompt = buildMediaPrompt(params);
    const count = Math.min(this.maxCandidates, Math.max(1, Math.trunc(params.count ?? 1)));
    const request: MediaRenderRequest = {
      kind: params.kind,
      style: params.style,
      prompt,
      count,
      target: plan.target,
      size: plan.size,
      ...(plan.sprite !== undefined ? { sprite: plan.sprite } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
    };

    let raw: MediaRawResult;
    try {
      raw = await generator(request);
    } catch (error) {
      this.log(`assets.generate failed (${params.kind}/${params.style}): ${error instanceof Error ? error.message : String(error)}`);
      throw providerRoomError(error);
    }
    if (raw.images.length === 0) {
      throw new RoomError('conflict', '生图服务没有返回任何图片（可能被内容安全策略拦截），请调整提示词后重试');
    }

    const candidates: AssetsGenerateCandidate[] = [];
    const problems: string[] = [];
    for (const image of raw.images.slice(0, count)) {
      const input = image.svg !== undefined
        ? new TextEncoder().encode(image.svg)
        : image.bytes;
      if (input === undefined || input.length === 0) {
        problems.push('生成器返回了空图片');
        continue;
      }
      const normalized = normalizeImage(input, plan.target, plan.sprite !== undefined ? { rows: plan.sprite.rows, cols: plan.sprite.cols } : {});
      if (!normalized.ok || normalized.bytes === undefined || normalized.format === undefined || normalized.sha256 === undefined) {
        problems.push(normalized.errors[0] ?? '归一化失败');
        continue;
      }
      candidates.push({
        b64: Buffer.from(normalized.bytes).toString('base64'),
        format: normalized.format,
        width: normalized.width,
        height: normalized.height,
        sha256: normalized.sha256,
        prompt,
        ...(image.seed !== undefined ? { seed: image.seed } : {}),
        style: params.style,
      });
    }
    if (candidates.length === 0) {
      throw new RoomError(
        'conflict',
        `生成的图片都不合格（已按 ${ASSET_TARGETS[plan.target].label} 标准档校验）：${problems[0] ?? '未知原因'}`,
      );
    }
    return {
      candidates,
      ...(raw.provider !== undefined ? { provider: raw.provider } : {}),
    };
  }
}

/** 创建生图服务（host `index.ts` 的接线入口）。 */
export function createMediaService(options: MediaServiceOptions = {}): MediaService {
  return new MediaService(options);
}
