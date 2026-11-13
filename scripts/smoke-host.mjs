/**
 * M0 冒烟测试：不经过 DSH，直接加载打包产物 lib/host.js，验证房间服务。
 * 运行：node scripts/smoke-host.mjs
 */
import { apply } from '../packages/dsh-trpg-table/lib/host.js';

const PORT = 45872;
const BASE = `http://127.0.0.1:${PORT}`;
const disposers = [];

const ctx = {
  effect(fn) {
    disposers.push(fn());
  },
};

apply(ctx, { port: PORT, bindHost: '127.0.0.1' });

async function waitForHealth(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/trpg/health`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`health endpoint not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

let failed = false;
try {
  const health = await waitForHealth();
  console.log('[smoke] health:', JSON.stringify(health));
  if (health.ok !== true || health.protocol !== 1) throw new Error('unexpected health payload');

  const created = await fetch(`${BASE}/trpg/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '鬼木崖·异光', gmMode: 'ai' }),
  });
  if (created.status !== 201) throw new Error(`create room failed: HTTP ${created.status}`);
  const { room } = await created.json();
  console.log('[smoke] created room:', JSON.stringify(room));
  if (!room.roomId || !/^[A-Z2-9]{6}$/.test(room.inviteCode)) throw new Error('invalid room payload');

  const rooms = await (await fetch(`${BASE}/trpg/rooms`)).json();
  if (rooms.rooms.length !== 1) throw new Error(`expected 1 room, got ${rooms.rooms.length}`);

  const missing = await fetch(`${BASE}/trpg/nope`);
  if (missing.status !== 404) throw new Error(`expected 404, got ${missing.status}`);

  console.log('[smoke] OK');
} catch (error) {
  failed = true;
  console.error('[smoke] FAILED:', error instanceof Error ? error.message : error);
} finally {
  for (const dispose of disposers.reverse()) dispose();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
}
