/**
 * M9.4 协议层：新 DTO 形状、12 个新 RPC 的参数校验、SSE 事件 kind。
 * （投影数值由 host 算，这里只锁协议契约与中文错误。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSseEvent,
  isRpcMethod,
  validateCombatEnd,
  validateCombatEndTurn,
  validateCombatMove,
  validateCombatRollCheck,
  validateCombatStart,
  validateCombatUseAction,
  validateCombatView,
  validateRpcRequest,
  validateSheetEquip,
  validateSheetGet,
  validateSheetUnequip,
  validateSheetUseItem,
  validateWorldMapGet,
  type CombatView,
  type EquipmentView,
  type GameEvent,
  type InventoryView,
  type RoomView,
  type SheetView,
  type WorldMapView,
} from '../src/index.ts';

function errorOf(result: { ok: boolean; error?: string }): string {
  assert.equal(result.ok, false, '预期校验失败');
  return result.error ?? '';
}

// ---------------------------------------------------------------------------
// 方法表
// ---------------------------------------------------------------------------

test('RPC：12 个 M9.4 方法都在方法表里，validateRpcRequest 认它们', () => {
  const methods = [
    'sheet.get',
    'sheet.equip',
    'sheet.unequip',
    'sheet.useItem',
    'combat.view',
    'combat.start',
    'combat.useAction',
    'combat.move',
    'combat.endTurn',
    'combat.rollCheck',
    'combat.end',
    'worldmap.get',
  ];
  for (const method of methods) assert.equal(isRpcMethod(method), true, `未注册：${method}`);
  const parsed = validateRpcRequest({ method: 'sheet.get', token: 'tk', params: {} });
  assert.equal(parsed.ok, true);
  assert.equal(validateRpcRequest({ method: 'combat.nope' }).ok, false);
  const badParams = validateRpcRequest({ method: 'sheet.get', params: 42 });
  assert.match(errorOf(badParams), /params 必须是对象/);
});

// ---------------------------------------------------------------------------
// 参数校验：卡面
// ---------------------------------------------------------------------------

test('sheet.get：空参数/playerId/actorId 合法；非法选择器给中文错误', () => {
  assert.equal(validateSheetGet(undefined).ok, true);
  assert.equal(validateSheetGet({}).ok, true);
  assert.equal(validateSheetGet({ playerId: 'p1' }).ok, true);
  assert.equal(validateSheetGet({ actorId: 'pc:p1' }).ok, true);
  assert.match(errorOf(validateSheetGet({ playerId: 3 })), /playerId 必须是非空字符串/);
  assert.match(errorOf(validateSheetGet({ actorId: '' })), /actorId 必须是非空字符串/);
  assert.match(errorOf(validateSheetGet('nope')), /参数必须是对象/);
});

test('sheet.equip / sheet.unequip：slotId+instanceId 必填，选择器可带', () => {
  assert.equal(validateSheetEquip({ slotId: 'mainHand', instanceId: 'ins_1' }).ok, true);
  assert.equal(validateSheetEquip({ slotId: 'mainHand', instanceId: 'ins_1', playerId: 'p1' }).ok, true);
  assert.match(errorOf(validateSheetEquip({ instanceId: 'ins_1' })), /缺少 slotId/);
  assert.match(errorOf(validateSheetEquip({ slotId: 'mainHand' })), /缺少 instanceId/);
  assert.equal(validateSheetUnequip({ slotId: 'body', instanceId: 'ins_2' }).ok, true);
  assert.match(errorOf(validateSheetUnequip({})), /缺少 slotId/);
  assert.match(errorOf(validateSheetUnequip({ slotId: 'body', instanceId: 'x', actorId: 7 })), /actorId/);
});

test('sheet.useItem：instanceId 必填、targetId 可选且必须是非空字符串', () => {
  assert.equal(validateSheetUseItem({ instanceId: 'ins_1' }).ok, true);
  assert.equal(validateSheetUseItem({ instanceId: 'ins_1', targetId: 'pc:enemy' }).ok, true);
  assert.match(errorOf(validateSheetUseItem({})), /缺少 instanceId/);
  assert.match(errorOf(validateSheetUseItem({ instanceId: 'ins_1', targetId: '' })), /targetId 必须是非空字符串/);
  assert.match(errorOf(validateSheetUseItem({ instanceId: 1 })), /instanceId/);
});

// ---------------------------------------------------------------------------
// 参数校验：战斗
// ---------------------------------------------------------------------------

test('combat.view / worldmap.get：空参数命令接受 undefined 与 {}', () => {
  assert.equal(validateCombatView(undefined).ok, true);
  assert.equal(validateCombatView({}).ok, true);
  assert.equal(validateWorldMapGet(undefined).ok, true);
  assert.equal(validateWorldMapGet({}).ok, true);
  assert.match(errorOf(validateCombatView([])), /参数必须是对象/);
});

test('combat.start：空参/完整参/敌人数组合法；非法字段给中文错误', () => {
  assert.equal(validateCombatStart(undefined).ok, true);
  assert.equal(
    validateCombatStart({ maxRounds: 8, mapId: 'map_cave', reason: '遭遇', actorIds: ['pc:a'] }).ok,
    true,
  );
  const withEnemies = validateCombatStart({
    enemies: [{ name: '血尸', cell: { x: 2, y: 4 }, team: 'enemy' }, { name: '看客', team: 'neutral' }],
  });
  assert.equal(withEnemies.ok, true);
  assert.match(errorOf(validateCombatStart({ maxRounds: 0 })), /maxRounds 必须是 1–999 的整数/);
  assert.match(errorOf(validateCombatStart({ maxRounds: 1.5 })), /maxRounds/);
  assert.match(errorOf(validateCombatStart({ actorIds: ['pc:a', 3] })), /actorIds/);
  assert.match(errorOf(validateCombatStart({ enemies: 'x' })), /enemies 必须是数组/);
  assert.match(errorOf(validateCombatStart({ enemies: [{ name: '' }] })), /enemies\[\]\.name 必填/);
  assert.match(errorOf(validateCombatStart({ enemies: [{ name: '血尸', team: 'ally' }] })), /team 必须是 enemy 或 neutral/);
  assert.match(errorOf(validateCombatStart({ enemies: [{ name: '血尸', cell: { x: 'a' } }] })), /cell 必须是 \{ x, y \}/);
  assert.match(errorOf(validateCombatStart({ enemies: [{ name: '血尸', card: 'nope' }] })), /card 必须是对象/);
  assert.match(errorOf(validateCombatStart({ mapId: 9 })), /mapId/);
});

test('combat.useAction：actionId 必填；options 的 mode/mods/dc 类型受校验', () => {
  assert.equal(validateCombatUseAction({ actionId: 'attack.melee' }).ok, true);
  assert.equal(
    validateCombatUseAction({ actionId: 'attack.melee', targetId: 'npc:1', options: { mode: 'advantage', mods: 2, dc: 12 } }).ok,
    true,
  );
  assert.match(errorOf(validateCombatUseAction({})), /缺少 actionId/);
  assert.match(errorOf(validateCombatUseAction({ actionId: 'x'.repeat(80) })), /actionId 过长/);
  assert.match(errorOf(validateCombatUseAction({ actionId: 'a', options: { mode: 'lucky' } })), /options\.mode/);
  assert.match(errorOf(validateCombatUseAction({ actionId: 'a', options: { mods: 'x' } })), /options\.mods/);
  assert.match(errorOf(validateCombatUseAction({ actionId: 'a', targetId: '' })), /targetId/);
});

test('combat.move：to 必须是 {zoneId} 或 {cell:{x,y}}，坐标必须是整数', () => {
  assert.equal(validateCombatMove({ to: { cell: { x: 2, y: 4 } } }).ok, true);
  assert.equal(validateCombatMove({ to: { zoneId: 'cave' } }).ok, true);
  assert.match(errorOf(validateCombatMove({})), /缺少 to/);
  assert.match(errorOf(validateCombatMove({ to: {} })), /zoneId 或 cell/);
  assert.match(errorOf(validateCombatMove({ to: { cell: { x: 1.2, y: 2 } } })), /整数/);
  assert.match(errorOf(validateCombatMove({ to: { cell: { x: 1 } } })), /to\.cell 必须是/);
  assert.match(errorOf(validateCombatMove({ to: { zoneId: 'cave' }, via: 3 })), /via/);
});

test('combat.endTurn / combat.end：空参数合法，字段类型错误给中文', () => {
  assert.equal(validateCombatEndTurn(undefined).ok, true);
  assert.equal(validateCombatEndTurn({ actorId: 'pc:a', playerId: 'p1' }).ok, true);
  assert.match(errorOf(validateCombatEndTurn({ actorId: 5 })), /actorId 必须是非空字符串/);
  assert.equal(validateCombatEnd(undefined).ok, true);
  assert.equal(validateCombatEnd({ reason: '清场' }).ok, true);
  assert.match(errorOf(validateCombatEnd({ reason: 3 })), /reason 必须是字符串/);
});

test('combat.rollCheck：DC 0–60、mode 枚举、技能/属性 id 类型校验', () => {
  assert.equal(validateCombatRollCheck(undefined).ok, true);
  assert.equal(
    validateCombatRollCheck({ skillId: 'athletics', dc: 12, mode: 'advantage', mods: 1, reason: '潜行' }).ok,
    true,
  );
  assert.match(errorOf(validateCombatRollCheck({ dc: 61 })), /dc 必须是 0–60 的整数/);
  assert.match(errorOf(validateCombatRollCheck({ dc: 1.5 })), /dc 必须是 0–60 的整数/);
  assert.match(errorOf(validateCombatRollCheck({ mode: 'luck' })), /mode 必须是 normal\/advantage\/disadvantage/);
  assert.match(errorOf(validateCombatRollCheck({ skillId: 9 })), /skillId 必须是非空字符串/);
  assert.match(errorOf(validateCombatRollCheck({ mods: 'x' })), /mods 必须是数值/);
});

// ---------------------------------------------------------------------------
// DTO 形状（含 RoomView.rules / 新事件 kind）
// ---------------------------------------------------------------------------

test('SheetView/EquipmentView/InventoryView：形状与 JSON 往返稳定', () => {
  const equipment: EquipmentView = {
    slots: [
      {
        slotId: 'mainHand',
        name: '主手',
        accepts: ['weapon:melee'],
        count: 1,
        capacity: 1,
        item: {
          instanceId: 'ins_1',
          itemId: 'hengdao',
          name: '横刀',
          tags: ['weapon:melee'],
          stats: [{ statId: '攻击', name: '攻击', value: 2 }],
          equippedSlot: 'mainHand',
          count: 1,
        },
        items: [],
      },
    ],
    statTotals: [{ statId: '攻击', name: '攻击', total: 2 }],
    items: [],
  };
  const sheet: SheetView = {
    cardId: 'card_aqing',
    playerId: 'p1',
    actorId: 'pc:p1',
    rulesId: 'd20-mini',
    rulesVersion: '1.0.0',
    identity: { name: '阿青', level: 1 },
    values: { attributes: { str: 17 }, derived: { ac: 13 } },
    resources: [{ id: 'hp', name: '生命', current: 12, max: 18 }],
    fields: { name: '阿青', level: 1 },
    equipment,
    skills: [{ id: 'athletics', name: '运动', total: 5, proficient: true }],
    statuses: [{ id: 'poisoned', name: '中毒', stacks: 1, remaining: 2 }],
    actions: [
      {
        actionId: 'attack.melee',
        name: '近战攻击',
        kind: 'attack',
        available: false,
        reason: '动作不足（需要 1，剩余 0）',
        cost: { turn: { action: 1 } },
        targeting: { type: 'single', range: 'engaged', sides: 'enemy' },
      },
    ],
    items: [],
    warnings: [],
  };
  const inventory: InventoryView = { items: [], capacity: { used: 0, max: 18 } };
  assert.deepEqual(JSON.parse(JSON.stringify({ sheet, inventory })), { sheet, inventory });
  assert.equal(sheet.actions[0]?.reason?.includes('不足'), true);
});

test('CombatView：行动经济/先攻/位置/时间字段齐全，JSON 往返稳定', () => {
  const combat: CombatView = {
    active: true,
    mapId: 'map_cave',
    zoneId: 'cave',
    cols: 8,
    rows: 6,
    cellMeters: 1.5,
    distanceMode: 'chebyshev',
    terrain: [['wall', 'floor']],
    obstacles: [{ x: 3, y: 4, w: 2, h: 1, terrain: 'rubble' }],
    positions: { 'pc:p1': { x: 1, y: 4, zoneId: 'cave' } },
    tokens: [{ actorId: 'pc:p1', name: '阿青', team: 'player', x: 1, y: 4, dead: false, active: true }],
    initiative: [
      { actorId: 'pc:p1', name: '阿青', team: 'player', initiative: 12, roll: 10, dead: false, active: true },
      { actorId: 'npc:1', name: '血尸', team: 'enemy', initiative: 9, roll: 9, hp: { current: 8, max: 13 }, dead: false, active: false },
    ],
    round: 1,
    maxRounds: 10,
    activeActorId: 'pc:p1',
    activePlayerId: 'p1',
    actionEconomy: {
      actorId: 'pc:p1',
      remaining: [{ id: 'action', name: '动作', current: 1, max: 1 }],
    },
    time: { round: 1, segment: 0, day: 0 },
    terrainLegend: [{ id: 'wall', name: '岩壁', blocksMove: true }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(combat)), combat);
});

test('WorldMapView：zone 热点/连线/队伍位置形状', () => {
  const worldMap: WorldMapView = {
    backgroundAssetId: 'map/region-test',
    width: 1024,
    height: 768,
    zones: [
      {
        zoneId: 'cave',
        name: '洞口',
        hotspot: { x: 0.6, y: 0.4 },
        connections: [{ to: 'town', kind: 'road', distance: 3 }],
        current: true,
        battleMapId: 'map_cave',
        explored: true,
      },
    ],
    partyPosition: { zoneId: 'cave', members: [{ actorId: 'pc:p1', playerId: 'p1', name: '阿青', zoneId: 'cave', x: 1, y: 4 }] },
    currentZoneId: 'cave',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(worldMap)), worldMap);
});

test('RoomView.rules：可选规则元数据（含降级标记）', () => {
  const room: RoomView = {
    roomId: 'r1',
    title: '规则团',
    phase: 'lobby',
    gmMode: 'ai',
    locked: false,
    rules: { rulesId: 'd20-mini', rulesVersion: '1.0.0', name: 'D20 极简示例', degraded: true },
    players: [],
    createdAt: 1,
  };
  assert.equal(room.rules?.degraded, true);
});

test('SSE：sheet/update、combat/update、rules/error 是合法事件 kind 且能编码', () => {
  const base = { v: 1 as const, seq: 3, at: 1700000000000, to: 'all' as const };
  const sheetEvent: GameEvent = { ...base, kind: 'sheet/update', payload: { playerId: 'p1' } };
  const combatEvent: GameEvent = { ...base, kind: 'combat/update', payload: { combat: { active: true } } };
  const rulesEvent: GameEvent = { ...base, kind: 'rules/error', payload: { message: 'x', text: '规则错误' } };
  for (const event of [sheetEvent, combatEvent, rulesEvent]) {
    const encoded = encodeSseEvent(event);
    assert.match(encoded, /^event: game\ndata: /);
    assert.equal(JSON.parse(encoded.split('\ndata: ')[1]?.trim() ?? '{}').kind, event.kind);
  }
});
