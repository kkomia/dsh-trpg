import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomService } from '@dsh-trpg/rooms';
import { RoomPersistence, defaultRoomsDir } from '../src/host/persistence.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-trpg-persist-'));
}

test('persistence: 写入快照后可由新服务完整恢复（含 token / 事件 / 场景）', () => {
  const dir = tempDir();
  try {
    const service = new RoomService({ now: () => 1000 });
    const created = service.createRoom({ title: '鬼木崖·异光', gmMode: 'ai' });
    const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青' });
    const player = service.login(joined.playerToken);
    service.roll(player, { expression: '2d6+1' });
    service.gmScene(created.room.roomId, 'scene_shendong', '古洞深处');

    const persistence = new RoomPersistence({ dir, debounceMs: 1 });
    persistence.attach(service);
    persistence.close(); // flush

    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0]?.endsWith('.json'));

    const restoredService = new RoomService();
    const persistence2 = new RoomPersistence({ dir });
    const restored = persistence2.restoreInto(restoredService);
    assert.equal(restored, 1);
    const host = restoredService.login(created.hostToken);
    const view = restoredService.state(host).room;
    assert.equal(view.title, '鬼木崖·异光');
    assert.equal(view.scene?.sceneId, 'scene_shendong');
    assert.equal(view.players.length, 1);
    assert.ok(restoredService.login(joined.playerToken));
    assert.ok(restoredService.eventsSince(host, 0).length >= 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistence: flush 清理已不存在的房间文件', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'ghost-room.json'), '{"schemaVersion":1,"savedAt":0,"room":null}', 'utf8');
    const service = new RoomService();
    service.createRoom({ title: '只留这间', gmMode: 'human' });
    const persistence = new RoomPersistence({ dir });
    persistence.attach(service);
    persistence.flush();
    const files = readdirSync(dir);
    assert.equal(files.includes('ghost-room.json'), false);
    assert.equal(files.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultRoomsDir: 跟随 DSH_HOME / DSH_PROFILE', () => {
  const dir = defaultRoomsDir({ DSH_HOME: 'C:/dsh-home', DSH_PROFILE: 'trpg' } as NodeJS.ProcessEnv);
  assert.ok(dir.includes('dsh-home'));
  assert.ok(dir.includes('trpg'));
  assert.ok(dir.endsWith('rooms'));
});
