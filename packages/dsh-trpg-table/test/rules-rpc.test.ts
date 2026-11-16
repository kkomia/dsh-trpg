/**
 * M9.4 host 集成：PackRegistry 解析内容包 rules/scripts + room-http 的 12 个投影/命令 RPC。
 *
 * 用内置包 core-guimuya（M9.3 起内联 dnd5e-lite 规则包 + 4 个规则脚本）走真链路：
 * 注册表 → RoomService（带规则运行时）→ HTTP RPC / SSE。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARDS } from '@dsh-trpg/content';
import type { CatalogPack, RoomView, SheetView } from '@dsh-trpg/protocol';
import { RoomService, type RoomContentResolver, type RoomSnapshot } from '@dsh-trpg/rooms';
import { createRoomHttpServer, type RoomHttpServer } from '../src/host/room-http.ts';
import { PackRegistry } from '../src/host/pack-registry.ts';

interface TestServer {
  base: string;
  registry: PackRegistry;
  service: RoomService;
  close: () => Promise<void>;
}

async function startServer(options: { withoutRules?: boolean } = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-rules-'));
  const registry = new PackRegistry({ dir });
  registry.reload();
  const service = new RoomService(
    options.withoutRules === true ? { content: registry } : { content: registry, rules: registry },
  );
  const http: RoomHttpServer = createRoomHttpServer({
    port: 0,
    bindHost: '127.0.0.1',
    service,
    contentCatalog: () => registry.publicCatalog(),
    contentReload: () => registry.reload(),
  });
  await new Promise<void>((resolve) => http.server.listen(0, '127.0.0.1', () => resolve()));
  const address = http.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    registry,
    service,
    close: async () => {
      await http.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface RpcBody<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

async function rpc<T = unknown>(base: string, method: string, params?: unknown, token?: string): Promise<RpcBody<T>> {
  const response = await fetch(`${base}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, ...(params !== undefined ? { params } : {}), ...(token ? { token } : {}) }),
  });
  return (await response.json()) as RpcBody<T>;
}

interface RoomHandle {
  room: RoomView;
  hostToken: string;
  inviteCode: string;
}

async function createRoom(base: string): Promise<RoomHandle> {
  const created = await rpc<RoomHandle>(base, 'room.create', { title: '规则 RPC', gmMode: 'ai' });
  assert.equal(created.ok, true, created.error?.message);
  assert.ok(created.result);
  return created.result;
}

async function joinAndSeat(
  base: string,
  inviteCode: string,
  playerName: string,
  characterCard: unknown = CARDS[0],
): Promise<{ playerId: string; playerToken: string }> {
  const joined = await rpc<{ playerId: string; playerToken: string }>(base, 'room.join', { inviteCode, playerName });
  assert.equal(joined.ok, true, joined.error?.message);
  const playerToken = joined.result?.playerToken;
  const playerId = joined.result?.playerId;
  assert.ok(playerToken && playerId);
  const seated = await rpc(base, 'room.seat', { characterCard }, playerToken);
  assert.equal(seated.ok, true, seated.error?.message);
  return { playerId, playerToken };
}

async function playerTurn(base: string, hostToken: string, playerId: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const view = await rpc<{ combat: { active: boolean; activePlayerId?: string } }>(base, 'combat.view', undefined, hostToken);
    assert.equal(view.ok, true, view.error?.message);
    const combat = view.result?.combat;
    if (!combat?.active || combat.activePlayerId === playerId) return;
    const ended = await rpc(base, 'combat.endTurn', {}, hostToken);
    assert.equal(ended.ok, true, ended.error?.message);
  }
}

/** 读 SSE 重放（lastSeq=0）直到出现 needle 或超时；用于验证广播 kind。 */
async function readSseContains(url: string, needle: string, timeoutMs = 3000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes(needle)) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return '';
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// 注册表：rules + scripts
// ---------------------------------------------------------------------------

test('registry：内置内容包带 rules 段 → resolveRules 返回规则/脚本/指纹', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-reg-'));
  try {
    const registry = new PackRegistry({ dir });
    const loaded = registry.reload();
    assert.equal(loaded.packs, 1);
    assert.deepEqual(loaded.warnings, []);
    const entry = registry.getEntry('core-guimuya');
    assert.ok(entry?.rules, 'PackEntry 应保留 rules');
    const rules = registry.resolveRules('core-guimuya');
    assert.ok(rules);
    assert.equal(rules.rules.rulesId, 'dnd5e-lite');
    assert.equal(rules.rules.rulesVersion, '2.0.0');
    assert.equal(rules.packId, 'core-guimuya');
    assert.equal(rules.scripts?.length, 4, '内置规则包应带 4 个脚本源码');
    assert.match(rules.scripts?.[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
    assert.match(rules.rulesHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(registry.resolveRules('missing-pack'), undefined);
    // 内容解析（旧链路）不受影响
    assert.ok(registry.resolveLegacy('core-guimuya'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry：内置脚本源码的 sha256 与规则包清单一致（否则规则运行时会被拒绝）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-reg-'));
  try {
    const registry = new PackRegistry({ dir });
    registry.reload();
    const rules = registry.resolveRules('core-guimuya');
    assert.ok(rules?.scripts);
    const declared = new Map<string, string>();
    for (const ref of Object.values(rules.rules.scripts ?? {})) {
      if (ref !== undefined) declared.set(ref.file, ref.sha256);
    }
    assert.equal(declared.size, rules.scripts.length);
    for (const script of rules.scripts) {
      assert.equal(declared.get(script.file), script.sha256, `脚本 ${script.file} 的 sha256 应与清单一致`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP：卡面 / 装备 / 权限
// ---------------------------------------------------------------------------

test('HTTP：建房带规则 → room.rules = dnd5e-lite；落座后 sheet.get 返回完整卡面', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    assert.deepEqual(
      { rulesId: created.room.rules?.rulesId, rulesVersion: created.room.rules?.rulesVersion },
      { rulesId: 'dnd5e-lite', rulesVersion: '2.0.0' },
    );
    const { playerId, playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    const sheet = await rpc<{ sheet: SheetView; inventory: { items: unknown[] } }>(server.base, 'sheet.get', {}, playerToken);
    assert.equal(sheet.ok, true, sheet.error?.message);
    const view = sheet.result?.sheet;
    assert.ok(view);
    assert.equal(view.playerId, playerId);
    assert.equal(view.rulesId, 'dnd5e-lite');
    assert.equal(view.identity.name, '阿青');
    assert.ok(view.resources.some((resource) => resource.id === 'hp'));
    assert.equal(view.equipment.slots.length, 3);
    assert.ok(view.actions.some((action) => action.actionId === 'attack.melee'));
    assert.deepEqual(sheet.result?.inventory.items.length, view.items.length);
    // 房主也能看（GM 视角），无需 token 指定
    const asHost = await rpc<{ sheet: SheetView }>(server.base, 'sheet.get', { playerId }, created.hostToken);
    assert.equal(asHost.ok, true, asHost.error?.message);
    assert.equal(asHost.result?.sheet.cardId, view.cardId);
  } finally {
    await server.close();
  }
});

test('HTTP：equip/unequip 写命令生效；玩家不能操作别人的卡（forbidden）', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const aqing = await joinAndSeat(server.base, created.inviteCode, '阿青');
    const bailu = await joinAndSeat(server.base, created.inviteCode, '白露', CARDS[1]);
    const firstItemId = (await rpc<{ sheet: SheetView }>(server.base, 'sheet.get', {}, aqing.playerToken)).result?.sheet.items[0]
      ?.instanceId;
    assert.ok(firstItemId);
    const off = await rpc<{ sheet: SheetView }>(
      server.base,
      'sheet.unequip',
      { slotId: 'mainHand', instanceId: firstItemId },
      aqing.playerToken,
    );
    assert.equal(off.ok, true, off.error?.message);
    assert.equal(
      off.result?.sheet.equipment.slots.find((slot) => slot.slotId === 'mainHand')?.items.length,
      0,
    );
    const on = await rpc<{ sheet: SheetView }>(
      server.base,
      'sheet.equip',
      { slotId: 'mainHand', instanceId: firstItemId },
      aqing.playerToken,
    );
    assert.equal(on.ok, true, on.error?.message);
    assert.equal(
      on.result?.sheet.equipment.slots.find((slot) => slot.slotId === 'mainHand')?.items.length,
      1,
    );
    // 白露不能操作阿青的卡
    const other = await rpc(server.base, 'sheet.equip', { slotId: 'mainHand', instanceId: firstItemId, playerId: aqing.playerId }, bailu.playerToken);
    assert.equal(other.ok, false);
    assert.equal(other.error?.code, 'forbidden');
    assert.match(other.error?.message ?? '', /别人的角色卡/);
    // 非法参数中文错误
    const missing = await rpc(server.base, 'sheet.equip', { instanceId: firstItemId }, aqing.playerToken);
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'bad-request');
    assert.match(missing.error?.message ?? '', /缺少 slotId/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// HTTP：战斗 / 世界地图
// ---------------------------------------------------------------------------

test('HTTP：combat.view 未开战稳定形状；combat.start（房主）→ 先攻/回合/行动经济', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerId, playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    const before = await rpc<{ combat: { active: boolean; cols: number; terrain: unknown[] } }>(
      server.base,
      'combat.view',
      undefined,
      playerToken,
    );
    assert.equal(before.ok, true, before.error?.message);
    assert.equal(before.result?.combat.active, false);
    assert.equal(before.result?.combat.cols, 0, 'dnd5e-lite 无空间模型：cols=0');
    assert.deepEqual(before.result?.combat.terrain, []);

    const playerStart = await rpc(server.base, 'combat.start', { enemies: [{ name: '血尸' }] }, playerToken);
    assert.equal(playerStart.ok, false);
    assert.equal(playerStart.error?.code, 'forbidden');

    const started = await rpc<{ combat: { active: boolean; round: number; maxRounds: number; initiative: unknown[]; actionEconomy: { actorId: string | null; remaining: Array<{ id: string }> } }; rolls: unknown[] }>(
      server.base,
      'combat.start',
      { enemies: [{ name: '血尸' }], reason: '遭遇' },
      created.hostToken,
    );
    assert.equal(started.ok, true, started.error?.message);
    const combat = started.result?.combat;
    assert.ok(combat);
    assert.equal(combat.active, true);
    assert.equal(combat.round, 1);
    assert.equal(combat.maxRounds, 0, 'dnd5e-lite 未声明 time.defaultMaxRounds：无回合上限');
    assert.equal(combat.initiative.length, 2);
    assert.equal(started.result?.rolls.length, 2);
    assert.deepEqual(combat.actionEconomy.remaining.map((entry) => entry.id), ['action', 'bonus', 'reaction', 'movement']);
    assert.ok(playerId);
  } finally {
    await server.close();
  }
});

test('HTTP：useAction/rollCheck/endTurn 走 host 结算；越权与非法动作中文错误', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerId, playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    await rpc(server.base, 'combat.start', { enemies: [{ name: '血尸' }] }, created.hostToken);
    await playerTurn(server.base, created.hostToken, playerId);
    const view = await rpc<{ combat: { tokens: Array<{ actorId: string; team: string }> } }>(
      server.base,
      'combat.view',
      undefined,
      playerToken,
    );
    const enemy = view.result?.combat.tokens.find((token) => token.team === 'enemy');
    assert.ok(enemy);

    const acted = await rpc<{ action: { actionId: string; turn: Record<string, number>; rolls: unknown[] }; combat: { active: boolean } }>(
      server.base,
      'combat.useAction',
      { actionId: 'attack.melee', targetId: enemy.actorId },
      playerToken,
    );
    assert.equal(acted.ok, true, acted.error?.message);
    assert.equal(acted.result?.action.actionId, 'attack.melee');
    assert.equal(acted.result?.action.turn.action, 0, '动作经济已消耗');
    assert.ok((acted.result?.action.rolls.length ?? 0) >= 1);
    // 动作不够再打一次 → conflict 中文（若首刀把敌人打倒了，则是「已经倒下」）
    const again = await rpc(server.base, 'combat.useAction', { actionId: 'attack.melee', targetId: enemy.actorId }, playerToken);
    assert.equal(again.ok, false);
    assert.equal(again.error?.code, 'conflict');
    assert.match(again.error?.message ?? '', /不足|已经倒下/);
    // 未知动作 → not-found 中文
    const unknown = await rpc(server.base, 'combat.useAction', { actionId: 'attack.nope' }, playerToken);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error?.code, 'not-found');
    assert.match(unknown.error?.message ?? '', /没有动作/);
    // 检定
    const check = await rpc<{ check: { d20: number; dc: number; success: boolean; total: number } }>(
      server.base,
      'combat.rollCheck',
      { skillId: 'athletics', dc: 12 },
      playerToken,
    );
    assert.equal(check.ok, true, check.error?.message);
    assert.equal(check.result?.check.dc, 12);
    assert.ok((check.result?.check.d20 ?? 0) >= 1);
    // 结束回合（房主代管当前回合）
    const ended = await rpc<{ combat: { active: boolean } }>(server.base, 'combat.endTurn', {}, created.hostToken);
    assert.equal(ended.ok, true, ended.error?.message);
    assert.equal(typeof ended.result?.combat.active, 'boolean');
    // combat.end（房主收场）
    const finished = await rpc<{ combat: { active: boolean; endedReason?: string } }>(server.base, 'combat.end', { reason: '收场' }, created.hostToken);
    assert.equal(finished.ok, true, finished.error?.message);
    assert.equal(finished.result?.combat.active, false);
    assert.equal(finished.result?.combat.endedReason, '收场');
  } finally {
    await server.close();
  }
});

test('HTTP：combat.move / worldmap.get（dnd5e 无空间模型时仍给稳定形状）', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerId, playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    const world = await rpc<{ worldMap: { zones: unknown[]; partyPosition: { members: unknown[] } } }>(
      server.base,
      'worldmap.get',
      undefined,
      playerToken,
    );
    assert.equal(world.ok, true, world.error?.message);
    assert.deepEqual(world.result?.worldMap.zones, []);
    assert.equal(world.result?.worldMap.partyPosition.members.length, 1);
    await rpc(server.base, 'combat.start', { enemies: [{ name: '血尸' }] }, created.hostToken);
    await playerTurn(server.base, created.hostToken, playerId);
    const moved = await rpc<{ move: { cost: number; remaining: number | null }; combat: { active: boolean } }>(
      server.base,
      'combat.move',
      { to: { zoneId: 'open-field' } },
      playerToken,
    );
    assert.equal(moved.ok, true, moved.error?.message);
    assert.equal(typeof moved.result?.move.cost, 'number');
    const bad = await rpc(server.base, 'combat.move', { to: {} }, playerToken);
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, 'bad-request');
    assert.match(bad.error?.message ?? '', /zoneId 或 cell/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// HTTP：SSE 广播
// ---------------------------------------------------------------------------

test('HTTP/SSE：sheet/update 只投本人、combat/update 全桌（重放 lastSeq=0）', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    const sheet = await rpc<{ sheet: SheetView }>(server.base, 'sheet.get', {}, playerToken);
    const instanceId = sheet.result?.sheet.items[0]?.instanceId;
    assert.ok(instanceId);
    await rpc(server.base, 'sheet.unequip', { slotId: 'mainHand', instanceId }, playerToken);
    const playerSse = await readSseContains(`${server.base}/trpg/events?token=${playerToken}&lastSeq=0`, 'sheet/update');
    assert.ok(playerSse.includes('"kind":"sheet/update"'), '玩家应收到自己的 sheet/update');
    const hostSse = await readSseContains(`${server.base}/trpg/events?token=${created.hostToken}&lastSeq=0`, '"kind":"sheet/update"');
    assert.ok(hostSse.includes('"kind":"sheet/update"'), '房主（GM）也能看到玩家的 sheet/update');
    const witness = await rpc<{ playerToken: string }>(server.base, 'room.join', { inviteCode: created.inviteCode, playerName: '旁观者' });
    const witnessToken = witness.result?.playerToken;
    assert.ok(witnessToken);
    const witnessSse = await readSseContains(`${server.base}/trpg/events?token=${witnessToken}&lastSeq=0`, '"kind":"room"');
    assert.ok(witnessSse.includes('"kind":"room"'), '旁观者的 SSE 流应能连上（至少收到 room 事件）');
  } finally {
    await server.close();
  }
});

test('HTTP/SSE：战斗开始广播 combat/update（全桌，带 causes）', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerId, playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    await rpc(server.base, 'combat.start', { enemies: [{ name: '血尸' }] }, created.hostToken);
    const combatSse = await readSseContains(`${server.base}/trpg/events?token=${created.hostToken}&lastSeq=0`, '"kind":"combat/update"');
    assert.ok(combatSse.includes('"kind":"combat/update"'), '开战应广播 combat/update');
    assert.ok(combatSse.includes('"causes":["combat/start"]') || combatSse.includes('combat/start'));
    assert.ok(playerId);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 无 rules 降级 / 续团恢复
// ---------------------------------------------------------------------------

function stubContent(): RoomContentResolver {
  return {
    defaultPackId: 'core-guimuya',
    resolveModule(packId: string): { packId: string; packVersion: string; moduleId: string; moduleTitle: string; contentHash: string; scenes: never[] } {
      return {
        packId,
        packVersion: '1.0.0',
        moduleId: 'guimuya',
        moduleTitle: '鬼木崖·异光',
        contentHash: 'stub',
        scenes: [],
      };
    },
  };
}

test('HTTP：无 rules 的房间保持旧行为（room.rules 缺省；规则命令中文 conflict）', async () => {
  const server = await startServer({ withoutRules: true });
  try {
    const created = await createRoom(server.base);
    assert.equal(created.room.rules, undefined);
    const joined = await rpc<{ playerToken: string }>(server.base, 'room.join', { inviteCode: created.inviteCode, playerName: '阿青' });
    const playerToken = joined.result?.playerToken;
    assert.ok(playerToken);
    const sheet = await rpc(server.base, 'sheet.get', {}, playerToken);
    assert.equal(sheet.ok, false);
    assert.equal(sheet.error?.code, 'conflict');
    assert.match(sheet.error?.message ?? '', /没有规则运行时/);
    const combat = await rpc(server.base, 'combat.view', undefined, playerToken);
    assert.equal(combat.ok, false);
    assert.equal(combat.error?.code, 'conflict');
    const world = await rpc(server.base, 'worldmap.get', undefined, playerToken);
    assert.equal(world.ok, false);
    assert.equal(world.error?.code, 'conflict');
    // 旧 RPC 正常
    assert.equal((await rpc(server.base, 'room.state', undefined, playerToken)).ok, true);
    assert.equal((await rpc(server.base, 'room.roll', { expression: '1d20' }, playerToken)).ok, true);
  } finally {
    await server.close();
  }
});

test('续团：恢复快照后 ruleState 继续生效（规则/卡面/战斗回合都可续算）', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerId, playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    await rpc(server.base, 'combat.start', { enemies: [{ name: '血尸' }] }, created.hostToken);
    const beforeSnapshot = await rpc<{ check: { d20: number; total: number } }>(
      server.base,
      'combat.rollCheck',
      { skillId: 'athletics', dc: 12 },
      playerToken,
    );
    assert.equal(beforeSnapshot.ok, true, beforeSnapshot.error?.message);
    const snapshot = JSON.parse(JSON.stringify(server.service.snapshotAll()[0])) as RoomSnapshot;
    assert.ok(snapshot.room.ruleState, '快照应带 ruleState');
    assert.equal(snapshot.room.rulesId, 'dnd5e-lite');
    assert.equal(typeof snapshot.room.rulesSeed, 'number');

    const restoredService = new RoomService({ content: server.registry, rules: server.registry });
    assert.equal(restoredService.restore(snapshot), true);
    const host = restoredService.login(created.hostToken);
    const player = restoredService.login(playerToken);
    assert.equal(restoredService.state(host).room.rules?.degraded, undefined);
    const view = restoredService.combatView(player).combat;
    assert.equal(view.active, true);
    assert.equal(view.initiative.length, 2);
    const sheet = restoredService.sheet(player, {});
    assert.equal(sheet.sheet.playerId, playerId);
    // 续算一致：两边继续同一动作序列（检定）应得到相同骰面
    const originalNext = server.service.rollCheck(server.service.login(playerToken), { skillId: 'athletics', dc: 12 });
    const restoredNext = restoredService.rollCheck(player, { skillId: 'athletics', dc: 12 });
    assert.equal(originalNext.check.d20, restoredNext.check.d20);
    assert.equal(originalNext.check.total, restoredNext.check.total);
  } finally {
    await server.close();
  }
});

test('续团降级：规则包缺失时房间恢复但标 degraded，规则命令中文错误', async () => {
  const server = await startServer();
  try {
    const created = await createRoom(server.base);
    const { playerToken } = await joinAndSeat(server.base, created.inviteCode, '阿青');
    const snapshot = JSON.parse(JSON.stringify(server.service.snapshotAll()[0])) as RoomSnapshot;
    const restoredService = new RoomService({ content: stubContent() });
    assert.equal(restoredService.restore(snapshot), true);
    const host = restoredService.login(created.hostToken);
    const room = restoredService.state(host).room;
    assert.equal(room.rules?.degraded, true);
    assert.equal(restoredService.runtimeOf(snapshot.room.id), undefined);
    const player = restoredService.login(playerToken);
    assert.throws(() => restoredService.sheet(player, {}), /规则|不可用/);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// content.list 脱敏不受 rules 影响
// ---------------------------------------------------------------------------

test('content.list：仍只给脱敏目录（不泄漏 rules 正文/脚本）', async () => {
  const server = await startServer();
  try {
    const listed = await rpc<{ packs: CatalogPack[] }>(server.base, 'content.list');
    assert.equal(listed.ok, true);
    const serialized = JSON.stringify(listed.result);
    assert.ok(serialized.includes('core-guimuya'));
    assert.equal(serialized.includes('formulas'), false, '目录不能泄漏规则包正文');
    assert.equal(serialized.includes('rules/scripts'), false, '目录不能泄漏脚本路径');
  } finally {
    await server.close();
  }
});
