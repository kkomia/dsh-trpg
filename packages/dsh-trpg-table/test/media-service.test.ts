/**
 * M9.5d 生图服务（MediaService）：配置/限流/归一化标准档/fake 注入/中文错误。
 *
 * 全部离线：OpenAI 兼容接口用注入的 fake fetch（`FetchLike`），不发起真实网络请求；
 * fake 生成器（`DSH_TRPG_MEDIA_FAKE=1` / `--fake`）产确定性 PNG/SVG。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomError } from '@dsh-trpg/rooms';
import type { AssetsGenerateParams } from '@dsh-trpg/protocol';
import {
  MediaService,
  buildMediaPrompt,
  createFakeMediaGenerator,
  fakeMediaPng,
  fakeMediaSvg,
  mediaRenderPlan,
  type MediaServiceOptions,
} from '../src/host/media/index.ts';
import type { FetchInit, FetchLike, FetchResponseLike } from '../../assets/src/index.ts';

const PNG = fakeMediaPng(0);
const PNG_B64 = Buffer.from(PNG).toString('base64');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface RecordedFetch {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: FetchInit; body: Record<string, unknown> }>;
}

/** 假 fetch：记录请求并按 handler 返回响应。 */
function makeFetch(handler: (url: string, body: Record<string, unknown>) => { status?: number; body: unknown }): RecordedFetch {
  const calls: RecordedFetch['calls'] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body.length > 0 ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, init, body });
    const result = handler(url, body);
    const text = JSON.stringify(result.body);
    const response: FetchResponseLike = {
      ok: (result.status ?? 200) >= 200 && (result.status ?? 200) < 300,
      status: result.status ?? 200,
      text: async () => text,
    };
    return response;
  };
  return { fetchImpl, calls };
}

function fakeService(overrides: MediaServiceOptions = {}): MediaService {
  return new MediaService({ generator: createFakeMediaGenerator(), ...overrides });
}

const AVATAR_PARAMS: AssetsGenerateParams = { kind: 'avatar', style: 'game-2d', prompt: '青衫少年，背长剑', subject: '阿青' };

test('MediaService: 未配置 baseUrl/生成器 → conflict + 可读中文错误（含环境变量名）', async () => {
  const service = new MediaService({ env: {} });
  assert.equal(service.configured(), false);
  await assert.rejects(
    () => service.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof RoomError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /生图服务未配置/);
      assert.match(error.message, /DSH_TRPG_OPENAI_BASE_URL/);
      assert.match(error.message, /DSH_TRPG_OPENAI_IMAGE_MODEL/);
      return true;
    },
  );
});

test('MediaService: fake 生成器（--fake 兼容）→ 头像候选归一化到 256×256，b64/sha256 可复算', async () => {
  const service = fakeService();
  assert.equal(service.configured(), true);
  const result = await service.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.format, 'png');
  assert.equal(candidate.width, 256);
  assert.equal(candidate.height, 256);
  assert.equal(candidate.style, 'game-2d');
  assert.match(candidate.prompt, /角色头像/);
  assert.match(candidate.prompt, /阿青/);
  const bytes = Buffer.from(candidate.b64, 'base64');
  assert.equal(sha256(new Uint8Array(bytes)), candidate.sha256, '候选 sha256 必须是归一化后字节的指纹');
  assert.equal(result.provider, 'fake');
  // 归一化后的 PNG 可以被再次归一化（说明是真 PNG）
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('MediaService: 标准档映射（portrait 768×1024 / sprite 512×512 帧表 / icon 32·128 / svg 128）', async () => {
  const service = fakeService({ rateLimit: { max: 100, windowMs: 60_000 } });
  const principal = { roomId: 'room-1', playerId: 'p1' };

  const portrait = await service.generate(principal, { kind: 'portrait', style: 'game-2d', prompt: '立绘' });
  assert.equal(portrait.candidates[0]?.width, 768);
  assert.equal(portrait.candidates[0]?.height, 1024);

  const sprite = await service.generate(principal, { kind: 'sprite', style: 'pixel-32', prompt: '走路帧' });
  assert.equal(sprite.candidates[0]?.width, 512);
  assert.equal(sprite.candidates[0]?.height, 512);
  assert.match(buildMediaPrompt({ kind: 'sprite', style: 'pixel-32', prompt: '走路帧' }), /4 行 × 4 列/);

  const pixelIcon = await service.generate(principal, { kind: 'icon', style: 'pixel-32', prompt: '横刀' });
  assert.equal(pixelIcon.candidates[0]?.width, 32);
  assert.equal(pixelIcon.candidates[0]?.height, 32);

  const gameIcon = await service.generate(principal, { kind: 'icon', style: 'game-2d', prompt: '横刀' });
  assert.equal(gameIcon.candidates[0]?.width, 128);
  assert.equal(gameIcon.candidates[0]?.height, 128);

  const svgIcon = await service.generate(principal, { kind: 'icon', style: 'svg', prompt: '横刀' });
  const svgCandidate = svgIcon.candidates[0]!;
  assert.equal(svgCandidate.format, 'svg');
  assert.equal(svgCandidate.width, 128);
  const svgText = Buffer.from(svgCandidate.b64, 'base64').toString('utf8');
  assert.match(svgText, /^<\?xml/);
  assert.match(svgText, /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(sha256(new TextEncoder().encode(svgText)), svgCandidate.sha256);
});

test('MediaService: style=svg 只支持 icon（头像/立绘/帧表 → bad-request 中文错误）', async () => {
  const service = fakeService();
  for (const kind of ['avatar', 'portrait', 'sprite'] as const) {
    await assert.rejects(
      () => service.generate({ roomId: 'room-1', playerId: 'p1' }, { kind, style: 'svg', prompt: 'x' }),
      (error: unknown) => {
        assert.ok(error instanceof RoomError);
        assert.equal(error.code, 'bad-request');
        assert.match(error.message, /svg 只支持 icon/);
        return true;
      },
    );
  }
  assert.equal(mediaRenderPlan('avatar', 'pixel-32').target, 'avatar-256');
  assert.equal(mediaRenderPlan('sprite', 'game-2d').target, 'spritesheet');
  assert.deepEqual(mediaRenderPlan('sprite', 'game-2d').sprite, { rows: 4, cols: 4, frameSize: 128 });
});

test('MediaService: 每玩家限流 3 次/分钟（第 4 次 conflict；别的玩家不受影响；可配）', async () => {
  const service = fakeService({ rateLimit: { max: 3, windowMs: 60_000 } });
  const player = { roomId: 'room-1', playerId: 'p1' };
  for (let index = 0; index < 3; index += 1) {
    await service.generate(player, AVATAR_PARAMS);
  }
  await assert.rejects(
    () => service.generate(player, AVATAR_PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof RoomError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /生成请求太频繁/);
      assert.match(error.message, /3 次/);
      return true;
    },
  );
  // 另一个玩家（以及另一个房间的同名 playerId）各自独立计数
  await service.generate({ roomId: 'room-1', playerId: 'p2' }, AVATAR_PARAMS);
  await service.generate({ roomId: 'room-2', playerId: 'p1' }, AVATAR_PARAMS);

  const two = fakeService({ rateLimit: { max: 2, windowMs: 60_000 } });
  await two.generate(player, AVATAR_PARAMS);
  await two.generate(player, AVATAR_PARAMS);
  await assert.rejects(() => two.generate(player, AVATAR_PARAMS), /生成请求太频繁/);
});

test('MediaService: count 候选数（1–4；服务端硬上限 4；同请求多候选 seed 递增）', async () => {
  const service = new MediaService({
    generator: fakeMediaGeneratorWithSeeds(),
    rateLimit: { max: 100, windowMs: 60_000 },
  });
  const principal = { roomId: 'room-1', playerId: 'p1' };
  const two = await service.generate(principal, { ...AVATAR_PARAMS, count: 2 });
  assert.equal(two.candidates.length, 2);
  assert.deepEqual(two.candidates.map((candidate) => candidate.seed), [9000, 9001]);
  const four = await service.generate(principal, { ...AVATAR_PARAMS, count: 4 });
  assert.equal(four.candidates.length, 4);
  const clamped = await service.generate(principal, { ...AVATAR_PARAMS, count: 10 });
  assert.equal(clamped.candidates.length, 4, '服务端硬上限 4');
  const byPlan = mediaRenderPlan('icon', 'svg');
  assert.equal(byPlan.target, 'icon-128');
});

function fakeMediaGeneratorWithSeeds() {
  return () => ({
    images: [0, 1, 2, 3].map((index) => ({ bytes: fakeMediaPng(index), seed: 9000 + index })),
    provider: 'fake',
  });
}

test('MediaService: OpenAI 兼容生图（mock fetch）→ 请求 n/size/response_format 正确，候选按标准档归一化', async () => {
  const recorded = makeFetch(() => ({ body: { data: [{ b64_json: PNG_B64 }], model: 'sd-xl' } }));
  const service = new MediaService({
    baseUrl: 'https://llm.example.com/v1',
    apiKey: 'sk-test',
    imageModel: 'sd-xl',
    fetchImpl: recorded.fetchImpl,
    env: {},
  });
  assert.equal(service.configured(), true);
  const result = await service.generate({ roomId: 'room-1', playerId: 'p1' }, { ...AVATAR_PARAMS, seed: 7 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.width, 256);
  assert.equal(result.candidates[0]?.seed, 7, '后端没回 seed 时用请求 seed');
  assert.equal(recorded.calls.length, 1);
  const call = recorded.calls[0]!;
  assert.equal(call.url, 'https://llm.example.com/v1/images/generations', 'baseUrl 末尾 /v1 自动剥离再拼');
  assert.equal(call.init.headers.authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'sd-xl');
  assert.equal(call.body.n, 1);
  assert.equal(call.body.size, '1024x1024');
  assert.equal(call.body.response_format, 'b64_json');
  assert.equal(call.body.seed, 7);
  assert.match(String(call.body.prompt), /阿青/);
  assert.match(result.provider ?? '', /openai-compat/);
});

test('MediaService: OpenAI 兼容 AI SVG（mock chat）→ 净化后 SVG 候选', async () => {
  const recorded = makeFetch(() => ({
    body: { model: 'svg-model', choices: [{ message: { role: 'assistant', content: fakeMediaSvg(1) } }] },
  }));
  const service = new MediaService({
    baseUrl: 'https://llm.example.com',
    apiKey: 'sk-test',
    imageModel: 'sd-xl',
    textModel: 'svg-model',
    fetchImpl: recorded.fetchImpl,
    env: {},
  });
  const result = await service.generate(
    { roomId: 'room-1', playerId: 'p1' },
    { kind: 'icon', style: 'svg', prompt: '横刀图标' },
  );
  assert.equal(result.candidates[0]?.format, 'svg');
  assert.equal(recorded.calls[0]?.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(recorded.calls[0]?.body.model, 'svg-model');
});

test('MediaService: 模型/网络错误与不合格候选 → conflict + 中文错误（不抛裸异常）', async () => {
  const network = new MediaService({
    baseUrl: 'https://llm.example.com',
    imageModel: 'sd-xl',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
    env: {},
    retries: 0,
  });
  await assert.rejects(
    () => network.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof RoomError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /生图服务暂时不可用/);
      return true;
    },
  );

  const unauthorized = new MediaService({
    baseUrl: 'https://llm.example.com',
    imageModel: 'sd-xl',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' }),
    env: {},
    retries: 0,
  });
  await assert.rejects(
    () => unauthorized.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS),
    /鉴权失败/,
  );

  const garbage = new MediaService({
    baseUrl: 'https://llm.example.com',
    imageModel: 'sd-xl',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('not-an-image').toString('base64') }] }),
    }),
    env: {},
  });
  await assert.rejects(
    () => garbage.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof RoomError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /都不合格/);
      return true;
    },
  );
});

test('MediaService: 环境变量配置（含 DSH_TRPG_MEDIA_FAKE=1 免配置）与缺模型的中文错误', async () => {
  const fakeEnv = new MediaService({ env: { DSH_TRPG_MEDIA_FAKE: '1' } });
  assert.equal(fakeEnv.configured(), true);
  const fakeResult = await fakeEnv.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS);
  assert.equal(fakeResult.provider, 'fake');

  const recorded = makeFetch(() => ({ body: { data: [{ b64_json: PNG_B64 }] } }));
  const envConfigured = new MediaService({
    env: {
      DSH_TRPG_OPENAI_BASE_URL: 'https://env.example.com',
      DSH_TRPG_OPENAI_API_KEY: 'sk-env',
      DSH_TRPG_OPENAI_IMAGE_MODEL: 'env-image',
    },
    fetchImpl: recorded.fetchImpl,
  });
  assert.equal(envConfigured.configured(), true);
  assert.equal(envConfigured.imageModel, 'env-image');
  await envConfigured.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS);
  assert.equal(recorded.calls[0]?.url, 'https://env.example.com/v1/images/generations');

  const noModel = new MediaService({ env: { DSH_TRPG_OPENAI_BASE_URL: 'https://env.example.com' }, fetchImpl: recorded.fetchImpl });
  await assert.rejects(
    () => noModel.generate({ roomId: 'room-1', playerId: 'p1' }, AVATAR_PARAMS),
    (error: unknown) => {
      assert.ok(error instanceof RoomError);
      assert.equal(error.code, 'conflict');
      assert.match(error.message, /imageModel/);
      return true;
    },
  );
});

test('MediaService: 限流配置可用环境变量覆盖（DSH_TRPG_MEDIA_RATE_MAX）', async () => {
  const service = new MediaService({ env: { DSH_TRPG_MEDIA_FAKE: '1', DSH_TRPG_MEDIA_RATE_MAX: '1' } });
  const player = { roomId: 'room-1', playerId: 'p1' };
  await service.generate(player, AVATAR_PARAMS);
  await assert.rejects(() => service.generate(player, AVATAR_PARAMS), /每 60 秒最多 1 次/);
});
