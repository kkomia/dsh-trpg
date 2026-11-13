/**
 * 跑团桌 Client 半边（M2）：房间大厅 + 跑团桌界面。
 *
 * 布局（对应设计文档 §9）：
 * - 对话输入框下方 dock 打开「跑团桌」面板；
 * - 面板内：叙事流 + 玩家席 + 骰子 + 行动输入；
 * - M3 会把这套数据接到 DSH 会话的 conversation.view / 右侧栏（本文件的渲染逻辑可复用）。
 *
 * 构建：scripts/build.mjs 打包成 lib/client.js（CJS + ModuleLoader 包装）；
 * 因此源码里不要 import 'react'（由 ModuleLoader 注入），数据从 workspace 包静态打入。
 */
import { CARDS } from '@dsh-trpg/content';
import type {
  CreateRoomResult,
  DicePayload,
  GameEvent,
  JoinRoomResult,
  LockParams,
  RoomStateResult,
  RoomView,
  RollResult,
  SayResult,
} from '@dsh-trpg/protocol';

interface SlotsService {
  inject(ownerKey: string, callback: () => () => void): void;
  register(options: { name: string; id: string; order?: number }, component: unknown): () => void;
}

interface ClientContext {
  slots: SlotsService;
  effect?(fn: () => () => void): void;
}

const DEFAULT_BASE = 'http://127.0.0.1:45871';
const STORAGE_KEY = 'dsh-trpg:session:v1';
const MAX_FEED = 300;

interface StoredSession {
  base: string;
  hostToken?: string;
  playerToken?: string;
  playerId?: string;
  roomId?: string;
  inviteCode?: string;
  playerName?: string;
}

interface RpcResult<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

const CSS = {
  dock: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } as Record<string, unknown>,
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
  buttonPrimary: {
    padding: '5px 12px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-bg-base)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  } as Record<string, unknown>,
  panel: {
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    width: 'min(760px, 92vw)',
  } as Record<string, unknown>,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as Record<string, unknown>,
  input: {
    flex: 1,
    minWidth: 120,
    padding: '4px 8px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
  } as Record<string, unknown>,
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } as Record<string, unknown>,
  ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11 } as Record<string, unknown>,
  bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } as Record<string, unknown>,
  section: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 10,
    padding: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
  } as Record<string, unknown>,
  feed: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    maxHeight: 280,
    overflowY: 'auto',
    padding: 4,
  } as Record<string, unknown>,
  feedRow: { fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as Record<string, unknown>,
  diceCard: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    padding: '5px 8px',
    borderRadius: 8,
    border: '1px dashed var(--dsw-alias-border-l2)',
  } as Record<string, unknown>,
  die: {
    display: 'inline-block',
    minWidth: 20,
    textAlign: 'center',
    padding: '1px 5px',
    borderRadius: 5,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    fontVariantNumeric: 'tabular-nums',
  } as Record<string, unknown>,
  tag: {
    fontSize: 10,
    padding: '0 5px',
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
  } as Record<string, unknown>,
  party: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 } as Record<string, unknown>,
  dot: { width: 6, height: 6, borderRadius: 999, display: 'inline-block' } as Record<string, unknown>,
};

async function callRpc<T>(base: string, method: string, params: unknown, token?: string): Promise<T> {
  const response = await fetch(`${base.replace(/\/+$/, '')}/trpg/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params, token, clientVersion: '0.2.0' }),
  });
  const payload = (await response.json()) as RpcResult<T>;
  if (!payload.ok) throw new Error(payload.error?.message ?? `RPC 失败：${method}`);
  return payload.result as T;
}

function loadSession(): StoredSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function saveSession(session: StoredSession | null): void {
  try {
    if (session) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

function diceText(payload: DicePayload): string {
  const dice = payload.dice.map((die) => `${die}`).join(' + ');
  const modifier = payload.modifier > 0 ? ` + ${payload.modifier}` : payload.modifier < 0 ? ` - ${Math.abs(payload.modifier)}` : '';
  return `${dice}${modifier} = ${payload.total}`;
}

export function createPlugin(React: any) {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;

  function TrpgPanel() {
    const [open, setOpen] = useState(false);
    const [session, setSession] = useState(loadSession() as StoredSession | null);
    const [room, setRoom] = useState(null as RoomView | null);
    const [feed, setFeed] = useState([] as GameEvent[]);
    const [status, setStatus] = useState({ kind: 'idle', text: '未连接' } as {
      kind: 'idle' | 'ok' | 'bad';
      text: string;
    });
    const [base, setBase] = useState(session?.base ?? DEFAULT_BASE);
    const [playerName, setPlayerName] = useState(session?.playerName ?? '冒险者');
    const [inviteCode, setInviteCode] = useState('');
    const [title, setTitle] = useState('鬼木崖·异光');
    const [gmMode, setGmMode] = useState('ai' as 'ai' | 'human');
    const [expression, setExpression] = useState('d20');
    const [privateRoll, setPrivateRoll] = useState(false);
    const [sayText, setSayText] = useState('');
    const [sayPrivate, setSayPrivate] = useState(false);
    const [seatCardId, setSeatCardId] = useState(CARDS[0]?.id ?? '');
    const [busy, setBusy] = useState(false);
    const lastSeqRef = useRef(0);
    const sourceRef = useRef(null as { close: () => void } | null);
    const feedRef = useRef([] as GameEvent[]);

    const token = session?.hostToken ?? session?.playerToken;
    const isHost = Boolean(session?.hostToken);
    const myCharacter = useMemo(() => {
      if (!room || !session) return undefined;
      const me = session.playerId
        ? room.players.find((entry: RoomView['players'][number]) => entry.playerId === session.playerId)
        : room.players.find((entry: RoomView['players'][number]) => entry.playerId === 'host');
      return me;
    }, [room, session]);

    const appendFeed = useCallback((event: GameEvent) => {
      if (event.seq <= lastSeqRef.current && event.kind !== 'room') return;
      lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      if (event.kind === 'room') return;
      const next = [...feedRef.current, event].slice(-MAX_FEED);
      feedRef.current = next;
      setFeed(next);
    }, []);

    const handleEvent = useCallback(
      (event: GameEvent) => {
        if (event.kind === 'room') {
          setRoom(event.payload as RoomView);
          lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
          return;
        }
        if ((event.payload as { close?: boolean } | null)?.close === true) {
          appendFeed(event);
          setStatus({ kind: 'bad', text: (event.payload as { text?: string }).text ?? '连接已断开' });
          sourceRef.current?.close();
          saveSession(null);
          setSession(null);
          setRoom(null);
          return;
        }
        appendFeed(event);
      },
      [appendFeed],
    );

    const connect = useCallback(
      (targetSession: StoredSession) => {
        sourceRef.current?.close();
        const activeToken = targetSession.hostToken ?? targetSession.playerToken;
        if (!activeToken) return;
        const url = `${targetSession.base.replace(/\/+$/, '')}/trpg/events?token=${encodeURIComponent(activeToken)}&lastSeq=${lastSeqRef.current}`;
        let closed = false;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        const source = new EventSource(url);
        const close = () => {
          closed = true;
          source.close();
          if (retryTimer) clearTimeout(retryTimer);
        };
        source.addEventListener('game', (raw: { data: string }) => {
          try {
            handleEvent(JSON.parse(raw.data) as GameEvent);
          } catch {
            /* 忽略坏帧 */
          }
        });
        source.onerror = () => {
          source.close();
          if (closed) return;
          retryTimer = setTimeout(() => {
            if (closed) return;
            connect(targetSession);
          }, 2000);
        };
        sourceRef.current = { close };
      },
      [handleEvent],
    );

    const refreshRoom = useCallback(
      async (targetSession: StoredSession) => {
        const activeToken = targetSession.hostToken ?? targetSession.playerToken;
        if (!activeToken) return;
        try {
          const state = await callRpc<RoomStateResult>(targetSession.base, 'room.state', {}, activeToken);
          setRoom(state.room);
          setStatus({ kind: 'ok', text: '已进入房间' });
        } catch (error) {
          setStatus({ kind: 'bad', text: `无法恢复房间：${error instanceof Error ? error.message : String(error)}` });
          saveSession(null);
          setSession(null);
          setRoom(null);
        }
      },
      [],
    );

    // 启动：恢复上次会话
    useEffect(() => {
      if (!open || !session) return;
      lastSeqRef.current = 0;
      void refreshRoom(session).then(() => connect({ ...session }));
      return () => sourceRef.current?.close();
    }, [open, session, connect, refreshRoom]);

    useEffect(() => {
      if (!open) return;
      return () => sourceRef.current?.close();
    }, [open]);

    const enterRoom = useCallback((next: StoredSession) => {
      saveSession(next);
      setSession(next);
      setBase(next.base);
    }, []);

    const createRoom = useCallback(async () => {
      setBusy(true);
      setStatus({ kind: 'idle', text: '创建房间中…' });
      try {
        const normalizedBase = base.trim().replace(/\/+$/, '');
        const created = await callRpc<CreateRoomResult>(normalizedBase, 'room.create', { title, gmMode });
        lastSeqRef.current = 0;
        feedRef.current = [];
        setFeed([]);
        setRoom(created.room);
        enterRoom({ base: normalizedBase, hostToken: created.hostToken, roomId: created.room.roomId, inviteCode: created.inviteCode });
        setStatus({ kind: 'ok', text: `房间已创建，邀请码 ${created.inviteCode}` });
      } catch (error) {
        setStatus({ kind: 'bad', text: `创建失败：${error instanceof Error ? error.message : String(error)}（创建房间需要在房主本机）` });
      } finally {
        setBusy(false);
      }
    }, [base, title, gmMode, enterRoom]);

    const joinRoom = useCallback(async () => {
      setBusy(true);
      setStatus({ kind: 'idle', text: '加入房间中…' });
      try {
        const normalizedBase = base.trim().replace(/\/+$/, '');
        const joined = await callRpc<JoinRoomResult>(normalizedBase, 'room.join', {
          inviteCode: inviteCode.trim(),
          playerName: playerName.trim(),
        });
        lastSeqRef.current = 0;
        feedRef.current = [];
        setFeed([]);
        setRoom(joined.room);
        enterRoom({
          base: normalizedBase,
          playerToken: joined.playerToken,
          playerId: joined.playerId,
          roomId: joined.room.roomId,
          playerName: playerName.trim(),
        });
        setStatus({ kind: 'ok', text: '已加入房间' });
      } catch (error) {
        setStatus({ kind: 'bad', text: `加入失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [base, inviteCode, playerName, enterRoom]);

    const seat = useCallback(async () => {
      if (!session || !token) return;
      const card = CARDS.find((entry) => entry.id === seatCardId) ?? CARDS[0];
      if (!card) return;
      setBusy(true);
      try {
        const result = await callRpc<RoomStateResult>(session.base, 'room.seat', { characterCard: card }, token);
        setRoom(result.room);
        setStatus({ kind: 'ok', text: `已落座：${card.identity.name}` });
      } catch (error) {
        setStatus({ kind: 'bad', text: `落座失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [session, token, seatCardId]);

    const roll = useCallback(async () => {
      if (!session || !token) return;
      setBusy(true);
      try {
        const result = await callRpc<RollResult>(session.base, 'room.roll', {
          expression: expression.trim(),
          private: privateRoll,
        }, token);
        appendFeed(result.event);
      } catch (error) {
        setStatus({ kind: 'bad', text: `掷骰失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [session, token, expression, privateRoll, appendFeed]);

    const say = useCallback(async () => {
      if (!session || !token || !sayText.trim()) return;
      setBusy(true);
      try {
        const text = sayText;
        setSayText('');
        const result = await callRpc<SayResult>(session.base, 'room.say', { text, private: sayPrivate }, token);
        appendFeed(result.event);
      } catch (error) {
        setStatus({ kind: 'bad', text: `发送失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [session, token, sayText, sayPrivate, appendFeed]);

    const kick = useCallback(
      async (playerId: string) => {
        if (!session || !token) return;
        try {
          const result = await callRpc<RoomStateResult>(session.base, 'room.kick', { playerId }, token);
          setRoom(result.room);
        } catch (error) {
          setStatus({ kind: 'bad', text: `踢人失败：${error instanceof Error ? error.message : String(error)}` });
        }
      },
      [session, token],
    );

    const toggleLock = useCallback(async () => {
      if (!session || !token || !room) return;
      const params: LockParams = { locked: !room.locked };
      try {
        const result = await callRpc<RoomStateResult>(session.base, 'room.lock', params, token);
        setRoom(result.room);
      } catch (error) {
        setStatus({ kind: 'bad', text: `锁定失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }, [session, token, room]);

    const leave = useCallback(async () => {
      if (session && token && !session.hostToken) {
        try {
          await callRpc(session.base, 'room.leave', {}, token);
        } catch {
          /* 忽略 */
        }
      }
      sourceRef.current?.close();
      saveSession(null);
      setSession(null);
      setRoom(null);
      setFeed([]);
      lastSeqRef.current = 0;
      feedRef.current = [];
      setStatus({ kind: 'idle', text: '已离开房间' });
    }, [session, token]);

    const renderFeedEntry = (event: GameEvent, index: number) => {
      if (event.kind === 'dice') {
        const payload = event.payload as DicePayload;
        return h('div', { key: `${event.seq}-${index}`, style: { ...CSS.diceCard, borderStyle: payload.private ? 'solid' : 'dashed' } }, [
          h('span', { key: 'roller', style: CSS.muted }, payload.rollerName),
          ...(payload.label ? [h('span', { key: 'label' }, payload.label)] : []),
          h('span', { key: 'expr', style: CSS.muted }, payload.expression),
          ...payload.dice.map((die, dieIndex) => h('span', { key: `die-${dieIndex}`, style: CSS.die }, `${die}`)),
          h('span', { key: 'total', style: { fontWeight: 700 } }, `= ${payload.total}`),
          payload.private ? h('span', { key: 'private', style: CSS.tag }, '私骰') : null,
        ]);
      }
      if (event.kind === 'narration') {
        const payload = event.payload as { speaker: string; speakerName?: string; text: string };
        return h('div', { key: `${event.seq}-${index}`, style: CSS.feedRow }, [
          h('span', { key: 'speaker', style: { ...CSS.muted, marginRight: 6 } }, payload.speakerName ?? (payload.speaker === 'gm' ? 'GM' : '玩家')),
          h('span', { key: 'text' }, payload.text),
        ]);
      }
      if (event.kind === 'combat') {
        const payload = event.payload as {
          view?: {
            round: number;
            activeName: string;
            order: Array<{ id: string; name: string; kind: string; hp: number; maxHp: number; downed: boolean; dead: boolean }>;
          };
          note?: string;
        };
        const view = payload.view;
        return h(
          'div',
          { key: `${event.seq}-${index}`, style: { ...CSS.section, display: 'flex', flexDirection: 'column', gap: 4 } },
          [
            h('div', { key: 'head', style: { fontSize: 12, fontWeight: 600 } }, `⚔ 第 ${view?.round ?? '?'} 轮 · 轮到 ${view?.activeName ?? '?'}`),
            h(
              'div',
              { key: 'order', style: { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11 } },
              (view?.order ?? []).map((entry) =>
                h('span', { key: entry.id, style: { ...CSS.tag, color: entry.dead ? 'var(--dsw-alias-state-error-primary)' : entry.kind === 'pc' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-state-warn-primary)' } },
                  `${entry.name} ${entry.dead ? '阵亡' : entry.downed ? '倒地' : `${entry.hp}/${entry.maxHp}`}`),
              ),
            ),
            payload.note ? h('div', { key: 'note', style: CSS.muted }, payload.note) : null,
          ],
        );
      }
      if (event.kind === 'alert') {
        const payload = event.payload as { level: string; text: string };
        return h('div', { key: `${event.seq}-${index}`, style: { ...CSS.muted, fontStyle: 'italic' } }, `— ${payload.text} —`);
      }
      return h('div', { key: `${event.seq}-${index}`, style: CSS.muted }, `[${event.kind}]`);
    };

    const seatOptions = CARDS.map((card) =>
      h('option', { key: card.id, value: card.id }, `${card.identity.name}（${card.identity.class} ${card.identity.level} 级）`),
    );

    return h('div', { style: CSS.dock }, [
      h(
        'button',
        {
          key: 'toggle',
          type: 'button',
          style: CSS.button,
          onClick: () => setOpen((value: boolean) => !value),
        },
        `🎲 跑团桌${room ? ` · ${room.title}` : ''}${open ? ' ▲' : ' ▼'}`,
      ),
      h('span', { key: 'status', style: status.kind === 'ok' ? CSS.ok : status.kind === 'bad' ? CSS.bad : CSS.muted }, status.text),
      open
        ? h('div', { key: 'panel', style: CSS.panel }, [
            h('div', { key: 'header', style: CSS.row }, [
              h('strong', { key: 'title' }, '跑团桌 · 局域网多人跑团'),
              h('span', { key: 'space', style: { flex: 1 } }),
              session ? h('button', { key: 'leave', type: 'button', style: CSS.button, onClick: () => void leave() }, '退出房间') : null,
            ]),

            !session
              ? h('div', { key: 'lobby', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                  h('div', { key: 'base', style: CSS.row }, [
                    h('span', { key: 'label', style: CSS.muted }, '房主地址'),
                    h('input', {
                      key: 'input',
                      style: CSS.input,
                      value: base,
                      spellCheck: false,
                      onChange: (event: { target: { value: string } }) => setBase(event.target.value),
                    }),
                  ]),
                  h('div', { key: 'cols', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                    h('div', { key: 'host', style: { ...CSS.section, flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 6 } }, [
                      h('strong', { key: 'h' }, '我是房主'),
                      h('input', {
                        key: 'title',
                        style: CSS.input,
                        value: title,
                        onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
                      }),
                      h(
                        'select',
                        {
                          key: 'gm',
                          style: CSS.input,
                          value: gmMode,
                          onChange: (event: { target: { value: string } }) =>
                            setGmMode(event.target.value === 'human' ? 'human' : 'ai'),
                        },
                        [h('option', { key: 'ai', value: 'ai' }, 'AI 当 GM'), h('option', { key: 'human', value: 'human' }, '真人 GM')],
                      ),
                      h('button', { key: 'create', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void createRoom() }, '创建房间'),
                      h('span', { key: 'hint', style: CSS.muted }, '创建房间需要在房主本机（loopback）。'),
                    ]),
                    h('div', { key: 'join', style: { ...CSS.section, flex: '1 1 260px', display: 'flex', flexDirection: 'column', gap: 6 } }, [
                      h('strong', { key: 'j' }, '加入朋友的团'),
                      h('input', {
                        key: 'code',
                        style: CSS.input,
                        placeholder: '邀请码（如 7F3K9Q）',
                        value: inviteCode,
                        onChange: (event: { target: { value: string } }) => setInviteCode(event.target.value),
                      }),
                      h('input', {
                        key: 'name',
                        style: CSS.input,
                        placeholder: '你的玩家名',
                        value: playerName,
                        onChange: (event: { target: { value: string } }) => setPlayerName(event.target.value),
                      }),
                      h('button', { key: 'join-btn', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void joinRoom() }, '加入房间'),
                      h('span', { key: 'hint', style: CSS.muted }, '加入后用「落座」选择一张预制角色卡。'),
                    ]),
                  ]),
                ])
              : h('div', { key: 'room', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
                  h('div', { key: 'roombar', style: CSS.row }, [
                    h('strong', { key: 'roomtitle' }, room?.title ?? '房间'),
                    h('span', { key: 'phase', style: CSS.tag }, room?.phase ?? 'lobby'),
                    h('span', { key: 'gm', style: CSS.tag }, room?.gmMode === 'human' ? '真人 GM' : 'AI GM'),
                    isHost && room?.inviteCode ? h('span', { key: 'invite', style: CSS.tag }, `邀请码 ${room.inviteCode}`) : null,
                    room?.locked ? h('span', { key: 'locked', style: CSS.tag }, '已锁定') : null,
                    h('span', { key: 'count', style: CSS.muted }, `${room?.players.length ?? 0} 人在桌`),
                    isHost ? h('button', { key: 'lock', type: 'button', style: CSS.button, onClick: () => void toggleLock() }, room?.locked ? '解锁' : '锁房') : null,
                  ]),
                  h('div', { key: 'body', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                    h('div', { key: 'feedbox', style: { ...CSS.section, flex: '2 1 420px', display: 'flex', flexDirection: 'column', gap: 6 } }, [
                      h('strong', { key: 'f' }, '叙事流'),
                      h('div', { key: 'feed', style: CSS.feed }, feed.length ? feed.map(renderFeedEntry) : h('span', { style: CSS.muted }, '还没有事件。掷个骰或说句话吧。')),
                    ]),
                    h('div', { key: 'side', style: { flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: 8 } }, [
                      h('div', { key: 'party', style: { ...CSS.section, display: 'flex', flexDirection: 'column', gap: 6 } }, [
                        h('strong', { key: 'p' }, '玩家席'),
                        h(
                          'div',
                          { key: 'list', style: CSS.party },
                          (room?.players ?? []).map((entry: RoomView['players'][number]) =>
                            h('div', { key: entry.playerId, style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
                              h('span', {
                                key: 'dot',
                                style: { ...CSS.dot, background: entry.online ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' },
                              }),
                              h('span', { key: 'name' }, entry.displayName),
                              h('span', { key: 'char', style: CSS.muted }, entry.characterName ? `· ${entry.characterName}` : '· 未落座'),
                              entry.playerId === 'host' ? h('span', { key: 'hosttag', style: CSS.tag }, 'GM') : null,
                              isHost && entry.playerId !== 'host'
                                ? h('button', { key: 'kick', type: 'button', style: { ...CSS.button, padding: '0 6px', fontSize: 10 }, onClick: () => void kick(entry.playerId) }, '移除')
                                : null,
                            ]),
                          ),
                        ),
                        myCharacter?.characterName
                          ? h('span', { key: 'mine', style: CSS.muted }, `我的角色：${myCharacter.characterName}`)
                          : h('div', { key: 'seat', style: CSS.row }, [
                              h('select', {
                                key: 'seatselect',
                                style: { ...CSS.input, flex: '1 1 140px' },
                                value: seatCardId,
                                onChange: (event: { target: { value: string } }) => setSeatCardId(event.target.value),
                              }, seatOptions),
                              h('button', { key: 'seatbtn', type: 'button', style: CSS.button, onClick: () => void seat() }, '落座'),
                            ]),
                      ]),
                      h('div', { key: 'dice', style: { ...CSS.section, display: 'flex', flexDirection: 'column', gap: 6 } }, [
                        h('strong', { key: 'd' }, '掷骰'),
                        h('div', { key: 'dicerow', style: CSS.row }, [
                          h('input', {
                            key: 'expr',
                            style: { ...CSS.input, flex: '1 1 80px' },
                            value: expression,
                            spellCheck: false,
                            onChange: (event: { target: { value: string } }) => setExpression(event.target.value),
                          }),
                          h('label', { key: 'priv', style: { ...CSS.muted, display: 'flex', alignItems: 'center', gap: 4 } }, [
                            h('input', {
                              key: 'checkbox',
                              type: 'checkbox',
                              checked: privateRoll,
                              onChange: (event: { target: { checked: boolean } }) => setPrivateRoll(event.target.checked),
                            }),
                            '私骰',
                          ]),
                          h('button', { key: 'roll', type: 'button', style: CSS.button, onClick: () => void roll() }, '掷'),
                        ]),
                        h('span', { key: 'dicehint', style: CSS.muted }, '骰子由房主服务端掷，可复现。'),
                      ]),
                      h('div', { key: 'say', style: { ...CSS.section, display: 'flex', flexDirection: 'column', gap: 6 } }, [
                        h('strong', { key: 's' }, '我的行动 / RP'),
                        h('textarea', {
                          key: 'text',
                          style: { ...CSS.input, minHeight: 56, resize: 'vertical' },
                          value: sayText,
                          placeholder: '例：我推开门，先看一眼门缝里的光。',
                          onChange: (event: { target: { value: string } }) => setSayText(event.target.value),
                        }),
                        h('div', { key: 'sayrow', style: CSS.row }, [
                          h('label', { key: 'whisper', style: { ...CSS.muted, display: 'flex', alignItems: 'center', gap: 4 } }, [
                            h('input', {
                              key: 'checkbox',
                              type: 'checkbox',
                              checked: sayPrivate,
                              onChange: (event: { target: { checked: boolean } }) => setSayPrivate(event.target.checked),
                            }),
                            '悄悄话给 GM',
                          ]),
                          h('button', { key: 'send', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void say() }, '发送'),
                        ]),
                      ]),
                    ]),
                  ]),
                ]),
          ])
        : null,
    ]);
  }

  return {
    inject: ['slots'],
    apply(ctx: ClientContext) {
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-trpg-table', order: 40 }, TrpgPanel),
      );
    },
  };
}
