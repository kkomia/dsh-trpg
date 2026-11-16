/**
 * M3 端到端冒烟（不依赖真实 LLM）：HTTP 房间服务 + 真实 GM 编排 + 假 Agent。
 *
 * 假 Agent 收到 followup 后：
 *  1. 调一次 roll_check 工具（走真实引擎掷骰 → 房间收到 dice 事件）；
 *  2. 回一条 assistant 消息（GM 编排层应把它广播成公共叙事）。
 *
 * 用法：node scripts/smoke-gm.mjs
 */
import { createRoomHttpServer } from '../packages/dsh-trpg-table/src/host/room-http.ts';
import { GmManager } from '../packages/dsh-trpg-table/src/host/gm/runtime.ts';
import { RoomService } from '../packages/rooms/src/index.ts';
import { GUIMUYA_LOREBOOK, GUIMUYA_MODULE, CARDS } from '../packages/content/src/index.ts';

const PORT = 45874;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ✔ ${name}`);
  else {
    failures += 1;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function rpc(method, params = {}, token) {
  const response = await fetch(`${BASE}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, token }),
  });
  return response.json();
}

/** 收集一段 SSE 事件，直到 predicate 满足或超时。 */
async function collectSse(token, predicate, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${BASE}/trpg/events?token=${encodeURIComponent(token)}&lastSeq=0`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (dataLine) {
          const event = JSON.parse(dataLine.slice(6));
          events.push(event);
          if (predicate(event, events)) {
            controller.abort();
            clearTimeout(timer);
            return events;
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
    return events;
  } catch (error) {
    if (error.name === 'AbortError') return events;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const captured = { prompts: [], tools: [] };
  let manager;
  const roomService = new RoomService({
    onRoomCreated: (roomId) => void manager?.ensureRoom(roomId),
    onPlayerAction: (info) => manager?.onPlayerAction(info),
  });

  const createAgent = async ({ sessionId, setup }) => {
    const tools = [];
    const sections = [];
    setup({
      tools: { register: (definition) => (tools.push(definition), () => {}) },
      systemPrompt: { section: (section) => (sections.push(section), () => {}), suppressRuntimeContext: () => () => {} },
    });
    captured.tools = tools;
    captured.sections = sections;
    return {
      agent: {
        followup(input) {
          const prompt = input.content[0]?.text ?? '';
          captured.prompts.push(prompt);
          setTimeout(async () => {
            try {
              if (prompt.includes('【行动者】')) {
                const rollCheck = tools.find((tool) => tool.name === 'roll_check');
                await rollCheck.execute({ playerName: '阿青', skill: 'perception', dc: 10, reason: '观察门缝' });
                manager.onSessionEvent(sessionId, {
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: '门缝里透出一线冷绿的光，像有人举着火在等你。' }] } },
                });
              } else if (prompt.includes('【开场】')) {
                manager.onSessionEvent(sessionId, {
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: '夜色压在青石镇上，告示墙前还站着两个不肯走的人。' }] } },
                });
              }
            } catch (error) {
              console.error('[fake-gm] tool failed:', error.message);
            }
          }, 5);
        },
        whenIdle: async () => {},
      },
      dispose() {},
    };
  };

  manager = new GmManager({
    roomService,
    // M8.4 起 GM 按房间解析内容（内容包 registry 为权威来源）；smoke 固定用内置模组/世界书。
    resolveContent: () => ({ module: GUIMUYA_MODULE, lorebook: GUIMUYA_LOREBOOK }),
    createAgent,
    log: (message) => console.log('[gm]', message),
  });

  const http = createRoomHttpServer({ port: PORT, bindHost: '127.0.0.1', service: roomService });
  await new Promise((resolve) => http.server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[smoke-gm] server on ${BASE}`);

  try {
    const created = await rpc('room.create', { title: '鬼木崖·异光', gmMode: 'ai' });
    check('AI 模式建房成功', created.ok === true);
    const { hostToken, inviteCode } = created.result;
    const roomId = created.result.room.roomId;

    // 等 GM 启动 + 开场
    await new Promise((resolve) => setTimeout(resolve, 120));
    check('GM 会话已创建并注册工具', captured.tools.length === 13, `tools=${captured.tools.length}`);
    check('GM 系统提示已注入', captured.sections.length === 1 && captured.sections[0].text().includes('硬规则'));
    check('GM 收到开场回合', captured.prompts.some((prompt) => prompt.includes('【开场】')));

    const hostEvents = await collectSse(hostToken, (event) => event.kind === 'narration' && event.payload.text?.includes('夜色压在青石镇'), 3000);
    const opening = hostEvents.find((event) => event.kind === 'narration' && event.payload.text?.includes('夜色压在青石镇'));
    check('开场叙事广播到房间', Boolean(opening));

    const ready = hostEvents.some((event) => event.kind === 'narration' && event.payload.text?.includes('AI 主持人已就位'));
    check('就位提示广播到房间', ready);

    // 玩家加入并行动
    const joined = await rpc('room.join', { inviteCode, playerName: '阿青', characterCard: CARDS[0] });
    check('玩家加入', joined.ok === true);
    const seat = await rpc('room.seat', { characterCard: CARDS[0] }, joined.result.playerToken);
    check('玩家落座', seat.ok === true);
    const said = await rpc('room.say', { text: '我推开祠堂的门，先看门缝里的光。' }, joined.result.playerToken);
    check('玩家提交行动', said.ok === true);

    await new Promise((resolve) => setTimeout(resolve, 120));
    check('玩家行动被喂给 GM', captured.prompts.some((prompt) => prompt.includes('【行动者】玩家「阿青」') && prompt.includes('我推开祠堂的门')));
    const turnPrompt = captured.prompts.find((prompt) => prompt.includes('【行动者】')) ?? '';
    check(
      'prompt 只把阿青标为行动者',
      turnPrompt.includes('本次只有这一位玩家行动') && turnPrompt.includes('【行动者】玩家「阿青」') && !turnPrompt.includes('【行动者】玩家「白露」'),
    );

    // 假 Agent 调了 roll_check：房间应收到 dice 事件（含检定结果）
    const afterAction = await collectSse(joined.result.playerToken, (event, events) => {
      return events.some((entry) => entry.kind === 'dice' && entry.payload.check) && events.some((entry) => entry.kind === 'narration' && entry.payload.text?.includes('门缝里'));
    }, 4000);
    const diceEvent = afterAction.find((event) => event.kind === 'dice' && event.payload.check);
    check('GM 工具掷骰进入房间事件流', Boolean(diceEvent), JSON.stringify(diceEvent?.payload ?? null).slice(0, 120));
    check('检定结果带 DC 与成败', diceEvent?.payload.check?.dc === 10 && typeof diceEvent?.payload.check?.success === 'boolean');

    // 公共叙事由假 Agent 的 assistant 消息广播
    const narration = afterAction.find((event) => event.kind === 'narration' && event.payload.text?.includes('门缝里'));
    check('GM 叙事广播为公共事件', Boolean(narration) && narration.to === 'all');

    console.log(`[smoke-gm] 房间 ${roomId.slice(0, 8)} AI GM 全链路完成`);
  } finally {
    await http.close();
    await manager.dispose();
  }

  if (failures > 0) {
    console.error(`\n[smoke-gm] FAILED: ${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n[smoke-gm] ALL PASS');
  process.exit(0);
}

main().catch((error) => {
  console.error('[smoke-gm] 未捕获错误:', error);
  process.exit(1);
});
