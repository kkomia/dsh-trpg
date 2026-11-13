/**
 * M3 实机探针：对运行中的 DSH 跑团桌房间服务发一次建房 + SSE，观察 AI GM 是否真的开口。
 *
 * 用法：node scripts/probe-live-gm.mjs
 * 前提：DSH 已重启并加载了 M3 版插件 Host；房间服务在 127.0.0.1:45871。
 */
const BASE = process.env.DSH_TRPG_BASE ?? 'http://127.0.0.1:45871';

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

  // 加入一名玩家并落座（使用预制卡，避免手写）
  const { CARDS } = await import('../packages/content/src/index.ts');
  const joined = await rpc('room.join', { inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  if (!joined.ok) {
    console.error('[probe] join failed:', JSON.stringify(joined));
    process.exit(1);
  }
  await rpc('room.seat', { characterCard: CARDS[0] }, joined.result.playerToken);
  console.log('[probe] player joined + seated; waiting for AI GM narration (up to 120s)…');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  const events = [];
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
          events.push(event);
          if (event.kind === 'narration') {
            console.log(`[probe] narration[${event.seq}] (${event.to}): ${String(event.payload.text).slice(0, 200)}`);
          }
          if (event.kind === 'alert') console.log('[probe] alert:', event.payload.text);
          if (event.kind === 'dice') console.log('[probe] dice:', JSON.stringify(event.payload).slice(0, 200));
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }

  const gmNarrations = events.filter((event) => event.kind === 'narration');
  const hasOpening = gmNarrations.some((event) => event.payload.text && !event.payload.text.includes('AI 主持人已就位'));
  console.log(`[probe] events=${events.length} gmNarrations=${gmNarrations.length} hasOpening=${hasOpening}`);
  if (!hasOpening) {
    console.error('[probe] AI GM 没有开口：确认 DSH 已重启并加载 M3 版插件，且模型可用。');
    process.exit(2);
  }
  console.log('[probe] OK — AI GM 已在实机开口。');
  process.exit(0);
}

main().catch((error) => {
  console.error('[probe] failed:', error);
  process.exit(1);
});
