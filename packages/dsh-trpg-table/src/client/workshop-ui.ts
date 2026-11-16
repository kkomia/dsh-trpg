/**
 * M9.6a 内容工坊 UI（主区域独立工具页）：左侧 pack 列表 + 右侧 8 个页签。
 *
 * 页签：概览 / 角色卡 / 世界书 / 模组 / 规则（只读）+ 图标 / 地图（重点工作台）+ 分享。
 * - 聊天仍复用原生会话：本文件只注册 keyed `main` 面板，不碰聊天区与右栏三屏；
 * - 所有数据来自 host RPC（workshop.ts），客户端只读渲染、不做规则计算；
 * - 只读页大 JSON 一律折叠（`<details>`）或分页「显示更多」，不一次性展开全部原文；
 * - 后端未就绪/未实现时给中文降级文案，不崩、不空白。
 */
import type {
  AssetsGenerateCandidate,
  MapGenerateStyle,
  MapGenerateResult,
  PackAssetKind,
  PackImportStrategy,
  WorldGenerateResult,
} from '@dsh-trpg/protocol';
import type { ContentPack } from '@dsh-trpg/content';
import {
  PACK_ASSET_KIND_LABELS,
  WORKSHOP_TABS,
  assetFilePathFor,
  assetIdFromFileName,
  applyBattleMap,
  applyWorldMap,
  base64ByteSize,
  battleCharToTerrainId,
  collectIconReferences,
  collectMissingIconTargets,
  createWorkshopStore,
  downloadBase64File,
  fileToBase64,
  formatBytes,
  guessAssetUrls,
  iconPromptFor,
  packAssetUrl,
  sniffIconFormat,
  suggestAssetId,
  suggestMapId,
  TERRAIN_COLORS,
  uniqueAssetId,
  WORKSHOP_DEFAULT_BASE_HINT,
  type IconReferenceInfo,
  type MissingIconTarget,
  type WorkshopSessionLike,
  type WorkshopSnapshot,
  type WorkshopStore,
  type WorkshopTab,
} from './workshop.ts';

type H = (...args: any[]) => any;
type VNode = unknown;

export interface WorkshopUi {
  WorkshopMainPanel: (props: { goHome?: () => void; readSession?: () => unknown }) => VNode;
}

// ---------------------------------------------------------------------------
// 样式（主题 token；主区域自适应双列）
// ---------------------------------------------------------------------------

const ST: Record<string, Record<string, unknown>> = {
  page: {
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '10px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    flexShrink: 0,
    minWidth: 0,
  },
  title: { fontSize: 15, fontWeight: 700, minWidth: 0, whiteSpace: 'nowrap' },
  sub: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  body: { flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(210px, 260px) minmax(0, 1fr)' },
  packList: {
    borderRight: '1px solid var(--dsw-alias-border-l1)',
    padding: '10px 10px 18px',
    overflowY: 'auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  pane: { minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '12px 18px 28px', display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
  col: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  tiny: { fontSize: 10, minWidth: 0, color: 'var(--dsw-alias-label-secondary)' },
  small: { fontSize: 11, minWidth: 0 },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  warn: { color: 'var(--dsw-alias-state-warning-primary)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11 },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '4px 9px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonOn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '4px 9px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonPrimary: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '5px 12px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-bg-base)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonDanger: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-state-error-primary)',
    fontSize: 10,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonDisabled: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '4px 9px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 11,
    cursor: 'not-allowed',
    opacity: 0.55,
    whiteSpace: 'nowrap',
  },
  input: {
    flex: '1 1 140px',
    minWidth: 90,
    boxSizing: 'border-box',
    padding: '4px 8px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
    fontFamily: 'inherit',
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 60,
    padding: '5px 8px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  select: {
    boxSizing: 'border-box',
    padding: '4px 7px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
  },
  tag: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
  },
  tagOn: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-label-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)',
    whiteSpace: 'nowrap',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
  },
  panel: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-2)',
    padding: 10,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  panelTitle: { fontSize: 12, fontWeight: 700, color: 'var(--dsw-alias-label-secondary)', letterSpacing: 0.4 },
  card: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 9,
    padding: 8,
    background: 'var(--dsw-alias-bg-layer-1)',
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    minWidth: 0,
  },
  packItem: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 9,
    padding: '6px 8px',
    background: 'var(--dsw-alias-bg-layer-1)',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    cursor: 'pointer',
    minWidth: 0,
    textAlign: 'left',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
  },
  packItemOn: {
    border: '1px solid var(--dsw-alias-brand-primary)',
    borderRadius: 9,
    padding: '6px 8px',
    background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1))',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    cursor: 'pointer',
    minWidth: 0,
    textAlign: 'left',
    color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'inherit',
  },
  hint: {
    border: '1px dashed var(--dsw-alias-border-l2)',
    borderRadius: 9,
    padding: 8,
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    minWidth: 0,
  },
  notice: {
    borderRadius: 9,
    border: '1px solid var(--dsw-alias-border-l1)',
    padding: '6px 9px',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    fontSize: 11,
    minWidth: 0,
  },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10, alignItems: 'start', minWidth: 0 },
  threeCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, minWidth: 0 },
  preview: {
    position: 'relative',
    width: '100%',
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
  },
  img: { display: 'block', width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'auto' },
  thumb: {
    width: 40,
    height: 40,
    flex: '0 0 40px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    objectFit: 'contain',
  },
  code: {
    margin: 0,
    padding: 6,
    borderRadius: 6,
    background: 'var(--dsw-alias-bg-base)',
    border: '1px solid var(--dsw-alias-border-l1)',
    fontSize: 10,
    lineHeight: 1.45,
    maxHeight: 220,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'var(--dsw-alias-label-secondary)',
  },
  details: { minWidth: 0 },
  summary: { cursor: 'pointer', fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
  gridCell: { position: 'absolute', boxSizing: 'border-box' },
  marker: {
    position: 'absolute',
    transform: 'translate(-50%, -50%)',
    minWidth: 14,
    height: 14,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 8,
    fontWeight: 700,
    color: '#0b0d10',
    border: '1px solid rgba(0,0,0,.5)',
  },
};

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

export function createWorkshopUi(React: any): WorkshopUi {
  const h: H = React.createElement;
  const { useCallback, useEffect, useMemo, useRef, useState } = React;

  /** 工坊 store 在插件生命周期内只建一次（关闭/重开主区域保留状态）。 */
  const store: WorkshopStore = createWorkshopStore();

  function useSnapshot(): WorkshopSnapshot {
    const [snapshot, setSnapshot] = useState(() => store.getSnapshot());
    useEffect(() => {
      const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
      setSnapshot(store.getSnapshot());
      return unsubscribe;
    }, []);
    return snapshot as WorkshopSnapshot;
  }

  /** base64 图片 → blob URL（卸载/替换时 revoke）。 */
  function useObjectUrl(b64: string | undefined, format: 'png' | 'svg' | undefined): string | undefined {
    const [url, setUrl] = useState(undefined as string | undefined);
    useEffect(() => {
      if (typeof b64 !== 'string' || b64.length === 0 || format === undefined) {
        setUrl(undefined);
        return undefined;
      }
      let created: string | undefined;
      try {
        const binary = atob(b64.replace(/\s+/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: format === 'svg' ? 'image/svg+xml' : 'image/png' });
        created = URL.createObjectURL(blob);
        setUrl(created);
      } catch {
        setUrl(undefined);
      }
      return () => {
        if (created !== undefined) URL.revokeObjectURL(created);
      };
    }, [b64, format]);
    return url;
  }

  /** 候选/本地预览图（base64）。 */
  function B64Image(props: { b64: string; format: 'png' | 'svg'; alt: string; style?: Record<string, unknown> }): VNode {
    const url = useObjectUrl(props.b64, props.format);
    if (url === undefined) return h('span', { style: ST.tiny }, '预览不可用');
    return h('img', { src: url, alt: props.alt, title: props.alt, style: { ...ST.img, ...(props.style ?? {}) }, onError: () => undefined });
  }

  /** 依次尝试多个 URL 的预览图（清单 file 未知时探测 png/svg）。 */
  function ProbeImage(props: { urls: string[]; size?: number; round?: boolean; label: string }): VNode {
    const [index, setIndex] = useState(0);
    useEffect(() => {
      setIndex(0);
    }, [props.urls.join('|')]);
    if (props.urls.length === 0 || index >= props.urls.length) {
      return h('span', {
        style: {
          width: props.size ?? 40,
          height: props.size ?? 40,
          flex: `0 0 ${props.size ?? 40}px`,
          borderRadius: props.round === true ? 999 : 7,
          border: '1px dashed var(--dsw-alias-border-l2)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 9,
          color: 'var(--dsw-alias-label-secondary)',
        },
        title: `${props.label}：没有可预览的资产文件（或尚未落盘）`,
      }, '—');
    }
    return h('img', {
      src: props.urls[index],
      alt: props.label,
      title: props.label,
      style: { ...ST.thumb, ...(props.size !== undefined ? { width: props.size, height: props.size, flex: `0 0 ${props.size}px` } : {}), borderRadius: props.round === true ? 999 : 7 },
      onError: () => setIndex((current: number) => current + 1),
    });
  }

  function Tag(props: { text: string; on?: boolean; title?: string }): VNode {
    return h('span', { style: props.on === true ? ST.tagOn : ST.tag, title: props.title }, props.text);
  }

  function SectionTitle(props: { text: string; sub?: string }): VNode {
    return h('div', { style: ST.row }, [
      h('strong', { key: 't', style: { fontSize: 12 } }, props.text),
      props.sub !== undefined ? h('span', { key: 's', style: ST.tiny }, props.sub) : null,
    ]);
  }

  function NoticeBar(props: { snapshot: WorkshopSnapshot }): VNode | null {
    const notice = props.snapshot.notice;
    if (notice === null) return null;
    const color = notice.tone === 'bad' ? ST.bad : notice.tone === 'ok' ? ST.ok : ST.muted;
    return h('div', { key: 'notice', style: { ...ST.notice, borderLeft: `3px solid ${notice.tone === 'bad' ? 'var(--dsw-alias-state-error-primary)' : notice.tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'}` } }, [
      h('span', { key: 't', style: { ...color, fontSize: 11 } }, notice.text),
      ...notice.lines.slice(0, 8).map((line: string, index: number) => h('span', { key: `l${index}`, style: ST.warn }, line)),
      h('button', { key: 'x', type: 'button', style: { ...ST.button, alignSelf: 'flex-start', padding: '1px 7px', fontSize: 9 }, onClick: () => store.dismissNotice() }, '关闭'),
    ]);
  }

  /** 大 JSON 折叠展示（默认折叠；不把整包原文塞进 DOM 文本节点的一次性渲染）。 */
  function JsonFold(props: { label: string; value: unknown; maxHeight?: number }): VNode {
    const text = useMemo(() => {
      try {
        return JSON.stringify(props.value, null, 2) ?? '';
      } catch {
        return '（JSON 序列化失败）';
      }
    }, [props.value]);
    const [open, setOpen] = useState(false);
    return h('details', { style: ST.details, onToggle: (event: { currentTarget: { open: boolean } }) => setOpen(event.currentTarget.open) }, [
      h('summary', { key: 's', style: ST.summary }, `${props.label}${open ? '（收起）' : ''}`),
      open ? h('pre', { key: 'p', style: { ...ST.code, ...(props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : {}) } }, text) : null,
    ]);
  }

  /** 分页列表：默认渲染前 N 条 + 「显示更多」（大列表不卡 UI）。 */
  function usePaged<T>(items: readonly T[], pageSize = 24): { visible: T[]; more: number; showMore: () => void } {
    const [limit, setLimit] = useState(pageSize);
    useEffect(() => {
      setLimit(pageSize);
    }, [items.length, pageSize]);
    return {
      visible: items.slice(0, limit) as T[],
      more: Math.max(0, items.length - limit),
      showMore: () => setLimit((current: number) => current + pageSize),
    };
  }

  function truncate(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  function errorHint(title: string, detail: string | null): VNode {
    return h('div', { style: ST.hint }, [
      h('strong', { key: 't', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, title),
      h('span', { key: 'd', style: ST.warn }, detail ?? '（没有更多信息）'),
      h('span', { key: 'h', style: ST.tiny }, '工坊 RPC 需要 host 已实现 M9.5e 工坊服务（loopback + 房主令牌）。若确认后端已更新，请重启 DSH 后 Ctrl+R 重载客户端。'),
    ]);
  }

  // -------------------------------------------------------------------------
  // 顶部 + 左栏
  // -------------------------------------------------------------------------

  function PackSidebar(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const list = snapshot.packs;
    return h('div', { style: ST.packList }, [
      h('div', { key: 'head', style: ST.row }, [
        h('strong', { key: 't', style: { fontSize: 12 } }, `内容包（${list.length}）`),
        h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
        h('button', { key: 'r', type: 'button', style: { ...ST.button, padding: '1px 7px', fontSize: 10 }, disabled: snapshot.catalogBusy, title: '重新读取 content.list', onClick: () => void store.refreshCatalog() }, '刷新目录'),
      ]),
      snapshot.catalogError !== null ? h('span', { key: 'err', style: ST.bad }, snapshot.catalogError) : null,
      list.length === 0 && snapshot.catalogBusy ? h('span', { key: 'busy', style: ST.muted }, '正在读取内容包目录…') : null,
      list.length === 0 && !snapshot.catalogBusy && snapshot.catalogError === null ? h('span', { key: 'none', style: ST.muted }, 'host 上还没有内容包。') : null,
      ...list.map((pack) =>
        h(
          'button',
          {
            key: pack.packId,
            type: 'button',
            title: `${pack.name} · ${pack.packId} v${pack.version}`,
            style: snapshot.selectedPackId === pack.packId ? ST.packItemOn : ST.packItem,
            onClick: () => void store.selectPack(pack.packId),
          },
          [
            h('span', { key: 'n', style: { fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pack.name),
            h('div', { key: 'm', style: { ...ST.row, gap: 3 } }, [
              h('span', { key: 'src', style: pack.source === 'builtin' ? ST.tag : ST.tagOn }, pack.source === 'builtin' ? '内置' : '数据目录'),
              h('span', { key: 'v', style: ST.tiny }, `v${pack.version}`),
              h('span', { key: 'm2', style: ST.tiny }, `${pack.modules?.length ?? 0} 模组`),
              h('span', { key: 'c', style: ST.tiny }, `${pack.cardCount ?? 0} 卡`),
              h('span', { key: 'l', style: ST.tiny }, `${pack.loreCount ?? 0} 世界书`),
            ]),
            h('span', { key: 'id', style: { ...ST.tiny, opacity: 0.75, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pack.packId),
          ],
        ),
      ),
      h('div', { key: 'dev', style: { ...ST.hint, marginTop: 'auto' } }, [
        h('span', { key: 't', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, '图标清单说明'),
        h('span', { key: 'd', style: ST.tiny }, '后端暂无「列资产清单」RPC：图标页用 pack.export 读 zip 内的 assets/manifest.json（浏览器内解压，零新依赖）。'),
      ]),
    ]);
  }

  function ConnectionBar(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const ok = snapshot.conn !== null;
    return h('div', { key: 'conn', style: { ...ST.row, gap: 6, fontSize: 11 } }, [
      h('span', {
        key: 'dot',
        style: { width: 7, height: 7, borderRadius: 999, display: 'inline-block', flex: '0 0 7px', background: ok ? 'var(--dsw-alias-state-success-primary)' : snapshot.packs.length > 0 ? 'var(--dsw-alias-state-warning-primary)' : 'var(--dsw-alias-state-error-primary)' },
      }),
      ok
        ? h('span', { key: 't', style: ST.small }, `host ${snapshot.base} · 房主令牌：${snapshot.conn?.source ?? ''}`)
        : h('span', { key: 't', style: ST.warn }, snapshot.connectionError ?? '正在解析房主令牌…'),
      snapshot.writeBusy !== null ? h('span', { key: 'busy', style: ST.muted }, `· ${snapshot.writeBusy}`) : null,
    ]);
  }

  function PackagesWorkspace(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const tab = snapshot.tab;
    const detail = snapshot.detail;
    const detailReady = detail !== null && snapshot.detailError === null;
    const body = snapshot.detailBusy
      ? h('div', { key: 'busy', style: ST.hint }, [h('span', { style: ST.muted }, '正在读取 pack.detail…')])
      : snapshot.detailError !== null
        ? h('div', { key: 'err' }, errorHint('内容详情没有读到（后端未就绪 / 权限不足）', snapshot.detailError))
        : detailReady
          ? tab === 'overview'
            ? h(OverviewTab, { key: 'overview', snapshot })
            : tab === 'cards'
              ? h(CardsTab, { key: 'cards', snapshot })
              : tab === 'lore'
                ? h(LoreTab, { key: 'lore', snapshot })
                : tab === 'modules'
                  ? h(ModulesTab, { key: 'modules', snapshot })
                  : tab === 'rules'
                    ? h(RulesTab, { key: 'rules', snapshot })
                    : tab === 'icons'
                      ? h(IconsTab, { key: 'icons', snapshot })
                      : tab === 'maps'
                        ? h(MapsTab, { key: 'maps', snapshot })
                        : h(ShareTab, { key: 'share', snapshot })
          : h('div', { key: 'none', style: ST.hint }, [h('span', { style: ST.muted }, '左侧选择一个内容包查看详情。')]);
    return h('div', { key: 'pane', style: ST.pane }, [
      h('div', { key: 'tabs', style: { ...ST.row, gap: 2, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 7 } },
        WORKSHOP_TABS.map((entry) =>
          h(
            'button',
            { key: entry.id, type: 'button', style: { ...(tab === entry.id ? ST.buttonOn : ST.button), borderColor: tab === entry.id ? 'var(--dsw-alias-brand-primary)' : 'transparent', background: tab === entry.id ? undefined : 'transparent' }, onClick: () => store.setTab(entry.id) },
            entry.label,
          ),
        ),
      ),
      h(ConnectionBar, { key: 'conn', snapshot }),
      h(NoticeBar, { key: 'notice', snapshot }),
      body,
    ]);
  }

  function WorkshopMainPanel(props: { goHome?: () => void; readSession?: () => unknown }): VNode {
    const snapshot = useSnapshot();
    useEffect(() => {
      store.init(() => {
        try {
          return (props.readSession?.() as WorkshopSessionLike | null | undefined) ?? null;
        } catch {
          return null;
        }
      });
      // 只初始化一次；会话变化用顶部「刷新」重连（store.connect）。
    }, []);
    const title = snapshot.detail !== null ? `${snapshot.detail.name}` : snapshot.selectedPackId !== null ? snapshot.selectedPackId : '内容工坊';
    return h('div', { style: ST.page }, [
      h('div', { key: 'header', style: ST.header }, [
        h('span', { key: 'icon', style: { fontSize: 18, lineHeight: 1 } }, '🛠'),
        h('div', { key: 'title', style: { ...ST.col, gap: 0, minWidth: 0 } }, [
          h('span', { key: 't', style: ST.title }, `内容工坊 · ${title}`),
          h('span', { key: 's', style: ST.sub }, snapshot.detail !== null ? `${snapshot.detail.packId} v${snapshot.detail.version} · ${snapshot.detail.author ?? ''}` : '内容包 / 图标 / 地图 / 分享'),
        ]),
        h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
        h('button', { key: 'back', type: 'button', style: ST.button, title: '回到对话（工坊可随时再打开）', onClick: () => props.goHome?.() }, '返回对话'),
      ]),
      h('div', { key: 'body', style: ST.body }, [h(PackSidebar, { key: 'side', snapshot }), h(PackagesWorkspace, { key: 'main', snapshot })]),
      snapshot.phase === 'connecting' ? h('span', { key: 'phase', style: { ...ST.muted, padding: '0 16px 8px' } }, '正在连接工坊后端…') : null,
    ]);
  }

  // -------------------------------------------------------------------------
  // 概览 / 角色卡 / 世界书 / 模组 / 规则（只读）
  // -------------------------------------------------------------------------

  function countOfReaders(pack: ContentPack): { modules: number; cards: number; lore: number; scenes: number; encounters: number } {
    const modules = pack.modules ?? [];
    let scenes = 0;
    let encounters = 0;
    for (const module of modules) {
      scenes += module.scenes?.length ?? 0;
      encounters += module.encounters?.length ?? 0;
    }
    return { modules: modules.length, cards: pack.cards?.length ?? 0, lore: pack.lorebook?.entries?.length ?? 0, scenes, encounters };
  }

  function OverviewTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const pack = snapshot.detail as ContentPack;
    const counts = countOfReaders(pack);
    const exported = snapshot.exported;
    const builtin = store.isBuiltinPack(pack.packId);
    const catalogEntry = snapshot.packs.find((entry) => entry.packId === pack.packId);
    const source = catalogEntry?.source ?? 'data';
    const rules = pack.rules;
    const ruleSummary = rules === undefined
      ? '无 rules 段（纯叙事包）'
      : `${rules.name ?? rules.rulesId} v${rules.rulesVersion}：${rules.sheet?.attributes?.length ?? 0} 属性 / ${rules.actions?.length ?? 0} 动作 / ${rules.formulas !== undefined ? Object.keys(rules.formulas).length : 0} 公式`;
    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'meta', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `${pack.name}`, sub: pack.packId }),
        h('div', { key: 'tags', style: ST.row }, [
          h(Tag, { key: 'src', text: source === 'builtin' ? '内置包（只读）' : '数据目录包', on: source === 'data' }),
          h(Tag, { key: 'v', text: `v${pack.version}` }),
          h(Tag, { key: 'schema', text: pack.schemaVersion ?? 'trpg.pack/1' }),
          h(Tag, { key: 'sys', text: `规则系统 ${pack.ruleSystem?.name ?? pack.ruleSystem?.id ?? '—'}` }),
          h(Tag, { key: 'license', text: `许可 ${pack.license ?? '未标注'}` }),
        ]),
        pack.description !== undefined ? h('span', { key: 'd', style: ST.small }, pack.description) : null,
        h('span', { key: 'a', style: ST.muted }, `作者：${pack.author ?? '—'}　默认模组：${pack.defaultModuleId ?? '—'}　封面：${pack.icon !== undefined ? truncate(pack.icon, 60) : '未配'}`),
        h('div', { key: 'counts', style: ST.threeCol }, [
          h('div', { key: 'm', style: ST.card }, [h('span', { style: ST.tiny }, '模组'), h('strong', { style: { fontSize: 16 } }, String(counts.modules)), h('span', { style: ST.tiny }, `${counts.scenes} 场景 / ${counts.encounters} 遭遇`)]),
          h('div', { key: 'c', style: ST.card }, [h('span', { style: ST.tiny }, '预制角色卡'), h('strong', { style: { fontSize: 16 } }, String(counts.cards)), h('span', { style: ST.tiny }, 'pack 内置卡库')]),
          h('div', { key: 'l', style: ST.card }, [h('span', { style: ST.tiny }, '世界书条目'), h('strong', { style: { fontSize: 16 } }, String(counts.lore)), h('span', { style: ST.tiny }, pack.lorebook?.title ?? '')]),
        ]),
        h('span', { key: 'r', style: ST.muted }, `规则：${ruleSummary}`),
      ]),
      h('div', { key: 'io', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '导入 / 导出', sub: 'pack.export → 浏览器下载；pack.import 冲突策略见「分享」' }),
        h('div', { key: 'row', style: ST.row }, [
          h('button', { key: 'exp', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => void store.exportCurrent() }, '导出 .trpgpack'),
          builtin ? h('button', { key: 'dup', type: 'button', style: ST.button, disabled: snapshot.writeBusy !== null, title: '内置包只读：导出后用 rename 导入成可编辑副本', onClick: () => void store.duplicateCurrent() }, '复制为可编辑副本') : null,
          h('span', { key: 'fileName', style: exported !== null ? ST.ok : ST.muted }, exported !== null ? `下载文件名：${exported.fileName}（${formatBytes(exported.bytes)}）` : '尚未导出（导出的文件名会显示在这里）'),
        ]),
        exported !== null ? h('span', { key: 'hash', style: ST.tiny }, `packHash：${exported.packHash}`) : null,
        builtin ? h('span', { key: 'ro', style: ST.warn }, '内置包只读：pack.update / pack.assetPut 会被 host 拒绝（请先复制为数据目录副本再编辑）。') : null,
      ]),
      h('div', { key: 'warn', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '校验警告', sub: 'host 在 import/update/assetPut 时全量校验并回传 warnings；工坊没有独立的说明——下面显示最近一次写回结果' }),
        snapshot.lastWarnings.length === 0
          ? h('span', { key: 'none', style: ST.muted }, '最近一次写回没有 warning。')
          : h('div', { key: 'list', style: ST.col }, snapshot.lastWarnings.map((warning: string, index: number) => h('span', { key: index, style: ST.warn }, `• ${warning}`))),
      ]),
      h('div', { key: 'modules', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '模组一览', sub: '只读；编辑表单后续版本' }),
        ...(pack.modules ?? []).map((module) =>
          h('div', { key: module.moduleId, style: ST.card }, [
            h('div', { key: 'h', style: ST.row }, [
              h('strong', { key: 'n', style: { fontSize: 12 } }, module.title),
              h(Tag, { key: 'id', text: module.moduleId }),
              h(Tag, { key: 'lv', text: `等级 ${module.level?.[0] ?? '?'}–${module.level?.[1] ?? '?'}` }),
              h(Tag, { key: 'pc', text: `玩家 ${module.playerCount?.[0] ?? '?'}–${module.playerCount?.[1] ?? '?'}` }),
              h(Tag, { key: 'd', text: `${module.durationMinutes ?? 0} 分钟` }),
            ]),
            h('span', { key: 's', style: ST.muted }, truncate(module.synopsis ?? '', 180)),
          ]),
        ),
      ]),
    ]);
  }

  function attributeSummary(card: unknown): string {
    const abilities = (card as { abilities?: Record<string, number> }).abilities;
    if (abilities === undefined) return '—';
    return Object.entries(abilities)
      .map(([key, value]) => `${key.toUpperCase()} ${value}`)
      .join(' / ');
  }

  function CardsTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const pack = props.snapshot.detail as ContentPack;
    const cards = pack.cards ?? [];
    const paged = usePaged(cards, 12);
    return h('div', { style: { ...ST.col, gap: 8 } }, [
      h('div', { key: 'head', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `角色卡（${cards.length}）`, sub: '只读：名字 / 职业等级 / 属性摘要 / 原 JSON 折叠；编辑表单后续版本' }),
        h('span', { key: 'hint', style: ST.tiny }, '卡实例与落座由 host/rooms 负责，工坊只展示 pack 内置卡库（cards[]）。'),
      ]),
      ...paged.visible.map((card, index) => {
        const identity = card.identity as { name?: string; race?: string; class?: string; level?: number } | undefined;
        return h('div', { key: card.cardId ?? index, style: ST.card }, [
          h('div', { key: 'h', style: ST.row }, [
            h('strong', { key: 'n', style: { fontSize: 12 } }, identity?.name ?? card.cardId ?? `卡 ${index + 1}`),
            h(Tag, { key: 'race', text: identity?.race ?? '种族未填' }),
            h(Tag, { key: 'class', text: `${identity?.class ?? '职业未填'} Lv${identity?.level ?? '?'}` }),
            h(Tag, { key: 'id', text: card.cardId ?? '—' }),
          ]),
          h('span', { key: 'attr', style: ST.small }, attributeSummary(card)),
          h('span', { key: 'sum', style: ST.muted }, truncate(typeof card.publicSummary === 'string' ? card.publicSummary : '', 140)),
          h(JsonFold, { key: 'json', label: '原 JSON（cards[]）', value: card }),
        ]);
      }),
      paged.more > 0 ? h('button', { key: 'more', type: 'button', style: ST.button, onClick: paged.showMore }, `显示更多（还有 ${paged.more} 张）`) : null,
    ]);
  }

  function LoreTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const pack = props.snapshot.detail as ContentPack;
    const book = pack.lorebook;
    const entries = book?.entries ?? [];
    const paged = usePaged(entries, 20);
    return h('div', { style: { ...ST.col, gap: 8 } }, [
      h('div', { key: 'head', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `世界书：${book?.title ?? '（未命名）'}（${entries.length} 条）`, sub: '只读：title / visibility / keys / priority / alwaysOn + 正文截断' }),
      ]),
      ...paged.visible.map((entry, index) =>
        h('div', { key: entry.loreId ?? index, style: ST.card }, [
          h('div', { key: 'h', style: ST.row }, [
            h('strong', { key: 't', style: { fontSize: 12 } }, entry.title ?? entry.loreId ?? `条目 ${index + 1}`),
            h(Tag, { key: 'v', text: entry.visibility ?? '—', on: entry.visibility !== 'public' }),
            h(Tag, { key: 'p', text: `priority ${entry.priority ?? 0}` }),
            entry.alwaysOn === true ? h(Tag, { key: 'a', text: 'alwaysOn', on: true }) : null,
            h('span', { key: 'id', style: { ...ST.tiny, opacity: 0.7 } }, entry.loreId ?? ''),
          ]),
          h('div', { key: 'k', style: ST.row }, [
            h('span', { key: 'l', style: ST.tiny }, 'keys：'),
            ...(entry.keys ?? []).slice(0, 12).map((key: string) => h(Tag, { key: `k-${key}`, text: key })),
            (entry.keys ?? []).length > 12 ? h('span', { key: 'more', style: ST.tiny }, `+${(entry.keys ?? []).length - 12}`) : null,
          ]),
          h('span', { key: 'c', style: ST.small }, truncate(entry.content ?? '', 160)),
          h(JsonFold, { key: 'json', label: '原 JSON（lorebook.entries[]）', value: entry }),
        ]),
      ),
      paged.more > 0 ? h('button', { key: 'more', type: 'button', style: ST.button, onClick: paged.showMore }, `显示更多（还有 ${paged.more} 条）`) : null,
    ]);
  }

  function ModulesTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const pack = props.snapshot.detail as ContentPack;
    const modules = pack.modules ?? [];
    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'head', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `模组（${modules.length}）`, sub: 'scenes 列表：标题 / 开场截断 / NPC / beats / checks / encounters 计数；只读' }),
      ]),
      ...modules.flatMap((module) => [
        h('div', { key: `m-${module.moduleId}`, style: ST.panel }, [
          h(SectionTitle, { key: 't', text: module.title, sub: module.moduleId }),
          h('div', { key: 'meta', style: ST.row }, [
            h(Tag, { key: 'start', text: `起始场景 ${module.startSceneId ?? '—'}` }),
            h(Tag, { key: 'npcs', text: `${module.npcs?.length ?? 0} NPC` }),
            h(Tag, { key: 'scenes', text: `${module.scenes?.length ?? 0} 场景` }),
            h(Tag, { key: 'enc', text: `${module.encounters?.length ?? 0} 遭遇` }),
            h(Tag, { key: 'rew', text: `${module.rewards?.length ?? 0} 奖励` }),
            h(Tag, { key: 'sec', text: `${module.secrets?.length ?? 0} 秘密` }),
          ]),
          h(JsonFold, { key: 'gm', label: 'GM 备注 / 模组原 JSON（含 gmNotes、secrets）', value: module }),
        ]),
        ...(module.scenes ?? []).map((scene) =>
          h('div', { key: `s-${module.moduleId}-${scene.sceneId}`, style: { ...ST.card, marginLeft: 10 } }, [
            h('div', { key: 'h', style: ST.row }, [
              h('strong', { key: 'n', style: { fontSize: 11 } }, scene.title ?? scene.sceneId),
              h(Tag, { key: 'id', text: scene.sceneId }),
              h(Tag, { key: 'npc', text: `NPC ${scene.npcIds?.length ?? 0}` }),
              h(Tag, { key: 'b', text: `beats ${scene.beats?.length ?? 0}` }),
              h(Tag, { key: 'c', text: `checks ${scene.checks?.length ?? 0}` }),
              h(Tag, { key: 'e', text: `encounters ${scene.encounterIds?.length ?? 0}` }),
              h(Tag, { key: 'r', text: `rewards ${scene.rewardIds?.length ?? 0}` }),
            ]),
            h('span', { key: 'entry', style: ST.muted }, truncate(typeof scene.entry === 'string' ? scene.entry : '', 180)),
            h(JsonFold, { key: 'json', label: '场景原 JSON', value: scene }),
          ]),
        ),
      ]),
    ]);
  }

  function RulesTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const pack = props.snapshot.detail as ContentPack;
    const rules = pack.rules;
    const formulasAll = Object.entries(rules?.formulas ?? {}) as Array<[string, string]>;
    const formulasPaged = usePaged(formulasAll, 16);
    if (rules === undefined) {
      return h('div', { style: ST.hint }, [
        h('strong', { key: 't', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, '这个内容包没有规则段'),
        h('span', { key: 'd', style: ST.muted }, '纯叙事包（rules 缺省）：没有属性/资源/技能/动作/公式/场地数据；工坊规则页无内容可展示。'),
      ]);
    }
    const sheet = rules.sheet;
    const space = rules.space;
    const scripts = Object.entries(rules.scripts ?? {}) as Array<[string, { file?: string; sha256?: string } | undefined]>;
    const formulas = formulasAll;
    const paged = formulasPaged;
    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'head', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `${rules.name ?? rules.rulesId} v${rules.rulesVersion}`, sub: '规则摘要（只读；规则编辑器在后续里程碑）' }),
        h('div', { key: 'tags', style: ST.row }, [
          h(Tag, { key: 'id', text: rules.rulesId }),
          h(Tag, { key: 'schema', text: rules.schemaVersion }),
          h(Tag, { key: 'space', text: `space ${space?.model ?? '无'}` }),
          h(Tag, { key: 'time', text: `time ${rules.time?.model ?? '无'}` }),
        ]),
        rules.description !== undefined ? h('span', { key: 'd', style: ST.muted }, rules.description) : null,
      ]),
      h('div', { key: 'grids', style: ST.threeCol }, [
        h('div', { key: 'attrs', style: ST.card }, [
          h(SectionTitle, { key: 't', text: `属性（${sheet?.attributes?.length ?? 0}）` }),
          ...(sheet?.attributes ?? []).map((entry) => h('span', { key: entry.id, style: ST.tiny }, `${entry.name}（${entry.id}）${entry.min ?? '?'}–${entry.max ?? '?'}，默认 ${entry.default ?? '?'}`)),
        ]),
        h('div', { key: 'res', style: ST.card }, [
          h(SectionTitle, { key: 't', text: `资源（${sheet?.resources?.length ?? 0}）` }),
          ...(sheet?.resources ?? []).map((entry) => h('span', { key: entry.id, style: ST.tiny }, `${entry.name}（${entry.id}）公式 ${entry.formula ?? '—'}`)),
        ]),
        h('div', { key: 'skills', style: ST.card }, [
          h(SectionTitle, { key: 't', text: `技能（${sheet?.skills?.length ?? 0}）` }),
          ...(sheet?.skills ?? []).slice(0, 30).map((entry) => h('span', { key: entry.id, style: ST.tiny }, `${entry.name}（${entry.id}）→ ${entry.attribute}`)),
        ]),
      ]),
      h('div', { key: 'actions', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `动作（${rules.actions?.length ?? 0}）`, sub: 'kind / 目标 / 命中公式 / 花费' }),
        h('div', { key: 'list', style: ST.threeCol },
          (rules.actions ?? []).map((action) =>
            h('div', { key: action.actionId, style: ST.card }, [
              h('strong', { key: 'n', style: { fontSize: 11 } }, action.name ?? action.actionId),
              h('span', { key: 'k', style: ST.tiny }, `${action.kind ?? '—'} · ${action.targeting?.type ?? '—'} / ${action.targeting?.range ?? '—'} / ${action.targeting?.sides ?? '—'}`),
              h('span', { key: 'f', style: ST.tiny }, `命中公式：${action.toHit ?? '—'}${action.damage !== undefined ? `；伤害 ${JSON.stringify(action.damage).slice(0, 80)}` : ''}`),
            ]),
          ),
        ),
      ]),
      h('div', { key: 'formulas', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `公式（${formulas.length}）` }),
        ...paged.visible.map(([key, value]) => h('span', { key, style: { ...ST.tiny, fontFamily: 'ui-monospace, monospace' } }, `${key} = ${value}`)),
        paged.more > 0 ? h('button', { key: 'more', type: 'button', style: ST.button, onClick: paged.showMore }, `显示更多（还有 ${paged.more} 条）`) : null,
      ]),
      h('div', { key: 'hooks', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `钩子脚本（${scripts.length}）`, sub: 'rules.scripts：hook → {file, sha256}；脚本随 .trpgpack 分发、由 host 沙箱执行' }),
        scripts.length === 0
          ? h('span', { key: 'none', style: ST.muted }, '没有 JS 钩子脚本（纯数据规则包）。')
          : scripts.map(([hook, ref]) => h('span', { key: hook, style: { ...ST.tiny, fontFamily: 'ui-monospace, monospace' } }, `${hook} → ${ref?.file ?? '—'} ${ref?.sha256 !== undefined ? `sha256 ${ref.sha256.slice(0, 10)}…` : ''}`)),
      ]),
      h('div', { key: 'space', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: 'space / time / turn', sub: '场地、时间与行动经济概要' }),
        h('span', { key: 'space', style: ST.small }, `space：model=${space?.model ?? '—'}；距离=${space?.distanceMode ?? '—'}；单位=${typeof space?.units === 'string' ? space.units : space?.units !== undefined ? JSON.stringify(space.units) : '—'}；战斗地图 ${space?.battleMaps?.length ?? 0} 张；区域 ${space?.zones?.length ?? 0} 个；地形 ${space?.terrains?.length ?? 0} 种；掩体 ${space?.covers?.length ?? 0} 种`),
        h('span', { key: 'time', style: ST.small }, `time：model=${rules.time?.model ?? '—'}；单位=${rules.time?.durationUnit ?? '—'}；默认回合上限=${rules.time?.defaultMaxRounds ?? '—'}；到上限动作=${rules.time?.onRoundLimit ?? '—'}`),
        h('span', { key: 'turn', style: ST.small }, `turn：${(rules.turn?.resources ?? []).map((entry) => `${entry.name}×${entry.count ?? entry.perTurn ?? '?'}${entry.unit ?? ''}`).join(' / ') || '无资源池'}${rules.turn?.movement !== undefined ? `；移动 ${rules.turn.movement.name} ${rules.turn.movement.cells ?? rules.turn.movement.meters ?? '?'}${rules.turn.movement.unit ?? ''}` : ''}`),
      ]),
    ]);
  }

  // -------------------------------------------------------------------------
  // 图标工作台
  // -------------------------------------------------------------------------

  type IconPath = 'import' | 'svg' | 'image';

  interface BatchRow {
    key: string;
    target: MissingIconTarget;
    status: 'idle' | 'generating' | 'ready' | 'failed';
    candidates: AssetsGenerateCandidate[];
    selected: number | null;
    error: string | null;
  }

  function IconsTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const pack = snapshot.detail as ContentPack;
    const packId = pack.packId;
    const base = snapshot.base;
    const builtin = store.isBuiltinPack(packId);
    const manifest = snapshot.manifest !== null && snapshot.manifest.packId === packId ? snapshot.manifest : null;
    const [path, setPath] = useState('import' as IconPath);
    const [kind, setKind] = useState('item' as PackAssetKind);
    const [assetId, setAssetId] = useState('');
    const [importPreview, setImportPreview] = useState(null as { b64: string; format: 'png' | 'svg'; fileName: string; bytes: number } | null);
    const [importError, setImportError] = useState(null as string | null);
    const [genStyle, setGenStyle] = useState('svg' as 'svg' | 'pixel-32' | 'game-2d');
    const [genPrompt, setGenPrompt] = useState('');
    const [genCount, setGenCount] = useState(1);
    const [genTargetId, setGenTargetId] = useState('');
    const [genCandidates, setGenCandidates] = useState([] as AssetsGenerateCandidate[]);
    const [genSelected, setGenSelected] = useState(null as number | null);
    const [genProvider, setGenProvider] = useState(null as string | null);
    const [genBusy, setGenBusy] = useState(false);
    const [batchRows, setBatchRows] = useState([] as BatchRow[]);
    const [batchBusy, setBatchBusy] = useState(false);
    const fileRef = useRef(null as { click?: () => void; value?: string } | null);

    const references: IconReferenceInfo[] = useMemo(() => collectIconReferences(pack), [pack]);
    const missing: MissingIconTarget[] = useMemo(() => collectMissingIconTargets(pack), [pack]);
    const itemTargets: MissingIconTarget[] = useMemo(() => missing.filter((target: MissingIconTarget) => target.kind === 'item'), [missing]);
    const manifestIds: Set<string> = useMemo(() => new Set((manifest?.assets ?? []).map((entry) => entry.assetId)), [manifest]);
    const takenIds: Set<string> = useMemo(() => {
      const taken = new Set<string>(manifestIds);
      for (const reference of references) if (reference.assetId !== undefined) taken.add(reference.assetId);
      return taken;
    }, [manifestIds, references]);

    const selectedTarget: MissingIconTarget | null = missing.find((target: MissingIconTarget) => `${target.kind}:${target.id}` === genTargetId) ?? null;
    /** SVG 面板固定 style=svg；生图面板只允许 pixel-32 / game-2d（切换面板时归一见下）。 */
    const effectiveGenStyle: 'svg' | 'pixel-32' | 'game-2d' = path === 'svg' ? 'svg' : genStyle === 'svg' ? 'game-2d' : genStyle;
    const suggestedIdFor = useCallback(
      (target: MissingIconTarget | null, nextKind: PackAssetKind, slugSource?: string): string => {
        const scope = 'workshop';
        const slug = slugSource ?? target?.id ?? 'icon';
        return uniqueAssetId(suggestAssetId(nextKind, scope, slug), takenIds);
      },
      [takenIds],
    );

    // 选中目标时自动填充：kind/assetId/prompt（作者可改）。
    useEffect(() => {
      if (selectedTarget === null) return;
      setKind(selectedTarget.kind);
      setAssetId(suggestedIdFor(selectedTarget, selectedTarget.kind));
      setGenPrompt(iconPromptFor(selectedTarget, effectiveGenStyle));
    }, [genTargetId, selectedTarget, genStyle, suggestedIdFor]);

    // 资产清单：进入图标页时自动读取（pack.export + 解压 assets/manifest.json）。
    useEffect(() => {
      if (snapshot.conn !== null && snapshot.detail !== null) void store.loadManifest();
    }, [packId, snapshot.detail !== null, snapshot.conn !== null]);

    const onPickFile = async (file: File | undefined): Promise<void> => {
      if (file === undefined) return;
      setImportError(null);
      try {
        const b64 = await fileToBase64(file);
        const format = sniffIconFormat(b64);
        if (format === null) {
          setImportError('只接受 PNG / SVG（v1 内部强制，按 magic 嗅探不看后缀）：请另存为标准 PNG 或 SVG 再导入。');
          return;
        }
        setImportPreview({ b64, format, fileName: file.name, bytes: base64ByteSize(b64) });
        setAssetId((current: string) => (current.trim().length > 0 ? current : uniqueAssetId(suggestAssetId(kind, 'workshop', assetIdFromFileName(file.name)), takenIds)));
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      }
    };

    const saveImport = async (): Promise<void> => {
      if (importPreview === null) return;
      const id = assetId.trim().length > 0 ? assetId.trim() : suggestedIdFor(null, kind, assetIdFromFileName(importPreview.fileName));
      const result = await store.putAsset({
        assetId: id,
        kind,
        b64: importPreview.b64,
        meta: { style: 'imported', prompt: `本地导入：${importPreview.fileName}` },
      });
      if (result !== null) {
        setImportPreview(null);
        setAssetId('');
      }
    };

    const runGenerate = async (): Promise<void> => {
      if (genBusy) return;
      const prompt = genPrompt.trim();
      if (prompt.length === 0) {
        store.setNotice({ tone: 'bad', text: '提示词不能为空：先选择目标或写一句图标描述。', lines: [] });
        return;
      }
      setGenBusy(true);
      setGenCandidates([]);
      setGenSelected(null);
      try {
        const result = await store.generate({ kind: 'icon', style: effectiveGenStyle, prompt, count: genCount, ...(selectedTarget !== null ? { subject: selectedTarget.name } : {}) });
        if (result !== null) {
          setGenCandidates(result.candidates ?? []);
          setGenProvider(result.provider ?? null);
          if ((result.candidates ?? []).length === 1) setGenSelected(0);
        }
      } finally {
        setGenBusy(false);
      }
    };

    const saveCandidate = async (candidate: AssetsGenerateCandidate): Promise<void> => {
      const id = assetId.trim().length > 0 ? assetId.trim() : suggestedIdFor(selectedTarget, kind, selectedTarget?.id ?? 'icon');
      const result = await store.putAsset({
        assetId: id,
        kind,
        b64: candidate.b64,
        meta: {
          style: candidate.style ?? genStyle,
          prompt: candidate.prompt,
          ...(candidate.seed !== undefined ? { seed: candidate.seed } : {}),
        },
      });
      if (result !== null) {
        setGenCandidates([]);
        setGenSelected(null);
      }
    };

    const runBatch = async (): Promise<void> => {
      if (batchBusy) return;
      const targets = itemTargets.slice(0, 6);
      if (targets.length === 0) {
        store.setNotice({ tone: 'info', text: '物品库没有缺图标的物品（或该包没有 rules.items）：无需批量生成。', lines: [] });
        return;
      }
      setBatchBusy(true);
      setBatchRows(targets.map((target) => ({ key: `${target.kind}:${target.id}`, target, status: 'idle', candidates: [], selected: null, error: null })));
      const update = (key: string, partial: Partial<BatchRow>): void => setBatchRows((rows: BatchRow[]) => rows.map((row) => (row.key === key ? { ...row, ...partial } : row)));
      // 队列并发 2（UI-CONTRACT §7.1 的批量口径；失败条目单独重试）。
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const target = targets[index];
          if (target === undefined) return;
          const key = `${target.kind}:${target.id}`;
          update(key, { status: 'generating' });
          const result = await store.generate({ kind: 'icon', style: effectiveGenStyle, prompt: iconPromptFor(target, effectiveGenStyle), count: 1, subject: target.name });
          if (result === null || (result.candidates ?? []).length === 0) {
            update(key, { status: 'failed', error: '生成失败（见上方提示；可单条重试）' });
          } else {
            update(key, { status: 'ready', candidates: result.candidates ?? [], selected: 0 });
          }
        }
      };
      await Promise.all([worker(), worker()]);
      setBatchBusy(false);
    };

    const saveBatchRow = async (row: BatchRow): Promise<void> => {
      const candidate = row.candidates[row.selected ?? 0];
      if (candidate === undefined) return;
      const id = uniqueAssetId(suggestAssetId(row.target.kind, 'workshop', row.target.id), takenIds);
      const result = await store.putAsset({
        assetId: id,
        kind: row.target.kind,
        b64: candidate.b64,
        meta: { style: candidate.style ?? effectiveGenStyle, prompt: candidate.prompt, ...(candidate.seed !== undefined ? { seed: candidate.seed } : {}) },
      });
      if (result !== null) setBatchRows((rows: BatchRow[]) => rows.filter((entry) => entry.key !== row.key));
    };

    const pathButton = (id: IconPath, label: string): VNode =>
      h('button', { key: id, type: 'button', style: path === id ? ST.buttonOn : ST.button, onClick: () => setPath(id) }, label);

    const manifestRows = (manifest?.assets ?? []).map((entry) => {
      const url = packAssetUrl(base, packId, entry.file);
      return h('div', { key: entry.assetId, style: { ...ST.card, flexDirection: 'row', alignItems: 'center', gap: 8 } }, [
        h(ProbeImage, { key: 'img', urls: [url], size: 44, label: `${entry.assetId}（${entry.file}）` }),
        h('div', { key: 'meta', style: { ...ST.col, gap: 2, minWidth: 0, flex: '1 1 auto' } }, [
          h('div', { key: 'r', style: ST.row }, [
            h('strong', { key: 'id', style: { fontSize: 11 } }, entry.assetId),
            h(Tag, { key: 'k', text: PACK_ASSET_KIND_LABELS[entry.kind as PackAssetKind] ?? entry.kind }),
            h(Tag, { key: 'f', text: entry.format.toUpperCase() }),
            h(Tag, { key: 's', text: `${entry.width}×${entry.height}` }),
            h(Tag, { key: 'b', text: formatBytes(entry.bytes) }),
            h(Tag, { key: 'sha', text: `sha ${entry.sha256.slice(0, 8)}` }),
          ]),
          h('span', { key: 'file', style: { ...ST.tiny, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' } }, entry.file),
          h(JsonFold, { key: 'json', label: '清单条目 JSON（含来源/seed/prompt）', value: entry }),
        ]),
        h('button', {
          key: 'del',
          type: 'button',
          style: ST.buttonDanger,
          title: 'pack.assetDelete：被 pack.json 引用时 host 会拒绝并给出原因',
          onClick: () => void store.deleteAsset(entry.assetId),
        }, '删除'),
      ]);
    });

    const referenceRows = references.map((reference: IconReferenceInfo) => {
      const urls = reference.file !== undefined
        ? [packAssetUrl(base, packId, reference.file), ...(reference.file.endsWith('.svg') ? [packAssetUrl(base, packId, reference.file.replace(/\.svg$/, '.png'))] : [packAssetUrl(base, packId, reference.file.replace(/\.png$/, '.svg'))])]
        : reference.assetId !== undefined
          ? guessAssetUrls(base, packId, reference.kind, reference.assetId)
          : [];
      return h('div', { key: `${reference.source}:${reference.ref}`, style: { ...ST.card, flexDirection: 'row', alignItems: 'center', gap: 8 } }, [
        h(ProbeImage, { key: 'img', urls, size: 36, label: reference.ref }),
        h('div', { key: 'm', style: { ...ST.col, gap: 1, minWidth: 0, flex: '1 1 auto' } }, [
          h('span', { key: 'ref', style: { ...ST.tiny, wordBreak: 'break-all' } }, reference.ref),
          h('span', { key: 'src', style: ST.tiny }, `${reference.source} · ${PACK_ASSET_KIND_LABELS[reference.kind] ?? reference.kind}${reference.assetId !== undefined ? ` · assetId ${reference.assetId}` : ''}`),
        ]),
      ]);
    });

    const missingRows = missing.map((target) =>
      h('button', {
        key: `${target.kind}:${target.id}`,
        type: 'button',
        title: `${target.source}（点击填入生成表单）`,
        style: { ...(genTargetId === `${target.kind}:${target.id}` ? ST.packItemOn : ST.packItem), padding: '4px 7px' },
        onClick: () => {
          setGenTargetId(`${target.kind}:${target.id}`);
          setPath('image');
        },
      }, [
        h('span', { key: 'n', style: { fontSize: 11 } }, `${PACK_ASSET_KIND_LABELS[target.kind] ?? target.kind} · ${target.name}`),
        h('span', { key: 's', style: { ...ST.tiny, opacity: 0.7, wordBreak: 'break-all' } }, target.id),
      ]),
    );

    const importPanel = h('div', { key: 'import', style: { ...ST.panel } }, [
      h(SectionTitle, { key: 't', text: '① 本地导入（PNG / SVG）', sub: '预览 → pack.assetPut（host 按 kind 归一到标准档 + 写 manifest）' }),
      h('div', { key: 'row', style: ST.row }, [
        h('button', { key: 'pick', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => fileRef.current?.click?.() }, '选择图片…'),
        h('input', {
          key: 'file', ref: fileRef, type: 'file', accept: '.png,.svg,image/png,image/svg+xml', style: { display: 'none' },
          onChange: (event: { target: { files?: ArrayLike<File>; value?: string } }) => {
            void onPickFile(event.target.files?.[0]);
            if (event.target.value !== undefined) event.target.value = '';
          },
        }),
        h('select', { key: 'kind', style: ST.select, value: kind, onChange: (event: { target: { value: string } }) => setKind(event.target.value as PackAssetKind) },
          (Object.keys(PACK_ASSET_KIND_LABELS) as PackAssetKind[]).map((entry) => h('option', { key: entry, value: entry }, `${PACK_ASSET_KIND_LABELS[entry]}（${entry}）`)),
        ),
        h('input', { key: 'id', style: ST.input, value: assetId, placeholder: 'assetId（如 item.workshop.hengdao）', onChange: (event: { target: { value: string } }) => setAssetId(event.target.value) }),
        h('button', { key: 'sug', type: 'button', style: ST.button, title: '按 kind 生成不冲突的 assetId', onClick: () => setAssetId(suggestedIdFor(selectedTarget, kind)) }, '自动 id'),
      ]),
      importError !== null ? h('span', { key: 'err', style: ST.bad }, importError) : null,
      importPreview !== null
        ? h('div', { key: 'prev', style: { ...ST.card, flexDirection: 'row', alignItems: 'flex-start', gap: 10 } }, [
            h('div', { key: 'img', style: { width: 96, height: 96, flex: '0 0 96px', borderRadius: 8, background: '#0b0d10', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' } }, h(B64Image, { b64: importPreview.b64, format: importPreview.format, alt: importPreview.fileName })),
            h('div', { key: 'meta', style: { ...ST.col, gap: 3 } }, [
              h('strong', { key: 'n', style: { fontSize: 11 } }, importPreview.fileName),
              h('span', { key: 's', style: ST.tiny }, `${importPreview.format.toUpperCase()} · ${formatBytes(importPreview.bytes)} · 目标 assetId ${assetId.trim() || '（自动）'}`),
              h('span', { key: 'h', style: ST.tiny }, '确认后落盘到 assets/ 并更新 assets/manifest.json；同 assetId 再传 = 替换（引用不断）。'),
              h('div', { key: 'actions', style: ST.row }, [
                h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => void saveImport() }, '确认落盘'),
                h('button', { key: 'cancel', type: 'button', style: ST.button, onClick: () => setImportPreview(null) }, '取消'),
              ]),
            ]),
          ])
        : null,
      builtin ? h('span', { key: 'ro', style: ST.warn }, '当前是内置包（只读）：pack.assetPut 会被 host 拒绝。先到「概览」点「复制为可编辑副本」，在副本里落盘图标。') : null,
    ]);

    const svgPanel = h('div', { key: 'svg', style: { ...ST.panel } }, [
      h(SectionTitle, { key: 't', text: '② AI 生成 SVG 图标', sub: 'assets.generate kind=icon style=svg（文本模型出 SVG → 白名单净化）→ 选择后 pack.assetPut' }),
      ...genControls(true),
    ]);

    const imagePanel = h('div', { key: 'image', style: { ...ST.panel } }, [
      h(SectionTitle, { key: 't', text: '③ AI 生图（pixel-32 / game-2d）', sub: '可单张，也可对物品库缺图标的物品一键批量；逐条预览确认后才落盘' }),
      ...genControls(false),
      h('div', { key: 'batch', style: { ...ST.card, gap: 6 } }, [
        h('div', { key: 'h', style: ST.row }, [
          h('strong', { key: 't', style: { fontSize: 11 } }, `批量：物品库缺图标 ${itemTargets.length} 个`),
          h('button', { key: 'run', type: 'button', style: ST.buttonPrimary, disabled: batchBusy || snapshot.writeBusy !== null || itemTargets.length === 0, onClick: () => void runBatch() }, batchBusy ? '批量生成中…' : `一键生成（前 ${Math.min(6, itemTargets.length)} 个）`),
          h('span', { key: 'hint', style: ST.tiny }, '队列并发 2；每条可单独重试/确认，失败条目不落盘。'),
        ]),
        ...batchRows.map((row: BatchRow) =>
          h('div', { key: row.key, style: { ...ST.card, gap: 4 } }, [
            h('div', { key: 'h', style: ST.row }, [
              h('span', { key: 'n', style: { fontSize: 11 } }, `${PACK_ASSET_KIND_LABELS[row.target.kind] ?? row.target.kind} · ${row.target.name}`),
              h(Tag, { key: 'st', text: row.status === 'generating' ? '生成中…' : row.status === 'failed' ? '失败' : '待确认', on: row.status === 'ready' }),
              row.status === 'failed' ? h('button', { key: 'retry', type: 'button', style: ST.button, onClick: () => void (async () => {
                setBatchRows((rows: BatchRow[]) => rows.map((entry) => (entry.key === row.key ? { ...entry, status: 'generating', error: null } : entry)));
                const result = await store.generate({ kind: 'icon', style: effectiveGenStyle, prompt: iconPromptFor(row.target, effectiveGenStyle), count: 1, subject: row.target.name });
                setBatchRows((rows: BatchRow[]) => rows.map((entry) => (entry.key === row.key ? { ...entry, status: result !== null && (result.candidates ?? []).length > 0 ? 'ready' : 'failed', candidates: result?.candidates ?? [], selected: 0 } : entry)));
              })() }, '重试') : null,
            ]),
            row.error !== null ? h('span', { key: 'e', style: ST.bad }, row.error) : null,
            row.candidates.length > 0
              ? h('div', { key: 'c', style: { ...ST.row, gap: 6, alignItems: 'flex-start' } }, [
                  h(B64Image, { key: 'img', b64: row.candidates[row.selected ?? 0]?.b64 ?? '', format: row.candidates[row.selected ?? 0]?.format ?? 'png', alt: row.target.name, style: { width: 56, height: 56, borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)' } }),
                  h('div', { key: 'meta', style: { ...ST.col, gap: 3, flex: '1 1 auto' } }, [
                    h('span', { key: 'm', style: ST.tiny }, `assetId：${suggestAssetId(row.target.kind, 'workshop', row.target.id)} · ${formatBytes(base64ByteSize(row.candidates[row.selected ?? 0]?.b64 ?? ''))}`),
                    h('div', { key: 'a', style: ST.row }, [
                      h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => void saveBatchRow(row) }, '确认落盘'),
                      h('button', { key: 'drop', type: 'button', style: ST.button, onClick: () => setBatchRows((rows: BatchRow[]) => rows.map((entry) => (entry.key === row.key ? { ...entry, candidates: [], selected: null, status: 'idle' } : entry))) }, '丢弃'),
                    ]),
                  ]),
                ])
              : null,
          ]),
        ),
      ]),
    ]);

    function genControls(svgOnly: boolean): VNode[] {
      return [
        h('div', { key: 'target', style: ST.row }, [
          h('span', { key: 'l', style: ST.tiny }, '目标（可选）'),
          h('select', {
            key: 'sel', style: { ...ST.select, flex: '1 1 200px', minWidth: 140 }, value: genTargetId,
            onChange: (event: { target: { value: string } }) => setGenTargetId(event.target.value),
          }, [h('option', { key: '', value: '' }, '自由提示词（不绑定目标）'), ...missing.map((target) => h('option', { key: `${target.kind}:${target.id}`, value: `${target.kind}:${target.id}` }, `${PACK_ASSET_KIND_LABELS[target.kind] ?? target.kind} · ${target.name}`))]),
          h('span', { key: 'kind', style: ST.tiny }, `kind`),
          h('select', { key: 'k', style: ST.select, value: kind, onChange: (event: { target: { value: string } }) => setKind(event.target.value as PackAssetKind) },
            (Object.keys(PACK_ASSET_KIND_LABELS) as PackAssetKind[]).map((entry) => h('option', { key: entry, value: entry }, PACK_ASSET_KIND_LABELS[entry])),
          ),
        ]),
        h('div', { key: 'prompt', style: ST.col }, [
          h('span', { key: 'l', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, svgOnly ? '提示词（给文本模型；要求简洁矢量、无文字）' : '提示词（给生图模型；构图/主体/颜色可写）'),
          h('textarea', { key: 'ta', style: ST.textarea, value: genPrompt, placeholder: '例如：一把东方长刀图标，直刃、金色护手、深色刀柄、透明背景', onChange: (event: { target: { value: string } }) => setGenPrompt(event.target.value) }),
        ]),
        h('div', { key: 'opts', style: ST.row }, [
          h('span', { key: 'l', style: ST.tiny }, '风格'),
          svgOnly
            ? h(Tag, { key: 's', text: 'AI SVG（style=svg）', on: true })
            : (['pixel-32', 'game-2d'] as Array<'pixel-32' | 'game-2d'>).map((style) =>
                h('button', { key: style, type: 'button', style: genStyle === style ? ST.buttonOn : ST.button, onClick: () => setGenStyle(style) }, style === 'pixel-32' ? '像素 32' : '2D 游戏'),
              ),
          h('span', { key: 'c', style: { ...ST.tiny, marginLeft: 8 } }, '候选数'),
          h('select', { key: 'n', style: ST.select, value: String(genCount), onChange: (event: { target: { value: string } }) => setGenCount(Number.parseInt(event.target.value, 10) || 1) },
            [1, 2, 3, 4].map((count) => h('option', { key: count, value: String(count) }, String(count))),
          ),
          h('input', { key: 'id', style: ST.input, value: assetId, placeholder: '落盘 assetId', onChange: (event: { target: { value: string } }) => setAssetId(event.target.value) }),
          h('button', { key: 'fire', type: 'button', style: ST.buttonPrimary, disabled: genBusy || snapshot.writeBusy !== null, onClick: () => void runGenerate() }, genBusy ? '生成中…' : '生成候选'),
        ]),
        genProvider !== null ? h('span', { key: 'p', style: ST.tiny }, `来源：${genProvider}`) : null,
        genCandidates.length > 0
          ? h('div', { key: 'cand', style: { ...ST.col, gap: 6 } }, [
              h('span', { key: 't', style: ST.tiny }, `候选（${genCandidates.length}）：点选一张，再确认落盘（其余丢弃，不写包）`),
              h('div', { key: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 } },
                genCandidates.map((candidate: AssetsGenerateCandidate, index: number) =>
                  h('button', {
                    key: index, type: 'button', title: `#${index + 1} ${candidate.width}×${candidate.height} ${candidate.format.toUpperCase()}`,
                    style: { ...(genSelected === index ? ST.buttonOn : ST.card), padding: 5, cursor: 'pointer', alignItems: 'center' },
                    onClick: () => setGenSelected(index),
                  }, [
                    h(B64Image, { key: 'i', b64: candidate.b64, format: candidate.format, alt: `候选 ${index + 1}`, style: { width: '100%', aspectRatio: '1 / 1', borderRadius: 6, background: '#0b0d10' } }),
                    h('span', { key: 'm', style: ST.tiny }, `#${index + 1} ${candidate.width}×${candidate.height} ${formatBytes(base64ByteSize(candidate.b64))}`),
                    h('span', { key: 'h', style: { ...ST.tiny, opacity: 0.7 } }, candidate.sha256.slice(0, 12)),
                  ]),
                ),
              ),
              genSelected !== null && genCandidates[genSelected] !== undefined
                ? h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => void saveCandidate(genCandidates[genSelected as number]) }, `确认落盘候选 #${(genSelected as number) + 1}（${assetId.trim() || suggestedIdFor(selectedTarget, kind, selectedTarget?.id ?? 'icon')}）`)
                : null,
            ])
          : null,
        snapshot.conn === null ? h('span', { key: 'notoken', style: ST.warn }, 'AI 生成需要 host 令牌：assets.generate 与工坊 RPC 同源，先解决上方「房主令牌」问题。') : null,
      ];
    }

    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'head', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `图标工作台 · ${pack.name}`, sub: '三条获取路径：本地导入 / AI 生成 SVG / AI 生图；落盘 = assets/ + manifest + 原子写' }),
        h('div', { key: 'stats', style: ST.row }, [
          h(Tag, { key: 'mani', text: `清单资产 ${manifest?.assets.length ?? 0}`, on: (manifest?.assets.length ?? 0) > 0 }),
          h(Tag, { key: 'ref', text: `pack.json 图标引用 ${references.length}` }),
          h(Tag, { key: 'miss', text: `未配图标 ${missing.length}`, on: missing.length > 0 }),
          h(Tag, { key: 'kind', text: '内部强制 128×128 / PNG·SVG' }),
          snapshot.manifestBusy ? h('span', { key: 'busy', style: ST.muted }, '正在读取资产清单…') : null,
          h('button', { key: 'reload', type: 'button', style: ST.button, disabled: snapshot.manifestBusy, onClick: () => void store.loadManifest(true) }, '重新读取清单'),
        ]),
        snapshot.manifestError !== null ? h('span', { key: 'me', style: ST.bad }, snapshot.manifestError) : null,
        snapshot.manifestNote !== null ? h('span', { key: 'mn', style: ST.tiny }, snapshot.manifestNote) : null,
      ]),
      h('div', { key: 'paths', style: ST.row }, [pathButton('import', '① 本地导入'), pathButton('svg', '② AI 生成 SVG'), pathButton('image', '③ AI 生图 / 批量')]),
      path === 'import' ? importPanel : path === 'svg' ? svgPanel : imagePanel,
      h('div', { key: 'list', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `资产清单（manifest：${manifest?.assets.length ?? 0}）`, sub: 'assetId / kind / 尺寸 / 大小 / sha256 前 8 位 / 预览（GET /trpg/assets/<packId>/<path>）' }),
        (manifest?.assets.length ?? 0) === 0
          ? h('span', { key: 'none', style: ST.muted }, manifest !== null ? '清单里还没有资产：先用上面任一入口落盘第一张。' : snapshot.manifestBusy ? '读取中…' : '尚无清单数据。')
          : h('div', { key: 'rows', style: ST.col }, manifestRows),
      ]),
      h('div', { key: 'refs', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `pack.json 的图标引用（${references.length}）`, sub: '引用值 / 字段位置 / 预览探测（清单 file 已知时直接预览，否则按 assetId 约定路径探测 png→svg）' }),
        references.length === 0
          ? h('span', { key: 'none', style: ST.muted }, '这个包没有挂载任何 icon 引用。')
          : h('div', { key: 'rows', style: ST.col }, referenceRows),
      ]),
      h('div', { key: 'missing', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: `未配图标的挂载点（${missing.length}）`, sub: '点一条 → 自动填入生成表单（建议 assetId / 提示词按目标预填）' }),
        missing.length === 0
          ? h('span', { key: 'none', style: ST.muted }, '没有缺图标的挂载点（或该包没有 rules 段）。')
          : h('div', { key: 'rows', style: { ...ST.threeCol, gap: 6 } }, missingRows),
      ]),
    ]);
  }

  // -------------------------------------------------------------------------
  // 地图工作室
  // -------------------------------------------------------------------------

  function BattlePreview(props: { result: MapGenerateResult; base: string }): VNode {
    const structure = props.result.structure;
    const cols = Math.max(1, structure.cols);
    const rows = Math.max(1, structure.rows);
    const cells: VNode[] = [];
    for (let y = 0; y < rows; y += 1) {
      const row = structure.terrain[y] ?? [];
      for (let x = 0; x < cols; x += 1) {
        const char = row[x] ?? '.';
        const terrainId = battleCharToTerrainId(char);
        const palette = TERRAIN_COLORS[terrainId] ?? { label: terrainId, color: 'rgba(120,120,120,.4)' };
        cells.push(h('div', { key: `${x}-${y}`, style: { ...ST.gridCell, left: `${(x * 100) / cols}%`, top: `${(y * 100) / rows}%`, width: `${100 / cols}%`, height: `${100 / rows}%`, background: palette.color, boxShadow: 'inset 0 0 0 .5px rgba(255,255,255,.08)' }, title: `${x},${y} · ${palette.label}（${char}）` }));
      }
    }
    const backgroundUrl = useObjectUrl(props.result.background?.b64, props.result.background !== null ? 'png' : undefined);
    return h('div', { style: ST.col }, [
      h('div', {
        key: 'canvas',
        style: {
          ...ST.preview,
          aspectRatio: `${cols} / ${rows}`,
          backgroundImage: backgroundUrl !== undefined ? `url(${backgroundUrl})` : 'radial-gradient(circle at 30% 20%, rgba(90,110,90,.45), rgba(14,16,20,.95) 70%)',
          backgroundSize: backgroundUrl !== undefined ? 'cover' : undefined,
          backgroundPosition: 'center',
        },
      }, [
        ...cells,
        ...structure.obstacles.map((obstacle, index) =>
          h('div', { key: `o-${index}`, style: { ...ST.gridCell, left: `${(obstacle.x * 100) / cols}%`, top: `${(obstacle.y * 100) / rows}%`, width: `${((obstacle.w ?? 1) * 100) / cols}%`, height: `${((obstacle.h ?? 1) * 100) / rows}%`, border: '1px dashed rgba(240,220,120,.9)', background: obstacle.terrain !== undefined ? (TERRAIN_COLORS[battleCharToTerrainId(obstacle.terrain)]?.color ?? 'rgba(200,180,100,.18)') : 'transparent', boxSizing: 'border-box' }, title: `障碍 ${obstacle.x},${obstacle.y} ${obstacle.w ?? 1}×${obstacle.h ?? 1}${obstacle.terrain !== undefined ? ` · ${battleCharToTerrainId(obstacle.terrain)}` : ''}` }),
        ),
        ...structure.spawns.map((spawn, index) =>
          h('span', {
            key: `s-${index}`,
            style: {
              ...ST.marker,
              left: `${((spawn.x + 0.5) * 100) / cols}%`,
              top: `${((spawn.y + 0.5) * 100) / rows}%`,
              background: spawn.side === 'player' ? '#6ee7a8' : spawn.side === 'enemy' ? '#f87171' : '#d1d5db',
            },
            title: `出生点 ${spawn.side} @${spawn.x},${spawn.y}${spawn.label !== undefined ? `（${spawn.label}）` : ''}`,
          }, spawn.side === 'player' ? 'P' : spawn.side === 'enemy' ? 'E' : 'N'),
        ),
      ]),
      h('div', { key: 'legend', style: { ...ST.row, gap: 8 } }, [
        ...Object.entries(TERRAIN_COLORS).map(([id, palette]) => h('span', { key: id, style: { ...ST.tiny, display: 'inline-flex', alignItems: 'center', gap: 3 } }, [h('span', { key: 'c', style: { width: 10, height: 10, borderRadius: 2, background: palette.color, border: '1px solid var(--dsw-alias-border-l2)' } }), palette.label])),
        h('span', { key: 'sp', style: ST.tiny }, 'P 玩家出生点 / E 敌方 / N 中立；虚线框 = 障碍'),
      ]),
    ]);
  }

  function WorldPreview(props: { result: WorldGenerateResult; base: string }): VNode {
    const zones = props.result.world.zones ?? [];
    const backgroundUrl = useObjectUrl(props.result.background?.b64, props.result.background !== null ? 'png' : undefined);
    const byId = new Map(zones.map((zone) => [zone.zoneId, zone]));
    const lines: VNode[] = [];
    for (const zone of zones) {
      for (const connection of zone.connections ?? []) {
        const target = byId.get(connection.to);
        if (target === undefined) continue;
        lines.push(h('line', {
          key: `${zone.zoneId}-${connection.to}`,
          x1: zone.hotspot.x * 100, y1: zone.hotspot.y * 100, x2: target.hotspot.x * 100, y2: target.hotspot.y * 100,
          stroke: connection.kind === 'river' ? '#5f9fd0' : connection.kind === 'stairs' ? '#b9a7d8' : '#d8c890',
          strokeWidth: 0.5, strokeDasharray: connection.kind === 'stairs' ? '1.4 1.4' : undefined, opacity: 0.8,
        }));
      }
    }
    return h('div', { style: ST.col }, [
      h('div', {
        key: 'canvas',
        style: {
          ...ST.preview,
          aspectRatio: '4 / 3',
          backgroundImage: backgroundUrl !== undefined ? `url(${backgroundUrl})` : 'radial-gradient(circle at 22% 18%, rgba(96,84,132,.55), rgba(12,14,20,.96) 68%)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        },
      }, [
        h('div', { key: 'grid', style: { position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px)', backgroundSize: '5% 6.7%' } }),
        h('svg', { key: 'conn', viewBox: '0 0 100 100', preserveAspectRatio: 'none', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } }, lines),
        ...zones.map((zone) =>
          h('div', {
            key: zone.zoneId,
            style: {
              position: 'absolute',
              left: `${(zone.hotspot.x - zone.hotspot.w / 2) * 100}%`,
              top: `${(zone.hotspot.y - zone.hotspot.h / 2) * 100}%`,
              width: `${zone.hotspot.w * 100}%`,
              height: `${zone.hotspot.h * 100}%`,
              border: '1px solid rgba(240,225,160,.9)',
              borderRadius: 6,
              background: 'rgba(10,12,16,.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: 2,
              boxSizing: 'border-box',
              overflow: 'hidden',
            },
            title: `${zone.name}（${zone.zoneId}）${zone.description !== undefined ? `：${zone.description}` : ''}`,
          }, h('span', { key: 'n', style: { fontSize: 9, color: '#f4ecd8', background: 'rgba(8,10,14,.6)', borderRadius: 4, padding: '0 4px', lineHeight: 1.5 } }, zone.name)),
        ),
      ]),
      h('span', { key: 'hint', style: ST.tiny }, `区域 ${zones.length}：热点框按生成结构的归一化 hotspot（x/y 中心 + w/h）；连线来自 connections（道路/河流/楼梯分色）。`),
    ]);
  }

  function MapsTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const pack = snapshot.detail as ContentPack;
    const builtin = store.isBuiltinPack(pack.packId);
    const [section, setSection] = useState('battle' as 'battle' | 'world');
    const [battleForm, setBattleForm] = useState({
      prompt: '鬼木崖洞口前的空地：乱石、枯树与一条浅溪，适合小队遭遇战；两侧有岩壁，中间留出通道',
      style: 'topdown-2d' as MapGenerateStyle,
      cols: '',
      rows: '',
      partySize: '3',
      seed: '',
      withBackground: false,
    });
    const [battleResult, setBattleResult] = useState(null as MapGenerateResult | null);
    const [battleGenBusy, setBattleGenBusy] = useState(false);
    const [battleSave, setBattleSave] = useState({ mapId: '', name: '', zoneId: '', saveBackground: true });
    const [worldForm, setWorldForm] = useState({
      prompt: '鬼木崖周边的山野：山道、溪谷、洞穴与废弃猎屋，适合 3–5 人探索',
      zoneCount: '5',
      seed: '',
      withBackground: false,
    });
    const [worldResult, setWorldResult] = useState(null as WorldGenerateResult | null);
    const [worldGenBusy, setWorldGenBusy] = useState(false);
    const [saveBusy, setSaveBusy] = useState(false);
    const space = pack.rules?.space;
    const zones = space?.zones ?? [];
    const battleMaps = space?.battleMaps ?? [];

    const runBattle = async (): Promise<void> => {
      if (battleGenBusy) return;
      if (battleForm.prompt.trim().length === 0) {
        store.setNotice({ tone: 'bad', text: '战斗地图 prompt 不能为空。', lines: [] });
        return;
      }
      setBattleGenBusy(true);
      try {
        const params = {
          prompt: battleForm.prompt.trim(),
          style: battleForm.style,
          ...(battleForm.cols.trim().length > 0 ? { cols: Number.parseInt(battleForm.cols, 10) } : {}),
          ...(battleForm.rows.trim().length > 0 ? { rows: Number.parseInt(battleForm.rows, 10) } : {}),
          ...(battleForm.partySize.trim().length > 0 ? { partySize: Number.parseInt(battleForm.partySize, 10) } : {}),
          ...(battleForm.seed.trim().length > 0 ? { seed: Number.parseInt(battleForm.seed, 10) } : {}),
          withBackground: battleForm.withBackground,
        };
        const result = await store.generateMap(params as never);
        if (result !== null) {
          setBattleResult(result);
          setBattleSave((current: { mapId: string; name: string; zoneId: string; saveBackground: boolean }) => ({ ...current, mapId: current.mapId.trim().length > 0 ? current.mapId : suggestMapId(pack, 'battle'), name: current.name.trim().length > 0 ? current.name : `${pack.name} 战斗地图` }));
        }
      } finally {
        setBattleGenBusy(false);
      }
    };

    const saveBattle = async (): Promise<void> => {
      if (battleResult === null || saveBusy) return;
      const mapId = battleSave.mapId.trim().length > 0 ? battleSave.mapId.trim() : suggestMapId(pack, 'battle');
      setSaveBusy(true);
      try {
        let backgroundAssetId: string | undefined;
        if (battleResult.background !== null && battleSave.saveBackground) {
          const assetId = uniqueAssetId(`cover.battle.${slugPart(mapId)}`, new Set((battleMaps.map((map) => `cover.battle.${slugPart(map.mapId)}`))));
          const put = await store.putAsset({ assetId, kind: 'cover', b64: battleResult.background.b64, meta: { style: 'ai-background', target: 'battle-map', prompt: battleForm.prompt } });
          if (put !== null) backgroundAssetId = put.assetId;
        } else if (battleResult.background !== null && !battleSave.saveBackground) {
          store.setNotice({ tone: 'info', text: '已生成 AI 底图但未勾选「同时保存底图」：本场只保存结构（底图丢弃）。', lines: [] });
        }
        const applied = applyBattleMap(pack, { structure: battleResult.structure, warnings: battleResult.warnings, method: battleResult.method, background: battleResult.background }, {
          mapId,
          ...(battleSave.name.trim().length > 0 ? { name: battleSave.name.trim() } : {}),
          ...(battleSave.zoneId.trim().length > 0 ? { zoneId: battleSave.zoneId.trim() } : {}),
          ...(backgroundAssetId !== undefined ? { backgroundAssetId } : {}),
        });
        const saved = await store.savePack(applied.pack, `战斗地图 ${mapId}`);
        if (saved !== null) {
          store.setNotice({ tone: 'ok', text: `战斗地图已保存到「${pack.packId}」：rules.space.battleMaps[] 新增/替换「${mapId}」`, lines: [...battleResult.warnings, ...applied.warnings] });
        }
      } finally {
        setSaveBusy(false);
      }
    };

    const runWorld = async (): Promise<void> => {
      if (worldGenBusy) return;
      if (worldForm.prompt.trim().length === 0) {
        store.setNotice({ tone: 'bad', text: '世界地图 prompt 不能为空。', lines: [] });
        return;
      }
      setWorldGenBusy(true);
      try {
        const params = {
          prompt: worldForm.prompt.trim(),
          ...(worldForm.zoneCount.trim().length > 0 ? { zoneCount: Number.parseInt(worldForm.zoneCount, 10) } : {}),
          ...(worldForm.seed.trim().length > 0 ? { seed: Number.parseInt(worldForm.seed, 10) } : {}),
          style: '2d-illustration' as const,
          withBackground: worldForm.withBackground,
        };
        const result = await store.generateWorld(params);
        if (result !== null) setWorldResult(result);
      } finally {
        setWorldGenBusy(false);
      }
    };

    const saveWorld = async (): Promise<void> => {
      if (worldResult === null || saveBusy) return;
      setSaveBusy(true);
      try {
        let backgroundAssetId: string | undefined;
        if (worldResult.background !== null && worldForm.withBackground) {
          const assetId = uniqueAssetId(`cover.world.${slugPart(pack.defaultModuleId ?? pack.packId)}`, new Set());
          const put = await store.putAsset({ assetId, kind: 'cover', b64: worldResult.background.b64, meta: { style: 'ai-background', target: 'world-map', prompt: worldForm.prompt } });
          if (put !== null) backgroundAssetId = put.assetId;
        }
        const applied = applyWorldMap(pack, { world: worldResult.world, warnings: worldResult.warnings, method: worldResult.method, background: worldResult.background }, {
          ...(backgroundAssetId !== undefined ? { backgroundAssetId } : {}),
        });
        const saved = await store.savePack(applied.pack, '世界地图');
        if (saved !== null) {
          store.setNotice({ tone: 'ok', text: `世界地图已保存到「${pack.packId}」：rules.space.world/zones 已更新（新增 ${worldResult.world.zones.length} 个生成区域）`, lines: [...worldResult.warnings, ...applied.warnings] });
        }
      } finally {
        setSaveBusy(false);
      }
    };

    const methodBadge = (method: 'ai' | 'procedural', warnings: string[]): VNode => h('div', { style: ST.row }, [
      h(Tag, { key: 'm', text: method === 'ai' ? 'AI 草稿（已过结构校验）' : '程序化兜底（AI 未配置）', on: method === 'ai' }),
      warnings.length > 0 ? h('span', { key: 'w', style: ST.tiny }, `warnings ${warnings.length}`) : null,
    ]);

    const sectionButton = (id: 'battle' | 'world', label: string): VNode =>
      h('button', { key: id, type: 'button', style: section === id ? ST.buttonOn : ST.button, onClick: () => setSection(id) }, label);

    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'head', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '地图工作室', sub: 'map.generate / world.generate → 结构预览 + 背景缩略图 → 写入 rules.space（pack.update）' }),
        h('div', { key: 'row', style: ST.row }, [
          sectionButton('battle', '战斗地图（战棋结构）'),
          sectionButton('world', '世界地图（区域热点）'),
          h(Tag, { key: 'maps', text: `本包战斗地图 ${battleMaps.length}` }),
          h(Tag, { key: 'zones', text: `本包区域 ${zones.length}` }),
          h(Tag, { key: 'model', text: `space ${space?.model ?? '无'}` }),
        ]),
        builtin ? h('span', { key: 'ro', style: ST.warn }, '当前是内置包（只读）：生成/预览可以看，但保存（pack.update / pack.assetPut）会被 host 拒绝；先「概览 → 复制为可编辑副本」。') : null,
        snapshot.conn === null ? h('span', { key: 'nt', style: ST.warn }, '地图生成需要房主令牌（loopback + host token）。') : null,
      ]),
      section === 'battle'
        ? h('div', { key: 'battle', style: { ...ST.col, gap: 10 } }, [
            h('div', { key: 'form', style: ST.panel }, [
              h(SectionTitle, { key: 't', text: '战斗地图生成', sub: '结构数据权威、底图只是皮肤；离线时程序化兜底仍可保存可玩' }),
              h('textarea', { key: 'prompt', style: ST.textarea, value: battleForm.prompt, placeholder: '这场战斗在哪、谁在场、地形如何（AI 只做草稿，结构仍过校验器）', onChange: (event: { target: { value: string } }) => setBattleForm({ ...battleForm, prompt: event.target.value }) }),
              h('div', { key: 'opts', style: ST.row }, [
                h('span', { key: 'sl', style: ST.tiny }, '风格'),
                h('select', { key: 'style', style: ST.select, value: battleForm.style, onChange: (event: { target: { value: string } }) => setBattleForm({ ...battleForm, style: event.target.value as MapGenerateStyle }) }, [
                  h('option', { key: 'topdown-2d', value: 'topdown-2d' }, '俯视 2D（topdown-2d）'),
                  h('option', { key: 'pixel-topdown', value: 'pixel-topdown' }, '像素俯视（pixel-topdown）'),
                ]),
                h('span', { key: 'cl', style: ST.tiny }, '列'),
                h('input', { key: 'cols', style: { ...ST.input, flex: '0 0 56px', minWidth: 44 }, value: battleForm.cols, placeholder: 'auto', onChange: (event: { target: { value: string } }) => setBattleForm({ ...battleForm, cols: event.target.value }) }),
                h('span', { key: 'rl', style: ST.tiny }, '行'),
                h('input', { key: 'rows', style: { ...ST.input, flex: '0 0 56px', minWidth: 44 }, value: battleForm.rows, placeholder: 'auto', onChange: (event: { target: { value: string } }) => setBattleForm({ ...battleForm, rows: event.target.value }) }),
                h('span', { key: 'pl', style: ST.tiny }, '队伍人数'),
                h('input', { key: 'party', style: { ...ST.input, flex: '0 0 48px', minWidth: 40 }, value: battleForm.partySize, onChange: (event: { target: { value: string } }) => setBattleForm({ ...battleForm, partySize: event.target.value }) }),
                h('span', { key: 'sd', style: ST.tiny }, 'seed'),
                h('input', { key: 'seed', style: { ...ST.input, flex: '0 0 84px', minWidth: 60 }, value: battleForm.seed, placeholder: '随机', onChange: (event: { target: { value: string } }) => setBattleForm({ ...battleForm, seed: event.target.value }) }),
                h('label', { key: 'bg', style: { ...ST.tiny, display: 'inline-flex', alignItems: 'center', gap: 4 } }, [
                  h('input', { key: 'cb', type: 'checkbox', checked: battleForm.withBackground, onChange: (event: { target: { checked: boolean } }) => setBattleForm({ ...battleForm, withBackground: event.target.checked }) }),
                  '同时生成 AI 底图（未配置 AI 时只进 warnings）',
                ]),
                h('button', { key: 'go', type: 'button', style: ST.buttonPrimary, disabled: battleGenBusy || snapshot.writeBusy !== null, onClick: () => void runBattle() }, battleGenBusy ? '生成中…' : '生成结构'),
              ]),
              h('span', { key: 'limit', style: ST.tiny }, '硬约束：≤32×32 格、出生点 ≤20、单侧 ≤8；地形字符按内置图例（g . r + t ~ w #）。'),
            ]),
            battleResult !== null
              ? h('div', { key: 'result', style: ST.panel }, [
                  h(SectionTitle, { key: 't', text: `生成结果：${battleResult.structure.cols}×${battleResult.structure.rows}`, sub: `${battleResult.structure.spawns.length} 出生点 / ${battleResult.structure.obstacles.length} 障碍` }),
                  methodBadge(battleResult.method, battleResult.warnings),
                  h('div', { key: 'preview', style: ST.twoCol }, [
                    h('div', { key: 'left', style: ST.col }, [
                      h(BattlePreview, { key: 'grid', result: battleResult, base: snapshot.base }),
                      battleResult.background !== null
                        ? h('div', { key: 'bg', style: { ...ST.card, flexDirection: 'row', alignItems: 'center', gap: 8 } }, [
                            h('div', { key: 'i', style: { width: 96, height: 72, flex: '0 0 96px', borderRadius: 7, overflow: 'hidden', background: '#0b0d10' } }, h(B64Image, { b64: battleResult.background.b64, format: 'png', alt: 'AI 底图缩略图' })),
                            h('div', { key: 'm', style: ST.col }, [
                              h('strong', { key: 't', style: { fontSize: 11 } }, 'AI 底图（已归一化 1024×768）'),
                              h('span', { key: 's', style: ST.tiny }, `${battleResult.background.width}×${battleResult.background.height} · sha ${battleResult.background.sha256.slice(0, 8)}`),
                            ]),
                          ])
                        : h('span', { key: 'bgnone', style: ST.tiny }, '没有 AI 底图：结构预览即最终权威（离线程序兜底）。'),
                    ]),
                    h('div', { key: 'right', style: ST.col }, [
                      h('div', { key: 'saveCard', style: ST.card }, [
                        h(SectionTitle, { key: 't', text: '保存到当前模组', sub: '写入 rules.space.battleMaps（新 mapId）' }),
                        h(JsonFold, { key: 'json', label: '结构原 JSON（terrain/obstacles/spawns）', value: battleResult.structure }),
                        h('div', { key: 'row1', style: ST.row }, [
                          h('span', { key: 'l', style: ST.tiny }, 'mapId'),
                          h('input', { key: 'id', style: ST.input, value: battleSave.mapId, placeholder: '如 battle-1', onChange: (event: { target: { value: string } }) => setBattleSave({ ...battleSave, mapId: event.target.value }) }),
                        ]),
                        h('div', { key: 'row2', style: ST.row }, [
                          h('span', { key: 'l', style: ST.tiny }, '名称'),
                          h('input', { key: 'n', style: ST.input, value: battleSave.name, placeholder: '如 鬼木崖洞口', onChange: (event: { target: { value: string } }) => setBattleSave({ ...battleSave, name: event.target.value }) }),
                        ]),
                        h('div', { key: 'row3', style: ST.row }, [
                          h('span', { key: 'l', style: ST.tiny }, '绑定区域（可选）'),
                          h('select', { key: 'z', style: { ...ST.select, flex: '1 1 160px' }, value: battleSave.zoneId, onChange: (event: { target: { value: string } }) => setBattleSave({ ...battleSave, zoneId: event.target.value }) }, [h('option', { key: '', value: '' }, '不绑定（zoneId 留空）'), ...zones.map((zone) => h('option', { key: zone.zoneId, value: zone.zoneId }, `${zone.name}（${zone.zoneId}）`))]),
                          battleResult.background !== null
                            ? h('label', { key: 'bg', style: { ...ST.tiny, display: 'inline-flex', alignItems: 'center', gap: 4 } }, [
                                h('input', { key: 'c', type: 'checkbox', checked: battleSave.saveBackground, onChange: (event: { target: { checked: boolean } }) => setBattleSave({ ...battleSave, saveBackground: event.target.checked }) }),
                                '同时保存底图（pack.assetPut kind=cover target=battle-map）',
                              ])
                            : null,
                        ]),
                        h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: saveBusy || snapshot.writeBusy !== null, onClick: () => void saveBattle() }, saveBusy ? '保存中…' : '保存到 rules.space.battleMaps'),
                        builtin ? h('span', { key: 'ro', style: ST.warn }, '内置包只读：保存会被拒绝，先复制为可编辑副本。') : null,
                      ]),
                      battleResult.warnings.length > 0
                        ? h('div', { key: 'warn', style: ST.hint }, battleResult.warnings.map((warning: string, index: number) => h('span', { key: index, style: ST.warn }, `• ${warning}`)))
                        : null,
                    ]),
                  ]),
                ])
              : h('div', { key: 'empty', style: ST.hint }, [h('span', { key: 't', style: ST.muted }, '还没有生成结果：填好 prompt 点「生成结构」。无 AI 时走程序化兜底（method=procedural），结构与预览仍可保存。')]),
          ])
        : null,
      section === 'world'
        ? h('div', { key: 'world', style: { ...ST.col, gap: 10 } }, [
            h('div', { key: 'form', style: ST.panel }, [
              h(SectionTitle, { key: 't', text: '世界地图生成', sub: '区域热点 + 连线；底图可选（2D 插画风 2048×1536）' }),
              h('textarea', { key: 'prompt', style: ST.textarea, value: worldForm.prompt, onChange: (event: { target: { value: string } }) => setWorldForm({ ...worldForm, prompt: event.target.value }) }),
              h('div', { key: 'opts', style: ST.row }, [
                h('span', { key: 'zl', style: ST.tiny }, '区域数（3–8）'),
                h('input', { key: 'z', style: { ...ST.input, flex: '0 0 52px', minWidth: 44 }, value: worldForm.zoneCount, onChange: (event: { target: { value: string } }) => setWorldForm({ ...worldForm, zoneCount: event.target.value }) }),
                h('span', { key: 'sd', style: ST.tiny }, 'seed'),
                h('input', { key: 'seed', style: { ...ST.input, flex: '0 0 84px', minWidth: 60 }, value: worldForm.seed, placeholder: '随机', onChange: (event: { target: { value: string } }) => setWorldForm({ ...worldForm, seed: event.target.value }) }),
                h('label', { key: 'bg', style: { ...ST.tiny, display: 'inline-flex', alignItems: 'center', gap: 4 } }, [
                  h('input', { key: 'c', type: 'checkbox', checked: worldForm.withBackground, onChange: (event: { target: { checked: boolean } }) => setWorldForm({ ...worldForm, withBackground: event.target.checked }) }),
                  '同时生成 AI 底图（2048×1536 插画）',
                ]),
                h('button', { key: 'go', type: 'button', style: ST.buttonPrimary, disabled: worldGenBusy || snapshot.writeBusy !== null, onClick: () => void runWorld() }, worldGenBusy ? '生成中…' : '生成世界结构'),
              ]),
            ]),
            worldResult !== null
              ? h('div', { key: 'result', style: ST.panel }, [
                  h(SectionTitle, { key: 't', text: `生成结果：${worldResult.world.zones.length} 个区域`, sub: worldResult.world.zones.map((zone: { name: string }) => zone.name).join('、') }),
                  methodBadge(worldResult.method, worldResult.warnings),
                  h('div', { key: 'preview', style: ST.twoCol }, [
                    h('div', { key: 'l', style: ST.col }, [
                      h(WorldPreview, { key: 'w', result: worldResult, base: snapshot.base }),
                      worldResult.background !== null
                        ? h('div', { key: 'bg', style: { ...ST.card, flexDirection: 'row', alignItems: 'center', gap: 8 } }, [
                            h('div', { key: 'i', style: { width: 120, height: 90, flex: '0 0 120px', borderRadius: 7, overflow: 'hidden', background: '#0b0d10' } }, h(B64Image, { b64: worldResult.background.b64, format: 'png', alt: '世界地图底图缩略图' })),
                            h('div', { key: 'm', style: ST.col }, [
                              h('strong', { key: 't', style: { fontSize: 11 } }, 'AI 世界底图（已归一化 2048×1536）'),
                              h('span', { key: 's', style: ST.tiny }, `sha ${worldResult.background.sha256.slice(0, 8)}`),
                            ]),
                          ])
                        : h('span', { key: 'none', style: ST.tiny }, '没有 AI 底图：世界页会回退程序化底图；结构（区域/热点/连线）已可保存。'),
                    ]),
                    h('div', { key: 'r', style: ST.col }, [
                      h('div', { key: 'save', style: ST.card }, [
                        h(SectionTitle, { key: 't', text: '保存到当前模组', sub: '写入 rules.space.world + rules.space.zones' }),
                        h(JsonFold, { key: 'json', label: '世界结构原 JSON（zones/hotspot/connections）', value: worldResult.world }),
                        h('span', { key: 'zones', style: ST.tiny }, `本包已有区域 ${zones.length} 个；保存时按 zoneId 追加/替换，不删除作者已有区域。`),
                        h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: saveBusy || snapshot.writeBusy !== null, onClick: () => void saveWorld() }, saveBusy ? '保存中…' : '保存到 rules.space.zones'),
                        builtin ? h('span', { key: 'ro', style: ST.warn }, '内置包只读：保存会被拒绝，先复制为可编辑副本。') : null,
                      ]),
                      worldResult.warnings.length > 0
                        ? h('div', { key: 'warn', style: ST.hint }, worldResult.warnings.map((warning: string, index: number) => h('span', { key: index, style: ST.warn }, `• ${warning}`)))
                        : null,
                    ]),
                  ]),
                ])
              : h('div', { key: 'empty', style: ST.hint }, [h('span', { key: 'muted', style: ST.muted }, '还没有生成结果：世界结构由 AI 草稿 + 校验（或程序化兜底）产出；热点框会叠在底图上预览。')]),
          ])
        : null,
    ]);
  }

  function slugPart(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'map';
  }

  // -------------------------------------------------------------------------
  // 分享
  // -------------------------------------------------------------------------

  function ShareTab(props: { snapshot: WorkshopSnapshot }): VNode {
    const { snapshot } = props;
    const pack = snapshot.detail as ContentPack;
    const [strategy, setStrategy] = useState('reject' as PackImportStrategy);
    const [lastFileName, setLastFileName] = useState(null as string | null);
    const fileRef = useRef(null as { click?: () => void; value?: string } | null);
    const exported = snapshot.exported;
    const onImport = async (file: File | undefined): Promise<void> => {
      if (file === undefined) return;
      setLastFileName(file.name);
      try {
        const b64 = await fileToBase64(file);
        await store.importPack(b64, file.name, strategy);
      } catch (error) {
        store.setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error), lines: [] });
      }
    };
    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'exp', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '导出内容包', sub: 'pack.export → 浏览器下载 `<packId>-<version>.trpgpack`' }),
        h('div', { key: 'row', style: ST.row }, [
          h('button', { key: 'go', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => void store.exportCurrent() }, '导出并下载 .trpgpack'),
          exported !== null ? h('span', { key: 'f', style: ST.ok }, `最近下载：${exported.fileName}（${formatBytes(exported.bytes)}）`) : h('span', { key: 'n', style: ST.muted }, '尚未导出。'),
        ]),
        exported !== null ? h('span', { key: 'h', style: { ...ST.tiny, wordBreak: 'break-all' } }, `packHash：${exported.packHash}`) : null,
        h('span', { key: 'hint', style: ST.tiny }, '内置包导出 = 现场编码（可复现）；数据目录包导出 = 原始 zip 字节（packHash 与安装一致）。'),
      ]),
      h('div', { key: 'imp', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '导入内容包', sub: 'pack.import：同 id 冲突策略 reject / overwrite / rename' }),
        h('div', { key: 'row', style: ST.row }, [
          h('span', { key: 'l', style: ST.tiny }, '冲突策略'),
          h('select', { key: 's', style: ST.select, value: strategy, onChange: (event: { target: { value: string } }) => setStrategy(event.target.value as PackImportStrategy) }, [
            h('option', { key: 'reject', value: 'reject' }, 'reject：拒绝（已安装则报错）'),
            h('option', { key: 'overwrite', value: 'overwrite' }, 'overwrite：覆盖数据目录包（内置包不可覆盖）'),
            h('option', { key: 'rename', value: 'rename' }, 'rename：另存副本（新 packId 后缀 -copy-N）'),
          ]),
          h('button', { key: 'pick', type: 'button', style: ST.buttonPrimary, disabled: snapshot.writeBusy !== null, onClick: () => fileRef.current?.click?.() }, '选择 .trpgpack…'),
          h('input', {
            key: 'file', ref: fileRef, type: 'file', accept: '.trpgpack,application/zip', style: { display: 'none' },
            onChange: (event: { target: { files?: ArrayLike<File>; value?: string } }) => {
              void onImport(event.target.files?.[0]);
              if (event.target.value !== undefined) event.target.value = '';
            },
          }),
          lastFileName !== null ? h('span', { key: 'fn', style: ST.tiny }, `文件：${lastFileName}`) : null,
        ]),
        h('span', { key: 'hint', style: ST.tiny }, '导入成功后自动重扫内容包目录并选中新包；host 会先 trpgpackToPack → migrate → validatePack 全量校验，坏包不落盘。'),
      ]),
      h('div', { key: 'copy', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '复制为可编辑副本', sub: '内置包只读：导出后用 rename 导入成数据目录包，再编辑图标/地图' }),
        h('div', { key: 'row', style: ST.row }, [
          h('button', { key: 'go', type: 'button', style: ST.button, disabled: snapshot.writeBusy !== null, onClick: () => void store.duplicateCurrent() }, `复制「${pack.packId}」为数据包`),
          store.isBuiltinPack(pack.packId) ? h('span', { key: 't', style: ST.warn }, '当前是内置包：pack.update / pack.assetPut / pack.assetDelete 会被 host 拒绝。') : h('span', { key: 't', style: ST.muted }, '当前是数据目录包：可直接编辑并 pack.update 写回。'),
        ]),
      ]),
      h('div', { key: 'warn', style: ST.panel }, [
        h(SectionTitle, { key: 't', text: '最近一次写回警告（host 校验口径）' }),
        snapshot.lastWarnings.length === 0
          ? h('span', { key: 'n', style: ST.muted }, '无（或还没写过）。')
          : h('div', { key: 'l', style: ST.col }, snapshot.lastWarnings.map((warning: string, index: number) => h('span', { key: index, style: ST.warn }, `• ${warning}`))),
        h('span', { key: 'delta', style: { ...ST.tiny, marginTop: 4 } }, `host：${WORKSHOP_DEFAULT_BASE_HINT}（右栏跑团桌会话的 base/hostToken）`),
      ]),
    ]);
  }

  return {
    WorkshopMainPanel: (props) => h(WorkshopBoundary, null, h(WorkshopMainPanel, props)),
  };

  /** 顶层错误边界：任何渲染异常都降级成中文提示，不白屏整个主区域。 */
  function WorkshopBoundary(props: { children?: VNode }): VNode {
    const [error, setError] = useState(null as string | null);
    useEffect(() => {
      const onError = (event: { error?: unknown; message?: string }): void => {
        setError(event.error instanceof Error ? event.error.message : String(event.message ?? '未知错误'));
      };
      globalThis.addEventListener?.('error', onError as never);
      return () => globalThis.removeEventListener?.('error', onError as never);
    }, []);
    if (error !== null) {
      return h('div', { style: { ...ST.page, padding: 16 } }, [
        h('strong', { key: 't', style: { fontSize: 13 } }, '内容工坊渲染出错（已隔离，不影响聊天与右栏）'),
        h('span', { key: 'e', style: ST.bad }, error),
        h('button', { key: 'r', type: 'button', style: { ...ST.button, alignSelf: 'flex-start' }, onClick: () => setError(null) }, '重试渲染'),
      ]);
    }
    return props.children;
  }
}
