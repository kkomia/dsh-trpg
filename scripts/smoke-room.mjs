/**
 * M2 端到端冒烟：真实 HTTP 服务 + 真实 SSE + 三个"假客户端"（房主 / 阿青 / 白露）。
 *
 * 覆盖 ROADMAP M2 的验收点：建房 → 加入 → 落座 → 掷骰 → 私骰不泄漏 → 踢人 → 断线重连。
 * 用法：node scripts/smoke-room.mjs
 */
import { createRoomHttpServer } from '../packages/dsh-trpg-table/src/host/room-http.ts';
import { CARDS } from '../packages/content/src/index.ts';

const PORT = 45873;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
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

/** 读 SSE 直到 predicate 满足或超时；返回收到的事件。 */
async function sse(url, predicate, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(url, { signal: controller.signal });
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
  const http = createRoomHttpServer({ port: PORT, bindHost: '127.0.0.1' });
  await new Promise((resolve) => http.server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[smoke] room server on ${BASE}`);

  try {
    // 1. 房主建房
    const created = await rpc('room.create', { title: '鬼木崖·异光', gmMode: 'ai' });
    check('房主建房成功', created.ok === true && created.result.inviteCode.length === 6, JSON.stringify(created));
    const { hostToken, inviteCode, room } = created.result;

    // 2. 玩家加入（带角色卡）
    const joined = await rpc('room.join', { inviteCode, playerName: '阿青', characterCard: CARDS[0] });
    check('阿青加入成功', joined.ok === true && typeof joined.result.playerToken === 'string');
    const aqing = joined.result;
    const joined2 = await rpc('room.join', { inviteCode, playerName: '白露' });
    check('白露加入成功', joined2.ok === true);
    const bailu = joined2.result;

    // 3. 错误邀请码
    const wrong = await rpc('room.join', { inviteCode: 'XXXXXX', playerName: '路人' });
    check('错误邀请码被拒绝', wrong.ok === false && wrong.error.code === 'not-found');

    // 4. SSE 订阅 + 在线状态
    const hostEvents = [];
    const aqingEvents = [];
    const bailuEvents = [];
    await sse(`${BASE}/trpg/events?token=${hostToken}&lastSeq=0`, (event) => {
      hostEvents.push(event);
      return false;
    }, 1500);
    const [aqingReplay, bailuReplay] = await Promise.all([
      sse(`${BASE}/trpg/events?token=${aqing.playerToken}&lastSeq=0`, (event, list) => {
        aqingEvents.push(event);
        return list.length > 0 && event.kind === 'room';
      }),
      sse(`${BASE}/trpg/events?token=${bailu.playerToken}&lastSeq=0`, (event, list) => {
        bailuEvents.push(event);
        return list.length > 0 && event.kind === 'room';
      }),
    ]);
    void aqingReplay;
    void bailuReplay;
    check('玩家 SSE 收到房间事件', aqingEvents.length + bailuEvents.length > 0);

    // 5. 房主落座 + 公共骰
    const seat = await rpc('room.seat', { characterCard: CARDS[2] }, hostToken);
    check('房主落座成功', seat.ok === true && seat.result.room.players.some((entry) => entry.characterName));
    const publicRoll = await rpc('room.roll', { expression: '2d6+3', label: '伤害' }, aqing.playerToken);
    check('公共掷骰成功', publicRoll.ok === true && publicRoll.result.event.payload.dice.length === 2);
    const publicSeen = await sse(`${BASE}/trpg/events?token=${bailu.playerToken}&lastSeq=0`, (event) => event.seq === publicRoll.result.event.seq, 2000);
    check('白露收到公共骰', publicSeen.some((event) => event.seq === publicRoll.result.event.seq));

    // 6. 私骰不泄漏
    const privateRoll = await rpc('room.roll', { expression: 'd20', label: '察觉', private: true }, aqing.playerToken);
    const privateSeq = privateRoll.result.event.seq;
    const aqingPrivate = await sse(`${BASE}/trpg/events?token=${aqing.playerToken}&lastSeq=${privateSeq - 1}`, (event) => event.seq === privateSeq, 2000);
    check('掷骰者收到私骰', aqingPrivate.some((event) => event.seq === privateSeq));
    const bailuPrivate = await sse(`${BASE}/trpg/events?token=${bailu.playerToken}&lastSeq=${privateSeq - 1}`, (event) => event.seq === privateSeq, 1500);
    check('其他玩家收不到私骰', !bailuPrivate.some((event) => event.seq === privateSeq));

    // 7. 悄悄话只到 GM
    const whisper = await rpc('room.say', { text: '我想偷偷翻他的包', private: true }, aqing.playerToken);
    check('悄悄话目标为 GM', whisper.ok === true && whisper.result.event.to === 'gm');
    const bailuWhisper = await sse(`${BASE}/trpg/events?token=${bailu.playerToken}&lastSeq=${whisper.result.event.seq - 1}`, (event) => event.seq === whisper.result.event.seq, 1200);
    check('悄悄话不进公共通道', !bailuWhisper.some((event) => event.seq === whisper.result.event.seq));

    // 8. 断线重连补发
    const lastSeen = publicRoll.result.event.seq;
    const before = await rpc('room.say', { text: '我先去趟药铺' }, aqing.playerToken);
    const replay = await sse(`${BASE}/trpg/events?token=${bailu.playerToken}&lastSeq=${lastSeen}`, (event) => event.seq === before.result.event.seq, 2000);
    check('重连补发错过的事件', replay.some((event) => event.seq === before.result.event.seq), `lastSeq=${lastSeen}`);

    // 8.5 真人 GM 指令（host 权限）
    const gmNarrate = await rpc('gm.narrate', { text: '夜色更深了，风里有股血腥味。' }, hostToken);
    check('房主可发 GM 旁白', gmNarrate.ok === true);
    const aqingGm = await sse(`${BASE}/trpg/events?token=${aqing.playerToken}&lastSeq=${gmNarrate.result.event.seq - 1}`, (event) => event.seq === gmNarrate.result.event.seq, 2000);
    check('玩家收到 GM 旁白', aqingGm.some((event) => event.seq === gmNarrate.result.event.seq));
    const playerGm = await rpc('gm.narrate', { text: '假 GM' }, aqing.playerToken);
    check('玩家不能发 GM 旁白', playerGm.ok === false && playerGm.error.code === 'forbidden');
    const sceneSet = await rpc('gm.scene', { sceneId: 'scene_shendong', title: '古洞深处' }, hostToken);
    check('房主推进场景', sceneSet.ok === true);
    const stateScene = await rpc('room.state', {}, aqing.playerToken);
    check('场景写进房间视图', stateScene.result.room.scene?.sceneId === 'scene_shendong');
    const award = await rpc('gm.award', { playerId: aqing.playerId, xp: 50, items: ['镇魂符'] }, hostToken);
    check('房主发奖励', award.ok === true);
    const bailuAward = await sse(`${BASE}/trpg/events?token=${bailu.playerToken}&lastSeq=${award.result.event.seq - 1}`, (event) => event.seq === award.result.event.seq, 1200);
    check('奖励私密（其他玩家收不到）', !bailuAward.some((event) => event.seq === award.result.event.seq));

    // 9. 踢人 + 锁房
    const kicked = await rpc('room.kick', { playerId: bailu.playerId }, hostToken);
    check('房主踢人成功', kicked.ok === true);
    const bailuAfterKick = await rpc('room.state', {}, bailu.playerToken);
    check('被踢玩家的 token 失效', bailuAfterKick.ok === false && bailuAfterKick.error.code === 'unauthorized');
    const locked = await rpc('room.lock', { locked: true }, hostToken);
    check('房主锁房成功', locked.ok === true);
    const joinLocked = await rpc('room.join', { inviteCode, playerName: '路人' });
    check('锁房后无法加入', joinLocked.ok === false && joinLocked.error.code === 'room-locked');

    // 10. 非房主不能踢人
    const joinThird = await rpc('room.join', { inviteCode, playerName: '第三人' });
    check('解锁前第三人被拒', joinThird.ok === false);
    const unlock = await rpc('room.lock', { locked: false }, hostToken);
    check('房主解锁成功', unlock.ok === true);
    const aqingKick = await rpc('room.kick', { playerId: 'nobody' }, aqing.playerToken);
    check('玩家不能踢人', aqingKick.ok === false && aqingKick.error.code === 'forbidden');

    // 11. 健康检查与房间列表
    const health = await (await fetch(`${BASE}/trpg/health`)).json();
    check('健康检查返回协议版本', health.ok === true && health.protocol === 1);
    const list = await rpc('room.list', {});
    check('房间列表可用且不含邀请码', list.ok === true && !JSON.stringify(list).includes(inviteCode));

    console.log(`[smoke] 房间 ${room.roomId.slice(0, 8)} 全流程完成`);
  } finally {
    await http.close();
  }

  if (failures > 0) {
    console.error(`\n[smoke] FAILED: ${failures} 项未通过`);
    process.exit(1);
  }
  console.log('\n[smoke] ALL PASS');
  process.exit(0);
}

main().catch((error) => {
  console.error('[smoke] 未捕获错误:', error);
  process.exit(1);
});
