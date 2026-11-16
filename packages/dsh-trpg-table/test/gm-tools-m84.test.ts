/**
 * M8.4 通用 GM 工具 / 模组数据工具单测。
 *
 * 覆盖：工具注册裁剪（有/无规则运行时）、旧工具兼容、旧名别名、通用工具
 * 参数校验与路由到假运行时（成功 / 错误 / 无运行时降级）、scene/reward 工具、
 * reveal_lore → 已揭示登记。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIMUYA_LOREBOOK, GUIMUYA_MODULE, CARDS } from '@dsh-trpg/content';
import type { CombatView } from '@dsh-trpg/protocol';
import { RoomService } from '@dsh-trpg/rooms';
import { createGmTools, formatCombatView } from '../src/host/gm/tools.ts';
import { clearAllRevealedLore, revealedLoreIds } from '../src/host/gm/lore-reveal.ts';

type RoomRuntime = NonNullable<ReturnType<RoomService['runtimeOf']>>;

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function fakeRuntime(): RoomRuntime {
  return {
    listActors: () => [
      { actorId: 'pc:p1', name: '阿青' },
      { actorId: 'npc:1', name: '血尸' },
    ],
    rules: {
      actions: [{ actionId: 'attack.melee', kind: 'attack', name: '近战攻击' }],
      space: { battleMaps: [{ mapId: 'map_ok' }] },
    },
  } as unknown as RoomRuntime;
}

function combatViewOf(overrides: Record<string, unknown> = {}): CombatView {
  return {
    active: true,
    round: 1,
    maxRounds: 3,
    cols: 0,
    rows: 0,
    cellMeters: 1,
    distanceMode: 'chebyshev',
    terrain: [],
    obstacles: [],
    positions: {},
    tokens: [
      { actorId: 'pc:p1', name: '阿青', team: 'player', dead: false, active: true, hp: { current: 12, max: 12 } },
      { actorId: 'npc:1', name: '血尸', team: 'enemy', dead: false, active: false, hp: { current: 8, max: 8 } },
    ],
    initiative: [
      { actorId: 'pc:p1', name: '阿青', team: 'player', initiative: 12, roll: 10, dead: false, active: true },
      { actorId: 'npc:1', name: '血尸', team: 'enemy', initiative: 5, roll: 5, dead: false, active: false },
    ],
    activeActorId: 'pc:p1',
    actionEconomy: { actorId: 'pc:p1', remaining: [] },
    time: { round: 1, segment: 0, day: 0 },
    terrainLegend: [],
    ...overrides,
  } as unknown as CombatView;
}

function actionOutcomeOf(): Record<string, unknown> {
  return {
    actorId: 'pc:p1',
    actionId: 'attack.melee',
    actionName: '近战攻击',
    kind: 'attack',
    targetId: 'npc:1',
    hit: true,
    crit: false,
    damage: { amount: 5, absorbedByTempHp: 0, hpBefore: 8, hpAfter: 3, dead: false },
    check: {
      actorId: 'pc:p1',
      targetId: 'npc:1',
      kind: 'skill',
      skillId: 'athletics',
      dc: 10,
      mode: 'normal',
      d20: 15,
      modifier: 3,
      total: 18,
      success: true,
      crit: false,
      fumble: false,
      degree: 'success',
      rolls: [{ expression: '1d20', dice: [15], modifier: 3, total: 18 }],
      trace: { lines: ['命中检定 d20=15+3=18 vs AC 10 → 命中'], data: {} },
    },
    cost: { turn: { action: 1 } },
    turn: { action: 0, bonus: 1, reaction: 1, movement: 6 },
    autoEndedTurn: false,
    rolls: [
      { expression: '1d20', dice: [15], modifier: 3, total: 18 },
      { expression: '1d8', dice: [5], modifier: 0, total: 5 },
    ],
    events: ['attack', 'damage/after'],
    trace: {
      lines: ['命中检定 d20=15+3=18 vs AC 10 → 命中', '伤害 5 → 血尸 HP 8→3'],
      data: {},
    },
  };
}

interface FakeServiceOptions {
  runtime?: RoomRuntime | undefined;
  useAction?: (params: Record<string, unknown>) => unknown;
  move?: (params: Record<string, unknown>) => unknown;
  rollCheck?: (params: Record<string, unknown>) => unknown;
  startCombat?: (params: Record<string, unknown>) => unknown;
  endTurn?: (params: Record<string, unknown>) => unknown;
  endCombat?: (params: Record<string, unknown>) => unknown;
  combatView?: () => unknown;
}

function fakeService(options: FakeServiceOptions = {}): { service: RoomService; calls: Record<string, Array<Record<string, unknown>>> } {
  const runtime = 'runtime' in options ? options.runtime : fakeRuntime();
  const calls: Record<string, Array<Record<string, unknown>>> = {
    useAction: [],
    move: [],
    rollCheck: [],
    startCombat: [],
    endTurn: [],
    endCombat: [],
  };
  const record = (key: string, params: Record<string, unknown>): void => {
    calls[key]?.push(params);
  };
  const service = {
    runtimeOf: () => runtime,
    gmView: () => ({ roomId: 'room-1', title: '假房间', scene: undefined }),
    gmParty: () => [{ playerId: 'p1', name: '阿青', seat: 'player' }],
    useAction: (_principal: unknown, params: Record<string, unknown>) => {
      record('useAction', params);
      return options.useAction !== undefined ? options.useAction(params) : { action: actionOutcomeOf(), combat: combatViewOf() };
    },
    move: (_principal: unknown, params: Record<string, unknown>) => {
      record('move', params);
      return options.move !== undefined
        ? options.move(params)
        : {
            move: {
              actorId: 'pc:p1',
              from: { cell: { x: 0, y: 0 } },
              to: { cell: { x: 1, y: 1 } },
              cost: 1,
              remaining: 5,
              path: [{ x: 1, y: 1 }],
              trace: { lines: ['移动 1 格'], data: {} },
            },
            combat: combatViewOf(),
          };
    },
    rollCheck: (_principal: unknown, params: Record<string, unknown>) => {
      record('rollCheck', params);
      return options.rollCheck !== undefined
        ? options.rollCheck(params)
        : {
            check: {
              actorId: 'pc:p1',
              kind: 'skill',
              skillId: 'perception',
              dc: 12,
              mode: 'normal',
              d20: 14,
              modifier: 2,
              total: 16,
              success: true,
              crit: false,
              fumble: false,
              degree: 'success',
              rolls: [{ expression: '1d20', dice: [14], modifier: 2, total: 16 }],
              trace: { lines: ['检定 d20=14+2=16 vs DC 12 → 成功'], data: {} },
            },
          };
    },
    startCombat: (_principal: unknown, params: Record<string, unknown>) => {
      record('startCombat', params);
      return options.startCombat !== undefined
        ? options.startCombat(params)
        : { combat: combatViewOf(), rolls: [{ expression: '1d20', dice: [10], modifier: 2, total: 12 }] };
    },
    endTurn: (_principal: unknown, params: Record<string, unknown>) => {
      record('endTurn', params);
      return options.endTurn !== undefined ? options.endTurn(params) : { combat: combatViewOf() };
    },
    endCombat: (_principal: unknown, params: Record<string, unknown>) => {
      record('endCombat', params);
      return options.endCombat !== undefined ? options.endCombat(params) : { combat: combatViewOf({ active: false }) };
    },
    combatView: () => (options.combatView !== undefined ? options.combatView() : { combat: combatViewOf() }),
  };
  return { service: service as unknown as RoomService, calls };
}

function toolNamed(tools: ReturnType<typeof createGmTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`测试期望工具 ${name}`);
  return tool;
}

/** 非规则房间（无 rules resolver）：seating 两个玩家。 */
function setupPlainRoom() {
  const roomService = new RoomService({ now: () => 1000 });
  const created = roomService.createRoom({ title: '旧工具房间', gmMode: 'ai' });
  const joined = roomService.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  roomService.seat(roomService.login(joined.playerToken), { characterCard: CARDS[0] });
  return { roomService, roomId: created.room.roomId, joined };
}

// ---------------------------------------------------------------------------
// 注册裁剪 / 旧工具兼容
// ---------------------------------------------------------------------------

test('tools：无规则运行时的房间不注册通用工具，保留旧工具 + scene/reward', () => {
  const { roomService, roomId } = setupPlainRoom();
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 13);
  for (const legacy of ['start_combat', 'attack', 'next_turn', 'combat_status', 'end_combat']) {
    assert.ok(names.includes(legacy), `旧工具 ${legacy} 应保留`);
  }
  for (const generic of ['use_action', 'move', 'combat']) assert.equal(names.includes(generic), false);
  assert.ok(names.includes('scene'));
  assert.ok(names.includes('reward'));
});

test('tools：有规则运行时自动注册通用工具（含旧名别名）', () => {
  const { service } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 16);
  for (const generic of ['use_action', 'move', 'combat', 'scene', 'reward']) assert.ok(names.includes(generic));
  for (const legacy of ['start_combat', 'attack', 'next_turn', 'combat_status', 'end_combat']) assert.ok(names.includes(legacy));
});

test('tools：无规则房间的旧 roll_check 仍走旧引擎（playerName + skill + dc）', async () => {
  const { roomService, roomId } = setupPlainRoom();
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'roll_check').execute({ playerName: '阿青', skill: 'perception', dc: 10 });
  assert.ok(result.text.includes('察觉检定'));
  assert.ok(result.text.includes('vs DC 10'));
});

test('tools：无规则房间的旧战斗工具仍可用（start_combat/combat_status/end_combat）', async () => {
  const { CombatRuntime } = await import('../src/host/gm/combat.ts');
  const { roomService, roomId } = setupPlainRoom();
  const combat = new CombatRuntime({ roomService, roomId });
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE, combat });
  const started = await toolNamed(tools, 'start_combat').execute({ monsters: 'shanxiao*1' });
  assert.ok(started.text.includes('先攻顺序'));
  assert.equal(combat.running, true);
  const status = await toolNamed(tools, 'combat_status').execute({});
  assert.ok(status.text.includes('第 1 轮'));
  const ended = await toolNamed(tools, 'end_combat').execute({});
  assert.ok(ended.text.includes('战斗结束'));
  assert.equal(combat.running, false);
});

// ---------------------------------------------------------------------------
// 通用工具：假运行时路由（成功 / 错误 / 无运行时降级）
// ---------------------------------------------------------------------------

test('tools：use_action 路由到规则运行时，文本只含返回值里的骰面/伤害/trace', async () => {
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'use_action').execute({
    actionId: 'attack.melee',
    actorId: '阿青',
    targetId: '血尸',
  });
  assert.deepEqual(calls.useAction?.[0], { actionId: 'attack.melee', actorId: 'pc:p1', targetId: 'npc:1' });
  assert.ok(result.text.includes('近战攻击'));
  assert.ok(result.text.includes('命中'));
  assert.ok(result.text.includes('伤害 5'));
  assert.ok(result.text.includes('骰面：1d20=[15]+3=18'));
  assert.ok(result.text.includes('判定链：命中检定'));
  assert.ok(result.text.includes('剩余行动：action 0'));
});

test('tools：use_action 未知 actionId 给可读错误并列出可用动作', async () => {
  const { service } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  await assert.rejects(
    async () => toolNamed(tools, 'use_action').execute({ actionId: 'attack.nope', actorId: '阿青' }),
    /没有动作「attack\.nope」；可用动作：attack\.melee/,
  );
});

test('tools：use_action 运行时错误（中文）透传给模型', async () => {
  const { service } = fakeService({
    useAction: () => {
      throw new Error('阿青 本回合的动作已经用完');
    },
  });
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  await assert.rejects(
    async () => toolNamed(tools, 'use_action').execute({ actionId: 'attack.melee', actorId: '阿青' }),
    /动作已经用完/,
  );
});

test('tools：无规则运行时即便注册了通用工具，执行时给出可读降级错误', async () => {
  const { service } = fakeService({ runtime: undefined });
  const tools = createGmTools({
    roomService: service,
    roomId: 'room-1',
    lorebook: GUIMUYA_LOREBOOK,
    module: GUIMUYA_MODULE,
    includeGenericTools: true,
  });
  await assert.rejects(
    async () => toolNamed(tools, 'use_action').execute({ actionId: 'attack.melee', actorId: '阿青' }),
    /没有规则运行时/,
  );
});

test('tools：move 路由到运行时（to:{x,y} 转 cell）并格式化移动结果', async () => {
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'move').execute({ actorId: '阿青', to: { x: 1, y: 1 } });
  assert.deepEqual(calls.move?.[0], { actorId: 'pc:p1', to: { cell: { x: 1, y: 1 } } });
  assert.ok(result.text.includes('移动：(0,0) → (1,1)'));
  assert.ok(result.text.includes('消耗 1'));
  assert.ok(result.text.includes('剩余移动 5'));
  await assert.rejects(async () => toolNamed(tools, 'move').execute({ actorId: '阿青', to: {} }), /to 必须/);
  await assert.rejects(async () => toolNamed(tools, 'move').execute({ actorId: '阿青', to: { x: 1 } }), /同时提供/);
});

test('tools：combat status/next/end 路由到规则运行时', async () => {
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const status = await toolNamed(tools, 'combat').execute({ action: 'status' });
  assert.ok(status.text.includes('第 1 轮/3'));
  assert.ok(status.text.includes('先攻：阿青(12)'));
  const next = await toolNamed(tools, 'combat').execute({ action: 'next' });
  assert.equal(calls.endTurn?.length, 1);
  assert.ok(next.text.includes('现在轮到'));
  const ended = await toolNamed(tools, 'combat').execute({ action: 'end', reason: '收场' });
  assert.deepEqual(calls.endCombat?.[0], { reason: '收场' });
  assert.ok(ended.text.includes('战斗结束'));
  await assert.rejects(async () => toolNamed(tools, 'combat').execute({ action: 'dance' }), /只能是 start\/next\/end\/status/);
});

test('tools：combat start 按 encounterId 展开模组遭遇，并应用 maxRounds/battleMapId 覆盖', async () => {
  const module: typeof GUIMUYA_MODULE = {
    ...GUIMUYA_MODULE,
    scenes: GUIMUYA_MODULE.scenes.map((scene) => ({
      ...scene,
      encounters: (scene.encounters ?? []).map((encounter) => ({ ...encounter })),
    })),
  };
  // 给 enc_guihuo 加覆盖字段（host 按可选字段防御性读取）。
  const targetScene = module.scenes[1];
  if (targetScene !== undefined) {
    targetScene.encounters = [
      {
        ...(targetScene.encounters?.[0] ?? { id: 'enc_guihuo', monsters: [] }),
        maxRounds: 8,
        battleMapId: 'map_ok',
      } as unknown as NonNullable<typeof targetScene.encounters>[number],
      ...(targetScene.encounters ?? []).slice(1),
    ];
  }
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module });
  const result = await toolNamed(tools, 'combat').execute({ action: 'start', encounterId: 'enc_guihuo' });
  const params = calls.startCombat?.[0] ?? {};
  assert.deepEqual(
    (params.enemies as Array<{ name: string }>).map((enemy) => enemy.name),
    ['鬼火', '鬼火', '纸人', '纸人'],
  );
  assert.equal(params.maxRounds, 8);
  assert.equal(params.mapId, 'map_ok');
  assert.ok(result.text.includes('先攻骰'));
  assert.ok(result.text.includes('maxRounds=8'));
});

test('tools：combat start 未知 encounterId 给可读错误（列出可用遭遇）', async () => {
  const { service } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  await assert.rejects(
    async () => toolNamed(tools, 'combat').execute({ action: 'start', encounterId: 'enc_nope' }),
    /没有遭遇「enc_nope」；可用遭遇：enc_guihuo/,
  );
});

test('tools：combat start 的 battleMapId 在规则包里不存在时降级为 theater-of-mind 并提示', async () => {
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'combat').execute({
    action: 'start',
    monsters: 'shanxiao*1',
    battleMapId: 'map_missing',
  });
  const params = calls.startCombat?.[0] ?? {};
  assert.equal(params.mapId, undefined);
  assert.ok(result.text.includes('theater-of-mind'));
});

test('tools：旧名 attack 在有规则运行时映射为通用 use_action', async () => {
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'attack').execute({ attacker: '阿青', target: '血尸' });
  assert.deepEqual(calls.useAction?.[0], { actionId: 'attack.melee', actorId: 'pc:p1', targetId: 'npc:1' });
  assert.ok(result.text.includes('近战攻击'));
});

test('tools：泛化 roll_check 在有规则运行时时走 rollCheck（actorId + skill + dc）', async () => {
  const { service, calls } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'roll_check').execute({ actorId: '阿青', skill: 'perception', dc: 12 });
  assert.equal(calls.rollCheck?.[0]?.actorId, 'pc:p1');
  assert.equal(calls.rollCheck?.[0]?.skillId, 'perception');
  assert.equal(calls.rollCheck?.[0]?.kind, 'skill');
  assert.ok(result.text.includes('技能「perception」检定'));
  assert.ok(result.text.includes('DC 12'));
  assert.ok(result.text.includes('成功'));
  assert.ok(result.text.includes('判定链：检定 d20=14+2=16'));
});

// ---------------------------------------------------------------------------
// scene / reward / reveal
// ---------------------------------------------------------------------------

test('tools：scene 查看当前场景返回判定/奖励；advance 调用 gmScene 推进', async () => {
  const { roomService, roomId } = setupPlainRoom();
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const view = await toolNamed(tools, 'scene').execute({ action: 'view' });
  assert.ok(view.text.includes('当前场景：第 1/3 幕'));
  assert.ok(view.text.includes('persuasion DC 12'));
  assert.ok(view.text.includes('XP 20'));
  const advanced = await toolNamed(tools, 'scene').execute({ action: 'advance', sceneId: 'scene_guimuya' });
  assert.ok(advanced.text.includes('已推进到场景 2/3'));
  assert.ok(advanced.text.includes('enc_guihuo'));
  assert.equal(roomService.gmView(roomId).scene?.sceneId, 'scene_guimuya');
  const sceneEvent = roomService.gmRecentEvents(roomId, 10).find((event) => event.kind === 'scene');
  assert.equal((sceneEvent?.payload as { sceneId?: string }).sceneId, 'scene_guimuya');
  await assert.rejects(async () => toolNamed(tools, 'scene').execute({ action: 'advance', sceneId: 'scene_nope' }), /没有场景/);
});

test('tools：scene 在缺少模组解析时给可读错误', async () => {
  const { service } = fakeService();
  const tools = createGmTools({ roomService: service, roomId: 'room-1', lorebook: GUIMUYA_LOREBOOK });
  await assert.rejects(async () => toolNamed(tools, 'scene').execute({ action: 'view' }), /需要模组内容/);
});

test('tools：reward 复用 gmAward 发本场奖励（私发事件）', async () => {
  const { roomService, roomId, joined } = setupPlainRoom();
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'reward').execute({ playerName: '阿青', rewardIndex: 0 });
  assert.ok(result.text.includes('XP 20'));
  const award = roomService.gmRecentEvents(roomId, 10).find((event) => event.kind === 'award');
  assert.ok(award);
  assert.equal(award?.to, joined.playerId);
  assert.equal((award?.payload as { xp?: number }).xp, 20);
});

test('tools：reward 支持显式 xp/items，非法 xp 给可读错误', async () => {
  const { roomService, roomId } = setupPlainRoom();
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  const result = await toolNamed(tools, 'reward').execute({ playerName: '阿青', xp: 50, items: ['fuwen'], note: '额外奖励' });
  assert.ok(result.text.includes('XP 50'));
  assert.ok(result.text.includes('fuwen'));
  const award = roomService.gmRecentEvents(roomId, 10).find((event) => event.kind === 'award');
  assert.deepEqual((award?.payload as { items?: string[] }).items, ['fuwen']);
  await assert.rejects(async () => toolNamed(tools, 'reward').execute({ playerName: '阿青', xp: -1 }), /xp 必须是/);
});

test('tools：reveal_lore 登记已揭示条目，供下一轮检索注入；房间重置可清理', async () => {
  clearAllRevealedLore();
  const { roomService, roomId } = setupPlainRoom();
  const tools = createGmTools({ roomService, roomId, lorebook: GUIMUYA_LOREBOOK, module: GUIMUYA_MODULE });
  assert.deepEqual(revealedLoreIds(roomId), []);
  await toolNamed(tools, 'reveal_lore').execute({ entryId: 'entry_gm_zhenfa' });
  assert.deepEqual(revealedLoreIds(roomId), ['entry_gm_zhenfa']);
  clearAllRevealedLore();
  assert.deepEqual(revealedLoreIds(roomId), []);
});

test('formatCombatView：未开战/开战两种形状都稳定可读', () => {
  assert.equal(formatCombatView(combatViewOf({ active: false, initiative: [], tokens: [] })), '当前没有进行中的战斗');
  const text = formatCombatView(combatViewOf());
  assert.ok(text.includes('第 1 轮/3（回合上限）'));
  assert.ok(text.includes('当前行动者：阿青'));
  assert.ok(text.includes('血尸 8/8'));
});
