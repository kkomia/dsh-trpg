/**
 * M4 实机探针：真人 GM 指令（旁白 / 私发 / 发奖励）在真实房间里的可见性。
 * 用法：node scripts/probe-live-human-gm.mjs
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

async function readSse(token, predicate, timeoutMs = 4000) {
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
        const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
        if (line) {
          const event = JSON.parse(line.slice(6));
          events.push(event);
          if (predicate(event, events)) {
            controller.abort();
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
  const { CARDS } = await import('../packages/content/src/index.ts');
  const created = await rpc('room.create', { title: '真人GM探针', gmMode: 'human' });
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const { hostToken, inviteCode, room } = created.result;
  const joined = await rpc('room.join', { inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  if (!joined.ok) throw new Error(`join failed: ${JSON.stringify(joined)}`);
  const playerToken = joined.result.playerToken;
  const playerId = joined.result.playerId;
  let failed = 0;
  const check = (name, ok) => {
    console.log(`  ${ok ? '✔' : '✘'} ${name}`);
    if (!ok) failed += 1;
  };

  try {
    const narrate = await rpc('gm.narrate', { text: '夜色更深了，风里有股血腥味。' }, hostToken);
    check('房主可发 GM 旁白', narrate.ok === true);
    const playerSawNarration = await readSse(playerToken, (event) => event.seq === narrate.result.event.seq, 2500);
    check('玩家收到 GM 旁白', playerSawNarration.some((event) => event.seq === narrate.result.event.seq));

    const secret = await rpc('gm.secret', { playerId, text: '你注意到他袖口有一线暗红。' }, hostToken);
    check('房主可私发', secret.ok === true && secret.result.event.to === playerId);
    const playerSawSecret = await readSse(playerToken, (event) => event.seq === secret.result.event.seq, 2500);
    check('私发只到目标玩家', playerSawSecret.some((event) => event.seq === secret.result.event.seq && event.to === playerId));

    const award = await rpc('gm.award', { playerId, xp: 50, items: ['镇魂符'], note: '探针奖励' }, hostToken);
    check('房主可发奖励', award.ok === true && award.result.event.to === playerId);
    const playerSawAward = await readSse(playerToken, (event) => event.seq === award.result.event.seq, 2500);
    check('奖励只到目标玩家', playerSawAward.some((event) => event.seq === award.result.event.seq));

    const denied = await rpc('gm.narrate', { text: '玩家冒充' }, playerToken);
    check('玩家不能发 GM 指令', denied.ok === false && denied.error.code === 'forbidden');
  } finally {
    await rpc('room.close', {}, hostToken).catch(() => {});
  }

  console.log(`[human-gm] room ${room.roomId.slice(0, 8)} checks done, failed=${failed}`);
  if (failed > 0) process.exit(1);
  console.log('[human-gm] OK — 真人 GM 指令实机验证通过');
  process.exit(0);
}

main().catch((error) => {
  console.error('[human-gm] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
