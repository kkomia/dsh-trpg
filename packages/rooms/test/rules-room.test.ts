/**
 * M9.4：房间接入规则运行时——建房/落座/卡面投影/装备/战斗/快照续团/降级/权限/广播。
 *
 * 用 `@dsh-trpg/rules` 的 `MINIMAL_RULE_PACK`（8×6 战棋图 + 2 zone + 装备槽 + 物品库 + 行动经济），
 * 通过一个桩 `RoomRulesResolver` 注入，不依赖内容包（host 集成在 dsh-trpg-table 的测试里）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RoomError,
  RoomService,
  type RoomSnapshot,
  type RoomContentModule,
  type RoomContentResolver,
} from '../src/index.ts';
import {
  MINIMAL_RULE_PACK,
  SAMPLE_CARD_AQING,
  SAMPLE_LEGACY_CARD,
  type CardInstance,
  type RulePack,
} from '@dsh-trpg/rules';
import type { RoomRuleScript } from '../src/index.ts';

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

const CONTENT: RoomContentResolver = {
  defaultPackId: 'test-pack',
  resolveModule(packId: string, moduleId?: string): RoomContentModule | undefined {
    return {
      packId,
      packVersion: '1.0.0',
      packName: '测试包',
      moduleId: moduleId ?? 'test-module',
      moduleTitle: '测试模组',
      contentHash: 'hash-test',
      scenes: [{ sceneId: 'scene_1', title: '第一幕' }],
    };
  },
  hasPack(): boolean {
    return true;
  },
};

interface RulesStub {
  rules: RulePack;
  scripts?: RoomRuleScript[];
  rulesHash?: string;
}

function resolverOf(stub: RulesStub | null): { resolveRules: () => RulesStub | undefined } {
  return { resolveRules: () => (stub === null ? undefined : stub) };
}

function rulesStub(rules: RulePack = MINIMAL_RULE_PACK): RulesStub {
  return { rules, rulesHash: `hash-${rules.rulesId}-${rules.rulesVersion}` };
}

function makeService(options: { rules?: RulesStub | null; seedSalt?: string } = {}): RoomService {
  return new RoomService({
    content: CONTENT,
    rules: resolverOf(options.rules === undefined ? rulesStub() : options.rules),
    seedSalt: options.seedSalt ?? 'test-salt',
  });
}

interface Fixture {
  service: RoomService;
  roomId: string;
  hostToken: string;
  inviteCode: string;
  playerId: string;
  playerToken: string;
  host: ReturnType<RoomService['login']>;
  player: ReturnType<RoomService['login']>;
}

function openRoom(service: RoomService, card: unknown = SAMPLE_LEGACY_CARD, playerName = '阿青'): Fixture {
  const created = service.createRoom({ title: '规则团', gmMode: 'ai' });
  const joined = service.join({ inviteCode: created.inviteCode, playerName, characterCard: card });
  return {
    service,
    roomId: created.room.roomId,
    hostToken: created.hostToken,
    inviteCode: created.inviteCode,
    playerId: joined.playerId,
    playerToken: joined.playerToken,
    host: service.login(created.hostToken),
    player: service.login(joined.playerToken),
  };
}

function joinPlayer(service: RoomService, inviteCode: string, playerName: string, card?: unknown) {
  const joined = service.join({
    inviteCode,
    playerName,
    ...(card !== undefined ? { characterCard: card } : {}),
  });
  return { playerId: joined.playerId, principal: service.login(joined.playerToken) };
}

/** 把回合推进到该玩家行动（先攻骰面随房间种子，不能假定玩家先手）。 */
function passToPlayerTurn(service: RoomService, host: ReturnType<RoomService['login']>, playerId: string) {
  let view = service.combatView(host).combat;
  for (let attempt = 0; attempt < 8 && view.active && view.activePlayerId !== playerId; attempt += 1) {
    view = service.endTurn(host, {}).combat;
  }
  assert.equal(view.active, true, '战斗应仍在进行');
  assert.equal(view.activePlayerId, playerId, '应已轮到该玩家');
  return view;
}

function snapshotOf(service: RoomService): RoomSnapshot {
  const snapshot = service.snapshotAll()[0];
  assert.ok(snapshot, 'expected one room snapshot');
  return JSON.parse(JSON.stringify(snapshot)) as RoomSnapshot;
}

function ruleError(fn: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RoomError, `应为 RoomError，实际 ${String(error)}`);
    assert.equal(error.code, code, `错误码：${error.code}（${error.message}）`);
    assert.match(error.message, pattern);
    return true;
  });
}

function activeEnemy(service: RoomService, principal: ReturnType<RoomService['login']>) {
  const view = service.combatView(principal).combat;
  const enemy = view.tokens.find((token) => token.team === 'enemy');
  assert.ok(enemy, 'expected an enemy token');
  return enemy;
}

function scriptedRules(): RulesStub {
  const code = 'module.exports = { computeDerived: function () { throw new Error("测试钩子爆炸"); } };';
  const sha256 = createHash('sha256').update(code, 'utf8').digest('hex');
  const rules = structuredClone(MINIMAL_RULE_PACK) as RulePack;
  rules.scripts = { computeDerived: { file: 'rules/scripts/bad.js', sha256 } };
  return { rules, scripts: [{ file: 'rules/scripts/bad.js', code, sha256 }], rulesHash: 'hash-scripted' };
}

// ---------------------------------------------------------------------------
// A. 建房与规则运行时生命周期
// ---------------------------------------------------------------------------

test('建房：内容包带 rules → RoomView.rules 有元数据、runtimeOf 可用、未降级', () => {
  const service = makeService();
  const created = service.createRoom({ title: '规则团', gmMode: 'ai' });
  assert.deepEqual(
    { rulesId: created.room.rules?.rulesId, rulesVersion: created.room.rules?.rulesVersion },
    { rulesId: 'd20-mini', rulesVersion: '1.0.0' },
  );
  assert.equal(created.room.rules?.name, 'D20 极简示例');
  assert.equal(created.room.rules?.degraded, undefined);
  const runtime = service.runtimeOf(created.room.roomId);
  assert.ok(runtime, 'runtimeOf 应返回运行时');
  assert.equal(runtime.rules.rulesId, 'd20-mini');
  assert.equal(runtime.getCombat().active, false);
});

test('建房：无 rules 内容包 → 不建运行时、RoomView 无 rules、旧房间功能照常', () => {
  const service = makeService({ rules: null });
  const created = service.createRoom({ title: '旧团', gmMode: 'ai' });
  assert.equal(created.room.rules, undefined);
  assert.equal(service.runtimeOf(created.room.roomId), undefined);
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: SAMPLE_LEGACY_CARD });
  const principal = service.login(joined.playerToken);
  const rolled = service.roll(principal, { expression: '1d20' });
  assert.equal(rolled.event.kind, 'dice');
  ruleError(() => service.sheet(principal, {}), 'conflict', /没有规则运行时/);
});

test('建房：规则脚本 sha256 不符 → 房间降级开局（degraded + 中文 alert），不崩', () => {
  const service = new RoomService({
    content: CONTENT,
    rules: {
      resolveRules: () => ({
        rules: structuredClone(MINIMAL_RULE_PACK) as RulePack,
        scripts: [{ file: 'rules/scripts/bad.js', code: 'module.exports = {};', sha256: 'a'.repeat(64) }],
      }),
    },
  });
  const created = service.createRoom({ title: '坏脚本', gmMode: 'ai' });
  assert.equal(created.room.rules?.degraded, true);
  assert.equal(service.runtimeOf(created.room.roomId), undefined);
  const events = service.eventsSince(service.login(created.hostToken), 0);
  assert.ok(events.some((event) => event.kind === 'alert' && JSON.stringify(event.payload).includes('规则运行时启动失败')));
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: SAMPLE_LEGACY_CARD });
  ruleError(() => service.sheet(service.login(joined.playerToken), {}), 'conflict', /规则|不可用/);
});

test('落座：旧 engine 卡迁移进运行时（hp 来自 combat.hpMax、属性来自 abilities）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const sheet = service.sheet(fixture.player, {});
  assert.equal(sheet.sheet.actorId, `pc:${fixture.playerId}`);
  assert.equal(sheet.sheet.rulesId, 'd20-mini');
  assert.equal(sheet.sheet.values.attributes.str, 17);
  const hp = sheet.sheet.resources.find((resource) => resource.id === 'hp');
  assert.equal(hp?.current, 12);
  assert.equal(sheet.sheet.equipment.slots.length, 3);
  assert.equal(sheet.sheet.equipment.statTotals.find((stat) => stat.statId === '攻击')?.total, 2);
});

test('落座：新卡实例（trpg.card/1）直接进运行时（不再迁移，cardId 原样）', () => {
  const service = makeService();
  const card = structuredClone(SAMPLE_CARD_AQING);
  const fixture = openRoom(service, card);
  const sheet = service.sheet(fixture.player, {});
  assert.equal(sheet.sheet.cardId, 'card_aqing');
  assert.equal(sheet.sheet.playerId, fixture.playerId);
  assert.equal(sheet.sheet.values.attributes.str, 17);
  assert.equal(sheet.sheet.resources.find((resource) => resource.id === 'hp')?.current, 12);
});

test('落座：没有卡/未落座的玩家读卡面 → 中文 conflict；读别人的卡 → forbidden', () => {
  const service = makeService();
  const created = service.createRoom({ title: '权限', gmMode: 'ai' });
  const witness = joinPlayer(service, created.inviteCode, '旁观者');
  ruleError(() => service.sheet(witness.principal, {}), 'conflict', /还没有落座/);
  const fixture = openRoom(service);
  // 新建一个房间来测「不能读别人」：同房间更简单
  const joined = joinPlayer(service, fixture.inviteCode, '白露', structuredClone(SAMPLE_CARD_BAILU_CARD));
  ruleError(() => service.sheet(joined.principal, { playerId: fixture.playerId }), 'forbidden', /别人的角色卡/);
  ruleError(() => service.sheet(joined.principal, { actorId: `pc:${fixture.playerId}` }), 'forbidden', /别人的角色/);
});

const SAMPLE_CARD_BAILU_CARD: CardInstance = {
  schemaVersion: 'trpg.card/1',
  cardId: 'card_bailu',
  rulesId: 'd20-mini',
  rulesVersion: '1.0.0',
  attributes: { str: 12, dex: 16, con: 13 },
  resources: { hp: { current: 14, max: 17 } },
  fields: { name: '白露', level: 2 },
  equipmentInstances: [],
  skills: [],
  statuses: [],
};

// ---------------------------------------------------------------------------
// B. 卡面投影与装备/物品命令
// ---------------------------------------------------------------------------

test('sheet.get：角色卡面 DTO 关键字段齐全（资源/属性/装备/技能/动作/字段）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const { sheet, inventory } = service.sheet(fixture.player, {});
  assert.equal(sheet.identity.name, '阿青');
  assert.equal(sheet.identity.level, 1);
  assert.equal(sheet.values.derived !== undefined, true);
  assert.equal(sheet.fields.name, '阿青');
  assert.equal(sheet.skills.length, 2);
  assert.equal(sheet.skills.find((skill) => skill.id === 'athletics')?.proficient, true);
  assert.equal(sheet.actions.find((action) => action.actionId === 'attack.melee')?.available, true);
  assert.deepEqual(sheet.actions.find((action) => action.actionId === 'attack.melee')?.cost, { turn: { action: 1 } });
  assert.equal(sheet.actions.find((action) => action.actionId === 'attack.melee')?.targeting.sides, 'enemy');
  assert.equal(sheet.equipment.slots.find((slot) => slot.slotId === 'mainHand')?.items.length, 1);
  assert.equal(sheet.items.length, inventory.items.length);
  assert.deepEqual(sheet.statuses, []);
});

test('房主读卡面：可指定 playerId；房主未落座且未指定 → conflict 中文', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const viaPlayerId = service.sheet(fixture.host, { playerId: fixture.playerId });
  assert.equal(viaPlayerId.sheet.identity.name, '阿青');
  const viaActorId = service.sheet(fixture.host, { actorId: `pc:${fixture.playerId}` });
  assert.equal(viaActorId.sheet.cardId, 'card_aqing');
  ruleError(() => service.sheet(fixture.host, {}), 'conflict', /房主还没有可操作的角色/);
});

test('equip/unequip：卸下进背包、再装回槽位，投影同步变化', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const before = service.sheet(fixture.player, {});
  assert.equal(before.sheet.items.find((item) => item.instanceId === 'ins_1')?.equippedSlot, 'mainHand');

  const off = service.unequip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_1' });
  assert.equal(off.sheet.equipment.slots.find((slot) => slot.slotId === 'mainHand')?.items.length, 0);
  const offItem = off.inventory.items.find((item) => item.instanceId === 'ins_1');
  assert.equal(offItem?.equippedSlot, undefined);
  assert.equal(off.sheet.items.length, before.sheet.items.length, '卸下不丢物品');

  const on = service.equip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_1' });
  assert.equal(on.sheet.equipment.slots.find((slot) => slot.slotId === 'mainHand')?.items.length, 1);
  assert.equal(on.inventory.items.find((item) => item.instanceId === 'ins_1')?.equippedSlot, 'mainHand');
});

test('equip：槽位标签/容量/物品存在性都给中文 bad-request/not-found', () => {
  const service = makeService();
  const fixture = openRoom(service);
  ruleError(
    () => service.equip(fixture.player, { slotId: 'body', instanceId: 'ins_1' }),
    'bad-request',
    /不能放进「身上」/,
  );
  ruleError(
    () => service.equip(fixture.player, { slotId: 'nope', instanceId: 'ins_1' }),
    'bad-request',
    /没有装备槽/,
  );
  ruleError(
    () => service.equip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_404' }),
    'bad-request',
    /没有编号/,
  );
  // 主手容量 1：再塞一把近战武器 → 已满
  const service2 = makeService();
  const overfull = structuredClone(SAMPLE_CARD_AQING) as CardInstance;
  overfull.equipmentInstances.push({
    instanceId: 'ins_9',
    slot: 'trinket',
    name: '横刀二号',
    tags: ['weapon:melee'],
    stats: { 攻击: 1 },
  });
  const fixture2 = openRoom(service2, overfull);
  ruleError(
    () => service2.equip(fixture2.player, { slotId: 'mainHand', instanceId: 'ins_9' }),
    'bad-request',
    /已满/,
  );
});

test('unequip：槽位/物品不匹配时中文 bad-request', () => {
  const service = makeService();
  const fixture = openRoom(service);
  ruleError(
    () => service.unequip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_404' }),
    'bad-request',
    /没有编号/,
  );
  ruleError(
    () => service.unequip(fixture.player, { slotId: 'body', instanceId: 'ins_1' }),
    'bad-request',
    /不在「身上」/,
  );
});

test('useItem：走规则包 items[].useAction 结算，用后消耗一件（从槽位移除）', () => {
  const rules = structuredClone(MINIMAL_RULE_PACK) as RulePack;
  const huozhezi = rules.items?.find((item) => item.itemId === 'huozhezi');
  assert.ok(huozhezi);
  huozhezi.useAction = 'skill.athletics';
  const service = makeService({ rules: rulesStub(rules) });
  const fixture = openRoom(service);
  const before = service.sheet(fixture.player, {});
  const used = service.useItem(fixture.player, { instanceId: 'ins_3' });
  assert.equal(used.item?.name, '火折子');
  assert.equal(used.item?.consumed, true);
  assert.equal(used.item?.removedFrom, 'slot');
  assert.ok(used.item?.action, '应带动作结算结果');
  assert.equal(used.item?.action?.actionId, 'skill.athletics');
  assert.equal(used.sheet.items.length, before.sheet.items.length - 1);
  assert.equal(used.events?.includes('action/after'), true);
});

test('useItem：物品不存在 / 规则包没声明 useAction → 中文错误', () => {
  const service = makeService();
  const fixture = openRoom(service);
  ruleError(() => service.useItem(fixture.player, { instanceId: 'ins_404' }), 'not-found', /没有编号/);
  ruleError(() => service.useItem(fixture.player, { instanceId: 'ins_1' }), 'bad-request', /没有可用效果/);
});

test('命令权限：玩家不能操作别人的卡（equip/useItem/read 均 forbidden）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const other = joinPlayer(service, fixture.inviteCode, '白露', structuredClone(SAMPLE_CARD_BAILU_CARD));
  const own = service.sheet(other.principal, {});
  assert.equal(own.sheet.identity.name, '白露');
  ruleError(
    () => service.equip(other.principal, { slotId: 'mainHand', instanceId: 'ins_1', playerId: fixture.playerId }),
    'forbidden',
    /别人的角色卡/,
  );
  ruleError(
    () => service.unequip(other.principal, { slotId: 'mainHand', instanceId: 'ins_1', actorId: `pc:${fixture.playerId}` }),
    'forbidden',
    /别人的角色/,
  );
  ruleError(() => service.sheet(other.principal, { actorId: `pc:${fixture.playerId}` }), 'forbidden', /别人的角色/);
});

// ---------------------------------------------------------------------------
// C. 战斗
// ---------------------------------------------------------------------------

test('combat.view：未开战也返回稳定形状（地图/地形/位置/空行动经济）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const { combat } = service.combatView(fixture.player);
  assert.equal(combat.active, false);
  assert.equal(combat.cols, 8);
  assert.equal(combat.rows, 6);
  assert.equal(combat.terrain.length, 6);
  assert.equal(combat.cellMeters, 1.5);
  assert.equal(combat.distanceMode, 'chebyshev');
  assert.equal(combat.actionEconomy.actorId, null);
  assert.deepEqual(combat.actionEconomy.remaining, []);
  assert.equal(combat.round, 1);
  const token = combat.tokens.find((entry) => entry.actorId === `pc:${fixture.playerId}`);
  assert.ok(token, '玩家应在地图上');
  assert.deepEqual({ x: token?.x, y: token?.y }, { x: 1, y: 4 });
  assert.equal(combat.positions[`pc:${fixture.playerId}`]?.x, 1);
});

test('combat.start：房主开战 + enemies 入场，先攻/行动经济/回合上限就绪', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const started = service.startCombat(fixture.host, {
    enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }],
    reason: '遭遇战',
  });
  assert.equal(started.combat.active, true);
  assert.equal(started.combat.round, 1);
  assert.equal(started.combat.maxRounds, 10);
  assert.equal(started.combat.initiative.length, 2);
  assert.deepEqual(started.rolls.length, 2);
  assert.ok(started.combat.activeActorId);
  const economy = started.combat.actionEconomy;
  assert.equal(economy.actorId, started.combat.activeActorId);
  assert.deepEqual(economy.remaining.map((entry) => entry.id), ['action', 'bonus', 'movement']);
  assert.equal(economy.remaining.find((entry) => entry.id === 'movement')?.max, 6);
  const enemy = activeEnemy(service, fixture.host);
  assert.deepEqual({ x: enemy.x, y: enemy.y }, { x: 2, y: 4 });
});

test('combat.start：没有可参战角色 / 玩家调用 → 中文错误（conflict / forbidden）', () => {
  const service = makeService();
  const created = service.createRoom({ title: '空房', gmMode: 'ai' });
  const host = service.login(created.hostToken);
  ruleError(() => service.startCombat(host, {}), 'conflict', /没有可以参战的角色/);
  const fixture = openRoom(service);
  ruleError(
    () => service.startCombat(fixture.player, { enemies: [{ name: '血尸' }] }),
    'forbidden',
    /房主/,
  );
});

test('combat.useAction：攻击消耗动作、命中则扣敌人 HP，投影同步', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }] });
  passToPlayerTurn(service, fixture.host, fixture.playerId);
  const enemy = activeEnemy(service, fixture.player);
  const hpBefore = enemy.hp?.current ?? 0;
  const result = service.useAction(fixture.player, { actionId: 'attack.melee', targetId: enemy.actorId });
  assert.equal(result.action.actionId, 'attack.melee');
  assert.equal(result.action.turn.action, 0, '动作已消耗');
  assert.ok(result.action.rolls.length >= 1, '应有命中骰面');
  assert.ok(result.sheet, '应回带行动者卡面');
  const hpAfter = service.combatView(fixture.player).combat.initiative.find((entry) => entry.actorId === enemy.actorId)?.hp?.current;
  if (result.action.hit === true) {
    assert.ok((hpAfter ?? 0) < hpBefore, `命中应扣血：${hpBefore} → ${String(hpAfter)}`);
  } else {
    assert.equal(hpAfter, hpBefore, '未命中不扣血');
  }
});

test('行动经济：动作用完后 available=false 且 reason 中文；再行动被拒（conflict）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }] });
  passToPlayerTurn(service, fixture.host, fixture.playerId);
  const used = service.useAction(fixture.player, { actionId: 'skill.athletics' });
  assert.equal(used.action.turn.action, 0);
  const sheet = service.sheet(fixture.player, {}).sheet;
  const attack = sheet.actions.find((action) => action.actionId === 'attack.melee');
  assert.equal(attack?.available, false);
  assert.match(attack?.reason ?? '', /动作不足/);
  ruleError(() => service.useAction(fixture.player, { actionId: 'skill.athletics' }), 'conflict', /不足/);
});

test('回合/先攻：非当前行动者不能行动（conflict 中文），endTurn 推进到下一个行动者', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const started = service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }] });
  assert.notEqual(started.combat.activeActorId, null);
  // 谁先手由房间种子决定：若先手不是玩家，玩家动作必须被拒
  if (started.combat.activeActorId !== `pc:${fixture.playerId}`) {
    ruleError(
      () => service.useAction(fixture.player, { actionId: 'skill.athletics' }),
      'conflict',
      /当前轮到/,
    );
  }
  const next = service.endTurn(fixture.host, {});
  assert.notEqual(next.combat.activeActorId, started.combat.activeActorId, '应换人行动');
});

test('回合上限：maxRounds=1 跨轮触发 onRoundLimit(end) 收场（limitAction/endedReason）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }], maxRounds: 1 });
  let view = service.combatView(fixture.host).combat;
  for (let attempt = 0; attempt < 6 && view.active; attempt += 1) {
    view = service.endTurn(fixture.host, {}).combat;
  }
  assert.equal(view.active, false);
  assert.equal(view.limitAction, 'end');
  assert.equal(view.endedReason, 'round_limit');
});

test('combat.move：玩家回合内移动到相邻格，位置/移动力更新；越界与障碍给中文错误', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 6, y: 1 } }] });
  passToPlayerTurn(service, fixture.host, fixture.playerId);
  const moved = service.move(fixture.player, { to: { cell: { x: 2, y: 4 } } });
  assert.deepEqual(moved.move.from.cell, { x: 1, y: 4 });
  assert.deepEqual(moved.move.to.cell, { x: 2, y: 4 });
  assert.equal(moved.move.cost, 1);
  assert.equal(moved.move.remaining, 5);
  assert.deepEqual(moved.combat.positions[`pc:${fixture.playerId}`], { x: 2, y: 4, zoneId: 'cave' });
  ruleError(() => service.move(fixture.player, { to: { cell: { x: 99, y: 99 } } }), 'conflict', /越界/);
  ruleError(() => service.move(fixture.player, { to: { cell: { x: 3, y: 1 } } }), 'conflict', /挡住/);
});

test('combat.rollCheck：玩家检定返回骰面/DC/成败，并广播 dice 事件', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }] });
  const check = service.rollCheck(fixture.player, { skillId: 'athletics', dc: 12 });
  assert.equal(check.check.actorId, `pc:${fixture.playerId}`);
  assert.equal(check.check.dc, 12);
  assert.ok(check.check.d20 !== null && check.check.d20 >= 1 && check.check.d20 <= 20);
  assert.equal(check.check.total, (check.check.d20 ?? 0) + check.check.modifier);
  const events = service.eventsSince(fixture.host, 0);
  const dice = events.filter((event) => event.kind === 'dice');
  assert.ok(dice.length >= 1, '检定应广播 dice 事件');
  const payload = dice[dice.length - 1]?.payload as { check?: { success: boolean } } | undefined;
  assert.equal(payload?.check?.success, check.check.success);
  ruleError(
    () => service.rollCheck(fixture.player, { playerId: fixture.playerId, actorId: 'pc:other' }),
    'forbidden',
    /别人的角色/,
  );
});

test('combat.end：房主收场；玩家调用 forbidden；重复收场 conflict 中文', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸' }] });
  ruleError(() => service.endCombat(fixture.player, {}), 'forbidden', /房主/);
  const ended = service.endCombat(fixture.host, { reason: '清场' });
  assert.equal(ended.combat.active, false);
  assert.equal(ended.combat.endedReason, '清场');
  ruleError(() => service.endCombat(fixture.host, {}), 'conflict', /没有进行中的战斗/);
});

// ---------------------------------------------------------------------------
// D. 世界地图
// ---------------------------------------------------------------------------

test('worldmap.get：zone 热点/连线/当前区域/队伍位置', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const { worldMap } = service.worldMap(fixture.player);
  assert.deepEqual(worldMap.zones.map((zone) => zone.zoneId), ['town', 'cave']);
  assert.equal(worldMap.backgroundAssetId, 'map/region-test');
  assert.equal(worldMap.currentZoneId, 'cave');
  assert.equal(worldMap.zones.find((zone) => zone.zoneId === 'cave')?.current, true);
  assert.equal(worldMap.zones.find((zone) => zone.zoneId === 'town')?.current, false);
  assert.equal(worldMap.zones[0]?.connections[0]?.to, 'cave');
  assert.equal(worldMap.partyPosition.members.length, 1);
  assert.equal(worldMap.partyPosition.members[0]?.zoneId, 'cave');
  assert.deepEqual(
    { x: worldMap.partyPosition.members[0]?.x, y: worldMap.partyPosition.members[0]?.y },
    { x: 1, y: 4 },
  );
});

// ---------------------------------------------------------------------------
// E. 快照 / 续团
// ---------------------------------------------------------------------------

test('快照：record 带 rulesId/rulesVersion/rulesHash/rulesSeed/ruleState/ruleBags', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.unequip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_1' });
  const snapshot = snapshotOf(service);
  assert.equal(snapshot.room.rulesId, 'd20-mini');
  assert.equal(snapshot.room.rulesVersion, '1.0.0');
  assert.match(snapshot.room.rulesHash ?? '', /^hash-d20-mini-1\.0\.0$/);
  assert.equal(typeof snapshot.room.rulesSeed, 'number');
  assert.ok(snapshot.room.ruleState, '应包含运行态快照');
  assert.equal(snapshot.room.ruleBags?.[`pc:${fixture.playerId}`]?.[0]?.instanceId, 'ins_1');
});

test('续团：恢复后卡面/战斗/背包一致，且后续检定骰面与原实例逐项一致', () => {
  const service = makeService();
  const fixture = openRoom(service);
  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }], reason: '续团' });
  passToPlayerTurn(service, fixture.host, fixture.playerId);
  service.useAction(fixture.player, { actionId: 'skill.athletics' });
  service.unequip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_1' });
  const snapshot = snapshotOf(service);

  const restored = makeService();
  assert.equal(restored.restore(snapshot), true);
  const principal = restored.login(fixture.playerToken);
  const host = restored.login(fixture.hostToken);
  const originalView = service.combatView(fixture.player).combat;
  const restoredView = restored.combatView(principal).combat;
  assert.equal(restoredView.active, originalView.active);
  assert.equal(restoredView.round, originalView.round);
  assert.deepEqual(restoredView.initiative, originalView.initiative);
  const bagItem = restored.sheet(principal, {}).inventory.items.find((item) => item.instanceId === 'ins_1');
  assert.equal(bagItem?.equippedSlot, undefined, '背包物品续团不丢');
  assert.equal(restored.state(host).room.rules?.degraded, undefined);

  // 续算一致：两个实例各掷两次，骰面与总值逐项相同
  for (let index = 0; index < 2; index += 1) {
    const a = service.rollCheck(fixture.player, { skillId: 'athletics', dc: 12 });
    const b = restored.rollCheck(principal, { skillId: 'athletics', dc: 12 });
    assert.equal(a.check.d20, b.check.d20);
    assert.equal(a.check.total, b.check.total);
    assert.equal(a.check.success, b.check.success);
  }
});

test('续团降级：ruleState 不兼容（schemaVersion 坏了）→ 房间恢复但标记 degraded + warning', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const snapshot = snapshotOf(service);
  (snapshot.room as { ruleState?: unknown }).ruleState = { schemaVersion: 'broken' };

  const restored = makeService();
  assert.equal(restored.restore(snapshot), true);
  const host = restored.login(fixture.hostToken);
  assert.equal(restored.state(host).room.rules?.degraded, true);
  const events = restored.eventsSince(host, 0);
  assert.ok(
    events.some((event) => event.kind === 'alert' && JSON.stringify(event.payload).includes('规则运行态快照无法导入')),
    '应有中文 warning',
  );
  // 降级后仍能续团：卡面按当前规则重建
  const principal = restored.login(fixture.playerToken);
  const sheet = restored.sheet(principal, {});
  assert.equal(sheet.sheet.identity.name, '阿青');
});

test('续团降级：规则版本变化 → 房间恢复但标 degraded（规则命令仍可用）', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const snapshot = snapshotOf(service);
  const upgraded = structuredClone(MINIMAL_RULE_PACK) as RulePack;
  upgraded.rulesVersion = '2.0.0';
  const restored = makeService({ rules: rulesStub(upgraded) });
  // 卡也跟着升版本，否则落座会因 rulesVersion 不一致失败
  for (const player of snapshot.room.players) {
    if (player.ruleCard !== undefined) (player.ruleCard as { rulesVersion?: string }).rulesVersion = '2.0.0';
  }
  assert.equal(restored.restore(snapshot), true);
  const host = restored.login(snapshot.room.hostToken);
  assert.equal(restored.state(host).room.rules?.degraded, true);
  assert.equal(restored.state(host).room.rules?.rulesVersion, '2.0.0');
  const principal = restored.login(fixture.playerToken);
  assert.equal(restored.combatView(principal).combat.active, false);
  assert.equal(restored.sheet(principal, {}).sheet.rulesVersion, '2.0.0');
});

test('续团降级：规则包在本机不可用 → 房间恢复、rules.degraded、规则命令中文 conflict', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const snapshot = snapshotOf(service);
  const restored = makeService({ rules: null });
  assert.equal(restored.restore(snapshot), true);
  const host = restored.login(fixture.hostToken);
  assert.equal(restored.state(host).room.rules?.degraded, true);
  assert.equal(restored.runtimeOf(snapshot.room.id), undefined);
  const principal = restored.login(fixture.playerToken);
  ruleError(() => restored.sheet(principal, {}), 'conflict', /规则|不可用/);
  // 旧功能仍可用
  assert.equal(restored.roll(principal, { expression: '1d6' }).event.kind, 'dice');
});

// ---------------------------------------------------------------------------
// F. 事件广播 / 规则错误
// ---------------------------------------------------------------------------

test('广播：equip 产生 sheet/update（只投本人），战斗事件产生全桌 combat/update', () => {
  const service = makeService();
  const fixture = openRoom(service);
  const witness = joinPlayer(service, fixture.inviteCode, '旁观者', structuredClone(SAMPLE_CARD_BAILU_CARD));
  service.unequip(fixture.player, { slotId: 'mainHand', instanceId: 'ins_1' });
  const playerEvents = service.eventsSince(fixture.player, 0);
  const ownSheetUpdates = playerEvents.filter((event) => event.kind === 'sheet/update');
  assert.ok(ownSheetUpdates.length >= 1);
  assert.equal(ownSheetUpdates[0]?.to, fixture.playerId);
  const witnessEvents = service.eventsSince(witness.principal, 0);
  assert.equal(
    witnessEvents.filter((event) => event.kind === 'sheet/update' && event.to === fixture.playerId).length,
    0,
    '别人的 sheet/update 不应投给旁观者',
  );

  service.startCombat(fixture.host, { enemies: [{ name: '血尸', cell: { x: 2, y: 4 } }] });
  const all = service.eventsSince(witness.principal, 0);
  const combatUpdates = all.filter((event) => event.kind === 'combat/update');
  assert.ok(combatUpdates.length >= 1, '应有 combat/update');
  const payload = combatUpdates[combatUpdates.length - 1]?.payload as { combat?: { active: boolean } } | undefined;
  assert.equal(payload?.combat?.active, true);
});

test('规则错误：钩子抛错 → rules/error 事件带中文 text 与 hook 名，不打断落座', () => {
  const service = makeService({ rules: scriptedRules() });
  const created = service.createRoom({ title: '坏钩子', gmMode: 'ai' });
  const joined = service.join({ inviteCode: created.inviteCode, playerName: '阿青', characterCard: SAMPLE_LEGACY_CARD });
  const host = service.login(created.hostToken);
  const errors = service.eventsSince(host, 0).filter((event) => event.kind === 'rules/error');
  assert.ok(errors.length >= 1, '应有 rules/error 事件');
  const payload = errors[0]?.payload as { hook?: string; text: string; message: string };
  assert.equal(payload.hook, 'computeDerived');
  assert.match(payload.message, /测试钩子爆炸/);
  assert.match(payload.text, /规则钩子/);
  // 落座照常成功（钩子失败走缺省结算）
  assert.equal(service.sheet(service.login(joined.playerToken), {}).sheet.identity.name, '阿青');
});
