/**
 * M9.5e 工坊服务门面（host 侧）：地图/世界生成 + 内容包工坊 RPC 的唯一实现入口。
 *
 * `room-http` 只依赖 {@link StudioApi} 的结构化接口（便于单测注入假实现）；默认实现
 * {@link Studio} 组合：
 * - `map-generator.ts`：AI 文本草稿 → 校验 → 重试 ≤2 → 程序化兜底（结构唯一权威）；
 * - `background.ts`：AI 底图 → `normalizeImage` 归一化到 1024×768 / 2048×1536（失败只 warning）；
 * - `pack-workspace.ts`：内容包 detail/update/export/import/assetPut/assetDelete（原子写 + reload）。
 *
 * OpenAI 兼容配置复用 M9.5d 的环境变量（`DSH_TRPG_OPENAI_BASE_URL / _API_KEY / _IMAGE_MODEL /
 * _TEXT_MODEL`）；`DSH_TRPG_MEDIA_FAKE=1` 时底图走内置假生成器（离线联调不需要网络），
 * 文本模型不配则直接走程序化结构（离线模式仍可完整出图/导出）。
 */
import { existsSync } from 'node:fs';
import {
  OpenAICompatClient,
  type FetchLike,
} from '../../../../assets/src/index.ts';
import type {
  MapGenerateParams,
  MapGenerateResult,
  PackAssetDeleteParams,
  PackAssetDeleteResult,
  PackAssetPutParams,
  PackAssetPutResult,
  PackDetailParams,
  PackDetailResult,
  PackExportParams,
  PackExportResult,
  PackImportParams,
  PackImportResult,
  PackUpdateParams,
  PackUpdateResult,
  WorldGenerateParams,
  WorldGenerateResult,
} from '@dsh-trpg/protocol';
import type { PackRegistry } from '../pack-registry.ts';
import { fakeMediaPng } from '../media/index.ts';
import {
  generateBattleMap,
  generateWorldMap,
  type StudioTextGenerator,
  type StudioTextRequest,
} from './map-generator.ts';
import {
  buildBattleBackgroundPrompt,
  buildWorldBackgroundPrompt,
  generateMapBackground,
  type StudioImageGenerator,
  type StudioImageRequest,
} from './background.ts';
import { PackWorkspace, type PackWorkspaceOptions } from './pack-workspace.ts';

/** `room-http` 依赖的最小接口（8 个工坊 RPC 一一对应）。 */
export interface StudioApi {
  generateMap(params: MapGenerateParams): Promise<MapGenerateResult>;
  generateWorld(params: WorldGenerateParams): Promise<WorldGenerateResult>;
  packDetail(params: PackDetailParams): PackDetailResult;
  packUpdate(params: PackUpdateParams): Promise<PackUpdateResult>;
  packExport(params: PackExportParams): PackExportResult;
  packImport(params: PackImportParams): Promise<PackImportResult>;
  packAssetPut(params: PackAssetPutParams): Promise<PackAssetPutResult>;
  packAssetDelete(params: PackAssetDeleteParams): Promise<PackAssetDeleteResult>;
}

export interface StudioOptions {
  /** host 内容包注册表（pack.detail/update/... 的数据来源与 reload 入口）。 */
  registry: PackRegistry;
  /** 数据目录（缺省 = `registry.dir`）。 */
  dir?: string;
  /** OpenAI 兼容接口地址（缺省读 `DSH_TRPG_OPENAI_BASE_URL`）。 */
  baseUrl?: string;
  apiKey?: string;
  /** 文本模型（地图/世界结构草稿；缺省读 `DSH_TRPG_OPENAI_TEXT_MODEL`）。 */
  textModel?: string;
  /** 生图模型（底图；缺省读 `DSH_TRPG_OPENAI_IMAGE_MODEL`）。 */
  imageModel?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  /** 环境变量来源（测试注入；缺省 `process.env`）。 */
  env?: NodeJS.ProcessEnv;
  /** 直接注入文本生成器（优先于 OpenAI / 测试 mock）。 */
  textGenerator?: StudioTextGenerator;
  /** 直接注入生图器（优先于 OpenAI / fake）。 */
  imageGenerator?: StudioImageGenerator;
  /** `--fake` 兼容：底图用内置假生成器（不需要配置/网络）；结构走程序化。 */
  fake?: boolean;
  log?: (message: string) => void;
  now?: () => number;
  /** 直接注入 PackWorkspace（测试用）。 */
  workspace?: PackWorkspace;
  /** PackWorkspace 的额外选项（`now` 等）。 */
  workspaceOptions?: Partial<PackWorkspaceOptions>;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 默认文本生成器：OpenAI 兼容 chat/completions（未配置 baseUrl/textModel 时返回 undefined）。 */
function createOpenAITextGenerator(client: OpenAICompatClient): StudioTextGenerator {
  return async (request: StudioTextRequest) => {
    const result = await client.chatText({
      system: request.system,
      prompt: request.prompt,
      temperature: 0.4,
      maxTokens: 3000,
    });
    return result.content;
  };
}

/** 默认生图器：OpenAI 兼容 images/generations（只接受 b64_json，与 M9.5d 同口径）。 */
function createOpenAIImageGenerator(client: OpenAICompatClient): StudioImageGenerator {
  return async (request: StudioImageRequest) => {
    const result = await client.generateImage({
      prompt: request.prompt,
      size: request.size,
      n: 1,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    });
    return {
      images: result.images.map((image) => ({
        bytes: image.bytes,
        ...(image.seed !== null ? { seed: image.seed } : {}),
      })),
      ...(result.model !== undefined ? { provider: `openai-compat:${result.model}` } : {}),
    };
  };
}

/** fake 生图器：确定性四象限 PNG（归一化到任意档都合法），离线联调用。 */
function createFakeImageGenerator(): StudioImageGenerator {
  return () => ({ images: [{ bytes: fakeMediaPng(0) }], provider: 'fake' });
}

/** 工坊服务门面（生产实现）。 */
export class Studio implements StudioApi {
  readonly workspace: PackWorkspace;
  readonly textEnabled: boolean;
  readonly imageEnabled: boolean;
  private readonly textGenerator: StudioTextGenerator | undefined;
  private readonly imageGenerator: StudioImageGenerator | undefined;
  private readonly log: (message: string) => void;

  constructor(options: StudioOptions) {
    const env = options.env ?? process.env;
    const baseUrl = options.baseUrl ?? envValue(env, 'DSH_TRPG_OPENAI_BASE_URL');
    const apiKey = options.apiKey ?? envValue(env, 'DSH_TRPG_OPENAI_API_KEY');
    const textModel = options.textModel ?? envValue(env, 'DSH_TRPG_OPENAI_TEXT_MODEL');
    const imageModel = options.imageModel ?? envValue(env, 'DSH_TRPG_OPENAI_IMAGE_MODEL');
    this.log = options.log ?? (() => {});
    const fake = options.fake === true || envValue(env, 'DSH_TRPG_MEDIA_FAKE') === '1';

    let client: OpenAICompatClient | undefined;
    if (baseUrl !== undefined) {
      try {
        client = new OpenAICompatClient({
          baseUrl,
          ...(apiKey !== undefined ? { apiKey } : {}),
          ...(imageModel !== undefined ? { imageModel } : {}),
          ...(textModel !== undefined ? { textModel } : {}),
          ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.retries !== undefined ? { retries: options.retries } : {}),
        });
      } catch (error) {
        this.log(`工坊 OpenAI 兼容客户端初始化失败（UI 结构生成/底图不可用）：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.textGenerator =
      options.textGenerator ?? (client !== undefined && textModel !== undefined ? createOpenAITextGenerator(client) : undefined);
    this.imageGenerator =
      options.imageGenerator
      ?? (client !== undefined && imageModel !== undefined ? createOpenAIImageGenerator(client) : undefined)
      ?? (fake ? createFakeImageGenerator() : undefined);
    this.textEnabled = this.textGenerator !== undefined;
    this.imageEnabled = this.imageGenerator !== undefined;

    if (options.workspace !== undefined) {
      this.workspace = options.workspace;
    } else {
      this.workspace = new PackWorkspace({
        registry: options.registry,
        ...(options.dir !== undefined ? { dir: options.dir } : {}),
        log: this.log,
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.workspaceOptions ?? {}),
      });
    }
  }

  /** `map.generate`：结构（AI→校验→程序化）+ 可选底图。 */
  async generateMap(params: MapGenerateParams): Promise<MapGenerateResult> {
    const outcome = await generateBattleMap({
      prompt: params.prompt,
      style: params.style,
      ...(params.cols !== undefined ? { cols: params.cols } : {}),
      ...(params.rows !== undefined ? { rows: params.rows } : {}),
      ...(params.partySize !== undefined ? { partySize: params.partySize } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(this.textGenerator !== undefined ? { textGenerator: this.textGenerator } : {}),
    });
    const warnings = [...outcome.warnings];
    let background: MapGenerateResult['background'] = null;
    if (params.withBackground === true) {
      const prompt = buildBattleBackgroundPrompt({
        prompt: params.prompt,
        style: params.style,
        structure: outcome.structure,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
      });
      const generated = await generateMapBackground({
        kind: 'battle-map',
        prompt,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(this.imageGenerator !== undefined ? { imageGenerator: this.imageGenerator } : {}),
      });
      background = generated.background;
      warnings.push(...generated.warnings);
    }
    return { structure: outcome.structure, warnings, method: outcome.method, background };
  }

  /** `world.generate`：区域结构（AI→校验→程序化）+ 可选底图。 */
  async generateWorld(params: WorldGenerateParams): Promise<WorldGenerateResult> {
    const outcome = await generateWorldMap({
      prompt: params.prompt,
      ...(params.zoneCount !== undefined ? { zoneCount: params.zoneCount } : {}),
      ...(params.style !== undefined ? { style: params.style } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(this.textGenerator !== undefined ? { textGenerator: this.textGenerator } : {}),
    });
    const warnings = [...outcome.warnings];
    let background: WorldGenerateResult['background'] = null;
    if (params.withBackground === true) {
      const prompt = buildWorldBackgroundPrompt({
        prompt: params.prompt,
        world: outcome.world,
        ...(params.style !== undefined ? { style: params.style } : {}),
      });
      const generated = await generateMapBackground({
        kind: 'world-map',
        prompt,
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(this.imageGenerator !== undefined ? { imageGenerator: this.imageGenerator } : {}),
      });
      background = generated.background;
      warnings.push(...generated.warnings);
    }
    return { world: outcome.world, warnings, method: outcome.method, background };
  }

  packDetail(params: PackDetailParams): PackDetailResult {
    return this.workspace.detail(params);
  }

  packUpdate(params: PackUpdateParams): Promise<PackUpdateResult> {
    return this.workspace.update(params);
  }

  packExport(params: PackExportParams): PackExportResult {
    return this.workspace.exportPack(params);
  }

  packImport(params: PackImportParams): Promise<PackImportResult> {
    return this.workspace.importPack(params);
  }

  packAssetPut(params: PackAssetPutParams): Promise<PackAssetPutResult> {
    return this.workspace.assetPut(params);
  }

  packAssetDelete(params: PackAssetDeleteParams): Promise<PackAssetDeleteResult> {
    return this.workspace.assetDelete(params);
  }
}

/** host `index.ts` 的接线入口。 */
export function createStudio(options: StudioOptions): Studio {
  return new Studio(options);
}

/** 数据目录是否已存在（host 启动日志/诊断用）。 */
export function packsDirExists(dir: string): boolean {
  return existsSync(dir);
}

export {
  PackWorkspace,
  type PackWorkspaceOptions,
} from './pack-workspace.ts';
export {
  generateBattleMap,
  generateWorldMap,
  proceduralBattleStructure,
  proceduralWorldStructure,
  validateBattleStructure,
  validateWorldStructure,
  parseBattleDraft,
  parseWorldDraft,
  buildBattleDraftPrompt,
  buildWorldDraftPrompt,
  summarizeBattleStructure,
  summarizeWorldStructure,
  type BattleDraftInput,
  type BattleGenerateOptions,
  type BattleGenerationOutcome,
  type StudioTextGenerator,
  type StudioTextRequest,
  type StructureValidationReport,
  type WorldDraftInput,
  type WorldGenerateOptions,
  type WorldGenerationOutcome,
} from './map-generator.ts';
export {
  buildBattleBackgroundPrompt,
  buildWorldBackgroundPrompt,
  generateMapBackground,
  BACKGROUND_MAX_BYTES,
  type BackgroundOutcome,
  type StudioImageGenerator,
  type StudioImageOutput,
  type StudioImageRequest,
} from './background.ts';
