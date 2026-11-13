/**
 * 跑团桌 Client 半边（v2）。
 *
 * 布局：
 * - 注册为主区域面板 `main`（key = trpg）：打开后整块主区域就是「跑团桌」页面，
 *   中间是叙事对话流，下方是行动输入框 —— 不再占用输入框下方的 dock 条。
 * - 侧边栏面板图标（`sidebar.panellist`）与对话顶栏按钮（`conversation.session.header.actions`）作为入口。
 * - 没有房间时页面是大厅（建房 / 加入 / 本地角色卡库）。
 *
 * 构建：scripts/build.mjs 打包成 lib/client.js（CJS + ModuleLoader 包装）；
 * 因此源码里不要 import 'react'（由 ModuleLoader 注入），数据从 workspace 包静态打入。
 */
import { CARDS, GUIMUYA_MODULE } from '@dsh-trpg/content';
import {
  copyFromPregen,
  exportCardText,
  importCard,
  loadLocalCards,
  mergeGrowthIntoCard,
  removeLocalCard,
  saveLocalCards,
  upsertLocalCard,
  type LocalCardRecord,
} from './cards.ts';
import {
  growthToCardPatch,
  loadGrowth,
  mergeGrowth,
  roomToMarkdown,
  saveGrowth,
  type GrowthState,
} from './export.ts';
import type {
  AwardPayload,
  CreateRoomResult,
  DicePayload,
  GameEvent,
  JoinRoomResult,
  LockParams,
  NarrationPayload,
  RoomStateResult,
  RoomView,
  RollResult,
  SayResult,
} from '@dsh-trpg/protocol';

interface SlotsService {
  inject(ownerKey: string, callback: () => () => void): () => void;
  register(
    options: {
      name: string;
      id?: string;
      key?: string;
      order?: number;
      label?: string | (() => string);
      inject?: () => Record<string, unknown>;
    },
    component: unknown,
  ): () => void;
}

interface LayoutService {
  selectPanel(panelId: string | null): void;
}

interface ClientContext {
  slots: SlotsService;
  get?(id: string): unknown;
  effect?(fn: () => () => void): void;
}

/** main 面板 key：同时是 sidebar.panellist 的 id。 */
const MAIN_PANEL_ID = 'trpg';
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
  page: {
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    minWidth: 0,
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
  } as Record<string, unknown>,
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '10px 20px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    flexShrink: 0,
  } as Record<string, unknown>,
  brand: { fontSize: 15, fontWeight: 700, letterSpacing: 0.2 } as Record<string, unknown>,
  headTitle: { fontSize: 14, fontWeight: 600, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as Record<string, unknown>,
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    padding: '12px 20px 16px',
    boxSizing: 'border-box',
  } as Record<string, unknown>,
  chatCol: { flex: '1 1 340px', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 } as Record<string, unknown>,
  feed: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '4px 6px 8px',
  } as Record<string, unknown>,
  rail: {
    flex: '1 0 300px', maxWidth: 360,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    overflowY: 'auto',
    maxHeight: '100%',
    boxSizing: 'border-box',
  } as Record<string, unknown>,
  composer: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    flexShrink: 0,
  } as Record<string, unknown>,
  composerInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    maxHeight: 180,
    resize: 'none',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 13,
    lineHeight: 1.65,
    padding: '3px 0',
    fontFamily: 'inherit',
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
    whiteSpace: 'nowrap',
  } as Record<string, unknown>,
  buttonPrimary: {
    padding: '6px 16px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-bg-base)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  } as Record<string, unknown>,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } as Record<string, unknown>,
  input: {
    flex: 1,
    minWidth: 80,
    boxSizing: 'border-box',
    padding: '5px 9px',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
    fontFamily: 'inherit',
  } as Record<string, unknown>,
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } as Record<string, unknown>,
  ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11 } as Record<string, unknown>,
  bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } as Record<string, unknown>,
  section: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 10,
    padding: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    flexShrink: 0,
  } as Record<string, unknown>,
  msgRow: { display: 'flex', gap: 8, alignItems: 'flex-start' } as Record<string, unknown>,
  msgRowMine: { display: 'flex', gap: 8, alignItems: 'flex-start', flexDirection: 'row-reverse' } as Record<string, unknown>,
  avatar: {
    width: 26,
    height: 26,
    flex: '0 0 26px',
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
    fontWeight: 700,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)',
  } as Record<string, unknown>,
  avatarGm: {
    width: 26,
    height: 26,
    flex: '0 0 26px',
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    fontWeight: 700,
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-bg-base)',
  } as Record<string, unknown>,
  msgCol: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, maxWidth: 'min(680px, 82%)' } as Record<string, unknown>,
  msgColMine: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    maxWidth: 'min(680px, 82%)',
    alignItems: 'flex-end',
  } as Record<string, unknown>,
  bubble: {
    padding: '8px 12px',
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)',
    fontSize: 13,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as Record<string, unknown>,
  bubbleGm: {
    padding: '8px 12px',
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    fontSize: 13,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as Record<string, unknown>,
  bubbleMine: {
    padding: '8px 12px',
    borderRadius: 12,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-bg-base)',
    fontSize: 13,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } as Record<string, unknown>,
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
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap',
  } as Record<string, unknown>,
  party: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12 } as Record<string, unknown>,
  dot: { width: 6, height: 6, borderRadius: 999, display: 'inline-block', flex: '0 0 6px' } as Record<string, unknown>,
  lobby: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    boxSizing: 'border-box',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
    padding: '32px 20px 40px',
  } as Record<string, unknown>,
  lobbyTitle: { fontSize: 22, fontWeight: 700, textAlign: 'center' } as Record<string, unknown>,
  lobbySub: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', maxWidth: 620, textAlign: 'center' } as Record<string, unknown>,
  lobbyCols: { display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', width: 'min(780px, 100%)', boxSizing: 'border-box' } as Record<string, unknown>,
  lobbyCard: {
    flex: '1 1 300px',
    minWidth: 0,
    maxWidth: 420,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    padding: 14,
    background: 'var(--dsw-alias-bg-layer-1)',
    boxSizing: 'border-box',
  } as Record<string, unknown>,
  emptyHint: { margin: 'auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, textAlign: 'center', lineHeight: 1.8 } as Record<string, unknown>,
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

function downloadText(name: string, text: string, mediaType = 'text/plain;charset=utf-8'): void {
  try {
    const blob = new Blob([text], { type: mediaType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* 非浏览器环境忽略 */
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function createPlugin(React: any) {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;

  /** 侧边栏面板图标。 */
  function TrpgSidebarIcon(props: { size?: number; active?: boolean }) {
    const size = props?.size ?? 16;
    return h(
      'svg',
      {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props?.active ? 1.7 : 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
      [
        h('path', { key: 'dice', d: 'M8 1.8 13.6 5v6L8 14.2 2.4 11V5L8 1.8Z' }),
        h('circle', { key: 'p1', cx: 8, cy: 5.7, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'p2', cx: 5.4, cy: 9.6, r: 0.7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'p3', cx: 10.6, cy: 9.6, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      ],
    );
  }

  /** 对话顶栏快捷入口。 */
  function OpenTableButton(props: { onOpen?: () => void }) {
    return h(
      'button',
      {
        type: 'button',
        title: '打开跑团桌',
        style: { ...CSS.button, padding: '3px 8px', fontSize: 11 },
        onClick: () => props?.onOpen?.(),
      },
      '🎲 跑团桌',
    );
  }

  /** 主区域整页：叙事对话流 + 行动输入框 + 右侧桌面。 */
  function TrpgTable(props: { goHome?: () => void }) {
    const [session, setSession] = useState(loadSession() as StoredSession | null);
    const [room, setRoom] = useState(null as RoomView | null);
    const [feed, setFeed] = useState([] as GameEvent[]);
    const [status, setStatus] = useState({ kind: 'idle', text: '未连接' } as {
      kind: 'idle' | 'ok' | 'bad';
      text: string;
    });
    const [base, setBase] = useState(() => loadSession()?.base ?? DEFAULT_BASE);
    const [playerName, setPlayerName] = useState(() => loadSession()?.playerName ?? '冒险者');
    const [inviteCode, setInviteCode] = useState('');
    const [title, setTitle] = useState('鬼木崖·异光');
    const [gmMode, setGmMode] = useState('ai' as 'ai' | 'human');
    const [expression, setExpression] = useState('d20');
    const [privateRoll, setPrivateRoll] = useState(false);
    const [sayText, setSayText] = useState('');
    const [sayPrivate, setSayPrivate] = useState(false);
    const [seatCardId, setSeatCardId] = useState(CARDS[0]?.id ?? '');
    const [localCards, setLocalCards] = useState(loadLocalCards() as LocalCardRecord[]);
    const [selectedLocalId, setSelectedLocalId] = useState('');
    const fileInputRef = useRef(null as { click?: () => void } | null);
    const [busy, setBusy] = useState(false);
    const [growth, setGrowth] = useState(null as GrowthState | null);
    const growthRef = useRef(null as GrowthState | null);
    // 真人 GM 控制台
    const [gmOpen, setGmOpen] = useState(false);
    const [gmText, setGmText] = useState('');
    const [gmPlayerId, setGmPlayerId] = useState('');
    const [gmSecretText, setGmSecretText] = useState('');
    const [gmSceneId, setGmSceneId] = useState(GUIMUYA_MODULE.scenes[0]?.id ?? '');
    const [awardXp, setAwardXp] = useState('50');
    const [awardItems, setAwardItems] = useState('');
    const lastSeqRef = useRef(0);
    const sourceRef = useRef(null as { close: () => void } | null);
    const feedRef = useRef([] as GameEvent[]);
    const feedDomRef = useRef(null as { scrollTop: number; scrollHeight: number } | null);

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
        if (event.kind === 'award' && session?.playerId && event.to === session.playerId) {
          const roomId = session.roomId ?? '';
          const next = mergeGrowth(growthRef.current, roomId, event as GameEvent<'award', AwardPayload>);
          growthRef.current = next;
          saveGrowth(roomId, session.playerId, next);
          setGrowth(next);
        }
        appendFeed(event);
      },
      [appendFeed, session],
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

    const refreshRoom = useCallback(async (targetSession: StoredSession) => {
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
    }, []);


    // 恢复上次会话：拉状态 + 连 SSE。
    useEffect(() => {
      if (!session) return;
      lastSeqRef.current = 0;
      if (session.roomId && session.playerId) {
        const loaded = loadGrowth(session.roomId, session.playerId);
        growthRef.current = loaded;
        setGrowth(loaded);
      }
      void refreshRoom(session).then(() => connect({ ...session }));
      return () => sourceRef.current?.close();
    }, [session, connect, refreshRoom]);

    // 新事件自动滚到底部。
    useEffect(() => {
      const element = feedDomRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    }, [feed.length]);

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

    const selectedLocalCard = localCards.find((record: LocalCardRecord) => record.card.id === selectedLocalId) ?? null;

    const savePregenCopy = useCallback(() => {
      const pregen = CARDS.find((entry) => entry.id === seatCardId) ?? CARDS[0];
      if (!pregen) return;
      const record = copyFromPregen(pregen);
      const next = upsertLocalCard(localCards, record);
      setLocalCards(next);
      saveLocalCards(next);
      setSelectedLocalId(record.card.id);
      setStatus({ kind: 'ok', text: `已保存本地卡：${record.card.identity.name}` });
    }, [localCards, seatCardId]);

    const importCardFile = useCallback(
      async (event: { target?: { files?: ArrayLike<File & { text(): Promise<string> }>; value?: string } }) => {
        const file = event?.target?.files?.[0];
        if (!file) return;
        const text = await file.text();
        const result = importCard(text);
        if (!result.ok || !result.record) {
          setStatus({ kind: 'bad', text: `导入失败：${result.errors.join('；')}` });
          return;
        }
        const next = upsertLocalCard(localCards, result.record);
        setLocalCards(next);
        saveLocalCards(next);
        setSelectedLocalId(result.record.card.id);
        setStatus({ kind: 'ok', text: `已导入角色卡：${result.record.card.identity.name}` });
        if (event.target) event.target.value = '';
      },
      [localCards],
    );

    const exportSelectedCard = useCallback(() => {
      if (!selectedLocalCard) return;
      downloadText(`card-${selectedLocalCard.card.identity.name}.json`, exportCardText(selectedLocalCard.card), 'application/json;charset=utf-8');
    }, [selectedLocalCard]);

    const deleteSelectedCard = useCallback(() => {
      if (!selectedLocalCard) return;
      const next = removeLocalCard(localCards, selectedLocalCard.card.id);
      setLocalCards(next);
      saveLocalCards(next);
      setSelectedLocalId('');
      setStatus({ kind: 'ok', text: '已删除本地卡' });
    }, [localCards, selectedLocalCard]);

    const mergeGrowthToCard = useCallback(() => {
      if (!selectedLocalCard || !growth) return;
      const merged = mergeGrowthIntoCard(selectedLocalCard.card, growth.items);
      const next = upsertLocalCard(localCards, { ...selectedLocalCard, card: merged.card, updatedAt: Date.now() });
      setLocalCards(next);
      saveLocalCards(next);
      setStatus({ kind: 'ok', text: `已合并 ${merged.addedItems.length} 件奖励物品到本地卡` });
    }, [localCards, selectedLocalCard, growth]);

    const seat = useCallback(async () => {
      if (!session || !token) return;
      const card = selectedLocalCard?.card ?? CARDS.find((entry) => entry.id === seatCardId) ?? CARDS[0];
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
    }, [session, token, seatCardId, selectedLocalCard]);

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

    // 真人 GM 控制台动作
    const gmNarrate = useCallback(async () => {
      if (!session || !token || !gmText.trim()) return;
      setBusy(true);
      try {
        const text = gmText;
        setGmText('');
        await callRpc(session.base, 'gm.narrate', { text }, token);
      } catch (error) {
        setStatus({ kind: 'bad', text: `旁白发送失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [session, token, gmText]);

    const gmSecret = useCallback(async () => {
      if (!session || !token || !gmPlayerId || !gmSecretText.trim()) return;
      setBusy(true);
      try {
        const text = gmSecretText;
        setGmSecretText('');
        await callRpc(session.base, 'gm.secret', { playerId: gmPlayerId, text }, token);
      } catch (error) {
        setStatus({ kind: 'bad', text: `私发失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [session, token, gmPlayerId, gmSecretText]);

    const gmScene = useCallback(async () => {
      if (!session || !token || !gmSceneId) return;
      const scene = GUIMUYA_MODULE.scenes.find((entry) => entry.id === gmSceneId);
      try {
        await callRpc(session.base, 'gm.scene', { sceneId: gmSceneId, title: scene?.title }, token);
      } catch (error) {
        setStatus({ kind: 'bad', text: `推进场景失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }, [session, token, gmSceneId]);

    const gmAward = useCallback(async () => {
      if (!session || !token || !gmPlayerId) return;
      const xp = Number.parseInt(awardXp, 10);
      const items = awardItems
        .split(/[,，\s]+/)
        .map((item: string) => item.trim())
        .filter(Boolean);
      try {
        await callRpc(session.base, 'gm.award', { playerId: gmPlayerId, xp: Number.isFinite(xp) ? xp : 0, items }, token);
      } catch (error) {
        setStatus({ kind: 'bad', text: `发放奖励失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }, [session, token, gmPlayerId, awardXp, awardItems]);

    const copyInvite = useCallback(async () => {
      if (!room?.inviteCode) return;
      const ok = await copyText(room.inviteCode);
      setStatus({ kind: ok ? 'ok' : 'bad', text: ok ? `邀请码 ${room.inviteCode} 已复制` : '复制失败，请手动记下邀请码' });
    }, [room]);

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

    // ---------------------------------------------------------------- 事件渲染

    const renderChatEntry = (event: GameEvent, index: number) => {
      const key = `${event.seq}-${index}`;
      if (event.kind === 'narration') {
        const payload = event.payload as NarrationPayload;
        const gm = payload.speaker === 'gm';
        const mine = Boolean(session?.playerId && payload.playerId === session.playerId);
        const name = payload.speakerName ?? (gm ? 'GM' : payload.speaker === 'system' ? '系统' : '玩家');
        return h('div', { key, style: mine ? CSS.msgRowMine : CSS.msgRow }, [
          h('div', { key: 'avatar', style: gm ? CSS.avatarGm : CSS.avatar }, gm ? 'GM' : name.slice(0, 1)),
          h('div', { key: 'col', style: mine ? CSS.msgColMine : CSS.msgCol }, [
            h('span', { key: 'name', style: CSS.muted }, name),
            h('div', { key: 'bubble', style: gm ? CSS.bubbleGm : mine ? CSS.bubbleMine : CSS.bubble }, payload.text),
          ]),
        ]);
      }
      if (event.kind === 'dice') {
        const payload = event.payload as DicePayload;
        return h('div', { key, style: { display: 'flex', justifyContent: 'center' } }, [
          h('div', { key: 'card', style: { ...CSS.diceCard, borderStyle: payload.private ? 'solid' : 'dashed' } }, [
            h('span', { key: 'roller', style: CSS.muted }, payload.rollerName),
            ...(payload.label ? [h('span', { key: 'label' }, payload.label)] : []),
            h('span', { key: 'expr', style: CSS.muted }, payload.expression),
            ...payload.dice.map((die: number, dieIndex: number) => h('span', { key: `die-${dieIndex}`, style: CSS.die }, `${die}`)),
            h('span', { key: 'total', style: { fontWeight: 700 } }, `= ${payload.total}`),
            payload.check
              ? h('span', { key: 'check', style: payload.check.success ? { ...CSS.tag, color: 'var(--dsw-alias-state-success-primary)' } : { ...CSS.tag, color: 'var(--dsw-alias-state-error-primary)' } },
                `${payload.check.name} DC${payload.check.dc} ${payload.check.success ? '成功' : '失败'}`)
              : null,
            payload.private ? h('span', { key: 'private', style: CSS.tag }, '私骰') : null,
          ]),
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
        return h('div', { key, style: CSS.section }, [
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
        ]);
      }
      if (event.kind === 'scene') {
        const payload = event.payload as { sceneId: string; title?: string };
        return h('div', { key, style: { ...CSS.muted, textAlign: 'center', fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } }, `📍 场景推进：${payload.title ?? payload.sceneId}`);
      }
      if (event.kind === 'award') {
        const payload = event.payload as { xp: number; items: string[]; note?: string };
        return h('div', { key, style: { display: 'flex', justifyContent: 'center' } }, [
          h('div', { key: 'card', style: { ...CSS.diceCard, borderStyle: 'solid' } }, [
            h('span', { key: 'title', style: { fontWeight: 600 } }, '🎁 获得奖励'),
            h('span', { key: 'xp' }, `+${payload.xp} XP`),
            payload.items.length ? h('span', { key: 'items', style: CSS.muted }, payload.items.join('、')) : null,
            payload.note ? h('span', { key: 'note', style: CSS.muted }, payload.note) : null,
          ]),
        ]);
      }
      if (event.kind === 'alert') {
        const payload = event.payload as { level: string; text: string };
        return h('div', { key, style: { ...CSS.muted, fontStyle: 'italic', textAlign: 'center' } }, `— ${payload.text} —`);
      }
      return h('div', { key, style: CSS.muted }, `[${event.kind}]`);
    };

    const seatOptions = CARDS.map((card) =>
      h('option', { key: card.id, value: card.id }, `${card.identity.name}（${card.identity.class} ${card.identity.level} 级）`),
    );
    const localCardOptions = [
      h('option', { key: 'none', value: '' }, localCards.length ? '选择我的角色卡' : '（本地卡库为空）'),
      ...localCards.map((record: LocalCardRecord) =>
        h(
          'option',
          { key: record.card.id, value: record.card.id },
          `${record.card.identity.name}（${record.card.identity.class} ${record.card.identity.level} 级）`,
        ),
      ),
    ];
    const playerOptions = [
      h('option', { key: 'none', value: '' }, '选择玩家'),
      ...(room?.players ?? [])
        .filter((entry: RoomView['players'][number]) => entry.playerId !== 'host')
        .map((entry: RoomView['players'][number]) => h('option', { key: entry.playerId, value: entry.playerId }, entry.displayName)),
    ];

    // ---------------------------------------------------------------- 页面片段

    const head = h('div', { key: 'head', style: CSS.head }, [
      h('span', { key: 'brand', style: CSS.brand }, '🎲 跑团桌'),
      room ? h('span', { key: 'title', style: CSS.headTitle }, room.title) : null,
      room ? h('span', { key: 'phase', style: CSS.tag }, room.phase) : null,
      room ? h('span', { key: 'gm', style: CSS.tag }, room.gmMode === 'human' ? '真人 GM' : 'AI GM') : null,
      room?.scene ? h('span', { key: 'scene', style: CSS.tag }, `场景：${room.scene.title ?? room.scene.sceneId}`) : null,
      room?.locked ? h('span', { key: 'locked', style: CSS.tag }, '已锁定') : null,
      room ? h('span', { key: 'count', style: CSS.muted }, `${room.players.length} 人在桌`) : null,
      isHost && room?.inviteCode
        ? h('button', { key: 'invite', type: 'button', style: { ...CSS.tag, cursor: 'pointer', background: 'transparent' }, title: '点击复制邀请码', onClick: () => void copyInvite() }, `邀请码 ${room.inviteCode}`)
        : null,
      h('span', { key: 'spacer', style: { flex: 1 } }),
      h('span', { key: 'status', style: status.kind === 'ok' ? CSS.ok : status.kind === 'bad' ? CSS.bad : CSS.muted }, status.text),
      isHost && room ? h('button', { key: 'gm-console', type: 'button', style: CSS.button, onClick: () => setGmOpen((value: boolean) => !value) }, gmOpen ? '收起 GM 控制台' : 'GM 控制台') : null,
      isHost && room ? h('button', { key: 'lock', type: 'button', style: CSS.button, onClick: () => void toggleLock() }, room.locked ? '解锁' : '锁房') : null,
      session ? h('button', { key: 'leave', type: 'button', style: CSS.button, onClick: () => void leave() }, session.hostToken ? '结束房间' : '退出房间') : null,
      props?.goHome ? h('button', { key: 'home', type: 'button', style: CSS.button, title: '返回 DSH 对话', onClick: () => props.goHome?.() }, '返回对话') : null,
    ]);

    const composer = h('div', { key: 'composer', style: CSS.composer }, [
      h('textarea', {
        key: 'input',
        style: CSS.composerInput,
        value: sayText,
        placeholder: sayPrivate ? '悄悄话给 GM：只有 GM（和真人 GM）能看到…' : '你要做什么？（例：我推开门，先看一眼门缝里的光）',
        onChange: (event: { target: { value: string } }) => setSayText(event.target.value),
        onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault?: () => void }) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault?.();
            void say();
          }
        },
      }),
      h('div', { key: 'actions', style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 } }, [
        h('button', { key: 'send', type: 'button', style: CSS.buttonPrimary, disabled: busy || !sayText.trim(), onClick: () => void say() }, sayPrivate ? '私发 GM' : '发送'),
        h('label', { key: 'whisper', style: { ...CSS.muted, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' } }, [
          h('input', {
            key: 'checkbox',
            type: 'checkbox',
            checked: sayPrivate,
            onChange: (event: { target: { checked: boolean } }) => setSayPrivate(event.target.checked),
          }),
          '悄悄话给 GM',
        ]),
      ]),
    ]);

    const chatColumn = h('div', { key: 'chat', style: CSS.chatCol }, [
      h('div', { key: 'feed', ref: feedDomRef, style: CSS.feed }, feed.length
        ? feed.map(renderChatEntry)
        : h('div', { key: 'empty', style: CSS.emptyHint }, [
            h('div', { key: 'line1' }, room?.gmMode === 'human' ? '真人 GM 主持中。' : 'AI GM 正在带团。'),
            h('div', { key: 'line2' }, '在下方输入你的行动，按 Enter 发送（Shift+Enter 换行）。'),
          ])),
      composer,
    ]);

    const partySection = h('div', { key: 'party', style: CSS.section }, [
      h('strong', { key: 't' }, '玩家席'),
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
    ]);

    const seatSection = myCharacter?.characterName
      ? h('div', { key: 'seat', style: CSS.section }, [
          h('strong', { key: 't' }, '我的角色'),
          h('div', { key: 'name', style: { fontSize: 12 } }, myCharacter.characterName),
          h('span', { key: 'hint', style: CSS.muted }, '成长会以奖励形式回到「我的成长 / 战报」。'),
        ])
      : h('div', { key: 'seat', style: CSS.section }, [
          h('strong', { key: 't' }, '落座 · 我的角色卡'),
          h('div', { key: 'localrow', style: CSS.row }, [
            h(
              'select',
              {
                key: 'localselect',
                style: CSS.input,
                value: selectedLocalId,
                onChange: (event: { target: { value: string } }) => setSelectedLocalId(event.target.value),
              },
              localCardOptions,
            ),
            h('button', { key: 'seat-local', type: 'button', style: CSS.buttonPrimary, onClick: () => void seat(), disabled: busy }, '落座'),
          ]),
          h('div', { key: 'pregenrow', style: CSS.row }, [
            h(
              'select',
              {
                key: 'seatselect',
                style: CSS.input,
                value: seatCardId,
                onChange: (event: { target: { value: string } }) => setSeatCardId(event.target.value),
              },
              seatOptions,
            ),
            h('button', { key: 'seat-pregen', type: 'button', style: CSS.button, onClick: () => void seat(), disabled: busy }, '用预制卡落座'),
          ]),
          h('div', { key: 'cardbtns', style: CSS.row }, [
            h('button', { key: 'import-card', type: 'button', style: CSS.button, onClick: () => fileInputRef.current?.click?.() }, '导入卡 JSON'),
            h('button', { key: 'copy-pregen', type: 'button', style: CSS.button, onClick: () => savePregenCopy() }, '存预制为本地卡'),
            growth ? h('button', { key: 'merge-growth', type: 'button', style: CSS.button, onClick: () => mergeGrowthToCard() }, '合并成长到卡') : null,
            h('button', { key: 'export-card', type: 'button', style: CSS.button, onClick: () => exportSelectedCard() }, '导出卡'),
            h('button', { key: 'delete-card', type: 'button', style: CSS.button, onClick: () => deleteSelectedCard() }, '删除卡'),
          ]),
          h('input', {
            key: 'card-file',
            type: 'file',
            accept: '.json,application/json',
            style: { display: 'none' },
            ref: fileInputRef,
            onChange: (event: { target: unknown }) => void importCardFile(event),
          }),
        ]);

    const diceSection = h('div', { key: 'dice', style: CSS.section }, [
      h('strong', { key: 't' }, '掷骰'),
      h('div', { key: 'dicerow', style: CSS.row }, [
        h('input', {
          key: 'expr',
          style: CSS.input,
          value: expression,
          spellCheck: false,
          onChange: (event: { target: { value: string } }) => setExpression(event.target.value),
          onKeyDown: (event: { key: string; preventDefault?: () => void }) => {
            if (event.key === 'Enter') {
              event.preventDefault?.();
              void roll();
            }
          },
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
        h('button', { key: 'roll', type: 'button', style: CSS.button, disabled: busy, onClick: () => void roll() }, '掷'),
      ]),
      h('span', { key: 'hint', style: CSS.muted }, '骰子由房主服务端掷，可复现。'),
    ]);

    const growthSection = h('div', { key: 'growth', style: CSS.section }, [
      h('strong', { key: 't' }, '我的成长 / 战报'),
      growth
        ? h('span', { key: 'xp', style: CSS.muted }, `XP 总计 ${growth.xp}${growth.items.length ? ` · ${growth.items.join('、')}` : ''}`)
        : h('span', { key: 'none', style: CSS.muted }, '还没有奖励记录'),
      h('div', { key: 'actions', style: CSS.row }, [
        h(
          'button',
          {
            key: 'exp',
            type: 'button',
            style: CSS.button,
            onClick: () => {
              if (!growth) return;
              downloadText(`growth-${room?.title ?? 'trpg'}.json`, JSON.stringify(growthToCardPatch(growth), null, 2), 'application/json;charset=utf-8');
            },
          },
          '导出成长 JSON',
        ),
        h(
          'button',
          {
            key: 'md',
            type: 'button',
            style: CSS.button,
            onClick: () => {
              if (!room) return;
              downloadText(`report-${room.title}.md`, roomToMarkdown(room, feedRef.current), 'text/markdown;charset=utf-8');
            },
          },
          '导出战报 MD',
        ),
      ]),
    ]);

    const gmConsole = isHost && gmOpen
      ? h('div', { key: 'gmconsole', style: { ...CSS.section, gap: 8 } }, [
          h('strong', { key: 't' }, 'GM 控制台'),
          h('div', { key: 'narr', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('textarea', {
              key: 'txt',
              style: { ...CSS.input, minHeight: 52, resize: 'vertical' },
              value: gmText,
              placeholder: '以 GM 身份向全桌描述…',
              onChange: (event: { target: { value: string } }) => setGmText(event.target.value),
            }),
            h('button', { key: 'send', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void gmNarrate() }, '发送旁白'),
          ]),
          h('div', { key: 'secret', style: CSS.row }, [
            h('select', { key: 'player', style: { ...CSS.input, flex: '0 0 110px' }, value: gmPlayerId, onChange: (event: { target: { value: string } }) => setGmPlayerId(event.target.value) }, playerOptions),
            h('input', {
              key: 'st',
              style: CSS.input,
              value: gmSecretText,
              placeholder: '私密信息…',
              onChange: (event: { target: { value: string } }) => setGmSecretText(event.target.value),
            }),
            h('button', { key: 'sb', type: 'button', style: CSS.button, disabled: busy, onClick: () => void gmSecret() }, '私发'),
          ]),
          h('div', { key: 'scene', style: CSS.row }, [
            h('select', { key: 'sceneid', style: { ...CSS.input, flex: '1 1 140px' }, value: gmSceneId, onChange: (event: { target: { value: string } }) => setGmSceneId(event.target.value) }, GUIMUYA_MODULE.scenes.map((scene) => h('option', { key: scene.id, value: scene.id }, scene.title))),
            h('button', { key: 'scene-btn', type: 'button', style: CSS.button, disabled: busy, onClick: () => void gmScene() }, '推进场景'),
          ]),
          h('div', { key: 'award', style: CSS.row }, [
            h('input', {
              key: 'xp',
              style: { ...CSS.input, flex: '0 0 64px' },
              value: awardXp,
              placeholder: 'XP',
              onChange: (event: { target: { value: string } }) => setAwardXp(event.target.value),
            }),
            h('input', {
              key: 'items',
              style: CSS.input,
              value: awardItems,
              placeholder: '奖励物品,逗号分隔',
              onChange: (event: { target: { value: string } }) => setAwardItems(event.target.value),
            }),
            h('button', { key: 'award-btn', type: 'button', style: CSS.button, disabled: busy, onClick: () => void gmAward() }, '发奖励'),
          ]),
          h('span', { key: 'hint', style: CSS.muted }, '发奖励时按上面「选择玩家」的玩家发放；奖励会进入该玩家的成长记录。'),
        ])
      : null;

    const rail = h('div', { key: 'rail', style: CSS.rail }, [partySection, seatSection, gmConsole, diceSection, growthSection]);

    const roomBody = h('div', { key: 'body', style: CSS.body }, [chatColumn, rail]);

    // ---------------------------------------------------------------- 大厅

    const lobby = h('div', { key: 'lobby', style: CSS.lobby }, [
      h('div', { key: 'title', style: CSS.lobbyTitle }, '跑团桌 · 局域网多人跑团'),
      h('div', { key: 'sub', style: CSS.lobbySub }, '房主在自己电脑上开团（AI 当 GM，或你自己当 GM），朋友们用你的局域网地址 + 邀请码上桌。AI GM 只跑在房主机器上，玩家端不需要模型 Key。'),
      h('div', { key: 'base', style: { ...CSS.row, width: 'min(560px, 100%)', boxSizing: 'border-box' } }, [
        h('span', { key: 'label', style: CSS.muted }, '房主地址'),
        h('input', {
          key: 'input',
          style: CSS.input,
          value: base,
          spellCheck: false,
          placeholder: 'http://192.168.x.x:45871',
          onChange: (event: { target: { value: string } }) => setBase(event.target.value),
        }),
      ]),
      h('div', { key: 'cols', style: CSS.lobbyCols }, [
        h('div', { key: 'host', style: CSS.lobbyCard }, [
          h('strong', { key: 'h', style: { fontSize: 14 } }, '我是房主 · 开团'),
          h('span', { key: 'hint', style: CSS.muted }, '创建房间需要在房主本机操作。'),
          h('input', {
            key: 'title',
            style: CSS.input,
            value: title,
            placeholder: '团名',
            onChange: (event: { target: { value: string } }) => setTitle(event.target.value),
          }),
          h('select', {
            key: 'gm',
            style: CSS.input,
            value: gmMode,
            onChange: (event: { target: { value: string } }) => setGmMode(event.target.value === 'human' ? 'human' : 'ai'),
          }, [h('option', { key: 'ai', value: 'ai' }, 'AI 当 GM'), h('option', { key: 'human', value: 'human' }, '真人 GM（我来主持）')]),
          h('button', { key: 'create', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void createRoom() }, '创建房间'),
        ]),
        h('div', { key: 'join', style: CSS.lobbyCard }, [
          h('strong', { key: 'j', style: { fontSize: 14 } }, '加入朋友的团'),
          h('span', { key: 'hint', style: CSS.muted }, '填房主的局域网地址（或 127.0.0.1 同机测试）和邀请码。'),
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
        ]),
      ]),
      h('div', { key: 'hint2', style: { ...CSS.muted, textAlign: 'center', maxWidth: 620, lineHeight: 1.8 } },
        '进房后先「落座」：从预制卡里挑一张，或导入自己的角色卡。落座后中间就是叙事对话流，输入框写你的 RP 行动即可。'),
    ]);

    const loading = h('div', { key: 'loading', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, padding: 40 } }, [
      h('span', { key: 't', style: CSS.muted }, '正在连接房间…'),
    ]);

    return h('div', { key: 'page', style: CSS.page }, [
      head,
      session ? (room ? roomBody : loading) : lobby,
    ]);
  }

  return {
    inject: ['slots'],
    apply(ctx: ClientContext) {
      const layout = (ctx.get?.('layout') ?? undefined) as LayoutService | undefined;
      ctx.effect?.(() => {
        const disposers: Array<() => void> = [];
        // 主区域整页：打开后整块主区域就是跑团桌。
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: MAIN_PANEL_ID,
                inject: () => ({ goHome: layout ? () => layout.selectPanel(null) : undefined }),
              },
              TrpgTable,
            ),
          ),
        );

        // 侧边栏面板图标。
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: MAIN_PANEL_ID, order: 20, label: '跑团桌' }, TrpgSidebarIcon),
          ),
        );
        // 对话顶栏的快捷入口（有 layout 服务时才注册）。
        if (layout) {
          disposers.push(
            ctx.slots.inject('conversation.session.header.actions', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.actions',
                  id: 'dsh-trpg-table-open',
                  order: 60,
                  label: '跑团桌',
                  inject: () => ({ onOpen: () => layout.selectPanel(MAIN_PANEL_ID) }),
                },
                OpenTableButton,
              ),
            ),
          );
        }
        return () => {
          for (const dispose of disposers) dispose();
        };
      });
    },
  };
}
