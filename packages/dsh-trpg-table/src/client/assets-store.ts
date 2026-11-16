/**
 * M9.5d 玩家角色资产的数据/交互状态层（Client 半边，纯 TS + 订阅，不含 React）。
 *
 * 分工：
 * - `assets.ts`：IndexedDB 读写、预检、sha256、host 生成/上传 RPC、自备接口、提示词模板；
 * - 本文件：对话框状态机（三来源）、候选网格、变体选择、落座上传与「同步到房间」；
 * - `assets-ui.ts`：订阅快照做渲染，不直接发请求。
 *
 * 口径（UI-CONTRACT §7.2/§8）：本地是私卡的权威副本；落座只上传展示白名单；
 * 生成/上传失败都只做可读提示，绝不阻断落座。
 */
import type { AssetsGenerateCandidate, CharacterAssetRefInput, SheetView } from '@dsh-trpg/protocol';
import type { CharacterCard } from '@dsh-trpg/engine';
import type { TableSessionRef } from './rules-store.ts';
import {
  ASSET_TARGET_SIZES,
  assetIdOf,
  base64ToBytes,
  deleteCardAsset,
  findCardAsset,
  formatBytes,
  isAssetStorageMemoryOnly,
  KIND_LABELS,
  listCardAssets,
  loadCustomEndpoint,
  preflightAsset,
  renderPromptTemplate,
  requestCustomGeneration,
  requestHostGeneration,
  saveCardAsset,
  saveCustomEndpoint,
  sizeOf,
  sortForUpload,
  uploadDisplayAssets,
  type CardAssetKind,
  type CardAssetRecord,
  type CustomEndpointSettings,
  type PlayerGenKind,
  type PlayerGenStyle,
} from './assets.ts';
import { rpcErrorMessage } from './rpc.ts';

/** 卡面提示词变量（本地卡或 host 投影都能填）。 */
export interface CardMeta {
  cardId: string;
  name: string;
  race: string;
  class: string;
  appearance: string;
  personality: string;
}

/** 从 host 的 `SheetView` 造提示词变量（fields 里按常见键取外貌/性格）。 */
export function cardMetaFromSheet(sheet: SheetView): CardMeta {
  const fields = sheet.fields;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return '';
  };
  return {
    cardId: sheet.cardId,
    name: sheet.identity.name,
    race: sheet.identity.race ?? '',
    class: sheet.identity.class ?? '',
    appearance: pick('appearance', '外貌', 'looks', 'description'),
    personality: pick('personality', '性格', 'persona', 'background'),
  };
}

/** 从本地卡造提示词变量（未落座时编辑资产用）。 */
export function cardMetaFromCard(card: CharacterCard): CardMeta {
  return {
    cardId: card.id,
    name: card.identity.name,
    race: card.identity.race ?? '',
    class: card.identity.class ?? '',
    appearance: card.appearance ?? '',
    personality: card.personality ?? '',
  };
}

export type AssetDialogTab = 'import' | 'generate' | 'custom';

/** 本地导入预览（预检通过但还没落库）。 */
export interface AssetImportPreview {
  b64: string;
  format: 'png' | 'svg';
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  fileName: string;
  warnings: string[];
}

export interface AssetDialogState {
  /** 保存目标（头像/立绘/表情变体/帧表）。 */
  kind: CardAssetKind;
  tab: AssetDialogTab;
  style: PlayerGenStyle;
  /** 当前预填/编辑中的提示词。 */
  prompt: string;
  /** 最近一次按模板自动填的提示词（用户改过就不再自动覆盖）。 */
  autoPrompt: string;
  seed: string;
  count: number;
  /** 表情变体名（保存 `portraitVariant` 时用）。 */
  variant: string;
  candidates: AssetsGenerateCandidate[];
  selected: number | null;
  preview: AssetImportPreview | null;
  importErrors: string[];
  busy: string | null;
  error: string | null;
  notice: string | null;
  provider: string | null;
}

export interface AssetUploadState {
  at: number;
  refs: number;
  skipped: string[];
}

export interface AssetSnapshot {
  cardId: string | null;
  meta: CardMeta | null;
  assets: CardAssetRecord[];
  loading: boolean;
  error: string | null;
  notice: { tone: 'ok' | 'bad' | 'info'; text: string } | null;
  dialog: AssetDialogState | null;
  /** 当前选中的表情变体（null = 默认立绘；未配置的变体按立绘回退）。 */
  selectedVariant: string | null;
  uploading: boolean;
  /** 最近一次落座上传结果（界面展示「已同步到房间」）。 */
  lastUpload: AssetUploadState | null;
  /** 本地有展示资产但还没传上当前房间的数量。 */
  pendingSync: number;
  /** 自备接口设置（key 只在本地）。 */
  custom: CustomEndpointSettings;
  /** 「同步到房间」正在跑（= 重新落座）。 */
  resyncing: boolean;
}

const INITIAL: AssetSnapshot = {
  cardId: null,
  meta: null,
  assets: [],
  loading: false,
  error: null,
  notice: null,
  dialog: null,
  selectedVariant: null,
  uploading: false,
  lastUpload: null,
  pendingSync: 0,
  custom: { baseUrl: '', apiKey: '', model: '' },
  resyncing: false,
};

/** 落座上传的展示资产白名单排序（头像/立绘/变体/帧表/图标）。 */
const DISPLAY_KINDS: CardAssetKind[] = ['avatar', 'portrait', 'portraitVariant', 'spriteSheet', 'icon'];

function genKindOf(kind: CardAssetKind): PlayerGenKind {
  if (kind === 'avatar') return 'avatar';
  if (kind === 'spriteSheet' || kind === 'icon') return 'sprite';
  return 'portrait';
}

function displayAssetsOf(assets: CardAssetRecord[]): CardAssetRecord[] {
  return sortForUpload(assets.filter((asset) => DISPLAY_KINDS.includes(asset.kind)));
}

export interface SeatUploadOutcome {
  refs: CharacterAssetRefInput[];
  skipped: string[];
  error: string | null;
}

/**
 * 资产状态机。生命周期与 RulesStore 一致：插件创建一次、页面卸载/HMR 时 dispose。
 * 与 RulesStore 分开是为了：资产管理不依赖规则投影（纯叙事团也能用），且上传失败不影响卡面。
 */
export class AssetStore {
  private snapshot: AssetSnapshot = { ...INITIAL };
  private listeners = new Set<() => void>();
  private base: string | undefined;
  private token: string | undefined;
  private roomId: string | undefined;
  private sessionKey = '';
  /** 当前房间已成功上传的 sha256（界面「待同步」计数用；缓存不持久化字节）。 */
  private uploadedShas = new Set<string>();
  private seatRunner: (() => Promise<void>) | null = null;
  private loadSeq = 0;

  getSnapshot = (): AssetSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* 单个订阅者异常不阻塞其他视图 */
      }
    }
  }

  private set(patch: Partial<AssetSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  // ---------------------------------------------------------------- 会话/卡

  /** 绑定房间会话（token 用于生图/上传；换房间时清「已同步」状态）。 */
  bindSession(session: TableSessionRef | null): void {
    const base = session?.base;
    const token = session?.hostToken ?? session?.playerToken;
    const roomId = session?.roomId;
    const key = `${base ?? ''}|${token ?? ''}|${roomId ?? ''}`;
    if (key === this.sessionKey) return;
    this.sessionKey = key;
    this.base = base;
    this.token = token;
    this.roomId = roomId;
    this.uploadedShas.clear();
    this.set({ lastUpload: null, pendingSync: this.pendingSyncOf(this.snapshot.assets) });
  }

  /** 当前编辑的本地卡（落座后用 host 投影的 cardId；未落座用选中的本地卡）。 */
  setCard(meta: CardMeta | null): void {
    if (meta === null) {
      if (this.snapshot.cardId === null) return;
      this.set({ cardId: null, meta: null, assets: [], selectedVariant: null, loading: false, pendingSync: 0 });
      return;
    }
    if (this.snapshot.cardId === meta.cardId) {
      this.set({ meta });
      return;
    }
    this.set({ cardId: meta.cardId, meta, assets: [], loading: true, error: null, selectedVariant: null });
    void this.reload(meta.cardId);
  }

  private async reload(cardId: string): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const assets = await listCardAssets(cardId);
      if (seq !== this.loadSeq || this.snapshot.cardId !== cardId) return;
      this.set({
        assets,
        loading: false,
        pendingSync: this.pendingSyncOf(assets),
        ...(isAssetStorageMemoryOnly()
          ? { error: '浏览器 IndexedDB 不可用：本地资产只保留在内存里，刷新后会丢（请换普通窗口/关闭隐私模式）' }
          : {}),
      });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.set({ loading: false, error: `读取本地资产失败：${rpcErrorMessage(error)}` });
    }
  }

  /** 重新读本地资产（落座/切卡后）。 */
  refresh(): void {
    const cardId = this.snapshot.cardId;
    if (cardId === null) return;
    this.set({ loading: true });
    void this.reload(cardId);
  }

  private pendingSyncOf(assets: CardAssetRecord[]): number {
    return displayAssetsOf(assets).filter((asset) => asset.sha256.length > 0 && !this.uploadedShas.has(asset.sha256)).length;
  }

  /** 注册「重新落座（带资产）」回调：由 index.ts 在 seat 能力就绪后调用。 */
  setSeatRunner(runner: (() => Promise<void>) | null): void {
    this.seatRunner = runner;
  }

  /** 「同步到房间」按钮：重新走一次落座（先传资产再落座）。 */
  async requestResync(): Promise<void> {
    if (this.seatRunner === null || this.snapshot.resyncing) {
      this.set({ notice: { tone: 'info', text: '当前没有可用的落座上下文：先在右栏「落座」一次，再同步资产' } });
      return;
    }
    this.set({ resyncing: true });
    try {
      await this.seatRunner();
    } finally {
      this.set({ resyncing: false });
    }
  }

  // ---------------------------------------------------------------- 资产查询

  /** 展示资产（按上传优先级排序）。 */
  displayAssets(): CardAssetRecord[] {
    return displayAssetsOf(this.snapshot.assets);
  }

  /** 按 kind/variant 找本地资产（表情变体未配时回退主立绘）。 */
  assetOf(kind: CardAssetKind, variant?: string): CardAssetRecord | undefined {
    return findCardAsset(this.snapshot.assets, kind, variant);
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  setSelectedVariant(variant: string | null): void {
    if (variant === this.snapshot.selectedVariant) return;
    this.set({ selectedVariant: variant });
  }

  // ---------------------------------------------------------------- 对话框

  /** 打开资产对话框：按目标 kind 预填提示词与默认 tab。 */
  openDialog(kind: CardAssetKind, options?: { tab?: AssetDialogTab; variant?: string }): void {
    const style: PlayerGenStyle = 'game-2d';
    const meta = this.snapshot.meta;
    const prompt = renderPromptTemplate(genKindOf(kind), style, meta !== null ? meta : {});
    this.set({
      custom: loadCustomEndpoint(),
      dialog: {
        kind,
        tab: options?.tab ?? 'import',
        style,
        prompt,
        autoPrompt: prompt,
        seed: '',
        count: 2,
        variant: kind === 'portraitVariant' ? options?.variant ?? 'smile' : '',
        candidates: [],
        selected: null,
        preview: null,
        importErrors: [],
        busy: null,
        error: null,
        notice: null,
        provider: null,
      },
    });
  }

  closeDialog(): void {
    this.set({ dialog: null });
  }

  private patchDialog(patch: Partial<AssetDialogState>): void {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    this.set({ dialog: { ...dialog, ...patch } });
  }

  setDialogTab(tab: AssetDialogTab): void {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    this.patchDialog({ tab, error: null });
  }

  /** 切风格：提示词还是自动模板时一起更新（玩家改过就保留）。 */
  setDialogStyle(style: PlayerGenStyle): void {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    const meta = this.snapshot.meta;
    const auto = renderPromptTemplate(genKindOf(dialog.kind), style, meta !== null ? meta : {});
    const useAuto = dialog.prompt.trim().length === 0 || dialog.prompt === dialog.autoPrompt;
    this.patchDialog({ style, autoPrompt: auto, ...(useAuto ? { prompt: auto } : {}) });
  }

  setDialogPrompt(prompt: string): void {
    this.patchDialog({ prompt });
  }

  /** 把提示词重置回当前卡面模板（改了变量/风格后重填）。 */
  resetDialogPrompt(): void {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    const meta = this.snapshot.meta;
    const auto = renderPromptTemplate(genKindOf(dialog.kind), dialog.style, meta !== null ? meta : {});
    this.patchDialog({ prompt: auto, autoPrompt: auto });
  }

  setDialogSeed(seed: string): void {
    this.patchDialog({ seed });
  }

  setDialogCount(count: number): void {
    this.patchDialog({ count: Math.max(1, Math.min(4, Math.floor(count))) });
  }

  setDialogVariant(variant: string): void {
    this.patchDialog({ variant });
  }

  setCustom(patch: Partial<CustomEndpointSettings>): void {
    const custom = { ...this.snapshot.custom, ...patch };
    this.set({ custom });
    saveCustomEndpoint(custom);
  }

  /** 本地导入：文件 → 预检（格式/体积/尺寸）→ 预览。 */
  async importFile(file: File): Promise<void> {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    this.patchDialog({ busy: '预处理中…', error: null, preview: null, importErrors: [], notice: null });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const preflight = await preflightAsset(dialog.kind, bytes, file.name);
      if (!preflight.ok) {
        this.patchDialog({ busy: null, importErrors: preflight.errors });
        return;
      }
      this.patchDialog({
        busy: null,
        importErrors: [],
        preview: {
          b64: preflight.b64,
          format: preflight.format,
          width: preflight.width,
          height: preflight.height,
          bytes: preflight.bytes,
          sha256: preflight.sha256,
          fileName: file.name,
          warnings: preflight.warnings,
        },
      });
    } catch (error) {
      this.patchDialog({ busy: null, importErrors: [rpcErrorMessage(error)] });
    }
  }

  /** 保存本地导入的资产。 */
  async confirmImport(): Promise<void> {
    const dialog = this.snapshot.dialog;
    if (dialog === null || dialog.preview === null) return;
    const outcome = await this.saveBuffer({
      kind: dialog.kind,
      variant: dialog.kind === 'portraitVariant' ? dialog.variant : undefined,
      b64: dialog.preview.b64,
      format: dialog.preview.format,
      width: dialog.preview.width,
      height: dialog.preview.height,
      sha256: dialog.preview.sha256,
      meta: spriteMetaOf(dialog.kind, dialog.preview.width, dialog.preview.height),
    });
    if (outcome !== null) {
      this.closeDialog();
      this.set({ notice: { tone: 'ok', text: outcome } });
    }
  }

  /** 调 host 生图（`assets.generate`）；host 未配置时原样展示中文错误。 */
  async generate(): Promise<void> {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    const base = this.base;
    if (!base) {
      this.patchDialog({ error: '还没有加入房间：先建房/加入房间，再用 host 生图（也可以先在本地导入图片）' });
      return;
    }
    const prompt = dialog.prompt.trim();
    if (prompt.length === 0) {
      this.patchDialog({ error: '提示词不能为空' });
      return;
    }
    const seed = parseSeed(dialog.seed);
    if (seed === undefined) {
      this.patchDialog({ error: 'seed 只能是整数（留空 = 随机）' });
      return;
    }
    this.patchDialog({ busy: '生成中…', error: null, notice: null, candidates: [], selected: null, provider: null });
    try {
      const result = await requestHostGeneration(base, this.token, {
        kind: genKindOf(dialog.kind),
        style: dialog.style,
        prompt,
        ...(this.snapshot.meta !== null && this.snapshot.meta.name.length > 0 ? { subject: this.snapshot.meta.name } : {}),
        ...(seed !== null ? { seed } : {}),
        count: dialog.count,
      });
      this.patchDialog({
        busy: null,
        candidates: result.candidates,
        selected: result.candidates.length > 0 ? 0 : null,
        provider: result.provider ?? null,
        notice: result.candidates.length === 0 ? 'host 没有返回候选' : `已生成 ${result.candidates.length} 个候选：挑一个保存`,
      });
    } catch (error) {
      this.patchDialog({ busy: null, error: rpcErrorMessage(error) });
    }
  }

  /** 浏览器直连玩家自备 OpenAI 兼容接口生成（CORS 不可用给可读提示）。 */
  async generateCustom(): Promise<void> {
    const dialog = this.snapshot.dialog;
    if (dialog === null) return;
    const prompt = dialog.prompt.trim();
    if (prompt.length === 0) {
      this.patchDialog({ error: '提示词不能为空' });
      return;
    }
    const seed = parseSeed(dialog.seed);
    if (seed === undefined) {
      this.patchDialog({ error: 'seed 只能是整数（留空 = 随机）' });
      return;
    }
    this.patchDialog({ busy: '调用自备接口…', error: null, notice: null, candidates: [], selected: null, provider: null });
    try {
      const result = await requestCustomGeneration(this.snapshot.custom, {
        kind: genKindOf(dialog.kind),
        style: dialog.style,
        prompt,
        ...(this.snapshot.meta !== null && this.snapshot.meta.name.length > 0 ? { subject: this.snapshot.meta.name } : {}),
        ...(seed !== null ? { seed } : {}),
        count: dialog.count,
      });
      this.patchDialog({
        busy: null,
        candidates: result.candidates,
        selected: result.candidates.length > 0 ? 0 : null,
        provider: result.provider ?? null,
        notice: `自备接口返回 ${result.candidates.length} 个候选`,
      });
    } catch (error) {
      this.patchDialog({ busy: null, error: rpcErrorMessage(error) });
    }
  }

  selectCandidate(index: number): void {
    const dialog = this.snapshot.dialog;
    if (dialog === null || index < 0 || index >= dialog.candidates.length) return;
    this.patchDialog({ selected: index });
  }

  /** 保存选中候选到本地（不自动上传；落座/同步时才上传）。 */
  async saveSelectedCandidate(): Promise<void> {
    const dialog = this.snapshot.dialog;
    if (dialog === null || dialog.selected === null) return;
    const candidate = dialog.candidates[dialog.selected];
    if (candidate === undefined) return;
    const outcome = await this.saveBuffer({
      kind: dialog.kind,
      variant: dialog.kind === 'portraitVariant' ? dialog.variant : undefined,
      b64: candidate.b64,
      format: candidate.format,
      width: candidate.width,
      height: candidate.height,
      sha256: candidate.sha256,
      meta: spriteMetaOf(dialog.kind, candidate.width, candidate.height),
    });
    if (outcome !== null) {
      this.closeDialog();
      this.set({ notice: { tone: 'ok', text: outcome } });
    }
  }

  /** 删除本地资产（host 上已上传的不回收；房间展示按落座时引用）。 */
  async removeAsset(assetId: string): Promise<void> {
    const cardId = this.snapshot.cardId;
    if (cardId === null) return;
    try {
      await deleteCardAsset(cardId, assetId);
      const assets = this.snapshot.assets.filter((asset) => asset.assetId !== assetId);
      this.set({
        assets,
        pendingSync: this.pendingSyncOf(assets),
        notice: { tone: 'info', text: '已删除本地资产（房间里的旧引用要等下次落座/同步才更新）' },
      });
    } catch (error) {
      this.set({ error: `删除本地资产失败：${rpcErrorMessage(error)}` });
    }
  }

  /** 写入一条本地资产：按卡/kind/variant 唯一，重复导入即替换。 */
  private async saveBuffer(input: {
    kind: CardAssetKind;
    variant?: string;
    b64: string;
    format: 'png' | 'svg';
    width: number;
    height: number;
    sha256: string;
    meta?: { rows?: number; cols?: number; frameSize?: number };
  }): Promise<string | null> {
    const cardId = this.snapshot.cardId;
    if (cardId === null) {
      this.set({ notice: { tone: 'bad', text: '还没有选中的本地卡：先在右栏「我的卡」里选一张卡，再保存资产' } });
      return null;
    }
    const assetId = assetIdOf(input.kind, input.variant);
    const record: CardAssetRecord = {
      key: `${cardId}:${assetId}`,
      cardId,
      assetId,
      kind: input.kind,
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      bytes: input.b64,
      format: input.format,
      width: input.width,
      height: input.height,
      sha256: input.sha256,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      createdAt: Date.now(),
    };
    try {
      await saveCardAsset(record);
      const assets = [...this.snapshot.assets.filter((asset) => asset.assetId !== assetId), record].sort(
        (left, right) => left.createdAt - right.createdAt,
      );
      this.set({ assets, pendingSync: this.pendingSyncOf(assets), selectedVariant: input.variant ?? this.snapshot.selectedVariant });
      return `已保存${KIND_LABELS[input.kind]}到本地${input.variant !== undefined ? `（变体 ${input.variant}）` : ''}：${input.width}×${input.height} · ${formatBytes(base64BytesOf(input.b64))}`;
    } catch (error) {
      this.set({ notice: { tone: 'bad', text: `保存本地资产失败：${rpcErrorMessage(error)}` } });
      return null;
    }
  }

  // ---------------------------------------------------------------- 落座上传

  /**
   * 落座前上传展示资产：返回可直接放进 `room.seat` 的 `characterAssets` 引用。
   * 失败不抛（落座优先）：`error` 由 index.ts 拼进状态提示，refs 为空照常落座。
   */
  async uploadForSeat(): Promise<SeatUploadOutcome> {
    const base = this.base;
    const roomId = this.roomId;
    const assets = displayAssetsOf(this.snapshot.assets).filter((asset) => asset.sha256.length > 0);
    if (base === undefined || roomId === undefined || assets.length === 0) {
      return { refs: [], skipped: [], error: null };
    }
    this.set({ uploading: true });
    try {
      const result = await uploadDisplayAssets(base, this.token, roomId, assets);
      const uploadedKinds = new Set(result.refs.map((ref) => `${ref.kind}|${ref.variant ?? ''}`));
      for (const asset of assets) {
        if (uploadedKinds.has(`${asset.kind}|${asset.variant ?? ''}`)) this.uploadedShas.add(asset.sha256);
      }
      this.set({
        uploading: false,
        lastUpload: { at: Date.now(), refs: result.refs.length, skipped: result.skipped },
        pendingSync: this.pendingSyncOf(this.snapshot.assets),
        ...(result.skipped.length > 0
          ? { notice: { tone: 'info', text: `部分资产未上传：${result.skipped.join('；')}` } }
          : {}),
      });
      return { refs: result.refs, skipped: result.skipped, error: null };
    } catch (error) {
      this.set({ uploading: false });
      return { refs: [], skipped: [], error: rpcErrorMessage(error) };
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.sessionKey = '';
    this.base = undefined;
    this.token = undefined;
    this.roomId = undefined;
    this.seatRunner = null;
    this.uploadedShas.clear();
    this.snapshot = { ...INITIAL };
  }
}

/** `seed` 输入解析：空串 = random（null）；非法 = undefined（报错）。 */
function parseSeed(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** 帧表默认元数据：按 128/96/64/32 网格推断（host 只收「整表 = 列×行×每格」的图）。 */
function spriteMetaOf(kind: CardAssetKind, width: number, height: number): { rows: number; cols: number; frameSize: number } | undefined {
  if (kind !== 'spriteSheet') return undefined;
  for (const frameSize of [128, 96, 64, 32, 16]) {
    if (width % frameSize !== 0 || height % frameSize !== 0) continue;
    const cols = width / frameSize;
    const rows = height / frameSize;
    if (cols >= 1 && cols <= 8 && rows >= 1 && rows <= 8) return { rows, cols, frameSize };
  }
  return { rows: 1, cols: 1, frameSize: Math.max(16, Math.min(256, Math.min(width, height))) };
}

function base64BytesOf(b64: string): number {
  try {
    return base64ToBytes(b64).length;
  } catch {
    return 0;
  }
}

/** 生成目标尺寸（对话框提示用）。 */
export function targetSizeOf(kind: CardAssetKind): { width: number; height: number } {
  return sizeOf(kind);
}

/** 默认表情变体名（UI-CONTRACT §8.1）。 */
export const DEFAULT_VARIANTS = ['idle', 'smile', 'sad', 'angry', 'attack'] as const;

/** 目标尺寸/本地体积上限透出（对话框提示用）。 */
export { ASSET_TARGET_SIZES };

/** 每个插件实例一个资产 store（HMR 时释放旧实例的订阅）。 */
const ASSET_SLOT = Symbol.for('dsh-trpg-table.asset-store');

export function createAssetStore(): AssetStore {
  const holder = globalThis as unknown as Record<symbol, AssetStore | undefined>;
  try {
    holder[ASSET_SLOT]?.dispose();
  } catch {
    /* ignore */
  }
  const store = new AssetStore();
  holder[ASSET_SLOT] = store;
  return store;
}
