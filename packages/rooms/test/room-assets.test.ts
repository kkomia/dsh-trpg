/**
 * M9.5d 房间层：落座展示资产引用（`seat.characterAssets`）→ 房间视图 / 卡面媒体 / 战棋头像 / 快照续团。
 *
 * 只测 rooms 的引用记账与投影（字节在 host 的 RoomAssetStore，见 dsh-trpg-table 测试）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINIMAL_RULE_PACK, SAMPLE_LEGACY_CARD, type RulePack } from '@dsh-trpg/rules';
import type { CharacterAssetRefInput } from '@dsh-trpg/protocol';
import {
  RoomService,
  type RoomContentModule,
  type RoomContentResolver,
  type RoomRuleScript,
  type RoomSnapshot,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// 脚手架（与 rules-room.test.ts 同口径：桩规则包，不依赖内容包）
// ---------------------------------------------------------------------------

const CONTENT: RoomContentResolver = {
  defaultPackId: 'test-pack',
  resolveModule(packId: string, moduleId?: string): RoomContentModule | undefined {
    return {
      packId,
      packVersion: '1.0.0',
      packName: '测试包',
      moduleId: moduleId ?? 'test-module',
      moduleTitle: '测试模组',
      contentHash: 'hash-test',
      scenes: [{ sceneId: 'scene_1', title: '第一幕' }],
    };
  },
  hasPack(): boolean {
    return true;
  },
};

interface RulesStub {
  rules: RulePack;
  scripts?: RoomRuleScript[];
  rulesHash?: string;
}

function makeService(rules: RulesStub | null = { rules: MINIMAL_RULE_PACK, rulesHash: 'hash-test-rules' }): RoomService {
  return new RoomService({
    content: CONTENT,
    rules: { resolveRules: () => (rules === null ? undefined : rules) },
    seedSalt: 'test-salt',
  });
}

interface Fixture {
  service: RoomService;
  roomId: string;
  hostToken: string;
  playerId: string;
  playerToken: string;
  invitation: string;
  host: ReturnType<RoomService['login']>;
  player: ReturnType<RoomService['login']>;
}

function openRoom(service: RoomService): Fixture {
  const created = service.createRoom({ title: '资产团', gmMode: 'ai' });
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: SAMPLE_LEGACY_CARD });
  return {
    service,
    roomId: created.room.roomId,
    hostToken: created.hostToken,
    playerId: joined.playerId,
    playerToken: joined.playerToken,
    invitation: created.inviteCode,
    host: service.login(created.hostToken),
    player: service.login(joined.playerToken),
  };
}

const SHA_AVATAR = 'a'.repeat(64);
const SHA_PORTRAIT = 'b'.repeat(64);
const SHA_SMILE = 'c'.repeat(64);
const SHA_SHEET = 'd'.repeat(64);

function url(roomId: string, sha: string, ext = 'png'): string {
  return `/trpg/room-assets/${roomId}/${sha}.${ext}`;
}

function refsOf(roomId: string): CharacterAssetRefInput[] {
  return [
    { kind: 'avatar', sha256: SHA_AVATAR, url: url(roomId, SHA_AVATAR) },
    { kind: 'portrait', sha256: SHA_PORTRAIT, url: url(roomId, SHA_PORTRAIT) },
    { kind: 'portraitVariant', variant: 'smile', sha256: SHA_SMILE, url: url(roomId, SHA_SMILE) },
    {
      kind: 'spriteSheet',
      sha256: SHA_SHEET,
      url: url(roomId, SHA_SHEET),
      meta: { rows: 4, cols: 4, frameSize: 128 },
    },
  ];
}

function snapshotOf(service: RoomService): RoomSnapshot {
  const snapshot = service.snapshotAll()[0];
  assert.ok(snapshot);
  return JSON.parse(JSON.stringify(snapshot)) as RoomSnapshot;
}

// ---------------------------------------------------------------------------
// A. 落座引用 → 房间视图
// ---------------------------------------------------------------------------

test('M9.5d: seat 带 characterAssets → RoomView.assets 有条目（队友可见，按 sha256 去重）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const seated = service.seat(fixture.player, {
    characterCard: SAMPLE_LEGACY_CARD,
    characterAssets: refsOf(fixture.roomId),
  });
  assert.equal(seated.room.assets?.length, 4);
  const avatar = seated.room.assets?.find((asset) => asset.kind === 'avatar');
  assert.equal(avatar?.assetId, SHA_AVATAR);
  assert.equal(avatar?.sha256, SHA_AVATAR);
  assert.equal(avatar?.url, url(fixture.roomId, SHA_AVATAR));
  assert.equal(avatar?.ownerId, fixture.playerId);
  assert.equal(seated.room.assets?.find((asset) => asset.kind === 'portraitVariant')?.variant, 'smile');

  // 另一个玩家（later join）也能在房间视图看到队友的展示资产
  const other = service.join({ inviteCode: fixture.invitation, playerName: '阿白' });
  const otherView = service.state(service.login(other.playerToken)).room;
  assert.equal(otherView.assets?.length, 4, '队友可见立绘/变体');

  // 同一 sha 被两个玩家引用：房间资产列表只登记一条
  const bob = service.login(other.playerToken);
  service.seat(bob, {
    characterCard: SAMPLE_LEGACY_CARD,
    characterAssets: [{ kind: 'avatar', sha256: SHA_AVATAR, url: url(fixture.roomId, SHA_AVATAR) }],
  });
  assert.equal(service.state(fixture.host).room.assets?.length, 4);
});

test('M9.5d: 落座不带资产 → 无 assets 字段；再次落座带资产生效；空数组显式清空', () => {
  const service = makeService();
  const fixture = openRoom(service);
  assert.equal(service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD }).room.assets, undefined);

  // 断线重连：先带资产落座，再不带资产落座（旧客户端/重连）→ 保留引用不重复上传
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: refsOf(fixture.roomId) });
  const reconnected = service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD });
  assert.equal(reconnected.room.assets?.length, 4, '重连落座不丢资产引用');

  // 显式清空
  const cleared = service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: [] });
  assert.equal(cleared.room.assets, undefined);
});

test('M9.5d: 落座资产引用非法 → bad-request 中文错误（不落座、不改房间）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  assert.throws(
    () =>
      service.seat(fixture.player, {
        characterCard: SAMPLE_LEGACY_CARD,
        characterAssets: [{ kind: 'cover', sha256: SHA_AVATAR }],
      }),
    /kind 必须是 avatar/,
  );
  assert.throws(
    () =>
      service.seat(fixture.player, {
        characterCard: SAMPLE_LEGACY_CARD,
        characterAssets: [{ kind: 'avatar', sha256: 'xyz' }],
      }),
    /64 位小写十六进制/,
  );
  assert.throws(
    () =>
      service.seat(fixture.player, {
        characterCard: SAMPLE_LEGACY_CARD,
        characterAssets: Array.from({ length: 9 }, () => ({ kind: 'avatar' as const, sha256: SHA_AVATAR })),
      }),
    /最多 8 个文件/,
  );
  assert.equal(service.state(fixture.host).room.assets, undefined);
});

// ---------------------------------------------------------------------------
// B. 卡面 / 战棋投影带媒体字段
// ---------------------------------------------------------------------------

test('M9.5d: sheet.get → identity.avatarUrl/portraitUrl/portraitVariants/spriteSheet', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: refsOf(fixture.roomId) });
  const sheet = service.sheet(fixture.player, {}).sheet;
  assert.equal(sheet.identity.avatarUrl, url(fixture.roomId, SHA_AVATAR));
  assert.equal(sheet.identity.portraitUrl, url(fixture.roomId, SHA_PORTRAIT));
  assert.deepEqual(sheet.identity.portraitVariants, [{ variant: 'smile', url: url(fixture.roomId, SHA_SMILE) }]);
  assert.deepEqual(sheet.identity.spriteSheet, {
    url: url(fixture.roomId, SHA_SHEET),
    rows: 4,
    cols: 4,
    frameSize: 128,
  });
  // 房主代看某人的卡也带同一套媒体
  const hostView = service.sheet(fixture.host, { playerId: fixture.playerId }).sheet;
  assert.equal(hostView.identity.avatarUrl, url(fixture.roomId, SHA_AVATAR));
});

test('M9.5d: combat.view → tokens[].avatarUrl 只在玩家落座上传头像后出现', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: refsOf(fixture.roomId) });
  const started = service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 3, y: 4 } }], reason: '测试' });
  const playerToken = started.combat.tokens.find((token) => token.playerId === fixture.playerId);
  assert.ok(playerToken, '应有玩家 token');
  assert.equal(playerToken.avatarUrl, url(fixture.roomId, SHA_AVATAR));
  const enemyToken = started.combat.tokens.find((token) => token.team === 'enemy');
  assert.equal(enemyToken?.avatarUrl, undefined, '敌人没有头像 URL');
  // 后续 combat.view 同样带媒体字段
  const view = service.combatView(fixture.player).combat;
  assert.equal(view.tokens.find((token) => token.playerId === fixture.playerId)?.avatarUrl, url(fixture.roomId, SHA_AVATAR));
});

test('M9.5d: 没有头像引用时卡面/战棋不塞假字段（客户端用几何徽记兜底）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD });
  const sheet = service.sheet(fixture.player, {}).sheet;
  assert.equal(sheet.identity.avatarUrl, undefined);
  assert.equal(sheet.identity.portraitUrl, undefined);
  assert.equal(sheet.identity.portraitVariants, undefined);
  assert.equal(sheet.identity.spriteSheet, undefined);
  const combat = service.startCombat(fixture.host, {}).combat;
  assert.equal(combat.tokens.find((token) => token.playerId === fixture.playerId)?.avatarUrl, undefined);
});

test('M9.5d: 只有 sha 没有 url 的引用（上传失败的降级路径）→ 落座成功、投影无媒体字段', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const seated = service.seat(fixture.player, {
    characterCard: SAMPLE_LEGACY_CARD,
    characterAssets: [{ kind: 'avatar', sha256: SHA_AVATAR }],
  });
  assert.equal(seated.room.assets, undefined, '没有 URL 的引用不进房间资产区');
  assert.equal(service.sheet(fixture.player, {}).sheet.identity.avatarUrl, undefined);
});

// ---------------------------------------------------------------------------
// C. 快照 / 续团
// ---------------------------------------------------------------------------

test('M9.5d: 快照保留 characterAssets 引用（只存 refs/sha，不含字节）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: refsOf(fixture.roomId) });
  const snapshot = snapshotOf(service);
  const seated = snapshot.room.players.find((player) => player.id === fixture.playerId);
  assert.equal(seated?.characterAssets?.length, 4);
  assert.equal(seated?.characterAssets?.[0]?.sha256, SHA_AVATAR);
  assert.equal(seated?.characterAssets?.[0]?.url, url(fixture.roomId, SHA_AVATAR));
  assert.equal(JSON.stringify(snapshot).includes('base64'), false, '快照只存引用，不复制字节');
});

test('M9.5d: 续团恢复后资产引用/房间视图/卡面媒体仍在（断线重连不重复上传）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: refsOf(fixture.roomId) });
  const snapshot = snapshotOf(service);

  const restored = makeService();
  assert.equal(restored.restore(snapshot), true);
  const host = restored.login(fixture.hostToken);
  const player = restored.login(fixture.playerToken);
  assert.equal(restored.state(host).room.assets?.length, 4, '续团后房间资产列表保留');
  const sheet = restored.sheet(player, {}).sheet;
  assert.equal(sheet.identity.avatarUrl, url(fixture.roomId, SHA_AVATAR));
  assert.deepEqual(sheet.identity.spriteSheet, {
    url: url(fixture.roomId, SHA_SHEET),
    rows: 4,
    cols: 4,
    frameSize: 128,
  });
  // 重连落座（旧客户端不带资产）不丢引用
  restored.seat(player, { characterCard: SAMPLE_LEGACY_CARD });
  assert.equal(restored.state(host).room.assets?.length, 4);
});

// ---------------------------------------------------------------------------
// D. 离场
// ---------------------------------------------------------------------------

test('M9.5d: 玩家离开 → 房间资产列表移除其引用（文件保留在 host，续团/重进可复用）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.seat(fixture.player, { characterCard: SAMPLE_LEGACY_CARD, characterAssets: refsOf(fixture.roomId) });
  assert.equal(service.state(fixture.host).room.assets?.length, 4);
  service.leave(fixture.player);
  assert.equal(service.state(fixture.host).room.assets, undefined);
});
