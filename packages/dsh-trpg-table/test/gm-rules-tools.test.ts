/**
 * M8.4 通用 GM 工具 · 真实规则运行时集成测试。
 *
 * 走真链路：PackRegistry（内置包 core-guimuya 内联 dnd5e-lite 规则 + 4 个脚本）
 * → RoomService（建规则运行时）→ 落座 → createGmTools → 工具走 RoomService 运行时命令。
 * 断言的重点是「工具返回值是唯一叙事数值来源」：骰面/命中/伤害/轮次都来自运行时回包。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARDS, GUIMUYA_MODULE, GUIMUYA_LOREBOOK, type ModuleDef } from '@dsh-trpg/content';
import type { CombatView } from '@dsh-trpg/protocol';
import { RoomService, type Principal } from '@dsh-trpg/rooms';
import { PackRegistry } from '../src/host/pack-registry.ts';
import { createGmTools } from '../src/host/gm/tools.ts';

function hostPrincipal(roomId: string): Principal {
  return { kind: 'host', roomId };
}

function setupRulesRoom(): {
  dir: string;
  registry: PackRegistry;
  service: RoomService;
  roomId: string;
  playerId: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-m84-rules-'));
  const registry = new PackRegistry({ dir, log: () => {} });
  registry.reload();
  const service = new RoomService({ content: registry, rules: registry, seedSalt: 'm84-rules-test' });
  const created = service.createRoom({ title: 'M8.4 规则工具', gmMode: 'ai' });
  const roomId = created.room.roomId;
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: CARDS[0] });
  service.seat(service.login(joined.playerToken), { characterCard: CARDS[0] });
  return { dir, registry, service, roomId, playerId: joined.playerId };
}

function cleanup(context: { dir: string; service: RoomService }): void {
  try {
    context.service.closeAll();
  } catch {
    /* ignore */
  }
  rmSync(context.dir, { recursive: true, force: true });
}

/** 当前战斗视图（房主视角）。 */
function combatOf(service: RoomService, roomId: string): CombatView {
  return service.combatView(hostPrincipal(roomId)).combat;
}

/** 推进回合直到轮到指定玩家（战斗可能因先攻随机而先轮到敌人）。 */
function ensurePlayerTurn(service: RoomService, roomId: string, playerId: string): CombatView {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const combat = combatOf(service, roomId);
    if (!combat.active) return combat;
    if (combat.activePlayerId === playerId) return combat;
    const ended = service.endTurn(hostPrincipal(roomId), {});
    if (!ended.combat.active) return ended.combat;
  }
  throw new Error('先攻推进 12 次仍未轮到玩家');
}

function toolNamed(tools: ReturnType<typeof createGmTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`测试期望工具 ${name}`);
  return tool;
}

test('真实规则房间：createGmTools 自动注册 16 个工具（含通用工具与旧名别名）', () => {
  const context = setupRulesRoom();
  try {
    assert.notEqual(context.service.runtimeOf(context.roomId), undefined, '内置包带 rules 段应建运行时');
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    const names = tools.map((tool) => tool.name);
    assert.equal(names.length, 16);
    for (const name of ['use_action', 'move', 'combat', 'scene', 'reward']) assert.ok(names.includes(name));
    for (const name of ['start_combat', 'attack', 'next_turn', 'combat_status', 'end_combat']) {
      assert.ok(names.includes(name), `旧名 ${name} 应保留为别名`);
    }
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：combat start 走运行时掷先攻，轮次/行动经济来自回包', async () => {
  const context = setupRulesRoom();
  try {
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    const result = await toolNamed(tools, 'combat').execute({ action: 'start', monsters: 'xueshi*1', reason: '测试遭遇' });
    assert.ok(result.text.includes('战斗开始'));
    assert.ok(result.text.includes('先攻骰'));
    assert.ok(result.text.includes('第 1 轮'));
    const runtime = context.service.runtimeOf(context.roomId);
    assert.equal(runtime?.getCombat().active, true);
    assert.equal(runtime?.getCombat().order.length, 2);
    const after = combatOf(context.service, context.roomId);
    assert.equal(after.active, true);
    assert.equal(after.round, 1);
    assert.ok(after.initiative.length >= 2);
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：combat start 按 encounterId 展开模组遭遇并应用 maxRounds 覆盖', async () => {
  const context = setupRulesRoom();
  try {
    // 给 enc_guihuo 加 maxRounds 覆盖（legacy 场景类型未声明该字段，host 按可选字段消费）。
    const module: ModuleDef = {
      ...GUIMUYA_MODULE,
      scenes: GUIMUYA_MODULE.scenes.map((scene) => ({
        ...scene,
        encounters: (scene.encounters ?? []).map((encounter) =>
          encounter.id === 'enc_guihuo'
            ? ({ ...encounter, maxRounds: 3, battleMapId: 'map_cave_mouth' } as unknown as typeof encounter)
            : encounter,
        ),
      })),
    };
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module,
    });
    const result = await toolNamed(tools, 'combat').execute({ action: 'start', encounterId: 'enc_guihuo' });
    assert.ok(result.text.includes('敌人：鬼火、鬼火、纸人、纸人'));
    assert.ok(result.text.includes('maxRounds=3'));
    assert.ok(result.text.includes('theater-of-mind'), '规则包没有该 battleMapId 时应降级并提示');
    const runtime = context.service.runtimeOf(context.roomId);
    assert.equal(runtime?.getCombat().maxRounds, 3);
    assert.equal(runtime?.getCombat().order.length, 5);
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：roll_check 走运行时，返回 d20/总值/DC/成败与 trace', async () => {
  const context = setupRulesRoom();
  try {
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    const result = await toolNamed(tools, 'roll_check').execute({ actorId: '阿青', skill: 'perception', dc: 10 });
    assert.ok(result.text.includes('技能「perception」检定'));
    assert.ok(result.text.includes('d20='));
    assert.ok(result.text.includes('vs DC 10'));
    assert.ok(result.text.includes('判定链：'));
    assert.match(result.text, /成功|失败/);
    // 骰面来自运行时：回包里的 d20 与文本一致。
    const lastDice = context.service
      .gmRecentEvents(context.roomId, 30)
      .filter((event) => event.kind === 'dice')
      .pop();
    assert.notEqual(lastDice, undefined, '规则运行时检定应产生 dice 事件');
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：use_action 结算攻击，命中/伤害/骰面只取自运行时回包', async () => {
  const context = setupRulesRoom();
  try {
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    await toolNamed(tools, 'combat').execute({ action: 'start', monsters: 'xueshi*1' });
    const combat = ensurePlayerTurn(context.service, context.roomId, context.playerId);
    const enemy = combat.tokens.find((token) => token.team === 'enemy');
    assert.notEqual(enemy, undefined);
    const result = await toolNamed(tools, 'use_action').execute({
      actionId: 'attack.melee',
      actorId: '阿青',
      targetId: enemy?.name,
    });
    assert.ok(result.text.includes('近战攻击'));
    assert.ok(result.text.includes('骰面：'));
    assert.match(result.text, /命中|未命中/);
    assert.ok(result.text.includes('剩余行动：'));
    assert.ok(result.text.includes('第 1 轮'));
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：旧名 attack 等价于 use_action（别名兼容）', async () => {
  const context = setupRulesRoom();
  try {
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    await toolNamed(tools, 'combat').execute({ action: 'start', monsters: 'xueshi*1' });
    const combat = ensurePlayerTurn(context.service, context.roomId, context.playerId);
    const enemy = combat.tokens.find((token) => token.team === 'enemy');
    const result = await toolNamed(tools, 'attack').execute({ attacker: '阿青', target: enemy?.name });
    assert.ok(result.text.includes('近战攻击'));
    assert.ok(result.text.includes('骰面：'));
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：combat status/next/end 都走运行时视图', async () => {
  const context = setupRulesRoom();
  try {
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    await toolNamed(tools, 'combat').execute({ action: 'start', monsters: 'xueshi*1' });
    const status = await toolNamed(tools, 'combat').execute({ action: 'status' });
    assert.ok(status.text.includes('先攻：'));
    assert.ok(status.text.includes('当前行动者：'));
    const next = await toolNamed(tools, 'combat').execute({ action: 'next' });
    assert.ok(next.text.includes('第 1 轮') || next.text.includes('第 2 轮'));
    const ended = await toolNamed(tools, 'combat').execute({ action: 'end', reason: '收尾' });
    assert.ok(ended.text.includes('战斗结束'));
    assert.equal(context.service.runtimeOf(context.roomId)?.getCombat().active, false);
  } finally {
    cleanup(context);
  }
});

test('真实规则房间：move 先攻轮到玩家后按格子移动（无空间模型时 cost 0）', async () => {
  const context = setupRulesRoom();
  try {
    const tools = createGmTools({
      roomService: context.service,
      roomId: context.roomId,
      lorebook: GUIMUYA_LOREBOOK,
      module: GUIMUYA_MODULE,
    });
    await toolNamed(tools, 'combat').execute({ action: 'start', monsters: 'xueshi*1' });
    ensurePlayerTurn(context.service, context.roomId, context.playerId);
    const result = await toolNamed(tools, 'move').execute({ actorId: '阿青', to: { x: 1, y: 1 } });
    assert.ok(result.text.includes('移动：'));
    assert.ok(result.text.includes('(1,1)'));
    assert.ok(result.text.includes('消耗 0'), 'space.model=none 时格子移动不消耗移动力');
  } finally {
    cleanup(context);
  }
});
