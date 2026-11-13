import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, validateClientMessage } from '../src/index.ts';

const base = { v: PROTOCOL_VERSION, id: 'msg-1' };

test('validate: accepts a well-formed hello', () => {
  const result = validateClientMessage({ ...base, type: 'hello', payload: { roomId: 'room-1' } });
  assert.equal(result.ok, true);
  assert.equal(result.value?.type, 'hello');
});

test('validate: rejects missing id / unknown version / unknown type', () => {
  assert.equal(validateClientMessage({ ...base, id: '', type: 'hello', payload: {} }).ok, false);
  assert.equal(validateClientMessage({ v: 99, id: 'x', type: 'hello', payload: {} }).ok, false);
  assert.equal(validateClientMessage({ ...base, type: 'explode', payload: {} }).ok, false);
});

test('validate: join requires inviteCode, playerName, clientVersion', () => {
  const player = { inviteCode: '7F3K9Q', playerName: '阿青', clientVersion: '0.0.1' };
  assert.equal(validateClientMessage({ ...base, type: 'join', payload: player }).ok, true);
  assert.equal(validateClientMessage({ ...base, type: 'join', payload: { ...player, inviteCode: '' } }).ok, false);
  assert.equal(validateClientMessage({ ...base, type: 'join', payload: { ...player, playerName: 3 } }).ok, false);
});

test('validate: action text is required and bounded to 2000 chars', () => {
  assert.equal(validateClientMessage({ ...base, type: 'action', payload: { text: '我推开门' } }).ok, true);
  assert.equal(validateClientMessage({ ...base, type: 'action', payload: { text: '' } }).ok, false);
  assert.equal(validateClientMessage({ ...base, type: 'action', payload: { text: 'x'.repeat(2001) } }).ok, false);
  assert.equal(
    validateClientMessage({ ...base, type: 'action', payload: { text: '攻击', tags: ['attack'] } }).ok,
    true,
  );
  assert.equal(
    validateClientMessage({ ...base, type: 'action', payload: { text: '攻击', tags: [1] } }).ok,
    false,
  );
});
