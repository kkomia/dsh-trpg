/**
 * 跑团桌 Client 半边（M0 骨架）。
 *
 * 在 DSH Web 界面里注册一个最小可用入口：对话区输入框下方的「跑团桌」dock。
 * 打开后可以探测房主房间服务（GET /trpg/health）、创建房间、列出房间。
 * M2 起：改为 conversation.view 叙事流 + 右侧栏角色/骰子/队伍 + composer 行动输入，
 * 由 docs/DESIGN.md §9 的槽位方案接管。
 *
 * 构建：scripts/build.mjs 把本文件打包成 lib/client.js（CJS + ModuleLoader 包装）。
 * 因此源码里不要 import 'react'，React 由 ModuleLoader 的 require 提供。
 */

interface SlotsService {
  inject(ownerKey: string, callback: () => () => void): void;
  register(
    options: { name: string; id: string; order?: number },
    component: unknown,
  ): () => void;
}

interface ClientContext {
  slots: SlotsService;
  effect?(fn: () => () => void): void;
}

interface RoomSummary {
  roomId: string;
  title: string;
  phase: string;
  gmMode: 'ai' | 'human';
  inviteCode: string;
}

const DEFAULT_BASE = 'http://127.0.0.1:45871';

const styles = {
  dock: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--dsw-alias-label-secondary)',
  } as Record<string, unknown>,
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
    cursor: 'pointer',
  } as Record<string, unknown>,
  panel: {
    marginTop: 8,
    padding: 12,
    borderRadius: 10,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    maxWidth: 560,
  } as Record<string, unknown>,
  row: { display: 'flex', gap: 8, alignItems: 'center' } as Record<string, unknown>,
  input: {
    flex: 1,
    minWidth: 0,
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
  } as Record<string, unknown>,
  list: { margin: 0, paddingLeft: 18, fontSize: 12 } as Record<string, unknown>,
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } as Record<string, unknown>,
  ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 12 } as Record<string, unknown>,
  bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } as Record<string, unknown>,
};

async function requestJson(url: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: init?.body,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export function createPlugin(React: any) {
  const h = React.createElement;
  const { useCallback, useEffect, useState } = React;

  function TrpgDock() {
    const [open, setOpen] = useState(false);
    const [base, setBase] = useState(DEFAULT_BASE);
    const [status, setStatus] = useState({ kind: 'idle', text: '未连接' } as {
      kind: 'idle' | 'ok' | 'bad';
      text: string;
    });
    const [rooms, setRooms] = useState([] as RoomSummary[]);
    const [title, setTitle] = useState('鬼木崖·异光');
    const [gmMode, setGmMode] = useState('ai' as 'ai' | 'human');

    const trimmedBase = base.trim().replace(/\/+$/, '');

    const checkHealth = useCallback(async () => {
      setStatus({ kind: 'idle', text: '探测中…' });
      try {
        const health = (await requestJson(`${trimmedBase}/trpg/health`)) as { ok?: boolean; rooms?: number };
        if (health?.ok) {
          setStatus({ kind: 'ok', text: `房主在线 · 协议 v1 · 现有房间 ${health.rooms ?? 0}` });
          const payload = (await requestJson(`${trimmedBase}/trpg/rooms`)) as { rooms?: RoomSummary[] };
          setRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
        } else {
          setStatus({ kind: 'bad', text: '响应异常：缺少 ok 字段' });
        }
      } catch (error) {
        setStatus({ kind: 'bad', text: `连不上房主：${error instanceof Error ? error.message : String(error)}` });
      }
    }, [trimmedBase]);

    const createRoom = useCallback(async () => {
      setStatus({ kind: 'idle', text: '创建房间中…' });
      try {
        const payload = (await requestJson(`${trimmedBase}/trpg/rooms`, {
          method: 'POST',
          body: JSON.stringify({ title, gmMode }),
        })) as { room?: RoomSummary };
        if (payload.room) {
          setStatus({ kind: 'ok', text: `已创建房间：${payload.room.title} · 邀请码 ${payload.room.inviteCode}` });
          await checkHealth();
        } else {
          setStatus({ kind: 'bad', text: '创建失败：响应缺少 room' });
        }
      } catch (error) {
        setStatus({ kind: 'bad', text: `创建失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }, [trimmedBase, title, gmMode, checkHealth]);

    useEffect(() => {
      if (!open) return;
      void checkHealth();
    }, [open, checkHealth]);

    return h('div', { style: styles.dock }, [
      h(
        'button',
        {
          key: 'toggle',
          type: 'button',
          style: styles.button,
          onClick: () => setOpen((value: boolean) => !value),
          title: '跑团桌：局域网多人 AI 跑团',
        },
        `🎲 跑团桌${open ? ' ▲' : ' ▼'}`,
      ),
      h(
        'span',
        {
          key: 'status',
          style: status.kind === 'ok' ? styles.ok : status.kind === 'bad' ? styles.bad : styles.muted,
        },
        status.text,
      ),
      open
        ? h('div', { key: 'panel', style: styles.panel }, [
            h('div', { key: 'title', style: { fontWeight: 600 } }, '跑团桌 · 房间'),
            h('div', { key: 'hint', style: styles.muted }, 'M0 骨架：房间与连接服务已就绪；协议、角色卡、AI GM 在后续里程碑接入。'),
            h('div', { key: 'addr', style: styles.row }, [
              h('span', { key: 'label', style: styles.muted }, '房主地址'),
              h('input', {
                key: 'input',
                style: styles.input,
                value: base,
                onChange: (event: { target: { value: string } }) => setBase(event.target.value),
                spellCheck: false,
              }),
              h('button', { key: 'check', type: 'button', style: styles.button, onClick: () => void checkHealth() }, '检查'),
            ]),
            h('div', { key: 'create', style: styles.row }, [
              h('span', { key: 'label', style: styles.muted }, '新房间'),
              h('input', {
                key: 'title',
                style: styles.input,
                value: title,
                onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
              }),
              h(
                'select',
                {
                  key: 'gm',
                  style: { ...styles.input, flex: '0 0 120px' },
                  value: gmMode,
                  onChange: (event: { target: { value: string } }) =>
                    setGmMode(event.target.value === 'human' ? 'human' : 'ai'),
                },
                [
                  h('option', { key: 'ai', value: 'ai' }, 'AI 当 GM'),
                  h('option', { key: 'human', value: 'human' }, '真人 GM'),
                ],
              ),
              h('button', { key: 'create-btn', type: 'button', style: styles.button, onClick: () => void createRoom() }, '创建'),
            ]),
            rooms.length
              ? h(
                  'ul',
                  { key: 'rooms', style: styles.list },
                  rooms.map((room: RoomSummary) =>
                    h(
                      'li',
                      { key: room.roomId },
                      `${room.title} · 邀请码 ${room.inviteCode} · ${room.gmMode === 'ai' ? 'AI GM' : '真人 GM'} · ${room.phase}`,
                    ),
                  ),
                )
              : h('div', { key: 'empty', style: styles.muted }, '还没有房间。'),
          ])
        : null,
    ]);
  }

  return {
    inject: ['slots'],
    apply(ctx: ClientContext) {
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'dsh-trpg-table', order: 40 },
          TrpgDock,
        ),
      );
    },
  };
}
