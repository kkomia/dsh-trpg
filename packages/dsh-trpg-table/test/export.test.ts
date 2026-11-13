import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AwardPayload, GameEvent, RoomView } from '@dsh-trpg/protocol';
import {
  emptyGrowth,
  growthToCardPatch,
  loadGrowth,
  mergeGrowth,
  roomToMarkdown,
  saveGrowth,
} from '../src/client/export.ts';

function awardEvent(seq: number, xp: number, items: string[], note?: string): GameEvent<'award', AwardPayload> {
  return {
    v: 1,
    kind: 'award',
    seq,
    at: 1700000000000 + seq,
    to: 'p1',
    payload: { playerId: 'p1', playerName: '阿青', xp, items, note, private: true },
  };
}

test('mergeGrowth: 累计 XP/物品并去重同一事件', () => {
  let growth = emptyGrowth();
  growth = mergeGrowth(growth, 'room-1', awardEvent(5, 50, ['镇魂符']));
  growth = mergeGrowth(growth, 'room-1', awardEvent(9, 20, ['止血草', '镇魂符']));
  growth = mergeGrowth(growth, 'room-1', awardEvent(9, 20, ['止血草', '镇魂符'])); // 重放
  assert.equal(growth.xp, 70);
  assert.deepEqual(growth.items, ['镇魂符', '止血草', '镇魂符']);
  assert.equal(growth.awards.length, 2);
});

test('growthToCardPatch: 物品去重、备注可读', () => {
  let growth = emptyGrowth();
  growth = mergeGrowth(growth, 'room-1', awardEvent(1, 10, ['铜镜'], '初战'));
  const patch = growthToCardPatch(growth);
  assert.equal(patch.xp, 10);
  assert.deepEqual(patch.items, ['铜镜']);
  assert.ok(patch.note.includes('+10XP'));
});

test('loadGrowth/saveGrowth: 通过注入的 storage 往返', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const growth = mergeGrowth(null, 'room-9', awardEvent(3, 30, ['灵酒']));
  saveGrowth('room-9', 'p1', growth, storage);
  assert.equal(store.size, 1);
  const loaded = loadGrowth('room-9', 'p1', storage);
  assert.equal(loaded?.xp, 30);
  assert.deepEqual(loaded?.items, ['灵酒']);
  assert.equal(loadGrowth('room-9', 'other', storage), null);
});

test('roomToMarkdown: 包含叙事/骰子/场景/奖励', () => {
  const room: RoomView = {
    roomId: 'room-1',
    title: '鬼木崖·异光',
    phase: 'playing',
    gmMode: 'ai',
    locked: false,
    players: [{ playerId: 'p1', displayName: '阿青', seat: 'player', online: true, characterName: '阿青' }],
    scene: { sceneId: 'scene_guimuya', title: '枯木崖·古洞' },
    createdAt: 0,
  };
  const events: GameEvent[] = [
    { v: 1, kind: 'narration', seq: 1, at: 1700000000000, to: 'all', payload: { speaker: 'gm', text: '夜色压在青石镇上。' } },
    { v: 1, kind: 'dice', seq: 2, at: 1700000001000, to: 'all', payload: { expression: 'd20', dice: [12], modifier: 3, total: 15, label: '察觉检定', rollerName: '阿青', playerId: 'p1', private: false, check: { kind: 'skill', name: '察觉', dc: 10, success: true } } },
    { v: 1, kind: 'scene', seq: 3, at: 1700000002000, to: 'all', payload: { sceneId: 'scene_guimuya', title: '枯木崖·古洞', by: 'host' } },
    awardEvent(4, 50, ['镇魂符']),
  ];
  const markdown = roomToMarkdown(room, events);
  assert.ok(markdown.includes('# 跑团战报 · 鬼木崖·异光'));
  assert.ok(markdown.includes('夜色压在青石镇上。'));
  assert.ok(markdown.includes('察觉检定'));
  assert.ok(markdown.includes('成功（DC 10）'));
  assert.ok(markdown.includes('场景推进：枯木崖·古洞'));
  assert.ok(markdown.includes('+50 XP'));
});
