/**
 * M3 实机探针：建房 → 真实 AI GM 开场 → 玩家行动 → AI 回应（含工具调用）。
 *
 * 用法：node scripts/probe-live-gm.mjs
 * 前提：DSH 运行中且插件已加载（可用预览 bundle 的 HMR 热加载，无需重启）。
 * 环境变量：DSH_TRPG_BASE（默认 http://127.0.0.1:45871）
 */
const BASE = process.env.DSH_TRPG_BASE ?? 'http://127.0.0.1:45871';
const TIMEOUT_MS = 240000;

async function rpc(method, params = {}, token) {
  const response = await fetch(`${BASE}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, token }),
  });
  return response.json();
}

async function main() {
  const health = await (await fetch(`${BASE}/trpg/health`)).json();
  console.log('[probe] health:', JSON.stringify(health));
  const created = await rpc('room.create', { title: 'M3 实机自检', gmMode: 'ai' });
  if (!created.ok) {
    console.error('[probe] create failed:', JSON.stringify(created));
    process.exit(1);
  }
  const { hostToken, inviteCode } = created.result;
  console.log(`[probe] room created, invite=${inviteCode}`);

  const { CARDS } = await import('../packages/content/src/index.ts');
  const joined = await rpc('room.join', { inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  if (!joined.ok) {
    console.error('[probe] join failed:', JSON.stringify(joined));
    process.exit(1);
  }
  await rpc('room.seat', { characterCard: CARDS[0] }, joined.result.playerToken);
  console.log('[probe] player joined + seated; waiting for AI GM opening (up to 240s)…');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let phase = 'opening';
  let actionSeq = 0;
  let checkSeq = 0;
  let openingSeq = 0;
  let gmTurns = 0;
  let diceCount = 0;
  let actionSubmitted = false;
  let checkSubmitted = false;
  let toolOk = false;
  let success = false;

  const submitAction = async () => {
    if (actionSubmitted) return;
    actionSubmitted = true;
    phase = 'action';
    const text = '我向柳掌柜打听枯木崖绿光的事，语气客气一点。';
    const said = await rpc('room.say', { text }, joined.result.playerToken);
    if (!said.ok) {
      console.error('[probe] say failed:', JSON.stringify(said));
      return;
    }
    actionSeq = said.result.event.seq;
    console.log(`[probe] 玩家行动已提交（seq ${actionSeq}）：${text}`);
  };

  const submitCheckAction = async () => {
    if (checkSubmitted) return;
    checkSubmitted = true;
    phase = 'check';
    const text = '我仔细端详老王的表情和手上的泥印，想判断他是不是在隐瞒什么。';
    const said = await rpc('room.say', { text }, joined.result.playerToken);
    if (!said.ok) {
      console.error('[probe] say failed:', JSON.stringify(said));
      return;
    }
    checkSeq = said.result.event.seq;
    console.log(`[probe] 检定行动已提交（seq ${checkSeq}）：${text}`);
  };

  try {
    const response = await fetch(`${BASE}/trpg/events?token=${encodeURIComponent(hostToken)}&lastSeq=0`, { signal: controller.signal });
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
        const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
        if (line) {
          const event = JSON.parse(line.slice(6));
          if (event.kind === 'narration') {
            const text = String(event.payload.text ?? '');
            if (text.includes('AI 主持人已就位')) {
              // 就位提示，不算 GM 回合
            } else if (phase === 'opening') {
              openingSeq = event.seq;
              gmTurns += 1;
              console.log(`[probe] GM 开场（seq ${event.seq}）：${text.slice(0, 160)}…`);
              await submitAction();
            } else if (phase === 'action' && event.seq > actionSeq && event.seq !== openingSeq) {
              gmTurns += 1;
              console.log(`[probe] GM 回应（seq ${event.seq}）：${text.slice(0, 200)}…`);
              await submitCheckAction();
            } else if (phase === 'check' && event.seq > checkSeq) {
              gmTurns += 1;
              console.log(`[probe] GM 检定回应（seq ${event.seq}）：${text.slice(0, 200)}…`);
              success = true;
            }
          }
          if (event.kind === 'dice') {
            diceCount += 1;
            console.log(`[probe] 骰子事件（seq ${event.seq}）：${JSON.stringify(event.payload).slice(0, 240)}`);
            if (phase === 'check') {
              toolOk = true;
              success = true;
            }
          }
          if (event.kind === 'alert') console.log('[probe] alert:', event.payload.text);
        }
        index = buffer.indexOf('\n\n');
      }
      if (success) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }

  console.log(`[probe] gmTurns=${gmTurns} dice=${diceCount} toolOk=${toolOk} success=${success}`);
  try {
    await rpc('room.close', {}, hostToken);
    console.log('[probe] room closed');
  } catch {
    /* ignore */
  }
  if (!success) {
    console.error('[probe] FAILED：AI GM 没有完成「开场 + 行动回应」链路');
    process.exit(2);
  }
  console.log('[probe] OK — AI GM 实机带团链路完整（开场 + 玩家行动回应）。');
  process.exit(0);
}

main().catch((error) => {
  console.error('[probe] failed:', error);
  process.exit(1);
});
