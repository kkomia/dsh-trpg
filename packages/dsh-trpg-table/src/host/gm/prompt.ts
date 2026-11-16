/**
 * GM 上下文组装（纯函数，可单测）。
 *
 * 设计约束（DESIGN §4 锁 1/2/5、§8；CONTENT-MODEL §5.1/§5.2；RULES-MODEL §7.1）：
 * - 行动者身份由服务端在 prompt 里显式写出，AI 不推断；
 * - 骰子/数值只能来自工具结果，prompt 里明确禁止自算；
 * - 世界书**按需检索**（M8.4）：alwaysOn ∪ 当前场景关联 ∪ 本场已 reveal ∪ 关键词命中，
 *   按「alwaysOn > 场景 > 已 reveal > 关键词 + priority 降序」排序，受字符预算上限约束；
 *   未被选中的 GM 秘密不进入提示；选中条目保留〔公开〕/〔GM 秘密〕标记；
 * - 模组数据真正消费（M8.4）：当前场景的 beats/checks/encounters/rewards 以
 *   「玩家不可见 GM 提示」形式分区注入，并把 maxRounds/battleMapId 覆盖写清楚；
 * - 最近事件按序带上 seq，私密事件只出现在 GM 侧（GM 本来就全见）。
 */
import type {
  BeatDef,
  CheckDef,
  EncounterDef,
  LoreEntry,
  LorebookDef,
  ModuleDef,
  RewardDef,
  SceneDef,
} from '@dsh-trpg/content';

export interface PromptPlayer {
  playerId: string;
  name: string;
  characterName?: string;
  characterClass?: string;
  level?: number;
  hp?: number;
  hpMax?: number;
  ac?: number;
  publicSummary?: string;
}

export interface PromptEvent {
  seq: number;
  kind: string;
  to: string;
  text: string;
}

// ---------------------------------------------------------------------------
// 世界书按需检索（纯函数：selectLoreEntries）
// ---------------------------------------------------------------------------

/** 默认世界书注入预算（字符数；约 1200–1500 tokens，可用参数覆盖）。 */
export const DEFAULT_LORE_BUDGET = 6000;

/** 关键词检索时最多带多少条玩家行动文本。 */
export const LORE_ACTION_QUERY_LIMIT = 6;

/** 条目被选中的原因（同一档内按 priority 降序排）。 */
export type LoreReason = 'alwaysOn' | 'scene' | 'revealed' | 'keyword';

const LORE_REASON_RANK: Record<LoreReason, number> = {
  alwaysOn: 4,
  scene: 3,
  revealed: 2,
  keyword: 1,
};

const LORE_REASON_LABEL: Record<LoreReason, string> = {
  alwaysOn: '常驻',
  scene: '本场',
  revealed: '已揭示',
  keyword: '关键词',
};

/** 检索上下文：都是纯数据，便于按房间状态/单测构造。 */
export interface LoreSelectionContext {
  /** 当前场景在模组里的下标（缺省 0）。 */
  sceneIndex?: number;
  /** 当前场景标题（参与关键词查询）。 */
  sceneTitle?: string;
  /** 当前场景开场旁白（参与关键词查询）。 */
  sceneEntry?: string;
  /** 当前场景关联的世界书条目 id（scene.lore / scene.loreIds）。 */
  sceneLoreIds?: readonly string[];
  /** 本场已 reveal 的条目 id。 */
  revealedIds?: readonly string[];
  /** 最近玩家行动文本（参与关键词查询）。 */
  recentActions?: readonly string[];
  /** 额外查询文本（例如 GM 想强调的调查方向）。 */
  extraQuery?: string;
  /**
   * 是否允许 GM 秘密（缺省 true = GM 提示：public + gm）。
   * false = 玩家可见上下文，只取 public。
   */
  includeSecrets?: boolean;
}

export interface SelectedLoreEntry {
  entry: LoreEntry;
  reasons: LoreReason[];
  /** 该条渲染进提示的字符数（含换行）。 */
  chars: number;
}

export interface LoreSelection {
  entries: SelectedLoreEntry[];
  /** 渲染好的提示文本（每行一条；空字符串 = 没有命中）。 */
  text: string;
  usedChars: number;
  budget: number;
  /** 因预算被丢弃的候选条目 id（按排名顺序）。 */
  dropped: string[];
}

function scopeLabelOf(entry: LoreEntry): string {
  if (entry.visibility === 'gm') return '〔GM 秘密〕';
  if (entry.visibility === 'public') return '〔公开〕';
  return '〔限人〕';
}

/** 一条世界书条目的提示行（保留公开/秘密标记）。 */
export function renderLoreEntry(entry: LoreEntry): string {
  return `- ${scopeLabelOf(entry)}${entry.title ?? entry.id}（id: ${entry.id}）：${entry.content}`;
}

function visibleForPrompt(entry: LoreEntry, includeSecrets: boolean): boolean {
  // 口径见 CONTENT-MODEL §5.1：GM 提示可用 public + gm；玩家可见上下文只 public。
  if (!includeSecrets) return entry.visibility === 'public';
  return entry.visibility === 'public' || entry.visibility === 'gm';
}

function normalizeQuery(context: LoreSelectionContext): string {
  const parts = [
    context.sceneTitle ?? '',
    context.sceneEntry ?? '',
    context.extraQuery ?? '',
    ...(context.recentActions ?? []),
  ];
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, 4000)
    .toLowerCase();
}

/**
 * 内容方向的关键词命中：中文没有词边界，用条目正文的 5–8 字 n-gram 去命中查询文本。
 * 方向是「正文片段出现在查询里」，比「查询片段出现在正文里」副作用小得多（避免
 * 「在青石镇」这种跨词片段把无关秘密也捞进来）；keys/title 方向仍按整词包含判断。
 */
function contentMatchesQuery(content: string, query: string): boolean {
  if (query.length === 0) return false;
  const normalized = content.toLowerCase();
  for (const segment of normalized.split(/[\s，。！？、；：,.!?;:()（）[\]【】"'“”‘’…—\-/\\|]+/u)) {
    const text = segment.trim();
    if (text.length < 5) continue;
    for (let length = Math.min(8, text.length); length >= 5; length -= 1) {
      for (let start = 0; start + length <= text.length; start += 1) {
        if (query.includes(text.slice(start, start + length))) return true;
      }
    }
  }
  return false;
}

function matchesKeyword(entry: LoreEntry, query: string): boolean {
  if (query.length === 0) return false;
  if (query.includes(entry.id.toLowerCase())) return true;
  if (entry.title !== undefined && entry.title.trim().length > 0 && query.includes(entry.title.toLowerCase())) {
    return true;
  }
  for (const key of entry.keys) {
    const normalized = key.trim().toLowerCase();
    if (normalized.length > 0 && query.includes(normalized)) return true;
  }
  return contentMatchesQuery(entry.content, query);
}

function sceneLoreIdsOf(scene: SceneDef | undefined): string[] {
  if (scene === undefined) return [];
  const extra = (scene as SceneDef & { loreIds?: string[] }).loreIds;
  const ids = [...(scene.lore ?? []), ...(Array.isArray(extra) ? extra : [])];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * 选世界书条目（纯函数）。
 *
 * - 候选 = alwaysOn ∪ 当前场景 lore ∪ 已 reveal ∪ 关键词命中（title/keys/content）；
 * - 排序 = alwaysOn > 场景关联 > 已 reveal > 关键词；同档按 priority 降序、再按原顺序；
 * - 可见性 = GM 提示 public+gm，玩家可见只 public；未入选的秘密不返回；
 * - 预算 = 渲染后字符数上限（含换行）；alwaysOn 最先占预算，超出预算的条目不注入并记入 dropped。
 *
 * @param lorebook 世界书。
 * @param context 检索上下文（场景/已揭示/最近行动）。
 * @param budget 字符预算（默认 {@link DEFAULT_LORE_BUDGET}）。
 * @returns 选中的条目、渲染文本、用量与被丢弃的候选 id。
 */
export function selectLoreEntries(
  lorebook: LorebookDef,
  context: LoreSelectionContext = {},
  budget: number = DEFAULT_LORE_BUDGET,
): LoreSelection {
  const limit = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : DEFAULT_LORE_BUDGET;
  const includeSecrets = context.includeSecrets !== false;
  const sceneLore = new Set(context.sceneLoreIds ?? []);
  const revealed = new Set(context.revealedIds ?? []);
  const query = normalizeQuery(context);

  interface Candidate {
    entry: LoreEntry;
    reasons: LoreReason[];
    rank: number;
    index: number;
  }
  const candidates: Candidate[] = [];
  lorebook.entries.forEach((entry, index) => {
    if (!visibleForPrompt(entry, includeSecrets)) return;
    const reasons: LoreReason[] = [];
    if (entry.alwaysOn === true) reasons.push('alwaysOn');
    if (sceneLore.has(entry.id)) reasons.push('scene');
    if (revealed.has(entry.id)) reasons.push('revealed');
    if (matchesKeyword(entry, query)) reasons.push('keyword');
    if (reasons.length === 0) return;
    const rank = reasons.reduce((max, reason) => Math.max(max, LORE_REASON_RANK[reason]), 0);
    candidates.push({ entry, reasons, rank, index });
  });

  candidates.sort((left, right) => {
    if (right.rank !== left.rank) return right.rank - left.rank;
    if (right.entry.priority !== left.entry.priority) return right.entry.priority - left.entry.priority;
    return left.index - right.index;
  });

  const entries: SelectedLoreEntry[] = [];
  const dropped: string[] = [];
  let usedChars = 0;
  for (const candidate of candidates) {
    const chars = renderLoreEntry(candidate.entry).length + 1;
    if (usedChars + chars > limit) {
      dropped.push(candidate.entry.id);
      continue;
    }
    usedChars += chars;
    entries.push({ entry: candidate.entry, reasons: candidate.reasons, chars });
  }

  return {
    entries,
    text: entries.map((selected) => renderLoreEntry(selected.entry)).join('\n'),
    usedChars,
    budget: limit,
    dropped,
  };
}

/** 场景下标（sceneId 找不到时回退 0）。 */
export function currentSceneIndex(module: ModuleDef, sceneId: string | undefined): number {
  if (!sceneId) return 0;
  const index = module.scenes.findIndex((scene) => scene.id === sceneId);
  return index >= 0 ? index : 0;
}

/** 由房间场景状态构造检索上下文（供各 GM 通道共用）。 */
export function loreContextOfScene(
  module: ModuleDef,
  sceneId: string | undefined,
  revealedIds: readonly string[] = [],
  recentActions: readonly string[] = [],
): LoreSelectionContext {
  const sceneIndex = currentSceneIndex(module, sceneId);
  const scene = module.scenes[sceneIndex];
  return {
    sceneIndex,
    sceneTitle: scene?.title,
    sceneEntry: scene?.entry,
    sceneLoreIds: sceneLoreIdsOf(scene),
    revealedIds,
    recentActions,
  };
}

// ---------------------------------------------------------------------------
// 模组数据消费（beats / checks / encounters / rewards）
// ---------------------------------------------------------------------------

/** 遭遇（含遭遇级覆盖字段；legacy `EncounterDef` 未声明时按未知字段防御性读取）。 */
export interface SceneEncounterView {
  id: string;
  monsters: Array<{ monsterId: string; count: number }>;
  note?: string;
  /** 覆盖本场回合上限（正整数；缺省取 rules.time.defaultMaxRounds）。 */
  maxRounds?: number;
  /** 覆盖本场战斗地图（引用 rules.space.battleMaps[].mapId）。 */
  battleMapId?: string;
}

export interface SceneCheckView {
  when: string;
  skill: string;
  dc: number;
  success: string;
  failure: string;
  private: boolean;
}

export interface SceneBeatView {
  id: string;
  trigger: string;
  effect: string;
}

export interface SceneRewardView {
  /** 场景内奖励下标（trpg_reward 的 rewardIndex）。 */
  index: number;
  xp: number;
  items: string[];
  note?: string;
}

/** 当前场景可消费的模组数据（玩家不可见，只进 GM 提示/工具）。 */
export interface SceneDataView {
  id: string;
  index: number;
  title: string;
  entry: string;
  beats: SceneBeatView[];
  checks: SceneCheckView[];
  encounters: SceneEncounterView[];
  rewards: SceneRewardView[];
}

function readPositiveInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
}

function readOptionalStringField(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

function encounterViewOf(encounter: EncounterDef): SceneEncounterView {
  const extended = encounter as EncounterDef & { maxRounds?: unknown; battleMapId?: unknown };
  const maxRounds = readPositiveInt(extended.maxRounds);
  const battleMapId = readOptionalStringField(extended.battleMapId);
  return {
    id: encounter.id,
    monsters: encounter.monsters.map((group) => ({ monsterId: group.monsterId, count: group.count })),
    ...(encounter.note !== undefined ? { note: encounter.note } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(battleMapId !== undefined ? { battleMapId } : {}),
  };
}

function checkViewOf(check: CheckDef): SceneCheckView {
  return {
    when: check.when,
    skill: check.skill,
    dc: check.dc,
    success: check.success,
    failure: check.failure,
    private: check.private === true,
  };
}

function beatViewOf(beat: BeatDef): SceneBeatView {
  return { id: beat.id, trigger: beat.trigger, effect: beat.effect };
}

function rewardViewOf(reward: RewardDef, index: number): SceneRewardView {
  return {
    index,
    xp: reward.xp,
    items: [...reward.items],
    ...(reward.note !== undefined ? { note: reward.note } : {}),
  };
}

/** 取场景数据（下标越界回退 0；模组没有场景时 undefined）。 */
export function sceneDataOf(module: ModuleDef, sceneIndex: number | undefined): SceneDataView | undefined {
  const index = typeof sceneIndex === 'number' && Number.isFinite(sceneIndex) ? sceneIndex : 0;
  const scene = module.scenes[index];
  if (scene === undefined) return undefined;
  return {
    id: scene.id,
    index,
    title: scene.title,
    entry: scene.entry,
    beats: (scene.beats ?? []).map(beatViewOf),
    checks: (scene.checks ?? []).map(checkViewOf),
    encounters: (scene.encounters ?? []).map(encounterViewOf),
    rewards: (scene.rewards ?? []).map(rewardViewOf),
  };
}

/** 按 id 找场景下标（找不到 -1）。 */
export function findSceneIndex(module: ModuleDef, sceneId: string): number {
  return module.scenes.findIndex((scene) => scene.id === sceneId);
}

/** 跨场景按 encounterId 找遭遇（trpg_combat({encounterId}) 用）。 */
export function findEncounterInModule(
  module: ModuleDef,
  encounterId: string,
): { encounter: SceneEncounterView; scene: SceneDataView } | undefined {
  const wanted = encounterId.trim();
  if (wanted.length === 0) return undefined;
  for (let index = 0; index < module.scenes.length; index += 1) {
    const scene = sceneDataOf(module, index);
    if (scene === undefined) continue;
    const encounter = scene.encounters.find((candidate) => candidate.id === wanted);
    if (encounter !== undefined) return { encounter, scene };
  }
  return undefined;
}

export type ToolNameMap = Record<string, string>;

/** 场景数据 → GM 提示文本（玩家不可见；引用实际注册的工具名）。 */
export function formatSceneData(
  scene: SceneDataView,
  toolNames: ToolNameMap = {},
  hasRulesRuntime = false,
): string {
  const n = (name: string): string => toolNames[name] ?? name;
  const lines: string[] = [
    `【本场可用（${scene.id}｜${scene.title}）】（GM 专用：玩家不可见，不要把这一段原样念给玩家）`,
  ];
  let dataLines = 0;
  for (const beat of scene.beats) {
    lines.push(`- 节拍：${beat.trigger} → ${beat.effect}`);
    dataLines += 1;
  }
  for (const check of scene.checks) {
    lines.push(
      `- 判定：${check.when} → ${check.skill} DC ${check.dc}（成功：${check.success}；失败：${check.failure}）${check.private ? '（暗骰）' : ''} → ${n('roll_check')}`,
    );
    dataLines += 1;
  }
  for (const encounter of scene.encounters) {
    const monsters = encounter.monsters.map((group) => `${group.monsterId}×${group.count}`).join('、');
    const overrides = [
      encounter.maxRounds !== undefined ? `maxRounds=${encounter.maxRounds}` : '',
      encounter.battleMapId !== undefined ? `battleMapId=${encounter.battleMapId}` : '',
    ]
      .filter((part) => part.length > 0)
      .join('；');
    const openHint = hasRulesRuntime
      ? `${n('combat')}({action:'start', encounterId:'${encounter.id}'}) 自动展开怪物并应用本场覆盖`
      : `${n('start_combat')}({encounterId:'${encounter.id}'}) 开战`;
    lines.push(
      `- 遭遇：${encounter.id}（${monsters}${overrides.length > 0 ? `；${overrides}` : ''}）${encounter.note !== undefined ? `｜${encounter.note}` : ''} → ${openHint}`,
    );
    dataLines += 1;
  }
  for (const reward of scene.rewards) {
    lines.push(
      `- 奖励：第 ${reward.index + 1} 项 XP ${reward.xp}；物品：${reward.items.length > 0 ? reward.items.join('、') : '无'}${reward.note !== undefined ? `（${reward.note}）` : ''} → ${n('reward')}({playerName, rewardIndex:${reward.index}}) 或 gm 直接发放`,
    );
    dataLines += 1;
  }
  if (dataLines === 0) lines.push('- （本场景没有预置判定/遭遇/奖励/节拍：按剧情自由裁量）');
  return lines.join('\n');
}

/** 本次行动相关的 GM 上下文块：当前场景数据 + 本次检索到的世界书。 */
export interface ActionContextInput {
  module: ModuleDef;
  lorebook?: LorebookDef;
  sceneIndex?: number;
  sceneId?: string;
  /** 本次行动文本（世界书关键词检索的主查询）。 */
  actionText?: string;
  /** 最近几条行动/叙事文本（补充关键词）。 */
  recentActions?: readonly string[];
  revealedIds?: readonly string[];
  loreBudget?: number;
  hasRulesRuntime?: boolean;
  toolNames?: ToolNameMap;
}

export interface ActionContextResult {
  text: string;
  scene?: SceneDataView;
  lore?: LoreSelection;
}

/**
 * 组装「本场可用内容 + 本次相关世界书」GM 上下文块（玩家不可见）。
 * 没有任何内容时返回空字符串，调用方可以直接拼接。
 */
export function buildActionContext(input: ActionContextInput): ActionContextResult {
  const sceneIndex = input.sceneIndex ?? currentSceneIndex(input.module, input.sceneId);
  const scene = sceneDataOf(input.module, sceneIndex);
  const sections: string[] = [];
  if (scene !== undefined) sections.push(formatSceneData(scene, input.toolNames ?? {}, input.hasRulesRuntime === true));

  let lore: LoreSelection | undefined;
  if (input.lorebook !== undefined) {
    const recentActions = [input.actionText ?? '', ...(input.recentActions ?? [])]
      .map((text) => text.trim())
      .filter((text) => text.length > 0)
      .slice(0, LORE_ACTION_QUERY_LIMIT);
    lore = selectLoreEntries(
      input.lorebook,
      {
        sceneIndex,
        sceneTitle: scene?.title,
        sceneEntry: scene?.entry,
        sceneLoreIds: sceneLoreIdsOf(input.module.scenes[sceneIndex]),
        revealedIds: input.revealedIds ?? [],
        recentActions,
      },
      input.loreBudget,
    );
    const loreLines = ['【本次相关世界书】（按场景/已揭示/关键词检索；未列出的秘密不要主动展开）'];
    loreLines.push(lore.text.length > 0 ? lore.text : '（本次没有命中的世界书条目；需要时用 check_lore 查询）');
    if (lore.dropped.length > 0) {
      loreLines.push(`（另有 ${lore.dropped.length} 条候选超出预算未注入；需要时用 check_lore 查询）`);
    }
    sections.push(loreLines.join('\n'));
  }

  return {
    text: sections.join('\n\n'),
    ...(scene !== undefined ? { scene } : {}),
    ...(lore !== undefined ? { lore } : {}),
  };
}

/** 已选中条目的原因标签（诊断/测试用）。 */
export function loreReasonLabels(selected: SelectedLoreEntry): string[] {
  return selected.reasons.map((reason) => LORE_REASON_LABEL[reason]);
}

// ---------------------------------------------------------------------------
// 系统提示 / 单次行动提示
// ---------------------------------------------------------------------------

export interface GmSystemPromptOptions {
  /** 系统提示里注入的世界书上下文（缺省只注入 alwaysOn）。 */
  loreContext?: LoreSelectionContext;
  /** 世界书字符预算（默认 {@link DEFAULT_LORE_BUDGET}）。 */
  loreBudget?: number;
  /** 房间是否有规则运行时：决定工具清单用通用工具还是旧战斗工具。 */
  hasRulesRuntime?: boolean;
}

function toolsSection(n: (name: string) => string, hasRulesRuntime: boolean): string[] {
  const lines = [
    `- ${n('roll_check')}：做技能/属性/豁免检定（引擎掷骰并返回骰面、总值、DC 与成败）${hasRulesRuntime ? '；参数用 actorId + kind/skill + dc' : '；参数用 playerName + skill + dc'}。`,
    `- ${n('roll_dice')}：自由掷骰（伤害、随机表等）。`,
    `- ${n('secret_note')}：给某位玩家发私密信息。`,
    `- ${n('reveal_lore')}：把某条世界书内容揭示给全桌（揭示后才会进入后续提示）。`,
    `- ${n('check_lore')}：按关键词查世界书。`,
    `- ${n('list_party')}：查看队伍角色卡摘要。`,
    `- ${n('scene')}：查看/推进当前场景，返回本场判定、遭遇、奖励与节拍。`,
    `- ${n('reward')}：按当前场景奖励或自定义 XP 给某位玩家发奖励（复用 gm.award）。`,
  ];
  if (hasRulesRuntime) {
    lines.push(
      `- ${n('use_action')}：按规则包动作结算（{actionId, actorId, targetId?}），命中/伤害/骰面只以返回值叙事。`,
      `- ${n('move')}：按格子/区域移动（{actorId, to:{x,y} 或 {zoneId}}），距离/移动力由规则运行时校验。`,
      `- ${n('combat')}：战斗结算（{action:'start'|'next'|'end'|'status', encounterId?, monsters?, maxRounds?, battleMapId?}）；start 可用 encounterId 展开模组遭遇并应用本场 maxRounds/battleMapId 覆盖。`,
      `- 旧名 ${n('start_combat')} / ${n('attack')} / ${n('next_turn')} / ${n('combat_status')} / ${n('end_combat')} 仍可用，内部等价于上面的通用工具。`,
    );
  } else {
    lines.push(
      `- ${n('start_combat')} / ${n('attack')} / ${n('next_turn')} / ${n('combat_status')} / ${n('end_combat')}：战斗结算（先攻、攻击、轮次）。`,
    );
  }
  return lines;
}

/** 系统提示：GM 守则 + 模组骨架 + 场景骨架 + 世界书检索策略 + 工具清单。每个房间的 GM 会话常驻一份。 */
export function buildGmSystemPrompt(
  module: ModuleDef,
  lorebook: LorebookDef,
  toolNames: ToolNameMap = {},
  options: GmSystemPromptOptions = {},
): string {
  const n = (name: string): string => toolNames[name] ?? name;
  const hasRulesRuntime = options.hasRulesRuntime === true;
  const scenes = module.scenes.map((scene) => `- 【${scene.title}】${scene.entry}`).join('\n');
  const npcs = module.npcs.map((npc) => `- ${npc.name}：${npc.description}`).join('\n');
  const loreContext: LoreSelectionContext = { ...(options.loreContext ?? {}) };
  const lore = selectLoreEntries(lorebook, loreContext, options.loreBudget ?? DEFAULT_LORE_BUDGET);
  const loreLines = [
    '## 世界书（按需检索）',
    '只注入常驻条目、当前场景关联条目与本场已揭示条目；其余条目在每次行动时按行动文本/场景文本自动检索注入。',
    lore.text.length > 0 ? lore.text : '（当前没有入选的常驻/场景关联条目）',
    lore.dropped.length > 0 ? `（另有 ${lore.dropped.length} 条常驻/场景候选超出预算未注入）` : '',
    '- 未被选中的〔GM 秘密〕不会出现在提示里；需要时用 check_lore 查询。',
  ].filter((line) => line !== '');
  const actionRule = hasRulesRuntime
    ? `3c. 战斗/动作/移动一律走 ${n('use_action')} / ${n('move')} / ${n('combat')} 工具（检定走 ${n('roll_check')}），不要用叙事直接决定命中、伤害或位置。`
    : `3c. 战斗相关一律走 ${n('start_combat')} / ${n('attack')} / ${n('next_turn')} / ${n('end_combat')} 工具，不要用叙事直接决定命中或伤害。`;
  return [
    `你是《${module.title}》的 KP/GM（主持人），正在一个局域网跑团桌上带团。规则是 D&D 5e-lite（中文奇幻皮）。`,
    '',
    '## 你的职责',
    '- 描述场景、扮演所有 NPC、判定玩家行动的后果、推进剧情；玩家只负责扮演自己的角色。',
    '- 需要判定时调用工具掷骰，用工具返回的骰面与成败来叙述结果。',
    '',
    '## 硬规则（违反会让整桌跑团崩坏）',
    '1. 绝不替玩家角色写行动、台词或心理活动；玩家角色说过什么、做过什么，只以玩家提交的内容为准。',
    '2. 每次只回应「本次行动者」一个人提交的行动；其他玩家没有动作时，不要替他们行动或发言。',
    '3. 骰子、检定、伤害数值只能来自工具结果；不要自己编造数值，也不要假装掷骰。',
    `3b. 以下行动一律必须先调用 ${n('roll_check')} 工具再叙述结果：观察/偷听/搜索/调查/识破谎言/威吓/说服/潜行/攀爬/辨认符文/任何有失败可能的尝试。工具报错就如实告诉玩家“判定失败”，不得用文字替代掷骰。`,
    actionRule,
    '4. 一次回复 2–6 句，节奏紧凑，中文第二人称（“你”指行动者），结尾留出下一步的选择或问题。',
    `5. 标〔GM 秘密〕的内容不得直接说破；只有调用 ${n('reveal_lore')} 揭示给全桌后，才可以作为公开信息使用。`,
    `6. 只想让某一位玩家知道的信息，用 ${n('secret_note')} 工具私发，不要写进公共叙事。`,
    '7. 不要向玩家解释规则术语或工具机制，用世界内的语言描述结果。',
    '8. 模组场景数据（判定/遭遇/奖励/节拍）以「本场可用」形式注入，是给你参考的剧透；只把它当成幕后信息，不要整段朗读。',
    '',
    '## 模组概要',
    module.synopsis,
    '',
    module.gmNotes ? `## GM 备注\n${module.gmNotes}` : '',
    '',
    '## 场景（按顺序推进，由你判断何时切换；用 ' + n('scene') + ' 查看/推进）',
    scenes,
    '',
    '## NPC',
    npcs,
    '',
    ...loreLines,
    '',
    '## 可用工具',
    ...toolsSection(n, hasRulesRuntime),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatRecent(events: PromptEvent[]): string {
  if (events.length === 0) return '（本桌还没有发生过事件）';
  return events
    .map((event) => {
      const target = event.to === 'all' ? '' : event.to === 'gm' ? '（仅GM）' : '（私密）';
      return `[${event.seq}] ${event.kind}${target}：${event.text.slice(0, 160)}`;
    })
    .join('\n');
}

export interface TurnPromptInput {
  module: ModuleDef;
  roomTitle: string;
  actor: { playerName: string; characterName?: string };
  actionText: string;
  private: boolean;
  party: PromptPlayer[];
  recent: PromptEvent[];
  sceneIndex?: number;
  sceneId?: string;
  /** 世界书（传入才做按需检索注入）。 */
  lorebook?: LorebookDef;
  revealedIds?: readonly string[];
  loreBudget?: number;
  hasRulesRuntime?: boolean;
  toolNames?: ToolNameMap;
}

/** 单次行动的 user 消息：只包含本次行动者与最近事件，避免 AI 把多个玩家混在一起。 */
export function buildTurnPrompt(input: TurnPromptInput): string {
  const partyLines = input.party
    .map((player) => {
      const character = player.characterName
        ? `${player.characterName}（${player.characterClass ?? '?'} ${player.level ?? '?'} 级，HP ${player.hp ?? '?'}/${player.hpMax ?? '?'}，AC ${player.ac ?? '?'}）`
        : '未落座';
      return `- 玩家「${player.name}」：${character}${player.publicSummary ? ` — ${player.publicSummary}` : ''}`;
    })
    .join('\n');

  const sceneIndex = input.sceneIndex ?? currentSceneIndex(input.module, input.sceneId);
  const context = buildActionContext({
    module: input.module,
    ...(input.lorebook !== undefined ? { lorebook: input.lorebook } : {}),
    sceneIndex,
    ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
    actionText: input.actionText,
    recentActions: input.recent
      .filter((event) => event.kind === '叙事' || event.kind === '掷骰')
      .slice(-LORE_ACTION_QUERY_LIMIT)
      .map((event) => event.text),
    ...(input.revealedIds !== undefined ? { revealedIds: input.revealedIds } : {}),
    ...(input.loreBudget !== undefined ? { loreBudget: input.loreBudget } : {}),
    ...(input.hasRulesRuntime !== undefined ? { hasRulesRuntime: input.hasRulesRuntime } : {}),
    ...(input.toolNames !== undefined ? { toolNames: input.toolNames } : {}),
  });

  return [
    `【房间】${input.roomTitle}`,
    `【行动者】玩家「${input.actor.playerName}」${input.actor.characterName ? `（角色：${input.actor.characterName}）` : ''}`,
    '本次只有这一位玩家行动；请只回应该行动，不要替其他玩家做决定。',
    '',
    '【队伍】',
    partyLines,
    '',
    ...(context.text.length > 0 ? ['【GM 幕后备注（玩家不可见）】', context.text, ''] : []),
    '【最近事件】',
    formatRecent(input.recent),
    '',
    input.private ? '【行动内容（悄悄话，只有你和该玩家知道）】' : '【行动内容】',
    input.actionText,
    '',
    '请以 GM 身份叙述这次行动的结果。需要判定就调用 roll_check；不要自己编骰子结果。',
  ].join('\n');
}
