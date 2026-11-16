/**
 * M9.4 规则投影的 Client 渲染层（右栏紧凑三页签 + 主区域详细页/世界地图/战棋）。
 *
 * 约束：
 * - 客户端零规则计算：所有数值、可用性（available/reason）、命中/伤害/骰面都来自 host DTO；
 *   本文件只做「排版 + 求和展示」（如装备对比的 stats 求和）与「提交意图」。
 * - 图标机制为临时方案：DTO 的 `icon` 只是引用（资源 M9.5 才上线），这里按 iconRef/名称哈希
 *   生成程序化几何徽记（SVG 形状 + 颜色 + 首字），真图上线后由 `iconOrBadge` 一处替换。
 * - 无新依赖：只用注入的 React；样式全部内联 var(--dsw-alias-*) token。
 */
import type {
  CombatActionEconomyEntryView,
  CombatInitiativeView,
  CombatTerrainLegendView,
  CombatTokenView,
  CombatView,
  EquipmentSlotView,
  IconRef,
  ItemCardView,
  SheetActionView,
  SheetSkillView,
  SheetStatusView,
  SheetView,
  WorldMapView,
  WorldMapZoneView,
} from '@dsh-trpg/protocol';
import type { MainViewKind, RulesSnapshot, RulesStore } from './rules-store.ts';

type H = (...args: any[]) => any;
type VNode = unknown;

// ---------------------------------------------------------------------------
// 样式（右栏 320–420px 单列，主区域双列；全部走主题 token）
// ---------------------------------------------------------------------------

const ST: Record<string, Record<string, unknown>> = {
  section: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 10,
    padding: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    flexShrink: 0,
  },
  h: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, fontWeight: 600, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
  col: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
  small: { fontSize: 11, minWidth: 0 },
  tiny: { fontSize: 10, minWidth: 0 },
  ok: { color: 'var(--dsw-alias-state-success-primary)', fontSize: 11 },
  bad: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 },
  warn: { color: 'var(--dsw-alias-state-warning-primary)', fontSize: 11 },
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
    flex: '0 0 auto',
    width: '100%',
    boxSizing: 'border-box',
    padding: '4px 8px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
    fontFamily: 'inherit',
  },
  select: {
    flex: '0 0 auto',
    width: '100%',
    boxSizing: 'border-box',
    padding: '3px 6px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 11,
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
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6, minWidth: 0 },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, minWidth: 0 },
  grid4: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, minWidth: 0 },
  bar: { height: 5, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden', minWidth: 0 },
  barFill: { height: '100%', borderRadius: 999, background: 'var(--dsw-alias-brand-primary)' },
  hint: {
    border: '1px dashed var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: 6,
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  // 主区域
  page: {
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '14px 18px 28px',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  pageHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    paddingBottom: 8,
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
    flexShrink: 0,
  },
  pageTitle: { fontSize: 15, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  tabs: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  tab: {
    padding: '4px 10px',
    borderRadius: 7,
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    cursor: 'pointer',
  },
  tabOn: {
    padding: '4px 10px',
    borderRadius: 7,
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  panel: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-2)',
    padding: 12,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  panelTitle: { fontSize: 12, fontWeight: 700, color: 'var(--dsw-alias-label-secondary)', letterSpacing: 0.5 },
  twoCol: { display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)', gap: 12, alignItems: 'start' },
  threeCol: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 340px)', gap: 12, alignItems: 'start' },
  bigText: { fontSize: 13, lineHeight: 1.5 },
  media: {
    position: 'relative',
    aspectRatio: '3 / 4',
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid var(--dsw-alias-border-l1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 0,
    flex: '0 0 auto',
  },
  cell: { position: 'absolute', boxSizing: 'border-box' },
  gridWrap: { position: 'relative', width: '100%', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--dsw-alias-border-l2)' },
  token: {
    position: 'absolute',
    transform: 'translate(-50%, -50%)',
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 1,
    lineHeight: 0,
  },
  tokenRing: { borderRadius: 999, display: 'inline-flex', padding: 1, lineHeight: 0 },
  hpBar: { width: '82%', height: 3, borderRadius: 999, background: 'rgba(0,0,0,.45)', overflow: 'hidden' },
  notice: { borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1)', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 },
};

/** 主区域需要的小动画（脉冲高亮）；内联 <style> 注入，不引样式文件。 */
const KEYFRAMES = `
@keyframes dsh-trpg-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); }
  70% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--dsw-alias-brand-primary) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 0%, transparent); }
}`;

// ---------------------------------------------------------------------------
// 展示映射（只做中文显示名，不含任何规则数值）
// ---------------------------------------------------------------------------

const ATTR_LABELS: Record<string, string> = {
  str: '力量', dex: '敏捷', con: '体质', int: '智力', wis: '感知', cha: '魅力',
  strength: '力量', dexterity: '敏捷', constitution: '体质', intelligence: '智力', wisdom: '感知', charisma: '魅力',
  body: '体魄', mind: '心志', spirit: '神魂', luck: '气运',
};

const DERIVED_LABELS: Record<string, string> = {
  ac: '防御', hpMax: '生命上限', mpMax: '资源上限', speed: '速度', initiative: '先攻',
  prof: '熟练加值', proficiency: '熟练加值', attack: '命中', damage: '伤害', reach: '攻击距离',
};

const FIELD_LABELS: Record<string, string> = {
  background: '背景', appearance: '外貌', personality: '性格', summary: '公开摘要', publicSummary: '公开摘要', notes: '备注',
  age: '年龄', gender: '性别', height: '身高', weight: '体重', faith: '信仰', alignment: '阵营', xp: '经验',
  ideals: '理想', bonds: '羁绊', flaws: '缺陷', goal: '目标', secret: '秘密', origin: '出身', occupation: '职业',
};

/** 投影 `fields` 会把卡面顶层字段原样带出：身份类字段已在头卡展示，叙事区不再重复。 */
const IDENTITY_FIELD_KEYS = new Set(['name', 'level', 'race', 'class', 'cardId', 'cardid', 'id', 'schemaVersion', 'owner', 'source']);

const TAG_LABELS: Record<string, string> = {
  weapon: '武器', armor: '护甲', consumable: '消耗', treasure: '奇物', tool: '工具', gear: '装备',
  misc: '杂物', quest: '任务', melee: '近战', ranged: '远程', light: '轻甲', heavy: '重甲', shield: '盾牌',
  potion: '药剂', scroll: '卷轴', food: '食物', material: '材料',
};

const TEAM_LABELS: Record<string, string> = { player: '我方', enemy: '敌方', neutral: '中立' };
const RANGE_LABELS: Record<string, string> = { engaged: '近身', near: '近距离', far: '远距离' };
const SIDES_LABELS: Record<string, string> = { self: '自己', ally: '友方', enemy: '敌方', any: '任意', all: '全体' };
const TYPE_LABELS: Record<string, string> = { self: '自身', single: '单体', multi: '多体', area: '范围', all: '全体', none: '无目标' };
const KIND_LABELS: Record<string, string> = { attack: '攻击', skill: '技能', spell: '法术', custom: '特殊' };

function labelOf(map: Record<string, string>, id: string): string {
  return map[id] ?? id;
}

function attrLabel(id: string): string {
  return labelOf(ATTR_LABELS, id);
}

function derivedLabel(key: string): string {
  if (DERIVED_LABELS[key] !== undefined) return DERIVED_LABELS[key];
  const dot = key.indexOf('.');
  if (dot >= 0) {
    const prefix = key.slice(0, dot);
    const rest = key.slice(dot + 1);
    const prefixLabel: Record<string, string> = { mod: '调整值', save: '豁免', mods: '调整值' };
    if (prefixLabel[prefix] !== undefined) return `${attrLabel(rest)}${prefixLabel[prefix]}`;
  }
  if (key.startsWith('mod')) return `${attrLabel(key.slice(3))}调整值`;
  return key;
}

function tagLabel(tag: string): string {
  const direct = TAG_LABELS[tag];
  if (direct !== undefined) return direct;
  // 组合标签（如 `weapon.melee` / `weapon:melee`）：逐段翻译后用 `·` 连接，未知段保留原文。
  if (/[.:]/.test(tag)) {
    return tag
      .split(/[.:]/)
      .map((segment) => TAG_LABELS[segment] ?? segment)
      .join('·');
  }
  return tag;
}

function fieldLabel(key: string): string {
  return labelOf(FIELD_LABELS, key);
}

// ---------------------------------------------------------------------------
// 程序化几何徽记（临时图标机制）
// ---------------------------------------------------------------------------

/**
 * 资源上线后翻成 true：DTO 带 `iconUrl`（UI-CONTRACT §4.2 的可选便利字段）时渲染真图，
 * 否则仍走几何徽记。改这一处即可全局替换为 M9.5 资产。
 */
const ASSET_ICONS_ENABLED = false;

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initialOf(name: string): string {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return '?';
  return trimmed.slice(0, 1);
}

function shapeNode(h: H, kind: number, fill: string, rim: string): VNode {
  switch (kind) {
    case 0:
      return h('circle', { cx: 16, cy: 16, r: 12.5, fill, stroke: rim, strokeWidth: 1.6 });
    case 1:
      return h('polygon', { points: '16,2.8 29.2,16 16,29.2 2.8,16', fill, stroke: rim, strokeWidth: 1.6 });
    case 2:
      return h('polygon', { points: '16,2.4 27.8,9.2 27.8,22.8 16,29.6 4.2,22.8 4.2,9.2', fill, stroke: rim, strokeWidth: 1.6 });
    case 3:
      return h('polygon', { points: '16,3.2 29.2,27.4 2.8,27.4', fill, stroke: rim, strokeWidth: 1.6 });
    default:
      return h('rect', { x: 4.5, y: 4.5, width: 23, height: 23, rx: 4, fill, stroke: rim, strokeWidth: 1.6 });
  }
}

/** DTO 里的 `icon` 引用 → 程序化徽记（形状/颜色由引用哈希决定，永不会纯文字）。 */
function iconOrBadge(h: H, iconRef: IconRef | undefined, name: string, size: number, withLetter = true): VNode {
  const seedValue = typeof iconRef === 'string' && iconRef.length > 0 ? iconRef : name;
  const seed = hashSeed(seedValue);
  const hue = seed % 360;
  const shape = Math.floor(seed / 360) % 5;
  const fill = `hsl(${hue} 55% 44%)`;
  const rim = `hsl(${hue} 60% 72%)`;
  const url = (iconRef as unknown as { iconUrl?: string } | undefined)?.iconUrl;
  if (ASSET_ICONS_ENABLED && typeof url === 'string' && url.length > 0) {
    return h('img', { src: url, width: size, height: size, alt: name, style: { width: size, height: size, objectFit: 'contain' } });
  }
  const children: VNode[] = [
    h('circle', { key: 'halo', cx: 16, cy: 16, r: 14.6, fill: `hsl(${hue} 55% 44% / 0.16)` }),
    shapeNode(h, shape, fill, rim),
  ];
  if (withLetter && size >= 14) {
    children.push(
      h(
        'text',
        {
          key: 'letter',
          x: 16,
          y: 17.2,
          textAnchor: 'middle',
          dominantBaseline: 'central',
          fontSize: 14,
          fontWeight: 700,
          fill: '#ffffff',
          style: { fontFamily: 'inherit', userSelect: 'none' },
        },
        initialOf(name),
      ),
    );
  }
  return h(
    'svg',
    {
      viewBox: '0 0 32 32',
      width: size,
      height: size,
      style: { display: 'block', flex: '0 0 auto', overflow: 'visible' },
      'aria-hidden': true,
    },
    children,
  );
}

// ---------------------------------------------------------------------------
// 通用小片段
// ---------------------------------------------------------------------------

function pct(current: number, max: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

function resourceColor(id: string): string {
  const seed = hashSeed(id);
  const hue = seed % 360;
  return `hsl(${hue} 60% 52%)`;
}

function statsText(item: ItemCardView): string {
  if (item.stats.length === 0) return '无词条';
  return item.stats.map((stat) => `${stat.name} ${stat.value >= 0 ? '+' : ''}${stat.value}`).join(' · ');
}

function accepts(slot: EquipmentSlotView, item: ItemCardView): boolean {
  return slot.accepts.includes('*') || item.tags.some((tag) => slot.accepts.includes(tag));
}

function statSumMap(items: ItemCardView[]): Map<string, { name: string; value: number }> {
  const sums = new Map<string, { name: string; value: number }>();
  for (const item of items) {
    for (const stat of item.stats) {
      const previous = sums.get(stat.statId);
      sums.set(stat.statId, { name: stat.name, value: (previous?.value ?? 0) + stat.value });
    }
  }
  return sums;
}

function actionCostText(action: SheetActionView, economy: CombatActionEconomyEntryView[]): string {
  const parts: string[] = [];
  for (const [id, amount] of Object.entries(action.cost.turn ?? {})) {
    const entry = economy.find((candidate) => candidate.id === id);
    parts.push(`${entry?.name ?? id}×${amount}`);
  }
  if (action.cost.resource !== undefined) parts.push(`资源 ${action.cost.resource.id}×${action.cost.resource.amount}`);
  return parts.length > 0 ? parts.join(' · ') : '无消耗';
}

function targetingText(action: SheetActionView): string {
  const type = labelOf(TYPE_LABELS, action.targeting.type);
  const range = typeof action.targeting.range === 'number' ? `${action.targeting.range}` : labelOf(RANGE_LABELS, String(action.targeting.range));
  return `${type} · ${range} · ${labelOf(SIDES_LABELS, action.targeting.sides)}`;
}

function actionNeedsTarget(action: SheetActionView): boolean {
  return action.targeting.type !== 'self' && action.targeting.type !== 'none' && action.targeting.type !== 'all';
}

function terrainStyle(legend: Map<string, CombatTerrainLegendView>, id: string): Record<string, unknown> {
  const entry = legend.get(id);
  const seed = hashSeed(id);
  const hue = seed % 360;
  const blocks = entry?.blocksMove === true;
  const light = blocks ? 16 : 30;
  return {
    background: `hsl(${hue} 24% ${light}%)`,
    border: '1px solid hsl(' + hue + ' 24% ' + (light + 8) + '%)',
    boxSizing: 'border-box',
  };
}

// ---------------------------------------------------------------------------
// React 工厂
// ---------------------------------------------------------------------------

export interface RulesUi {
  SidebarRulesSection: (props: { onOpenMain?: (view: MainViewKind) => void }) => VNode;
  CombatCompact: (props: { onOpenMain?: (view: MainViewKind) => void }) => VNode;
  RulesMainPanel: (props: { goHome?: () => void; readSession?: () => unknown }) => VNode;
}

export function createRulesUi(React: any, store: RulesStore): RulesUi {
  const h: H = React.createElement;
  const { useEffect, useMemo, useRef, useState } = React;

  function useSnapshot(): RulesSnapshot {
    const [snapshot, setSnapshot] = useState(() => store.getSnapshot() as RulesSnapshot);
    useEffect(() => {
      const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
      setSnapshot(store.getSnapshot());
      return unsubscribe;
    }, []);
    return snapshot as RulesSnapshot;
  }

  // ---------------------------------------------------------------- 通用小块

  /**
   * 渲染兜底：规则投影缺字段/宿主形状变化时，宁可显示一条中文错误也不整块白屏。
   * （主区域面板与右栏规则卡都套这一层。）
   */
  class RulesBoundary extends React.Component {
    constructor(props: unknown) {
      super(props as never);
      this.state = { error: null as unknown, stack: '' };
    }

    static getDerivedStateFromError(error: unknown): { error: unknown } {
      return { error };
    }

    componentDidCatch(error: unknown, info: unknown): void {
      try {
        const stack = typeof (info as { componentStack?: unknown })?.componentStack === 'string'
          ? String((info as { componentStack: string }).componentStack).slice(0, 1200)
          : '';
        this.setState({ error, stack });
        console.error('[dsh-trpg-table] 规则界面渲染失败', error, info);
      } catch {
        /* ignore */
      }
    }

    render(): VNode {
      const state = this.state as { error: unknown; stack: string };
      const error = state.error;
      if (error !== null && error !== undefined) {
        const text = error instanceof Error ? error.message : String(error);
        return h('div', { style: { ...ST.hint, margin: 12, color: 'var(--dsw-alias-state-error-primary)' } }, [
          h('strong', { key: 't', style: { fontSize: 12 } }, '规则界面渲染失败（已兜底，不影响对话）'),
          h('span', { key: 'm', style: { ...ST.small, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text),
          state.stack.length > 0 ? h('pre', { key: 's', style: { ...ST.tiny, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 } }, state.stack) : null,
          h('span', { key: 'h', style: ST.tiny }, '可以把这条信息反馈给房主；刷新页面后重试。'),
        ]);
      }
      return (this.props as { children?: VNode }).children;
    }
  }

  function Bar(props: { current: number; max: number; color?: string }): VNode {
    return h('div', { style: ST.bar }, [
      h('div', { key: 'f', style: { ...ST.barFill, width: `${pct(props.current, props.max)}%`, background: props.color ?? 'var(--dsw-alias-brand-primary)' } }),
    ]);
  }

  function Tag(props: { children?: unknown; title?: string; tone?: 'ok' | 'bad' | 'warn' }): VNode {
    const tone: Record<string, unknown> =
      props.tone === 'ok'
        ? { color: 'var(--dsw-alias-state-success-primary)' }
        : props.tone === 'bad'
          ? { color: 'var(--dsw-alias-state-error-primary)' }
          : props.tone === 'warn'
            ? { color: 'var(--dsw-alias-state-warning-primary)' }
            : {};
    return h('span', { style: { ...ST.tag, ...tone }, title: props.title }, props.children);
  }

  function Hint(props: { children?: unknown; tone?: 'bad' | 'warn' }): VNode {
    const color =
      props.tone === 'bad'
        ? 'var(--dsw-alias-state-error-primary)'
        : props.tone === 'warn'
          ? 'var(--dsw-alias-state-warning-primary)'
          : 'var(--dsw-alias-label-secondary)';
    return h('div', { style: { ...ST.hint, color } }, props.children);
  }

  function Notice(props: { notice: { tone: 'ok' | 'bad' | 'info'; title: string; lines: string[] }; onClose: () => void }): VNode {
    const color =
      props.notice.tone === 'bad'
        ? 'var(--dsw-alias-state-error-primary)'
        : props.notice.tone === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-label-secondary)';
    return h('div', { style: { ...ST.notice, borderColor: color } }, [
      h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
        h('strong', { key: 't', style: { color, fontSize: 11 } }, props.notice.title),
        h('button', { key: 'x', type: 'button', style: { ...ST.button, padding: '0 5px', fontSize: 10, marginLeft: 'auto' }, onClick: props.onClose }, '关闭'),
      ]),
      ...props.notice.lines.slice(0, 8).map((line, index) => h('span', { key: `l${index}`, style: { ...ST.tiny, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, line)),
    ]);
  }

  function GlobalBanners(props: { snapshot: RulesSnapshot; compact?: boolean }): VNode {
    const { snapshot } = props;
    const children: VNode[] = [];
    if (snapshot.pending !== null) children.push(h('span', { key: 'p', style: ST.muted }, snapshot.pending));
    if (snapshot.error !== null) {
      children.push(
        h('div', { key: 'e', style: { ...ST.bad, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          h('span', { key: 't', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, snapshot.error),
          h('button', { key: 'x', type: 'button', style: { ...ST.button, padding: '0 5px', fontSize: 10 }, onClick: () => store.dismissError() }, '知道了'),
        ]),
      );
    }
    if (snapshot.ruleError !== null) {
      children.push(
        h('div', { key: 'r', style: { ...ST.warn, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } }, [
          h('span', { key: 't', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, `规则提示：${snapshot.ruleError.text}${snapshot.ruleError.degraded ? '（已降级）' : ''}`),
          h('button', { key: 'x', type: 'button', style: { ...ST.button, padding: '0 5px', fontSize: 10 }, onClick: () => store.dismissError() }, '知道了'),
        ]),
      );
    }
    if (snapshot.notice !== null) children.push(h(Notice, { key: 'n', notice: snapshot.notice, onClose: () => store.dismissNotice() }));
    if (children.length === 0) return null;
    return h('div', { style: { ...ST.col, gap: 4 } }, children);
  }

  /** 弹药：目标玩家选择（房主可看/代管任意玩家）。 */
  function TargetPicker(props: { snapshot: RulesSnapshot }): VNode {
    const { snapshot } = props;
    const isHost = typeof snapshot.session?.hostToken === 'string';
    const players = snapshot.room?.players ?? [];
    if (!isHost || players.length <= 1) return null;
    return h(
      'select',
      {
        style: ST.select,
        value: snapshot.targetPlayerId ?? '',
        title: '房主可切换查看/操作哪位玩家的角色卡',
        onChange: (event: { target: { value: string } }) => store.setTargetPlayer(event.target.value),
      },
      players.map((player) =>
        h('option', { key: player.playerId, value: player.playerId }, `${player.displayName}${player.characterName ? `（${player.characterName}）` : ''}${player.playerId === 'host' ? ' · GM' : ''}`),
      ),
    );
  }

  // ---------------------------------------------------------------- 人物 · 紧凑

  function SheetCompact(): VNode {
    const snapshot = useSnapshot();
    const [openAttr, setOpenAttr] = useState(null as string | null);
    const sheet = snapshot.sheet;
    if (snapshot.sheetError !== null) return h(Hint, null, [h('span', { key: 't' }, `人物卡不可用：${snapshot.sheetError}`)]);
    if (sheet === null) return h(Hint, null, [h('span', { key: 't' }, snapshot.loading ? '正在读取人物卡…' : '暂无人物卡投影')]);
    const attributes = Object.entries(sheet.values.attributes);
    const derived = sheet.values.derived;
    const fields = Object.entries(sheet.fields)
      .filter(([key]) => !IDENTITY_FIELD_KEYS.has(key))
      .slice(0, 4);
    const children: VNode[] = [
      h('div', { key: 'id', style: { ...ST.row, gap: 8, alignItems: 'center' } }, [
        iconOrBadge(h, undefined, sheet.identity.name, 34),
        h('div', { key: 'txt', style: { ...ST.col, gap: 1, minWidth: 0 } }, [
          h('strong', { key: 'n', style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sheet.identity.name),
          h(
            'span',
            { key: 'sub', style: ST.muted },
            [sheet.identity.race, sheet.identity.class].filter((part) => typeof part === 'string' && part.length > 0).join(' · ') || '未注明种族职业',
          ),
        ]),
        h(Tag, { key: 'lv' }, `Lv.${sheet.identity.level}`),
      ]),
    ];
    // 资源条
    children.push(
      h(
        'div',
        { key: 'res', style: { ...ST.col, gap: 4 } },
        sheet.resources.map((resource) =>
          h('div', { key: resource.id, style: { ...ST.col, gap: 2 } }, [
            h('div', { key: 'l', style: { ...ST.row, justifyContent: 'space-between', gap: 4, fontSize: 11 } }, [
              h('span', { key: 'n', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, [
                iconOrBadge(h, resource.icon, resource.name, 12, false),
                resource.name,
              ]),
              h('span', { key: 'v', style: { ...ST.muted, fontVariantNumeric: 'tabular-nums' } }, `${resource.current}/${resource.max}`),
            ]),
            h(Bar, { key: 'b', current: resource.current, max: resource.max, color: resourceColor(resource.id) }),
          ]),
        ),
      ),
    );
    // 属性栅格（值 + 派生值；点开看解释）
    if (attributes.length > 0) {
      children.push(
        h(
          'div',
          { key: 'grid', style: ST.grid3 },
          attributes.map(([attributeId, value]) => {
            const modValue = derived[`mod.${attributeId}`];
            const active = openAttr === attributeId;
            return h(
              'button',
              {
                key: attributeId,
                type: 'button',
                style: { ...(active ? ST.buttonOn : ST.card), alignItems: 'flex-start', cursor: 'pointer', flexDirection: 'column', gap: 2, padding: 5 },
                title: '点击查看计算过程',
                onClick: () => setOpenAttr(active ? null : attributeId),
              },
              [
                h('span', { key: 'n', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, attrLabel(attributeId)),
                h('span', { key: 'v', style: { fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } }, String(value)),
                modValue !== undefined ? h('span', { key: 'm', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, `调整 ${String(modValue)}`) : null,
              ],
            );
          }),
        ),
      );
    }
    if (openAttr !== null) {
      const derivedEntries = Object.entries(derived).filter(([key]) => key === `mod.${openAttr}` || key.endsWith(`.${openAttr}`) || key === openAttr);
      children.push(
        h('div', { key: 'explain', style: ST.hint }, [
          h('strong', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-primary)' } }, `${attrLabel(openAttr)} = ${String(sheet.values.attributes[openAttr] ?? '—')}`),
          ...derivedEntries.map(([key, value]) => h('span', { key, style: ST.tiny }, `${derivedLabel(key)}：${String(value)}`)),
          h('span', { key: 'note', style: ST.tiny }, '派生值由 host 按规则包公式计算；客户端不推导。'),
        ]),
      );
    }
    // 技能
    if (sheet.skills.length > 0) {
      children.push(
        h('div', { key: 'skills', style: { ...ST.col, gap: 2 } }, [
          h('span', { key: 't', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, `技能 / 豁免（${sheet.skills.length}）`),
          ...sheet.skills.slice(0, 6).map((skill: SheetSkillView) =>
            h('div', { key: skill.id, style: { ...ST.row, justifyContent: 'space-between', fontSize: 11 } }, [
              h('span', { key: 'n', style: { display: 'inline-flex', alignItems: 'center', gap: 3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [
                skill.proficient ? h('span', { key: 'p', style: { color: 'var(--dsw-alias-state-warning-primary)' } }, '★') : null,
                skill.name,
              ]),
              h('span', { key: 'v', style: { ...ST.muted, fontVariantNumeric: 'tabular-nums' } }, `${skill.total >= 0 ? '+' : ''}${skill.total}`),
            ]),
          ),
        ]),
      );
    }
    // 状态
    children.push(
      h('div', { key: 'status', style: ST.row }, [
        h('span', { key: 't', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, '状态：'),
        sheet.statuses.length === 0
          ? h('span', { key: 'none', style: ST.tiny }, '无状态')
          : h(
              'span',
              { key: 'list', style: { display: 'inline-flex', gap: 4, flexWrap: 'wrap' } },
              sheet.statuses.map((status: SheetStatusView) =>
                h(Tag, { key: status.id, tone: 'warn', title: status.name }, `${status.name}${status.stacks !== undefined && status.stacks > 1 ? `×${status.stacks}` : ''}${status.remaining !== undefined ? ` 剩${status.remaining}轮` : ''}`),
              ),
            ),
      ]),
    );
    // 动作（只读摘要；战斗视图里执行）
    if (sheet.actions.length > 0) {
      const available = sheet.actions.filter((action) => action.available).length;
      children.push(
        h('div', { key: 'actions', style: { ...ST.col, gap: 3 } }, [
          h('span', { key: 't', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, `动作（可用 ${available}/${sheet.actions.length}）`),
          h(
            'div',
            { key: 'chips', style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            sheet.actions.map((action) =>
              h(
                'span',
                {
                  key: action.actionId,
                  title: action.available ? `${targetingText(action)} · ${actionCostText(action, snapshot.combat?.actionEconomy.remaining ?? [])}` : action.reason ?? '不可用',
                  style: {
                    ...ST.tag,
                    opacity: action.available ? 1 : 0.5,
                    color: action.available ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  },
                },
                `${action.name}${action.available ? '' : '（不可用）'}`,
              ),
            ),
          ),
        ]),
      );
    }
    // 背景叙事字段
    if (fields.length > 0) {
      children.push(
        h(
          'div',
          { key: 'fields', style: { ...ST.col, gap: 2 } },
          fields.map(([key, value]) =>
            h('div', { key, style: { ...ST.row, fontSize: 11, alignItems: 'flex-start' } }, [
              h('span', { key: 'k', style: { ...ST.muted, flex: '0 0 48px' } }, fieldLabel(key)),
              h('span', { key: 'v', style: { ...ST.small, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, String(value)),
            ]),
          ),
        ),
      );
    }
    return h('div', { style: { ...ST.col, gap: 8 } }, children);
  }

  // ---------------------------------------------------------------- 装备 · 紧凑

  function EquipmentCompact(): VNode {
    const snapshot = useSnapshot();
    const sheet = snapshot.sheet;
    if (sheet === null) return h(Hint, null, [h('span', { key: 't' }, snapshot.sheetError ?? '暂无装备投影')]);
    const slots = sheet.equipment.slots;
    const selectedSlot = slots.find((slot) => slot.slotId === snapshot.selectedSlotId) ?? null;
    const candidates = selectedSlot === null
      ? []
      : sheet.items.filter((item) => item.equippedSlot !== selectedSlot.slotId && accepts(selectedSlot, item));
    const full = selectedSlot !== null && selectedSlot.count >= selectedSlot.capacity;
    const children: VNode[] = [
      h(
        'div',
        { key: 'slots', style: ST.grid2 },
        slots.map((slot) =>
          h(
            'button',
            {
              key: slot.slotId,
              type: 'button',
              style: { ...(snapshot.selectedSlotId === slot.slotId ? ST.buttonOn : ST.card), flexDirection: 'column', alignItems: 'stretch', gap: 3, cursor: 'pointer', padding: 5 },
              title: `槽位：${slot.name}（容量 ${slot.capacity}）`,
              onClick: () => store.selectSlot(snapshot.selectedSlotId === slot.slotId ? null : slot.slotId),
            },
            [
              h('span', { key: 'head', style: { ...ST.row, gap: 4 } }, [iconOrBadge(h, slot.icon, slot.name, 14), h('span', { key: 'n', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, slot.name)]),
              slot.items.length === 0
                ? h('span', { key: 'empty', style: { ...ST.tiny, border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 6, padding: '4px 3px', textAlign: 'center' } }, '空槽')
                : h(
                    'span',
                    { key: 'items', style: { ...ST.col, gap: 2 } },
                    slot.items.map((item) =>
                      h('span', { key: item.instanceId, style: { ...ST.row, gap: 3 } }, [iconOrBadge(h, item.icon, item.name, 13), h('span', { key: 'n', style: { ...ST.tiny, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name)]),
                    ),
                  ),
              h('span', { key: 'cap', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, `容量 ${slot.count}/${slot.capacity}`),
            ],
          ),
        ),
      ),
    ];
    if (selectedSlot !== null) {
      const compareRow: VNode[] = [];
      const before = statSumMap(selectedSlot.items);
      if (snapshot.selectedItemId !== null) {
        const candidate = candidates.find((item) => item.instanceId === snapshot.selectedItemId);
        if (candidate !== undefined) {
          const diffs: string[] = [];
          for (const stat of candidate.stats) {
            const current = before.get(stat.statId)?.value ?? 0;
            const delta = stat.value;
            diffs.push(`${stat.name} ${current >= 0 ? '+' : ''}${current} → ${current + delta >= 0 ? '+' : ''}${current + delta}（${delta >= 0 ? '+' : ''}${delta}）`);
          }
          compareRow.push(
            h('div', { key: 'cmp', style: ST.hint }, [
              h('strong', { key: 't', style: { fontSize: 11, color: 'var(--dsw-alias-label-primary)' } }, `试算：${candidate.name} → ${selectedSlot.name}`),
              ...diffs.slice(0, 6).map((line, index) => h('span', { key: `d${index}`, style: ST.tiny }, line)),
              h('span', { key: 'note', style: ST.tiny }, '仅按 DTO stats 求和（非规则推导）；确认后由 host 校验并重算。'),
            ]),
          );
        }
      }
      children.push(
        h('div', { key: 'picker', style: { ...ST.card, gap: 5 } }, [
          h('strong', { key: 't', style: { fontSize: 11 } }, `放入「${selectedSlot.name}」（可接受标签：${selectedSlot.accepts.map(tagLabel).join(' / ') || '无'}）`),
          full ? h('span', { key: 'full', style: ST.bad }, `槽已满（${selectedSlot.count}/${selectedSlot.capacity}）：需先卸下现有装备再装备（host 会拒绝直接换装）`) : null,
          ...selectedSlot.items.map((item) =>
            h('div', { key: item.instanceId, style: { ...ST.row, justifyContent: 'space-between' } }, [
              h('span', { key: 'n', style: { ...ST.small, display: 'inline-flex', gap: 4, alignItems: 'center' } }, [iconOrBadge(h, item.icon, item.name, 14), item.name]),
              h('span', { key: 'b', style: { display: 'inline-flex', gap: 4 } }, [
                item.count > 1 ? h(Tag, { key: 'q' }, `×${item.count}`) : null,
                h('button', { key: 'u', type: 'button', style: ST.button, onClick: () => void store.unequip(selectedSlot.slotId, item.instanceId) }, '卸下'),
              ]),
            ]),
          ),
          candidates.length === 0 ? h('span', { key: 'none', style: ST.muted }, '没有符合该槽标签的物品') : null,
          ...candidates.map((item) =>
            h('div', { key: item.instanceId, style: { ...ST.row, justifyContent: 'space-between' } }, [
              h('span', { key: 'n', style: { ...ST.small, display: 'inline-flex', gap: 4, alignItems: 'center', minWidth: 0 } }, [
                iconOrBadge(h, item.icon, item.name, 14),
                h('span', { key: 'x', style: { minWidth: 0 } }, item.name),
                h('span', { key: 's', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, statsText(item)),
              ]),
              h('span', { key: 'b', style: { display: 'inline-flex', gap: 4 } }, [
                h('button', { key: 'c', type: 'button', style: ST.button, onClick: () => store.selectItem(snapshot.selectedItemId === item.instanceId ? null : item.instanceId) }, '试算'),
                h(
                  'button',
                  {
                    key: 'e',
                    type: 'button',
                    style: full ? ST.buttonDisabled : ST.buttonPrimary,
                    disabled: full || snapshot.pending !== null,
                    onClick: () => void store.equip(selectedSlot.slotId, item.instanceId),
                  },
                  '装备',
                ),
              ]),
            ]),
          ),
          ...compareRow,
        ]),
      );
    }
    // 词条总览 + 来源分解
    if (sheet.equipment.statTotals.length > 0) {
      children.push(
        h('div', { key: 'totals', style: { display: 'flex', flexWrap: 'wrap', gap: 4 } }, [
          ...sheet.equipment.statTotals.map((total) =>
            h('span', { key: total.statId, style: { ...ST.tag, color: 'var(--dsw-alias-label-primary)' } }, `${total.name} ${total.total >= 0 ? '+' : ''}${total.total}`),
          ),
        ]),
      );
    }
    if ((sheet.equipment.trace ?? []).length > 0) {
      children.push(
        h('div', { key: 'trace', style: { ...ST.col, gap: 2 } }, [
          h('span', { key: 't', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, '来源分解（host 计算）'),
          ...(sheet.equipment.trace ?? []).slice(0, 4).map((entry) =>
            h('span', { key: entry.statId, style: ST.tiny }, `${entry.statId} +${entry.total}：${entry.parts.map((part) => `${part.sourceName} ${part.value >= 0 ? '+' : ''}${part.value}（${part.stack}）`).join(' · ')}`),
          ),
        ]),
      );
    }
    return h('div', { style: { ...ST.col, gap: 8 } }, children);
  }

  // ---------------------------------------------------------------- 背包 · 紧凑

  function bagItems(sheet: SheetView): ItemCardView[] {
    return sheet.items;
  }

  function filteredItems(snapshot: RulesSnapshot): ItemCardView[] {
    const sheet = snapshot.sheet;
    if (sheet === null) return [];
    const query = snapshot.bagQuery.trim().toLowerCase();
    const items = bagItems(sheet).filter((item) => {
      if (snapshot.bagCategory !== 'all' && !item.tags.includes(snapshot.bagCategory)) return false;
      if (query.length === 0) return true;
      const haystack = [item.name, item.rarityName ?? '', item.description ?? '', ...item.tags.map(tagLabel)].join(' ').toLowerCase();
      return haystack.includes(query);
    });
    const sorted = [...items];
    if (snapshot.bagSort === 'rarity') {
      sorted.sort((left, right) => (right.rarityName ?? '').localeCompare(left.rarityName ?? '', 'zh-Hans-CN'));
    } else {
      sorted.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    }
    return sorted;
  }

  function BagCategoryRow(props: { snapshot: RulesSnapshot }): VNode {
    const snapshot = props.snapshot;
    const items = snapshot.sheet?.items ?? [];
    const tags = Array.from(new Set(items.flatMap((item) => item.tags))).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
    return h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
      [
        h(
          'button',
          { key: 'all', type: 'button', style: snapshot.bagCategory === 'all' ? ST.buttonOn : ST.button, onClick: () => store.setBagFilter({ category: 'all' }) },
          `全部 ${items.length}`,
        ),
        ...tags.map((tag) =>
          h(
            'button',
            { key: tag, type: 'button', style: snapshot.bagCategory === tag ? ST.buttonOn : ST.button, onClick: () => store.setBagFilter({ category: tag }) },
            `${tagLabel(tag)} ${items.filter((item) => item.tags.includes(tag)).length}`,
          ),
        ),
      ],
    );
  }

  function ItemDetailCompact(props: { item: ItemCardView; snapshot: RulesSnapshot }): VNode {
    const { item, snapshot } = props;
    const sheet = snapshot.sheet;
    const compatibleSlots = (sheet?.equipment.slots ?? []).filter((slot) => accepts(slot, item) && item.equippedSlot !== slot.slotId);
    return h('div', { style: { ...ST.card, gap: 5 } }, [
      h('div', { key: 'h', style: { ...ST.row, gap: 6 } }, [
        iconOrBadge(h, item.icon, item.name, 26),
        h('div', { key: 'x', style: { ...ST.col, gap: 1, minWidth: 0 } }, [
          h('strong', { key: 'n', style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
          h('span', { key: 'r', style: ST.tiny }, [item.rarityName ?? item.rarity, ...item.tags.map(tagLabel)].filter(Boolean).join(' · ') || '无标签'),
        ]),
      ]),
      h('span', { key: 'stats', style: ST.small }, statsText(item)),
      item.description !== undefined ? h('span', { key: 'desc', style: { ...ST.tiny, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, item.description) : null,
      h('div', { key: 'acts', style: ST.row }, [
        ...compatibleSlots.slice(0, 2).map((slot) =>
          h('button', { key: slot.slotId, type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null, onClick: () => void store.equip(slot.slotId, item.instanceId) }, `装备到${slot.name}`),
        ),
        h('button', { key: 'use', type: 'button', style: ST.button, disabled: snapshot.pending !== null, title: '由 host 按规则包 items[].useAction 结算', onClick: () => void store.useItem(item.instanceId) }, '使用'),
      ]),
      h('span', { key: 'note', style: ST.tiny }, '丢弃 / 拆分：后端本版未提供命令，按钮隐藏。'),
    ]);
  }

  function BagCompact(): VNode {
    const snapshot = useSnapshot();
    const sheet = snapshot.sheet;
    if (sheet === null) return h(Hint, null, [h('span', { key: 't' }, snapshot.sheetError ?? '暂无背包投影')]);
    const items = filteredItems(snapshot);
    const selected = items.find((item) => item.instanceId === snapshot.selectedItemId) ?? null;
    const capacity = snapshot.inventory?.capacity;
    return h('div', { style: { ...ST.col, gap: 8 } }, [
      h(BagCategoryRow, { key: 'cat', snapshot }),
      h('div', { key: 'tools', style: ST.row }, [
        h('input', {
          key: 'q',
          style: { ...ST.input, flex: '1 1 90px', width: 'auto' },
          value: snapshot.bagQuery,
          placeholder: '搜索名字/标签/描述',
          onChange: (event: { target: { value: string } }) => store.setBagFilter({ query: event.target.value }),
        }),
        h(
          'select',
          { key: 's', style: { ...ST.select, flex: '0 0 74px', width: 'auto' }, value: snapshot.bagSort, onChange: (event: { target: { value: string } }) => store.setBagFilter({ sort: event.target.value === 'rarity' ? 'rarity' : 'name' }) },
          [h('option', { key: 'name', value: 'name' }, '按名字'), h('option', { key: 'rarity', value: 'rarity' }, '按稀有度')],
        ),
      ]),
      capacity !== undefined
        ? h('div', { key: 'cap', style: { ...ST.col, gap: 2 } }, [
            h('span', { key: 't', style: ST.tiny }, `容量 ${capacity.used}/${capacity.max}${capacity.unit !== undefined ? ` ${capacity.unit}` : ''}`),
            h(Bar, { key: 'b', current: capacity.used, max: capacity.max }),
          ])
        : null,
      h(
        'div',
        { key: 'grid', style: ST.grid4 },
        items.map((item) =>
          h(
            'button',
            {
              key: item.instanceId,
              type: 'button',
              style: {
                ...(snapshot.selectedItemId === item.instanceId ? ST.buttonOn : ST.card),
                alignItems: 'center',
                padding: 4,
                position: 'relative',
                cursor: 'pointer',
                flexDirection: 'column',
                gap: 2,
              },
              title: `${item.name}${item.equippedSlot !== undefined ? '（已装备）' : ''}`,
              onClick: () => store.selectItem(snapshot.selectedItemId === item.instanceId ? null : item.instanceId),
            },
            [
              iconOrBadge(h, item.icon, item.name, 24),
              h('span', { key: 'n', style: { ...ST.tiny, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
              item.count > 1 ? h('span', { key: 'q', style: { position: 'absolute', right: 2, top: 2, fontSize: 9, ...ST.tag, padding: '0 3px' } }, `×${item.count}`) : null,
            ],
          ),
        ),
      ),
      items.length === 0 ? h('span', { key: 'none', style: ST.muted }, '当前筛选下没有物品') : null,
      selected !== null ? h(ItemDetailCompact, { key: 'detail', item: selected, snapshot }) : h('span', { key: 'hint', style: ST.tiny }, '点物品查看详情/装备/使用'),
    ]);
  }

  // ---------------------------------------------------------------- 右栏子页签容器

  function SidebarRulesSection(props: { onOpenMain?: (view: MainViewKind) => void }): VNode {
    const snapshot = useSnapshot();
    const [tab, setTab] = useState('sheet' as 'sheet' | 'equip' | 'bag');
    const rules = snapshot.rules;
    if (rules === null) return null;
    const pending = snapshot.pending !== null;
    const body = snapshot.degraded
      ? h(Hint, { tone: 'warn' }, [
          h('strong', { key: 't', style: { fontSize: 11 } }, '规则不可用（降级）'),
          h('span', { key: 'x' }, `规则包「${rules.rulesId}@${rules.rulesVersion}」当前不可用：房间仍可继续叙事团，但人物/装备/背包/战斗暂不可用。`),
        ])
      : tab === 'sheet'
        ? h(SheetCompact, { key: 'sheet' })
        : tab === 'equip'
          ? h(EquipmentCompact, { key: 'equip' })
          : h(BagCompact, { key: 'bag' });
    const applyable = !snapshot.degraded;
    return h('div', { style: ST.section }, [
      h('style', { key: 'kf' }, KEYFRAMES),
      h('div', { key: 'hd', style: { ...ST.row, gap: 5 } }, [
        h('strong', { key: 't', style: { fontSize: 12 } }, '规则卡面'),
        h(Tag, { key: 'tag', title: '房间引用的规则包' }, `${rules.name ?? rules.rulesId} v${rules.rulesVersion}`),
        snapshot.loading ? h('span', { key: 'l', style: ST.muted }, '读取中…') : null,
        h(
          'button',
          { key: 'refresh', type: 'button', style: { ...ST.button, marginLeft: 'auto' }, disabled: !applyable || pending, onClick: () => void store.refresh() },
          pending ? '处理中…' : '刷新',
        ),
      ]),
      h(TargetPicker, { key: 'target', snapshot }),
      h(
        'div',
        { key: 'tabs', style: { ...ST.row, gap: 3, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 4 } },
        ([
          ['sheet', '人物'],
          ['equip', '装备'],
          ['bag', '背包'],
        ] as Array<['sheet' | 'equip' | 'bag', string]>).map(([id, label]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              style: { ...(tab === id ? ST.buttonOn : ST.button), padding: '2px 8px' },
              onClick: () => setTab(id),
            },
            label,
          ),
        ),
      ),
      h(GlobalBanners, { key: 'banners', snapshot, compact: true }),
      applyable ? body : null,
      h('div', { key: 'foot', style: { ...ST.row, gap: 4 } }, [
        h(
          'button',
          { key: 'detail', type: 'button', style: { ...ST.buttonPrimary, flex: '1 1 auto' }, disabled: !applyable, onClick: () => props.onOpenMain?.(tab) },
          '详细 ›',
        ),
        snapshot.mapAvailable && !snapshot.degraded
          ? h('button', { key: 'map', type: 'button', style: ST.button, onClick: () => props.onOpenMain?.('map') }, '世界地图')
          : null,
        !snapshot.degraded
          ? h('button', { key: 'combat', type: 'button', style: ST.button, onClick: () => props.onOpenMain?.('combat') }, '战斗视图')
          : null,
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 右栏战斗紧凑条

  function CombatCompact(props: { onOpenMain?: (view: MainViewKind) => void }): VNode {
    const snapshot = useSnapshot();
    const [enemyName, setEnemyName] = useState('血尸');
    const rules = snapshot.rules;
    const combat = snapshot.combat;
    if (rules === null || snapshot.degraded || combat === null) return null;
    const isHost = typeof snapshot.session?.hostToken === 'string';
    const active = combat.tokens.find((token: CombatTokenView) => token.actorId === combat.activeActorId);
    const myActorId = snapshot.sheet?.actorId;
    const myTurn = combat.activeActorId !== null && myActorId !== undefined && combat.activeActorId === myActorId;
    return h('div', { style: ST.section }, [
      h('div', { key: 'hd', style: { ...ST.row, gap: 5 } }, [
        h('strong', { key: 't', style: { fontSize: 12 } }, '战斗'),
        h(Tag, { key: 'state', tone: combat.active ? 'ok' : undefined }, combat.active ? `进行中 · 第 ${combat.round}/${combat.maxRounds || '∞'} 回合` : '未开战'),
        combat.cols > 0 ? h(Tag, { key: 'map', title: combat.mapId }, `地图 ${combat.cols}×${combat.rows}`) : h(Tag, { key: 'tom' }, 'theater-of-mind'),
        h('button', { key: 'open', type: 'button', style: { ...ST.button, marginLeft: 'auto' }, onClick: () => props.onOpenMain?.('combat') }, '查看 ›'),
      ]),
      combat.active
        ? h('div', { key: 'body', style: { ...ST.col, gap: 5 } }, [
            h('span', { key: 'active', style: ST.small }, `当前行动者：${active?.name ?? '无'}${myTurn ? '（你）' : ''}`),
            h(
              'div',
              { key: 'econ', style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
              combat.actionEconomy.remaining.map((entry) =>
                h(
                  'span',
                  {
                    key: entry.id,
                    title: `${entry.name}：${entry.current}/${entry.max}${entry.unit !== undefined ? ` ${entry.unit}` : ''}`,
                    style: { ...ST.tag, opacity: entry.current > 0 ? 1 : 0.5, color: entry.current > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)' },
                  },
                  `${entry.name} ${entry.current}/${entry.max}${entry.unit ?? ''}`,
                ),
              ),
            ),
            h('div', { key: 'acts', style: ST.row }, [
              h('button', { key: 'turn', type: 'button', style: myTurn || isHost ? ST.button : ST.buttonDisabled, disabled: !(myTurn || isHost) || snapshot.pending !== null, onClick: () => void store.endTurn() }, '结束回合'),
              isHost ? h('button', { key: 'end', type: 'button', style: ST.button, disabled: snapshot.pending !== null, onClick: () => void store.endCombat() }, '结束战斗') : null,
              h('button', { key: 'view', type: 'button', style: ST.button, onClick: () => props.onOpenMain?.('combat') }, '战斗视图'),
            ]),
            h(GlobalBanners, { key: 'banners', snapshot, compact: true }),
          ])
        : h('div', { key: 'idle', style: { ...ST.col, gap: 4 } }, [
            isHost
              ? h('div', { key: 'start', style: ST.row }, [
                  h('input', { key: 'name', style: { ...ST.input, flex: '1 1 80px', width: 'auto' }, value: enemyName, placeholder: '敌人名', onChange: (event: { target: { value: string } }) => setEnemyName(event.target.value) }),
                  h('button', { key: 'go', type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null || enemyName.trim().length === 0, onClick: () => void store.startCombat(enemyName.trim()) }, '发起战斗'),
                ])
              : h('span', { key: 'wait', style: ST.muted }, '等待 GM 发起战斗'),
            (combat.warnings ?? []).map((warning, index) => h('span', { key: `w${index}`, style: ST.tiny }, warning)),
            h('button', { key: 'view2', type: 'button', style: ST.button, onClick: () => props.onOpenMain?.('combat') }, '打开战斗视图'),
          ]),
    ]);
  }

  // ---------------------------------------------------------------- 主区域 · 人物详情

  function SheetDetail(): VNode {
    const snapshot = useSnapshot();
    const [openAttr, setOpenAttr] = useState(null as string | null);
    const [checkDc, setCheckDc] = useState(12);
    const sheet = snapshot.sheet;
    if (sheet === null) {
      return h(Hint, null, [
        h('strong', { key: 't', style: { fontSize: 12 } }, '人物卡不可用'),
        h('span', { key: 'x' }, snapshot.sheetError ?? '正在读取人物卡…'),
        h('span', { key: 'hint' }, '房主需要先在右栏「落座」；玩家需要先加入房间并落座。'),
      ]);
    }
    const attributes = Object.entries(sheet.values.attributes);
    const derivedEntries = Object.entries(sheet.values.derived);
    const hue = hashSeed(sheet.identity.name) % 360;
    const media = h('div', { key: 'media', style: { ...ST.media, background: `radial-gradient(circle at 30% 20%, hsl(${hue} 45% 32%), hsl(${(hue + 40) % 360} 40% 14%) 70%)` } }, [
      h('div', { key: 'badge', style: { transform: 'scale(2.1)', opacity: 0.92 } }, iconOrBadge(h, undefined, sheet.identity.name, 46)),
      h('span', { key: 'note', style: { position: 'absolute', bottom: 4, left: 0, right: 0, textAlign: 'center', fontSize: 9, color: 'rgba(255,255,255,.72)' } }, '立绘/头像资源未上线：程序化徽记'),
    ]);
    const left = h('div', { key: 'l', style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'id', style: { ...ST.card, gap: 6 } }, [
        media,
        h('div', { key: 'txt', style: { ...ST.row, gap: 6 } }, [
          h('strong', { key: 'n', style: { fontSize: 15 } }, sheet.identity.name),
          h(Tag, { key: 'lv' }, `Lv.${sheet.identity.level}`),
          h(Tag, { key: 'rc' }, [sheet.identity.race, sheet.identity.class].filter(Boolean).join(' · ') || '未注明'),
        ]),
        h('span', { key: 'cardid', style: ST.tiny }, `卡 ${sheet.cardId} · 行动者 ${sheet.actorId}`),
      ]),
      h('div', { key: 'res', style: ST.panel }, [
        h('div', { key: 't', style: ST.panelTitle }, '资源'),
        ...sheet.resources.map((resource) =>
          h('div', { key: resource.id, style: { ...ST.col, gap: 3 } }, [
            h('div', { key: 'l', style: { ...ST.row, justifyContent: 'space-between', fontSize: 12 } }, [
              h('span', { key: 'n', style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, [iconOrBadge(h, resource.icon, resource.name, 16, false), resource.name]),
              h('span', { key: 'v', style: { ...ST.muted, fontVariantNumeric: 'tabular-nums' } }, `${resource.current} / ${resource.max}`),
            ]),
            h(Bar, { key: 'b', current: resource.current, max: resource.max, color: resourceColor(resource.id) }),
          ]),
        ),
        sheet.resources.length === 0 ? h('span', { key: 'none', style: ST.muted }, '无资源条') : null,
      ]),
      h('div', { key: 'status', style: ST.panel }, [
        h('div', { key: 't', style: ST.panelTitle }, '状态'),
        sheet.statuses.length === 0
          ? h('span', { key: 'none', style: ST.muted }, '无状态')
          : h(
              'div',
              { key: 'list', style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
              sheet.statuses.map((status) =>
                h('span', { key: status.id, style: { ...ST.tag, padding: '2px 8px', fontSize: 11, color: 'var(--dsw-alias-state-warning-primary)' } }, [
                  iconOrBadge(h, status.icon, status.name, 13),
                  `${status.name}${status.stacks !== undefined && status.stacks > 1 ? ` ×${status.stacks}` : ''}${status.remaining !== undefined ? ` · 剩 ${status.remaining} 轮` : ''}`,
                ]),
              ),
            ),
      ]),
      h('div', { key: 'fields', style: ST.panel }, [
        h('div', { key: 't', style: ST.panelTitle }, '背景 / 叙事字段'),
        Object.entries(sheet.fields).filter(([key]) => !IDENTITY_FIELD_KEYS.has(key)).length === 0
          ? h('span', { key: 'none', style: ST.muted }, '规则包没有给叙事字段')
          : h(
              'div',
              { key: 'list', style: { ...ST.col, gap: 6 } },
              Object.entries(sheet.fields)
                .filter(([key]) => !IDENTITY_FIELD_KEYS.has(key))
                .map(([key, value]) =>
                  h('div', { key, style: { ...ST.col, gap: 1 } }, [
                    h('span', { key: 'k', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, fieldLabel(key)),
                    h('span', { key: 'v', style: ST.bigText }, String(value)),
                  ]),
                ),
            ),
      ]),
      (sheet.warnings ?? []).length > 0
        ? h('div', { key: 'warn', style: ST.panel }, [
            h('div', { key: 't', style: ST.panelTitle }, 'host 降级提示'),
            ...(sheet.warnings ?? []).map((warning, index) => h('span', { key: `w${index}`, style: ST.warn }, warning)),
          ])
        : null,
    ]);
    const attrGrid = h('div', { key: 'attr', style: { ...ST.col, gap: 8 } }, [
      h('div', { key: 't', style: ST.panelTitle }, '属性（点格子看计算过程）'),
      h(
        'div',
        { key: 'grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 } },
        attributes.map(([attributeId, value]) => {
          const modValue = sheet.values.derived[`mod.${attributeId}`];
          const active = openAttr === attributeId;
          return h(
            'button',
            {
              key: attributeId,
              type: 'button',
              style: { ...(active ? ST.buttonOn : ST.panel), alignItems: 'flex-start', cursor: 'pointer', flexDirection: 'column', gap: 2, padding: 8 },
              onClick: () => setOpenAttr(active ? null : attributeId),
            },
            [
              h('span', { key: 'n', style: { ...ST.tiny, color: 'var(--dsw-alias-label-secondary)' } }, attrLabel(attributeId)),
              h('span', { key: 'v', style: { fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums' } }, String(value)),
              h('span', { key: 'm', style: ST.tiny }, modValue !== undefined ? `调整 ${String(modValue)}` : '无派生调整'),
            ],
          );
        }),
      ),
      openAttr !== null
        ? h('div', { key: 'explain', style: { ...ST.hint, gap: 6 } }, [
            h('strong', { key: 't', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, `${attrLabel(openAttr)} = ${String(sheet.values.attributes[openAttr] ?? '—')}`),
            ...Object.entries(sheet.values.derived)
              .filter(([key]) => key === `mod.${openAttr}` || key.endsWith(`.${openAttr}`) || key === openAttr)
              .map(([key, value]) => h('span', { key, style: ST.small }, `${derivedLabel(key)}：${String(value)}`)),
            h('span', { key: 'all', style: ST.small }, `当前全部派生值：${derivedEntries.map(([key, value]) => `${derivedLabel(key)}=${String(value)}`).join('；') || '无'}`),
            h('span', { key: 'note', style: ST.tiny }, '以上由 host 按规则包公式计算后下发（docs/RULES-MODEL §8）；客户端不推导、不预测。'),
          ])
        : null,
    ]);
    const skillsPanel = h('div', { key: 'skills', style: ST.panel }, [
      h('div', { key: 'h', style: { ...ST.row, gap: 6 } }, [
        h('div', { key: 't', style: ST.panelTitle }, `技能 / 豁免（${sheet.skills.length}）`),
        h(
          'select',
          { key: 'dc', style: { ...ST.select, width: 'auto', marginLeft: 'auto' }, value: String(checkDc), title: '检定 DC', onChange: (event: { target: { value: string } }) => setCheckDc(Number.parseInt(event.target.value, 10) || 12) },
          [10, 12, 15, 18].map((dc) => h('option', { key: dc, value: String(dc) }, `DC ${dc}`)),
        ),
      ]),
      h(
        'div',
        { key: 'table', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4 } },
        sheet.skills.map((skill: SheetSkillView) =>
          h('div', { key: skill.id, style: { ...ST.row, justifyContent: 'space-between', gap: 6, borderBottom: '1px dashed var(--dsw-alias-border-l2)', padding: '3px 0' } }, [
            h('span', { key: 'n', style: { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 } }, [
              skill.icon !== undefined ? iconOrBadge(h, skill.icon, skill.name, 14) : h('span', { key: 'd', style: { width: 14, textAlign: 'center', color: 'var(--dsw-alias-state-warning-primary)' } }, skill.proficient ? '★' : '·'),
              h('span', { key: 'x', style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, skill.name),
              skill.attribute !== undefined ? h('span', { key: 'a', style: ST.tiny }, attrLabel(skill.attribute)) : null,
            ]),
            h('span', { key: 'v', style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
              h('span', { key: 'total', style: { fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, `${skill.total >= 0 ? '+' : ''}${skill.total}`),
              h('button', { key: 'check', type: 'button', style: { ...ST.button, padding: '1px 6px', fontSize: 10 }, disabled: snapshot.pending !== null, title: '请求 host 掷检定（客户端不本地掷）', onClick: () => void store.rollCheck(skill.id, checkDc) }, '检定'),
            ]),
          ]),
        ),
      ),
      sheet.skills.length === 0 ? h('span', { key: 'none', style: ST.muted }, '规则包没有技能表') : null,
    ]);
    const actionsPanel = h('div', { key: 'actions', style: ST.panel }, [
      h('div', { key: 't', style: ST.panelTitle }, `动作（可用 ${sheet.actions.filter((action) => action.available).length}/${sheet.actions.length}）`),
      sheet.actions.length === 0
        ? h('span', { key: 'none', style: ST.muted }, '规则包没有动作定义')
        : h(
            'div',
            { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            sheet.actions.map((action) =>
              h(
                'div',
                { key: action.actionId, style: { ...ST.card, gap: 3, opacity: action.available ? 1 : 0.65 } },
                [
                  h('div', { key: 'row', style: { ...ST.row, gap: 6 } }, [
                    iconOrBadge(h, action.icon, action.name, 18),
                    h('strong', { key: 'n', style: { fontSize: 12 } }, action.name),
                    h(Tag, { key: 'k' }, labelOf(KIND_LABELS, action.kind)),
                    h(Tag, { key: 'tgt' }, targetingText(action)),
                    h(Tag, { key: 'cost' }, actionCostText(action, snapshot.combat?.actionEconomy.remaining ?? [])),
                    action.available
                      ? h(
                          'button',
                          {
                            key: 'use',
                            type: 'button',
                            style: { ...ST.buttonPrimary, marginLeft: 'auto' },
                            disabled: snapshot.pending !== null,
                            onClick: () => {
                              store.selectAction(action.actionId);
                              store.setMainView('combat');
                            },
                          },
                          '选为战斗动作',
                        )
                      : h('span', { key: 'reason', style: { ...ST.bad, marginLeft: 'auto' } }, action.reason ?? '不可用'),
                  ]),
                  action.description !== undefined ? h('span', { key: 'd', style: ST.tiny }, action.description) : null,
                ],
              ),
            ),
          ),
    ]);
    const right = h('div', { key: 'r', style: { ...ST.col, gap: 10 } }, [attrGrid, skillsPanel, actionsPanel]);
    return h('div', { style: ST.twoCol }, [left, right]);
  }

  // ---------------------------------------------------------------- 主区域 · 装备详情

  function EquipmentDetail(): VNode {
    const snapshot = useSnapshot();
    const sheet = snapshot.sheet;
    if (sheet === null) return h(Hint, null, [h('span', { key: 't' }, snapshot.sheetError ?? '暂无装备投影')]);
    const slots = sheet.equipment.slots;
    const selected = slots.find((slot) => slot.slotId === snapshot.selectedSlotId) ?? null;
    const candidates = selected === null ? [] : sheet.items.filter((item) => item.equippedSlot !== selected.slotId && accepts(selected, item));
    const incompatible = selected === null ? [] : sheet.items.filter((item) => item.equippedSlot !== selected.slotId && !accepts(selected, item));
    const full = selected !== null && selected.count >= selected.capacity;
    const before = selected === null ? new Map() : statSumMap(selected.items);
    const candidate = selected === null || snapshot.selectedItemId === null ? null : candidates.find((item) => item.instanceId === snapshot.selectedItemId) ?? null;
    const slotGrid = h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 } },
      slots.map((slot) => {
        const active = snapshot.selectedSlotId === slot.slotId;
        return h(
          'button',
          {
            key: slot.slotId,
            type: 'button',
            style: { ...(active ? ST.buttonOn : ST.panel), alignItems: 'stretch', cursor: 'pointer', flexDirection: 'column', gap: 5, padding: 8, minHeight: 92 },
            onClick: () => store.selectSlot(active ? null : slot.slotId),
          },
          [
            h('span', { key: 'h', style: { ...ST.row, gap: 5 } }, [
              iconOrBadge(h, slot.icon, slot.name, 22),
              h('span', { key: 'n', style: { fontSize: 12, fontWeight: 600 } }, slot.name),
              h('span', { key: 'c', style: { ...ST.tiny, marginLeft: 'auto' } }, `${slot.count}/${slot.capacity}`),
            ]),
            slot.items.length === 0
              ? h('span', { key: 'empty', style: { ...ST.tiny, border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 6px', textAlign: 'center', flex: 1 } }, '空槽（点选后可放入物品）')
              : h(
                  'span',
                  { key: 'items', style: { ...ST.col, gap: 4 } },
                  slot.items.map((item) =>
                    h('span', { key: item.instanceId, style: { ...ST.card, padding: 4, gap: 2 } }, [
                      h('span', { key: 'r', style: { ...ST.row, gap: 4 } }, [iconOrBadge(h, item.icon, item.name, 16), h('span', { key: 'n', style: { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name)]),
                      h('span', { key: 's', style: ST.tiny }, statsText(item)),
                    ]),
                  ),
                ),
            h('span', { key: 'acc', style: ST.tiny }, `接受：${slot.accepts.map(tagLabel).join(' / ') || '无'}`),
          ],
        );
      }),
    );
    const picker = selected === null
      ? h('div', { style: ST.panel }, [h('div', { key: 't', style: ST.panelTitle }, '物品选择器'), h('span', { key: 'h', style: ST.muted }, '先在左侧选一个装备槽。')])
      : h('div', { style: ST.panel }, [
          h('div', { key: 'h', style: { ...ST.row, gap: 6 } }, [
            h('div', { key: 't', style: ST.panelTitle }, `「${selected.name}」可选物品（按 accepts 过滤）`),
            h('button', { key: 'x', type: 'button', style: { ...ST.button, marginLeft: 'auto' }, onClick: () => store.selectSlot(null) }, '关闭'),
          ]),
          full ? h('span', { key: 'full', style: ST.bad }, `槽已满：${selected.count}/${selected.capacity}，先卸下再装备（host 校验直接换装会拒绝）`) : null,
          h('div', { key: 'current', style: ST.tiny }, `当前物品：${selected.items.map((item) => item.name).join('、') || '空'}`),
          candidates.length === 0 ? h('span', { key: 'none', style: ST.muted }, '没有符合该槽标签的背包物品') : null,
          ...candidates.map((item) => {
            const isSelected = snapshot.selectedItemId === item.instanceId;
            return h(
              'button',
              {
                key: item.instanceId,
                type: 'button',
                style: { ...(isSelected ? ST.buttonOn : ST.card), alignItems: 'stretch', cursor: 'pointer', flexDirection: 'column', gap: 3, padding: 6, textAlign: 'left' },
                onClick: () => store.selectItem(isSelected ? null : item.instanceId),
              },
              [
                h('span', { key: 'r', style: { ...ST.row, gap: 6 } }, [
                  iconOrBadge(h, item.icon, item.name, 20),
                  h('strong', { key: 'n', style: { fontSize: 12 } }, item.name),
                  item.rarityName !== undefined ? h(Tag, { key: 'rar' }, item.rarityName) : null,
                  h('span', { key: 's', style: { ...ST.tiny, marginLeft: 'auto' } }, statsText(item)),
                ]),
                item.description !== undefined ? h('span', { key: 'd', style: ST.tiny }, item.description) : null,
              ],
            );
          }),
          candidate !== null
            ? h('div', { key: 'preview', style: { ...ST.hint, gap: 4 } }, [
                h('strong', { key: 't', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, `试算：把「${candidate.name}」放进「${selected.name}」`),
                candidate.stats.length === 0
                  ? h('span', { key: 'none', style: ST.tiny }, '该物品没有词条（不影响当前词条总览）')
                  : h(
                      'div',
                      { key: 'diffs', style: { ...ST.col, gap: 2 } },
                      candidate.stats.map((stat) => {
                        const currentValue = before.get(stat.statId)?.value ?? 0;
                        const after = currentValue + stat.value;
                        return h('span', { key: stat.statId, style: ST.small }, `${stat.name}：${currentValue >= 0 ? '+' : ''}${currentValue} → ${after >= 0 ? '+' : ''}${after}（${stat.value >= 0 ? '+' : ''}${stat.value}）`);
                      }),
                    ),
                h('span', { key: 'note', style: ST.tiny }, '试算仅为 DTO stats 求和展示（客户端不算规则公式）；确认后由 host 校验并重算词条/行动经济。'),
                h('div', { key: 'act', style: ST.row }, [
                  h('button', { key: 'equip', type: 'button', style: full ? ST.buttonDisabled : ST.buttonPrimary, disabled: full || snapshot.pending !== null, onClick: () => void store.equip(selected.slotId, candidate.instanceId) }, '确认装备'),
                  h('button', { key: 'cancel', type: 'button', style: ST.button, onClick: () => store.selectItem(null) }, '取消'),
                ]),
              ])
            : null,
          selected.items.length > 0
            ? h('div', { key: 'unequip', style: { ...ST.col, gap: 4 } }, [
                h('span', { key: 't', style: ST.tiny }, '卸下'),
                ...selected.items.map((item) =>
                  h('div', { key: item.instanceId, style: { ...ST.row, justifyContent: 'space-between' } }, [
                    h('span', { key: 'n', style: { ...ST.small, display: 'inline-flex', alignItems: 'center', gap: 4 } }, [iconOrBadge(h, item.icon, item.name, 15), item.name]),
                    h('button', { key: 'b', type: 'button', style: ST.button, disabled: snapshot.pending !== null, onClick: () => void store.unequip(selected.slotId, item.instanceId) }, '卸下'),
                  ]),
                ),
              ])
            : null,
          incompatible.length > 0
            ? h('details', { key: 'incompat' }, [
                h('summary', { key: 's', style: { ...ST.tiny, cursor: 'pointer' } }, `不匹配该槽的物品（${incompatible.length}，灰显不隐藏）`),
                ...incompatible.slice(0, 8).map((item) => h('span', { key: item.instanceId, style: { ...ST.tiny, opacity: 0.5 } }, `${item.name}（标签：${item.tags.join('/') || '无'}）`)),
              ])
            : null,
        ]);
    const totals = h('div', { style: ST.panel }, [
      h('div', { key: 't', style: ST.panelTitle }, '词条总览（host 聚合）'),
      sheet.equipment.statTotals.length === 0
        ? h('span', { key: 'none', style: ST.muted }, '没有装备词条')
        : h(
            'div',
            { key: 'list', style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
            sheet.equipment.statTotals.map((total) =>
              h('span', { key: total.statId, style: { ...ST.tag, padding: '2px 8px', fontSize: 11, color: 'var(--dsw-alias-label-primary)' } }, [iconOrBadge(h, total.icon, total.name, 13, false), `${total.name} ${total.total >= 0 ? '+' : ''}${total.total}`]),
            ),
          ),
      (sheet.equipment.trace ?? []).length > 0
        ? h(
            'div',
            { key: 'trace', style: { ...ST.col, gap: 3, marginTop: 4 } },
            (sheet.equipment.trace ?? []).map((entry) =>
              h('div', { key: entry.statId, style: { ...ST.col, gap: 1 } }, [
                h('span', { key: 'h', style: ST.small }, `${entry.statId}：合计 ${entry.total >= 0 ? '+' : ''}${entry.total}`),
                ...entry.parts.map((part, partIndex) => h('span', { key: `${part.sourceId}-${partIndex}`, style: ST.tiny }, `▲ ${part.sourceName} ${part.value >= 0 ? '+' : ''}${part.value}（${part.stack === 'add' ? '相加' : part.stack === 'max' ? '取最高' : part.stack === 'min' ? '取最低' : part.stack}）`)),
              ]),
            ),
          )
        : null,
    ]);
    return h('div', { style: ST.threeCol }, [
      h('div', { key: 'l', style: { ...ST.col, gap: 10 } }, [h('div', { key: 'slots', style: ST.panel }, [h('div', { key: 't', style: ST.panelTitle }, '槽位栅格（由规则包 slots[] 生成，不写死部位）'), slotGrid]), totals]),
      h('div', { key: 'r', style: { ...ST.col, gap: 10 } }, [picker]),
    ]);
  }

  // ---------------------------------------------------------------- 主区域 · 背包详情

  function BagDetail(): VNode {
    const snapshot = useSnapshot();
    const sheet = snapshot.sheet;
    if (sheet === null) return h(Hint, null, [h('span', { key: 't' }, snapshot.sheetError ?? '暂无背包投影')]);
    const items = filteredItems(snapshot);
    const selected = items.find((item) => item.instanceId === snapshot.selectedItemId) ?? null;
    const capacity = snapshot.inventory?.capacity;
    const weight = snapshot.inventory?.weight;
    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'bar', style: { ...ST.row, gap: 8 } }, [
        h('div', { key: 'cat', style: { flex: '1 1 320px' } }, BagCategoryRow({ snapshot })),
        h('div', { key: 'tools', style: { ...ST.row, gap: 6, flex: '0 1 320px' } }, [
          h('input', {
            key: 'q',
            style: { ...ST.input, width: 'auto', flex: '1 1 120px' },
            value: snapshot.bagQuery,
            placeholder: '搜索名字/标签/描述',
            onChange: (event: { target: { value: string } }) => store.setBagFilter({ query: event.target.value }),
          }),
          h(
            'select',
            { key: 's', style: { ...ST.select, width: 'auto', flex: '0 0 96px' }, value: snapshot.bagSort, onChange: (event: { target: { value: string } }) => store.setBagFilter({ sort: event.target.value === 'rarity' ? 'rarity' : 'name' }) },
            [h('option', { key: 'name', value: 'name' }, '按名字'), h('option', { key: 'rarity', value: 'rarity' }, '按稀有度')],
          ),
        ]),
      ]),
      capacity !== undefined
        ? h('div', { key: 'cap', style: { ...ST.col, gap: 3 } }, [
            h('span', { key: 't', style: ST.small }, `容量 ${capacity.used}/${capacity.max}${capacity.unit !== undefined ? ` ${capacity.unit}` : ''}${weight !== undefined ? ` · 重量 ${weight.used}${weight.max !== undefined ? `/${weight.max}` : ''}${weight.unit ?? ''}` : ''}`),
            h(Bar, { key: 'b', current: capacity.used, max: capacity.max }),
          ])
        : null,
      h('div', { key: 'body', style: ST.twoCol }, [
        h('div', { key: 'grid', style: ST.panel }, [
          h('div', { key: 't', style: ST.panelTitle }, `物品网格（${items.length}）`),
          items.length === 0 ? h('span', { key: 'none', style: ST.muted }, '当前筛选下没有物品') : null,
          h(
            'div',
            { key: 'cells', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 8 } },
            items.map((item) =>
              h(
                'button',
                {
                  key: item.instanceId,
                  type: 'button',
                  style: { ...(snapshot.selectedItemId === item.instanceId ? ST.buttonOn : ST.card), position: 'relative', alignItems: 'center', cursor: 'pointer', flexDirection: 'column', gap: 3, padding: 6 },
                  onClick: () => store.selectItem(snapshot.selectedItemId === item.instanceId ? null : item.instanceId),
                },
                [
                  iconOrBadge(h, item.icon, item.name, 34),
                  h('span', { key: 'n', style: { ...ST.tiny, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name),
                  item.count > 1 ? h('span', { key: 'q', style: { position: 'absolute', right: 3, top: 3, fontSize: 9, ...ST.tag, padding: '0 4px' } }, `×${item.count}`) : null,
                  item.equippedSlot !== undefined ? h('span', { key: 'e', style: { ...ST.tag, fontSize: 9, padding: '0 4px' } }, '已装备') : null,
                ],
              ),
            ),
          ),
        ]),
        h('div', { key: 'detail', style: ST.panel }, [
          h('div', { key: 't', style: ST.panelTitle }, '物品详情'),
          selected === null
            ? h('span', { key: 'none', style: ST.muted }, '点左侧物品查看详情')
            : h('div', { key: 'd', style: { ...ST.col, gap: 8 } }, [
                h('div', { key: 'h', style: { ...ST.row, gap: 8 } }, [iconOrBadge(h, selected.icon, selected.name, 40), h('div', { key: 'x', style: { ...ST.col, gap: 2 } }, [h('strong', { key: 'n', style: { fontSize: 14 } }, selected.name), h('span', { key: 'r', style: ST.tiny }, [selected.rarityName ?? selected.rarity, ...selected.tags.map(tagLabel)].filter(Boolean).join(' · ') || '无标签')])]),
                h('div', { key: 'stats', style: ST.col }, selected.stats.length === 0 ? [h('span', { key: 'none', style: ST.muted }, '无词条')] : selected.stats.map((stat) => h('span', { key: stat.statId, style: ST.small }, `${stat.name} ${stat.value >= 0 ? '+' : ''}${stat.value}`))),
                selected.description !== undefined ? h('span', { key: 'd', style: { ...ST.small, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, selected.description) : null,
                selected.equippedSlot !== undefined ? h('span', { key: 'slot', style: ST.tiny }, `已装备在：${store.slotName(selected.equippedSlot)}`) : null,
                h('div', { key: 'acts', style: { ...ST.col, gap: 5 } }, [
                  ...(sheet.equipment.slots
                    .filter((slot) => accepts(slot, selected) && selected.equippedSlot !== slot.slotId)
                    .map((slot) =>
                      h('button', { key: `e-${slot.slotId}`, type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null, onClick: () => void store.equip(slot.slotId, selected.instanceId) }, `装备到${slot.name}`),
                    )),
                  h('button', { key: 'use', type: 'button', style: ST.button, disabled: snapshot.pending !== null, onClick: () => void store.useItem(selected.instanceId) }, '使用'),
                ]),
                h('span', { key: 'note', style: ST.tiny }, '拆分 / 丢弃：后端本版没有对应命令（splitStack / drop），按钮按契约隐藏。'),
              ]),
        ]),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 主区域 · 世界地图

  function WorldMapPage(): VNode {
    const snapshot = useSnapshot();
    const [selectedZone, setSelectedZone] = useState(null as string | null);
    const world = snapshot.worldMap;
    if (world === null || !snapshot.mapAvailable) {
      return h(Hint, null, [
        h('strong', { key: 't', style: { fontSize: 12 } }, '当前模组没有世界地图'),
        h('span', { key: 'x' }, '`worldmap.get` 返回的 zones 为空：该内容包没有 space 段（theater-of-mind 团）。世界地图页按契约不显示。'),
      ]);
    }
    const zones = world.zones;
    const byId = new Map(zones.map((zone) => [zone.zoneId, zone]));
    const current = zones.find((zone) => zone.current) ?? (world.currentZoneId !== undefined ? byId.get(world.currentZoneId) : undefined);
    const selected = selectedZone !== null ? byId.get(selectedZone) ?? null : null;
    const lines: VNode[] = [];
    for (const zone of zones) {
      const from = zone.hotspot;
      if (from === undefined) continue;
      for (const connection of zone.connections) {
        const target = byId.get(connection.to);
        const to = target?.hotspot;
        if (to === undefined) continue;
        const color = connection.kind === 'river' ? '#5f9fd0' : connection.kind === 'stairs' ? '#b9a7d8' : '#b7a87e';
        lines.push(
          h('line', {
            key: `${zone.zoneId}-${connection.to}`,
            x1: from.x * 100,
            y1: from.y * 100,
            x2: to.x * 100,
            y2: to.y * 100,
            stroke: color,
            strokeWidth: 0.4,
            strokeDasharray: connection.kind === 'stairs' ? '1.2 1.2' : undefined,
            opacity: 0.75,
          }),
        );
      }
    }
    const hue = hashSeed('world-map') % 360;
    const canvas = h(
      'div',
      {
        key: 'canvas',
        style: {
          position: 'relative',
          width: '100%',
          maxWidth: 980,
          aspectRatio: `${world.width ?? 4} / ${world.height ?? 3}`,
          borderRadius: 12,
          overflow: 'hidden',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: `radial-gradient(circle at 22% 18%, hsl(${hue} 34% 26%), hsl(${(hue + 50) % 360} 28% 12%) 62%, #0d1014 100%)`,
        },
      },
      [
        h('div', { key: 'grid', style: { position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.055) 1px, transparent 1px)', backgroundSize: '5% 6.7%', opacity: 0.7 } }),
        h('svg', { key: 'conn', viewBox: '0 0 100 100', preserveAspectRatio: 'none', style: { position: 'absolute', inset: 0, width: '100%', height: '100%' } }, lines),
        ...zones.map((zone: WorldMapZoneView) => {
          const hotspot = zone.hotspot;
          if (hotspot === undefined) return null;
          const isCurrent = zone.current || zone.zoneId === current?.zoneId;
          return h(
            'button',
            {
              key: zone.zoneId,
              type: 'button',
              title: `${zone.name}${isCurrent ? '（当前区域）' : ''}${zone.explored ? '' : '（未探索）'}`,
              style: {
                position: 'absolute',
                left: `${hotspot.x * 100}%`,
                top: `${hotspot.y * 100}%`,
                transform: 'translate(-50%, -50%)',
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                opacity: zone.explored ? 1 : 0.55,
              },
              onClick: () => setSelectedZone(zone.zoneId === selectedZone ? null : zone.zoneId),
            },
            [
              h('span', {
                key: 'ring',
                style: {
                  borderRadius: 999,
                  padding: 3,
                  display: 'inline-flex',
                  lineHeight: 0,
                  background: isCurrent ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent)' : 'rgba(8,10,14,.55)',
                  border: isCurrent ? '2px solid var(--dsw-alias-brand-primary)' : '1px solid rgba(255,255,255,.35)',
                  animation: isCurrent ? 'dsh-trpg-pulse 1.8s ease-out infinite' : undefined,
                },
              }, iconOrBadge(h, hotspot.icon, zone.name, 22)),
              h('span', { key: 'name', style: { fontSize: 10, padding: '1px 5px', borderRadius: 5, background: 'rgba(8,10,14,.66)', color: '#f2ede2', whiteSpace: 'nowrap' } }, `${zone.name}${isCurrent ? ' · 当前' : ''}`),
            ],
          );
        }),
      ],
    );
    const zoneList = h('div', { key: 'list', style: ST.panel }, [
      h('div', { key: 't', style: ST.panelTitle }, `区域（${zones.length}）`),
      ...zones.map((zone) =>
        h(
          'button',
          {
            key: zone.zoneId,
            type: 'button',
            style: { ...(selectedZone === zone.zoneId ? ST.buttonOn : ST.button), justifyContent: 'space-between', width: '100%' },
            onClick: () => setSelectedZone(zone.zoneId === selectedZone ? null : zone.zoneId),
          },
          [h('span', { key: 'n', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, [iconOrBadge(h, zone.hotspot?.icon, zone.name, 14), zone.name, zone.current ? h('span', { key: 'c', style: ST.tiny }, '· 当前') : null]), h('span', { key: 'x', style: ST.tiny }, zone.explored ? '已探索' : '未探索')],
        ),
      ),
      selected !== null
        ? h('div', { key: 'detail', style: { ...ST.hint, marginTop: 6 } }, [
            h('strong', { key: 't', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, selected.name),
            selected.description !== undefined ? h('span', { key: 'd', style: ST.small }, selected.description) : h('span', { key: 'd', style: ST.tiny }, '（host 未下发区域描述）'),
            h('span', { key: 'c', style: ST.tiny }, `连接：${selected.connections.map((connection) => `${byId.get(connection.to)?.name ?? connection.to}${connection.kind !== undefined ? `（${connection.kind}）` : ''}${connection.distance !== undefined ? ` ${connection.distance}` : ''}`).join('、') || '无'}`),
            selected.battleMapId !== undefined ? h('span', { key: 'b', style: ST.tiny }, `战斗地图：${selected.battleMapId}`) : h('span', { key: 'b', style: ST.tiny }, '该区域无战棋地图（theater-of-mind）'),
            h('span', { key: 'n', style: ST.tiny }, '世界地图只做展示与导航：进入区域由 host 的 move 命令判定，客户端不自行切区域。'),
          ])
        : null,
      (world.warnings ?? []).map((warning, index) => h('span', { key: `w${index}`, style: ST.warn }, warning)),
    ]);
    return h('div', { style: ST.twoCol }, [
      h('div', { key: 'l', style: { ...ST.col, gap: 8 } }, [canvas, h('span', { key: 'legend', style: ST.tiny }, '底图：无世界图资产 → 程序化底图（M9.5e 接 AI 底图）；连线 = zones[].connections，按 kind 上色（道路/河流/楼梯）。')]),
      h('div', { key: 'r', style: { ...ST.col, gap: 8 } }, [zoneList]),
    ]);
  }

  // ---------------------------------------------------------------- 主区域 · 战棋/战斗

  function CombatPage(): VNode {
    const snapshot = useSnapshot();
    const combat = snapshot.combat;
    const sheet = snapshot.sheet;
    const [hint, setHint] = useState(null as string | null);
    if (combat === null) {
      return h(Hint, null, [h('span', { key: 't' }, snapshot.loading ? '正在读取战斗视图…' : '暂无战斗视图')]);
    }
    const isHost = typeof snapshot.session?.hostToken === 'string';
    const legend = new Map(combat.terrainLegend.map((entry) => [entry.id, entry]));
    const selectedAction = sheet?.actions.find((action) => action.actionId === snapshot.selectedActionId) ?? null;
    const selectedTarget = combat.tokens.find((token) => token.actorId === snapshot.selectedTargetId) ?? null;
    const active = combat.tokens.find((token) => token.actorId === combat.activeActorId);
    const myActorId = sheet?.actorId;
    const myTurn = combat.activeActorId !== null && myActorId !== undefined && combat.activeActorId === myActorId;

    function performAction(action: SheetActionView, targetId?: string): void {
      if (!action.available) {
        setHint(action.reason ?? '该动作不可用');
        return;
      }
      if (actionNeedsTarget(action) && targetId === undefined) {
        setHint('该动作需要目标：先点选一个 token');
        return;
      }
      setHint(null);
      void store.useAction(action.actionId, targetId);
    }

    const economy = combat.actionEconomy.remaining;
    const economyRow = h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      economy.map((entry) =>
        h('span', { key: entry.id, style: { ...ST.tag, padding: '2px 8px', fontSize: 11, color: entry.current > 0 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', opacity: entry.current > 0 ? 1 : 0.6 } }, `${entry.name} ${entry.current}/${entry.max}${entry.unit ?? ''}`),
      ),
    );
    const actionBar = sheet === null
      ? h('span', { key: 'none', style: ST.muted }, '没有自己的卡面（未落座/房主未指定角色）：无法从 UI 选动作；仍可看先攻与行动经济。')
      : h(
          'div',
          { key: 'bar', style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
          sheet.actions.map((action) =>
            h(
              'button',
              {
                key: action.actionId,
                type: 'button',
                style: snapshot.selectedActionId === action.actionId ? ST.buttonOn : action.available ? ST.button : ST.buttonDisabled,
                disabled: !action.available || snapshot.pending !== null,
                title: action.available ? `${targetingText(action)} · ${actionCostText(action, economy)}` : action.reason ?? '不可用',
                onClick: () => {
                  if (!actionNeedsTarget(action)) {
                    performAction(action);
                    return;
                  }
                  store.selectAction(snapshot.selectedActionId === action.actionId ? null : action.actionId);
                  setHint(`已选「${action.name}」：点击目标 token ${action.targeting.type === 'area' ? '附近格子' : '执行'}（host 判定）`);
                },
              },
              `${action.name}${action.available ? '' : '（不可用）'}`,
            ),
          ),
        );
    const hintCard = hint !== null ? h('div', { key: 'hint', style: ST.hint }, [h('span', { key: 't', style: ST.small }, hint)]) : null;
    const selectedInfo = selectedAction !== null
      ? h('div', { key: 'sel', style: { ...ST.hint, gap: 3 } }, [
          h('strong', { key: 't', style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, `已选动作：${selectedAction.name}`),
          h('span', { key: 'tgt', style: ST.tiny }, `${targetingText(selectedAction)} · ${actionCostText(selectedAction, economy)}`),
          selectedAction.description !== undefined ? h('span', { key: 'd', style: ST.tiny }, selectedAction.description) : null,
          selectedTarget !== null && actionNeedsTarget(selectedAction)
            ? h('button', { key: 'go', type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null, onClick: () => performAction(selectedAction, selectedTarget.actorId) }, `对「${selectedTarget.name}」执行`)
            : h('span', { key: 'wait', style: ST.tiny }, actionNeedsTarget(selectedAction) ? '选择目标后执行' : '可直接执行（无目标动作）'),
          h('div', { key: 'row', style: ST.row }, [
            h('button', { key: 'cancel', type: 'button', style: ST.button, onClick: () => store.selectAction(null) }, '取消选择'),
            !actionNeedsTarget(selectedAction) ? h('button', { key: 'run', type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null, onClick: () => performAction(selectedAction) }, '执行') : null,
          ]),
        ])
      : null;

    const tokenButton = (token: CombatTokenView, size: number): VNode => {
      const activeToken = token.active;
      return h(
        'button',
        {
          key: token.actorId,
          type: 'button',
          title: `${token.name}（${labelOf(TEAM_LABELS, token.team)}）${token.hp !== undefined ? ` HP ${token.hp.current}/${token.hp.max ?? '?'}` : ''}${token.dead ? ' · 已倒下' : ''}`,
          style: {
            ...ST.token,
            opacity: token.dead ? 0.45 : 1,
            filter: token.dead ? 'grayscale(1)' : undefined,
          },
          onClick: () => {
            store.selectTarget(token.actorId);
            if (selectedAction !== null && actionNeedsTarget(selectedAction)) {
              performAction(selectedAction, token.actorId);
            }
          },
        },
        [
          h('span', {
            key: 'ring',
            style: {
              ...ST.tokenRing,
              border: activeToken ? '2px solid var(--dsw-alias-brand-primary)' : `2px solid ${token.team === 'enemy' ? 'var(--dsw-alias-state-error-primary)' : token.team === 'neutral' ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-success-primary)'}`,
              background: 'var(--dsw-alias-bg-layer-2)',
              borderRadius: 999,
              padding: 1,
            },
          }, iconOrBadge(h, undefined, token.name, size)),
          token.hp !== undefined
            ? h('span', { key: 'hp', style: ST.hpBar }, [h('span', { key: 'f', style: { display: 'block', height: '100%', width: `${pct(token.hp.current, token.hp.max ?? (token.hp.current || 1))}%`, background: 'var(--dsw-alias-state-error-primary)' } })])
            : null,
        ],
      );
    };

    let battlefield: VNode;
    if (combat.cols > 0 && combat.rows > 0) {
      const cols = Math.min(32, Math.max(1, combat.cols));
      const rows = Math.min(32, Math.max(1, combat.rows));
      const cells: VNode[] = [];
      for (let y = 0; y < rows; y += 1) {
        const row = combat.terrain[y] ?? [];
        for (let x = 0; x < cols; x += 1) {
          const terrainId = row[x] ?? 'floor';
          const legendEntry = legend.get(terrainId);
          cells.push(
            h(
              'button',
              {
                key: `${x}-${y}`,
                type: 'button',
                title: `${x},${y} · ${legendEntry?.name ?? terrainId}${legendEntry?.blocksMove === true ? '（阻挡移动）' : ''}`,
                style: { ...terrainStyle(legend, terrainId), padding: 0, cursor: combat.active ? 'pointer' : 'default', minWidth: 0, minHeight: 0 },
                onClick: () => {
                  if (!combat.active) return;
                  if (selectedAction !== null && actionNeedsTarget(selectedAction)) {
                    setHint('已选动作：请点目标 token（格子移动如需先取消动作）');
                    return;
                  }
                  setHint(null);
                  void store.move({ x, y });
                },
              },
              [],
            ),
          );
        }
      }
      const obstacles = (combat.obstacles ?? []).map((obstacle, index) =>
        h('span', {
          key: `o${index}`,
          title: `障碍：${obstacle.terrain ?? ''}${obstacle.coverId !== undefined ? ` · 掩体 ${obstacle.coverId}` : ''}`,
          style: {
            position: 'absolute',
            left: `${(obstacle.x / cols) * 100}%`,
            top: `${(obstacle.y / rows) * 100}%`,
            width: `${(obstacle.w / cols) * 100}%`,
            height: `${(obstacle.h / rows) * 100}%`,
            background: 'repeating-linear-gradient(45deg, rgba(0,0,0,.5) 0 4px, rgba(255,255,255,.12) 4px 8px)',
            border: '1px solid rgba(255,255,255,.35)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
            borderRadius: 2,
          },
        }),
      );
      const tokens = combat.tokens
        .filter((token) => token.x !== undefined && token.y !== undefined)
        .map((token) =>
          h(
            'span',
            { key: token.actorId, style: { position: 'absolute', left: `${((token.x ?? 0) + 0.5) / cols * 100}%`, top: `${((token.y ?? 0) + 0.5) / rows * 100}%`, width: `${100 / cols}%`, display: 'flex', justifyContent: 'center', pointerEvents: 'none' } },
            [h('span', { key: 'w', style: { pointerEvents: 'auto' } }, [tokenButton(token, Math.max(16, Math.min(40, 360 / cols / 2)) )])],
          ),
        );
      battlefield = h('div', { key: 'grid-wrap', style: ST.gridWrap }, [
        h('div', {
          key: 'grid',
          style: {
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            aspectRatio: `${cols} / ${rows}`,
            width: '100%',
            background: '#0d1014',
          },
        }, cells),
        ...obstacles,
        ...tokens,
        h('span', { key: 'hintbar', style: { position: 'absolute', right: 6, bottom: 6, fontSize: 10, padding: '1px 6px', borderRadius: 6, background: 'rgba(8,10,14,.7)', color: '#ddd' } }, '点格子 = move（host 判距离/地形）；点 token = 选目标/执行动作'),
      ]);
    } else {
      // theater-of-mind：无格子地图，按先攻序列 + token 列表推进
      const order = combat.initiative.length > 0
        ? combat.initiative
        : combat.tokens.map((token) => ({ actorId: token.actorId, name: token.name, team: token.team, playerId: token.playerId, initiative: 0, roll: 0, hp: token.hp, dead: token.dead, active: token.active } as CombatInitiativeView));
      battlefield = h('div', { key: 'tom', style: { ...ST.col, gap: 6 } }, [
        h('span', { key: 'note', style: ST.tiny }, `theater-of-mind（cols=0，规则包无格子地图）：距离按规则包档位由 host 判定；下方按先攻序列排列，点 token 选目标。`),
        ...order.map((entry) =>
          h(
            'button',
            {
              key: entry.actorId,
              type: 'button',
              style: {
                ...(combat.activeActorId === entry.actorId ? ST.buttonOn : ST.card),
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                opacity: entry.dead ? 0.5 : 1,
                padding: 6,
              },
              onClick: () => {
                store.selectTarget(entry.actorId);
                if (selectedAction !== null && actionNeedsTarget(selectedAction)) performAction(selectedAction, entry.actorId);
              },
            },
            [
              h('span', { key: 'init', style: { ...ST.muted, width: 42, fontVariantNumeric: 'tabular-nums' } }, `${entry.initiative}`),
              iconOrBadge(h, undefined, colorSeedOf(entry.actorId), 22),
              h('span', { key: 'n', style: { ...ST.row, gap: 5, flex: '1 1 auto' } }, [
                h('strong', { key: 'x', style: { fontSize: 12 } }, entry.name),
                h(Tag, { key: 'team', tone: entry.team === 'enemy' ? 'bad' : 'ok' }, labelOf(TEAM_LABELS, entry.team)),
                entry.active ? h(Tag, { key: 'active', title: '当前行动者' }, '当前') : null,
                entry.dead ? h(Tag, { key: 'dead', tone: 'bad' }, '已倒下') : null,
              ]),
              entry.hp !== undefined
                ? h('span', { key: 'hp', style: { ...ST.tiny, width: 96, display: 'flex', flexDirection: 'column', gap: 2 } }, [
                    h('span', { key: 't', style: { fontVariantNumeric: 'tabular-nums' } }, `HP ${entry.hp.current}/${entry.hp.max ?? '?'}`),
                    h(Bar, { key: 'b', current: entry.hp.current, max: entry.hp.max ?? (entry.hp.current || 1), color: 'var(--dsw-alias-state-error-primary)' }),
                  ])
                : null,
            ],
          ),
        ),
        order.length === 0 ? h('span', { key: 'none', style: ST.muted }, '战斗里还没有行动者') : null,
      ]);
    }

    const initiativeList = h('div', { style: ST.panel }, [
      h('div', { key: 't', style: ST.panelTitle }, `先攻序（${combat.initiative.length}）`),
      combat.round !== undefined ? h('span', { key: 'round', style: ST.small }, `回合 ${combat.round}/${combat.maxRounds || '∞'}${combat.overtime ? ' · 加时' : ''}`) : null,
      ...combat.initiative.map((entry) =>
        h('div', { key: entry.actorId, style: { ...ST.row, justifyContent: 'space-between', gap: 4, opacity: entry.dead ? 0.5 : 1, borderBottom: '1px dashed var(--dsw-alias-border-l2)', padding: '2px 0' } }, [
          h('span', { key: 'n', style: { ...ST.small, display: 'inline-flex', alignItems: 'center', gap: 4 } }, [
            entry.active ? h('span', { key: 'a', style: { color: 'var(--dsw-alias-brand-primary)' } }, '▶') : null,
            entry.name,
            h('span', { key: 'team', style: ST.tiny }, labelOf(TEAM_LABELS, entry.team)),
          ]),
          h('span', { key: 'v', style: { ...ST.tiny, fontVariantNumeric: 'tabular-nums' } }, `先攻 ${entry.initiative}（d20 ${entry.roll}）`),
        ]),
      ),
      combat.initiative.length === 0 ? h('span', { key: 'none', style: ST.muted }, '未开战') : null,
      (combat.warnings ?? []).map((warning, index) => h('span', { key: `w${index}`, style: ST.warn }, warning)),
      combat.endedReason !== undefined ? h('span', { key: 'ended', style: ST.muted }, `结束原因：${combat.endedReason}`) : null,
    ]);
    const headerActions = h('div', { key: 'acts', style: ST.row }, [
      isHost && !combat.active ? h('button', { key: 'start', type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null, onClick: () => void store.startCombat('血尸') }, '发起战斗（血尸）') : null,
      combat.active && (myTurn || isHost) ? h('button', { key: 'turn', type: 'button', style: ST.buttonPrimary, disabled: snapshot.pending !== null, onClick: () => void store.endTurn() }, '结束回合') : null,
      isHost && combat.active ? h('button', { key: 'end', type: 'button', style: ST.button, disabled: snapshot.pending !== null, onClick: () => void store.endCombat() }, '结束战斗') : null,
      h('button', { key: 'refresh', type: 'button', style: ST.button, disabled: snapshot.pending !== null, onClick: () => void store.refreshSheet() }, '刷新'),
    ]);
    return h('div', { style: { ...ST.col, gap: 10 } }, [
      h('div', { key: 'hud', style: { ...ST.panel, gap: 8 } }, [
        h('div', { key: 'line', style: { ...ST.row, gap: 8 } }, [
          h('strong', { key: 't', style: { fontSize: 14 } }, combat.active ? `战斗 · 第 ${combat.round}/${combat.maxRounds || '∞'} 回合` : '未开战'),
          h(Tag, { key: 'zone', title: combat.mapId }, combat.zoneId ?? combat.mapId ?? (combat.cols > 0 ? '格子地图' : 'theater-of-mind')),
          combat.active ? h('span', { key: 'a', style: ST.small }, `当前行动者：${active?.name ?? '无'}${myTurn ? '（你）' : ''}`) : null,
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          headerActions,
        ]),
        economyRow,
        combat.active && combat.actionEconomy.actorId !== null ? h('span', { key: 'econ-owner', style: ST.tiny }, `行动经济（${combat.actionEconomy.actorId}）：由 host 按 turn.resources[] 下发`) : null,
        h('div', { key: 'actions', style: { ...ST.col, gap: 5 } }, [h('span', { key: 't', style: ST.panelTitle }, '动作栏（点选 → 点目标）；行动经济由 host 结算'), actionBar]),
        hintCard,
        selectedInfo,
        h(GlobalBanners, { key: 'banners', snapshot }),
      ]),
      h('div', { key: 'body', style: ST.twoCol }, [
        h('div', { key: 'battlefield', style: { ...ST.panel, gap: 6 } }, [h('div', { key: 't', style: ST.panelTitle }, combat.cols > 0 ? `战棋地图 ${combat.cols}×${combat.rows}（地形/障碍/token）` : 'theater-of-mind 令牌列表'), battlefield]),
        h('div', { key: 'side', style: { ...ST.col, gap: 10 } }, [
          initiativeList,
          h('div', { key: 'legend', style: ST.panel }, [
            h('div', { key: 't', style: ST.panelTitle }, '地形图例'),
            ...combat.terrainLegend.map((entry) =>
              h('div', { key: entry.id, style: { ...ST.row, gap: 5, padding: '1px 0' } }, [
                h('span', { key: 'sw', style: { ...terrainStyle(legend, entry.id), width: 14, height: 14, borderRadius: 3, border: '1px solid var(--dsw-alias-border-l2)' } }),
                h('span', { key: 'n', style: ST.small }, entry.name),
                entry.blocksMove ? h('span', { key: 'm', style: ST.tiny }, '阻挡移动') : null,
                entry.blocksSight ? h('span', { key: 's', style: ST.tiny }, '阻挡视线') : null,
              ]),
            ),
            combat.terrainLegend.length === 0 ? h('span', { key: 'none', style: ST.muted }, '该规则包没有地形图例') : null,
          ]),
          selectedTarget !== null
            ? h('div', { key: 'target', style: ST.panel }, [
                h('div', { key: 't', style: ST.panelTitle }, '选中目标'),
                h('div', { key: 'r', style: { ...ST.row, gap: 6 } }, [
                  iconOrBadge(h, undefined, selectedTarget.name, 24),
                  h('span', { key: 'n', style: ST.small }, selectedTarget.name),
                  h(Tag, { key: 'team', tone: selectedTarget.team === 'enemy' ? 'bad' : 'ok' }, labelOf(TEAM_LABELS, selectedTarget.team)),
                  selectedTarget.active ? h(Tag, { key: 'a' }, '当前行动者') : null,
                ]),
                selectedTarget.hp !== undefined ? h('span', { key: 'hp', style: ST.small }, `HP ${selectedTarget.hp.current}/${selectedTarget.hp.max ?? '?'}`) : null,
                selectedTarget.zoneId !== undefined ? h('span', { key: 'z', style: ST.tiny }, `区域：${selectedTarget.zoneId}`) : null,
              ])
            : null,
        ]),
      ]),
    ]);
  }

  /** theater 列表里给 token 造一个稳定色种子（未配 icon 时按名字哈希）。 */
  function colorSeedOf(actorId: string): string {
    return actorId;
  }

  // ---------------------------------------------------------------- 主区域容器

  function RulesMainPanel(props: { goHome?: () => void; readSession?: () => unknown }): VNode {
    const snapshot = useSnapshot();
    const readSessionRef = useRef(props.readSession);
    readSessionRef.current = props.readSession;
    useEffect(() => {
      const session = readSessionRef.current?.() as { roomId?: string } | null | undefined;
      if (session && session.roomId !== undefined) store.bind(session as never);
    }, []);
    // 主区域可能先于右栏打开：轮询一次 localStorage 里的房间会话，进房后自动接上。
    useEffect(() => {
      if (snapshot.session !== null) return undefined;
      const timer = setInterval(() => {
        const session = readSessionRef.current?.() as { roomId?: string } | null | undefined;
        if (session && session.roomId !== undefined) store.bind(session as never);
      }, 2000);
      return () => clearInterval(timer);
    }, [snapshot.session]);
    const rules = snapshot.rules;
    const available: Array<[MainViewKind, string]> = [
      ['sheet', '人物'],
      ['equip', '装备'],
      ['bag', '背包'],
    ];
    if (snapshot.mapAvailable && !snapshot.degraded) available.push(['map', '世界地图']);
    if (!snapshot.degraded) available.push(['combat', '战斗']);
    const requested = snapshot.mainView;
    const view = available.some(([id]) => id === requested) ? requested : 'sheet';
    const body = rules === null
      ? h(Hint, null, [
          h('strong', { key: 't', style: { fontSize: 12 } }, '这个房间没有规则包'),
          h('span', { key: 'x' }, '内容包未带 rules 段（纯叙事团）：人物 / 装备 / 背包 / 世界地图 / 战棋视图都不显示；房间与人聊天照旧。'),
          snapshot.error !== null ? h('span', { key: 'e', style: ST.bad }, snapshot.error) : null,
        ])
      : snapshot.degraded
        ? h(Hint, { tone: 'warn' }, [
            h('strong', { key: 't', style: { fontSize: 12 } }, '规则不可用（房间降级）'),
            h('span', { key: 'x' }, `房间引用的规则包「${rules.rulesId}@${rules.rulesVersion}」在 host 上不可用/版本漂移：房间仍可续团，规则视图停用。`),
          ])
        : view === 'sheet'
          ? h(SheetDetail, { key: 'sheet' })
          : view === 'equip'
            ? h(EquipmentDetail, { key: 'equip' })
            : view === 'bag'
              ? h(BagDetail, { key: 'bag' })
              : view === 'map'
                ? h(WorldMapPage, { key: 'map' })
                : h(CombatPage, { key: 'combat' });
    return h('div', { style: ST.page }, [
      h('style', { key: 'kf' }, KEYFRAMES),
      h('div', { key: 'header', style: ST.pageHeader }, [
        iconOrBadge(h, undefined, snapshot.room?.title ?? '跑团桌详细', 28),
        h('div', { key: 'title', style: { ...ST.col, gap: 1, minWidth: 0 } }, [
          h('span', { key: 't', style: ST.pageTitle }, `跑团桌 · 详细${snapshot.room !== null ? ` · ${snapshot.room.title}` : ''}`),
          h('span', { key: 's', style: ST.tiny }, rules !== null ? `规则 ${rules.name ?? rules.rulesId} v${rules.rulesVersion}${snapshot.room?.content?.moduleTitle !== undefined ? ` · ${snapshot.room.content.moduleTitle}` : ''}` : '无规则包（叙事团）'),
        ]),
        h('div', { key: 'tabs', style: { ...ST.tabs, marginLeft: 'auto' } }, available.map(([id, label]) =>
          h(
            'button',
            { key: id, type: 'button', style: view === id ? ST.tabOn : ST.tab, onClick: () => store.setMainView(id) },
            label,
          ),
        )),
        h(
          'button',
          { key: 'back', type: 'button', style: ST.button, title: '回到对话（主区域面板可随时再打开）', onClick: () => props.goHome?.() },
          '返回对话',
        ),
      ]),
      h('div', { key: 'banners', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [h(GlobalBanners, { key: 'b', snapshot })]),
      h('div', { key: 'body' }, [body]),
    ]);
  }

  return {
    SidebarRulesSection: (props) => h(RulesBoundary, null, h(SidebarRulesSection, props)),
    CombatCompact: (props) => h(RulesBoundary, null, h(CombatCompact, props)),
    RulesMainPanel: (props) => h(RulesBoundary, null, h(RulesMainPanel, props)),
  };
}
