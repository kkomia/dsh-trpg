import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIMUYA_LOREBOOK, GUIMUYA_MODULE, CARDS } from '@dsh-trpg/content';
import { RoomService, type PlayerActionInfo } from '@dsh-trpg/rooms';
import {
  GmManager,
  GmRuntime,
  eventToPromptEvent,
  extractAssistantText,
  type GmAgentCtxLike,
  type GmCreateAgent,
} from '../src/host/gm/runtime.ts';
import { buildGmSystemPrompt, buildTurnPrompt } from '../src/host/gm/prompt.ts';
import { createGmTools } from '../src/host/gm/tools.ts';

interface FakeCtxCapture {
  tools: Array<{ name: string; execute: (args: Record<string, unknown>) => Promise<{ text: string }> | { text: string } }>;
  sections: Array<{ name: string; text: () => string }>;
  suppressed: boolean;
}

function fakeAgentFactory(state: { calls: string[] }) {
  const ctx: FakeCtxCapture = { tools: [], sections: [], suppressed: false };
  const createAgent: GmCreateAgent = async ({ setup }) => {
    const agentCtx: GmAgentCtxLike = {
      tools: {
        register(definition) {
          ctx.tools.push(definition as FakeCtxCapture['tools'][number]);
          return () => {};
        },
      },
      systemPrompt: {
        section(section) {
          ctx.sections.push(section as FakeCtxCapture['sections'][number]);
          return () => {};
        },
        suppressRuntimeContext() {
          ctx.suppressed = true;
          return () => {};
        },
      },
    };
    setup(agentCtx);
    return {
      agent: {
        followup(input) {
          state.calls.push(input.content[0]?.text ?? '');
        },
        whenIdle: async () => {},
      },
      dispose() {},
    };
  };
  return { createAgent, ctx };
}

function setupRoom(gmMode: 'ai' | 'human' = 'ai') {
  const roomService = new RoomService({ now: () => 1000 });
  const created = roomService.createRoom({ title: '鬼木崖·异光', gmMode });
  const hostToken = created.hostToken;
  const host = roomService.login(hostToken);
  const joined = roomService.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  roomService.seat(roomService.login(joined.playerToken), { characterCard: CARDS[0] });
  const joined2 = roomService.join({ inviteCode: created.inviteCode, playerName: '白露' });
  roomService.seat(roomService.login(joined2.playerToken), { characterCard: CARDS[1] });
  const action: PlayerActionInfo = {
    roomId: created.room.roomId,
    playerId: joined.playerId,
    playerName: '阿青',
    characterName: '阿青',
    text: '我推开祠堂的门，先看门缝里的光。',
    private: false,
  };
  return { roomService, created, host, joined, joined2, action };
}

test('extractAssistantText: joins text blocks and ignores tool calls/reasoning', () => {
  const message = {
    content: [
      { type: 'reasoning', text: '思考中' },
      { type: 'text', text: '你推开门。' },
      { type: 'tool-call', id: 'x', name: 'roll_check', arguments: '{}' },
      { type: 'text', text: '  霉味扑面而来。 ' },
    ],
  };
  assert.equal(extractAssistantText(message), '你推开门。\n\n霉味扑面而来。');
  assert.equal(extractAssistantText(null), '');
  assert.equal(extractAssistantText({ content: [] }), '');
});

test('prompt: system prompt carries GM hard rules, module, lore and secrets', () => {
  const system = buildGmSystemPrompt(GUIMUYA_MODULE, GUIMUYA_LOREBOOK);
  assert.ok(system.includes(GUIMUYA_MODULE.title));
  assert.ok(system.includes('绝不替玩家角色写行动'));
  assert.ok(system.includes('骰子、检定、伤害数值只能来自工具结果'));
  assert.ok(system.includes('〔GM 秘密〕'));
  assert.ok(system.includes('entry_gm_zhenfa'));
});

test('prompt: turn prompt names the single actor and includes party + recent events', () => {
  const prompt = buildTurnPrompt({
    module: GUIMUYA_MODULE,
    roomTitle: '鬼木崖·异光',
    actor: { playerName: '阿青', characterName: '阿青' },
    actionText: '我推开祠堂的门。',
    private: false,
    party: [
      { playerId: 'p1', name: '阿青', characterName: '阿青', characterClass: '武者', level: 1, hp: 12, hpMax: 12, ac: 16 },
      { playerId: 'p2', name: '白露', characterName: '白露', characterClass: '游侠', level: 1, hp: 11, hpMax: 11, ac: 14 },
    ],
    recent: [{ seq: 3, kind: '叙事', to: 'all', text: 'GM：镇口告示墙前还围着人。' }],
  });
  assert.ok(prompt.includes('本次只有这一位玩家行动'));
  assert.ok(prompt.includes('阿青'));
  assert.ok(prompt.includes('白露'));
  assert.ok(prompt.includes('镇口告示墙前还围着人'));
  assert.ok(prompt.includes('我推开祠堂的门'));
});

test('runtime: start registers GM tools scoped to the agent and system section', async () => {
  const { roomService, action } = setupRoom();
  const state = { calls: [] as string[] };
  const { createAgent, ctx } = fakeAgentFactory(state);
  const runtime = new GmRuntime({
    roomId: action.roomId,
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
  });
  await runtime.start();
  assert.equal(ctx.tools.length, 11, '应注册 11 个 GM 工具');
  assert.deepEqual(ctx.tools.map((tool) => tool.name).sort(), [
    'attack',
    'check_lore',
    'combat_status',
    'end_combat',
    'list_party',
    'next_turn',
    'reveal_lore',
    'roll_check',
    'roll_dice',
    'secret_note',
    'start_combat',
  ]);
  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0]?.name, 'trpg-gm');
  assert.ok(ctx.sections[0]?.text().includes('硬规则'));
  assert.equal(ctx.suppressed, true);
  await runtime.stop();
});

test('runtime: player action becomes a followup prompt with actor binding', async () => {
  const { roomService, action } = setupRoom();
  const state = { calls: [] as string[] };
  const { createAgent } = fakeAgentFactory(state);
  const runtime = new GmRuntime({
    roomId: action.roomId,
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log: () => {},
  });
  await runtime.start();
  runtime.notifyPlayerAction(action);
  await runtime.whenIdle();
  assert.equal(state.calls.length, 1);
  assert.ok(state.calls[0]?.includes('【行动者】玩家「阿青」'));
  assert.ok(state.calls[0]?.includes('我推开祠堂的门'));
  await runtime.stop();
});

test('runtime: assistant message is broadcast to the room as GM narration', async () => {
  const { roomService, action } = setupRoom();
  const { createAgent } = fakeAgentFactory({ calls: [] });
  const runtime = new GmRuntime({
    roomId: action.roomId,
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log: () => {},
  });
  await runtime.start();
  runtime.onSessionEvent({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '门轴发出刺耳的呻吟，霉味扑面而来。' }] } },
  });
  const recent = roomService.gmRecentEvents(action.roomId, 5);
  const narration = recent.find((event) => event.kind === 'narration' && event.to === 'all');
  assert.ok(narration);
  assert.equal((narration?.payload as { text: string }).text, '门轴发出刺耳的呻吟，霉味扑面而来。');
  await runtime.stop();
});

test('tools: roll_check uses engine dice and broadcasts a dice event with check result', async () => {
  const { roomService, action } = setupRoom();
  const tools = createGmTools({ roomService, roomId: action.roomId, lorebook: GUIMUYA_LOREBOOK });
  const rollCheck = tools.find((tool) => tool.name === 'roll_check');
  assert.ok(rollCheck);
  const result = await rollCheck?.execute({ playerName: '阿青', skill: 'perception', dc: 10, reason: '观察门缝' });
  assert.ok(result?.text.includes('察觉检定'));
  const diceEvent = roomService.gmRecentEvents(action.roomId, 10).find((event) => event.kind === 'dice');
  assert.ok(diceEvent);
  const payload = diceEvent?.payload as { check?: { success: boolean; dc: number }; dice: number[] };
  assert.equal(payload.check?.dc, 10);
  assert.equal(payload.dice.length >= 1, true);
});

test('tools: secret_note is private, reveal_lore is public', async () => {
  const { roomService, action, joined } = setupRoom();
  const tools = createGmTools({ roomService, roomId: action.roomId, lorebook: GUIMUYA_LOREBOOK });
  await tools.find((tool) => tool.name === 'secret_note')?.execute({ playerName: '阿青', text: '你闻到一股极淡的血腥味。' });
  const secret = roomService.gmRecentEvents(action.roomId, 10).find((event) => event.kind === 'narration' && event.to === joined.playerId);
  assert.ok(secret);

  const revealed = await tools.find((tool) => tool.name === 'reveal_lore')?.execute({ entryId: 'entry_guimuya' });
  assert.ok(revealed?.text.includes('枯木崖'));
  const publicNarration = roomService.gmRecentEvents(action.roomId, 5).find((event) => event.kind === 'narration' && event.to === 'all');
  assert.ok(publicNarration);
});

test('manager: routes actions and session events, and announces readiness', async () => {
  const { roomService, action } = setupRoom();
  const state = { calls: [] as string[] };
  const { createAgent } = fakeAgentFactory(state);
  const manager = new GmManager({
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log: () => {},
  });
  await manager.ensureRoom(action.roomId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.calls.length, 1, 'AI GM 模式建房后应自动生成开场回合');
  assert.ok(state.calls[0]?.includes('【开场】'));
  const ready = roomService.gmRecentEvents(action.roomId, 10).some(
    (event) => event.kind === 'narration' && (event.payload as { text?: string }).text?.includes('AI 主持人已就位'),
  );
  assert.equal(ready, true);

  manager.onPlayerAction(action);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.calls.length, 2);
  assert.ok(state.calls[1]?.includes('【行动者】玩家「阿青」'));

  const sessionId = manager.sessionIds()[0];
  assert.equal(typeof sessionId, 'string');
  manager.onSessionEvent(sessionId as string, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '洞口的草被踩倒了一片。' }] } },
  });
  const narrated = roomService.gmRecentEvents(action.roomId, 5).some(
    (event) => event.kind === 'narration' && (event.payload as { text?: string }).text === '洞口的草被踩倒了一片。',
  );
  assert.equal(narrated, true);
  await manager.dispose();
});

test('manager: human GM mode does not start an AI agent', async () => {
  const { roomService, created } = setupRoom('human');
  const state = { calls: [] as string[] };
  const { createAgent } = fakeAgentFactory(state);
  const manager = new GmManager({
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    createAgent,
    log: () => {},
  });
  await manager.ensureRoom(created.room.roomId);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.calls.length, 0);
  await manager.dispose();
});

test('combat: engine enforces turn order and broadcasts combat state', async () => {
  const { roomService, action } = setupRoom();
  const { CombatRuntime } = await import('../src/host/gm/combat.ts');
  const combat = new CombatRuntime({ roomService, roomId: action.roomId });
  const tools = createGmTools({ roomService, roomId: action.roomId, lorebook: GUIMUYA_LOREBOOK, combat });
  const start = tools.find((tool) => tool.name === 'start_combat');
  const started = await start?.execute({ monsters: 'shanxiao*1' });
  assert.ok(started?.text.includes('先攻顺序'));
  assert.equal(combat.running, true);

  const view = combat.view();
  const active = view.order.find((entry) => entry.id === view.activeId);
  const enemies = view.order.filter((entry) => entry.kind === 'monster');
  const allies = view.order.filter((entry) => entry.kind === 'pc');
  const attacker = active?.kind === 'monster' ? enemies[0] : allies[0];
  const target = attacker?.kind === 'monster' ? allies[0] : enemies[0];
  assert.ok(attacker && target);

  const attackTool = tools.find((tool) => tool.name === 'attack');
  const attacked = await attackTool?.execute({ attacker: attacker.name, target: target.name });
  assert.ok(attacked?.text.includes(attacker.name));

  const combatEvent = roomService.gmRecentEvents(action.roomId, 10).find((event) => event.kind === 'combat');
  assert.ok(combatEvent);

  // 不是行动者的攻击必须被引擎拒绝
  const wrong = view.order.find((entry) => entry.id !== view.activeId && !entry.dead);
  assert.ok(wrong);
  const wrongTarget = wrong.kind === 'monster' ? allies[0] : enemies[0];
  assert.ok(wrongTarget);
  await assert.rejects(
    async () => attackTool?.execute({ attacker: wrong.name, target: wrongTarget.name }),
    /轮到/,
  );

  const ended = await tools.find((tool) => tool.name === 'end_combat')?.execute({});
  assert.ok(ended?.text.includes('战斗结束'));
  assert.equal(combat.running, false);
});

test('eventToPromptEvent: formats narration/dice/alert and drops room snapshots', () => {
  assert.equal(
    eventToPromptEvent({ v: 1, kind: 'room', seq: 1, at: 0, to: 'all', payload: {} }),
    null,
  );
  const line = eventToPromptEvent({
    v: 1,
    kind: 'dice',
    seq: 2,
    at: 0,
    to: 'all',
    payload: {
      expression: 'd20',
      dice: [12],
      modifier: 3,
      total: 15,
      label: '察觉检定',
      rollerName: '阿青',
      playerId: 'p1',
      private: false,
      check: { kind: 'skill', name: '察觉', dc: 10, success: true },
    },
  });
  assert.ok(line?.text.includes('察觉 DC 10 → 成功'));
});
