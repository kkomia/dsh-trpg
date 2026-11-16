/**
 * 房间服务的 HTTP/SSE 适配层（薄壳）：把 RoomService 映射成局域网可访问的接口。
 *
 * 端点：
 * - GET  /trpg/health               健康检查
 * - GET  /trpg/rooms                公开房间列表
 * - POST /trpg/rpc                  JSON-RPC 风格调用（token 认证）
 * - GET  /trpg/events?token&lastSeq SSE 事件流（断线重连补发）
 * - GET  /trpg/assets/<packId>/<assetPath>  host 只读资产（**无 token**，png/svg + ETag + immutable）
 * - GET  /trpg/room-assets/<roomId>/<sha256>.<ext>  房间资产（**无 token**，落座上传的展示图）
 *
 * 安全：room.create / host.session 只接受 loopback 请求（房主就坐在本机）；
 * 其余操作靠 token → principal 解析，客户端不能自称身份。
 * 资产端点是无鉴权只读：路径必须严格受限（无 `..` / 绝对路径 / 控制字符），只提供 png/svg，
 * 字节来自内容包注册表缓存（内容包安装 = 受信代码，见 RULES-MODEL §10）；
 * 房间资产端点只提供本房间内容寻址文件名（sha256.<ext>），字节来自 RoomAssetStore。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RoomError, RoomService, type Principal } from '@dsh-trpg/rooms';
import {
  encodeSseEvent,
  PROTOCOL_VERSION,
  validateAssetsGenerate,
  validateAssetsUpload,
  validateBindSession,
  validateCharacterAssetRefs,
  validateGmAward,
  validateGmNarrate,
  validateGmScene,
  validateGmSecret,
  validateRpcRequest,
  type AssetsGenerateResult,
  type AssetsUploadResult,
  type CatalogPack,
  type CharacterAssetRefInput,
  type RpcResponse,
  type RpcRequest,
} from '@dsh-trpg/protocol';
import type { MediaAssetsService, RoomAssetsStore } from './media/index.ts';

/** 只读资产的解析结果（host 注入，一般来自 `PackRegistry.assetOf`）。 */
export interface RoomAsset {
  bytes: Uint8Array;
  /** sha256(字节)：ETag 与客户端缓存 key。 */
  sha256: string;
}

export interface RoomHttpOptions {
  port: number;
  bindHost: string;
  log?: (message: string) => void;
  service?: RoomService;
  /** 把房间绑定到 DSH 会话（房主本机；host/index 注入实现）。 */
  bindSession?: (roomId: string, sessionId: string | null) => unknown | Promise<unknown>;
  /** 内容包脱敏目录（`content.list`，玩家可调、只读）。 */
  contentCatalog?: () => CatalogPack[];
  /** 重扫内容包（`content.reload`，仅 loopback + host token）。 */
  contentReload?: () => { packs: number; warnings: string[]; recoveredRooms?: number };
  /**
   * 只读资产解析（`GET /trpg/assets/<packId>/<assetPath>`，M9.5b）：
   * `assetPath` 是去掉 `assets/` 前缀的相对路径。未注入时资产端点一律 404。
   */
  assetOf?: (packId: string, assetPath: string) => RoomAsset | undefined;
  /**
   * 生图服务（M9.5d `assets.generate`）：未注入时返回可读中文错误（`conflict`），
   * 客户端据此引导玩家配置自备的 OpenAI 兼容接口。
   */
  media?: MediaAssetsService;
  /**
   * 房间资产存储（M9.5d `assets.upload` + `GET /trpg/room-assets/...` + 落座引用规范化）：
   * 未注入时上传返回可读中文错误，资产端点一律 404。
   */
  roomAssets?: RoomAssetsStore;
}

export interface RoomHttpServer {
  server: Server;
  service: RoomService;
  close: () => Promise<void>;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage, limitBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * RPC 请求体上限：`assets.upload` 允许 8 MiB 原始字节（base64 后约 10.7 MiB），
 * 这里给 12 MiB；其余方法继续在参数校验层限制（超限给中文错误）。
 */
const RPC_MAX_BODY_BYTES = 12 * 1024 * 1024;

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// ---------------------------------------------------------------------------
// M9.5b 只读资产端点（UI-CONTRACT §4.1）
// ---------------------------------------------------------------------------

const ASSET_URL_PREFIX = '/trpg/assets/';
/** v1 只提供 PNG/SVG（UI-CONTRACT §0 #6 / §4.1）。 */
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml',
};
/** 内容寻址 + immutable：换图即换 ETag/sha256，永不强刷（契约 §4.1/§4.3）。 */
const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** packId 规范（与内容包的 slug 规则一致）。 */
const ASSET_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type AssetPathParseResult =
  | { ok: true; packId: string; assetPath: string }
  | { ok: false; status: 403 | 404; message: string };

/**
 * 解析 `/trpg/assets/<packId>/<assetPath>`：先 URL 解码，再拒绝路径穿越 / 绝对路径 /
 * 反斜杠 / 控制字符 / 空段。403 = 路径越权，404 = 端点/路径缺失。
 */
function parseAssetRequestPath(rawPath: string): AssetPathParseResult {
  if (rawPath.length === 0) {
    return { ok: false, status: 404, message: '缺少资产路径（应为 GET /trpg/assets/<packId>/<assetPath>）' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, status: 403, message: '资产路径不是合法的 URL 编码' };
  }
  if (decoded.includes('\\')) return { ok: false, status: 403, message: '资产路径不允许使用反斜杠' };
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return { ok: false, status: 403, message: '资产路径包含控制字符，已拒绝' };
  if (decoded.startsWith('/')) return { ok: false, status: 403, message: '资产路径必须是相对路径（不能以 / 开头）' };
  const segments = decoded.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return { ok: false, status: 403, message: '资产路径包含非法路径段（空段 / . / ..），已拒绝' };
  }
  const packId = segments[0] ?? '';
  if (!ASSET_PACK_ID_PATTERN.test(packId)) {
    return { ok: false, status: 403, message: `packId 非法：${JSON.stringify(packId)}` };
  }
  if (segments.length < 2) return { ok: false, status: 404, message: '缺少资产路径' };
  return { ok: true, packId, assetPath: segments.slice(1).join('/') };
}

/** If-None-Match 匹配：接受短 ETag（sha256 前 16）、完整 sha256、以及 `*`。 */
function etagMatches(ifNoneMatch: string, sha256: string): boolean {
  const full = sha256.toLowerCase();
  const short = full.slice(0, 16);
  for (const candidate of ifNoneMatch.split(',')) {
    let token = candidate.trim();
    if (token === '*') return true;
    if (token.startsWith('W/')) token = token.slice(2).trim();
    if (token.startsWith('"')) token = token.slice(1);
    if (token.endsWith('"')) token = token.slice(0, -1);
    if (token === short || token === full) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// M9.5d 房间资产端点（UI-CONTRACT §4.1/§4.5）
// ---------------------------------------------------------------------------

const ROOM_ASSET_URL_PREFIX = '/trpg/room-assets/';
/** 房间 id：host 生成的 UUID，只允许 URL 安全字符（路径安全第一道闸）。 */
const ROOM_ASSET_ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 资产文件名：`<sha256>.<png|svg>`（内容寻址；不接受其他文件名/子目录）。 */
const ROOM_ASSET_SHA256_PATTERN = /^[0-9a-f]{64}$/;

type RoomAssetParseResult =
  | { ok: true; roomId: string; sha256: string; ext: 'png' | 'svg' }
  | { ok: false; status: 403 | 404; message: string };

/** 解析 `/trpg/room-assets/<roomId>/<sha256>.<ext>`：拒绝穿越/反斜杠/控制字符/多余路径段。 */
function parseRoomAssetRequestPath(rawPath: string): RoomAssetParseResult {
  if (rawPath.length === 0) {
    return { ok: false, status: 404, message: '缺少房间资产路径（应为 GET /trpg/room-assets/<roomId>/<sha256>.<ext>）' };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, status: 403, message: '房间资产路径不是合法的 URL 编码' };
  }
  if (decoded.includes('\\')) return { ok: false, status: 403, message: '房间资产路径不允许使用反斜杠' };
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return { ok: false, status: 403, message: '房间资产路径包含控制字符，已拒绝' };
  if (decoded.startsWith('/')) return { ok: false, status: 403, message: '房间资产路径必须是相对路径（不能以 / 开头）' };
  const segments = decoded.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return { ok: false, status: 403, message: '房间资产路径包含非法路径段（空段 / . / ..），已拒绝' };
  }
  if (segments.length !== 2) return { ok: false, status: 403, message: '房间资产路径必须形如 <roomId>/<sha256>.<ext>' };
  const [roomId = '', filename = ''] = segments;
  if (!ROOM_ASSET_ROOM_ID_PATTERN.test(roomId)) {
    return { ok: false, status: 403, message: `房间 id 非法：${JSON.stringify(roomId)}` };
  }
  const dot = filename.lastIndexOf('.');
  const sha256 = dot > 0 ? filename.slice(0, dot) : '';
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (!ROOM_ASSET_SHA256_PATTERN.test(sha256)) {
    return { ok: false, status: 403, message: '房间资产文件名必须是 64 位小写十六进制 sha256（形如 <sha256>.png）' };
  }
  if (ext !== 'png' && ext !== 'svg') {
    return { ok: false, status: 404, message: `房间资产类型不支持（v1 只提供 png / svg）：${filename}` };
  }
  return { ok: true, roomId, sha256, ext };
}

/** RPC 参数里的展示资产引用：先过协议校验，再由存储层换成 host 权威 URL（未知 sha 丢弃）。 */
function canonicalSeatParams(
  rawParams: unknown,
  roomId: string,
  store: RoomAssetsStore | undefined,
): unknown {
  if (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams)) return rawParams;
  const params = rawParams as { characterAssets?: unknown };
  if (params.characterAssets === undefined) return rawParams;
  const parsed = validateCharacterAssetRefs(params.characterAssets);
  if (!parsed.ok || parsed.value === undefined) {
    throw new RoomError('bad-request', parsed.error ?? 'characterAssets 非法');
  }
  const refs: CharacterAssetRefInput[] = store !== undefined
    ? store.canonicalizeRefs(roomId, parsed.value)
    : parsed.value;
  return { ...params, characterAssets: refs };
}

export function createRoomHttpServer(options: RoomHttpOptions): RoomHttpServer {
  const log = options.log ?? (() => {});
  const service = options.service ?? new RoomService();
  const startedAt = Date.now();

  const dispatch = async (request: IncomingMessage, rpc: RpcRequest): Promise<unknown> => {
    // 内容包目录：玩家可读的脱敏清单，不需要房间 token（建房前/大厅就要用）。
    if (rpc.method === 'content.list') {
      if (!options.contentCatalog) throw new RoomError('internal', '内容包注册表未就绪');
      return { packs: options.contentCatalog() };
    }
    if (rpc.method === 'content.reload') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以重扫内容包');
      if (!options.contentReload) throw new RoomError('internal', '内容包注册表未就绪');
      // loopback + host token：内容重扫会影响所有房间，只许房主触发。
      const hostPrincipal = service.login(rpc.token);
      if (hostPrincipal.kind !== 'host') throw new RoomError('forbidden', '只有房主可以重扫内容包');
      return options.contentReload();
    }
    if (rpc.method === 'room.create') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以创建房间');
      return service.createRoom(rpc.params);
    }
    if (rpc.method === 'room.join') {
      return service.join(rpc.params);
    }
    if (rpc.method === 'host.session') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以取回房间令牌');
      const roomId = (rpc.params as { roomId?: unknown } | undefined)?.roomId;
      if (typeof roomId !== 'string') throw new RoomError('bad-request', '缺少 roomId');
      const session = service.hostSession(roomId);
      return { ...session, roomId };
    }
    if (rpc.method === 'room.list') {
      return service.list();
    }
    if (rpc.method === 'room.closeAll') {
      if (!isLoopback(request)) throw new RoomError('forbidden', '只有房主本机可以清空房间');
      return service.closeAll();
    }

    const principal: Principal = service.login(rpc.token);
    const take = <T>(report: { ok: boolean; value?: T; error?: string }): T => {
      if (!report.ok || report.value === undefined) throw new RoomError('bad-request', report.error ?? '参数非法');
      return report.value;
    };
    const requireHost = (): void => {
      if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能执行该操作');
    };
    switch (rpc.method) {
      case 'room.state':
        return service.state(principal);
      case 'room.seat':
        // M9.5d：落座资产引用先过协议校验，再由 RoomAssetStore 换成 host 权威 URL（未知 sha 丢弃，不阻断落座）。
        return service.seat(principal, canonicalSeatParams(rpc.params, principal.roomId, options.roomAssets));
      case 'room.roll':
        return service.roll(principal, rpc.params);
      case 'room.say':
        return service.say(principal, rpc.params);
      case 'room.leave':
        return service.leave(principal);
      case 'room.kick':
        return service.kick(principal, rpc.params);
      case 'room.lock':
        return service.lock(principal, rpc.params);
      case 'room.bind': {
        requireHost();
        const params = take(validateBindSession(rpc.params));
        const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim().length > 0 ? params.sessionId.trim() : null;
        if (options.bindSession) return await options.bindSession(principal.roomId, sessionId);
        return { room: service.bindSession(principal.roomId, sessionId) };
      }
      case 'room.close': {
        requireHost();
        return service.closeRoom(principal.roomId);
      }
      case 'gm.narrate': {
        requireHost();
        const params = take(validateGmNarrate(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能发 GM 旁白');
        return { event: service.gmNarrate(principal.roomId, params.text) };
      }
      case 'gm.secret': {
        requireHost();
        const params = take(validateGmSecret(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能发私密信息');
        return { event: service.gmSecret(principal.roomId, params.playerId, params.text) };
      }
      case 'gm.scene': {
        requireHost();
        const params = take(validateGmScene(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能推进场景');
        return { event: service.gmScene(principal.roomId, params.sceneId, params.title) };
      }
      case 'gm.award': {
        requireHost();
        const params = take(validateGmAward(rpc.params));
        if (principal.kind !== 'host') throw new RoomError('forbidden', '只有房主能发奖励');
        return { event: service.gmAward(principal.roomId, params.playerId, { xp: params.xp, items: params.items, note: params.note }) };
      }
      // ---- M9.4 规则投影与命令（host 结算；读命令全桌可调，写命令由 rooms 校验行动者/权限） ----
      // 运行时事件 → SSE 的映射不在这一层：RuleRuntime 由 rooms 持有，运行时事件（turn/damage/
      // rules/error 等）在 rooms 的订阅里广播成 `combat/update` / `sheet/update` / `rules/error`，
      // 这里只把命令结果（投影 DTO + 中文错误）回包，保持 HTTP 适配层是薄壳。
      case 'sheet.get':
        return service.sheet(principal, rpc.params);
      case 'sheet.equip':
        return service.equip(principal, rpc.params);
      case 'sheet.unequip':
        return service.unequip(principal, rpc.params);
      case 'sheet.useItem':
        return service.useItem(principal, rpc.params);
      case 'combat.view':
        return service.combatView(principal);
      case 'combat.start':
        return service.startCombat(principal, rpc.params);
      case 'combat.useAction':
        return service.useAction(principal, rpc.params);
      case 'combat.move':
        return service.move(principal, rpc.params);
      case 'combat.endTurn':
        return service.endTurn(principal, rpc.params);
      case 'combat.rollCheck':
        return service.rollCheck(principal, rpc.params);
      case 'combat.end':
        return service.endCombat(principal, rpc.params);
      case 'worldmap.get':
        return service.worldMap(principal);
      // ---- M9.5d 玩家角色资产（玩家 + 房主；token → 房间成员身份） ----
      case 'assets.generate': {
        const params = take(validateAssetsGenerate(rpc.params));
        if (options.media === undefined) {
          throw new RoomError(
            'conflict',
            '生图服务未启用：房主可在 host 环境变量里配置 DSH_TRPG_OPENAI_BASE_URL / DSH_TRPG_OPENAI_API_KEY / '
              + 'DSH_TRPG_OPENAI_IMAGE_MODEL，或改用玩家自备的 OpenAI 兼容接口',
          );
        }
        const ownerId = principal.kind === 'player' ? principal.playerId : 'host';
        const result: AssetsGenerateResult = await options.media.generate(
          { roomId: principal.roomId, playerId: ownerId },
          params,
        );
        return result;
      }
      case 'assets.upload': {
        const params = take(validateAssetsUpload(rpc.params));
        if (options.roomAssets === undefined) {
          throw new RoomError('conflict', '房间资产存储未启用（host 未配置文件目录）：暂时不能上传展示资产');
        }
        const ownerId = principal.kind === 'player' ? principal.playerId : 'host';
        const result: AssetsUploadResult = options.roomAssets.store(principal.roomId, ownerId, params.assets);
        return result;
      }
      default:
        throw new RoomError('bad-request', `未知方法：${rpc.method}`);
    }
  };

  async function handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = await readJsonBody(request, RPC_MAX_BODY_BYTES);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : '请求体不是合法 JSON' },
      } satisfies RpcResponse);
      return;
    }
    const parsed = validateRpcRequest(body);
    if (!parsed.ok || !parsed.value) {
      sendJson(response, 200, {
        ok: false,
        error: { code: 'bad-request', message: parsed.error ?? 'RPC 请求非法' },
      } satisfies RpcResponse);
      return;
    }
    try {
      const result = await dispatch(request, parsed.value);
      sendJson(response, 200, { ok: true, result } satisfies RpcResponse);
    } catch (error) {
      if (error instanceof RoomError) {
        sendJson(response, 200, { ok: false, error: { code: error.code, message: error.message } } satisfies RpcResponse);
        return;
      }
      log(`rpc ${parsed.value.method} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(response, 500, {
        ok: false,
        error: { code: 'internal', message: '服务端内部错误' },
      } satisfies RpcResponse);
    }
  }

  function handleSse(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const token = url.searchParams.get('token') ?? undefined;
    let principal: Principal;
    try {
      principal = service.login(token);
    } catch {
      sendJson(response, 401, { ok: false, error: { code: 'unauthorized', message: '令牌无效' } });
      return;
    }
    const lastSeq = Number.parseInt(url.searchParams.get('lastSeq') ?? '0', 10);
    response.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 2000\n\n');

    const writeEvent = (event: Parameters<typeof encodeSseEvent>[0]): void => {
      try {
        response.write(encodeSseEvent(event));
        if ((event.payload as { close?: boolean } | null)?.close === true) response.end();
      } catch {
        /* 客户端已断开 */
      }
    };

    for (const event of service.eventsSince(principal, Number.isFinite(lastSeq) ? lastSeq : 0)) writeEvent(event);
    const unsubscribe = service.subscribe(principal, writeEvent);
    const heartbeat = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    request.on('error', cleanup);
  }

  /**
   * 只读资产：无 token、只允许 png/svg、immutable + ETag、If-None-Match → 304。
   * 路径非法/越权 → 403；包/资产不存在或类型不支持 → 404（全中文错误）。
   */
  function handleAsset(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const parsed = parseAssetRequestPath(url.pathname.slice(ASSET_URL_PREFIX.length));
    if (!parsed.ok) {
      sendJson(response, parsed.status, {
        ok: false,
        error: { code: parsed.status === 403 ? 'forbidden' : 'not-found', message: parsed.message },
      });
      return;
    }
    const { packId, assetPath } = parsed;
    const extension = assetPath.slice(assetPath.lastIndexOf('.') + 1).toLowerCase();
    const contentType = ASSET_CONTENT_TYPES[extension];
    if (contentType === undefined) {
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not-found', message: `资产类型不支持（v1 只提供 png / svg 图片资产）：${assetPath}` },
      });
      return;
    }
    let asset: RoomAsset | undefined;
    try {
      asset = options.assetOf?.(packId, assetPath);
    } catch (error) {
      log(`asset ${packId}/${assetPath} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(response, 500, { ok: false, error: { code: 'internal', message: '读取资产失败' } });
      return;
    }
    if (asset === undefined) {
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not-found', message: `资产不存在：${packId}/${assetPath}` },
      });
      return;
    }
    const etag = `"${asset.sha256.slice(0, 16)}"`;
    const headers = {
      ...CORS_HEADERS,
      etag,
      'cache-control': ASSET_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
    };
    const ifNoneMatch = request.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, asset.sha256)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      'content-type': contentType,
      'content-length': asset.bytes.byteLength,
    });
    response.end(Buffer.from(asset.bytes));
  }

  /**
   * 房间资产：无 token、只允许内容寻址文件名、immutable + ETag、If-None-Match → 304。
   * 路径非法/越权 → 403；房间/资产不存在或类型不支持 → 404（全中文错误）。
   */
  function handleRoomAsset(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const parsed = parseRoomAssetRequestPath(url.pathname.slice(ROOM_ASSET_URL_PREFIX.length));
    if (!parsed.ok) {
      sendJson(response, parsed.status, {
        ok: false,
        error: { code: parsed.status === 403 ? 'forbidden' : 'not-found', message: parsed.message },
      });
      return;
    }
    const store = options.roomAssets;
    if (store === undefined) {
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not-found', message: '房间资产存储未启用' },
      });
      return;
    }
    let asset: ReturnType<RoomAssetsStore['read']>;
    try {
      asset = store.read(parsed.roomId, parsed.sha256, parsed.ext);
    } catch (error) {
      log(`room-asset ${parsed.roomId}/${parsed.sha256} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      sendJson(response, 500, { ok: false, error: { code: 'internal', message: '读取房间资产失败' } });
      return;
    }
    if (asset === undefined) {
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not-found', message: `房间资产不存在：${parsed.roomId}/${parsed.sha256}.${parsed.ext}` },
      });
      return;
    }
    const etag = `"${parsed.sha256.slice(0, 16)}"`;
    const headers = {
      ...CORS_HEADERS,
      etag,
      'cache-control': ASSET_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
    };
    const ifNoneMatch = request.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, parsed.sha256)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      'content-type': asset.contentType,
      'content-length': asset.bytes.byteLength,
    });
    response.end(Buffer.from(asset.bytes));
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/trpg/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'dsh-trpg-table',
        protocol: PROTOCOL_VERSION,
        rooms: service.list().rooms.length,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/trpg/rooms') {
      sendJson(response, 200, service.list());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/trpg/events') {
      handleSse(request, response, url);
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith(ROOM_ASSET_URL_PREFIX)) {
      handleRoomAsset(request, response, url);
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith(ASSET_URL_PREFIX)) {
      handleAsset(request, response, url);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/trpg/rpc') {
      void handleRpc(request, response);
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: 'not-found', message: 'not found' } });
  });

  return {
    server,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 已建立的 SSE 连接会阻止 close 回调；主动断开。
        server.closeAllConnections?.();
      }),
  };
}
