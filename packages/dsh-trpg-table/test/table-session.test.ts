import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIMUYA_LOREBOOK, GUIMUYA_MODULE } from '@dsh-trpg/content';
import { RoomService } from '@dsh-trpg/rooms';
import { TableSessionBridge, type TableAgentLike } from '../src/host/table-session.ts';

function setup() {
  const service = new RoomService({ maxRooms: 4 });
  const created = service.createRoom({ title: '会话牌桌', gmMode: 'ai' });
  const roomId = created.room.roomId;
  const registeredTools: unknown[] = [];
  const registeredSections: unknown[] = [];
  const prompted: Array<{ sessionId: string; text: string }> = [];
  const agent: TableAgentLike = {
    id: 'session-probe',
    ctx: {
      tools: {
        register: (definition) => {
          registeredTools.push(definition);
          return () => {
            registeredTools.pop();
          };
        },
      },
      systemPrompt: {
        section: (section) => {
          registeredSections.push(section);
          return () => {
            registeredSections.pop();
          };
        },
      },
    },
  };
  let agentAvailable = true;
  const bridge = new TableSessionBridge({
    roomService: service,
    resolveContent: () => ({ module: GUIMUYA_MODULE, lorebook: GUIMUYA_LOREBOOK }),
    getAgent: () => (agentAvailable ? agent : undefined),
    prompt: async (sessionId, text) => {
      prompted.push({ sessionId, text });
    },
  });
  return { service, created, roomId, bridge, registeredTools, registeredSections, prompted, setAgentAvailable: (value: boolean) => { agentAvailable = value; } };
}

test('TableSessionBridge: 绑定会话时在 Agent 上注册 GM 提示段与工具，解绑时回收', () => {
  const { bridge, roomId, registeredTools, registeredSections } = setup();
  const result = bridge.bind(roomId, 'session-probe');
  assert.deepEqual(result, { ok: true });
  assert.ok(registeredTools.length >= 10, `expected GM tools, got ${registeredTools.length}`);
  assert.equal(registeredSections.length, 1);
  assert.equal(bridge.sessionOfRoom(roomId), 'session-probe');
  assert.equal(bridge.isBoundSession('session-probe'), true);

  bridge.unbind(roomId);
  assert.equal(registeredTools.length, 0);
  assert.equal(registeredSections.length, 0);
  assert.equal(bridge.isBoundSession('session-probe'), false);
});

test('TableSessionBridge: 会话未打开（没有存活 Agent）时拒绝绑定并给出可读原因', () => {
  const { bridge, roomId, setAgentAvailable } = setup();
  setAgentAvailable(false);
  const result = bridge.bind(roomId, 'session-missing');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /打开/);
  assert.equal(bridge.sessionOfRoom(roomId), undefined);
});

test('TableSessionBridge: 玩家行动以【角色名】前缀注入会话', () => {
  const { bridge, service, roomId, prompted } = setup();
  bridge.bind(roomId, 'session-probe');
  const player = service.join({ inviteCode: service.hostSession(roomId).room.inviteCode ?? '', playerName: '阿青' });
  assert.ok(player.playerId);
  bridge.promptAction(roomId, {
    roomId,
    playerId: player.playerId,
    playerName: '阿青',
    characterName: '阿青',
    text: '我推开门',
    private: false,
  });
  assert.equal(prompted.length, 1);
  assert.equal(prompted[0]?.sessionId, 'session-probe');
  assert.equal(prompted[0]?.text, '【阿青】我推开门');
});

test('TableSessionBridge: AI 的 assistant 消息作为 GM 旁白广播回房间', () => {
  const { bridge, service, roomId } = setup();
  bridge.bind(roomId, 'session-probe');
  bridge.onSessionEvent('session-probe', 'assistant/message', {
    message: { content: [{ type: 'text', text: '茶馆的门吱呀一声开了。' }] },
  });
  const events = service.gmRecentEvents(roomId, 10);
  const narration = events.find((event) => event.kind === 'narration');
  assert.ok(narration, 'expected a narration event in the room');
  assert.equal((narration?.payload as { text: string }).text, '茶馆的门吱呀一声开了。');
});

test('TableSessionBridge: 解绑后不再转发行动/旁白', () => {
  const { bridge, roomId, prompted, service } = setup();
  bridge.bind(roomId, 'session-probe');
  bridge.unbind(roomId);
  bridge.promptAction(roomId, {
    roomId,
    playerId: 'p1',
    playerName: '阿青',
    text: '我推开门',
    private: false,
  });
  assert.equal(prompted.length, 0);
  const before = service.gmRecentEvents(roomId, 10).length;
  bridge.onSessionEvent('session-probe', 'assistant/message', { message: { content: [{ type: 'text', text: '不该出现' }] } });
  assert.equal(service.gmRecentEvents(roomId, 10).length, before);
});
