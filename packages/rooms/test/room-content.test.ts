import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomError, RoomService, type RoomContentModule, type RoomContentResolver, type RoomSnapshot } from '../src/index.ts';

/**
 * 内容解析器桩：模拟 host 的 pack registry（内置包 core-guimuya + 数据目录包 other-pack）。
 * 场景只给公开摘要，验证房间不会把模组内容复制进视图。
 */
function makeResolver(): RoomContentResolver & {
  modules: Map<string, RoomContentModule>;
  defaults: Map<string, string>;
  add(packId: string, moduleId: string, title: string, version?: string, contentHash?: string): void;
  removePack(packId: string): void;
} {
  const modules = new Map<string, RoomContentModule>();
  const defaults = new Map<string, string>();
  const add = (packId: string, moduleId: string, title: string, version = '1.0.0', contentHash = `hash-${packId}`) => {
    defaults.set(packId, moduleId);
    modules.set(`${packId}/${moduleId}`, {
      packId,
      packVersion: version,
      packName: `包·${packId}`,
      moduleId,
      moduleTitle: title,
      contentHash,
      scenes: [
        { sceneId: 'scene_qingshi', title: '青石镇·悬赏' },
        { sceneId: 'scene_guimuya', title: '枯木崖·古洞' },
      ],
    });
  };
  add('core-guimuya', 'guimuya', '鬼木崖·异光');
  add('other-pack', 'other-module', '另一模组');
  const resolver = {
    defaultPackId: 'core-guimuya',
    modules,
    defaults,
    add,
    resolveModule(packId: string, moduleId?: string): RoomContentModule | undefined {
      const target = moduleId?.trim() || defaults.get(packId);
      return target ? modules.get(`${packId}/${target}`) : undefined;
    },
    hasPack(packId: string): boolean {
      return defaults.has(packId);
    },
    removePack(packId: string): void {
      for (const key of [...modules.keys()]) if (key.startsWith(`${packId}/`)) modules.delete(key);
      defaults.delete(packId);
    },
  };
  return resolver;
}

function snapshotOf(service: RoomService): RoomSnapshot {
  const snapshot = service.snapshotAll()[0];
  assert.ok(snapshot, 'expected one room snapshot');
  return snapshot;
}

test('room.create: 缺省 = 解析器默认包默认模组，视图带 content 与公开 scenes', () => {
  const service = new RoomService({ content: makeResolver() });
  const created = service.createRoom({ title: '鬼木崖·异光', gmMode: 'ai' });
  assert.deepEqual(
    { packId: created.room.content?.packId, packVersion: created.room.content?.packVersion, moduleId: created.room.content?.moduleId },
    { packId: 'core-guimuya', packVersion: '1.0.0', moduleId: 'guimuya' },
  );
  assert.equal(created.room.content?.moduleTitle, '鬼木崖·异光');
  assert.equal(created.room.content?.packName, '包·core-guimuya');
  assert.equal(created.room.content?.degraded, undefined);
  assert.deepEqual(created.room.scenes, [
    { sceneId: 'scene_qingshi', title: '青石镇·悬赏' },
    { sceneId: 'scene_guimuya', title: '枯木崖·古洞' },
  ]);
  // 场景摘要只含公开字段（不含 entry/checks/encounters 等模组内容）
  assert.deepEqual(Object.keys(created.room.scenes?.[0] ?? {}).sort(), ['sceneId', 'title']);
});

test('room.create: 显式 packId/moduleId 生效，玩家视图同样带 content/scenes', () => {
  const service = new RoomService({ content: makeResolver() });
  const created = service.createRoom({ title: '另一团', gmMode: 'human', packId: 'other-pack', moduleId: 'other-module' });
  assert.equal(created.room.content?.packId, 'other-pack');
  assert.equal(created.room.content?.moduleId, 'other-module');
  assert.equal(created.room.content?.moduleTitle, '另一模组');
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青' });
  assert.equal(joined.room.content?.packId, 'other-pack');
  assert.equal(joined.room.scenes?.length, 2);
});

test('room.create: 不存在的包/模组给中文 bad-request 错误', () => {
  const service = new RoomService({ content: makeResolver() });
  assert.throws(
    () => service.createRoom({ title: 'x', gmMode: 'ai', packId: 'missing-pack' }),
    (error: unknown) =>
      error instanceof RoomError && error.code === 'bad-request' && /内容包/.test(error.message) && /missing-pack/.test(error.message),
  );
  assert.throws(
    () => service.createRoom({ title: 'x', gmMode: 'ai', packId: 'core-guimuya', moduleId: 'missing-module' }),
    (error: unknown) => error instanceof RoomError && error.code === 'bad-request' && /没有模组/.test(error.message),
  );
  assert.equal(service.roomCount(), 0, '校验失败不能留下半截房间');
});

test('snapshot/restore: 内容引用（packId/moduleId/hash/scenes）完整保留', () => {
  const resolver = makeResolver();
  const service = new RoomService({ content: resolver });
  const created = service.createRoom({ title: '续团', gmMode: 'ai', packId: 'other-pack' });
  const snapshot = snapshotOf(service);
  assert.equal(snapshot.room.content?.packId, 'other-pack');
  assert.equal(snapshot.room.content?.moduleId, 'other-module');
  assert.equal(snapshot.room.content?.contentHash, 'hash-other-pack');
  assert.equal(snapshot.room.content?.scenes?.length, 2);

  const restored = new RoomService({ content: resolver });
  assert.equal(restored.restore(snapshot), true);
  const view = restored.state(restored.login(created.hostToken)).room;
  assert.equal(view.content?.packId, 'other-pack');
  assert.equal(view.content?.moduleId, 'other-module');
  assert.equal(view.content?.degraded, undefined);
  assert.equal(restored.gmContent(created.room.roomId).contentHash, 'hash-other-pack');
});

test('restore: 包缺失时降级恢复（degraded + GM 警告），房间仍可进人可继续', () => {
  const resolver = makeResolver();
  const first = new RoomService({ content: resolver });
  const created = first.createRoom({ title: '丢包团', gmMode: 'ai' });
  const snapshot = snapshotOf(first);

  resolver.removePack('core-guimuya');
  const restored = new RoomService({ content: resolver });
  assert.equal(restored.restore(snapshot), true);
  const host = restored.login(created.hostToken);
  const view = restored.state(host).room;
  assert.equal(view.content?.degraded, true);
  assert.equal(view.content?.packId, 'core-guimuya');
  assert.equal(view.content?.moduleTitle, '鬼木崖·异光', '降级时保留快照里的最后已知标题');

  const alerts = restored.eventsSince(host, 0).filter((event) => event.kind === 'alert');
  const warning = alerts.find((event) => (event.payload as { level?: string }).level === 'warning');
  assert.ok(warning, '应有一条 GM 降级警告');
  assert.match((warning?.payload as { text: string }).text, /降级|不可用/);
  assert.equal(restored.gmContent(created.room.roomId).degraded, true);

  // 房间不卡死：玩家仍能加入，社交/掷骰照常
  const joined = restored.join({ inviteCode: snapshot.room.inviteCode, playerName: '阿青' });
  const player = restored.login(joined.playerToken);
  assert.ok(restored.roll(player, { expression: 'd20' }).event.seq > 0);
});

test('restore: 旧快照没有 content 字段时视为内置包默认模组（向后兼容）', () => {
  const resolver = makeResolver();
  const first = new RoomService({ content: resolver });
  const created = first.createRoom({ title: '旧档', gmMode: 'ai' });
  const legacy = JSON.parse(JSON.stringify(snapshotOf(first))) as RoomSnapshot;
  delete legacy.room.content;

  const restored = new RoomService({ content: resolver });
  assert.equal(restored.restore(legacy), true);
  const view = restored.state(restored.login(created.hostToken)).room;
  assert.equal(view.content?.packId, 'core-guimuya');
  assert.equal(view.content?.moduleId, 'guimuya');
  assert.equal(view.content?.degraded, undefined);
  assert.equal(view.scenes?.length, 2, '旧档也要补回场景下拉数据');
});

test('restore: 内容版本漂移时按本机内容继续并标 degraded', () => {
  const resolver = makeResolver();
  const first = new RoomService({ content: resolver });
  const created = first.createRoom({ title: '漂移', gmMode: 'ai' });
  const snapshot = snapshotOf(first);

  // 本机包升级到 1.1.0（同 packId/moduleId，hash 也变了）
  const upgraded = makeResolver();
  const module = upgraded.modules.get('core-guimuya/guimuya');
  assert.ok(module);
  upgraded.modules.set('core-guimuya/guimuya', { ...module, packVersion: '1.1.0', contentHash: 'hash-core-v2' });

  const restored = new RoomService({ content: upgraded });
  assert.equal(restored.restore(snapshot), true);
  const view = restored.state(restored.login(created.hostToken)).room;
  assert.equal(view.content?.degraded, true);
  assert.equal(view.content?.packVersion, '1.1.0', '按本机内容继续');
  const warning = restored
    .eventsSince(restored.login(created.hostToken), 0)
    .find((event) => event.kind === 'alert' && (event.payload as { level?: string }).level === 'warning');
  assert.match((warning?.payload as { text: string }).text, /已变化/);
});

test('revalidateContent: 重扫后降级房间恢复原引用并清除 degraded', () => {
  const resolver = makeResolver();
  const first = new RoomService({ content: resolver });
  const created = first.createRoom({ title: '重扫恢复', gmMode: 'ai' });
  const snapshot = snapshotOf(first);
  resolver.removePack('core-guimuya');

  const restored = new RoomService({ content: resolver });
  restored.restore(snapshot);
  assert.equal(restored.gmContent(created.room.roomId).degraded, true);

  // 模拟导入 .trpgpack 后 content.reload：包又回来了（同版本同内容指纹）
  resolver.add('core-guimuya', 'guimuya', '鬼木崖·异光', '1.0.0', 'hash-core-guimuya');
  assert.deepEqual(restored.revalidateContent(), { recovered: 1 });
  assert.equal(restored.gmContent(created.room.roomId).degraded, undefined);
  const view = restored.state(restored.login(created.hostToken)).room;
  assert.equal(view.content?.moduleTitle, '鬼木崖·异光');
  assert.equal(view.content?.degraded, undefined);
});

test('未注入解析器时（旧调用/单测）：缺省引用照常记账，显式引用标记降级', () => {
  const service = new RoomService();
  const plain = service.createRoom({ title: '旧调用', gmMode: 'ai' });
  assert.equal(plain.room.content?.packId, 'core-guimuya');
  assert.equal(plain.room.content?.moduleId, 'guimuya');
  assert.equal(plain.room.content?.degraded, undefined);

  const explicit = service.createRoom({ title: '显式', gmMode: 'ai', packId: 'not-loaded' });
  assert.equal(explicit.room.content?.packId, 'not-loaded');
  assert.equal(explicit.room.content?.degraded, true);
});
