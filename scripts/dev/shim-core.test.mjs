/**
 * M9.5c dev shim 的单测（node --test；**不在七包测试 glob 里**，用
 * `node --test scripts/dev/*.test.mjs` 单独跑）。
 *
 * 覆盖：映射逻辑（size/prompt/seed/n/model/扩展参数）、工作流占位符与节点覆盖、
 * 响应拼装、--fake 确定性 PNG、--fake-svg、以及 shim HTTP 服务端到端（fake 模式，不需要 ComfyUI）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKFLOW_TEMPLATE,
  createShimServer,
} from './comfyui-openai-shim.mjs';
import {
  MAX_CANDIDATES,
  MAX_SEED,
  ShimError,
  buildChatCompletion,
  buildImagePlan,
  buildImagesResponse,
  extractFirstImage,
  fakePng,
  fakeSvg,
  fillWorkflowTemplate,
  normalizeSeed,
  parseSize,
  resolvePrompt,
  splitPrompt,
  SUPPORTED_SIZES,
} from './shim-core.mjs';

function expectShimError(fn, status, codePart) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ShimError, `应抛 ShimError，实际：${String(error)}`);
    assert.equal(error.status, status);
    if (codePart !== undefined) assert.ok(error.message.includes(codePart), `错误信息应包含「${codePart}」，实际：${error.message}`);
    return true;
  });
}

test('shim-core: parseSize 只接受三档，其它 400 且列出支持档位', () => {
  assert.deepEqual(parseSize('1024x1024'), { width: 1024, height: 1024, target: SUPPORTED_SIZES['1024x1024'].target });
  assert.equal(parseSize('512x512').width, 512);
  assert.deepEqual([parseSize('768x1024').width, parseSize('768x1024').height], [768, 1024]);
  assert.equal(parseSize(undefined).width, 1024, '缺省 1024x1024');
  assert.throws(
    () => parseSize('640x480'),
    (error) =>
      error instanceof ShimError &&
      error.status === 400 &&
      error.code === 'unsupported_size' &&
      error.message.includes('1024x1024') &&
      error.message.includes('512x512'),
  );
});

test('shim-core: 提示词拆分（Avoid 段 / 独立 negative_prompt 优先）', () => {
  assert.deepEqual(splitPrompt('一个图标\nAvoid：文字、水印、边框'), {
    positive: '一个图标',
    negative: '文字、水印、边框',
  });
  assert.deepEqual(splitPrompt('一个图标'), { positive: '一个图标', negative: '' });
  assert.deepEqual(splitPrompt('A\nAvoid: 文字'), { positive: 'A', negative: '文字' });

  assert.deepEqual(resolvePrompt({ prompt: '图标\nAvoid：文字' }), { positive: '图标', negative: '文字' });
  assert.deepEqual(resolvePrompt({ prompt: '图标\nAvoid：文字', negative_prompt: '水印' }), {
    positive: '图标',
    negative: '水印',
  });
});

test('shim-core: normalizeSeed / buildImagePlan 校验与映射', () => {
  assert.equal(normalizeSeed(42), 42);
  assert.equal(normalizeSeed(undefined, () => 0.5), Math.floor(0.5 * (MAX_SEED + 1)));
  expectShimError(() => normalizeSeed(-1), 400, 'seed');

  const plan = buildImagePlan({
    model: 'game-2d',
    prompt: '一个图标\nAvoid：文字',
    size: '512x512',
    n: 2,
    seed: 7,
    response_format: 'b64_json',
    steps: 20,
    cfg_scale: 6.5,
    sampler: 'euler_a',
    unknown_field: 'ignored',
  });
  assert.equal(plan.model, 'game-2d');
  assert.equal(plan.width, 512);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.seeds, [7, 8]);
  assert.equal(plan.negative, '文字');
  assert.equal(plan.steps, 20);
  assert.equal(plan.cfgScale, 6.5);
  assert.equal(plan.sampler, 'euler_a');

  expectShimError(() => buildImagePlan({ prompt: '' }), 400, 'prompt');
  expectShimError(() => buildImagePlan({ prompt: 'x', response_format: 'url' }), 400, 'b64_json');
  expectShimError(() => buildImagePlan({ prompt: 'x', n: MAX_CANDIDATES + 1 }), 400, 'n');
  expectShimError(() => buildImagePlan({ prompt: 'x', n: 1.5 }), 400, 'n');
  expectShimError(() => buildImagePlan({ prompt: 'x', size: '100x100' }), 400, '不支持');
  expectShimError(
    () => buildImagePlan({ prompt: 'x', model: 'unknown' }, { knownModels: ['sd-xl', 'pixel-32'] }),
    400,
    '未知 model',
  );
});

test('shim-core: fillWorkflowTemplate 占位符替换（不改模板、保留数字类型、可选参数缺省原样）', () => {
  const template = {
    '1': {
      class_type: 'CLIPTextEncode',
      inputs: { text: '{{prompt}}', clip: ['2', 1] },
    },
    '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '{{checkpoint}}' } },
    '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 10, cfg: 7 } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
    '5': { class_type: 'Note', inputs: { text: 'size {{width}}x{{height}} seed={{seed}}' } },
  };
  const snapshot = JSON.stringify(template);
  const plan = buildImagePlan({ prompt: '图标\nAvoid：文字', size: '1024x1024', seed: 123, steps: 30 }, {});
  const workflow = fillWorkflowTemplate(template, plan, 123);

  assert.equal(JSON.stringify(template), snapshot, '模板不能被修改（深拷贝）');
  assert.equal(workflow['1'].inputs.text, '图标');
  assert.equal(workflow['2'].inputs.ckpt_name, '{{checkpoint}}', '未提供的 checkpoint 保留原占位');
  assert.equal(workflow['3'].inputs.seed, 123, '整串占位替换为数字');
  assert.equal(workflow['4'].inputs.width, 1024);
  assert.equal(workflow['4'].inputs.height, 1024);
  assert.equal(workflow['5'].inputs.text, 'size 1024x1024 seed=123', '字符串内插值');
  // 模板里没写的可选参数不覆盖
  assert.equal(workflow['3'].inputs.cfg, 7);
});

test('shim-core: fillWorkflowTemplate 按 class_type 覆盖（内置模板路线：正向/负向/尺寸/seed/steps/cfg/sampler）', () => {
  const template = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW_TEMPLATE));
  const plan = buildImagePlan({
    prompt: '图标\nAvoid：文字',
    size: '768x1024',
    seed: 99,
    steps: 28,
    cfg_scale: 5,
    sampler: 'dpmpp_2m',
  });
  const workflow = fillWorkflowTemplate(template, plan, 99);
  const nodes = Object.values(workflow);
  const encoder = nodes.filter((node) => node.class_type === 'CLIPTextEncode');
  assert.equal(encoder.length, 2);
  assert.equal(encoder[0].inputs.text, '图标', '第一个 CLIPTextEncode 收正向');
  assert.equal(encoder[1].inputs.text, '文字', '第二个收负向');
  const latent = nodes.find((node) => node.class_type === 'EmptyLatentImage');
  assert.deepEqual([latent.inputs.width, latent.inputs.height, latent.inputs.batch_size], [768, 1024, 1]);
  const sampler = nodes.find((node) => node.class_type === 'KSampler');
  assert.deepEqual([sampler.inputs.seed, sampler.inputs.steps, sampler.inputs.cfg, sampler.inputs.sampler_name], [
    99,
    28,
    5,
    'dpmpp_2m',
  ]);
  assert.equal(JSON.stringify(template), JSON.stringify(DEFAULT_WORKFLOW_TEMPLATE), '默认模板常量不可被污染');
});

test('shim-core: extractFirstImage / buildImagesResponse / buildChatCompletion', () => {
  const history = {
    status: { status_str: 'success', completed: true },
    outputs: {
      '9': { images: [{ filename: 'dsh_00001_.png', subfolder: '', type: 'output' }] },
    },
  };
  assert.deepEqual(extractFirstImage(history), { filename: 'dsh_00001_.png', subfolder: '', type: 'output' });
  assert.equal(extractFirstImage({ outputs: {} }), undefined);
  assert.throws(
    () => extractFirstImage({ status: { status_str: 'error' } }),
    (error) => error instanceof ShimError && error.status === 500,
  );

  const png = fakePng({ width: 8, height: 8, seed: 1 });
  const response = buildImagesResponse([{ bytes: png, seed: 11 }], { model: 'sd-xl', created: 100 });
  assert.equal(response.created, 100);
  assert.equal(response.model, 'sd-xl');
  assert.equal(response.data.length, 1);
  assert.equal(response.data[0].seed, 11);
  assert.deepEqual(Buffer.from(response.data[0].b64_json, 'base64'), Buffer.from(png));
  assert.equal('url' in response.data[0], false, '禁止用 url 替代 b64_json');

  const chat = buildChatCompletion({ svg: '<svg/>', seed: 3, model: 'x' });
  assert.equal(chat.object, 'chat.completion');
  assert.equal(chat.choices[0].message.content, '<svg/>');
  assert.equal(chat.model, 'x');
});

test('shim-core: fakePng 确定性 + 最小合法 PNG（签名/IHDR 尺寸）', () => {
  const first = fakePng({ width: 32, height: 24, seed: 1234 });
  const second = fakePng({ width: 32, height: 24, seed: 1234 });
  const other = fakePng({ width: 32, height: 24, seed: 1235 });
  assert.deepEqual([...first], [...second], '同 seed 同字节');
  assert.notDeepEqual([...first], [...other], '不同 seed 不同像素');

  assert.deepEqual([...first.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 魔数');
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  assert.equal(view.getUint32(8, false), 13, '第一块是 13 字节 IHDR');
  assert.equal(new TextDecoder().decode(first.subarray(12, 16)), 'IHDR');
  assert.equal(view.getUint32(16, false), 32);
  assert.equal(view.getUint32(20, false), 24);
  assert.deepEqual([...first.slice(-12)], [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 'IEND 收尾');
});

test('shim-core: fakeSvg 确定性 + 合法 128×128 SVG（无 script/外链）', () => {
  const first = fakeSvg({ seed: 5, prompt: '<script>alert(1)</script>文字' });
  const second = fakeSvg({ seed: 5, prompt: '<script>alert(1)</script>文字' });
  assert.equal(first, second, '同 seed/prompt 同字节');
  assert.match(first, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 128 128">/);
  assert.match(first, /<\/svg>$/);
  assert.ok(!first.includes('<script'), 'prompt 里的尖括号要转义掉');
  assert.ok(!first.includes('href'), '不生成外链');
});

// ---------------------------------------------------------------------------
// HTTP 服务端到端（fake 模式，不需要 ComfyUI）
// ---------------------------------------------------------------------------

async function startFakeShim(options = {}) {
  const { server } = createShimServer({ fake: true, fakeSvg: true, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test('shim-server: GET /health → 200（fake 模式不连 ComfyUI）', async () => {
  const shim = await startFakeShim();
  try {
    const response = await fetch(`${shim.base}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'fake');
    assert.equal(body.fakeSvg, true);
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal((await fetch(`${shim.base}/healthz`)).status, 200);
  } finally {
    await shim.close();
  }
});

test('shim-server: POST /v1/images/generations → b64_json（n 候选逐张、seed 回读）', async () => {
  const shim = await startFakeShim();
  try {
    const response = await fetch(`${shim.base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev' },
      body: JSON.stringify({
        model: 'sd-xl',
        prompt: '像素风图标\nAvoid：文字、水印',
        size: '512x512',
        n: 2,
        seed: 100,
        response_format: 'b64_json',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.created, 'number');
    assert.equal(body.data.length, 2);
    assert.deepEqual(body.data.map((item) => item.seed), [100, 101]);
    for (const item of body.data) {
      const bytes = Buffer.from(item.b64_json, 'base64');
      assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.equal(bytes.readUInt32BE(16), 512, 'IHDR 宽度 = 请求 size');
      assert.equal(bytes.readUInt32BE(20), 512);
    }

    // 关掉 fake 之外的行为都一样：非法参数 → 400 + 中文 error.message（客户端能映射成可读提示）
    const badSize = await fetch(`${shim.base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', size: '100x100' }),
    });
    assert.equal(badSize.status, 400);
    const badBody = await badSize.json();
    assert.ok(badBody.error.message.includes('100x100'));
    assert.equal(badBody.error.code, 'unsupported_size');

    const badFormat = await fetch(`${shim.base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', response_format: 'url' }),
    });
    assert.equal(badFormat.status, 400);
    assert.equal((await badFormat.json()).error.code, 'unsupported_response_format');
  } finally {
    await shim.close();
  }
});

test('shim-server: --fake-svg 的 /v1/chat/completions 返回合法 SVG；未启用时 404 可读错误', async () => {
  const shim = await startFakeShim();
  try {
    const response = await fetch(`${shim.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-svg', messages: [{ role: 'user', content: '画一个图标' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const svg = body.choices[0].message.content;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 128 128">/);
    assert.match(svg, /<\/svg>$/);
  } finally {
    await shim.close();
  }

  const noSvg = await startFakeShim({ fakeSvg: false });
  try {
    const response = await fetch(`${noSvg.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.match(body.error.message, /fake-svg/);
  } finally {
    await noSvg.close();
  }
});

test('shim-server: 未知端点 404；不校验 Authorization（本地开发随便填）', async () => {
  const shim = await startFakeShim();
  try {
    const response = await fetch(`${shim.base}/v1/unknown`, { method: 'POST' });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error.message, /未实现/);

    const health = await fetch(`${shim.base}/health`, { headers: { authorization: 'Bearer whatever' } });
    assert.equal(health.status, 200);
  } finally {
    await shim.close();
  }
});
