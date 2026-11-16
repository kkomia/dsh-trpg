/**
 * M9.5e 地图/世界结构生成与校验（host/studio/map-generator.ts）。
 *
 * 覆盖：程序化兜底的确定性/可玩性、校验器硬闸（越界/行宽/未知字符/出生点重叠或不可站立/不连通）、
 * AI 草稿（JSON + RULES-MODEL ASCII 文本）解析、重试 ≤2、连续失败回退程序化、世界地图热点/双向连线校验。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATTLE_TERRAIN_LEGEND,
  type BattleStructure,
  type WorldStructure,
} from '@dsh-trpg/protocol';
import {
  buildBattleDraftPrompt,
  buildWorldDraftPrompt,
  generateBattleMap,
  generateWorldMap,
  parseBattleDraft,
  parseWorldDraft,
  proceduralBattleStructure,
  proceduralWorldStructure,
  summarizeBattleStructure,
  summarizeWorldStructure,
  validateBattleStructure,
  validateWorldStructure,
  type StudioTextGenerator,
  type StudioTextRequest,
} from '../src/host/studio/index.ts';

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 6×5 全墙外圈 + 3 行地板；玩家出生点 (1,2)、敌方出生点 (4,2)。 */
function validBattle(): BattleStructure {
  return {
    cols: 6,
    rows: 5,
    terrain: ['######', '#....#', '#....#', '#....#', '######'].map((row) => [...row]),
    obstacles: [],
    spawns: [
      { x: 1, y: 2, side: 'player' },
      { x: 4, y: 2, side: 'enemy' },
    ],
  };
}

function validWorld(): WorldStructure {
  return {
    zones: [
      {
        zoneId: 'zone_a',
        name: '青石镇',
        hotspot: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 },
        connections: [
          { to: 'zone_b', kind: 'road' },
          { to: 'zone_c', kind: 'path' },
        ],
      },
      {
        zoneId: 'zone_b',
        name: '枯木崖',
        hotspot: { x: 0.55, y: 0.05, w: 0.2, h: 0.2 },
        connections: [
          { to: 'zone_a', kind: 'road' },
          { to: 'zone_c', kind: 'river' },
        ],
      },
      {
        zoneId: 'zone_c',
        name: '寒潭',
        hotspot: { x: 0.05, y: 0.6, w: 0.2, h: 0.2 },
        connections: [
          { to: 'zone_a', kind: 'path' },
          { to: 'zone_b', kind: 'river' },
        ],
      },
    ],
    background: null,
  };
}

const VALID_BATTLE_JSON = JSON.stringify({
  cols: 6,
  rows: 5,
  legend: '# wall | . floor',
  terrain: ['######', '#....#', '#....#', '#....#', '######'],
  spawns: [
    { x: 1, y: 2, side: 'player' },
    { x: 4, y: 2, side: 'enemy' },
  ],
});

const VALID_BATTLE_TEXT = `SIZE 6x5
LEGEND # wall | . floor
######
#....#
#....#
#....#
######
spawns: player 1,2 | enemy 4,2`;

const VALID_WORLD_JSON = JSON.stringify({ zones: validWorld().zones });

function mockText(...responses: Array<string | Error>): { generator: StudioTextGenerator; calls: StudioTextRequest[] } {
  const calls: StudioTextRequest[] = [];
  let index = 0;
  const generator: StudioTextGenerator = (request) => {
    calls.push(request);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response instanceof Error) throw response;
    return response ?? '';
  };
  return { generator, calls };
}

// ---------------------------------------------------------------------------
// 校验器：硬约束
// ---------------------------------------------------------------------------

test('校验器：合法结构通过（无错误/无警告）', () => {
  const report = validateBattleStructure(validBattle());
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.ok(report.value);
});

test('校验器：cols/rows 越界与缺失 → 中文错误', () => {
  const zero = validateBattleStructure({ ...validBattle(), cols: 0 });
  assert.equal(zero.ok, false);
  assert.match(zero.errors.join('；'), /cols 必须是 1–32 的整数/);
  const tooBig = validateBattleStructure({ ...validBattle(), rows: 33 });
  assert.match(tooBig.errors.join('；'), /rows 必须是 1–32 的整数/);
  const missing = validateBattleStructure({});
  assert.match(missing.errors.join('；'), /cols/);
  assert.match(missing.errors.join('；'), /rows/);
});

test('校验器：行数/行宽必须严格匹配 rows/cols', () => {
  const short = structuredClone(validBattle());
  short.terrain.pop();
  assert.match(validateBattleStructure(short).errors.join('；'), /terrain 行数必须等于 rows/);

  const narrow = structuredClone(validBattle());
  narrow.terrain[1] = ['#', '.', '.', '.', '#'] as unknown as string[];
  assert.match(validateBattleStructure(narrow).errors.join('；'), /terrain\[1\] 行宽必须等于 cols/);
});

test('校验器：未知地形字符不静默当墙，报错定位到格', () => {
  const draft = structuredClone(validBattle());
  draft.terrain[2] = ['#', 'x', '.', '.', '.', '#'];
  const report = validateBattleStructure(draft);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('；'), /terrain\[2\]\[1\] 地形字符非法/);
  assert.match(report.errors.join('；'), /合法字符/);
});

test('校验器：障碍越界 / 覆盖出生点 → 错误；障碍互相重叠 → 仅警告', () => {
  const outOfBounds = structuredClone(validBattle());
  outOfBounds.obstacles = [{ x: 5, y: 2, w: 3, h: 1 }];
  assert.match(validateBattleStructure(outOfBounds).errors.join('；'), /obstacles\[0\] 越界/);

  const coversSpawn = structuredClone(validBattle());
  coversSpawn.obstacles = [{ x: 1, y: 2, w: 1, h: 1, terrain: 'w' }];
  assert.match(validateBattleStructure(coversSpawn).errors.join('；'), /出生点不可站立/);

  const overlapping = structuredClone(validBattle());
  overlapping.obstacles = [
    { x: 2, y: 2, w: 1, h: 1, terrain: 'r' },
    { x: 2, y: 2, w: 1, h: 1, terrain: 'r' },
  ];
  const warningReport = validateBattleStructure(overlapping);
  assert.equal(warningReport.ok, true, '障碍重叠只是软约束');
  assert.match(warningReport.warnings.join('；'), /障碍矩形重叠/);
});

test('校验器：出生点越界 / 重叠 / 不可站立 / 缺失双方 → 逐条报错', () => {
  const outOfBounds = structuredClone(validBattle());
  outOfBounds.spawns[0] = { x: 9, y: 2, side: 'player' };
  assert.match(validateBattleStructure(outOfBounds).errors.join('；'), /spawns\[0\] 越界/);

  const overlap = structuredClone(validBattle());
  overlap.spawns[1] = { x: 1, y: 2, side: 'enemy' };
  assert.match(validateBattleStructure(overlap).errors.join('；'), /出生点重叠/);

  const onWall = structuredClone(validBattle());
  onWall.spawns[0] = { x: 0, y: 0, side: 'player' };
  assert.match(validateBattleStructure(onWall).errors.join('；'), /出生点不可站立/);

  const noPlayer = structuredClone(validBattle());
  noPlayer.spawns = noPlayer.spawns.filter((spawn) => spawn.side !== 'player');
  assert.match(validateBattleStructure(noPlayer).errors.join('；'), /至少要有 1 个玩家/);

  const noEnemy = structuredClone(validBattle());
  noEnemy.spawns = noEnemy.spawns.filter((spawn) => spawn.side !== 'enemy');
  assert.match(validateBattleStructure(noEnemy).errors.join('；'), /至少要有 1 个敌方/);

  const tooMany = structuredClone(validBattle());
  tooMany.spawns = Array.from({ length: 21 }, (_, index) => ({
    x: 1 + (index % 4),
    y: 1 + Math.floor(index / 4),
    side: 'player' as const,
  }));
  assert.match(validateBattleStructure(tooMany).errors.join('；'), /出生点最多 20 个/);
});

test('校验器：被墙劈成两半（不可达）→ 报不连通且定位出生点；可通行的碎石不阻断 BFS', () => {
  const disconnected: BattleStructure = {
    cols: 7,
    rows: 5,
    terrain: ['#######', '#..w..#', '#..w..#', '#..w..#', '#######'].map((row) => [...row]),
    obstacles: [],
    spawns: [
      { x: 1, y: 2, side: 'player' },
      { x: 5, y: 2, side: 'enemy' },
    ],
  };
  const report = validateBattleStructure(disconnected);
  assert.equal(report.ok, false);
  assert.match(report.errors.join('；'), /出生点不连通/);
  assert.match(report.errors.join('；'), /玩家出生点 \(1,2\) 走不到敌方出生点 \(5,2\)/);

  const rubbleBridge = structuredClone(disconnected);
  rubbleBridge.terrain[2] = ['#', '.', '.', 'r', '.', '.', '#'];
  const bridged = validateBattleStructure(rubbleBridge);
  assert.equal(bridged.ok, true, '碎石（r，可通行/慢速）应该能连通 BFS');
});

test('校验器：外圈有可通行格只是 warning（不阻断）、并能识别世界图背景占位非法', () => {
  const openBorder = structuredClone(validBattle());
  openBorder.terrain[2] = ['g', '.', '-', '.', '.', '#'];
  openBorder.terrain[2] = ['g', '.', '.', '.', '.', '#'];
  const report = validateBattleStructure(openBorder);
  assert.equal(report.ok, true);
  assert.match(report.warnings.join('；'), /最外圈有 \d+ 个可通行格/);

  const badWorld = validateWorldStructure({ ...validWorld(), background: 'assets/x.png' });
  assert.equal(badWorld.ok, false);
  assert.match(badWorld.errors.join('；'), /world\.background/);
});

// ---------------------------------------------------------------------------
// AI 草稿解析
// ---------------------------------------------------------------------------

test('解析：AI JSON 草稿（legend 词映射）→ 结构', () => {
  const parsed = parseBattleDraft(`\`\`\`json\n${VALID_BATTLE_JSON}\n\`\`\``);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.value);
  assert.equal(parsed.value.cols, 6);
  assert.equal(parsed.value.rows, 5);
  assert.equal(parsed.value.terrain[0]?.[0], 'w');
  assert.equal(parsed.value.terrain[1]?.[1], 'g');
  assert.equal(parsed.value.spawns.length, 2);
});

test('解析：RULES-MODEL ASCII 文本草稿（SIZE/LEGEND/行/spawns）→ 结构', () => {
  const parsed = parseBattleDraft(VALID_BATTLE_TEXT);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.value);
  assert.deepEqual(parsed.value.terrain[0], ['w', 'w', 'w', 'w', 'w', 'w']);
  assert.equal(parsed.value.spawns[0]?.side, 'player');
  assert.equal(parsed.value.spawns[1]?.side, 'enemy');
});

test('解析：未知地形字符/缺 spawns/非 JSON 废话 → 中文错误', () => {
  const unknown = parseBattleDraft(JSON.stringify({ cols: 3, rows: 3, terrain: ['wwx', 'wgw', 'www'] }));
  assert.ok(unknown.errors.length > 0);
  const noSpawns = parseBattleDraft(JSON.stringify({ cols: 3, rows: 3, terrain: ['www', 'wgw', 'www'] }));
  assert.match(noSpawns.errors.join('；'), /出生点/);
  const garbage = parseBattleDraft('模型今天不想画地图');
  assert.ok(garbage.errors.length > 0);
  assert.equal(parseBattleDraft('').errors.length, 1);
});

// ---------------------------------------------------------------------------
// AI 生成：成功 / 重试 / 回退
// ---------------------------------------------------------------------------

test('generateBattleMap：AI 草稿一次通过 → method=ai、attempts=1', async () => {
  const { generator, calls } = mockText(VALID_BATTLE_JSON);
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'topdown-2d', textGenerator: generator });
  assert.equal(outcome.method, 'ai');
  assert.equal(outcome.attempts, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.system ?? '', /你只输出 JSON/);
  assert.match(calls[0]?.prompt ?? '', /洞口/);
  assert.equal(outcome.structure.spawns.length, 2);
});

test('generateBattleMap：RULES-MODEL 文本草稿也能被接受（AI 没给 JSON 时的兼容路径）', async () => {
  const { generator } = mockText(VALID_BATTLE_TEXT);
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'topdown-2d', textGenerator: generator });
  assert.equal(outcome.method, 'ai');
  assert.equal(outcome.structure.cols, 6);
});

test('generateBattleMap：第 1 次解析失败 → 第 2 次成功（重试 ≤2），并把错误反馈给模型', async () => {
  const { generator, calls } = mockText('完全不是草稿', VALID_BATTLE_JSON);
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'topdown-2d', textGenerator: generator });
  assert.equal(outcome.method, 'ai');
  assert.equal(outcome.attempts, 2);
  assert.equal(calls.length, 2);
  assert.match(outcome.warnings.join('；'), /第 1 次无法解析/);
  assert.match(calls[1]?.prompt ?? '', /上一轮草稿没通过程序校验/);
});

test('generateBattleMap：第 1 次校验失败（不连通）→ 第 2 次修正后成功', async () => {
  const bad = JSON.stringify({
    cols: 7,
    rows: 5,
    terrain: ['#######', '#..w..#', '#..w..#', '#..w..#', '#######'],
    spawns: [
      { x: 1, y: 2, side: 'player' },
      { x: 5, y: 2, side: 'enemy' },
    ],
  });
  const { generator } = mockText(bad, VALID_BATTLE_JSON);
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'topdown-2d', textGenerator: generator });
  assert.equal(outcome.method, 'ai');
  assert.equal(outcome.attempts, 2);
  assert.match(outcome.warnings.join('；'), /未通过校验：.*出生点不连通/);
});

test('generateBattleMap：连续 3 次不可用 → 程序化兜底（结构仍合法、attempts=0）', async () => {
  const { generator, calls } = mockText('not json', 'still not json', '{"cols":0}');
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'topdown-2d', textGenerator: generator });
  assert.equal(outcome.method, 'procedural');
  assert.equal(outcome.attempts, 0);
  assert.equal(calls.length, 3, '最多 1 次首发 + 2 次重试');
  assert.match(outcome.warnings.join('；'), /连续 3 次不可用，已回退程序化生成/);
  assert.equal(validateBattleStructure(outcome.structure).ok, true);
});

test('generateBattleMap：文本生成器抛错也重试，最终回退程序化', async () => {
  const { generator, calls } = mockText(new Error('网络超时'), new Error('网络超时'), new Error('网络超时'));
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'pixel-topdown', textGenerator: generator });
  assert.equal(outcome.method, 'procedural');
  assert.equal(calls.length, 3);
  assert.match(outcome.warnings.join('；'), /调用失败：网络超时/);
});

test('generateBattleMap：未配置文本模型 → 直接程序化 + 可读 warning', async () => {
  const outcome = await generateBattleMap({ prompt: '洞口', style: 'topdown-2d' });
  assert.equal(outcome.method, 'procedural');
  assert.equal(outcome.attempts, 0);
  assert.match(outcome.warnings.join('；'), /未配置文本模型/);
});

// ---------------------------------------------------------------------------
// 程序化战棋：确定性 + 可玩性
// ---------------------------------------------------------------------------

test('程序化战棋：同 prompt+seed 结构逐字节一致；换 seed 结构不同', () => {
  const a = proceduralBattleStructure({ prompt: '洞口遭遇', style: 'topdown-2d', seed: 7, partySize: 4 });
  const b = proceduralBattleStructure({ prompt: '洞口遭遇', style: 'topdown-2d', seed: 7, partySize: 4 });
  const c = proceduralBattleStructure({ prompt: '洞口遭遇', style: 'topdown-2d', seed: 8, partySize: 4 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  // 缺省 seed 也按 prompt 派生（同 prompt 同结构）
  assert.deepEqual(
    proceduralBattleStructure({ prompt: '同一句', style: 'topdown-2d' }),
    proceduralBattleStructure({ prompt: '同一句', style: 'topdown-2d' }),
  );
});

test('程序化战棋：多种尺寸/队伍/风格组合全部通过校验器，且出生点数量按队伍人数', () => {
  for (const style of ['topdown-2d', 'pixel-topdown'] as const) {
    for (const partySize of [1, 3, 4, 6, 8]) {
      for (const [cols, rows] of [[10, 8], [16, 10], [24, 16], [32, 32]] as const) {
        const structure = proceduralBattleStructure({ prompt: `组合-${style}-${partySize}-${cols}`, style, cols, rows, partySize, seed: partySize * 7 + cols });
        const report = validateBattleStructure(structure);
        assert.equal(report.ok, true, `${style}/${partySize}/${cols}×${rows} 应合法：${report.errors.join('；')}`);
        const players = structure.spawns.filter((spawn) => spawn.side === 'player');
        const enemies = structure.spawns.filter((spawn) => spawn.side === 'enemy');
        assert.equal(players.length, partySize, '玩家出生点数量 = 队伍人数');
        assert.ok(enemies.length >= 1 && enemies.length <= 4);
        assert.ok(enemies.length > 0);
      }
    }
  }
});

test('程序化战棋：极小地图（4×4 + 8 人）也保证两侧出生点可站立且可达', () => {
  const structure = proceduralBattleStructure({ prompt: '极窄走廊', style: 'topdown-2d', cols: 4, rows: 4, partySize: 8 });
  const report = validateBattleStructure(structure);
  assert.equal(report.ok, true, report.errors.join('；'));
  assert.ok(structure.spawns.filter((spawn) => spawn.side === 'player').length >= 1);
  assert.ok(structure.spawns.filter((spawn) => spawn.side === 'enemy').length >= 1);
});

test('程序化战棋：地形只含图例字符，障碍矩形覆盖的格子与出生点不重叠', () => {
  const structure = proceduralBattleStructure({ prompt: '废墟', style: 'topdown-2d', cols: 14, rows: 9, partySize: 5 });
  for (const row of structure.terrain) {
    for (const char of row) assert.ok(BATTLE_TERRAIN_LEGEND[char], `未知地形字符：${char}`);
  }
  for (const obstacle of structure.obstacles) {
    for (const spawn of structure.spawns) {
      const inside =
        spawn.x >= obstacle.x &&
        spawn.y >= obstacle.y &&
        spawn.x < obstacle.x + obstacle.w &&
        spawn.y < obstacle.y + obstacle.h;
      assert.equal(inside, false, `障碍覆盖了出生点 (${spawn.x},${spawn.y})`);
    }
  }
});

// ---------------------------------------------------------------------------
// 世界地图：校验器 / 解析 / 生成
// ---------------------------------------------------------------------------

test('世界校验器：合法世界通过；背景占位必须是 null', () => {
  const report = validateWorldStructure(validWorld());
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.value?.background, null);
});

test('世界校验器：zoneId 重复/非法、连线指向缺失区域、连线非双向 → 报错', () => {
  const duplicate = structuredClone(validWorld());
  duplicate.zones[1] = { ...duplicate.zones[1]!, zoneId: 'zone_a' };
  assert.match(validateWorldStructure(duplicate).errors.join('；'), /zoneId 重复：zone_a/);

  const missingTarget = structuredClone(validWorld());
  missingTarget.zones[0]!.connections.push({ to: 'zone_missing', kind: 'road' });
  assert.match(validateWorldStructure(missingTarget).errors.join('；'), /连线指向不存在的区域：zone_missing/);

  const oneWay = structuredClone(validWorld());
  oneWay.zones[1]!.connections = oneWay.zones[1]!.connections.filter((connection) => connection.to !== 'zone_a');
  assert.match(validateWorldStructure(oneWay).errors.join('；'), /连线不是双向的/);

  const selfLoop = structuredClone(validWorld());
  selfLoop.zones[0]!.connections.push({ to: 'zone_a' });
  assert.match(validateWorldStructure(selfLoop).errors.join('；'), /连接指向自己/);
});

test('世界校验器：热点越界/过小/重叠 → 报错（重叠定位到 zoneId）', () => {
  const outOfRange = structuredClone(validWorld());
  outOfRange.zones[0]!.hotspot = { x: 0.9, y: 0.1, w: 0.2, h: 0.2 };
  assert.match(validateWorldStructure(outOfRange).errors.join('；'), /hotspot 越界/);

  const tooSmall = structuredClone(validWorld());
  tooSmall.zones[0]!.hotspot = { x: 0.1, y: 0.1, w: 0.001, h: 0.001 };
  assert.match(validateWorldStructure(tooSmall).errors.join('；'), /hotspot 太小/);

  const overlapping = structuredClone(validWorld());
  overlapping.zones[1]!.hotspot = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  assert.match(validateWorldStructure(overlapping).errors.join('；'), /热点重叠：zone_a 与 zone_b/);
});

test('解析世界草稿：合法 JSON 通过；缺 zones/热点非法 → 中文错误', () => {
  const parsed = parseWorldDraft(`\`\`\`json\n${VALID_WORLD_JSON}\n\`\`\``);
  assert.ok(parsed.value);
  assert.equal(parsed.value.zones.length, 3);
  assert.equal(parseWorldDraft('{}').errors[0], '世界草稿缺少 zones 数组');
  const badHotspot = parseWorldDraft(JSON.stringify({ zones: [{ zoneId: 'a', name: 'A', hotspot: { x: 2, y: 0, w: 0.1, h: 0.1 } }] }));
  assert.ok(badHotspot.value, '解析器只管形状，范围交给校验器');
  assert.equal(validateWorldStructure(badHotspot.value).ok, false, '热点 x=2 应被校验器拒绝');
});

test('generateWorldMap：AI 草稿通过 → method=ai；缺反向连线先重试再成功', async () => {
  const ok = await generateWorldMap({
    prompt: '青石镇周边',
    textGenerator: mockText(VALID_WORLD_JSON).generator,
  });
  assert.equal(ok.method, 'ai');
  assert.equal(ok.world.zones.length, 3);
  assert.equal(ok.world.background, null);

  const oneWay = structuredClone(validWorld());
  oneWay.zones[1]!.connections = oneWay.zones[1]!.connections.filter((connection) => connection.to !== 'zone_a');
  const { generator, calls } = mockText(JSON.stringify({ zones: oneWay.zones }), VALID_WORLD_JSON);
  const retried = await generateWorldMap({ prompt: '青石镇周边', textGenerator: generator, zoneCount: 3 });
  assert.equal(retried.method, 'ai');
  assert.equal(retried.attempts, 2);
  assert.equal(calls.length, 2);
  assert.match(retried.warnings.join('；'), /连线不是双向的/);
});

test('generateWorldMap：连续失败/未配置 → 程序化（3..8 区域、双向连线、热点不重叠）', async () => {
  for (const zoneCount of [3, 5, 8]) {
    const outcome = await generateWorldMap({ prompt: '寒潭与古道', zoneCount, seed: zoneCount });
    assert.equal(outcome.method, 'procedural');
    const report = validateWorldStructure(outcome.world);
    assert.equal(report.ok, true, report.errors.join('；'));
    assert.equal(outcome.world.zones.length, zoneCount);
    for (const zone of outcome.world.zones) {
      assert.ok(zone.name.length > 0);
      assert.ok(zone.description && zone.description.length > 0);
      for (const connection of zone.connections) {
        const target = outcome.world.zones.find((candidate) => candidate.zoneId === connection.to);
        assert.ok(target, `连线目标 ${connection.to} 必须存在`);
        assert.ok(
          target.connections.some((reverse) => reverse.to === zone.zoneId),
          '每条连线都必须有反向连线',
        );
      }
    }
  }
  const fallback = await generateWorldMap({
    prompt: '寒潭',
    textGenerator: mockText('{}', '{}', '{}').generator,
  });
  assert.equal(fallback.method, 'procedural');
  assert.match(fallback.warnings.join('；'), /连续 3 次不可用/);
});

test('程序化世界：同 seed 一致、不同 seed 不同、热点互不重叠且在 0..1', () => {
  const a = proceduralWorldStructure({ prompt: '青石镇', zoneCount: 5, seed: 3 });
  const b = proceduralWorldStructure({ prompt: '青石镇', zoneCount: 5, seed: 3 });
  const c = proceduralWorldStructure({ prompt: '青石镇', zoneCount: 5, seed: 4 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const zone of a.zones) {
    const { x, y, w, h } = zone.hotspot;
    assert.ok(x >= 0 && y >= 0 && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9, `${zone.zoneId} 热点越界`);
  }
});

// ---------------------------------------------------------------------------
// 提示词摘要（工坊 UI 展示 / 底图重生成）
// ---------------------------------------------------------------------------

test('摘要/提示词：结构摘要与重试反馈进入 prompt', () => {
  const summary = summarizeBattleStructure(proceduralBattleStructure({ prompt: '洞口', style: 'topdown-2d', partySize: 3 }));
  assert.match(summary, /格；地形：/);
  assert.match(summary, /玩家出生点 3 个/);
  const worldSummary = summarizeWorldStructure(validWorld());
  assert.match(worldSummary, /3 个区域：青石镇、枯木崖、寒潭/);

  const retryPrompt = buildBattleDraftPrompt({ prompt: '洞口', style: 'topdown-2d' }, 2, '第 2 行行宽错误');
  assert.match(retryPrompt, /上一轮草稿没通过程序校验/);
  assert.match(retryPrompt, /第 2 行行宽错误/);
  const worldPrompt = buildWorldDraftPrompt({ prompt: '青石镇', zoneCount: 3 }, 0);
  assert.match(worldPrompt, /区域数量：3/);
});
