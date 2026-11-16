import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRulePack, MINIMAL_RULE_PACK } from '../src/index.ts';
import { clonePack, withPack } from './helpers.ts';

const HEX64 = 'a'.repeat(64);

function errorsOf(input: unknown, options?: Parameters<typeof validateRulePack>[1]): string[] {
  const result = validateRulePack(input, options);
  assert.equal(result.ok, false, `预期校验失败，实际通过；warnings=${result.warnings.join('; ')}`);
  return result.errors;
}

// ---------------------------------------------------------------------------
// 合法包
// ---------------------------------------------------------------------------

test('规则包：内置最小示例包合法且无 warning', () => {
  const result = validateRulePack(MINIMAL_RULE_PACK);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.value?.rulesId, 'd20-mini');
});

test('规则包：strict 模式下合法包仍通过', () => {
  const result = validateRulePack(MINIMAL_RULE_PACK, { strict: true });
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('规则包：输入不是对象直接失败', () => {
  assert.ok(errorsOf('not a pack').some((message) => message.includes('对象')));
});

// ---------------------------------------------------------------------------
// 顶层字段
// ---------------------------------------------------------------------------

test('规则包：schemaVersion 必须匹配', () => {
  assert.ok(errorsOf(withPack((pack) => ((pack as unknown as { schemaVersion: string }).schemaVersion = 'trpg.rules/2'))).some((message) => message.includes('schemaVersion')));
});

test('规则包：rulesId 必须合法', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.rulesId = 'D20 Mini'))).some((message) => message.includes('rulesId')));
});

test('规则包：rulesVersion 必须是语义化版本', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.rulesVersion = '1.0'))).some((message) => message.includes('语义化版本')));
});

test('规则包：name 必填', () => {
  assert.ok(errorsOf(withPack((pack) => ((pack as unknown as { name?: string }).name = undefined))).some((message) => message.includes('name')));
});

test('规则包：未知顶层字段只给 warning', () => {
  const result = validateRulePack(withPack((pack) => ((pack as unknown as Record<string, unknown>).homebrew = 1)));
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(result.warnings.some((warning) => warning.includes('未知顶层字段')));
});

// ---------------------------------------------------------------------------
// sheet
// ---------------------------------------------------------------------------

test('规则包：属性 min 不能大于 max', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.attributes[0]!.min = 99))).some((message) => message.includes('sheet.attributes[0].min')));
});

test('规则包：属性 default 必须在范围内', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.attributes[0]!.default = 99))).some((message) => message.includes('default')));
});

test('规则包：属性 id 不能重复', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.attributes[1]!.id = 'str'))).some((message) => message.includes('重复的属性 id')));
});

test('规则包：enum 字段 options 不能为空', () => {
  const pack = withPack((p) => {
    const field = p.sheet.fields.find((item) => item.kind === 'enum');
    if (field === undefined) throw new Error('fixture 缺少 enum 字段');
    field.options = [];
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('options')));
});

test('规则包：enum 字段缺 options 报错', () => {
  const pack = withPack((p) => {
    const field = p.sheet.fields.find((item) => item.kind === 'enum');
    if (field === undefined) throw new Error('fixture 缺少 enum 字段');
    delete field.options;
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('enum')));
});

test('规则包：装备槽 accepts 不能为空', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.equipment.slots[0]!.accepts = []))).some((message) => message.includes('accepts')));
});

test('规则包：装备槽 count 必须是正整数', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.equipment.slots[0]!.count = 0))).some((message) => message.includes('count')));
});

test('规则包：词条 stacking 必须是已知叠法', () => {
  assert.ok(
    errorsOf(withPack((pack) => ((pack.sheet.equipment.stats[0] as unknown as { stacking: string }).stacking = 'multiply'))).some((message) =>
      message.includes('stacking'),
    ),
  );
});

test('规则包：技能 attribute 必须引用已声明属性', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.skills[0]!.attribute = 'luck'))).some((message) => message.includes('未声明的属性')));
});

// ---------------------------------------------------------------------------
// formulas / 资源 / 动作 / 行动经济
// ---------------------------------------------------------------------------

test('规则包：公式语法错误带 formulas.<key> 与列号', () => {
  const errors = errorsOf(withPack((pack) => (pack.formulas.hpMax = '1 + ')));
  assert.ok(errors.some((error) => error.startsWith('formulas.hpMax: 第 5 列')), errors.join('; '));
});

test('规则包：公式引用未声明属性报错', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.formulas.hpMax = 'attr.nope + 1'))).some((message) => message.includes('没有声明属性')));
});

test('规则包：公式引用未声明技能报错', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.formulas.check = 'skill.arcana + 1'))).some((message) => message.includes('没有声明技能')));
});

test('规则包：公式使用白名单外函数报错', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.formulas.hpMax = 'sqrt(attr.con)'))).some((message) => message.includes('未知函数')));
});

test('规则包：资源上限引用未定义公式报错', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.sheet.resources[0]!.formula = 'nopeMax'))).some((message) => message.includes('sheet.resources[0].formula')));
});

test('规则包：资源上限内联表达式可编译但给 warning', () => {
  const result = validateRulePack(withPack((pack) => (pack.sheet.resources[0]!.formula = '2 + attr.con')));
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(result.warnings.some((warning) => warning.includes('内联表达式')));
});

test('规则包：动作 toHit 必须引用已定义公式', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.actions[0]!.toHit = 'nope'))).some((message) => message.includes('toHit')));
});

test('规则包：动作 damage.formula 必须引用已定义公式', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.actions[0]!.damage = { formula: 'nope' }))).some((message) => message.includes('damage.formula')));
});

test('规则包：动作 damage.dice 必须像骰子表达式', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.actions[0]!.damage = { dice: '1d' }))).some((message) => message.includes('骰子表达式')));
});

test('规则包：动作 targeting 枚举非法报错', () => {
  assert.ok(
    errorsOf(withPack((pack) => ((pack.actions[0]!.targeting as unknown as { type: string }).type = 'beam'))).some((message) =>
      message.includes('targeting.type'),
    ),
  );
});

test('规则包：动作 actionId 唯一', () => {
  assert.ok(
    errorsOf(withPack((pack) => pack.actions.push(structuredClone(pack.actions[0]!)))).some((message) => message.includes('重复的动作 id')),
  );
});

test('规则包：动作花费的行动经济资源必须在 turn 中声明', () => {
  const pack = withPack((p) => {
    p.turn.resources = [{ id: 'action', name: '动作', count: 1 }];
    p.actions[0]!.cost = { bonus: 1 };
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('"bonus"') && message.includes('turn')));
});

test('规则包：动作花费的角色资源必须已声明', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.actions[1]!.cost = { resource: 'mana' }))).some((message) => message.includes('未声明的资源')));
});

test('规则包：turn 每回合公式必须引用已定义公式', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.turn.resources[0]!.perTurnFormula = 'nope'))).some((message) => message.includes('perTurnFormula')));
});

test('规则包：turn 资源 id 唯一', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.turn.resources[1]!.id = 'action'))).some((message) => message.includes('重复的行动经济资源 id')));
});

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

test('规则包：合法脚本声明通过', () => {
  const result = validateRulePack(
    withPack((pack) => {
      pack.scripts = { onEvent: { file: 'rules/scripts/events.js', sha256: HEX64 } };
    }),
  );
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('规则包：未知钩子名报错', () => {
  const pack = withPack((p) => {
    p.scripts = { transformSheet: { file: 'rules/scripts/sheet.js', sha256: HEX64 } } as unknown as typeof p.scripts;
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('未知钩子')));
});

test('规则包：脚本路径穿越报错', () => {
  const pack = withPack((p) => {
    p.scripts = { onEvent: { file: 'rules/scripts/../../evil.js', sha256: HEX64 } };
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('穿越')));
});

test('规则包：脚本绝对路径报错', () => {
  const pack = withPack((p) => {
    p.scripts = { onEvent: { file: '/rules/scripts/evil.js', sha256: HEX64 } };
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('绝对路径')));
});

test('规则包：脚本必须在 rules/scripts 下', () => {
  const pack = withPack((p) => {
    p.scripts = { onEvent: { file: 'scripts/events.js', sha256: HEX64 } };
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('rules/scripts/')));
});

test('规则包：脚本 sha256 必须是 64 位小写十六进制', () => {
  const pack = withPack((p) => {
    p.scripts = { onEvent: { file: 'rules/scripts/events.js', sha256: 'abc' } };
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('sha256')));
});

test('规则包：脚本数量超过 32 报错', () => {
  const extraHookNames = Array.from({ length: 33 }, (_, index) => `hook${index}`);
  const scripts = Object.fromEntries(
    extraHookNames.map((name) => [name, { file: 'rules/scripts/x.js', sha256: HEX64 }]),
  );
  const pack = withPack((p) => {
    p.scripts = scripts as unknown as typeof p.scripts;
  });
  assert.ok(errorsOf(pack, { extraHookNames }).some((message) => message.includes('超过上限')));
});

// ---------------------------------------------------------------------------
// space
// ---------------------------------------------------------------------------

test('规则包：zone id 不能重复', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.space!.zones![1]!.zoneId = 'town'))).some((message) => message.includes('重复的区域 id')));
});

test('规则包：connection 必须指向存在的 zone', () => {
  assert.ok(
    errorsOf(withPack((pack) => (pack.space!.zones![1]!.connections![0]!.to = 'nowhere'))).some((message) => message.includes('不存在的区域')),
  );
});

test('规则包：parentZoneId 必须存在且不能形成循环', () => {
  const pack = withPack((p) => {
    p.space!.zones![0]!.parentZoneId = 'cave';
    p.space!.zones![1]!.parentZoneId = 'town';
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('循环')));
});

test('规则包：battleMap.zoneId 必须引用存在的 zone', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.space!.battleMaps![0]!.zoneId = 'nowhere'))).some((message) => message.includes('不存在的区域')));
});

test('规则包：地图 cols/rows 必须在 1..32', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.space!.battleMaps![0]!.cols = 33))).some((message) => message.includes('cols')));
});

test('规则包：terrain 行数必须等于 rows', () => {
  assert.ok(errorsOf(withPack((pack) => pack.space!.battleMaps![0]!.terrain!.pop())).some((message) => message.includes('行数')));
});

test('规则包：terrain 每行列数必须等于 cols', () => {
  assert.ok(errorsOf(withPack((pack) => pack.space!.battleMaps![0]!.terrain![1]!.pop())).some((message) => message.includes('列数')));
});

test('规则包：terrain 必须引用已声明地形', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.space!.battleMaps![0]!.terrain![1]![1] = 'lava'))).some((message) => message.includes('未声明的地形')));
});

test('规则包：未声明 terrains 时地形字符非法报错', () => {
  const pack = withPack((p) => {
    delete p.space!.terrains;
    p.space!.battleMaps![0]!.terrain![1]![1] = 'a b';
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('合法地形字符')));
});

test('规则包：障碍越界报错', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.space!.battleMaps![0]!.obstacles![0]!.x = 7))).some((message) => message.includes('越界')));
});

test('规则包：出生点越界报错', () => {
  assert.ok(
    errorsOf(withPack((pack) => (pack.space!.battleMaps![0]!.spawns![0]!.cells = [[9, 0]]))).some((message) => message.includes('越界')),
  );
});

test('规则包：出生点不能重叠', () => {
  const pack = withPack((p) => {
    p.space!.battleMaps![0]!.spawns![1]!.cells = [[1, 4]];
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('重叠')));
});

test('规则包：一个包内战斗地图不能超过 64 张', () => {
  const pack = withPack((p) => {
    const base = structuredClone(p.space!.battleMaps![0]!);
    p.space!.battleMaps = Array.from({ length: 65 }, (_, index) => ({ ...structuredClone(base), mapId: `map_${index}` }));
  });
  assert.ok(errorsOf(pack).some((message) => message.includes('超过上限')));
});

// ---------------------------------------------------------------------------
// time
// ---------------------------------------------------------------------------

test('规则包：time.model 枚举非法报错', () => {
  assert.ok(
    errorsOf(withPack((pack) => ((pack.time as unknown as { model: string }).model = 'clock'))).some((message) => message.includes('time.model')),
  );
});

test('规则包：time.onRoundLimit 枚举非法报错', () => {
  assert.ok(
    errorsOf(withPack((pack) => ((pack.time as unknown as { onRoundLimit: string }).onRoundLimit = 'explode'))).some((message) =>
      message.includes('onRoundLimit'),
    ),
  );
});

test('规则包：time.durationUnit 只支持 round', () => {
  assert.ok(
    errorsOf(withPack((pack) => ((pack.time as unknown as { durationUnit: string }).durationUnit = 'minute'))).some((message) =>
      message.includes('durationUnit'),
    ),
  );
});

// ---------------------------------------------------------------------------
// 其它段
// ---------------------------------------------------------------------------

test('规则包：表格区间重叠报错', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.tables![0]!.entries[1]!.min = 50))).some((message) => message.includes('重叠')));
});

test('规则包：物品 stats 必须引用已声明词条', () => {
  assert.ok(
    errorsOf(withPack((pack) => (pack.items![0]!.stats = { 不存在: 1 }))).some((message) => message.includes('未声明的词条')),
  );
});

test('规则包：物品 equipSlot 必须引用已声明槽位', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.items![0]!.equipSlot = ['hat']))).some((message) => message.includes('未声明的装备槽')));
});

test('规则包：成长 atLevel 不能超过 maxLevel', () => {
  assert.ok(errorsOf(withPack((pack) => (pack.progression!.grants![0]!.atLevel = 9))).some((message) => message.includes('maxLevel')));
});

test('规则包：strict 模式把 warning 升级为失败', () => {
  const pack = withPack((p) => (p.sheet.resources[0]!.formula = '2 + attr.con'));
  const lenient = validateRulePack(pack);
  assert.equal(lenient.ok, true);
  const strict = validateRulePack(pack, { strict: true });
  assert.equal(strict.ok, false);
  assert.ok(strict.errors.some((error) => error.includes('[严格模式]')));
});

test('规则包：深拷贝不影响 fixture 本身', () => {
  const pack = clonePack();
  pack.sheet.attributes[0]!.min = 99;
  assert.equal(MINIMAL_RULE_PACK.sheet.attributes[0]!.min, 3);
});
