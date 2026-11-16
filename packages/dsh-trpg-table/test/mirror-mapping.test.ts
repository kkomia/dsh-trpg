import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  closeMirrorTurn,
  createMirrorMapState,
  mapMirrorFrame,
  MIRROR_SESSION_EVENT_TYPES,
  mirrorGapNoticeEvent,
  mirrorTitleEvent,
  type MirrorMapState,
  type MirrorSessionEventInput,
} from '../src/host/mirror/mapping.ts';
import type { MirrorFrame } from '../src/host/mirror/types.ts';

const createId = (() => {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
})();

function map(frame: MirrorFrame, state: MirrorMapState = createMirrorMapState()): MirrorSessionEventInput[] {
  return mapMirrorFrame(frame, state, { createId });
}

test('会话事件白名单：只包含 DSH 已知事件类型', () => {
  assert.deepEqual([...MIRROR_SESSION_EVENT_TYPES], [
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'session/title',
  ]);
});

test('映射：GM 叙事开新 turn；第二条叙事换新 step（DSH 每个 turn:step 只渲染一条 assistant）', () => {
  const state = createMirrorMapState();
  const first = map({ v: 1, seq: 1, at: 1, kind: 'narration', data: { text: '第一段' } }, state);
  assert.deepEqual(first.map((event) => event.type), ['turn/start', 'step/start', 'assistant/message']);
  assert.deepEqual(first[0]?.data, { turn: 1 });
  assert.equal((first[2]?.data as { turn: number }).turn, 1);
  assert.equal((first[2]?.data as { step: number }).step, 1);
  const second = map({ v: 1, seq: 2, at: 2, kind: 'narration', data: { text: '第二段' } }, state);
  assert.deepEqual(second.map((event) => event.type), ['step/end', 'step/start', 'assistant/message']);
  assert.deepEqual(second[0]?.data, { turn: 1, step: 1 });
  assert.deepEqual(second[1]?.data, { turn: 1, step: 2 });
  const message = second[2]?.data as { turn: number; step: number; message: { content: Array<{ text: string }> } };
  assert.equal(message.turn, 1);
  assert.equal(message.step, 2);
  assert.equal(message.message.content[0]?.text, '第二段');
});

test('映射：玩家行动先收 turn 写 step/end+turn/end，再写用户气泡（【角色名】）', () => {
  const state = createMirrorMapState();
  map({ v: 1, seq: 1, at: 1, kind: 'narration', data: { text: '门开了' } }, state);
  const action = map({ v: 1, seq: 2, at: 2, kind: 'action', data: { playerId: 'p1', playerName: '阿青', characterName: '青衣客', text: '我推开门' } }, state);
  assert.deepEqual(action.map((event) => event.type), ['step/end', 'turn/end', 'user/message']);
  const user = action[2];
  assert.equal((user?.data.content as Array<{ text: string }>)[0]?.text, '【青衣客】我推开门');
  assert.equal((user?.data.source as { kind: string }).kind, 'user');
  assert.equal(user?.surfaceOp, 'append');
  assert.equal(state.turn, undefined);
  // 下一条 GM 叙事重新开 turn 2。
  const next = map({ v: 1, seq: 3, at: 3, kind: 'narration', data: { text: '继续' } }, state);
  assert.equal((next[0]?.data as { turn: number }).turn, 2);
});

test('映射：工具 call/result 成对写入，result 沿用 call 所在 turn', () => {
  const state = createMirrorMapState();
  map({ v: 1, seq: 1, at: 1, kind: 'narration', data: { text: '先叙事' } }, state);
  const call = map({ v: 1, seq: 2, at: 2, kind: 'tool', data: { phase: 'call', callId: 'c1', name: 'roll_check', summary: '检定：阿青 perception vs DC 12' } }, state);
  assert.deepEqual(call.map((event) => event.type), ['step/end', 'step/start', 'tool/call']);
  assert.equal(String(call[2]?.data.name), 'trpg_roll_check');
  const result = map({ v: 1, seq: 3, at: 3, kind: 'tool', data: { phase: 'result', callId: 'c1', name: 'roll_check', summary: '成功' } }, state);
  assert.deepEqual(result.map((event) => event.type), ['tool/result']);
  assert.equal((result[0]?.data as { turn: number }).turn, 1);
  assert.equal((result[0]?.data as { message: { toolCallId: string } }).message.toolCallId, 'c1');
  assert.equal(result[0]?.surfaceOp, 'append');
});

test('映射：工具结果没有对应 call 时在当前 turn 落一条 tool/result', () => {
  const state = createMirrorMapState();
  const result = map({ v: 1, seq: 1, at: 1, kind: 'tool', data: { phase: 'result', callId: 'orphan', name: 'combat', summary: '战斗继续' } }, state);
  assert.deepEqual(result.map((event) => event.type), ['turn/start', 'step/start', 'tool/result']);
  assert.equal((result[2]?.data as { message: { toolCallId: string } }).message.toolCallId, 'orphan');
});

test('映射：错误工具结果带 isError；掷骰/战斗合成工具卡', () => {
  const state = createMirrorMapState();
  const error = map({ v: 1, seq: 1, at: 1, kind: 'tool', data: { phase: 'error', callId: 'c9', name: 'roll_check', summary: '工具错误：超时' } }, state);
  const result = error.find((event) => event.type === 'tool/result');
  assert.equal((result?.data as { message: { isError?: boolean } }).message.isError, true);
  assert.match(String(((result?.data as { message: { content: Array<{ text: string }> } }).message.content)[0]?.text), /超时/);

  const dice = map({
    v: 1,
    seq: 2,
    at: 2,
    kind: 'dice',
    data: { expression: 'd20', dice: [10], modifier: 2, total: 12, rollerName: '阿青', private: false, check: { kind: 'skill', name: 'perception', dc: 12, success: true } },
  }, state);
  assert.deepEqual(dice.map((event) => event.type), ['step/end', 'step/start', 'tool/call', 'tool/result']);
  assert.match(JSON.stringify(dice[3]?.data), /DC 12 → 成功/);

  const combat = map({ v: 1, seq: 3, at: 3, kind: 'combat', data: { text: '⚔️ 战斗 · 第 2 轮' } }, state);
  assert.deepEqual(combat.map((event) => event.type), ['step/end', 'step/start', 'tool/call', 'tool/result']);
  assert.match(JSON.stringify(combat[3]?.data), /第 2 轮/);
});

test('映射：空叙事/未知 kind 不产生事件', () => {
  const state = createMirrorMapState();
  assert.deepEqual(map({ v: 1, seq: 1, at: 1, kind: 'narration', data: { text: '   ' } }, state), []);
  assert.deepEqual(state.turn, undefined);
  const unknown = { v: 1, seq: 2, at: 2, kind: 'mystery', data: {} } as unknown as MirrorFrame;
  assert.deepEqual(map(unknown, state), []);
});

test('映射：closeMirrorTurn 只在有打开的 turn 时收尾；gap/title 事件形状固定', () => {
  const state = createMirrorMapState();
  assert.deepEqual(closeMirrorTurn(state), []);
  map({ v: 1, seq: 1, at: 1, kind: 'narration', data: { text: '一段' } }, state);
  const closed = closeMirrorTurn(state);
  assert.deepEqual(closed.map((event) => event.type), ['step/end', 'turn/end']);
  assert.deepEqual(closed[1]?.data, { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(closeMirrorTurn(state), []);

  const gap = mirrorGapNoticeEvent(5, { createId });
  assert.equal(gap.type, 'user/message');
  assert.equal((gap.data.source as { kind: string }).kind, 'system');
  assert.match((gap.data.content as Array<{ text: string }>)[0]?.text ?? '', /5 条/);

  const title = mirrorTitleEvent('鬼木崖·异光');
  assert.equal(title.type, 'session/title');
  assert.equal(title.data.title, '跑团桌：鬼木崖·异光');
  assert.deepEqual(title.data.messageSeqs, []);
  assert.deepEqual(title.data.source, { kind: 'user' });
  assert.equal(title.surfaceOp, undefined);
});
