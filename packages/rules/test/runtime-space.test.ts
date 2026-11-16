/** M9.2：zone-grid 场地——距离四模式、Bresenham 视线、地形/障碍/出生点、移动。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpaceRuntime,
  bandForCellsDistance,
  bandForZoneHops,
  bresenhamLine,
  distanceBetween,
} from '../src/index.ts';
import {
  addActor,
  clonePack,
  createRuntime,
  expectErr,
  expectOk,
  makeCard,
} from './runtime-helpers.ts';

// ---------------------------------------------------------------------------
// 距离四模式
// ---------------------------------------------------------------------------

test('距离：chebyshev 八方向同耗', () => {
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 2 }, 'chebyshev'), 3);
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 2, y: 2 }, 'chebyshev'), 2);
});

test('距离：manhattan 四方向', () => {
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 2 }, 'manhattan'), 5);
  assert.equal(distanceBetween({ x: 2, y: 2 }, { x: 2, y: 2 }, 'manhattan'), 0);
});

test('距离：dnd5e 斜向 5-10-5（max + floor(min/2)）', () => {
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, 'dnd5e'), 1);
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 1, y: 1 }, 'dnd5e'), 1);
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 2, y: 2 }, 'dnd5e'), 3);
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 3 }, 'dnd5e'), 4);
});

test('距离：euclid 斜向按 √2 取整', () => {
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 }, 'euclid'), 5);
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 1, y: 1 }, 'euclid'), 1);
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 2, y: 2 }, 'euclid'), 3);
});

test('距离：档位映射（格子 / 区域跳数）', () => {
  assert.equal(bandForCellsDistance(0), 'engaged');
  assert.equal(bandForCellsDistance(1), 'engaged');
  assert.equal(bandForCellsDistance(2), 'near');
  assert.equal(bandForCellsDistance(5), 'near');
  assert.equal(bandForCellsDistance(6), 'far');
  assert.equal(bandForZoneHops(0), 'engaged');
  assert.equal(bandForZoneHops(1), 'near');
  assert.equal(bandForZoneHops(2), 'far');
});

// ---------------------------------------------------------------------------
// 视线 / 出生点 / 地形
// ---------------------------------------------------------------------------

test('视线：Bresenham 直线包含两端点', () => {
  const line = bresenhamLine({ x: 1, y: 4 }, { x: 3, y: 2 });
  assert.deepEqual(line, [{ x: 1, y: 4 }, { x: 2, y: 3 }, { x: 3, y: 2 }]);
  const horizontal = bresenhamLine({ x: 0, y: 0 }, { x: 3, y: 0 });
  assert.deepEqual(horizontal, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
});

test('视线：墙体阻挡', () => {
  const space = new SpaceRuntime(clonePack());
  const map = space.getMap('map_cave');
  assert.ok(map !== undefined);
  const blocked = space.lineOfSight(map, { x: 1, y: 2 }, { x: 6, y: 2 });
  assert.equal(blocked.visible, false);
  assert.ok(blocked.blockedAt !== undefined);
});

test('视线：空地可见', () => {
  const space = new SpaceRuntime(clonePack());
  const map = space.getMap('map_cave')!;
  const clear = space.lineOfSight(map, { x: 1, y: 3 }, { x: 6, y: 3 });
  assert.equal(clear.visible, true);
});

test('地形：出生点按阵营展开；墙格不可通行', () => {
  const space = new SpaceRuntime(clonePack());
  assert.deepEqual(space.spawnCells('map_cave', 'player'), [{ x: 1, y: 4 }, { x: 2, y: 4 }]);
  assert.deepEqual(space.spawnCells('map_cave', 'enemy'), [{ x: 6, y: 1 }, { x: 6, y: 2 }]);
  assert.deepEqual(space.spawnCells('map_missing', 'player'), []);
  const map = space.getMap('map_cave')!;
  assert.equal(space.isBlocked(map, { x: 0, y: 0 }), true);
  assert.equal(space.isBlocked(map, { x: 1, y: 3 }), false);
  assert.equal(space.moveCostAt(map, { x: 1, y: 3 }), 1);
  assert.equal(space.moveCostAt(map, { x: 4, y: 1 }), 2);
});

test('地形：障碍格阻挡且带掩体数据', () => {
  const space = new SpaceRuntime(clonePack());
  const map = space.getMap('map_cave')!;
  assert.equal(space.isBlocked(map, { x: 3, y: 4 }), true);
  const cover = space.coverAt(map, { x: 3, y: 4 });
  assert.equal(cover.coverId, 'half');
  assert.equal(cover.defenseBonus, 2);
  assert.deepEqual(cover.tags, ['wall']);
});

// ---------------------------------------------------------------------------
// 移动（边界 / 障碍 / 地形消耗 / 移动力）
// ---------------------------------------------------------------------------

test('移动：越界被拒绝', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  const error = expectErr(runtime.move({ actorId: 'card_a', to: { cell: { x: 9, y: 3 } } }));
  assert.equal(error.code, 'blocked');
  assert.match(error.messageZh, /越界/);
});

test('移动：墙体与障碍阻挡（整体不落位）', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 1, y: 4 } } });
  const wall = expectErr(runtime.move({ actorId: 'card_a', to: { cell: { x: 0, y: 4 } } }));
  assert.equal(wall.code, 'blocked');
  const obstacle = expectErr(runtime.move({ actorId: 'card_a', to: { cell: { x: 4, y: 4 } } }));
  assert.equal(obstacle.code, 'blocked');
  assert.match(obstacle.messageZh, /障碍物/);
  const position = expectOk(runtime.getActor('card_a')).actor.position;
  assert.deepEqual(position, { zoneId: 'cave', cell: { x: 1, y: 4 } });
});

test('移动：地形 moveCost 计入（碎石格 ×2）', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 3, y: 1 } } });
  // (3,1)→(5,1)：(4,1) 碎石 2 + (5,1) 碎石 2 = 4
  const result = expectOk(runtime.move({ actorId: 'card_a', to: { cell: { x: 5, y: 1 } } }));
  assert.equal(result.cost, 4);
  assert.equal(result.remaining, 2);
  assert.equal(result.path.length, 2);
});

test('移动：超出移动力被拒绝', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 1, y: 1 } } });
  // (1,1)→(5,1)：地面 1 + 地面 1 + 碎石 2 + 碎石 2 = 6，移动力耗尽
  const moved = expectOk(runtime.move({ actorId: 'card_a', to: { cell: { x: 5, y: 1 } } }));
  assert.equal(moved.cost, 6);
  assert.equal(moved.remaining, 0);
  // 返回：(5,1)→(3,1) 需要 3 点，剩余 0
  const error = expectErr(runtime.move({ actorId: 'card_a', to: { cell: { x: 3, y: 1 } } }));
  assert.equal(error.code, 'insufficient_turn_resource');
});

test('移动：区域之间按 connections 连通性判定', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'town' } });
  const result = expectOk(runtime.move({ actorId: 'card_a', to: { zoneId: 'cave' } }));
  assert.equal(result.to.zoneId, 'cave');
  assert.equal(result.cost, 1);
  // 不存在的区域
  const missing = expectErr(runtime.move({ actorId: 'card_a', to: { zoneId: 'nowhere' } }));
  assert.equal(missing.code, 'blocked');
});

test('移动：区域跳数（BFS）', () => {
  const space = new SpaceRuntime(clonePack());
  assert.equal(space.zoneHops('town', 'cave'), 1);
  assert.equal(space.zoneHops('cave', 'cave'), 0);
  assert.equal(space.zoneHops('town', 'nowhere'), undefined);
});

// ---------------------------------------------------------------------------
// computeDistance / computeCover 缺省行为
// ---------------------------------------------------------------------------

test('距离：缺省按 space.distanceMode 计算并给档位', () => {
  const runtime = createRuntime({ roomSeed: 600 });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { position: { zoneId: 'cave', cell: { x: 4, y: 1 } } });
  const result = expectOk(runtime.computeDistance({ actorId: 'card_a', targetId: 'card_b' }));
  assert.equal(result.usedHook, false);
  assert.equal(result.distance, 3); // chebyshev max(3,2)
  assert.equal(result.band, 'near');
});

test('距离：距离模式是数据项（manhattan 规则包）', () => {
  const pack = clonePack();
  pack.space!.distanceMode = 'manhattan';
  const runtime = createRuntime({ rules: pack });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { position: { zoneId: 'cave', cell: { x: 4, y: 1 } } });
  const result = expectOk(runtime.computeDistance({ actorId: 'card_a', targetId: 'card_b' }));
  assert.equal(result.distance, 5);
});

test('距离：跨区域用跳数（zone 模型）', () => {
  const runtime = createRuntime();
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'town' } });
  addActor(runtime, makeCard({ cardId: 'card_b' }), { position: { zoneId: 'cave' } });
  const result = expectOk(runtime.computeDistance({ actorId: 'card_a', targetId: 'card_b' }));
  assert.equal(result.distance, 1);
  assert.equal(result.band, 'near');
});

test('掩体：缺省按 obstacles.coverId 匹配', () => {
  const runtime = createRuntime({ roomSeed: 601 });
  addActor(runtime, makeCard({ cardId: 'card_a' }), { position: { zoneId: 'cave', cell: { x: 1, y: 3 } } });
  addActor(
    runtime,
    makeCard({ cardId: 'card_b' }),
    { position: { zoneId: 'cave', cell: { x: 3, y: 4 } } },
  );
  const result = expectOk(runtime.computeCover({ actorId: 'card_a', targetId: 'card_b' }));
  assert.equal(result.usedHook, false);
  assert.equal(result.defenseBonus, 2);
  assert.equal(result.coverId, 'half');
});
