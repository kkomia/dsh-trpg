import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoomService, type Principal } from '@dsh-trpg/rooms';
import { RoomMirrorHub, type MirrorPlayerInfo } from '../src/host/mirror/hub.ts';
import type { MirrorFrame } from '../src/host/mirror/types.ts';

interface FrameRecord {
  principal: Principal;
  frame: MirrorFrame;
}

interface CloseRecord {
  principal: Principal;
  reason: string;
}

function framesOf(records: FrameRecord[], principal: Principal): MirrorFrame[] {
  return records
    .filter((record) => record.principal.kind === principal.kind
      && (record.principal.kind !== 'player' || principal.kind !== 'player' || record.principal.playerId === principal.playerId))
    .map((record) => record.frame);
}

function setup(options: { maxBuffer?: number; playersOf?: (roomId: string) => MirrorPlayerInfo[] } = {}) {
  const hubRef: { current: RoomMirrorHub | null } = { current: null };
  const service = new RoomService({
    maxRooms: 4,
    onRoomClosed: (closedRoomId) => hubRef.current?.disposeRoom(closedRoomId),
  });
  const created = service.createRoom({ title: '鬼木崖·异光', gmMode: 'ai' });
  const roomId = created.room.roomId;
  const inviteCode = created.inviteCode;
  const alice = service.join({ inviteCode, playerName: '阿青' });
  const bob = service.join({ inviteCode, playerName: '白露' });
  const alicePrincipal: Principal = service.login(alice.playerToken);
  const bobPrincipal: Principal = service.login(bob.playerToken);
  const hostPrincipal: Principal = service.login(created.hostToken);
  const hub = new RoomMirrorHub({
    playersOf: options.playersOf ?? ((id) => service.gmParty(id).map((player) => ({
      playerId: player.playerId,
      playerName: player.name,
    }))),
    maxBuffer: options.maxBuffer,
    now: (() => {
      let time = 1000;
      return () => {
        time += 10;
        return time;
      };
    })(),
  });
  hubRef.current = hub;
  const off = service.subscribeAll((id, event) => hub.onRoomEvent(id, event));
  hub.registerRoom(roomId, '鬼木崖·异光');
  hub.bindSession(roomId, 'session-gm');
  const frames: FrameRecord[] = [];
  const closes: CloseRecord[] = [];
  for (const principal of [hostPrincipal, alicePrincipal, bobPrincipal]) {
    hub.subscribe(principal, {
      frame: (frame) => frames.push({ principal, frame }),
      close: (reason) => closes.push({ principal, reason }),
    });
  }
  return {
    service,
    roomId,
    inviteCode,
    hub,
    frames,
    closes,
    alice,
    bob,
    alicePrincipal,
    bobPrincipal,
    hostPrincipal,
    off,
  };
}

test('镜像中枢：assistant 消息投影为公共旁白帧（所有订阅者收到）', () => {
  const { hub, frames, hostPrincipal, alicePrincipal, bobPrincipal } = setup();
  hub.onSessionEvent('session-gm', 'assistant/message', {
    message: { content: [{ type: 'reasoning', text: '内部思考' }, { type: 'text', text: '茶馆的门吱呀一声开了。' }] },
  });
  const hostFrames = framesOf(frames, hostPrincipal);
  assert.equal(hostFrames.length, 1);
  assert.equal(hostFrames[0]?.kind, 'narration');
  assert.equal((hostFrames[0]?.data as { text: string }).text, '茶馆的门吱呀一声开了。');
  assert.equal(framesOf(frames, alicePrincipal).length, 1);
  assert.equal(framesOf(frames, bobPrincipal).length, 1);
  // 只有 text 块进入镜像，reasoning 不外泄。
  assert.equal(JSON.stringify(hostFrames[0]).includes('内部思考'), false);
});

test('镜像中枢：GM 旁白回声去重（assistant → 房间 narration 只出一帧）', () => {
  const { hub, service, roomId, frames, hostPrincipal } = setup();
  hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '门开了。' }] } });
  service.gmNarrate(roomId, '门开了。'); // table-session 会把 assistant 文本再广播回房间
  service.gmNarrate(roomId, '世界书揭示：鬼木崖在村北。'); // 非回声（GM 工具旁白）
  const hostFrames = framesOf(frames, hostPrincipal);
  const narrations = hostFrames.filter((frame) => frame.kind === 'narration');
  assert.equal(narrations.length, 2);
  assert.equal((narrations[0]?.data as { text: string }).text, '门开了。');
  assert.match((narrations[1]?.data as { text: string }).text, /鬼木崖/);
});

test('镜像中枢：玩家公开行动以【角色名】投影并全桌可见', () => {
  const { hub, frames, roomId, alice, hostPrincipal, alicePrincipal, bobPrincipal } = setup();
  const injectedText = `【阿青】我推开门\n\n---\n\n【本轮 GM 幕后备注（玩家不可见，不要原样朗读）】\n- 判定：perception DC 12`;
  hub.noteInjectedAction(roomId, { roomId, playerId: alice.playerId, playerName: '阿青', text: '我推开门', private: false }, injectedText);
  hub.onSessionEvent('session-gm', 'user/message', { content: [{ type: 'text', text: injectedText }], source: { kind: 'user' } });
  const hostFrames = framesOf(frames, hostPrincipal);
  assert.equal(hostFrames.length, 1);
  assert.equal(hostFrames[0]?.kind, 'action');
  const action = hostFrames[0]?.data as { playerName: string; text: string };
  assert.equal(action.playerName, '阿青');
  assert.equal(action.text, '我推开门');
  // 幕后备注绝不进入镜像。
  assert.equal(JSON.stringify(hostFrames[0]).includes('幕后备注'), false);
  assert.equal(framesOf(frames, alicePrincipal).length, 1);
  assert.equal(framesOf(frames, bobPrincipal).length, 1);
});

test('镜像中枢：私密行动只投行动者 + GM，其他玩家收不到', () => {
  const { hub, frames, roomId, alice, hostPrincipal, alicePrincipal, bobPrincipal } = setup();
  const injectedText = '【阿青】我贴着墙走（悄悄话给 GM）\n\n---\n\n【本轮 GM 幕后备注';
  hub.noteInjectedAction(roomId, { roomId, playerId: alice.playerId, playerName: '阿青', text: '我贴着墙走', private: true }, injectedText);
  hub.onSessionEvent('session-gm', 'user/message', { content: [{ type: 'text', text: injectedText }], source: { kind: 'user' } });
  const hostFrames = framesOf(frames, hostPrincipal);
  assert.equal(hostFrames.length, 1);
  assert.equal((hostFrames[0]?.data as { private?: boolean }).private, true);
  assert.equal(framesOf(frames, alicePrincipal).length, 1);
  assert.equal(framesOf(frames, bobPrincipal).length, 0);
});

test('镜像中枢：房主在会话里手动输入不投给玩家（只投 GM，含幕后备注时去敏感）', () => {
  const { hub, frames, hostPrincipal, alicePrincipal } = setup();
  hub.onSessionEvent('session-gm', 'user/message', { content: [{ type: 'text', text: '【阿青】我推开门\n\n---\n\n【本轮 GM 幕后备注' }] });
  assert.equal(framesOf(frames, hostPrincipal).length, 1);
  assert.equal((framesOf(frames, hostPrincipal)[0]?.data as { text: string }).text, '【阿青】我推开门');
  assert.equal(framesOf(frames, alicePrincipal).length, 0);
});

test('镜像中枢：GM 私密旁白（gmSecret）只投目标玩家 + GM', () => {
  const { service, roomId, frames, alice, hostPrincipal, alicePrincipal, bobPrincipal } = setup();
  service.gmSecret(roomId, alice.playerId, '你摸到门后有活物的呼吸。');
  const hostFrames = framesOf(frames, hostPrincipal);
  assert.equal(hostFrames.length, 1);
  assert.equal(hostFrames[0]?.kind, 'narration');
  assert.equal((hostFrames[0]?.data as { private?: boolean }).private, true);
  assert.equal(framesOf(frames, alicePrincipal).length, 1);
  assert.equal(framesOf(frames, bobPrincipal).length, 0);
  assert.equal(JSON.stringify(framesOf(frames, bobPrincipal)).includes('活物'), false);
});

test('镜像中枢：公开骰全桌、私骰只投本人 + GM', () => {
  const { service, frames, alicePrincipal, bobPrincipal, hostPrincipal } = setup();
  service.roll(alicePrincipal, { expression: 'd20', label: '侦察' });
  service.roll(alicePrincipal, { expression: 'd20', label: '暗骰', private: true });
  const bobFrames = framesOf(frames, bobPrincipal);
  assert.equal(bobFrames.length, 1);
  assert.equal((bobFrames[0]?.data as { private: boolean }).private, false);
  assert.equal(framesOf(frames, alicePrincipal).length, 2);
  assert.equal(framesOf(frames, hostPrincipal).length, 2);
  const hostPrivates = framesOf(frames, hostPrincipal).filter((frame) => (frame.data as { private: boolean }).private === true);
  assert.equal(hostPrivates.length, 1);
});

test('镜像中枢：奖励只投目标玩家 + GM；场景通知全桌；普通 alert 不进镜像', () => {
  const { service, roomId, frames, alice, bobPrincipal, alicePrincipal, hostPrincipal } = setup();
  service.gmAward(roomId, alice.playerId, { xp: 50, items: ['青铜面具'], note: '首功' });
  service.gmScene(roomId, 'scene_02', '废弃道观');
  service.gmAlert(roomId, '随便一条普通提示');
  const bobFrames = framesOf(frames, bobPrincipal);
  assert.equal(bobFrames.some((frame) => frame.kind === 'award'), false);
  assert.equal(bobFrames.some((frame) => frame.kind === 'notice' && (frame.data as { text: string }).text.includes('废弃道观')), true);
  const aliceAward = framesOf(frames, alicePrincipal).find((frame) => frame.kind === 'award');
  assert.ok(aliceAward);
  assert.equal((aliceAward.data as { xp: number }).xp, 50);
  assert.equal(framesOf(frames, hostPrincipal).some((frame) => frame.kind === 'award'), true);
  assert.equal(bobFrames.some((frame) => (frame.data as { text?: string }).text === '随便一条普通提示'), false);
});

test('镜像中枢：战斗事件投影为一行战斗摘要（全桌）', () => {
  const { service, roomId, frames, hostPrincipal, bobPrincipal } = setup();
  service.gmCombat(roomId, {
    round: 2,
    activeId: 'pc1',
    activeName: '阿青',
    order: [
      { id: 'pc1', name: '阿青', kind: 'pc', hp: 10, maxHp: 10, ac: 12, downed: false, dead: false },
      { id: 'm1', name: '山魈', kind: 'monster', hp: 5, maxHp: 9, ac: 11, downed: false, dead: false },
    ],
  });
  const combat = framesOf(frames, hostPrincipal).find((frame) => frame.kind === 'combat');
  assert.ok(combat);
  assert.match((combat.data as { text: string }).text, /第 2 轮/);
  assert.match((combat.data as { text: string }).text, /阿青/);
  assert.equal(framesOf(frames, bobPrincipal).length, 1);
});

test('镜像中枢：trpg_secret_note 工具卡只给 GM，秘密内容只以私密旁白投目标玩家', () => {
  const { hub, service, roomId, frames, alice, hostPrincipal, alicePrincipal, bobPrincipal } = setup();
  hub.onSessionEvent('session-gm', 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-secret',
    name: 'trpg_secret_note',
    arguments: JSON.stringify({ playerName: '阿青', text: '门后有活物' }),
  });
  hub.onSessionEvent('session-gm', 'tool/result', {
    turn: 1,
    step: 1,
    message: { toolCallId: 'call-secret', role: 'tool', content: [{ type: 'text', text: '已私发 阿青：门后有活物' }], source: { kind: 'tool', callId: 'call-secret' } },
  });
  service.gmSecret(roomId, alice.playerId, '门后有活物');
  const hostTools = framesOf(frames, hostPrincipal).filter((frame) => frame.kind === 'tool');
  assert.equal(hostTools.length, 2);
  assert.equal(framesOf(frames, alicePrincipal).filter((frame) => frame.kind === 'tool').length, 0);
  const aliceNarration = framesOf(frames, alicePrincipal).filter((frame) => frame.kind === 'narration');
  assert.equal(aliceNarration.length, 1);
  assert.equal(JSON.stringify(framesOf(frames, bobPrincipal)).includes('门后有活物'), false);
  // 工具卡摘要里也不能带私密正文（只给 GM 也不重复录秘密）。
  const toolJson = JSON.stringify(hostTools);
  assert.equal(toolJson.includes('门后有活物'), false);
});

test('镜像中枢：GM 秘密工具（check_lore）只给 GM，公开工具 call/result 全桌且用摘要', () => {
  const { hub, frames, hostPrincipal, alicePrincipal, bobPrincipal } = setup();
  hub.onSessionEvent('session-gm', 'tool/call', {
    callId: 'call-lore', name: 'trpg_check_lore', arguments: JSON.stringify({ query: '鬼木崖 真身' }), turn: 1, step: 1,
  });
  assert.equal(framesOf(frames, hostPrincipal).filter((frame) => frame.kind === 'tool').length, 1);
  assert.equal(framesOf(frames, alicePrincipal).filter((frame) => frame.kind === 'tool').length, 0);

  hub.onSessionEvent('session-gm', 'tool/call', {
    callId: 'call-roll', name: 'trpg_roll_check', arguments: JSON.stringify({ actorId: '阿青', skill: 'perception', dc: 12 }), turn: 1, step: 1,
  });
  hub.onSessionEvent('session-gm', 'tool/result', {
    message: { toolCallId: 'call-roll', role: 'tool', content: [{ type: 'text', text: '阿青的侦察检定：d20=[15] + 2 = 17 vs DC 12 → 成功' }], source: { kind: 'tool', callId: 'call-roll' } },
    turn: 1, step: 1,
  });
  const bobTools = framesOf(frames, bobPrincipal).filter((frame) => frame.kind === 'tool');
  assert.equal(bobTools.length, 2);
  assert.match((bobTools[0]?.data as { summary: string }).summary, /DC 12/);
  assert.match((bobTools[1]?.data as { summary: string }).summary, /成功/);
  assert.equal((bobTools[0]?.data as { phase: string }).phase, 'call');
  assert.equal((bobTools[1]?.data as { phase: string }).phase, 'result');
});

test('镜像中枢：非跑团桌工具与未知 callId 结果都不进镜像', () => {
  const { hub, frames, hostPrincipal } = setup();
  hub.onSessionEvent('session-gm', 'tool/call', { callId: 'call-pwsh', name: 'pwsh', arguments: '{"command":"dir"}', turn: 1, step: 1 });
  hub.onSessionEvent('session-gm', 'tool/call', { callId: 'call-read', name: 'read', arguments: '{"file_path":"a.ts"}', turn: 1, step: 1 });
  hub.onSessionEvent('session-gm', 'tool/result', { message: { toolCallId: 'call-unknown', content: [{ type: 'text', text: 'x' }] }, turn: 1, step: 1 });
  assert.equal(framesOf(frames, hostPrincipal).length, 0);
});

test('镜像中枢：seq 单调递增，私密帧让无权限玩家的重放出现跳号（预期行为）', () => {
  const { service, roomId, hub, alice, frames, bobPrincipal, hostPrincipal } = setup();
  service.gmNarrate(roomId, '公开一');
  service.gmSecret(roomId, alice.playerId, '秘密二');
  service.gmNarrate(roomId, '公开三');
  const hostFrames = framesOf(frames, hostPrincipal);
  assert.deepEqual(hostFrames.map((frame) => frame.seq), [1, 2, 3]);
  const bobFrames = framesOf(frames, bobPrincipal);
  assert.deepEqual(bobFrames.map((frame) => frame.seq), [1, 3]);
  // hub 的缓冲按 seq 重放缓存的原始帧，按 principal 再过滤。
  const hostReplay = hub.eventsSince(hostPrincipal, 0);
  assert.deepEqual(hostReplay.map((frame) => frame.seq), [1, 2, 3]);
  const bobReplay = hub.eventsSince(bobPrincipal, 1);
  assert.deepEqual(bobReplay.map((frame) => frame.seq), [3]);
});

test('镜像中枢：环形缓冲淘汰最旧帧，重放窗口用 seqRange 表达', () => {
  const { hub, roomId, hostPrincipal } = setup({ maxBuffer: 3 });
  for (let index = 1; index <= 5; index += 1) {
    hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: `第 ${index} 段` }] } });
  }
  assert.equal(hub.bufferedCount(roomId), 3);
  assert.deepEqual(hub.seqRange(roomId), { oldest: 3, latest: 5 });
  const replay = hub.eventsSince(hostPrincipal, 0).map((frame) => frame.seq);
  assert.deepEqual(replay, [3, 4, 5]);
});

test('镜像中枢：订阅可取消，取消后不再收到帧；disposeRoom 关闭连接并清空房间', () => {
  const { hub, service, roomId, frames, closes, hostPrincipal } = setup();
  const received: MirrorFrame[] = [];
  const off = hub.subscribe(hostPrincipal, { frame: (frame) => received.push(frame), close: () => {} });
  hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '第一帧' }] } });
  assert.equal(received.length, 1);
  off();
  hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '第二帧' }] } });
  assert.equal(received.length, 1);
  assert.equal(framesOf(frames, hostPrincipal).length, 2);

  service.closeRoom(roomId);
  assert.equal(hub.hasRoom(roomId), false);
  assert.equal(closes.length, 3);
  assert.match(closes[0]?.reason ?? '', /关闭/);
});

test('镜像中枢：插件卸载 dispose() 关闭所有订阅并清空缓冲', () => {
  const { hub, roomId, closes, hostPrincipal } = setup();
  hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '一帧' }] } });
  hub.dispose();
  assert.equal(closes.length, 3);
  assert.match(closes[0]?.reason ?? '', /停止/);
  assert.equal(hub.hasRoom(roomId), false);
  assert.deepEqual(hub.eventsSince(hostPrincipal, 0), []);
});

test('镜像中枢：解绑会话后不再消费会话事件；未绑定房间的玩家旁白回退为行动帧', () => {
  const { hub, service, roomId, frames, alicePrincipal, hostPrincipal } = setup();
  hub.unbindSession(roomId);
  const before = framesOf(frames, hostPrincipal).length;
  hub.onSessionEvent('session-gm', 'assistant/message', { message: { content: [{ type: 'text', text: '不该出现' }] } });
  assert.equal(framesOf(frames, hostPrincipal).length, before);

  service.say(alicePrincipal, { text: '大家好' });
  const hostFrames = framesOf(frames, hostPrincipal);
  const action = hostFrames.find((frame) => frame.kind === 'action');
  assert.ok(action);
  assert.equal((action.data as { playerName: string }).playerName, '阿青');
  assert.equal(framesOf(frames, alicePrincipal).some((frame) => frame.kind === 'action'), true);
});

test('镜像中枢：私聊 GM（悄悄话）在未绑定会话时只投 GM', () => {
  const { hub, service, roomId, frames, alicePrincipal, bobPrincipal, hostPrincipal } = setup();
  hub.unbindSession(roomId);
  service.say(alicePrincipal, { text: '我悄悄告诉 GM', private: true });
  const hostAction = framesOf(frames, hostPrincipal).find((frame) => frame.kind === 'action');
  assert.ok(hostAction);
  assert.equal(framesOf(frames, bobPrincipal).length, 0);
  assert.equal(framesOf(frames, alicePrincipal).length, 0);
});

test('镜像中枢：trpg_secret_note 目标解析支持角色名（playersOf 注入）', () => {
  const service = new RoomService({ maxRooms: 2 });
  const created = service.createRoom({ title: '角色名局', gmMode: 'ai' });
  const roomId = created.room.roomId;
  const alice = service.join({ inviteCode: created.inviteCode, playerName: '阿青' });
  const bob = service.join({ inviteCode: created.inviteCode, playerName: '白露' });
  const hub = new RoomMirrorHub({
    playersOf: () => [
      { playerId: alice.playerId, playerName: '阿青', characterName: '青衣客' },
      { playerId: bob.playerId, playerName: '白露', characterName: '白露' },
    ],
  });
  hub.registerRoom(roomId);
  hub.bindSession(roomId, 'session-gm');
  const aliceFrames: MirrorFrame[] = [];
  hub.subscribe(service.login(alice.playerToken), { frame: (frame) => aliceFrames.push(frame), close: () => {} });
  hub.onSessionEvent('session-gm', 'tool/call', {
    callId: 'call-secret', name: 'trpg_secret_note', arguments: JSON.stringify({ playerName: '青衣客', text: '只有你知道' }), turn: 1, step: 1,
  });
  // 工具卡本身只给 GM（目标玩家由房间私密旁白拿到内容），因此这里目标玩家 0 帧。
  assert.equal(aliceFrames.length, 0);
});
