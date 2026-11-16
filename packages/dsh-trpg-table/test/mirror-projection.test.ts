import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMirrorTitle,
  diceDataOf,
  formatActionText,
  formatAwardText,
  formatCombatText,
  formatDiceText,
  formatSceneNotice,
  isMirroredTool,
  parseInjectedAction,
  parseToolArguments,
  shortToolName,
  stripPrivateActionTag,
  summarizeToolCall,
  summarizeToolResult,
  toolCallPolicy,
  toolLabel,
  truncateNarration,
  visibleTo,
  MIRROR_TOOL_RESULT_MAX_CHARS,
} from '../src/host/mirror/projection.ts';
import type { MirrorDiceData, MirrorVisibility } from '../src/host/mirror/types.ts';

test('镜像可见性：GM 看到全部，玩家只看 all + 投给自己的帧', () => {
  const host = { kind: 'host' as const };
  const alice = { kind: 'player' as const, playerId: 'p1' };
  const bob = { kind: 'player' as const, playerId: 'p2' };
  assert.equal(visibleTo('all', host), true);
  assert.equal(visibleTo('all', alice), true);
  assert.equal(visibleTo('host', host), true);
  assert.equal(visibleTo('host', alice), false);
  assert.equal(visibleTo({ playerId: 'p1' }, alice), true);
  assert.equal(visibleTo({ playerId: 'p1' }, bob), false);
  assert.equal(visibleTo({ playerId: 'p1' }, host), true);
});

test('工具可见性策略：公开结算全桌、暗骰/秘密工具只给 GM、私发投目标玩家', () => {
  assert.deepEqual(toolCallPolicy('trpg_roll_check', { dc: 12 }), { visibility: 'public' });
  assert.deepEqual(toolCallPolicy('roll_check', { dc: 12, private: true }), { visibility: 'host' });
  assert.deepEqual(toolCallPolicy('trpg_secret_note', { playerName: '阿青', text: '秘密' }), {
    visibility: 'player',
    targetPlayerName: '阿青',
  });
  assert.deepEqual(toolCallPolicy('trpg_check_lore', { query: '鬼木崖' }), { visibility: 'host' });
  assert.deepEqual(toolCallPolicy('read', { file_path: 'x' }), { visibility: 'host' });
  assert.equal(isMirroredTool('trpg_attack'), true);
  assert.equal(isMirroredTool('roll_dice'), true);
  assert.equal(isMirroredTool('pwsh'), false);
  assert.equal(shortToolName('trpg_roll_check'), 'roll_check');
  assert.equal(shortToolName('roll_check'), 'roll_check');
  assert.equal(toolLabel('trpg_secret_note'), '私密消息');
});

test('工具调用摘要：只描述语义，不复制秘密文本/原始参数', () => {
  const secret = '门后的青铜面具其实是活的';
  const summary = summarizeToolCall('trpg_secret_note', { playerName: '阿青', text: secret });
  assert.equal(summary.includes(secret), false);
  assert.match(summary, /阿青/);

  const check = summarizeToolCall('trpg_roll_check', { actorId: '阿青', skillId: 'perception', dc: 15, reason: '听门后动静', mode: 'advantage' });
  assert.match(check, /阿青/);
  assert.match(check, /perception/);
  assert.match(check, /DC 15/);
  assert.match(check, /优势/);

  assert.match(summarizeToolCall('trpg_roll_dice', { expression: '2d6+3', label: '伤害' }), /2d6\+3/);
  assert.match(summarizeToolCall('trpg_attack', { attacker: '阿青', target: '山魈' }), /阿青 → 山魈/);
  assert.match(summarizeToolCall('trpg_start_combat', { monsters: 'shanxiao*2' }), /shanxiao\*2/);
  assert.match(summarizeToolCall('trpg_reward', { playerName: '阿青', xp: 50 }), /阿青/);
  // 未知工具退回中文标签/原名，不抛错。
  assert.equal(summarizeToolCall('mystery_tool', {}), 'mystery_tool');
});

test('工具参数解析：JSON 字符串/对象/坏 JSON 都稳定', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(parseToolArguments('not-json'), {});
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments('[1,2]'), {});
});

test('工具结果摘要：空输出给占位、超长截断', () => {
  assert.match(summarizeToolResult('trpg_roll_check', '  '), /无输出/);
  const long = '甲'.repeat(MIRROR_TOOL_RESULT_MAX_CHARS + 100);
  const summary = summarizeToolResult('trpg_check_lore', long);
  assert.equal(summary.length, MIRROR_TOOL_RESULT_MAX_CHARS);
  assert.ok(summary.endsWith('…'));
});

test('行动注入文本解析：去掉「本轮 GM 幕后备注」，记录是否带备注', () => {
  const text = '【阿青】我推开门\n\n---\n\n【本轮 GM 幕后备注（玩家不可见，不要原样朗读）】\n- 判定：perception DC 12';
  const parsed = parseInjectedAction(text);
  assert.equal(parsed.text, '【阿青】我推开门');
  assert.equal(parsed.hadContext, true);
  assert.deepEqual(parseInjectedAction('【阿青】我推开门'), { text: '【阿青】我推开门', hadContext: false });
});

test('玩家行动气泡：角色名优先，私密标记只保留一个', () => {
  assert.equal(formatActionText({ playerName: '阿青', characterName: '青衣客', text: '我推开门' }), '【青衣客】我推开门');
  assert.equal(formatActionText({ playerName: '阿青', text: '我推开门' }), '【阿青】我推开门');
  assert.equal(formatActionText({ text: '我推开门' }), '【玩家】我推开门');
  assert.equal(formatActionText({ playerName: '阿青', text: '我推开门（悄悄话给 GM）', private: true }), '【阿青】（悄悄话）我推开门');
  assert.equal(stripPrivateActionTag('我推开门（悄悄话给 GM）'), '我推开门');
  assert.equal(formatActionText({ playerName: '阿青', text: '我推开门' }).includes('幕后备注'), false);
});

test('掷骰文本：骰面/总值/检定 DC/暗骰都如实呈现', () => {
  const data: MirrorDiceData = {
    expression: 'd20',
    dice: [12],
    modifier: 3,
    total: 15,
    label: '侦察',
    rollerName: '阿青',
    private: false,
    check: { kind: 'skill', name: 'perception', dc: 12, success: true },
  };
  const text = formatDiceText(data);
  assert.match(text, /阿青/);
  assert.match(text, /d20/);
  assert.match(text, /\[12\]/);
  assert.match(text, /\+ 3/);
  assert.match(text, /= 15/);
  assert.match(text, /DC 12 → 成功/);
  assert.equal(formatDiceText({ ...data, private: true }).includes('暗骰'), true);
});

test('diceDataOf：复制骰面数组，不共享引用', () => {
  const payload = {
    expression: '2d6',
    dice: [3, 4],
    modifier: 0,
    total: 7,
    rollerName: 'GM',
    playerId: 'p1',
    private: false,
  };
  const data = diceDataOf(payload);
  assert.deepEqual(data.dice, [3, 4]);
  payload.dice.push(5);
  assert.deepEqual(data.dice, [3, 4]);
});

test('战斗摘要：兼容旧 combat view 与 M9.4 CombatView，未知形状给通用文案', () => {
  const legacy = formatCombatText({
    view: {
      round: 2,
      activeId: 'pc1',
      activeName: '阿青',
      order: [
        { id: 'pc1', name: '阿青', downed: false, dead: false },
        { id: 'm1', name: '山魈', downed: true, dead: false },
      ],
    },
  });
  assert.match(legacy, /第 2 轮/);
  assert.match(legacy, /阿青/);
  assert.match(legacy, /存活 1\/2/);

  const modern = formatCombatText({
    combat: {
      round: 3,
      maxRounds: 10,
      activeActorId: 'pc1',
      tokens: [
        { actorId: 'pc1', name: '阿青', dead: false },
        { actorId: 'm1', name: '山魈', dead: true },
      ],
    },
  });
  assert.match(modern, /第 3\/10 轮/);
  assert.match(modern, /行动：阿青/);
  assert.match(modern, /存活 1\/2/);

  assert.match(formatCombatText(undefined), /战斗状态更新/);
});

test('奖励/场景/标题文本：私发文案与「跑团桌：<房名>」', () => {
  assert.match(formatAwardText({ playerName: '阿青', xp: 50, items: ['青铜面具'], note: '首功' }), /阿青 获得 50 XP/);
  assert.match(formatAwardText({ playerName: '阿青', xp: 50, items: ['青铜面具'] }), /青铜面具/);
  assert.match(formatSceneNotice('scene_02', '废弃道观'), /场景：废弃道观/);
  assert.match(formatSceneNotice('scene_02'), /scene_02/);
  assert.equal(buildMirrorTitle('鬼木崖·异光'), '跑团桌：鬼木崖·异光');
  assert.equal(buildMirrorTitle('   '), '跑团桌');
  assert.equal(buildMirrorTitle(undefined), '跑团桌');
  assert.ok(buildMirrorTitle('长'.repeat(200)).length <= 80);
});

test('超长叙事截断：保留首段且不超过上限', () => {
  const text = '甲'.repeat(20000);
  assert.equal(truncateNarration(text).length, 12000);
  assert.ok(truncateNarration(text).endsWith('…'));
  assert.equal(truncateNarration('短文本'), '短文本');
});

test('可见性联合类型：private 帧只出现在目标玩家的重放里', () => {
  const visibility: MirrorVisibility = { playerId: 'p2' };
  assert.equal(visibleTo(visibility, { kind: 'player', playerId: 'p1' }), false);
  assert.equal(visibleTo(visibility, { kind: 'player', playerId: 'p2' }), true);
  assert.equal(visibleTo(visibility, { kind: 'host' }), true);
});
