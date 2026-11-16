/**
 * M9.5e AI 底图生成（剧本 §③：结构摘要 + 风格档 + 氛围 prompt → 俯视/插画底图 PNG）。
 *
 * - 生图走**可注入**的 `StudioImageGenerator`（生产 = OpenAI 兼容 images/generations，单测 = mock）；
 * - 产物一律经 `normalizeImage()` 归一化到标准档：战斗图 **1024×768**（`battle-map`）、
 *   世界图 **2048×1536**（`world-map`），并回 `{b64,width,height,sha256}`；
 * - **失败/未配置/超时只进 warnings，不阻断结构生成**（契约：结构是唯一权威，底图只是皮肤；
 *   底图缺失时客户端退回程序化底图，战斗照常可玩）；
 * - 生图体积上限：战斗图 4 MiB / 世界图 7 MiB（`assets` 包默认 512 KiB 是图标档的硬约束，
 *   底图是大幅面，落盘前由 zip 单条目 8 MiB 兜底）。
 */
import { NEGATIVE_PROMPT, normalizeImage } from '../../../../assets/src/index.ts';
import type { GeneratedMapBackground, MapGenerateStyle, WorldGenerateStyle } from '@dsh-trpg/protocol';
import { summarizeBattleStructure, summarizeWorldStructure } from './map-generator.ts';
import type { BattleStructure, WorldStructure } from '@dsh-trpg/protocol';

/** 一次底图生图请求（提示词已渲染、尺寸已定）。 */
export interface StudioImageRequest {
  kind: 'battle-map' | 'world-map';
  prompt: string;
  /** 生图接口请求尺寸（4:3）。 */
  size: string;
  seed?: number;
}

/** 生成器返回的原始图片（未归一化，PNG/SVG 字节由 normalizeImage 嗅探）。 */
export interface StudioImageOutput {
  images: Array<{ bytes: Uint8Array; seed?: number }>;
  provider?: string;
}

/** 可注入的生图器（生产 = OpenAI 兼容客户端；单测 = mock；未配置 = undefined）。 */
export type StudioImageGenerator = (
  request: StudioImageRequest,
) => StudioImageOutput | Promise<StudioImageOutput>;

/** 底图归一化上限（见文件头注释）。 */
export const BACKGROUND_MAX_BYTES = {
  'battle-map': 4 * 1024 * 1024,
  'world-map': 7 * 1024 * 1024,
} as const;

export interface BackgroundOutcome {
  background: GeneratedMapBackground | null;
  warnings: string[];
  /** 实际使用的完整提示词（作者可复制去重生成）。 */
  prompt: string;
}

const STYLE_DIRECTION: Readonly<Record<MapGenerateStyle | WorldGenerateStyle, string>> = {
  'topdown-2d': '正俯视 2D 游戏战场底图，手绘质感、光照均匀、结构块面清晰',
  'pixel-topdown': '16-bit 像素风正俯视战场底图，硬边像素、限色板、无抗锯齿',
  '2d-illustration': '2D 俯视/等距手绘插画世界地图，水彩质感、河流道路清晰、留出区域热点位置',
};

/** 战斗图底图提示词：结构摘要 + 风格档 + 氛围。 */
export function buildBattleBackgroundPrompt(input: {
  prompt: string;
  style: MapGenerateStyle;
  structure: BattleStructure;
  seed?: number;
}): string {
  const summary = summarizeBattleStructure(input.structure);
  return `你是战棋 TRPG 的地图底图美术师。生成一张【正俯视】战场底图（4:3）。
场景氛围：${input.prompt.trim().slice(0, 600)}
结构摘要（权威数据，底图只做皮肤）：${summary}
美术方向：${STYLE_DIRECTION[input.style]}。
硬约束：正俯视、无网格线、无文字/字母/水印/UI/边框、不画角色与怪物、光照均匀、地形块面与结构摘要大致对应、边缘留出不可通行的边界。
Avoid：${NEGATIVE_PROMPT}`;
}

/** 世界地图底图提示词：区域清单 + 插画风格。 */
export function buildWorldBackgroundPrompt(input: {
  prompt: string;
  style?: WorldGenerateStyle;
  world: WorldStructure;
  seed?: number;
}): string {
  const summary = summarizeWorldStructure(input.world);
  const style = input.style ?? '2d-illustration';
  return `你是 TRPG 世界地图的插画师。生成一张【俯视/等距】2D 插画世界地图底图（4:3）。
世界观与氛围：${input.prompt.trim().slice(0, 600)}
区域清单（按大致网格分布，请为每个区域留出可辨识的地貌块，不要写字）：${summary}
美术方向：${STYLE_DIRECTION[style]}。
硬约束：无网格线、无文字/字母/图例/水印/UI、不画角色、道路与河流自然连接各区域、整体色调统一、边缘自然收尾。
Avoid：${NEGATIVE_PROMPT}`;
}

/**
 * 生成并归一化一张底图。未注入生成器 / 生成失败 / 归一化失败 → 只返回 warnings + null。
 */
export async function generateMapBackground(input: {
  kind: 'battle-map' | 'world-map';
  prompt: string;
  seed?: number;
  imageGenerator?: StudioImageGenerator;
}): Promise<BackgroundOutcome> {
  const warnings: string[] = [];
  const prompt = input.prompt;
  if (input.imageGenerator === undefined) {
    warnings.push(
      '生图服务未配置（或未启用）：底图未生成；结构不受影响，客户端会退回程序化底图。'
        + '房主可配置 DSH_TRPG_OPENAI_BASE_URL / DSH_TRPG_OPENAI_IMAGE_MODEL 后重试生成底图。',
    );
    return { background: null, warnings, prompt };
  }
  const target = input.kind;
  const size = input.kind === 'battle-map' ? '1024x768' : '1536x1152';
  let raw: StudioImageOutput;
  try {
    raw = await input.imageGenerator({
      kind: input.kind,
      prompt,
      size,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
  } catch (error) {
    warnings.push(`底图生图失败（结构不受影响）：${error instanceof Error ? error.message : String(error)}`);
    return { background: null, warnings, prompt };
  }
  const first = raw.images[0];
  if (first === undefined || first.bytes.length === 0) {
    warnings.push('底图生图失败（结构不受影响）：生图服务没有返回任何图片');
    return { background: null, warnings, prompt };
  }
  const normalized = normalizeImage(first.bytes, target, {
    pixelated: false,
    maxBytes: BACKGROUND_MAX_BYTES[target],
  });
  if (!normalized.ok || normalized.bytes === undefined || normalized.sha256 === undefined) {
    warnings.push(
      `底图不合格（结构不受影响）：${normalized.errors[0] ?? '归一化失败'}`,
    );
    return { background: null, warnings, prompt };
  }
  warnings.push(...normalized.warnings.map((warning) => `底图归一化：${warning}`));
  return {
    background: {
      b64: Buffer.from(normalized.bytes).toString('base64'),
      width: normalized.width,
      height: normalized.height,
      sha256: normalized.sha256,
      format: 'png',
    },
    warnings,
    prompt,
  };
}
