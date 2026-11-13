import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, GUIMUYA_LOREBOOK, GUIMUYA_MODULE } from '@dsh-trpg/content';
import { RoomService, type PlayerActionInfo } from '@dsh-trpg/rooms';
import { SubagentGmManager, extractResultText, type SubagentsLike } from '../src/host/gm/subagent-gm.ts';

function setup(gmMode: 'ai' | 'human' = 'ai') {
  const roomService = new RoomService({ now: () => 1000 });
  const created = roomService.createRoom({ title: '鬼木崖·异光', gmMode });
  const joined = roomService.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  roomService.seat(roomService.login(joined.playerToken), { characterCard: CARDS[0] });
  const action: PlayerActionInfo = {
    roomId: created.room.roomId,
    playerId: joined.playerId,
    playerName: '阿青',
    characterName: '阿青',
    text: '我推开祠堂的门。',
    private: false,
  };
  const hasNarration = (text: string) =>
    roomService
      .gmRecentEvents(created.room.roomId, 50)
      .some((event) => event.kind === 'narration' && (event.payload as { text?: string }).text === text);
  return { roomService, created, action, hasNarration };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test('extractResultText: 兼容字符串 / output 数组 / content 数组', () => {
  assert.equal(extractResultText('门轴呻吟。'), '门轴呻吟。');
  assert.equal(extractResultText({ output: [{ type: 'text', text: '霉味扑来。' }] }), '霉味扑来。');
  assert.equal(extractResultText({ output: { content: [{ type: 'text', text: '洞口的草被踩倒。' }] } }), '洞口的草被踩倒。');
  assert.equal(extractResultText(null), '');
});

test('subagent GM: 开场回合与玩家行动都通过 spawn 激活，叙事广播回房间', async () => {
  const { roomService, action, hasNarration } = setup();
  const calls: Array<{ prompt: string; parent: unknown; childId: string }> = [];
  const tools: Array<{ name: string; execute: (args: Record<string, unknown>, exec?: { agent?: { session?: { id?: string } } }) => unknown }> = [];

  const subagents: SubagentsLike = {
    startActivation: async (spec) => {
      const promptText = Array.isArray(spec.prompt)
        ? (spec.prompt as Array<{ type?: string; text?: string }>)
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => String(block.text))
            .join('')
        : String(spec.prompt);
      calls.push({ prompt: promptText, parent: spec.parent, childId: String(spec.childId) });
      // 模拟子 Agent 调用一次 roll_check 工具（验证 childId→room 路由）
      const tool = tools.find((entry) => entry.name.startsWith('roll_check'));
      if (tool && spec.childId) {
        await tool.execute({ playerName: '阿青', skill: 'perception', dc: 10 }, { agent: { session: { id: String(spec.childId) } } });
      }
      return {
        childId: String(spec.childId),
        result: Promise.resolve({ output: [{ type: 'text', text: calls.length === 1 ? '夜色压在青石镇上。' : '门轴发出刺耳的呻吟。' }] }),
        dispose: () => {},
      };
    },
  };

  const manager = new SubagentGmManager({
    subagents,
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    getParents: () => [{ id: 'host-session' }],
    log: () => {},
    registerTool: (definition) => tools.push(definition as (typeof tools)[number]),
  });
  manager.registerTools();
  assert.equal(tools.length, 11);

  manager.ensureRoom(action.roomId);
  assert.equal(await waitFor(() => hasNarration('夜色压在青石镇上。')), true);
  assert.ok(calls[0]?.prompt.includes('【开场】'));
  assert.ok(calls[0]?.prompt.includes('硬规则'));
  assert.deepEqual(calls[0]?.parent, { id: 'host-session' });

  manager.onPlayerAction(action);
  assert.equal(await waitFor(() => hasNarration('门轴发出刺耳的呻吟。')), true);
  assert.ok(calls[1]?.prompt.includes('【行动者】玩家「阿青」'));
  assert.ok(calls[1]?.prompt.includes('本次只有这一位玩家行动'));

  const dice = roomService.gmRecentEvents(action.roomId, 50).find((event) => event.kind === 'dice');
  assert.ok(dice, '子 Agent 的工具调用应路由到房间并产生 dice 事件');
  await manager.dispose();
});

test('subagent GM: 没有可用父会话时给出明确提示而不是静默失败', async () => {
  const { roomService, action } = setup();
  const subagents: SubagentsLike = { startActivation: async () => ({ childId: 'x' }) };
  const manager = new SubagentGmManager({
    subagents,
    roomService,
    module: GUIMUYA_MODULE,
    lorebook: GUIMUYA_LOREBOOK,
    getParents: () => [],
    log: () => {},
    registerTool: () => {},
  });
  manager.registerTools();
  manager.ensureRoom(action.roomId);
  const alerted = await waitFor(() =>
    roomService
      .gmRecentEvents(action.roomId, 30)
      .some((event) => event.kind === 'alert' && (event.payload as { text?: string }).text?.includes('没有可用')),
  );
  assert.equal(alerted, true);
  await manager.dispose();
});
