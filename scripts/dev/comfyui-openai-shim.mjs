#!/usr/bin/env node
/**
 * M9.5c 开发用 ComfyUI → OpenAI 协议 shim（**仅用于本机联调，不进插件产物**）。
 *
 * 作用：让工坊「AI 生图」按 OpenAI 兼容协议（`POST /v1/images/generations`，`b64_json` 返回）
 * 直接打到本机 ComfyUI，从而在不改插件代码的情况下跑通「生成 → 归一化 → 预览 → 落盘」。
 * 协议约定见 `packages/assets/src/openai-shim/README.md`；映射逻辑在 `./shim-core.mjs`（可单测）。
 *
 * 用法见 `scripts/dev/README.md`。常用：
 *   node scripts/dev/comfyui-openai-shim.mjs --fake
 *   node scripts/dev/comfyui-openai-shim.mjs --workflow scripts/dev/workflows/sdxl-txt2img.json \
 *        --comfyui http://127.0.0.1:8188
 *
 * 安全（README §4）：默认只绑 127.0.0.1，**拒绝监听 0.0.0.0**；不校验 Authorization；零 npm 依赖。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_CLIENT_TIMEOUT_MS,
  DEFAULT_COMFYUI_URL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SHIM_HOST,
  DEFAULT_SHIM_PORT,
  ShimError,
  buildChatCompletion,
  buildImagePlan,
  buildImagesResponse,
  extractFirstImage,
  fakePng,
  fakeSvg,
  fillWorkflowTemplate,
} from './shim-core.mjs';

/** 内置默认模板占位：ComfyUI 自带的 SD1.5 文生图 API 工作流（节点 id 与官方默认图一致）。 */
export const DEFAULT_WORKFLOW_TEMPLATE = Object.freeze({
  '3': {
    class_type: 'KSampler',
    inputs: { seed: 0, steps: 24, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-trpg-shim', images: ['8', 0] } },
});

const LOG_PREFIX = '[shim]';
const REQUEST_BODY_LIMIT = 1024 * 1024;

/** @param {string} message */
function log(message) {
  // 只输出到 stderr：stdout 留给可能的管道使用
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 解析命令行参数；`--help` 时打印用法并退出。 */
export function parseArgs(argv) {
  const options = {
    host: process.env.SHIM_HOST ?? DEFAULT_SHIM_HOST,
    port: Number.parseInt(process.env.SHIM_PORT ?? String(DEFAULT_SHIM_PORT), 10),
    comfyui: process.env.COMFYUI_BASE_URL ?? DEFAULT_COMFYUI_URL,
    workflow: undefined,
    checkpoint: process.env.COMFYUI_CHECKPOINT ?? undefined,
    fake: false,
    fakeSvg: false,
    pollTimeoutMs: Number.parseInt(process.env.SHIM_POLL_TIMEOUT_MS ?? String(DEFAULT_POLL_TIMEOUT_MS), 10),
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    modelWorkflows: [],
    defaultModel: DEFAULT_IMAGE_MODEL,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} 需要一个参数值`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--host':
        options.host = next();
        break;
      case '--port':
        options.port = Number.parseInt(next(), 10);
        break;
      case '--comfyui':
        options.comfyui = next();
        break;
      case '--workflow':
        options.workflow = next();
        break;
      case '--checkpoint':
        options.checkpoint = next();
        break;
      case '--model-workflow': {
        const value = next();
        const separator = value.indexOf('=');
        if (separator <= 0) throw new Error('--model-workflow 格式应为 <model>=<工作流 JSON 路径>');
        options.modelWorkflows.push({ model: value.slice(0, separator), file: value.slice(separator + 1), workflow: undefined });
        break;
      }
      case '--default-model':
        options.defaultModel = next();
        break;
      case '--poll-timeout-ms':
        options.pollTimeoutMs = Number.parseInt(next(), 10);
        break;
      case '--poll-interval-ms':
        options.pollIntervalMs = Number.parseInt(next(), 10);
        break;
      case '--fake':
        options.fake = true;
        break;
      case '--fake-svg':
        options.fakeSvg = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

const USAGE = `用法: node scripts/dev/comfyui-openai-shim.mjs [选项]

  --fake                    不连 ComfyUI，直接按 seed 返回确定性 PNG（联调整条链路用）
  --fake-svg                实现 POST /v1/chat/completions，返回合法的 128×128 SVG（SVG 管线联调）
  --comfyui <url>           ComfyUI 地址（默认 ${DEFAULT_COMFYUI_URL} 或 COMFYUI_BASE_URL）
  --workflow <file>         默认 ComfyUI API 格式工作流 JSON（不给则用内置 SD1.5 模板占位）
  --model-workflow a=b.json 可选：按 OpenAI model 名映射到不同工作流（可重复）
  --checkpoint <name>       覆盖 CheckpointLoaderSimple.ckpt_name
  --host / --port           监听地址/端口（默认 ${DEFAULT_SHIM_HOST}:${DEFAULT_SHIM_PORT}；拒绝非 loopback）
  --poll-timeout-ms <n>     轮询 /history 上限（默认 ${DEFAULT_POLL_TIMEOUT_MS}，必须小于客户端 120s）
  --help                    显示本用法

只用于本机开发：不进 pnpm pack:plugin 产物、不实现鉴权、绝不监听 0.0.0.0。`;

/** 读出工作流 JSON（文件路径 → 对象）；读失败给中文可读错误。 */
function loadWorkflowFile(filePath) {
  let text;
  try {
    text = readFileSync(resolve(filePath), 'utf8');
  } catch (error) {
    throw new Error(`读取工作流失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`工作流不是合法 JSON：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!isRecord(data)) throw new Error(`工作流必须是 ComfyUI API 格式的 JSON 对象：${filePath}`);
  return data;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > REQUEST_BODY_LIMIT) throw new ShimError(413, 'body_too_large', '请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new ShimError(400, 'invalid_json', `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

function sendError(response, error) {
  if (error instanceof ShimError) {
    sendJson(response, error.status, {
      error: { message: error.message, type: error.type, code: error.code },
    });
    return;
  }
  log(`未处理错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  sendJson(response, 500, {
    error: { message: `shim 内部错误：${error instanceof Error ? error.message : String(error)}`, type: 'server_error', code: 'internal' },
  });
}

// ---------------------------------------------------------------------------
// ComfyUI HTTP 客户端（只用全局 fetch）
// ---------------------------------------------------------------------------

async function comfyFetchJson(url, init, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ShimError(
      502,
      'comfyui_unreachable',
      `ComfyUI 未启动：无法连接 ${url}（${error instanceof Error ? error.message : String(error)}）`,
      'upstream_error',
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ShimError(502, 'comfyui_error', `ComfyUI 返回 HTTP ${response.status}：${text.slice(0, 300)}`, 'upstream_error');
  }
  try {
    return await response.json();
  } catch {
    throw new ShimError(502, 'comfyui_bad_json', 'ComfyUI 返回的不是合法 JSON', 'upstream_error');
  }
}

/** 提交工作流到 ComfyUI `/prompt`，返回 prompt_id。 */
export async function submitWorkflow(comfyui, workflow, options = {}) {
  const base = comfyui.replace(/\/+$/u, '');
  const result = await comfyFetchJson(
    `${base}/prompt`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: options.clientId ?? 'dsh-trpg-shim' }),
    },
    options.timeoutMs ?? 15_000,
  );
  if (!isRecord(result) || typeof result.prompt_id !== 'string' || result.prompt_id.length === 0) {
    throw new ShimError(502, 'comfyui_bad_response', `ComfyUI /prompt 没有返回 prompt_id：${JSON.stringify(result).slice(0, 300)}`, 'upstream_error');
  }
  return result.prompt_id;
}

/** 轮询 `/history/<prompt_id>` 直到有输出图；超时给 504 中文错误。 */
export async function waitForImage(comfyui, promptId, options = {}) {
  const base = comfyui.replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const startedAt = Date.now();
  for (;;) {
    const history = await comfyFetchJson(`${base}/history/${encodeURIComponent(promptId)}`, {}, 15_000);
    if (isRecord(history)) {
      const entry = history[promptId];
      if (isRecord(entry)) {
        const image = extractFirstImage(entry);
        if (image !== undefined) return image;
        const status = isRecord(entry.status) ? entry.status : undefined;
        if (status?.completed === true && status?.status_str !== 'error') {
          throw new ShimError(
            500,
            'no_image',
            'ComfyUI 执行完成但没有图片输出（工作流缺少 SaveImage/PreviewImage？）',
            'upstream_error',
          );
        }
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new ShimError(
        504,
        'comfyui_timeout',
        `等待 ComfyUI 出图超时（已等 ${timeoutMs}ms，prompt_id=${promptId}）；请检查 ComfyUI 执行队列或调大 --poll-timeout-ms`,
        'upstream_error',
      );
    }
    await sleep(intervalMs);
  }
}

/** 用 `/view` 取图片字节。 */
export async function fetchImageBytes(comfyui, image, options = {}) {
  const base = comfyui.replace(/\/+$/u, '');
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  let response;
  try {
    response = await fetch(`${base}/view?${query.toString()}`, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
  } catch (error) {
    throw new ShimError(
      502,
      'comfyui_unreachable',
      `ComfyUI 未启动：无法取图 ${base}/view（${error instanceof Error ? error.message : String(error)}）`,
      'upstream_error',
    );
  }
  if (!response.ok) {
    throw new ShimError(502, 'comfyui_error', `ComfyUI /view 返回 HTTP ${response.status}`, 'upstream_error');
  }
  return new Uint8Array(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// 服务端
// ---------------------------------------------------------------------------

/**
 * 创建 shim HTTP 服务（不 listen；测试与 main 共用）。
 * @param {object} [config] fake / fakeSvg / comfyui / checkpoint / defaultModel / defaultWorkflow /
 *   modelWorkflows / pollTimeoutMs / pollIntervalMs
 */
export function createShimServer(config = {}) {
  const fake = config.fake === true;
  const fakeSvgEnabled = config.fakeSvg === true;
  const comfyui = config.comfyui ?? DEFAULT_COMFYUI_URL;
  const defaultModel = config.defaultModel ?? DEFAULT_IMAGE_MODEL;
  const defaultWorkflow = config.defaultWorkflow ?? DEFAULT_WORKFLOW_TEMPLATE;
  const modelWorkflows = config.modelWorkflows ?? [];
  const pollTimeoutMs = config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let comfyHealthy;
  let comfyHealthyAt = 0;

  const workflowFor = (model) => {
    const mapped = modelWorkflows.find((item) => item.model === model);
    return mapped?.workflow ?? defaultWorkflow;
  };
  // 配了 model→工作流映射时收紧 model 白名单（默认 model 始终可用，走默认工作流）
  const knownModels =
    modelWorkflows.length > 0
      ? [...new Set([defaultModel, ...modelWorkflows.map((item) => item.model)])]
      : [];

  async function checkComfyHealth() {
    if (fake) return { ok: true, fake: true, url: comfyui, note: '--fake 模式不连 ComfyUI' };
    const now = Date.now();
    if (comfyHealthy !== undefined && now - comfyHealthyAt < 3000) return comfyHealthy;
    try {
      const base = comfyui.replace(/\/+$/u, '');
      const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2000) });
      comfyHealthy = { ok: response.ok, url: comfyui, status: response.status };
    } catch (error) {
      comfyHealthy = { ok: false, url: comfyui, error: error instanceof Error ? error.message : String(error) };
    }
    comfyHealthyAt = now;
    return comfyHealthy;
  }

  async function generateImages(body) {
    const plan = buildImagePlan(body, {
      defaultModel,
      ...(isNonEmptyString(config.checkpoint) ? { checkpoint: config.checkpoint } : {}),
      ...(knownModels.length > 0 ? { knownModels } : {}),
    });
    if (fake) {
      return buildImagesResponse(
        plan.seeds.map((seed) => ({ bytes: fakePng({ width: plan.width, height: plan.height, seed }), seed })),
        { model: plan.model },
      );
    }
    const template = workflowFor(plan.model);
    const images = [];
    for (const seed of plan.seeds) {
      const workflow = fillWorkflowTemplate(template, plan, seed);
      const promptId = await submitWorkflow(comfyui, workflow, { timeoutMs: 15_000 });
      const image = await waitForImage(comfyui, promptId, { timeoutMs: pollTimeoutMs, intervalMs: pollIntervalMs });
      const bytes = await fetchImageBytes(comfyui, image, { timeoutMs: DEFAULT_CLIENT_TIMEOUT_MS });
      images.push({ bytes, seed });
    }
    return buildImagesResponse(images, { model: plan.model });
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      try {
        if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
          const comfy = await checkComfyHealth();
          sendJson(response, 200, {
            ok: true,
            mode: fake ? 'fake' : 'comfyui',
            fakeSvg: fakeSvgEnabled,
            comfyui: comfy,
            defaultModel,
            models: knownModels,
            uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          });
          return;
        }
        if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
          const body = await readJsonBody(request);
          sendJson(response, 200, await generateImages(body));
          return;
        }
        if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
          const body = await readJsonBody(request);
          if (!fakeSvgEnabled) {
            throw new ShimError(
              404,
              'not_implemented',
              '本次 shim 未启用 /v1/chat/completions（SVG 管线联调请加 --fake-svg 启动）',
              'invalid_request_error',
            );
          }
          const seed = typeof body?.seed === 'number' ? body.seed : 0;
          const prompt =
            (Array.isArray(body?.messages) ? body.messages : [])
              .filter((message) => isRecord(message) && typeof message.content === 'string')
              .map((message) => message.content)
              .join('\n') || '';
          const svg = fakeSvg({ seed, prompt });
          sendJson(response, 200, buildChatCompletion({ svg, seed, model: isNonEmptyString(body?.model) ? body.model : 'shim-fake-svg' }));
          return;
        }
        sendJson(response, 404, {
          error: { message: `shim 未实现该端点：${request.method} ${url.pathname}`, type: 'invalid_request_error', code: 'not_found' },
        });
      } catch (error) {
        sendError(response, error);
      }
    })();
  });

  return { server, config: { fake, fakeSvg: fakeSvgEnabled, comfyui, defaultModel, pollTimeoutMs, pollIntervalMs } };
}

/** CLI 入口。 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!LOOPBACK_HOSTS.has(options.host)) {
    throw new Error(`为了安全，shim 只允许监听 loopback（127.0.0.1 / localhost / ::1），拒绝：${options.host}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`端口非法：${options.port}`);
  }
  const defaultWorkflow = isNonEmptyString(options.workflow) ? loadWorkflowFile(options.workflow) : DEFAULT_WORKFLOW_TEMPLATE;
  const modelWorkflows = options.modelWorkflows.map((item) => ({
    model: item.model,
    workflow: loadWorkflowFile(item.file),
  }));
  const { server } = createShimServer({
    fake: options.fake,
    fakeSvg: options.fakeSvg,
    comfyui: options.comfyui,
    ...(options.checkpoint !== undefined ? { checkpoint: options.checkpoint } : {}),
    defaultModel: options.defaultModel,
    defaultWorkflow,
    modelWorkflows,
    pollTimeoutMs: options.pollTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(new Error(`监听 ${options.host}:${options.port} 失败：${error.message}`));
    server.once('error', onError);
    server.listen(options.port, options.host, () => {
      server.off('error', onError);
      resolvePromise(undefined);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  log(`listening on http://${options.host}:${port}（mode=${options.fake ? 'fake' : 'comfyui'}${options.fakeSvg ? ', fake-svg' : ''}）`);
  if (options.fake) {
    log('--fake：不连 ComfyUI，POST /v1/images/generations 返回确定性 PNG');
  } else {
    log(`ComfyUI: ${options.comfyui}（工作流：${isNonEmptyString(options.workflow) ? options.workflow : '内置 SD1.5 模板占位'}）`);
  }
  log(`工坊配置：baseUrl=http://${options.host}:${port}, apiKey=dev, imageModel=${options.defaultModel}`);

  const shutdown = () => {
    log('收到退出信号，关闭服务');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const entryPath = process.argv[1];
const isMain = entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${LOG_PREFIX} 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
