import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomService } from '../src/index.ts';

interface Received {
  roomId: string;
  kind: string;
  to: string;
}

function setup() {
  const service = new RoomService({ maxRooms: 4 });
  const created = service.createRoom({ title: '订阅测试', gmMode: 'ai' });
  const roomId = created.room.roomId;
  const alice = service.join({ inviteCode: created.inviteCode, playerName: '阿青' });
  const received: Received[] = [];
  const off = service.subscribeAll((eventRoomId, event) => {
    received.push({ roomId: eventRoomId, kind: event.kind, to: event.to });
  });
  return { service, roomId, created, alice, received, off };
}

test('subscribeAll：能收到私密事件（GM 视角全量），不是玩家可见性通道', () => {
  const { service, roomId, created, alice, received, off } = setup();
  const alicePrincipal = service.login(alice.playerToken);
  service.roll(alicePrincipal, { expression: 'd20', private: true });
  service.gmSecret(roomId, alice.playerId, '只有阿青能看到');
  service.gmNarrate(roomId, '公开旁白');
  const kinds = received.map((entry) => entry.kind);
  assert.equal(kinds.includes('dice'), true);
  assert.equal(kinds.includes('narration'), true);
  // 私骰/私密旁白都带收件人；全量监听能看到 to=playerId 的事件。
  const privateDice = received.find((entry) => entry.kind === 'dice' && entry.to !== 'all');
  assert.equal(privateDice?.to, alice.playerId);
  const privateNarration = received.find((entry) => entry.kind === 'narration' && entry.to !== 'all');
  assert.equal(privateNarration?.to, alice.playerId);
  // 房主视角仍有 host 事件流（GM 也可见）。
  assert.equal(service.gmRecentEvents(roomId, 10).length > 0, true);
  assert.equal(created.room.roomId, roomId);
  off();
});

test('subscribeAll：取消后不再收事件；多监听互不影响', () => {
  const { service, roomId, alice, received, off } = setup();
  const second: string[] = [];
  const offSecond = service.subscribeAll((_roomId, event) => second.push(event.kind));
  service.gmAlert(roomId, '提示一');
  assert.equal(received.length >= 1, true);
  assert.equal(second.length >= 1, true);
  const before = received.length;
  off();
  offSecond();
  service.gmAlert(roomId, '提示二');
  assert.equal(received.length, before);
  assert.equal(second.length, 1);
  // 房间仍在，玩家行动照常。
  const result = service.say(service.login(alice.playerToken), { text: '我推开门' });
  assert.equal(result.event.kind, 'narration');
});

test('subscribeAll：单个监听抛错不影响广播与其它监听；关房后事件停止', () => {
  const { service, roomId, received, off } = setup();
  const offThrow = service.subscribeAll(() => {
    throw new Error('监听故意失败');
  });
  service.gmAlert(roomId, '广播继续');
  assert.equal(received.length >= 1, true);
  offThrow();
  service.closeRoom(roomId);
  const afterClose = received.length;
  assert.throws(() => service.gmAlert(roomId, '关房后不会再发'), /不存在|已关闭/);
  assert.equal(received.length, afterClose);
  off();
});
