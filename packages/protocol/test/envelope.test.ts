import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  validateRpcRequest,
  validateCreateRoom,
  validateJoin,
  validateRoll,
  validateSay,
  encodeSseEvent,
  type GameEvent,
} from '../src/index.ts';

test('validateRpcRequest: accepts known methods and rejects unknown ones', () => {
  assert.equal(validateRpcRequest({ method: 'room.roll', params: { expression: 'd20' } }).ok, true);
  assert.equal(validateRpcRequest({ method: 'room.delete', params: {} }).ok, false);
  assert.equal(validateRpcRequest({ method: 'room.roll', params: [] }).ok, false);
  assert.equal(validateRpcRequest({ method: 'room.roll', token: 42, params: {} }).ok, false);
});

test('validateCreateRoom: requires title and gmMode', () => {
  assert.equal(validateCreateRoom({ title: '鬼木崖', gmMode: 'ai' }).ok, true);
  assert.equal(validateCreateRoom({ title: '', gmMode: 'ai' }).ok, false);
  assert.equal(validateCreateRoom({ title: 'x', gmMode: 'robot' }).ok, false);
  assert.equal(validateCreateRoom({ title: 'x'.repeat(61), gmMode: 'ai' }).ok, false);
});

test('validateJoin: requires invite code and player name', () => {
  assert.equal(validateJoin({ inviteCode: '7F3K9Q', playerName: '阿青' }).ok, true);
  assert.equal(validateJoin({ inviteCode: '7F3K9Q' }).ok, false);
  assert.equal(validateJoin({ inviteCode: '7F3K9Q', playerName: 'x'.repeat(31) }).ok, false);
});

test('validateRoll: expression required and bounded', () => {
  assert.equal(validateRoll({ expression: '2d6+3' }).ok, true);
  assert.equal(validateRoll({ expression: '' }).ok, false);
  assert.equal(validateRoll({ expression: 'x'.repeat(41) }).ok, false);
  assert.equal(validateRoll({ expression: 'd20', private: 'yes' }).ok, false);
});

test('validateSay: text required, private boolean', () => {
  assert.equal(validateSay({ text: '我推开门' }).ok, true);
  assert.equal(validateSay({ text: '' }).ok, false);
  assert.equal(validateSay({ text: 'x'.repeat(3001) }).ok, false);
  assert.equal(validateSay({ text: '悄悄话', private: true }).ok, true);
});

test('encodeSseEvent: emits SSE frame with JSON payload', () => {
  const event: GameEvent = {
    v: PROTOCOL_VERSION,
    kind: 'dice',
    seq: 3,
    at: 1,
    to: 'all',
    payload: { expression: 'd20', dice: [20], modifier: 0, total: 20 },
  };
  const frame = encodeSseEvent(event);
  assert.ok(frame.startsWith('event: game\ndata: '));
  assert.ok(frame.endsWith('\n\n'));
  const parsed = JSON.parse(frame.slice('event: game\ndata: '.length).trim());
  assert.equal(parsed.seq, 3);
});
