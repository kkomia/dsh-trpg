/**
 * M9.5d 玩家角色资产的渲染层（头像/立绘/变体/帧表 + 三来源资产对话框）。
 *
 * 约束：
 * - 真图一律用 `<img>`（或 CSS background）渲染，**不 inline SVG**，避免 SVG 内脚本进入 DOM；
 * - 无真图时由调用方传进来程序化徽记（`fallback`），保持 M9.4 的降级体验；
 * - 二进制只在 IndexedDB；这里把 base64 转 blob URL 预览，卸载时 revoke；
 * - 不改聊天区：本文件只服务右栏紧凑卡与主区域详细页。
 */
import type { AssetsGenerateCandidate } from '@dsh-trpg/protocol';
import type { AssetDialogState, AssetSnapshot, AssetStore } from './assets-store.ts';
import { DEFAULT_VARIANTS, targetSizeOf } from './assets-store.ts';
import {
  base64ToBytes,
  formatBytes,
  KIND_LABELS,
  LOCAL_ASSET_BYTE_LIMITS,
  resolveAssetUrl,
  spriteFirstFrameStyle,
  STYLE_LABELS,
  VARIANT_PRESETS,
  type CardAssetKind,
  type CardAssetRecord,
  type PlayerGenStyle,
  type SpriteSheetView,
} from './assets.ts';

type H = (...args: any[]) => any;
type VNode = unknown;

/** 卡面媒体投影的可选子集（与协议 `SheetIdentityMediaView` 同口径；本地类型避免耦合）。 */
export interface IdentityMedia {
  avatarUrl?: string;
  portraitUrl?: string;
  portraitVariants?: Array<{ variant: string; url: string }>;
  spriteSheet?: SpriteSheetView;
}

export interface AssetsUi {
  AssetsDialog: (props: { store: AssetStore }) => VNode;
  SheetAvatar: (props: { store: AssetStore; base?: string; identity: IdentityMedia; name: string; size: number; fallback: VNode }) => VNode;
  SheetPortrait: (props: { store: AssetStore; base?: string; identity: IdentityMedia; name: string; fallback: VNode }) => VNode;
  SheetAssetPanel: (props: {
    store: AssetStore;
    identity: IdentityMedia;
    canEdit: boolean;
    compact?: boolean;
    onOpenMain?: (view: 'sheet') => void;
  }) => VNode;
  SheetSpriteThumb: (props: { store: AssetStore; base?: string; identity: IdentityMedia }) => VNode;
  AssetThumb: (props: { src?: string; name: string; size: number; round?: boolean; fallback: VNode }) => VNode;
  AssetNotice: (props: { store: AssetStore }) => VNode;
  /** 订阅资产快照（rules-ui 里做「未落座本地资产页」用）。 */
  useAssetSnapshot: (store: AssetStore) => AssetSnapshot;
}

// ---------------------------------------------------------------------------
// 样式（右栏 320–420px 单列 + 主区域；全部走主题 token）
// ---------------------------------------------------------------------------

const ST: Record<string, Record<string, unknown>> = {
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
  col: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  tiny: { fontSize: 10, minWidth: 0, color: 'var(--dsw-alias-label-secondary)' },
  small: { fontSize: 11, minWidth: 0 },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
  bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  warn: { color: 'var(--dsw-alias-state-warning-primary)', fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 10 },
  button: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '3px 8px',
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
    padding: '3px 8px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent)',
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
    padding: '4px 10px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-bg-base)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonDisabled: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '3px 8px',
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
    boxSizing: 'border-box',
    width: '100%',
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
    minHeight: 64,
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
    padding: '3px 6px',
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
  card: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    padding: 6,
    background: 'var(--dsw-alias-bg-layer-1)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
};

// ---------------------------------------------------------------------------
// React 工厂
// ---------------------------------------------------------------------------

export function createAssetsUi(React: any): AssetsUi {
  const h: H = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;

  function useSnapshot(store: AssetStore): AssetSnapshot {
    const [snapshot, setSnapshot] = useState(() => store.getSnapshot() as AssetSnapshot);
    useEffect(() => {
      const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
      setSnapshot(store.getSnapshot());
      return unsubscribe;
    }, [store]);
    return snapshot as AssetSnapshot;
  }

  /** base64 图片 → blob URL（卸载/替换时 revoke）；格式非法返回 undefined。 */
  function useObjectUrl(b64: string | undefined, format: 'png' | 'svg' | undefined): string | undefined {
    const [url, setUrl] = useState(undefined as string | undefined);
    useEffect(() => {
      if (typeof b64 !== 'string' || b64.length === 0 || format === undefined) {
        setUrl(undefined);
        return undefined;
      }
      let created: string | undefined;
      try {
        const bytes = base64ToBytes(b64);
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        const blob = new Blob([copy.buffer as ArrayBuffer], { type: format === 'svg' ? 'image/svg+xml' : 'image/png' });
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

  /** 本地资产记录 → 可渲染 URL。 */
  function useLocalAssetUrl(record: CardAssetRecord | undefined): string | undefined {
    return useObjectUrl(record?.bytes, record?.format);
  }

  /** 真图（`<img>`）渲染；加载失败回退调用方的徽记。 */
  function AssetThumb(props: { src?: string; name: string; size: number; round?: boolean; fallback: VNode }): VNode {
    const [failed, setFailed] = useState(false);
    const src = props.src;
    useEffect(() => {
      setFailed(false);
    }, [src]);
    if (typeof src !== 'string' || src.length === 0 || failed) return props.fallback;
    return h('img', {
      src,
      alt: props.name,
      title: props.name,
      width: props.size,
      height: props.size,
      loading: 'lazy',
      style: {
        width: props.size,
        height: props.size,
        flex: '0 0 auto',
        objectFit: 'cover',
        borderRadius: props.round === true ? 999 : 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      onError: () => setFailed(true),
    });
  }

  /**
   * 头像：host 投影优先（房间可见），否则本地私卡资产；都没有回退程序化徽记。
   * 本地有「待同步」的更新时优先本地（玩家自己即时看到改动）。
   */
  function SheetAvatar(props: {
    store: AssetStore;
    base?: string;
    identity: IdentityMedia;
    name: string;
    size: number;
    fallback: VNode;
  }): VNode {
    const snapshot = useSnapshot(props.store);
    const hostUrl = resolveAssetUrl(props.base, props.identity.avatarUrl);
    const local = props.store.assetOf('avatar');
    const localUrl = useLocalAssetUrl(local);
    const url = snapshot.pendingSync > 0 && localUrl !== undefined ? localUrl : hostUrl ?? localUrl;
    return h(AssetThumb, { src: url, name: props.name, size: props.size, round: true, fallback: props.fallback });
  }

  /** 3:4 立绘框：表情变体按 `selectedVariant` 切换；无图回退徽记。 */
  function SheetPortrait(props: {
    store: AssetStore;
    base?: string;
    identity: IdentityMedia;
    name: string;
    fallback: VNode;
  }): VNode {
    const snapshot = useSnapshot(props.store);
    const variant = snapshot.selectedVariant;
    const variants = props.identity.portraitVariants ?? [];
    const hostUrl = resolveAssetUrl(props.base, variants.find((entry) => entry.variant === variant)?.url ?? props.identity.portraitUrl);
    const local = props.store.assetOf('portraitVariant', variant ?? undefined);
    const localUrl = useLocalAssetUrl(local);
    const url = snapshot.pendingSync > 0 && localUrl !== undefined ? localUrl : hostUrl ?? localUrl;
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      setFailed(false);
    }, [url]);
    const source = hostUrl !== undefined ? (snapshot.pendingSync > 0 && localUrl !== undefined ? '本地（未同步）' : 'host 房间资产') : localUrl !== undefined ? '本地私卡' : '程序化徽记';
    return h(
      'div',
      {
        style: {
          position: 'relative',
          width: '100%',
          maxWidth: 300,
          aspectRatio: '3 / 4',
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'radial-gradient(circle at 30% 20%, rgba(120,110,200,.35), rgba(20,22,30,.9) 70%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '0 0 auto',
        },
      },
      [
        typeof url === 'string' && !failed
          ? h('img', {
              key: 'img',
              src: url,
              alt: props.name,
              style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
              onError: () => setFailed(true),
            })
          : h('div', { key: 'badge', style: { transform: 'scale(2.1)', opacity: 0.92 } }, props.fallback),
        h(
          'span',
          {
            key: 'src',
            style: {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              padding: '2px 6px',
              fontSize: 9,
              color: 'rgba(255,255,255,.78)',
              background: 'linear-gradient(transparent, rgba(0,0,0,.55))',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 6,
            },
          },
          [
            h('span', { key: 's' }, source),
            variant !== null ? h('span', { key: 'v' }, `变体 ${variant}`) : null,
          ],
        ),
      ],
    );
  }

  /** 表情变体 chips（默认 + 已配置/本地已有的变体）。 */
  function VariantChips(props: { store: AssetStore; identity: IdentityMedia; compact?: boolean }): VNode {
    const snapshot = useSnapshot(props.store);
    const available = useMemo(() => {
      const names: string[] = [...VARIANT_PRESETS];
      for (const entry of props.identity.portraitVariants ?? []) if (!names.includes(entry.variant)) names.push(entry.variant);
      for (const asset of snapshot.assets) if (asset.kind === 'portraitVariant' && asset.variant !== undefined && !names.includes(asset.variant)) names.push(asset.variant);
      return names;
    }, [props.identity.portraitVariants, snapshot.assets]);
    if (available.length === 0) return null;
    const selected = snapshot.selectedVariant;
    return h('div', { style: { ...ST.row, gap: 4 } }, [
      h(
        'button',
        {
          key: 'default',
          type: 'button',
          style: { ...(selected === null ? ST.buttonOn : ST.button), padding: '1px 6px', fontSize: 10 },
          title: '默认立绘',
          onClick: () => props.store.setSelectedVariant(null),
        },
        '默认',
      ),
      ...available.map((variant: string) =>
        h(
          'button',
          {
            key: variant,
            type: 'button',
            style: { ...(selected === variant ? ST.buttonOn : ST.button), padding: '1px 6px', fontSize: 10 },
            title: `表情变体：${variant}`,
            onClick: () => props.store.setSelectedVariant(selected === variant ? null : variant),
          },
          variant,
        ),
      ),
    ]);
  }

  /** 帧表缩略（v1 只显示第一帧，不做动画）。 */
  function SheetSpriteThumb(props: { store: AssetStore; base?: string; identity: IdentityMedia }): VNode {
    const snapshot = useSnapshot(props.store);
    const local = props.store.assetOf('spriteSheet');
    const host = props.identity.spriteSheet;
    const style = host !== undefined
      ? spriteFirstFrameStyle(host, 48, props.base)
      : local !== undefined
        ? spriteFirstFrameStyle(
            { url: 'local', rows: local.meta?.rows ?? 4, cols: local.meta?.cols ?? 4, frameSize: local.meta?.frameSize ?? 128 },
            48,
          )
        : null;
    if (style === null && local === undefined && host === undefined) return null;
    const rows = host?.rows ?? local?.meta?.rows ?? 4;
    const cols = host?.cols ?? local?.meta?.cols ?? 4;
    if (style === null) {
      return h('span', { style: ST.tiny }, `帧表 ${rows}×${cols}（本地已存）`);
    }
    return h('div', { style: { ...ST.col, gap: 2 }, title: `帧表 ${rows}×${cols}：v1 只显示第一帧（不做动画）` }, [
      h('span', { style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, '帧表·首帧'),
      h('span', { style: style }),
      h('span', { style: ST.tiny }, `${rows}×${cols} 格`),
    ]);
  }

  /** 人物页资产操作条：换头像/换立绘/表情变体/帧表 + 同步到房间。 */
  function SheetAssetPanel(props: {
    store: AssetStore;
    identity: IdentityMedia;
    canEdit: boolean;
    compact?: boolean;
    onOpenMain?: (view: 'sheet') => void;
  }): VNode {
    const snapshot = useSnapshot(props.store);
    const [uploadHint, setUploadHint] = useState(null as string | null);
    const open = (kind: CardAssetKind): void => {
      props.onOpenMain?.('sheet');
      props.store.openDialog(kind, kind === 'portraitVariant' ? { variant: snapshot.selectedVariant ?? 'smile' } : undefined);
    };
    if (!props.canEdit) {
      return h('div', { style: { ...ST.col, gap: 3 } }, [
        h('span', { style: ST.muted }, '这是队友/其他角色的卡面：头像与立绘来自 host 房间资产；只有本人能改自己的本地资产。'),
      ]);
    }
    const hasAny = snapshot.assets.length > 0;
    return h('div', { style: { ...ST.col, gap: 4 } }, [
      h('div', { style: ST.row }, [
        h('button', { key: 'avatar', type: 'button', style: ST.button, onClick: () => open('avatar'), title: '本地导入 / AI 生成 / 自备接口' }, '换头像…'),
        h('button', { key: 'portrait', type: 'button', style: ST.button, onClick: () => open('portrait') }, '换立绘…'),
        h('button', { key: 'variant', type: 'button', style: ST.button, onClick: () => open('portraitVariant') }, '表情变体…'),
        h('button', { key: 'sprite', type: 'button', style: ST.button, onClick: () => open('spriteSheet') }, '帧表…'),
        hasAny
          ? h(
              'button',
              {
                key: 'delete',
                type: 'button',
                style: { ...ST.button, color: 'var(--dsw-alias-state-error-primary)' },
                title: '清空本地展示资产（不影响已经在房间里的旧引用）',
                onClick: () => {
                  for (const asset of snapshot.assets) void props.store.removeAsset(asset.assetId);
                },
              },
              '清空本地',
            )
          : null,
      ]),
      h(VariantChips, { store: props.store, identity: props.identity }),
      snapshot.pendingSync > 0
        ? h('div', { key: 'sync', style: ST.row }, [
            h('span', { style: ST.warn }, `本地有 ${snapshot.pendingSync} 个展示资产还没同步到房间`),
            h(
              'button',
              {
                key: 'go',
                type: 'button',
                style: { ...ST.buttonPrimary, padding: '2px 8px' },
                disabled: snapshot.resyncing || snapshot.uploading,
                title: '重新落座：先把本地展示资产传到 host，再提交引用',
                onClick: () => {
                  void props.store.requestResync().then(() => {
                    const snap = props.store.getSnapshot();
                    setUploadHint(snap.lastUpload !== null && snap.lastUpload.refs > 0 ? `已同步 ${snap.lastUpload.refs} 个资产到房间` : null);
                  });
                },
              },
              snapshot.resyncing ? '同步中…' : '同步到房间',
            ),
          ])
        : snapshot.lastUpload !== null && snapshot.lastUpload.refs > 0
          ? h('span', { key: 'synced', style: ST.ok }, `已上传 ${snapshot.lastUpload.refs} 个展示资产到房间（重连/重登不重复上传）`)
          : null,
      uploadHint !== null ? h('span', { key: 'hint', style: ST.ok }, uploadHint) : null,
      h(AssetNotice, { store: props.store }),
      props.compact === true ? null : h('span', { style: ST.tiny }, '资产只存本机 IndexedDB；落座时只上传头像/立绘/表情变体/帧表（≤8 个、≤8 MiB），外貌/性格等私密字段不会上传。'),
    ]);
  }

  /** 资产提示条（成功/失败/说明；可关闭）。 */
  function AssetNotice(props: { store: AssetStore }): VNode {
    const snapshot = useSnapshot(props.store);
    if (snapshot.notice === null && snapshot.error === null) return null;
    const notice = snapshot.notice;
    return h('div', { style: { ...ST.col, gap: 2, borderLeft: '2px solid var(--dsw-alias-border-l2)', paddingLeft: 6 } }, [
      ...(snapshot.error !== null
        ? [h('span', { key: 'e', style: ST.bad }, snapshot.error)]
        : []),
      ...(notice !== null
        ? [
            h('span', {
              key: 'n',
              style: notice.tone === 'bad' ? ST.bad : notice.tone === 'ok' ? ST.ok : ST.tiny,
            }, notice.text),
          ]
        : []),
      h(
        'button',
        {
          key: 'x',
          type: 'button',
          style: { ...ST.button, padding: '0 5px', fontSize: 9, alignSelf: 'flex-start' },
          onClick: () => {
            props.store.dismissNotice();
          },
        },
        '关闭提示',
      ),
    ]);
  }

  // ---------------------------------------------------------------- 资产对话框

  function CandidatePreview(props: { candidate: AssetsGenerateCandidate; index: number; selected: boolean; onSelect: () => void }): VNode {
    const url = useObjectUrl(props.candidate.b64, props.candidate.format);
    return h(
      'button',
      {
        type: 'button',
        title: `候选 ${props.index + 1}：${props.candidate.width}×${props.candidate.height} · ${formatBytes(sizeOfB64(props.candidate.b64))}`,
        style: {
          ...(props.selected ? ST.buttonOn : ST.card),
          padding: 4,
          gap: 3,
          cursor: 'pointer',
          borderColor: props.selected ? 'var(--dsw-alias-brand-primary)' : undefined,
        },
        onClick: props.onSelect,
      },
      [
        url !== undefined
          ? h('img', { key: 'img', src: url, alt: `候选 ${props.index + 1}`, style: { width: '100%', aspectRatio: '3 / 4', objectFit: 'contain', borderRadius: 6, background: '#0d1014' } })
          : h('span', { key: 'missing', style: ST.tiny }, '候选图不可预览'),
        h('span', { key: 'meta', style: ST.tiny }, `#${props.index + 1} · ${props.candidate.width}×${props.candidate.height} · ${props.candidate.format.toUpperCase()}`),
        h('span', { key: 'sha', style: { ...ST.tiny, opacity: 0.7 } }, props.candidate.sha256.slice(0, 12)),
      ],
    );
  }

  function ImportPreviewBox(props: { preview: NonNullable<AssetDialogState['preview']> }): VNode {
    const url = useObjectUrl(props.preview.b64, props.preview.format);
    return h('div', { style: { ...ST.card, flexDirection: 'row', alignItems: 'flex-start', gap: 8 } }, [
      url !== undefined
        ? h('img', { key: 'img', src: url, alt: props.preview.fileName, style: { width: 96, height: 128, objectFit: 'contain', borderRadius: 6, background: '#0d1014', flex: '0 0 auto' } })
        : h('span', { key: 'none', style: ST.tiny }, '预览不可用'),
      h('div', { key: 'meta', style: { ...ST.col, gap: 2, minWidth: 0 } }, [
        h('strong', { key: 'n', style: { fontSize: 11 } }, props.preview.fileName),
        h('span', { key: 's', style: ST.tiny }, `${props.preview.width}×${props.preview.height} · ${props.preview.format.toUpperCase()} · ${formatBytes(props.preview.bytes)}`),
        h('span', { key: 'h', style: ST.tiny }, `sha256 ${props.preview.sha256.slice(0, 16)}…`),
        ...props.preview.warnings.map((warning: string, index: number) => h('span', { key: `w${index}`, style: ST.warn }, warning)),
      ]),
    ]);
  }

  function CustomFields(props: { store: AssetStore; snapshot: AssetSnapshot }): VNode {
    const custom = props.snapshot.custom;
    return h('div', { key: 'custom', style: { ...ST.col, gap: 4, border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 8, padding: 6 } }, [
      h('span', { key: 't', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, '自备 OpenAI 兼容接口（只存本机 localStorage，不进房间；浏览器直连需服务端允许 CORS）'),
      h('input', {
        key: 'base',
        style: ST.input,
        placeholder: 'baseUrl，如 https://api.openai.com/v1',
        value: custom.baseUrl,
        onChange: (event: { target: { value: string } }) => props.store.setCustom({ baseUrl: event.target.value }),
      }),
      h('input', {
        key: 'model',
        style: ST.input,
        placeholder: '模型名，如 dall-e-3 / gpt-image-1',
        value: custom.model,
        onChange: (event: { target: { value: string } }) => props.store.setCustom({ model: event.target.value }),
      }),
      h('input', {
        key: 'key',
        style: ST.input,
        type: 'password',
        placeholder: 'API key（只存本机；不会上传房间）',
        value: custom.apiKey,
        onChange: (event: { target: { value: string } }) => props.store.setCustom({ apiKey: event.target.value }),
      }),
    ]);
  }

  /** 三来源资产对话框：本地导入 / AI 生成（host）/ 自备接口。 */
  function AssetsDialog(props: { store: AssetStore }): VNode {
    const snapshot = useSnapshot(props.store);
    const dialog = snapshot.dialog;
    const fileRef = useRef(null as { click?: () => void; value?: string } | null);
    if (dialog === null) return null;
    const target = targetSizeOf(dialog.kind);
    const limit = LOCAL_ASSET_BYTE_LIMITS[dialog.kind];
    const busy = dialog.busy !== null;
    const isGenTab = dialog.tab === 'generate' || dialog.tab === 'custom';
    const existing = props.store.assetOf(dialog.kind === 'portraitVariant' ? 'portraitVariant' : dialog.kind, dialog.kind === 'portraitVariant' ? dialog.variant : undefined);
    const canSaveCandidate = dialog.selected !== null && dialog.candidates.length > 0 && !busy;

    const tabButton = (tab: 'import' | 'generate' | 'custom', label: string): VNode =>
      h(
        'button',
        {
          key: tab,
          type: 'button',
          style: { ...(dialog.tab === tab ? ST.buttonOn : ST.button), padding: '2px 10px' },
          onClick: () => props.store.setDialogTab(tab),
        },
        label,
      );

    const sharedGenControls: VNode[] = [
      h('div', { key: 'style', style: ST.row }, [
        h('span', { key: 'l', style: ST.tiny }, '风格'),
        ...(['pixel-32', 'game-2d'] as PlayerGenStyle[]).map((style) =>
          h(
            'button',
            {
              key: style,
              type: 'button',
              style: { ...(dialog.style === style ? ST.buttonOn : ST.button), padding: '1px 8px' },
              onClick: () => props.store.setDialogStyle(style),
            },
            STYLE_LABELS[style],
          ),
        ),
        h('span', { key: 'size', style: ST.tiny }, `目标 ${target.width}×${target.height}`),
      ]),
      h('div', { key: 'prompt', style: { ...ST.col, gap: 2 } }, [
        h('div', { key: 'h', style: ST.row }, [
          h('span', { key: 'l', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, '提示词（模板变量已按卡面预填，可改）'),
          h(
            'button',
            { key: 'reset', type: 'button', style: { ...ST.button, padding: '0 6px', fontSize: 9 }, onClick: () => props.store.resetDialogPrompt() },
            '按卡面重填',
          ),
        ]),
        h('textarea', {
          key: 'ta',
          style: ST.textarea,
          value: dialog.prompt,
          onChange: (event: { target: { value: string } }) => props.store.setDialogPrompt(event.target.value),
          placeholder: '角色外貌、服装、构图、背景要求…',
        }),
      ]),
      h('div', { key: 'seed', style: ST.row }, [
        h('span', { key: 'l', style: ST.tiny }, 'seed'),
        h('input', {
          key: 'i',
          style: { ...ST.input, width: 90 },
          placeholder: '留空=随机',
          value: dialog.seed,
          onChange: (event: { target: { value: string } }) => props.store.setDialogSeed(event.target.value),
        }),
        h('span', { key: 'c', style: { ...ST.tiny, marginLeft: 8 } }, '候选数'),
        h(
          'select',
          {
            key: 'n',
            style: ST.select,
            value: String(dialog.count),
            onChange: (event: { target: { value: string } }) => props.store.setDialogCount(Number.parseInt(event.target.value, 10) || 1),
          },
          [1, 2, 3, 4].map((count) => h('option', { key: count, value: String(count) }, String(count))),
        ),
        dialog.kind === 'portraitVariant'
          ? h('span', { key: 'v', style: ST.row }, [
              h('span', { style: ST.tiny }, '变体名'),
              h('input', {
                style: { ...ST.input, width: 96 },
                list: 'dsh-trpg-variant-presets',
                value: dialog.variant,
                onChange: (event: { target: { value: string } }) => props.store.setDialogVariant(event.target.value),
              }),
              h('datalist', { id: 'dsh-trpg-variant-presets' }, VARIANT_PRESETS.map((name) => h('option', { key: name, value: name }))),
            ])
          : null,
      ]),
    ];

    const candidatesGrid = dialog.candidates.length > 0
      ? h(
          'div',
          { key: 'candidates', style: { ...ST.col, gap: 4 } }, [
            h('span', { key: 't', style: ST.tiny }, `候选（${dialog.candidates.length}）${dialog.provider !== null ? ` · 来源 ${dialog.provider}` : ''}：点选后保存到本地`),
            h(
              'div',
              { key: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6 } },
              dialog.candidates.map((candidate, index) =>
                h(CandidatePreview, {
                  key: index,
                  candidate,
                  index,
                  selected: dialog.selected === index,
                  onSelect: () => props.store.selectCandidate(index),
                }),
              ),
            ),
          ],
        )
      : null;

    const importTab: VNode = h('div', { key: 'import', style: { ...ST.col, gap: 6 } }, [
      h('span', { key: 'note', style: ST.tiny }, `本地导入 PNG/SVG：${KIND_LABELS[dialog.kind]}预检上限 ${formatBytes(limit)}，建议 ${target.width}×${target.height}；只存本机 IndexedDB，不上传 host。`),
      h('div', { key: 'row', style: ST.row }, [
        h(
          'button',
          {
            key: 'pick',
            type: 'button',
            style: ST.buttonPrimary,
            disabled: busy,
            onClick: () => fileRef.current?.click?.(),
          },
          '选择图片…',
        ),
        h('input', {
          key: 'file',
          ref: fileRef,
          type: 'file',
          accept: '.png,.svg,image/png,image/svg+xml',
          style: { display: 'none' },
          onChange: (event: { target: { files?: ArrayLike<File>; value?: string } }) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void props.store.importFile(file);
            if (event.target.value !== undefined) event.target.value = '';
          },
        }),
        existing !== undefined ? h('span', { key: 'existing', style: ST.tiny }, `已有一份：${existing.width}×${existing.height}（再导入即替换）`) : null,
      ]),
      dialog.preview !== null ? h(ImportPreviewBox, { key: 'preview', preview: dialog.preview }) : null,
      ...dialog.importErrors.map((error: string, index: number) => h('span', { key: `ie${index}`, style: ST.bad }, error)),
      dialog.preview !== null
        ? h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: busy, onClick: () => void props.store.confirmImport() }, '保存到本地卡')
        : null,
    ]);

    const generateTab: VNode = h('div', { key: 'generate', style: { ...ST.col, gap: 6 } }, [
      ...sharedGenControls,
      h('div', { key: 'go', style: ST.row }, [
        h(
          'button',
          {
            key: 'run',
            type: 'button',
            style: ST.buttonPrimary,
            disabled: busy,
            onClick: () => void props.store.generate(),
          },
          dialog.busy !== null ? dialog.busy : `调用 host 生成 ${dialog.count} 个候选`,
        ),
        h('span', { key: 'hint', style: ST.tiny }, 'host 需配置 DSH_TRPG_OPENAI_* 生图服务；未配置时右侧显示 host 的中文错误'),
      ]),
      dialog.error !== null ? h('span', { key: 'err', style: ST.bad }, dialog.error) : null,
      dialog.notice !== null && dialog.tab === 'generate' ? h('span', { key: 'n', style: ST.tiny }, dialog.notice) : null,
      candidatesGrid,
      dialog.selected !== null
        ? h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: !canSaveCandidate, onClick: () => void props.store.saveSelectedCandidate() }, `保存选中候选（#${dialog.selected + 1}）到本地`)
        : null,
    ]);

    const customTab: VNode = h('div', { key: 'custom-tab', style: { ...ST.col, gap: 6 } }, [
      h(CustomFields, { key: 'cf', store: props.store, snapshot }),
      ...sharedGenControls,
      h('div', { key: 'go', style: ST.row }, [
        h(
          'button',
          {
            key: 'run',
            type: 'button',
            style: ST.buttonPrimary,
            disabled: busy,
            onClick: () => void props.store.generateCustom(),
          },
          dialog.busy !== null ? dialog.busy : `用自备接口生成 ${dialog.count} 个候选`,
        ),
        h('span', { key: 'hint', style: ST.tiny }, '浏览器直连：接口需允许 CORS；key 只存本机、不进房间'),
      ]),
      dialog.error !== null ? h('span', { key: 'err', style: ST.bad }, dialog.error) : null,
      dialog.notice !== null && dialog.tab === 'custom' ? h('span', { key: 'n', style: ST.tiny }, dialog.notice) : null,
      candidatesGrid,
      dialog.selected !== null
        ? h('button', { key: 'save', type: 'button', style: ST.buttonPrimary, disabled: !canSaveCandidate, onClick: () => void props.store.saveSelectedCandidate() }, `保存选中候选（#${dialog.selected + 1}）到本地`)
        : null,
    ]);

    return h(
      'div',
      {
        key: 'asset-dialog-overlay',
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 9000,
          background: 'rgba(4,6,10,.60)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        },
        onClick: (event: { target: unknown; currentTarget: unknown }) => {
          if (event.target === event.currentTarget) props.store.closeDialog();
        },
      },
      h(
        'div',
        {
          style: {
            width: 'min(780px, 94vw)',
            maxHeight: '88vh',
            overflow: 'auto',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 12,
            boxShadow: '0 18px 48px rgba(0,0,0,.45)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
        },
        [
          h('div', { key: 'hd', style: { ...ST.row, gap: 8 } }, [
            h('strong', { key: 't', style: { fontSize: 13 } }, `角色资产 · ${KIND_LABELS[dialog.kind]}`),
            h('span', { key: 'card', style: ST.tiny }, snapshot.meta !== null ? `卡：${snapshot.meta.name}` : '未选中卡'),
            h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
            h('button', { key: 'x', type: 'button', style: ST.button, onClick: () => props.store.closeDialog() }, '关闭'),
          ]),
          h('div', { key: 'tabs', style: { ...ST.row, gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 6 } }, [
            tabButton('import', '本地导入'),
            tabButton('generate', 'AI 生成（host）'),
            tabButton('custom', '自备接口'),
          ]),
          dialog.tab === 'import' ? importTab : dialog.tab === 'generate' ? generateTab : customTab,
        ],
      ),
    );
  }

  return {
    AssetsDialog,
    SheetAvatar,
    SheetPortrait,
    SheetAssetPanel,
    SheetSpriteThumb,
    AssetThumb,
    AssetNotice,
    useAssetSnapshot: useSnapshot,
  };
}

function sizeOfB64(b64: string): number {
  try {
    return base64ToBytes(b64).length;
  } catch {
    return 0;
  }
}

// `DEFAULT_VARIANTS` 目前仅作为文档级常量透出（对话框用 VARIANT_PRESETS），避免未使用告警。
void DEFAULT_VARIANTS;
