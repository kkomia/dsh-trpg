/**
 * 跑团桌 Client 半边（v3：原生会话即牌桌）。
 *
 * 形态（产品已定，勿改回自绘聊天页）：
 * - 对话主区域直接复用 DSH 原生会话：房主会话即牌桌，GM 的回复由原生对话渲染。
 * - 插件只提供四样东西：对话顶栏入口（`conversation.session.header.actions`）、
 *   空态页全局入口（`conversation.header.leading`，无会话/空会话时显示，正常对话页让位给顶栏 chip）、
 *   右侧边栏常驻 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`）、以及
 *   没有房间时的建房/加入最小大厅卡片。
 * - tab 正文只有紧凑卡片（宽度适配右侧栏约 320–420px）：房间状态 / 大厅 /
 *   玩家席 / 落座 / 掷骰记录 / GM 控制台 / 成长。没有自绘对话流，也没有输入框。
 *
 * 构建：scripts/build.mjs 打包成 lib/client.js（CJS + ModuleLoader 包装）；
 * 因此源码里不要 import 'react'（由 ModuleLoader 注入），数据从 workspace 包静态打入。
 */
import {
  CARDS,
  CORE_GUIMUYA_PACK_NAME,
  CORE_GUIMUYA_PACK_VERSION,
  GUIMUYA_MODULE,
  RULE_SYSTEM,
} from '@dsh-trpg/content';
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
import { callRpc, rpcErrorMessage } from './rpc.ts';
import { createRulesStore, type MainViewKind } from './rules-store.ts';
import { createRulesUi } from './rules-ui.ts';
import { WORKSHOP_PANEL_ID } from './workshop.ts';
import { createWorkshopUi } from './workshop-ui.ts';
import { canonicalRefs } from './assets.ts';
import { cardMetaFromCard, createAssetStore } from './assets-store.ts';
import {
  createMirrorApi,
  mirrorStartInput,
  mirrorStatusText,
  shouldAutoStartMirror,
  MIRROR_FALLBACK_HINT,
  type MirrorApi,
  type MirrorStatusView,
} from './mirror.ts';
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
  BindSessionResult,
  CatalogModuleSummary,
  CatalogPack,
  CharacterAssetRefInput,
  ContentListResult,
  CreateRoomResult,
  DicePayload,
  GameEvent,
  JoinRoomResult,
  LockParams,
  RoomStateResult,
  RoomSceneSummary,
  RoomView,
  RollResult,
} from '@dsh-trpg/protocol';
import { DEFAULT_CONTENT_MODULE_ID, DEFAULT_CONTENT_PACK_ID } from '@dsh-trpg/protocol';

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

/** 右侧栏 tab 类型注册表（由 @deepseek-ai/dsh-client-ui-sidebar-right 提供）。 */
interface SidebarRightTabsService {
  register(definition: { id: string; kind: string; title: (address: string) => string }): () => void;
}

/** 右侧栏的「当前在屏会话」快照（service.mounted）：root 作用域也能读到有没有会话面。 */
interface SidebarRightMountedSource {
  getSnapshot(): string | undefined;
  subscribe(listener: () => void): () => void;
}

/** 右侧栏导航面（同一个包提供）：按 kind 打开一个页面 tab。 */
interface SidebarRightService {
  openTab(kind: string, options?: Record<string, unknown>): void;
  /** 没有在屏会话时为 undefined；openTab 在这种状态下会抛错。 */
  mounted?: SidebarRightMountedSource;
}

interface ClientContext {
  slots: SlotsService;
  get?(id: string): unknown;
  inject?(deps: string[], callback: (scoped: ClientContext) => void | (() => void)): unknown;
  effect?(fn: () => () => void): void;
}

/**
 * 右侧栏 tab：`id` 是实现的唯一标识（正文注册的 key），`kind` 是 openTab 点名的对象。
 * 包名前缀避免与其它插件的注册撞名。
 */
const TAB_TYPE_ID = 'dsh-trpg-table:table';
const TAB_KIND = 'trpg-table';
const TAB_TITLE = '跑团桌';
/** 主区域详细页的 keyed `main` 面板 id（`ctx.layout.selectPanel` 点名；M9.4）。 */
const MAIN_PANEL_ID = 'trpg-view';

const DEFAULT_BASE = 'http://127.0.0.1:45871';
const STORAGE_KEY = 'dsh-trpg:session:v1';
/** 当前打开的 DSH 会话 id（顶栏按钮写入，建房时作为牌桌会话绑定的兜底）。 */
const ACTIVE_SESSION_KEY = 'dsh-trpg:active-session.v1';
const MAX_FEED = 300;
/** 掷骰记录卡最多回显几条。 */
const MAX_DICE_ROWS = 8;

interface StoredSession {
  base: string;
  hostToken?: string;
  playerToken?: string;
  playerId?: string;
  roomId?: string;
  inviteCode?: string;
  playerName?: string;
}

/** 右侧栏紧凑卡片样式：所有卡片铺满栏宽，靠外层 tab 容器滚动。 */
const CSS = {
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 10px 14px',
    boxSizing: 'border-box',
    overflowY: 'auto',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
  } as Record<string, unknown>,
  section: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 10,
    padding: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    flexShrink: 0,
    minWidth: 0,
  } as Record<string, unknown>,
  sectionTitle: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, fontWeight: 600 } as Record<string, unknown>,
  roomTitle: { fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as Record<string, unknown>,
  metaRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 } as Record<string, unknown>,
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
  /** 竖排卡片里的输入控件：不参与竖向拉伸，固定铺满栏宽。 */
  field: {
    flex: '0 0 auto',
    width: '100%',
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
  diceCard: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    padding: '4px 6px',
    borderRadius: 8,
    border: '1px dashed var(--dsw-alias-border-l2)',
  } as Record<string, unknown>,
  die: {
    display: 'inline-block',
    minWidth: 18,
    textAlign: 'center',
    padding: '0 4px',
    borderRadius: 5,
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l1)',
    fontVariantNumeric: 'tabular-nums',
  } as Record<string, unknown>,
  emptyDice: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } as Record<string, unknown>,
};

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

/** 会话/房间 id 太长时截短展示，完整值放 title。 */
function shortId(id: string, keep = 8): string {
  return id.length <= keep ? id : `${id.slice(0, keep)}…`;
}

/** 顶栏按钮记住的当前会话 id（建房的兜底；右侧栏 tab 有 props.sessionId 时优先用它）。 */
function readActiveSessionId(): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(ACTIVE_SESSION_KEY);
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 内容包（M8.2b）：大厅选包/选模组 + 房间内容展示
// ---------------------------------------------------------------------------

/** 大厅当前选中的内容引用（packId + moduleId；建房时原样传给 room.create）。 */
interface ContentChoice {
  packId: string;
  moduleId: string;
}

/** 来源标签：内置（随插件）还是数据目录里的 .trpgpack。 */
function packSourceLabel(source: CatalogPack['source']): string {
  return source === 'builtin' ? '内置' : '数据目录';
}

/** 等级/人数区间：上下限相同时只显示一个值。 */
function rangeLabel(range: [number, number]): string {
  return range[0] === range[1] ? `${range[0]}` : `${range[0]}–${range[1]}`;
}

/** 模组摘要一行：标题（等级 / 人数 / 场景数）。 */
function moduleOptionLabel(module: CatalogModuleSummary): string {
  return `${module.title}（${rangeLabel(module.level)} 级 / ${rangeLabel(module.playerCount)} 人 / ${module.sceneCount} 场）`;
}

/**
 * `content.list` 返回值的宽松校验：只保留形状正确的包，避免坏数据把大厅渲染炸掉。
 * （服务端已做脱敏投影，这里只是客户端防御。）
 */
function sanitizeCatalog(input: unknown): CatalogPack[] {
  const packs = (input as { packs?: unknown } | null | undefined)?.packs;
  if (!Array.isArray(packs)) return [];
  return packs.filter((pack): pack is CatalogPack => {
    if (!pack || typeof pack !== 'object') return false;
    const candidate = pack as Partial<CatalogPack>;
    return (
      typeof candidate.packId === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.version === 'string' &&
      Array.isArray(candidate.modules)
    );
  });
}

/**
 * 内容目录不可用时的兜底：内置包 core-guimuya + 其默认模组。
 * 只用于大厅展示；建房不传 packId/moduleId，由 host 用自己的缺省值（静默降级）。
 */
function builtinCatalogFallback(): CatalogPack[] {
  return [
    {
      packId: DEFAULT_CONTENT_PACK_ID,
      name: CORE_GUIMUYA_PACK_NAME,
      version: CORE_GUIMUYA_PACK_VERSION,
      ruleSystem: { id: RULE_SYSTEM.id, name: RULE_SYSTEM.name },
      defaultModuleId: DEFAULT_CONTENT_MODULE_ID,
      modules: [
        {
          moduleId: GUIMUYA_MODULE.id,
          title: GUIMUYA_MODULE.title,
          level: [GUIMUYA_MODULE.level[0], GUIMUYA_MODULE.level[1]],
          playerCount: [GUIMUYA_MODULE.playerCount[0], GUIMUYA_MODULE.playerCount[1]],
          sceneCount: GUIMUYA_MODULE.scenes.length,
        },
      ],
      cardCount: CARDS.length,
      loreCount: 0,
      source: 'builtin',
    },
  ];
}

/** 在目录里定位当前选择；选择失效（包/模组被删）时回退到默认包、默认模组。 */
function resolveContentChoice(
  packs: CatalogPack[] | null,
  choice: ContentChoice,
): { pack?: CatalogPack; module?: CatalogModuleSummary } {
  if (!packs || packs.length === 0) return {};
  const pack =
    packs.find((candidate) => candidate.packId === choice.packId) ??
    packs.find((candidate) => candidate.packId === DEFAULT_CONTENT_PACK_ID) ??
    packs[0];
  if (!pack) return {};
  const modules = pack.modules ?? [];
  const module =
    modules.find((candidate) => candidate.moduleId === choice.moduleId) ??
    modules.find((candidate) => candidate.moduleId === pack.defaultModuleId) ??
    modules[0];
  return { pack, module };
}

/** 切包后选该包的默认模组（没有默认就第一个）。 */
function moduleIdForPack(pack: CatalogPack | undefined): string {
  const modules = pack?.modules ?? [];
  const preferred = modules.find((candidate) => candidate.moduleId === pack?.defaultModuleId) ?? modules[0];
  return preferred?.moduleId ?? pack?.defaultModuleId ?? DEFAULT_CONTENT_MODULE_ID;
}

export function createPlugin(React: any) {
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;

  // M9.4 规则投影：数据层（RPC + SSE + 命令）与渲染层（右栏紧凑三页签 + 主区域详细页）。
  const rulesStore = createRulesStore();
  // M9.5d 玩家角色资产：本地 IndexedDB 私卡资产 + 生成/上传；落座时由 index 组装 characterAssets。
  const assetStore = createAssetStore();
  const rulesUi = createRulesUi(React, rulesStore, assetStore);
  // M9.6a 内容工坊：主区域独立工具页（左栏内容包 + 右侧 8 页签）；聊天仍走原生会话。
  const workshopUi = createWorkshopUi(React);

  /** 对话顶栏入口：打开右侧栏的跑团桌 tab；顺带记住当前会话，作为建房的兜底。 */
  function OpenTableButton(props: { onOpen?: () => void; sessionId?: string }) {
    useEffect(() => {
      if (typeof props?.sessionId !== 'string' || props.sessionId.length === 0) return;
      try {
        globalThis.localStorage?.setItem(ACTIVE_SESSION_KEY, props.sessionId);
      } catch {
        /* 隐私模式忽略 */
      }
    }, [props?.sessionId]);
    return h(
      'button',
      {
        type: 'button',
        title: '在右侧栏打开跑团桌',
        style: { ...CSS.button, padding: '3px 8px', fontSize: 11 },
        onClick: () => props?.onOpen?.(),
      },
      '🎲 跑团桌',
    );
  }

  /**
   * 全局入口：挂在 `conversation.header.leading`（root 作用域，空态新会话页也渲染）。
   *
   * 会话头有标题/操作集群时（正常对话页），原 `conversation.session.header.actions`
   * 的「跑团桌」chip 已在，本组件返回 null 让位，保证同一时刻只有一个入口；
   * 只在「没有会话面」或「空会话（会话头隐藏操作集群）」时显示。
   *
   * 点击：有在屏会话就直接开右侧栏 tab；没有则先让 DSH 新开会话，等 mounted 出现后重试，
   * 仍失败（例如完全没有工作区）才给出可读引导。
   */
  function GlobalOpenTableEntry(props: {
    onOpen?: () => boolean;
    readMounted?: () => string | undefined;
    subscribeMounted?: (listener: () => void) => () => void;
    ensureSession?: () => void;
    useSessions?: (selector: (state: any) => unknown) => unknown;
  }) {
    const [mounted, setMounted] = useState(() => props?.readMounted?.());
    const [hint, setHint] = useState('');
    const retryRef = useRef(null as ReturnType<typeof setTimeout> | null);

    useEffect(() => {
      setMounted(props?.readMounted?.());
      const stop = props?.subscribeMounted?.(() => setMounted(props?.readMounted?.()));
      return () => {
        stop?.();
      };
    }, []);

    useEffect(() => () => {
      if (retryRef.current) clearTimeout(retryRef.current);
    }, []);

    // 空会话 = 会话头隐藏了标题/操作集群（原 chip 看不见）；undefined 表示列表还没加载，先不显示，避免重复。
    const blank = props?.useSessions?.((state: any) =>
      typeof mounted === 'string' && state?.byId !== undefined ? state.byId[mounted]?.blank : undefined);

    const tryOpen = (attempt: number): void => {
      if (props?.onOpen?.() === true) {
        setHint('');
        return;
      }
      if (attempt <= 0) {
        setHint('先在左侧「新会话」建一个会话，再打开跑团桌');
        return;
      }
      retryRef.current = setTimeout(() => {
        tryOpen(attempt - 1);
      }, 300);
    };

    // 有会话且不是空会话时，会话头 chip 已覆盖入口 → 让位。
    if (mounted !== undefined && blank !== true) return null;

    return h('div', { key: 'global-open', style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } }, [
      h(
        'button',
        {
          key: 'btn',
          type: 'button',
          title: '在右侧栏打开跑团桌',
          style: { ...CSS.button, padding: '3px 8px', fontSize: 11 },
          onClick: () => {
            if (props?.onOpen?.() === true) {
              setHint('');
              return;
            }
            // 没有在屏会话：先新建会话，再等右侧栏出现会话面。
            props?.ensureSession?.();
            tryOpen(12);
          },
        },
        '🎲 跑团桌',
      ),
      hint
        ? h(
            'span',
            {
              key: 'hint',
              style: {
                ...CSS.muted,
                fontSize: 11,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            hint,
          )
        : null,
    ]);
  }

  /** 右侧栏 tab 正文：紧凑常驻卡片。props.sessionId = 当前会话（右侧栏按会话作用域注入）。 */
  function TrpgTableCard(props: {
    sessionId?: string;
    onOpenMain?: (view: MainViewKind) => boolean | void;
    /** M9.6a：切主区域 keyed `main` 面板 `trpg-workshop`（内容工坊）。 */
    onOpenWorkshop?: () => boolean | void;
    /** M7：打开玩家本机镜像会话（`uiWorkspace.openSession`）；返回 false = 宿主没有该能力。 */
    onOpenMirrorSession?: (sessionId: string) => boolean;
  }) {
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
    const [title, setTitle] = useState(GUIMUYA_MODULE.title);
    // 内容包目录（content.list）：null = 还没读到；catalogFallback = 目录失败、已静默降级到内置包。
    const [catalog, setCatalog] = useState(null as CatalogPack[] | null);
    const [catalogFallback, setCatalogFallback] = useState(false);
    const [contentChoice, setContentChoice] = useState({
      packId: DEFAULT_CONTENT_PACK_ID,
      moduleId: DEFAULT_CONTENT_MODULE_ID,
    } as ContentChoice);
    const titleTouchedRef = useRef(false);
    const catalogLoadingRef = useRef(false);
    const [gmMode, setGmMode] = useState('ai' as 'ai' | 'human');
    const [expression, setExpression] = useState('d20');
    const [privateRoll, setPrivateRoll] = useState(false);
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

    const token = session?.hostToken ?? session?.playerToken;
    const isHost = Boolean(session?.hostToken);
    /**
     * 右栏「详细」/「世界地图」/「战斗视图」入口：由 apply() 注入（内部用 ctx.layout.selectPanel
     * 切到 keyed `main` 面板 `trpg-view`）。返回 false = 当前宿主没有主区域面板机制。
     */
    const openMain = useCallback(
      (view: MainViewKind) => {
        const opened = props?.onOpenMain?.(view);
        if (opened === false) {
          setStatus({ kind: 'bad', text: '当前宿主不支持主区域工具页（keyed main 面板不可用），只能使用右栏紧凑卡片。' });
        }
      },
      [props?.onOpenMain],
    );
    /** 右侧栏 tab 的会话 id：绑定/建房优先用它，localStorage 只做兜底。 */
    const tabSessionId = typeof props?.sessionId === 'string' && props.sessionId.trim().length > 0 ? props.sessionId.trim() : undefined;

    // ---------------------------------------------------------------- M7 对话镜像
    // 玩家身份入房后：自动连本机镜像服务 → 本机插件 host 连房主 `/trpg/mirror` SSE →
    // 玩家本机镜像会话（原生会话视图）。房主身份不启动（当前绑定会话就是牌桌）。
    const [mirrorStatus, setMirrorStatus] = useState(null as MirrorStatusView | null);
    const [mirrorApi] = useState(() => createMirrorApi() as MirrorApi);

    /** 打开镜像会话：优先 DSH 的 `uiWorkspace.openSession`；宿主没有该能力时给手动打开提示。 */
    const openMirrorSession = useCallback(
      (sessionId: string) => {
        const opened = props?.onOpenMirrorSession?.(sessionId);
        if (opened === false) {
          setStatus({
            kind: 'bad',
            text: `当前宿主不支持自动打开会话：请在左侧会话列表点开「跑团桌」会话（id：${sessionId}）`,
          });
        }
      },
      [props?.onOpenMirrorSession],
    );

    /** 玩家身份 + 房间就绪 → 启动镜像并轮询状态；退房/关房/切房/卸载时停止。 */
    useEffect(() => {
      const roomId = session?.roomId;
      if (!session?.playerToken || !roomId) {
        setMirrorStatus(null);
        return;
      }
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const startInput = mirrorStartInput(session, room?.title);
      if (startInput) {
        void mirrorApi.start(startInput).then((status: MirrorStatusView) => {
          if (!disposed) setMirrorStatus(status);
        });
      }
      const poll = (): void => {
        void mirrorApi.status(roomId).then((status: MirrorStatusView) => {
          if (disposed) return;
          setMirrorStatus(status);
          timer = setTimeout(poll, 1500);
        });
      };
      poll();
      return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
        void mirrorApi.stop(roomId);
      };
      // room.title 变化由下面的补标题 effect 处理，避免把连接整体重启。
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session?.playerToken, session?.roomId, mirrorApi]);

    /** 恢复房间时房名异步到达：再 start 一次（host 侧幂等，补齐/更新镜像会话标题）。 */
    useEffect(() => {
      if (!shouldAutoStartMirror(session)) return;
      const input = mirrorStartInput(session, room?.title);
      if (!input) return;
      void mirrorApi.start(input).then((status: MirrorStatusView) => setMirrorStatus(status));
    }, [room?.title, session?.playerToken, session?.roomId, session, mirrorApi]);

    const myCharacter = useMemo(() => {
      if (!room || !session) return undefined;
      const me = session.playerId
        ? room.players.find((entry: RoomView['players'][number]) => entry.playerId === session.playerId)
        : room.players.find((entry: RoomView['players'][number]) => entry.playerId === 'host');
      return me;
    }, [room, session]);

    // M9.5d：会话绑定进资产 store（生图/上传用 token，换房间重置「已同步」状态）。
    useEffect(() => {
      assetStore.bindSession(session);
    }, [session]);

    /**
     * GM 控制台场景下拉：优先用服务端下发的 `room.scenes`（当前模组的公开场景标题）；
     * 旧房间/旧服务端没有该字段时回退内置模组 `GUIMUYA_MODULE.scenes`。两边都没有则不渲染下拉。
     */
    const sceneChoices = useMemo(() => {
      const fromRoom = room?.scenes ?? [];
      if (fromRoom.length > 0) {
        return fromRoom.map((scene: RoomSceneSummary) => ({ sceneId: scene.sceneId, title: scene.title }));
      }
      return GUIMUYA_MODULE.scenes.map((scene: { id: string; title: string }) => ({ sceneId: scene.id, title: scene.title }));
    }, [room]);

    // 房间切换/场景清单变化后，选中项若不在清单里就落到第一个场景。
    useEffect(() => {
      if (sceneChoices.length === 0) return;
      if (!sceneChoices.some((scene: { sceneId: string; title: string }) => scene.sceneId === gmSceneId)) {
        setGmSceneId(sceneChoices[0]?.sceneId ?? '');
      }
    }, [sceneChoices, gmSceneId]);

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

    const enterRoom = useCallback((next: StoredSession) => {
      saveSession(next);
      setSession(next);
      setBase(next.base);
    }, []);

    // M9.4：把规则投影数据层绑到当前房间会话（无 rules 的房间内部空转，不请求规则 RPC）。
    // room 变化（SSE room 事件）时同步规则引用；同一会话重复 bind 只更新房间视图。
    useEffect(() => {
      rulesStore.bind(session, room);
    }, [session, room]);

    /**
     * 读取房主的内容包目录（`content.list`，无需 token，玩家也可读）。
     * 失败时静默降级到内置默认：大厅照常能建房，不弹错误、不挡流程。
     */
    const loadCatalog = useCallback(async (address: string) => {
      if (catalogLoadingRef.current) return;
      const normalizedBase = address.trim().replace(/\/+$/, '');
      if (!normalizedBase) return;
      catalogLoadingRef.current = true;
      try {
        const result = await callRpc<ContentListResult>(normalizedBase, 'content.list', {});
        const packs = sanitizeCatalog(result);
        if (packs.length === 0) throw new Error('内容包目录为空');
        setCatalog(packs);
        setCatalogFallback(false);
        setContentChoice((previous: ContentChoice) => {
          const { pack, module } = resolveContentChoice(packs, previous);
          return {
            packId: pack?.packId ?? DEFAULT_CONTENT_PACK_ID,
            moduleId: module?.moduleId ?? moduleIdForPack(pack),
          };
        });
      } catch {
        // 静态降级：用内置包展示，建房时不传 packId/moduleId，由 host 用缺省值。
        setCatalog(builtinCatalogFallback());
        setCatalogFallback(true);
        setContentChoice({ packId: DEFAULT_CONTENT_PACK_ID, moduleId: DEFAULT_CONTENT_MODULE_ID });
      } finally {
        catalogLoadingRef.current = false;
      }
    }, []);

    // 大厅可见时读内容目录（回到大厅/换房主地址后刷新一次；短 debounce 避免输入地址时刷屏）。
    useEffect(() => {
      if (session) return;
      const timer = setTimeout(() => void loadCatalog(base), 250);
      return () => clearTimeout(timer);
    }, [session, base, loadCatalog]);

    /** 当前选中的包/模组（选择失效时自动回退）。 */
    const { pack: selectedPack, module: selectedModule } = useMemo(
      () => resolveContentChoice(catalog, contentChoice),
      [catalog, contentChoice],
    );

    // 团名默认跟所选模组标题联动；用户手动改过团名后不再覆盖。
    useEffect(() => {
      if (titleTouchedRef.current) return;
      if (typeof selectedModule?.title === 'string' && selectedModule.title.length > 0) {
        setTitle(selectedModule.title);
      }
    }, [selectedModule]);

    const choosePack = useCallback(
      (nextPackId: string) => {
        const pack = catalog?.find((candidate: CatalogPack) => candidate.packId === nextPackId);
        setContentChoice({ packId: nextPackId, moduleId: moduleIdForPack(pack) });
      },
      [catalog],
    );

    const chooseModule = useCallback((nextModuleId: string) => {
      setContentChoice((previous: ContentChoice) => ({ ...previous, moduleId: nextModuleId }));
    }, []);

    const createRoom = useCallback(async () => {
      setBusy(true);
      setStatus({ kind: 'idle', text: '创建房间中…' });
      try {
        const normalizedBase = base.trim().replace(/\/+$/, '');
        // 牌桌会话：右侧栏 tab 的会话优先，顶栏按钮记住的会话兜底。
        const sessionId = tabSessionId ?? readActiveSessionId();
        const created = await callRpc<CreateRoomResult>(normalizedBase, 'room.create', {
          title,
          gmMode,
          ...(sessionId ? { sessionId } : {}),
          // 目录可用时把所选内容一并带上；目录失败时省略，交给 host 的内置缺省（静默降级）。
          ...(!catalogFallback && selectedPack
            ? { packId: selectedPack.packId, ...(selectedModule ? { moduleId: selectedModule.moduleId } : {}) }
            : {}),
        });
        lastSeqRef.current = 0;
        feedRef.current = [];
        setFeed([]);
        setRoom(created.room);
        enterRoom({ base: normalizedBase, hostToken: created.hostToken, roomId: created.room.roomId, inviteCode: created.inviteCode });
        setStatus({
          kind: 'ok',
          text: created.room.sessionId
            ? `房间已创建，并绑定到当前对话（邀请码 ${created.inviteCode}）`
            : `房间已创建，邀请码 ${created.inviteCode}（未绑定会话：请在对话页顶栏打开跑团桌后点「绑定当前会话」）`,
        });
      } catch (error) {
        setStatus({ kind: 'bad', text: `创建失败：${error instanceof Error ? error.message : String(error)}（创建房间需要在房主本机）` });
      } finally {
        setBusy(false);
      }
    }, [base, title, gmMode, enterRoom, tabSessionId, catalogFallback, selectedPack, selectedModule]);

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

    /**
     * 房主本机恢复会话（M9.6a 附带）：本机 localStorage 会话丢失/指向旧地址时，
     * 用 loopback 的 `room.list` + `host.session` 找回房主令牌并恢复牌桌会话。
     * 只在本机房主本机有效（host.session 只接受 loopback 请求），不会创建/修改房间。
     */
    const recoverHostRoom = useCallback(async () => {
      setBusy(true);
      setStatus({ kind: 'idle', text: '正在本机查找可恢复的房主房间…' });
      try {
        const normalizedBase = (base.trim() || DEFAULT_BASE).replace(/\/+$/, '');
        const list = await callRpc<{ rooms: Array<{ roomId: string; title?: string; phase?: string }> }>(
          normalizedBase,
          'room.list',
          {},
        );
        const rooms = list.rooms ?? [];
        if (rooms.length === 0) {
          setStatus({ kind: 'bad', text: `本机 host（${normalizedBase}）上没有房间可恢复：请确认跑团桌 host 正在运行并已建房。` });
          return;
        }
        // 优先恢复到 localStorage 里记过的房间；否则取第一个。
        const remembered = session?.roomId;
        const target = rooms.find((entry) => entry.roomId === remembered) ?? rooms[0]!;
        const host = await callRpc<{ hostToken?: string; room?: { inviteCode?: string; title?: string } }>(
          normalizedBase,
          'host.session',
          { roomId: target.roomId },
        );
        if (typeof host.hostToken !== 'string' || host.hostToken.length === 0) {
          throw new Error('host.session 没有返回房主令牌');
        }
        lastSeqRef.current = 0;
        feedRef.current = [];
        setFeed([]);
        enterRoom({
          base: normalizedBase,
          hostToken: host.hostToken,
          roomId: target.roomId,
          ...(typeof host.room?.inviteCode === 'string' ? { inviteCode: host.room.inviteCode } : {}),
        });
        setStatus({ kind: 'ok', text: `已恢复本机房主会话：${host.room?.title ?? target.title ?? target.roomId}` });
      } catch (error) {
        setStatus({
          kind: 'bad',
          text: `恢复失败：${error instanceof Error ? error.message : String(error)}（只有房主本机可恢复；需要 host 在运行）`,
        });
      } finally {
        setBusy(false);
      }
    }, [base, enterRoom, session?.roomId]);

    /** 房主：把房间绑定到右侧栏 tab 所在的会话（原生对话即牌桌）。 */
    const bindCurrentSession = useCallback(async () => {
      if (!session || !token) return;
      if (!tabSessionId) {
        setStatus({ kind: 'bad', text: '当前 tab 没有可绑定的会话：请在对话页顶栏打开跑团桌后再绑定' });
        return;
      }
      setBusy(true);
      setStatus({ kind: 'idle', text: '绑定中…' });
      try {
        const result = await callRpc<BindSessionResult>(session.base, 'room.bind', { sessionId: tabSessionId }, token);
        setRoom(result.room);
        setStatus({ kind: 'ok', text: `牌桌已绑定到当前对话（${shortId(tabSessionId, 8)}）` });
      } catch (error) {
        setStatus({ kind: 'bad', text: `绑定失败：${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(false);
      }
    }, [session, token, tabSessionId]);

    const selectedLocalCard = localCards.find((record: LocalCardRecord) => record.card.id === selectedLocalId) ?? null;

    /** 当前要落座/编辑的角色卡（优先选中的本地卡，其次预制卡）。 */
    const seatCard = useMemo(
      () => selectedLocalCard?.card ?? CARDS.find((entry) => entry.id === seatCardId) ?? CARDS[0],
      [selectedLocalCard, seatCardId],
    );

    // M9.5d：资产 store 跟随「当前卡」——未落座也能先本地导入/生成；落座后由 host 投影的 cardId 接管。
    useEffect(() => {
      if (!seatCard) return;
      const sheet = rulesStore.getSnapshot().sheet;
      if (sheet === null || sheet.cardId !== seatCard.id) assetStore.setCard(cardMetaFromCard(seatCard));
    }, [seatCard, room?.roomId]);

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
      // M9.5d：先上传「展示用」本地资产（头像/立绘/变体/帧表），再带 characterAssets 引用落座。
      // 上传失败**不阻断落座**：先入座，提示可稍后在人物页「同步到房间」重试。
      const assetLines: string[] = [];
      let refs: CharacterAssetRefInput[] = [];
      try {
        const prepared = await assetStore.uploadForSeat();
        refs = canonicalRefs(prepared.refs);
        if (prepared.error !== null) assetLines.push(`资产上传失败（已先落座，可稍后重试）：${prepared.error}`);
        else if (refs.length > 0) assetLines.push(`已上传 ${refs.length} 个展示资产`);
        else if (assetStore.displayAssets().length > 0) assetLines.push('本地展示资产未上传（host 未启用房间资产存储）');
        if (prepared.skipped.length > 0) assetLines.push(...prepared.skipped);
      } catch (error) {
        assetLines.push(`资产上传异常（已先落座）：${rpcErrorMessage(error)}`);
      }
      try {
        const result = await callRpc<RoomStateResult>(
          session.base,
          'room.seat',
          {
            characterCard: card,
            ...(refs.length > 0 ? { characterAssets: refs } : {}),
          },
          token,
        );
        setRoom(result.room);
        // 落座后本地资产归到这张卡，并刷新一次（host 投影到达后人物页显示房间可见的头像/立绘）。
        assetStore.setCard(cardMetaFromCard(card));
        assetStore.refresh();
        setStatus({
          kind: assetLines.some((line) => line.includes('失败') || line.includes('异常')) ? 'bad' : 'ok',
          text: [`已落座：${card.identity.name}`, ...assetLines].join('；'),
        });
      } catch (error) {
        assetLines.push(`落座失败：${error instanceof Error ? error.message : String(error)}`);
        setStatus({ kind: 'bad', text: assetLines.join('；') });
      } finally {
        setBusy(false);
      }
    }, [session, token, seatCardId, selectedLocalCard, assetStore]);

    // 「同步到房间」按钮（人物页）：复用落座流程（先传资产再 seat），注册给资产 store。
    const seatRef = useRef(seat);
    seatRef.current = seat;
    useEffect(() => {
      assetStore.setSeatRunner(async () => {
        await seatRef.current?.();
      });
      return () => assetStore.setSeatRunner(null);
    }, [assetStore]);

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
      const scene = sceneChoices.find((entry: { sceneId: string; title: string }) => entry.sceneId === gmSceneId);
      try {
        // RPC 参数保持原样：只认场景 sceneId（标题只用于端上展示进度）。
        await callRpc(session.base, 'gm.scene', { sceneId: gmSceneId, title: scene?.title }, token);
      } catch (error) {
        setStatus({ kind: 'bad', text: `推进场景失败：${error instanceof Error ? error.message : String(error)}` });
      }
    }, [session, token, gmSceneId, sceneChoices]);

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
      if (session && token) {
        try {
          // 房主「结束房间」必须真的关房：服务端 closeRoom → onRoomClosed 解绑牌桌会话，
          // 撤销注入当前会话的 GM 人设/trpg_* 工具；玩家「退出房间」只离开自己的席位。
          await callRpc(session.base, session.hostToken ? 'room.close' : 'room.leave', {}, token);
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

    // ---------------------------------------------------------------- 下拉选项 & 派生数据

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
    /** 掷骰记录：最近几条（新→旧），数据来自 SSE 事件流，只回显不重排。 */
    const recentDice = useMemo(
      () => feed.filter((event: GameEvent) => event.kind === 'dice').slice(-MAX_DICE_ROWS).reverse(),
      [feed],
    );

    // ---------------------------------------------------------------- 页面片段

    const statusLine = h('div', { key: 'status', style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } }, [
      h('span', {
        key: 'dot',
        style: {
          ...CSS.dot,
          background:
            status.kind === 'ok'
              ? 'var(--dsw-alias-state-success-primary)'
              : status.kind === 'bad'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
        },
      }),
      h('span', { key: 'text', style: status.kind === 'ok' ? CSS.ok : status.kind === 'bad' ? CSS.bad : CSS.muted }, status.text),
    ]);

    const boundSessionId = room?.sessionId;
    const boundIsCurrent = Boolean(boundSessionId && tabSessionId && boundSessionId === tabSessionId);

    /** 拿不到会话 id（例如这个 tab 被恢复在没有会话的宿主里）时给可读提示：建房不会静默丢绑定。 */
    const missingSessionHint = tabSessionId
      ? null
      : h('div', { key: 'nosession', style: CSS.section }, [
          h('strong', { key: 't', style: { color: 'var(--dsw-alias-state-warning-primary)' } }, '当前没有可绑定的会话'),
          h(
            'span',
            { key: 'hint', style: CSS.muted },
            '建房会照常成功，但不会绑定 AI GM。请回到对话页，用顶栏的「跑团桌」入口重新打开本栏，再点「绑定当前会话」。',
          ),
        ]);

    const onlineCount = (room?.players ?? []).filter((entry: RoomView['players'][number]) => entry.online).length;

    const roomCard = room
      ? h('div', { key: 'room', style: CSS.section }, [
          h('div', { key: 'head', style: CSS.sectionTitle }, [
            h('span', { key: 'title', style: CSS.roomTitle, title: room.title }, room.title),
            h('span', { key: 'phase', style: CSS.tag }, room.phase),
            h('span', { key: 'gm', style: CSS.tag }, room.gmMode === 'human' ? '真人 GM' : 'AI GM'),
            room.locked ? h('span', { key: 'locked', style: CSS.tag }, '已锁定') : null,
          ]),
          h('div', { key: 'meta', style: CSS.metaRow }, [
            isHost && room.inviteCode
              ? h(
                  'button',
                  {
                    key: 'invite',
                    type: 'button',
                    style: { ...CSS.tag, cursor: 'pointer', background: 'transparent' },
                    title: '点击复制邀请码',
                    onClick: () => void copyInvite(),
                  },
                  `邀请码 ${room.inviteCode}`,
                )
              : null,
            h('span', { key: 'roomno', style: CSS.tag, title: room.roomId }, `房间号 ${shortId(room.roomId)}`),
            h('span', { key: 'online', style: CSS.muted }, `在线 ${onlineCount}/${room.players.length}`),
          ]),
          // 房间内容引用：包名/模组标题 + 版本小字；降级时给红色警戒文案。
          room.content
            ? h('div', { key: 'content', style: CSS.metaRow }, [
                h(
                  'span',
                  {
                    key: 'pack',
                    style: { fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: `${room.content.packId} · ${room.content.moduleId}`,
                  },
                  `内容包：${room.content.packName ?? room.content.packId}`,
                ),
                h(
                  'span',
                  {
                    key: 'module',
                    style: { fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    title: room.content.moduleId,
                  },
                  `模组：${room.content.moduleTitle ?? room.content.moduleId}`,
                ),
                h('span', { key: 'version', style: CSS.tag, title: `内容包版本 ${room.content.packVersion}` }, `v${room.content.packVersion}`),
              ])
            : null,
          room.content?.degraded
            ? h('span', { key: 'degraded', style: { ...CSS.bad, display: 'block' } }, '⚠ 内容包缺失或已变更，GM 回退到内置模组')
            : null,
          room.scene
            ? h('span', { key: 'scene', style: CSS.muted }, `场景：${room.scene.title ?? room.scene.sceneId}`)
            : null,
          h('div', { key: 'session', style: CSS.metaRow }, [
            h(
              'span',
              {
                key: 'sessionid',
                style: { ...CSS.muted, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: boundSessionId ?? '尚未绑定牌桌会话',
              },
              `牌桌会话：${boundSessionId ? shortId(boundSessionId, 10) : '未绑定'}`,
            ),
            isHost
              ? h(
                  'button',
                  {
                    key: 'bind',
                    type: 'button',
                    style: CSS.button,
                    disabled: busy || !tabSessionId || boundIsCurrent,
                    title: tabSessionId ? '把房间绑定到当前对话会话' : '当前没有可绑定的会话',
                    onClick: () => void bindCurrentSession(),
                  },
                  boundIsCurrent ? '已绑定本会话' : boundSessionId ? '改绑到本会话' : '绑定当前会话',
                )
              : null,
          ]),
          h('div', { key: 'actions', style: CSS.row }, [
            isHost
              ? h('button', { key: 'gm-console', type: 'button', style: CSS.button, onClick: () => setGmOpen((value: boolean) => !value) }, gmOpen ? '收起 GM 控制台' : 'GM 控制台')
              : null,
            isHost ? h('button', { key: 'lock', type: 'button', style: CSS.button, onClick: () => void toggleLock() }, room.locked ? '解锁' : '锁房') : null,
            session ? h('button', { key: 'leave', type: 'button', style: CSS.button, onClick: () => void leave() }, session.hostToken ? '结束房间' : '退出房间') : null,
          ]),
        ])
      : null;

    // 大厅的内容包/模组选择：目录只有一项时压成只读文字（仍保留来源标签），
    // 多个包/模组时用原生 select（右侧栏 320–420px，原生控件不会溢出）。
    const multiPack = (catalog?.length ?? 0) > 1;
    const moduleOptions = selectedPack?.modules ?? [];
    const multiModule = moduleOptions.length > 1;
    const contentSection = h('div', { key: 'content', style: CSS.section }, [
      h('div', { key: 'head', style: CSS.sectionTitle }, [
        h('strong', { key: 't' }, '内容包 / 模组'),
        selectedPack ? h('span', { key: 'source', style: CSS.tag }, packSourceLabel(selectedPack.source)) : null,
        selectedPack ? h('span', { key: 'rule', style: CSS.tag }, selectedPack.ruleSystem.name) : null,
        catalogFallback ? h('span', { key: 'fallback', style: CSS.tag }, '目录不可用') : null,
      ]),
      !catalog
        ? h('span', { key: 'loading', style: CSS.muted }, '正在读取内容包…')
        : selectedPack
          ? h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } }, [
              multiPack
                ? h(
                    'select',
                    {
                      key: 'pack',
                      style: CSS.field,
                      value: selectedPack.packId,
                      title: '选择内容包',
                      onChange: (event: { target: { value: string } }) => choosePack(event.target.value),
                    },
                    (catalog ?? []).map((pack: CatalogPack) => h('option', { key: pack.packId, value: pack.packId }, `${pack.name} v${pack.version}`)),
                  )
                : h(
                    'span',
                    {
                      key: 'pack',
                      style: { fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      title: `${selectedPack.packId} · ${selectedPack.ruleSystem.name}`,
                    },
                    `内容包：${selectedPack.name} v${selectedPack.version}`,
                  ),
              multiModule
                ? h(
                    'select',
                    {
                      key: 'module',
                      style: CSS.field,
                      value: selectedModule?.moduleId ?? '',
                      title: '选择模组',
                      onChange: (event: { target: { value: string } }) => chooseModule(event.target.value),
                    },
                    moduleOptions.map((module: CatalogModuleSummary) => h('option', { key: module.moduleId, value: module.moduleId }, moduleOptionLabel(module))),
                  )
                : h(
                    'span',
                    {
                      key: 'module',
                      style: { fontSize: 12, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      title: selectedModule?.moduleId,
                    },
                    selectedModule ? `模组：${moduleOptionLabel(selectedModule)}` : '该内容包没有可用模组',
                  ),
            ])
          : h('span', { key: 'empty', style: CSS.bad }, '内容包目录为空，将使用内置默认内容建房'),
      catalogFallback
        ? h('span', { key: 'fallbackhint', style: CSS.muted }, '内容目录暂不可用：已用内置内容包，建房时由房主服务端取缺省内容。')
        : null,
      h('span', { key: 'note', style: CSS.muted }, '内容由房主本机决定；建房后房间引用所选内容包与模组。'),
    ]);

    const lobby = h('div', { key: 'lobby', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
      missingSessionHint,
      h('div', { key: 'base', style: CSS.section }, [
        h('strong', { key: 't' }, '房主地址'),
        h('input', {
          key: 'input',
          style: CSS.field,
          value: base,
          spellCheck: false,
          placeholder: 'http://192.168.x.x:45871',
          onChange: (event: { target: { value: string } }) => setBase(event.target.value),
        }),
        h('span', { key: 'hint', style: CSS.muted }, '同机测试用 127.0.0.1；玩家填房主的局域网地址。'),
      ]),
      contentSection,
      h('div', { key: 'host', style: CSS.section }, [
        h('strong', { key: 't' }, '开团 · 我是房主'),
        h('input', {
          key: 'title',
          style: CSS.field,
          value: title,
          placeholder: '团名',
          onChange: (event: { target: { value: string } }) => {
            // 用户改过团名后，切换模组不再覆盖。
            titleTouchedRef.current = true;
            setTitle(event.target.value);
          },
        }),
        h(
          'select',
          {
            key: 'gm',
            style: CSS.field,
            value: gmMode,
            onChange: (event: { target: { value: string } }) => setGmMode(event.target.value === 'human' ? 'human' : 'ai'),
          },
          [h('option', { key: 'ai', value: 'ai' }, 'AI 当 GM'), h('option', { key: 'human', value: 'human' }, '真人 GM（我来主持）')],
        ),
        h('button', { key: 'create', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void createRoom() }, '创建房间'),
        h('span', { key: 'hint', style: CSS.muted }, '需在房主本机操作；会把当前对话设为牌桌，AI GM 直接在会话里回话。'),
      ]),
      h('div', { key: 'join', style: CSS.section }, [
        h('strong', { key: 't' }, '加入朋友的团'),
        h('input', {
          key: 'code',
          style: CSS.field,
          placeholder: '邀请码（如 7F3K9Q）',
          value: inviteCode,
          onChange: (event: { target: { value: string } }) => setInviteCode(event.target.value),
        }),
        h('input', {
          key: 'name',
          style: CSS.field,
          placeholder: '你的玩家名',
          value: playerName,
          onChange: (event: { target: { value: string } }) => setPlayerName(event.target.value),
        }),
        h('button', { key: 'join-btn', type: 'button', style: CSS.buttonPrimary, disabled: busy, onClick: () => void joinRoom() }, '加入房间'),
        h('span', { key: 'hint', style: CSS.muted }, '进房后先「落座」，行动直接写在原生对话里。'),
      ]),
      // M9.6a：本机 localStorage 会话丢失/指错地址时的房主自救入口（loopback + host.session，只读查找）。
      h('div', { key: 'recover', style: { ...CSS.section, gap: 5 } }, [
        h('strong', { key: 't' }, '房主本机恢复'),
        h('span', { key: 'hint', style: CSS.muted }, '本机会话丢失（例如浏览器存储被清/换了地址）时，可在此找回本机 host 上已有房间的房主身份；不创建新房间。'),
        h(
          'button',
          { key: 'go', type: 'button', style: { ...CSS.button, alignSelf: 'flex-start' }, disabled: busy, onClick: () => void recoverHostRoom() },
          '恢复本机房主会话',
        ),
      ]),
    ]);

    const connecting = h('div', { key: 'loading', style: { ...CSS.section, gap: 4 } }, [
      h('span', { key: 't', style: CSS.muted }, '正在连接房间…'),
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
            h('span', { key: 'name', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.displayName),
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
      recentDice.length
        ? h(
            'div',
            { key: 'history', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            recentDice.map((event: GameEvent) => {
              const payload = event.payload as DicePayload;
              return h('div', { key: `${event.seq}`, style: { ...CSS.diceCard, borderStyle: payload.private ? 'solid' : 'dashed' } }, [
                h('span', { key: 'roller', style: CSS.muted }, payload.rollerName),
                ...(payload.label ? [h('span', { key: 'label' }, payload.label)] : []),
                h('span', { key: 'expr', style: CSS.muted }, payload.expression),
                ...payload.dice.map((die: number, dieIndex: number) => h('span', { key: `die-${dieIndex}`, style: CSS.die }, `${die}`)),
                h('span', { key: 'total', style: { fontWeight: 700 } }, `= ${payload.total}`),
                payload.check
                  ? h(
                      'span',
                      {
                        key: 'check',
                        style: payload.check.success
                          ? { ...CSS.tag, color: 'var(--dsw-alias-state-success-primary)' }
                          : { ...CSS.tag, color: 'var(--dsw-alias-state-error-primary)' },
                      },
                      `${payload.check.name} DC${payload.check.dc} ${payload.check.success ? '成功' : '失败'}`,
                    )
                  : null,
                payload.private ? h('span', { key: 'private', style: CSS.tag }, '私骰') : null,
              ]);
            }),
          )
        : h('span', { key: 'empty', style: CSS.emptyDice }, '还没有掷骰记录。'),
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

    // 场景下拉：服务端给了公开场景清单就按它列；旧数据回退内置模组；两者都无则不渲染该行。
    const sceneRow = sceneChoices.length > 0
      ? h('div', { key: 'scene', style: CSS.row }, [
          h(
            'select',
            {
              key: 'sceneid',
              style: { ...CSS.input, flex: '1 1 140px' },
              value: gmSceneId,
              title: '选择要推进到的场景',
              onChange: (event: { target: { value: string } }) => setGmSceneId(event.target.value),
            },
            sceneChoices.map((scene: { sceneId: string; title: string }) => h('option', { key: scene.sceneId, value: scene.sceneId }, scene.title)),
          ),
          h('button', { key: 'scene-btn', type: 'button', style: CSS.button, disabled: busy, onClick: () => void gmScene() }, '推进场景'),
        ])
      : null;

    const gmConsole = isHost && gmOpen
      ? h('div', { key: 'gmconsole', style: { ...CSS.section, gap: 8 } }, [
          h('strong', { key: 't' }, 'GM 控制台'),
          h('div', { key: 'narr', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
            h('textarea', {
              key: 'txt',
              style: { ...CSS.field, minHeight: 52, resize: 'vertical' },
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
          sceneRow,
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

    // M9.6a：房主才显示「内容工坊」入口（切主区域独立工具页；玩家看不到）。
    const workshopEntry = isHost
      ? h('div', { key: 'workshop-entry', style: { ...CSS.section, flexDirection: 'row', alignItems: 'center', gap: 6, padding: '6px 8px' } }, [
          h('span', { key: 'icon', style: { fontSize: 13, lineHeight: 1 } }, '🛠'),
          h('span', { key: 't', style: { ...CSS.sectionTitle, fontSize: 12 } }, '内容工坊'),
          h('span', { key: 's', style: { ...CSS.muted, flex: '1 1 auto', minWidth: 0 } }, '图标 · 地图 · 内容包'),
          h(
            'button',
            {
              key: 'open',
              type: 'button',
              style: CSS.button,
              title: '在主区域打开内容工坊（内容包 / 图标 / 地图 / 分享）',
              onClick: () => {
                const opened = props?.onOpenWorkshop?.();
                if (opened === false) {
                  setStatus({ kind: 'bad', text: '当前宿主不支持主区域工具页（keyed main 面板不可用），工坊打不开。' });
                }
              },
            },
            '打开工坊',
          ),
        ])
      : null;

    // M7：右栏「对话镜像」状态卡（玩家侧原生会话镜像；房主显示无需镜像）。
    const mirrorText = mirrorStatusText(mirrorStatus, {
      isHost,
      player: Boolean(session?.playerToken),
    });
    const mirrorSection = session
      ? h('div', { key: 'mirror', style: { ...CSS.section, gap: 6 } }, [
          h('div', { key: 'head', style: CSS.sectionTitle }, [
            h('span', { key: 't' }, '对话镜像'),
            h(
              'span',
              { key: 'tag', style: CSS.tag },
              mirrorText.kind === 'ok' ? '已连接' : mirrorText.kind === 'bad' ? '不可用' : mirrorText.kind === 'busy' ? '同步中' : '未连接',
            ),
          ]),
          h('span', { key: 'text', style: mirrorText.kind === 'ok' ? CSS.ok : mirrorText.kind === 'bad' ? CSS.bad : CSS.muted }, mirrorText.text),
          mirrorStatus?.sessionId
            ? h(
                'button',
                {
                  key: 'open',
                  type: 'button',
                  style: CSS.button,
                  title: '在 DSH 原生会话界面打开镜像会话',
                  onClick: () => {
                    openMirrorSession(String(mirrorStatus.sessionId));
                  },
                },
                '打开镜像会话',
              )
            : null,
          mirrorStatus?.sessionId
            ? h(
                'span',
                {
                  key: 'sid',
                  style: { ...CSS.muted, fontFamily: 'monospace', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis' },
                  title: mirrorStatus.sessionId,
                },
                `会话 id：${shortId(String(mirrorStatus.sessionId), 12)}`,
              )
            : null,
          mirrorText.kind === 'bad' ? h('span', { key: 'fallback', style: CSS.muted }, MIRROR_FALLBACK_HINT) : null,
        ])
      : null;

    const children: unknown[] = [workshopEntry, statusLine, mirrorSection].filter((entry) => entry !== null && entry !== undefined);
    if (!session) children.push(lobby);
    else if (!room) children.push(connecting);
    else {
      children.push(
        roomCard,
        // M9.4：rule 房间才渲染的紧凑子页签（人物/装备/背包）与战斗紧凑条；无 rules 时组件自行返回 null。
        h(rulesUi.SidebarRulesSection, { key: 'rules-tabs', onOpenMain: openMain }),
        h(rulesUi.CombatCompact, { key: 'rules-combat', onOpenMain: openMain }),
        partySection,
        seatSection,
        gmConsole,
        diceSection,
        growthSection,
      );
    }

    return h('div', { key: 'root', style: CSS.root }, children);
  }

  return {
    inject: ['slots'],
    apply(ctx: ClientContext) {
      /** 懒取右侧栏导航面：点击时一定已就绪；精简宿主没有该服务时返回 undefined。 */
      const sidebarRight = (): SidebarRightService | undefined => {
        const service = ctx.get?.('sidebarRight') as SidebarRightService | undefined;
        return service && typeof service.openTab === 'function' ? service : undefined;
      };

      /**
       * 打开右侧栏「跑团桌」tab。
       * @returns 成功返回 true；没有在屏会话面（openTab 会抛错）返回 false，由调用方决定引导方式。
       */
      const openTableTab = (): boolean => {
        const service = sidebarRight();
        if (!service) return false;
        try {
          service.openTab(TAB_KIND);
          return true;
        } catch {
          /* 没有已挂载的会话面（例如停在空态页）时由调用方改走「先新建会话」 */
          return false;
        }
      };

      /** 空态页没有会话时：请 DSH 走它自己的「新会话」导航（没有工作区时它自己不动作）。 */
      const ensureSession = (): void => {
        const navigation = ctx.get?.('uiWorkspace') as
          | { startSession?: (workspaceId?: string) => void }
          | undefined;
        try {
          navigation?.startSession?.();
        } catch (error) {
          console.warn('[dsh-trpg-table] 新建会话失败', error);
        }
      };

      /**
       * M7：在 DSH 原生会话界面打开玩家本机镜像会话。
       * `uiWorkspace.openSession(sessionId)` 是 DSH 的公开导航 API（选会话并显示对话）；
       * 精简宿主没有该服务时返回 false，右栏卡片回退为「显示会话 id 供手动打开」。
       * @param sessionId - 镜像会话 id。
       * @returns 成功 true；宿主无导航能力 false。
       */
      const openMirrorSession = (sessionId: string): boolean => {
        const navigation = ctx.get?.('uiWorkspace') as
          | { openSession?: (target: { kind: 'session'; sessionId: string } | string) => void }
          | undefined;
        if (typeof navigation?.openSession !== 'function') return false;
        try {
          navigation.openSession(sessionId);
          return true;
        } catch (error) {
          console.warn('[dsh-trpg-table] 打开镜像会话失败', error);
          return false;
        }
      };

      /** 读右侧栏「当前在屏会话」：空态页/全局页面为 undefined。 */
      const readMounted = (): string | undefined => sidebarRight()?.mounted?.getSnapshot();

      /** layout 服务（ui-layout 提供）：切换 keyed `main` 主区域面板；精简宿主可能没有。 */
      const layout = (): { selectPanel: (id: string | null) => void } | undefined => {
        const service = ctx.get?.('layout') as { selectPanel?: (id: string | null) => void } | undefined;
        return service && typeof service.selectPanel === 'function'
          ? (service as { selectPanel: (id: string | null) => void })
          : undefined;
      };

      /**
       * 右栏「详细」入口：切主区域 keyed `main` 面板 `trpg-view` 并指定视图。
       * @returns 成功 true；宿主没有 main 面板机制时 false（右栏显示可读提示）。
       */
      const openMainPanel = (view: MainViewKind): boolean => {
        rulesStore.setMainView(view);
        const service = layout();
        if (!service) return false;
        try {
          service.selectPanel(MAIN_PANEL_ID);
          return true;
        } catch (error) {
          console.warn('[dsh-trpg-table] 打开主区域详细页失败', error);
          return false;
        }
      };

      /** 主区域「返回对话」：selectPanel(null) 回到 Conversation。 */
      const closeMainPanel = (): void => {
        try {
          layout()?.selectPanel(null);
        } catch (error) {
          console.warn('[dsh-trpg-table] 返回对话失败', error);
        }
      };

      /**
       * 右栏「内容工坊」入口：切主区域 keyed `main` 面板 `trpg-workshop`（M9.6a）。
       * @returns 成功 true；宿主没有 main 面板机制时 false（右栏显示可读提示）。
       */
      const openWorkshopPanel = (): boolean => {
        const service = layout();
        if (!service) return false;
        try {
          service.selectPanel(WORKSHOP_PANEL_ID);
          return true;
        } catch (error) {
          console.warn('[dsh-trpg-table] 打不开内容工坊', error);
          return false;
        }
      };

      // 1) 右侧栏 tab 类型：服务由 @deepseek-ai/dsh-client-ui-sidebar-right 提供，
      //    用 ctx.inject 惰性等待（它可能比本插件晚挂载；没有该服务的精简宿主只是没有这个 tab）。
      ctx.inject?.(['sidebarRightTabs'], (scoped) => {
        const tabs = scoped.get?.('sidebarRightTabs') as SidebarRightTabsService | undefined;
        if (!tabs || typeof tabs.register !== 'function') return;
        let dispose: (() => void) | undefined;
        try {
          dispose = tabs.register({ id: TAB_TYPE_ID, kind: TAB_KIND, title: () => TAB_TITLE });
        } catch (error) {
          console.warn('[dsh-trpg-table] 注册右侧栏 tab 类型失败', error);
          return;
        }
        return () => dispose?.();
      });

      // 2) tab 正文：按 tab 类型的 id 注册到 keyed slot（slot 由右侧栏拥有，inject 会等它就绪）。
      //    inject 给正文一个「打开主区域详细页」的回调（M9.4 的人物/装备/背包/地图/战棋）。
      ctx.effect?.(() =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID, inject: () => ({ onOpenMain: openMainPanel, onOpenWorkshop: openWorkshopPanel, onOpenMirrorSession: openMirrorSession }) },
            TrpgTableCard,
          ),
        ),
      );

      // 2b) 主区域 keyed `main` 面板：详细版人物/装备/背包/世界地图/战棋。
      //     `main` 是 ui-layout 的 root keyed slot；inject 会等 layout 先挂载（精简宿主没有就不注册）。
      ctx.effect?.(() =>
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: MAIN_PANEL_ID,
              inject: () => ({ goHome: closeMainPanel, readSession: loadSession }),
            },
            rulesUi.RulesMainPanel,
          ),
        ),
      );

      // 2c) M9.6a 主区域 keyed `main` 面板：内容工坊（左栏内容包 + 右侧 8 页签；只读内容 + 图标/地图工作台）。
      ctx.effect?.(() =>
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: WORKSHOP_PANEL_ID,
              inject: () => ({ goHome: closeMainPanel, readSession: loadSession }),
            },
            workshopUi.WorkshopMainPanel,
          ),
        ),
      );

      // 3) 对话顶栏入口（点击打开右侧栏 tab，不再切换主区域面板）。
      ctx.effect?.(() =>
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'dsh-trpg-table-open',
              order: 60,
              label: TAB_TITLE,
              inject: () => ({ onOpen: openTableTab }),
            },
            OpenTableButton,
          ),
        ),
      );

      // 4) 全局入口：`conversation.header.leading` 是 root 作用域，空态新会话页（无会话头操作集群）也渲染。
      //    该组件只在「没有会话面」或「空会话」时显示，正常对话页让位给上面的 chip，不出现重复入口。
      ctx.effect?.(() =>
        ctx.slots.inject('conversation.header.leading', () =>
          ctx.slots.register(
            {
              name: 'conversation.header.leading',
              inject: () => ({
                onOpen: openTableTab,
                readMounted,
                subscribeMounted: (listener: () => void) => {
                  const observable = sidebarRight()?.mounted;
                  if (!observable || typeof observable.subscribe !== 'function') return () => {};
                  return observable.subscribe(listener);
                },
                ensureSession,
              }),
            },
            GlobalOpenTableEntry,
          ),
        ),
      );
    },
  };
}
