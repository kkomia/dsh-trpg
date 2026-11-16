/**
 * M8.4 GM 检索注入 + 模组数据消费单测（纯函数层）。
 *
 * 覆盖：selectLoreEntries（预算/alwaysOn/场景关联/已 reveal/关键词/秘密过滤/排序）+
 * buildTurnPrompt/buildActionContext 对当前场景 beats/checks/encounters/rewards 的注入
 * （含 maxRounds/battleMapId 覆盖说明）+ 系统提示的工具清单映射。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUIMUYA_LOREBOOK,
  GUIMUYA_MODULE,
  type EncounterDef,
  type LoreEntry,
  type LorebookDef,
  type ModuleDef,
} from '@dsh-trpg/content';
import {
  DEFAULT_LORE_BUDGET,
  buildActionContext,
  buildGmSystemPrompt,
  buildTurnPrompt,
  findEncounterInModule,
  renderLoreEntry,
  sceneDataOf,
  selectLoreEntries,
  type PromptEvent,
  type PromptPlayer,
} from '../src/host/gm/prompt.ts';

function entryOf(partial: Partial<LoreEntry> & { id: string }): LoreEntry {
  return {
    id: partial.id,
    keys: partial.keys ?? [],
    visibility: partial.visibility ?? 'public',
    priority: partial.priority ?? 0,
    content: partial.content ?? `内容-${partial.id}`,
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    ...(partial.alwaysOn !== undefined ? { alwaysOn: partial.alwaysOn } : {}),
  };
}

function bookOf(entries: LoreEntry[]): LorebookDef {
  return { schemaVersion: 1, id: 'test-lore', title: '测试世界书', entries };
}

const PARTY: PromptPlayer[] = [
  { playerId: 'p1', name: '阿青', characterName: '阿青', characterClass: '武者', level: 1, hp: 12, hpMax: 12, ac: 16 },
];

const RECENT: PromptEvent[] = [{ seq: 1, kind: '叙事', to: 'all', text: 'GM：夜色压在青石镇上。' }];

/** 场景 2（古洞）的遭遇加上 maxRounds/battleMapId 覆盖（legacy 类型未声明，host 按可选字段消费）。 */
function moduleWithEncounterOverrides(): ModuleDef {
  return {
    ...GUIMUYA_MODULE,
    scenes: GUIMUYA_MODULE.scenes.map((scene, index) => {
      if (index !== 1) return scene;
      return {
        ...scene,
        encounters: (scene.encounters ?? []).map((encounter, encounterIndex) =>
          encounterIndex === 0
            ? ({ ...encounter, maxRounds: 8, battleMapId: 'map_cave_mouth' } as unknown as EncounterDef)
            : encounter,
        ),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// selectLoreEntries
// ---------------------------------------------------------------------------

test('selectLoreEntries：alwaysOn 无条件入选，普通条目不入；保留〔公开〕标记', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_always', keys: ['甲'], content: '常驻设定', alwaysOn: true }),
    entryOf({ id: 'entry_normal', keys: ['乙'], content: '普通设定' }),
  ]);
  const selection = selectLoreEntries(lorebook, {});
  assert.deepEqual(selection.entries.map((selected) => selected.entry.id), ['entry_always']);
  assert.equal(selection.text.includes('〔公开〕'), true);
  assert.equal(selection.text.includes('常驻设定'), true);
  assert.equal(selection.text.includes('普通设定'), false);
  assert.ok(selection.usedChars <= DEFAULT_LORE_BUDGET);
  assert.equal(selection.budget, DEFAULT_LORE_BUDGET);
});

test('selectLoreEntries：当前场景关联条目（sceneLoreIds）入选', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_scene', keys: ['青石镇'], content: '场景关联设定' }),
    entryOf({ id: 'entry_other', keys: ['昆仑'], content: '无关设定' }),
  ]);
  const selection = selectLoreEntries(lorebook, { sceneLoreIds: ['entry_scene'] });
  assert.deepEqual(selection.entries.map((selected) => selected.entry.id), ['entry_scene']);
});

test('selectLoreEntries：本场已 reveal 条目入选（reason=revealed）', () => {
  const lorebook = bookOf([entryOf({ id: 'entry_rev', keys: ['禁地'], content: '已揭示线索' })]);
  const selection = selectLoreEntries(lorebook, { revealedIds: ['entry_rev'] });
  assert.deepEqual(selection.entries.map((selected) => selected.entry.id), ['entry_rev']);
  assert.deepEqual(selection.entries[0]?.reasons, ['revealed']);
});

test('selectLoreEntries：关键词命中来自最近玩家行动文本（keys 方向匹配）', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_key', keys: ['枯木崖', '绿光'], title: '枯木崖', content: '崖下有绿光' }),
    entryOf({ id: 'entry_no', keys: ['剑宗'], content: '无关' }),
  ]);
  const selection = selectLoreEntries(lorebook, { recentActions: ['我想去枯木崖看看那团绿光'] });
  assert.deepEqual(selection.entries.map((selected) => selected.entry.id), ['entry_key']);
  assert.ok(selection.entries[0]?.reasons.includes('keyword'));
});

test('selectLoreEntries：关键词命中来自场景标题/开场（title/content 方向）', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_title', keys: ['无'], title: '青石镇', content: '边陲小镇' }),
    entryOf({ id: 'entry_content', keys: ['无'], content: '石壁上刻满符文' }),
    entryOf({ id: 'entry_miss', keys: ['无'], content: '完全无关' }),
  ]);
  const selection = selectLoreEntries(lorebook, {
    sceneTitle: '青石镇·悬赏',
    sceneEntry: '洞口的石壁上刻满符文。',
  });
  const ids = selection.entries.map((selected) => selected.entry.id);
  assert.ok(ids.includes('entry_title'), '场景标题应命中有 title 的条目');
  assert.ok(ids.includes('entry_content'), '开场旁白的关键词应命中 content');
  assert.equal(ids.includes('entry_miss'), false);
});

test('selectLoreEntries：秘密过滤——GM 提示含 public+gm，玩家可见只 public；player:<id> 不进 GM 提示', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_public' }),
    entryOf({ id: 'entry_gm', visibility: 'gm', content: '幕后真相' }),
    entryOf({ id: 'entry_player', visibility: 'player:p1', content: '只给阿青的暗线' }),
  ]);
  const gmSelection = selectLoreEntries(lorebook, {
    sceneLoreIds: ['entry_public', 'entry_gm', 'entry_player'],
  });
  const gmIds = gmSelection.entries.map((selected) => selected.entry.id);
  assert.deepEqual(gmIds, ['entry_public', 'entry_gm'], 'gm 秘密与公开条目入选（同档按原序），限人条目不进 GM 提示');
  assert.ok(gmSelection.text.includes('〔GM 秘密〕'));
  assert.ok(gmSelection.text.includes('〔公开〕'));
  assert.equal(gmSelection.text.includes('只给阿青的暗线'), false);

  const playerSelection = selectLoreEntries(lorebook, {
    sceneLoreIds: ['entry_public', 'entry_gm', 'entry_player'],
    includeSecrets: false,
  });
  assert.deepEqual(playerSelection.entries.map((selected) => selected.entry.id), ['entry_public']);
});

test('selectLoreEntries：未命中的 GM 秘密不出现；选中后才带〔GM 秘密〕', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_secret', visibility: 'gm', keys: ['阵眼'], content: '阵眼在三枚符文石里' }),
  ]);
  const miss = selectLoreEntries(lorebook, { recentActions: ['我在镇上喝茶'] });
  assert.equal(miss.entries.length, 0);
  assert.equal(miss.text.includes('阵眼在三枚符文石里'), false);
  const hit = selectLoreEntries(lorebook, { recentActions: ['我寻找阵眼'] });
  assert.equal(hit.text.includes('〔GM 秘密〕'), true);
});

test('selectLoreEntries：字符预算上限生效，超出预算的候选被丢弃并记录 dropped', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_top', keys: ['无'], content: '常驻内容'.repeat(8), alwaysOn: true, priority: 100 }),
    entryOf({ id: 'entry_scene', keys: ['无'], content: '场景内容' }),
    entryOf({ id: 'entry_key', keys: ['枯木崖'], content: '关键词内容' }),
  ]);
  const full = selectLoreEntries(lorebook, { sceneLoreIds: ['entry_scene'], recentActions: ['去枯木崖'] }, 100000);
  assert.equal(full.entries.length, 3);
  const topChars = full.entries[0]?.chars ?? 0;
  const sceneChars = full.entries[1]?.chars ?? 0;
  // 预算恰好装下 alwaysOn + 场景条目，关键词条目应被丢弃。
  const tight = selectLoreEntries(
    lorebook,
    { sceneLoreIds: ['entry_scene'], recentActions: ['去枯木崖'] },
    topChars + sceneChars,
  );
  assert.deepEqual(tight.entries.map((selected) => selected.entry.id), ['entry_top', 'entry_scene']);
  assert.deepEqual(tight.dropped, ['entry_key']);
  assert.ok(tight.usedChars <= tight.budget);
});

test('selectLoreEntries：排序 alwaysOn > 场景 > 已 reveal > 关键词；同档按 priority 降序', () => {
  const lorebook = bookOf([
    entryOf({ id: 'entry_key', keys: ['异光'], priority: 100 }),
    entryOf({ id: 'entry_rev', priority: 10 }),
    entryOf({ id: 'entry_scene_low', priority: 1 }),
    entryOf({ id: 'entry_scene_high', priority: 9 }),
    entryOf({ id: 'entry_always', priority: 0, alwaysOn: true }),
  ]);
  const selection = selectLoreEntries(lorebook, {
    sceneLoreIds: ['entry_scene_low', 'entry_scene_high'],
    revealedIds: ['entry_rev'],
    recentActions: ['异光'],
  });
  assert.deepEqual(
    selection.entries.map((selected) => selected.entry.id),
    ['entry_always', 'entry_scene_high', 'entry_scene_low', 'entry_rev', 'entry_key'],
  );
});

test('renderLoreEntry：三种可见性标记与 id/标题格式稳定', () => {
  assert.equal(
    renderLoreEntry(entryOf({ id: 'entry_x', title: '条目', content: '正文' })),
    '- 〔公开〕条目（id: entry_x）：正文',
  );
  assert.equal(
    renderLoreEntry(entryOf({ id: 'entry_y', visibility: 'player:p2', content: '暗线' })),
    '- 〔限人〕entry_y（id: entry_y）：暗线',
  );
});

// ---------------------------------------------------------------------------
// 场景数据注入（buildActionContext / buildTurnPrompt）
// ---------------------------------------------------------------------------

test('sceneDataOf：把 legacy 场景的 beats/checks/encounters/rewards 归一化，并读取 maxRounds/battleMapId', () => {
  const module = moduleWithEncounterOverrides();
  const scene = sceneDataOf(module, 1);
  assert.equal(scene?.id, 'scene_guimuya');
  assert.equal(scene?.checks.length, 3);
  assert.equal(scene?.checks[0]?.skill, 'perception');
  assert.equal(scene?.checks[0]?.dc, 13);
  assert.equal(scene?.encounters.length, 2);
  assert.equal(scene?.encounters[0]?.id, 'enc_guihuo');
  assert.equal(scene?.encounters[0]?.maxRounds, 8);
  assert.equal(scene?.encounters[0]?.battleMapId, 'map_cave_mouth');
  assert.equal(scene?.rewards[0]?.xp, 30);
  assert.deepEqual(scene?.rewards[0]?.items, ['fuwen']);
  assert.equal(scene?.beats[0]?.effect.includes('scene_shendong'), true);
});

test('findEncounterInModule：跨场景按 encounterId 找到遭遇与所属场景', () => {
  const module = moduleWithEncounterOverrides();
  const found = findEncounterInModule(module, 'enc_boss');
  assert.equal(found?.scene.id, 'scene_shendong');
  assert.equal(found?.encounter.monsters.length, 2);
  assert.equal(findEncounterInModule(module, 'enc_missing'), undefined);
});

test('buildTurnPrompt：分区注入当前场景判定/遭遇/奖励/节拍 + 遭遇覆盖说明（GM 专用）', () => {
  const module = moduleWithEncounterOverrides();
  const prompt = buildTurnPrompt({
    module,
    roomTitle: '鬼木崖·异光',
    actor: { playerName: '阿青', characterName: '阿青' },
    actionText: '我蹲下查看洞口的痕迹。',
    private: false,
    party: PARTY,
    recent: RECENT,
    sceneIndex: 1,
    lorebook: GUIMUYA_LOREBOOK,
    hasRulesRuntime: true,
    toolNames: { combat: 'trpg_combat', roll_check: 'trpg_roll_check', reward: 'trpg_reward' },
  });
  assert.ok(prompt.includes('【GM 幕后备注（玩家不可见）】'));
  assert.ok(prompt.includes('本场可用（scene_guimuya'));
  assert.ok(prompt.includes('检查洞口的痕迹'), '应注入 checks.when');
  assert.ok(prompt.includes('perception DC 13'), '应注入 checks.skill/dc');
  assert.ok(prompt.includes('三组不同的鞋印'), '应注入 checks.success');
  assert.ok(prompt.includes('enc_guihuo'), '应注入 encounterId');
  assert.ok(prompt.includes('guihuo×2'), '应注入怪物组');
  assert.ok(prompt.includes('maxRounds=8'), '应注入遭遇 maxRounds 覆盖');
  assert.ok(prompt.includes('battleMapId=map_cave_mouth'), '应注入遭遇 battleMapId 覆盖');
  assert.ok(prompt.includes('trpg_combat'), '有规则运行时应引用 trpg_combat');
  assert.ok(prompt.includes('XP 30'), '应注入场景奖励');
  assert.ok(prompt.includes('fuwen'), '应注入奖励物品');
  assert.ok(prompt.includes('进入洞中深处或找到阵眼'), '应注入 beats.effect');
  assert.ok(prompt.includes('本次相关世界书'));
  // 本场景关联条目入选；没有命中关键词的秘密条目不会出现（按 CONTENT-MODEL §5.1 的候选口径）。
  assert.ok(prompt.includes('〔公开〕枯木崖'));
  assert.equal(prompt.includes('（id: entry_gm_liu）'), false, '未命中的秘密条目不注入');
  assert.equal(prompt.includes('（id: entry_laolieren）'), false, '未被场景/关键词选中的公开条目也不注入');
});

test('buildTurnPrompt：无规则运行时引用旧名 start_combat；正文含玩家不可见提示', () => {
  const prompt = buildTurnPrompt({
    module: GUIMUYA_MODULE,
    roomTitle: '鬼木崖·异光',
    actor: { playerName: '阿青' },
    actionText: '我守在洞口。',
    private: false,
    party: PARTY,
    recent: [],
    sceneIndex: 1,
    lorebook: GUIMUYA_LOREBOOK,
    hasRulesRuntime: false,
    toolNames: { start_combat: 'trpg_start_combat' },
  });
  assert.ok(prompt.includes('trpg_start_combat'));
  assert.equal(prompt.includes('action:\'start\''), false);
});

test('buildTurnPrompt：行动文本关键词命中世界书（含已揭示秘密）并保留标记', () => {
  const prompt = buildTurnPrompt({
    module: GUIMUYA_MODULE,
    roomTitle: '鬼木崖·异光',
    actor: { playerName: '阿青' },
    actionText: '我辨认石壁上的符文。',
    private: false,
    party: PARTY,
    recent: [],
    sceneIndex: 1,
    lorebook: GUIMUYA_LOREBOOK,
    revealedIds: ['entry_gm_chishan'],
  });
  assert.ok(prompt.includes('entry_dongfu'), '「符文」应命中古洞条目');
  assert.ok(prompt.includes('〔GM 秘密〕赤目道人'), '已 reveal 的秘密应重新注入并保留秘密标记');
});

test('buildActionContext：无场景数据时返回空文本（调用方可直接拼接）', () => {
  const module: ModuleDef = { ...GUIMUYA_MODULE, scenes: [] };
  const context = buildActionContext({ module, actionText: '随便看看' });
  assert.equal(context.text, '');
  assert.equal(context.scene, undefined);
});

test('buildGmSystemPrompt：toolNames 映射同步 + 按是否有规则运行时切换工具清单', () => {
  const names = {
    roll_check: 'trpg_roll_check',
    roll_dice: 'trpg_roll_dice',
    secret_note: 'trpg_secret_note',
    reveal_lore: 'trpg_reveal_lore',
    check_lore: 'trpg_check_lore',
    list_party: 'trpg_list_party',
    scene: 'trpg_scene',
    reward: 'trpg_reward',
    use_action: 'trpg_use_action',
    move: 'trpg_move',
    combat: 'trpg_combat',
    start_combat: 'trpg_start_combat',
    attack: 'trpg_attack',
    next_turn: 'trpg_next_turn',
    combat_status: 'trpg_combat_status',
    end_combat: 'trpg_end_combat',
  };
  const withRules = buildGmSystemPrompt(GUIMUYA_MODULE, GUIMUYA_LOREBOOK, names, { hasRulesRuntime: true });
  assert.ok(withRules.includes('trpg_use_action'));
  assert.ok(withRules.includes('trpg_move'));
  assert.ok(withRules.includes('trpg_combat'));
  assert.ok(withRules.includes('3c. 战斗/动作/移动一律走 trpg_use_action'));
  const withoutRules = buildGmSystemPrompt(GUIMUYA_MODULE, GUIMUYA_LOREBOOK, names, { hasRulesRuntime: false });
  assert.equal(withoutRules.includes('trpg_use_action'), false);
  assert.ok(withoutRules.includes('trpg_start_combat'));
});
