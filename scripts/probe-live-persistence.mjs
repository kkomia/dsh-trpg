/**
 * M4 实机探针：存档/续团。
 *
 * 用法：
 *   node scripts/probe-live-persistence.mjs create   # 建房、落座、掷骰、推进场景，保存 token
 *   （此时用 plugin_manager 重载插件 bundle，模拟 DSH 重启）
 *   node scripts/probe-live-persistence.mjs verify   # 用旧 token 恢复房间，校验存档内容
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.DSH_TRPG_BASE ?? 'http://127.0.0.1:45871';
const STATE_FILE = join('D:\\gitlab\\dsh-trpg\\.tmp', 'persist-probe.json');

async function rpc(method, params = {}, token) {
  const response = await fetch(`${BASE}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, token }),
  });
  return response.json();
}

async function create() {
  const { CARDS } = await import('../packages/content/src/index.ts');
  const created = await rpc('room.create', { title: '续团探针·鬼木崖', gmMode: 'human' });
  if (!created.ok) throw new Error(`room.create failed: ${JSON.stringify(created)}`);
  const { hostToken, inviteCode, room } = created.result;
  const joined = await rpc('room.join', { inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  if (!joined.ok) throw new Error(`room.join failed: ${JSON.stringify(joined)}`);
  const playerToken = joined.result.playerToken;
  await rpc('room.seat', { characterCard: CARDS[0] }, playerToken);
  await rpc('room.roll', { expression: 'd20', label: '存档探针' }, playerToken);
  await rpc('gm.scene', { sceneId: 'scene_guimuya', title: '枯木崖·古洞' }, hostToken);
  const state = { base: BASE, hostToken, playerToken, roomId: room.roomId, title: room.title, sceneId: 'scene_guimuya' };
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  console.log(`[persist] created room ${room.roomId.slice(0, 8)}；请重载插件后运行 verify`);
}

async function verify() {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const hostState = await rpc('room.state', {}, state.hostToken);
  if (!hostState.ok) throw new Error(`续团失败（host token 无效）：${JSON.stringify(hostState)}`);
  const restored = hostState.result.room;
  const checks = [
    ['房间标题保留', restored.title === state.title],
    ['场景进度保留', restored.scene?.sceneId === state.sceneId],
    ['玩家席保留', restored.players.some((player) => player.characterName === '阿青')],
    ['房间 id 一致', restored.roomId === state.roomId],
  ];
  const playerState = await rpc('room.state', {}, state.playerToken);
  checks.push(['玩家 token 仍有效', playerState.ok === true]);
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}`);
    if (!ok) failed += 1;
  }
  await rpc('room.close', {}, state.hostToken).catch(() => {});
  try {
    unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
  if (failed > 0) {
    console.error(`[persist] FAILED: ${failed} 项未通过`);
    process.exit(1);
  }
  console.log('[persist] OK — 存档续团实机验证通过');
  process.exit(0);
}

const phase = process.argv[2];
(phase === 'create' ? create() : phase === 'verify' ? verify() : Promise.reject(new Error('用法：create | verify'))).catch((error) => {
  console.error('[persist] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
