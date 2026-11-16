/**
 * OpenAI 兼容客户端测试（全 mock，不读网络）：chat 剥围栏、images b64、超时/重试/错误映射、提示词模板。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendNegativePrompt,
  createOpenAICompatClient,
  NEGATIVE_PROMPT,
  normalizeBaseUrl,
  OpenAICompatClient,
  OpenAIClientError,
  PROMPT_TEMPLATES,
  promptAvatar,
  promptGame2dIcon,
  promptPixelIcon,
  promptPortrait,
  promptSvgIcon,
  renderPromptTemplate,
  stripMarkdownFences,
  type FetchInit,
  type FetchLike,
  type FetchResponseLike,
} from '../src/index.ts';

interface MockCall {
  url: string;
  init: FetchInit;
}

interface MockFetch {
  fetchImpl: FetchLike;
  calls: MockCall[];
}

function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function textResponse(text: string, status = 200): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function mockFetch(
  handler: (call: MockCall, index: number) => FetchResponseLike | Promise<FetchResponseLike>,
): MockFetch {
  const calls: MockCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const call: MockCall = { url, init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function client(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): OpenAICompatClient {
  return new OpenAICompatClient({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    textModel: 'gpt-4o-mini',
    imageModel: 'sd-xl',
    fetchImpl,
    ...overrides,
  });
}

function expectClientError(code: string, messagePart?: string): (error: unknown) => void {
  return (error: unknown) => {
    assert.ok(error instanceof OpenAIClientError, `应是 OpenAIClientError，实际：${String(error)}`);
    assert.equal(error.code, code);
    if (messagePart !== undefined) {
      assert.ok(
        error.message.includes(messagePart),
        `错误信息应包含「${messagePart}」，实际「${error.message}」`,
      );
    }
  };
}

/** assert.throws 的验证函数（必须返回 true）。 */
function configError(code: string, messagePart: string): (error: unknown) => true {
  return (error: unknown) => {
    expectClientError(code, messagePart)(error);
    return true;
  };
}

async function expectRejects(
  promise: Promise<unknown>,
  code: string,
  messagePart?: string,
): Promise<OpenAIClientError> {
  try {
    await promise;
  } catch (error) {
    expectClientError(code, messagePart)(error);
    return error as OpenAIClientError;
  }
  assert.fail('预期抛错但成功返回');
}

// ---------------------------------------------------------------------------
// chatText
// ---------------------------------------------------------------------------

test('openai chat：成功返回 content（含 usage/model）', async () => {
  const mock = mockFetch(() =>
    jsonResponse({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: '这是正文' } }],
      usage: { total_tokens: 12 },
    }),
  );
  const result = await client(mock.fetchImpl).chatText({ prompt: 'hi' });
  assert.equal(result.content, '这是正文');
  assert.equal(result.model, 'gpt-4o-mini');
  assert.deepEqual(result.usage, { total_tokens: 12 });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]!.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(mock.calls[0]!.init.headers.authorization, 'Bearer sk-test');
});

test('openai chat：剥离 Markdown 围栏与前后废话（SVG）', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="8" height="8"/></svg>';
  const mock = mockFetch(() =>
    jsonResponse({
      choices: [{ message: { content: `好的，给你：\n\`\`\`svg\n${svg}\n\`\`\`\n希望有用。` } }],
    }),
  );
  const result = await client(mock.fetchImpl).chatText({ prompt: '画图标' });
  assert.equal(result.content, svg);
});

test('openai chat：content 非字符串（多模态分段）拒绝', async () => {
  const mock = mockFetch(() =>
    jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'x' }] } }] }),
  );
  await expectRejects(client(mock.fetchImpl).chatText({ prompt: 'x' }), 'invalid-response', 'content');
});

test('openai chat：缺少 choices 拒绝', async () => {
  const mock = mockFetch(() => jsonResponse({ choices: [] }));
  await expectRejects(client(mock.fetchImpl).chatText({ prompt: 'x' }), 'invalid-response', 'choices');
});

test('openai chat：HTTP 401 → 中文鉴权错误、不重试', async () => {
  const mock = mockFetch(() => textResponse('{"error":{"message":"invalid api key"}}', 401));
  const error = await expectRejects(
    client(mock.fetchImpl).chatText({ prompt: 'x' }),
    'auth',
    'API Key',
  );
  assert.equal(error.status, 401);
  assert.equal(mock.calls.length, 1);
});

test('openai chat：HTTP 429 → 限流错误', async () => {
  const mock = mockFetch(() => textResponse('{"error":"rate"}', 429));
  await expectRejects(client(mock.fetchImpl).chatText({ prompt: 'x' }), 'rate-limit', '429');
  assert.equal(mock.calls.length, 1);
});

test('openai chat：HTTP 500 重试一次后失败', async () => {
  const mock = mockFetch(() => textResponse('boom', 500));
  await expectRejects(client(mock.fetchImpl).chatText({ prompt: 'x' }), 'server', '500');
  assert.equal(mock.calls.length, 2);
});

test('openai chat：网络错误重试一次后成功', async () => {
  const mock = mockFetch((_call, index) => {
    if (index === 0) throw new Error('ECONNREFUSED');
    return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
  });
  const result = await client(mock.fetchImpl).chatText({ prompt: 'x' });
  assert.equal(result.content, 'ok');
  assert.equal(mock.calls.length, 2);
});

test('openai chat：超时 → timeout 错误（不重试）', async () => {
  const mock = mockFetch(
    (call) =>
      new Promise<FetchResponseLike>((_resolve, reject) => {
        call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  const error = await expectRejects(
    client(mock.fetchImpl, { timeoutMs: 30 }).chatText({ prompt: 'x' }),
    'timeout',
    '超时',
  );
  assert.ok(error.message.includes('秒'));
  assert.equal(mock.calls.length, 1);
});

test('openai chat：响应不是合法 JSON → invalid-response', async () => {
  const mock = mockFetch(() => textResponse('<html>502</html>', 200));
  await expectRejects(
    client(mock.fetchImpl).chatText({ prompt: 'x' }),
    'invalid-response',
    'JSON',
  );
});

test('openai chat：请求体包含 model/messages/temperature/max_tokens', async () => {
  const mock = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
  await client(mock.fetchImpl).chatText({
    system: '你是图标设计师',
    prompt: '画一把刀',
    temperature: 0.3,
    maxTokens: 2048,
  });
  const body = JSON.parse(mock.calls[0]!.init.body) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    temperature: number;
    max_tokens: number;
  };
  assert.equal(body.model, 'gpt-4o-mini');
  assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user']);
  assert.equal(body.messages[1]!.content, '画一把刀');
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_tokens, 2048);
});

test('openai chat：未配置文本模型 → config 错误', async () => {
  const mock = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
  await expectRejects(
    client(mock.fetchImpl, { textModel: undefined }).chatText({ prompt: 'x' }),
    'config',
    'textModel',
  );
});

test('openai：运行环境无 fetch 且未注入 → no-fetch 中文错误', async () => {
  const globalObject = globalThis as { fetch?: unknown };
  const saved = globalObject.fetch;
  globalObject.fetch = undefined;
  try {
    const error = await expectRejects(
      new OpenAICompatClient({ baseUrl: 'https://api.example.com', textModel: 'm' }).chatText({
        prompt: 'x',
      }),
      'no-fetch',
      'fetchImpl',
    );
    assert.ok(error.message.includes('fetch'));
  } finally {
    globalObject.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// generateImage
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');

test('openai images：b64_json → bytes，回读 seed', async () => {
  const mock = mockFetch(() =>
    jsonResponse({ data: [{ b64_json: PNG_B64, seed: 42 }], model: 'sd-xl' }),
  );
  const result = await client(mock.fetchImpl).generateImage({ prompt: '一把刀', seed: 7 });
  assert.equal(result.images.length, 1);
  assert.deepEqual([...result.images[0]!.bytes], [...PNG_BYTES]);
  assert.equal(result.images[0]!.seed, 42);
  assert.equal(result.model, 'sd-xl');
  const body = JSON.parse(mock.calls[0]!.init.body) as Record<string, unknown>;
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.seed, 7);
  assert.equal(body.size, '1024x1024');
  assert.equal(body.n, 1);
  assert.equal(body.model, 'sd-xl');
});

test('openai images：n>1 多候选全部解析', async () => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: [
        { b64_json: PNG_B64 },
        { b64_json: Buffer.from([1, 2, 3]).toString('base64') },
      ],
    }),
  );
  const result = await client(mock.fetchImpl).generateImage({ prompt: 'x', n: 2 });
  assert.equal(result.images.length, 2);
  assert.deepEqual([...result.images[1]!.bytes], [1, 2, 3]);
});

test('openai images：只返回 url → 明确拒绝（不代抓外链）', async () => {
  const mock = mockFetch(() =>
    jsonResponse({ data: [{ url: 'https://cdn.example.com/a.png' }] }),
  );
  await expectRejects(
    client(mock.fetchImpl).generateImage({ prompt: 'x' }),
    'unsupported',
    '不代抓外链',
  );
});

test('openai images：b64_json 非法 Base64 → invalid-response', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [{ b64_json: '!!!not-base64!!!' }] }));
  await expectRejects(
    client(mock.fetchImpl).generateImage({ prompt: 'x' }),
    'invalid-response',
    'Base64',
  );
});

test('openai images：data 缺失 → invalid-response', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [] }));
  await expectRejects(
    client(mock.fetchImpl).generateImage({ prompt: 'x' }),
    'invalid-response',
    'data',
  );
});

test('openai images：negativePrompt 以 Avoid 段追加进 prompt', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await client(mock.fetchImpl).generateImage({
    prompt: '画一把刀',
    negativePrompt: '文字、水印',
  });
  const body = JSON.parse(mock.calls[0]!.init.body) as { prompt: string };
  assert.ok(body.prompt.includes('画一把刀'));
  assert.ok(body.prompt.includes('Avoid：文字、水印'));
});

test('openai images：extra.negative_prompt 独立透传（不重复拼进 prompt）', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await client(mock.fetchImpl).generateImage({
    prompt: '画一把刀',
    negativePrompt: '不应该出现',
    extra: { negative_prompt: '文字、水印', steps: 24, cfg_scale: 7 },
  });
  const body = JSON.parse(mock.calls[0]!.init.body) as Record<string, unknown>;
  assert.equal(body.prompt, '画一把刀');
  assert.equal(body.negative_prompt, '文字、水印');
  assert.equal(body.steps, 24);
  assert.equal(body.cfg_scale, 7);
  assert.equal(body.response_format, 'b64_json');
});

test('openai images：seed 透传 + 无 seed 返回时回读请求 seed', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const result = await client(mock.fetchImpl).generateImage({ prompt: 'x', seed: 1234, n: 1 });
  assert.equal(result.images[0]!.seed, 1234);
  const body = JSON.parse(mock.calls[0]!.init.body) as { seed: number };
  assert.equal(body.seed, 1234);
});

test('openai images：请求地址走 baseUrl 归一化后的 /v1/images/generations', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  const instance = new OpenAICompatClient({
    baseUrl: 'http://127.0.0.1:8188/v1/',
    apiKey: 'k',
    imageModel: 'sd-xl',
    fetchImpl: mock.fetchImpl,
  });
  await instance.generateImage({ prompt: 'x' });
  assert.equal(mock.calls[0]!.url, 'http://127.0.0.1:8188/v1/images/generations');
  assert.equal(instance.chatEndpoint, 'http://127.0.0.1:8188/v1/chat/completions');
  assert.equal(instance.imagesEndpoint, 'http://127.0.0.1:8188/v1/images/generations');
  assert.equal(mock.calls[0]!.init.headers.authorization, 'Bearer k');
  assert.equal(mock.calls[0]!.init.headers['content-type'], 'application/json');
});

test('openai images：空 prompt → config 错误', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [] }));
  await expectRejects(
    client(mock.fetchImpl).generateImage({ prompt: '  ' }),
    'config',
    'prompt',
  );
});

test('openai images：未配置 imageModel → config 错误', async () => {
  const mock = mockFetch(() => jsonResponse({ data: [{ b64_json: PNG_B64 }] }));
  await expectRejects(
    client(mock.fetchImpl, { imageModel: undefined }).generateImage({ prompt: 'x' }),
    'config',
    'imageModel',
  );
});

// ---------------------------------------------------------------------------
// 配置与工具函数
// ---------------------------------------------------------------------------

test('openai：配置校验（timeoutMs / retries / baseUrl）', () => {
  assert.throws(
    () => createOpenAICompatClient({ baseUrl: '' }),
    configError('config', 'baseUrl'),
  );
  assert.throws(
    () => createOpenAICompatClient({ baseUrl: 'ftp://x.example' }),
    configError('config', 'http'),
  );
  assert.throws(
    () => createOpenAICompatClient({ baseUrl: 'https://x.example', timeoutMs: 0 }),
    configError('config', 'timeoutMs'),
  );
  assert.throws(
    () => createOpenAICompatClient({ baseUrl: 'https://x.example', retries: 9 }),
    configError('config', 'retries'),
  );
});

test('openai：4xx 非鉴权错误映射为 http 且带状态码', async () => {
  const mock = mockFetch(() => textResponse('bad request', 400));
  const error = await expectRejects(
    client(mock.fetchImpl).chatText({ prompt: 'x' }),
    'http',
    '400',
  );
  assert.equal(error.status, 400);
});

test('openai：normalizeBaseUrl 去尾部 /v1 与 /', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com');
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com');
  assert.equal(normalizeBaseUrl('https://api.openai.com/'), 'https://api.openai.com');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8188'), 'http://127.0.0.1:8188');
});

test('openai：stripMarkdownFences 处理围栏/废话/纯文本', () => {
  assert.equal(stripMarkdownFences('```\nhello\n```'), 'hello');
  assert.equal(stripMarkdownFences('前言\n```svg\n<svg></svg>\n```\n后记'), '<svg></svg>');
  assert.equal(stripMarkdownFences('  纯文本  '), '纯文本');
  assert.equal(
    stripMarkdownFences('解释一下：<svg viewBox="0 0 1 1"></svg> 完毕'),
    '<svg viewBox="0 0 1 1"></svg>',
  );
});

test('openai：appendNegativePrompt 不重复追加', () => {
  const base = '画一把刀\nAvoid：文字';
  assert.equal(appendNegativePrompt(base, '文字'), base);
  assert.equal(appendNegativePrompt('画一把刀', ''), '画一把刀');
  assert.ok(appendNegativePrompt('画一把刀', '水印').includes('Avoid：水印'));
});

test('openai：提示词模板均替换四个变量、无残留占位符、含 Avoid', () => {
  const item = {
    name: '横刀',
    tags: ['锋利', '家传'],
    description: '刀脊有裂纹',
    artDirection: '像素风',
  };
  const prompts = [
    promptSvgIcon(item),
    promptPixelIcon(item),
    promptGame2dIcon(item),
    promptPortrait({ ...item, race: '人族', characterClass: '武者', level: 3, appearance: '黑衣' }),
    promptAvatar({ ...item, race: '人族', characterClass: '武者' }),
  ];
  for (const prompt of prompts) {
    assert.ok(!prompt.includes('{{'), `提示词残留占位符：${prompt.slice(0, 80)}`);
    assert.ok(prompt.includes('横刀'));
    assert.ok(prompt.includes('锋利'));
    assert.ok(prompt.includes('刀脊有裂纹'));
    assert.ok(prompt.includes('像素风'));
    assert.ok(prompt.includes('Avoid'), '所有生图提示词应带 Avoid 负向段');
  }
  assert.ok(prompts[0]!.includes('viewBox="0 0 128 128"'));
  assert.ok(prompts[1]!.includes('16-bit'));
  assert.ok(prompts[2]!.includes('512×512'));
});

test('openai：像素/2D 模板是不同风格的独立模板', () => {
  assert.notEqual(promptPixelIcon({ name: '刀' }), promptGame2dIcon({ name: '刀' }));
  assert.deepEqual(Object.keys(PROMPT_TEMPLATES).sort(), [
    'avatar',
    'game-2d',
    'pixel-32',
    'portrait',
    'svg',
  ]);
  assert.ok(promptPortrait({ name: '阿青' }).includes('768×1024'));
  assert.equal(promptAvatar({ name: '阿青' }).includes('{{'), false);
});

test('openai：renderPromptTemplate 缺省变量给中文占位', () => {
  const rendered = renderPromptTemplate('{{name}}/{{tags}}/{{description}}/{{artDirection}}');
  assert.ok(!rendered.includes('{{'));
  assert.ok(rendered.includes('（未命名主体）'));
  assert.ok(rendered.includes('（无标签）'));
  assert.ok(rendered.includes('（无描述）'));
});

test('openai：NEGATIVE_PROMPT 常量覆盖常见负向约束', () => {
  assert.ok(NEGATIVE_PROMPT.includes('文字'));
  assert.ok(NEGATIVE_PROMPT.includes('模糊'));
  assert.ok(NEGATIVE_PROMPT.includes('水印'));
});
