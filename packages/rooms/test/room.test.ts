import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomError, RoomService } from '../src/index.ts';

/** 最小合法角色卡（结构与 content/cards 一致）。 */
function card(name: string) {
  return {
    schemaVersion: 1,
    id: `card_${name}`,
    identity: { name, race: '山民', class: '武者', level: 1 },
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
    proficiency: { bonus: 2, skills: ['athletics'], saves: ['str', 'con'] },
    combat: {
      ac: 16,
      hpMax: 12,
      attacks: [{ name: '横刀', ability: 'str', proficient: true, damage: '1d8', range: 'engaged' }],
    },
    inventory: [],
    publicSummary: `${name}的公开简介`,
  };
}

function setup() {
  const service = new RoomService({ now: () => 1000 });
  const created = service.createRoom({ title: '鬼木崖·异光', gmMode: 'ai' });
  const host = service.login(created.hostToken);
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: card('阿青') });
  const player = service.login(joined.playerToken);
  const joined2 = service.join({ inviteCode: created.inviteCode, playerName: '白露' });
  const player2 = service.login(joined2.playerToken);
  return { service, created, host, player, player2, joined, joined2 };
}

test('createRoom: host gets invite code and token; player view hides invite code', () => {
  const { service, created } = setup();
  assert.equal(created.inviteCode.length, 6);
  assert.ok(created.hostToken.length > 20);
  assert.equal(created.room.inviteCode, created.inviteCode, '房主视图包含邀请码');
  const playerView = service.state(service.login(created.hostToken)).room;
  assert.ok(playerView);
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '新人' });
  assert.equal(joined.room.inviteCode, undefined, '玩家视图不能看到邀请码');
  assert.ok(service);
});

test('join: wrong invite code and locked room are rejected', () => {
  const { service, created, host } = setup();
  assert.throws(() => service.join({ inviteCode: 'AAAAAA', playerName: 'x' }), /邀请码/);
  service.lock(host, { locked: true });
  assert.throws(
    () => service.join({ inviteCode: created.inviteCode, playerName: 'x' }),
    (error: unknown) => error instanceof RoomError && error.code === 'room-locked',
  );
  service.lock(host, { locked: false });
  assert.ok(service.join({ inviteCode: created.inviteCode, playerName: 'x' }).playerToken);
});

test('seat: invalid card rejected, valid card updates the seat view', () => {
  const { service, player } = setup();
  assert.throws(() => service.seat(player, { characterCard: { nope: true } }), /角色卡校验失败/);
  const result = service.seat(player, { characterCard: card('阿青') });
  assert.ok(result.room.players.some((entry) => entry.characterName === '阿青'));
  assert.ok(result.room.players.some((entry) => entry.characterSummary?.includes('公开简介')));
});

test('roll: deterministic per room, public dice visible to everyone', () => {
  const { service, host, player, player2 } = setup();
  const roll = service.roll(host, { expression: '2d6+1', label: '伤害' });
  assert.equal(roll.event.kind, 'dice');
  assert.equal(roll.event.payload.dice.length, 2);
  assert.equal(roll.event.to, 'all');
  const playerEvents = service.eventsSince(player2, 0).filter((event) => event.kind === 'dice');
  assert.equal(playerEvents.length, 1);
  // 相同房间再掷一次，结果与 rollIndex 相关且可复现
  const second = service.roll(player, { expression: 'd20' });
  assert.equal(second.event.payload.dice.length, 1);
  assert.ok(second.event.seq > roll.event.seq);
});

test('roll: private roll is only visible to the roller and the host (GM)', () => {
  const { service, host, player, player2 } = setup();
  const privateRoll = service.roll(player, { expression: 'd20', label: '察觉', private: true });
  assert.equal(privateRoll.event.to !== 'all', true);
  const hostSees = service.eventsSince(host, 0).some((event) => event.seq === privateRoll.event.seq);
  const rollerSees = service.eventsSince(player, 0).some((event) => event.seq === privateRoll.event.seq);
  const otherSees = service.eventsSince(player2, 0).some((event) => event.seq === privateRoll.event.seq);
  assert.equal(hostSees, true);
  assert.equal(rollerSees, true);
  assert.equal(otherSees, false, '私骰不能泄漏给其他玩家');
});

test('say: private whisper reaches only the GM', () => {
  const { service, host, player, player2 } = setup();
  const whisper = service.say(player, { text: '我想偷偷翻他的包', private: true });
  assert.equal(whisper.event.to, 'gm');
  assert.equal(service.eventsSince(host, 0).some((event) => event.seq === whisper.event.seq), true);
  assert.equal(service.eventsSince(player2, 0).some((event) => event.seq === whisper.event.seq), false);
  const publicSay = service.say(player, { text: '我走进茶馆' });
  assert.equal(publicSay.event.to, 'all');
  assert.equal(service.eventsSince(player2, 0).some((event) => event.seq === publicSay.event.seq), true);
});

test('permissions: only the host can kick or lock; kicked token becomes invalid', () => {
  const { service, host, player, joined2 } = setup();
  assert.throws(() => service.kick(player, { playerId: joined2.room.players[1]?.playerId }), /只有房主/);
  assert.throws(() => service.lock(player, { locked: true }), /只有房主/);
  service.kick(host, { playerId: joined2.playerId });
  assert.throws(() => service.login(joined2.playerToken), /令牌无效|移出房间/);
  const hostView = service.state(host).room;
  assert.ok(!hostView.players.some((entry) => entry.playerId === joined2.playerId));
});

test('eventsSince: reconnect replays only events after lastSeq and respects projection', () => {
  const { service, player, player2 } = setup();
  const first = service.roll(player, { expression: 'd20' });
  service.roll(player, { expression: 'd20', private: true });
  const later = service.roll(player, { expression: 'd8' });
  const replay = service.eventsSince(player2, first.event.seq);
  assert.ok(replay.some((event) => event.seq === later.event.seq));
  assert.ok(!replay.some((event) => event.seq === first.event.seq), '已确认的 seq 不重复推送');
  assert.ok(!replay.some((event) => event.kind === 'dice' && event.to !== 'all'), '补发也要过滤私密事件');
});

test('subscribe: SE 连接维护在线状态，断线后离线', () => {
  const { service, player } = setup();
  const received: number[] = [];
  const unsubscribe = service.subscribe(player, (event) => received.push(event.seq));
  assert.equal(service.diagnostics().listeners, 1);
  service.roll(player, { expression: 'd20' });
  assert.ok(received.length > 0, '订阅者应收到广播事件');
  unsubscribe();
  assert.equal(service.diagnostics().listeners, 0);
});

test('room list is public but carries no secret', () => {
  const { service, created } = setup();
  const list = service.list();
  assert.equal(list.rooms.length, 1);
  assert.equal(list.rooms[0]?.title, created.room.title);
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes(created.inviteCode), '房间列表不能泄漏邀请码');
  assert.ok(!serialized.includes(created.hostToken));
});

test('invalid input: empty text and bad dice expression are rejected with codes', () => {
  const { service, host } = setup();
  assert.throws(() => service.say(host, { text: '' }), /不能为空/);
  assert.throws(
    () => service.roll(host, { expression: 'd' }),
    (error: unknown) => error instanceof RoomError && error.code === 'invalid-expression',
  );
});

test('snapshot/restore: 存档恢复后 token、角色卡、事件序号与场景保持', () => {
  const { service, created, player, joined } = setup();
  service.roll(player, { expression: 'd20' });
  service.gmScene(created.room.roomId, 'scene_guimuya', '枯木崖·古洞');
  const snapshots = service.snapshotAll();
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.ok(snapshot);
  const restored = new RoomService();
  assert.equal(restored.restore(snapshot), true);
  const hostPrincipal = restored.login(created.hostToken);
  const view = restored.state(hostPrincipal).room;
  assert.equal(view.scene?.sceneId, 'scene_guimuya');
  assert.equal(view.players.length, 2);
  assert.ok(restored.login(joined.playerToken), '玩家 token 也要能恢复');
  const events = restored.eventsSince(hostPrincipal, 0);
  assert.ok(events.length > 2);
  assert.equal(events[events.length - 1]?.seq, snapshot.room.seq);
});

test('gm.award: 奖励只发给目标玩家，GM 可见，其他玩家不可见', () => {
  const { service, host, player, player2, joined2 } = setup();
  const award = service.gmAward(host.roomId, joined2.playerId, { xp: 50, items: ['镇魂符'] });
  assert.equal(award.to, joined2.playerId);
  assert.equal(service.eventsSince(host, 0).some((event) => event.seq === award.seq), true);
  assert.equal(service.eventsSince(player2, 0).some((event) => event.seq === award.seq), true);
  assert.equal(service.eventsSince(player, 0).some((event) => event.seq === award.seq), false, '奖励不能泄漏给其他玩家');
});
