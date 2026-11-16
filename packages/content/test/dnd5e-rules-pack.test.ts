/**
 * dnd5e-lite 示例规则包的数据段 / 脚本清单 / `.trpgpack` 集成测试（M9.3）。
 *
 * 覆盖三块：
 * - 规则数据本身：validateRulePack 通过、属性/技能/状态/动作/公式/物品/成长/表格口径与旧 engine 一致；
 * - 脚本清单：`pack.rules.scripts` 的 8 个钩子 / 4 个文件 / sha256 与内联源码一致；
 * - 内容包集成：`validatePack` 校验规则段与脚本完整性；`packToTrpgpack` / `trpgpackToPack`
 *   以独立 zip 条目承载 `rules/scripts/*.js`（pack.json 只留 file+sha256）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONDITION_NAME,
  SKILL_ABILITY,
  SKILL_NAME,
  type Condition,
  type SkillId,
} from '@dsh-trpg/engine';
import { validateRulePack } from '../src/rules-bridge.ts';
import type { RulePack } from '../src/rules-bridge.ts';
import { validatePack, type ContentPack } from '../src/pack.ts';
import { packToTrpgpack, trpgpackToPack } from '../src/pack-zip.ts';
import { readZip, writeZip, type ZipWriteEntry } from '../src/zip.ts';
import { CORE_GUIMUYA_PACK, ITEMS } from '../src/index.ts';
import {
  DND5E_LITE_RULES,
  DND5E_LITE_SCRIPT_CODE_BY_FILE,
  DND5E_LITE_SCRIPT_FILES,
  DND5E_LITE_SCRIPT_HASH_BY_FILE,
  DND5E_LITE_SCRIPT_REFS,
  DND5E_LITE_SCRIPT_SOURCES,
} from '../src/rules-pack/index.ts';

const SCRIPTS = new Map(DND5E_LITE_SCRIPT_SOURCES.map((source) => [source.file, source.code]));
const encoder = new TextEncoder();

function cloneRules(): RulePack {
  return JSON.parse(JSON.stringify(DND5E_LITE_RULES)) as RulePack;
}

// ---------------------------------------------------------------------------
// 规则数据
// ---------------------------------------------------------------------------

test('规则包：validateRulePack 通过且无任何 error/warning', () => {
  const report = validateRulePack(DND5E_LITE_RULES);
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test('规则包：schema 版本 / rulesId / rulesVersion / name', () => {
  assert.equal(DND5E_LITE_RULES.schemaVersion, 'trpg.rules/1');
  assert.equal(DND5E_LITE_RULES.rulesId, 'dnd5e-lite');
  assert.equal(DND5E_LITE_RULES.rulesVersion, '2.0.0');
  assert.equal(DND5E_LITE_RULES.name, 'D&D 5e-lite');
  assert.match(DND5E_LITE_RULES.description ?? '', /六属性/u);
});

test('规则包：六属性 3–18、默认 10，与 engine 的 Ability 集合一致', () => {
  const declared = DND5E_LITE_RULES.sheet.attributes;
  assert.equal(declared.length, 6);
  for (const attribute of declared) {
    assert.equal(attribute.min, 3, `${attribute.id} 下限`);
    assert.equal(attribute.max, 18, `${attribute.id} 上限`);
    assert.equal(attribute.default, 10, `${attribute.id} 默认值`);
    assert.ok(attribute.name.length > 0);
  }
  assert.deepEqual(
    declared.map((attribute) => attribute.id),
    ['str', 'dex', 'con', 'int', 'wis', 'cha'],
  );
});

test('规则包：HP / 两环法术位资源都引用命名公式', () => {
  const resources = DND5E_LITE_RULES.sheet.resources;
  assert.deepEqual(resources.map((resource) => resource.id), ['hp', 'slot1', 'slot2']);
  for (const resource of resources) {
    assert.ok(
      Object.hasOwn(DND5E_LITE_RULES.formulas, resource.formula),
      `资源 ${resource.id} 的上限公式「${resource.formula}」必须是命名公式`,
    );
  }
  assert.equal(DND5E_LITE_RULES.formulas.hpMax, 'derived.hpMax');
  assert.equal(DND5E_LITE_RULES.formulas.slot1Max, 'derived.slot1Max');
  assert.equal(DND5E_LITE_RULES.formulas.slot2Max, 'derived.slot2Max');
});

test('规则包：装备槽（主手/身上/随身）与词条池（攻击/防御/先攻/暴击范围）', () => {
  const equipment = DND5E_LITE_RULES.sheet.equipment;
  assert.deepEqual(equipment.slots.map((slot) => slot.id), ['mainHand', 'body', 'trinket']);
  assert.ok(equipment.slots.every((slot) => slot.accepts.length > 0));
  const statIds = equipment.stats.map((stat) => stat.id);
  assert.deepEqual(statIds, ['攻击', '防御', '先攻', '暴击范围']);
  assert.equal(equipment.stats.find((stat) => stat.id === '暴击范围')?.stacking, 'min');
  assert.equal(equipment.stats.find((stat) => stat.id === '攻击')?.stacking, 'add');
  assert.equal(equipment.stacking?.add, '相加');
});

test('规则包：18 项技能的关联属性表与 engine SKILL_ABILITY 完全一致', () => {
  assert.deepEqual(
    DND5E_LITE_RULES.sheet.skills.map((skill) => [skill.id, skill.attribute, skill.name]).sort(),
    (Object.keys(SKILL_ABILITY) as SkillId[]).map((id) => [id, SKILL_ABILITY[id], SKILL_NAME[id]]).sort(),
  );
});

test('规则包：8 种状态的 id/中文名与 engine Condition/CONDITION_NAME 一致', () => {
  assert.deepEqual(
    DND5E_LITE_RULES.sheet.statuses.map((status) => [status.id, status.name]).sort(),
    (Object.keys(CONDITION_NAME) as Condition[]).map((id) => [id, CONDITION_NAME[id]]).sort(),
  );
  for (const status of DND5E_LITE_RULES.sheet.statuses) {
    assert.ok((status.duration ?? 0) >= 1, `${status.id} 的状态时长应为正回合数`);
    assert.equal(status.stacking, 'refresh');
  }
});

test('规则包：动作（近战/远程/灵符/桃木剑/法术）引用已声明公式与行动经济', () => {
  const actions = DND5E_LITE_RULES.actions;
  assert.deepEqual(actions.map((action) => action.actionId), [
    'attack.melee',
    'attack.ranged',
    'attack.lingfu',
    'attack.taomu',
    'spell.zhuoyan',
  ]);
  const turnResourceIds = new Set(DND5E_LITE_RULES.turn.resources.map((resource) => resource.id));
  for (const action of actions) {
    if (action.toHit !== undefined) assert.ok(Object.hasOwn(DND5E_LITE_RULES.formulas, action.toHit));
    if (action.damage?.formula !== undefined) assert.ok(Object.hasOwn(DND5E_LITE_RULES.formulas, action.damage.formula));
    if (action.damage?.dice !== undefined) assert.match(action.damage.dice, /^\d+d\d+$/u);
    if (action.targeting.type !== 'self') assert.ok(action.description.length > 0);
    for (const [key, value] of Object.entries(action.cost ?? {})) {
      if (key === 'resource') continue;
      assert.ok(turnResourceIds.has(key), `动作 ${action.actionId} 的花费「${key}」应在 turn.resources 中声明`);
      assert.ok(typeof value === 'number' && value >= 1);
    }
  }
  const spell = actions.find((action) => action.actionId === 'spell.zhuoyan');
  assert.equal(spell?.kind, 'spell');
  assert.deepEqual(spell?.cost?.resource, { id: 'slot1', amount: 1 });
});

test('规则包：命中/伤害公式按六属性各一套，且引用派生调整值与装备词条', () => {
  for (const ability of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
    assert.equal(
      DND5E_LITE_RULES.formulas[`attack.${ability}`],
      `derived.mod.${ability} + proficiency + equip.攻击`,
    );
    assert.equal(DND5E_LITE_RULES.formulas[`damage.${ability}`], `derived.mod.${ability} + equip.攻击`);
  }
  assert.equal(DND5E_LITE_RULES.formulas.defense, '10 + derived.mod.dex + equip.防御');
  assert.equal(DND5E_LITE_RULES.formulas.initiative, 'derived.mod.dex + equip.先攻');
  assert.equal(DND5E_LITE_RULES.formulas.proficiency, 'floor((level - 1) / 4) + 2');
  assert.equal(DND5E_LITE_RULES.formulas.check, 'derived.mod + skill.proficient * proficiency + skill.bonus');
});

test('规则包：行动经济 = 动作/附赠/反应 + 移动力，每回合回满', () => {
  assert.deepEqual(DND5E_LITE_RULES.turn.resources.map((resource) => [resource.id, resource.count]), [
    ['action', 1],
    ['bonus', 1],
    ['reaction', 1],
  ]);
  assert.equal(DND5E_LITE_RULES.turn.movement?.id, 'movement');
  assert.equal(DND5E_LITE_RULES.turn.movement?.cells, 6);
  assert.equal(DND5E_LITE_RULES.turn.refill, 'turnStart');
  assert.equal(DND5E_LITE_RULES.turn.endTurn?.trigger, 'player');
});

test('规则包：成长表（10 级、XP 单调、技能点奖励）', () => {
  const progression = DND5E_LITE_RULES.progression;
  assert.equal(progression?.maxLevel, 10);
  assert.equal(progression?.xpTable?.length, 10);
  assert.equal(progression?.xpTable?.[0], 0);
  for (let index = 1; index < (progression?.xpTable?.length ?? 0); index += 1) {
    assert.ok((progression?.xpTable?.[index] ?? 0) > (progression?.xpTable?.[index - 1] ?? 0), 'XP 表应严格递增');
  }
  for (const grant of progression?.grants ?? []) {
    assert.ok(grant.atLevel >= 1 && grant.atLevel <= 10);
    assert.ok((grant.skillPoints ?? 0) >= 1);
  }
});

test('规则包：掉落表 loot.common 覆盖 1–100 且区间不重叠', () => {
  const table = DND5E_LITE_RULES.tables?.find((entry) => entry.tableId === 'loot.common');
  assert.ok(table);
  assert.equal(table.roll, '1d100');
  let expectedMin = 1;
  for (const entry of table.entries) {
    assert.equal(entry.min, expectedMin, `区间应从 ${expectedMin} 连续开始`);
    assert.ok(entry.max >= entry.min);
    assert.ok(entry.itemId !== undefined);
    assert.ok((DND5E_LITE_RULES.items ?? []).some((item) => item.itemId === entry.itemId), `${entry.itemId} 应在 items[]`);
    expectedMin = entry.max + 1;
  }
  assert.equal(expectedMin, 101, '区间应覆盖到 100');
});

test('规则包：20 件物品与 content ITEMS 一一对应，词条/槽位合法', () => {
  const items = DND5E_LITE_RULES.items ?? [];
  assert.equal(items.length, ITEMS.length);
  assert.deepEqual(items.map((item) => item.itemId).sort(), ITEMS.map((item) => item.id).sort());
  const slotIds = new Set(DND5E_LITE_RULES.sheet.equipment.slots.map((slot) => slot.id));
  const statIds = new Set(DND5E_LITE_RULES.sheet.equipment.stats.map((stat) => stat.id));
  for (const item of items) {
    const legacy = ITEMS.find((entry) => entry.id === item.itemId);
    assert.ok(legacy, `${item.itemId} 应来自 content ITEMS`);
    assert.equal(item.name, legacy.name);
    assert.equal(item.description, legacy.effect);
    for (const slot of item.equipSlot ?? []) assert.ok(slotIds.has(slot), `${item.itemId} 的槽位 ${slot}`);
    for (const statId of Object.keys(item.stats ?? {})) assert.ok(statIds.has(statId), `${item.itemId} 的词条 ${statId}`);
  }
  // 护甲「防御」口径（对照测试用：AC = 10 + 敏捷调整 + 防御）
  const byId = new Map(items.map((item) => [item.itemId, item]));
  assert.equal(byId.get('tiejia')?.stats?.['防御'], 4);
  assert.equal(byId.get('pijia')?.stats?.['防御'], 1);
  assert.equal(byId.get('daopao')?.stats?.['防御'], 1);
  assert.equal(byId.get('zhenhunfu')?.stats?.['防御'], 1);
  // 凡俗武器不带「攻击」词条（对照测试里伤害加值只剩属性调整，与旧 engine 一致）
  for (const weaponId of ['hengdao', 'liuyedao', 'gong', 'lingfu', 'taomujian']) {
    assert.equal(byId.get(weaponId)?.stats?.['攻击'], undefined, `${weaponId} 不应带攻击词条`);
  }
});

test('规则包：UI 分组/物品分类/稀有度/模板可渲染', () => {
  const ui = DND5E_LITE_RULES.ui;
  assert.ok(ui?.groups !== undefined && ui.groups.length >= 4);
  for (const group of ui.groups) {
    assert.ok(group.id.length > 0 && group.title.length > 0 && group.fields.length > 0);
  }
  assert.deepEqual(ui.itemCategories?.map((category) => category.id), ['weapon', 'armor', 'consumable', 'treasure']);
  assert.deepEqual(ui.rarities?.map((rarity) => rarity.id), ['common', 'rare']);
  assert.deepEqual(ui.templates?.sheetCompact, ['resources', 'attributes', 'skills']);
});

test('规则包：space 为 theater-of-mind（model=none），时间只按回合', () => {
  assert.deepEqual(DND5E_LITE_RULES.space, { model: 'none' });
  assert.equal(DND5E_LITE_RULES.time?.model, 'round');
  assert.equal(DND5E_LITE_RULES.time?.durationUnit, 'round');
  // M9.1 校验器把 defaultMaxRounds 当正整数；0（= 无回合上限）因此省略（运行时缺省即 0）
  assert.equal(DND5E_LITE_RULES.time?.defaultMaxRounds, undefined);
});

// ---------------------------------------------------------------------------
// 脚本清单
// ---------------------------------------------------------------------------

test('脚本：8 个核心钩子映射到 4 个独立文件', () => {
  const scripts = DND5E_LITE_RULES.scripts ?? {};
  assert.deepEqual(Object.keys(scripts).sort(), [
    'computeDerived',
    'generateLoot',
    'onEvent',
    'onLevelUp',
    'resolveAttack',
    'resolveCheck',
    'resolveDamage',
    'validateSheet',
  ]);
  const files = new Set(Object.values(scripts).map((ref) => ref?.file));
  assert.deepEqual([...files].sort(), Object.values(DND5E_LITE_SCRIPT_FILES).sort());
  assert.equal(DND5E_LITE_SCRIPT_REFS.length, 4);
});

test('脚本：清单 sha256 与内联源码哈希一致，路径都在 rules/scripts/ 下', () => {
  for (const ref of DND5E_LITE_SCRIPT_REFS) {
    assert.match(ref.file, /^rules\/scripts\/[a-z]+\.js$/u);
    assert.equal(ref.sha256, DND5E_LITE_SCRIPT_HASH_BY_FILE[ref.file], `${ref.file} 的哈希应来自 generated 常量`);
    assert.ok(DND5E_LITE_SCRIPT_CODE_BY_FILE[ref.file]?.includes('module.exports'), `${ref.file} 应导出 CommonJS 模块`);
  }
});

test('脚本：源码中没有沙箱禁用的全局能力（require/process/Date/Math.random/eval）', () => {
  for (const source of DND5E_LITE_SCRIPT_SOURCES) {
    // 注释里会说明「不要用 Math.random / Date」，扫代码前先剥掉注释
    const code = source.code
      .replace(/\/\*[\s\S]*?\*\//gu, ' ')
      .replace(/^[ \t]*\/\/[^\n]*/gmu, ' ');
    assert.doesNotMatch(code, /\brequire\s*\(/u, `${source.file} 不应 require`);
    assert.doesNotMatch(code, /\bprocess\s*\./u);
    assert.doesNotMatch(code, /\bnew\s+Date\b/u);
    assert.doesNotMatch(code, /Math\s*\.\s*random/u);
    assert.doesNotMatch(code, /\beval\s*\(/u);
    assert.doesNotMatch(code, /^\s*import\s+/mu);
  }
});

// ---------------------------------------------------------------------------
// 校验负例（规则段 / 脚本完整性）
// ---------------------------------------------------------------------------

test('规则包校验负例：非法公式 / 未知钩子 / 破坏 sheet 段都会报错', () => {
  const badFormula = cloneRules();
  badFormula.formulas.check = 'derived.mod +';
  const formulaReport = validateRulePack(badFormula);
  assert.equal(formulaReport.ok, false);
  assert.match(formulaReport.errors.join('\n'), /formulas\.check/u);

  const badHook = cloneRules() as unknown as { scripts: Record<string, unknown> };
  badHook.scripts.bogusHook = { file: 'rules/scripts/sheet.js', sha256: DND5E_LITE_RULES.scripts?.validateSheet?.sha256 };
  const hookReport = validateRulePack(badHook as unknown);
  assert.equal(hookReport.ok, false);
  assert.match(hookReport.errors.join('\n'), /未知钩子/u);

  const noSheet = cloneRules() as unknown as { sheet: Record<string, unknown> };
  delete noSheet.sheet.attributes;
  const sheetReport = validateRulePack(noSheet as unknown);
  assert.equal(sheetReport.ok, false);
  assert.match(sheetReport.errors.join('\n'), /sheet\.attributes/u);
});

test('pack.rules：内置包带脚本校验通过；只做结构校验时不阻断也不告警', () => {
  const ok = validatePack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.deepEqual(ok.warnings, [], '脚本与清单一致时不应有 warning');

  // 没有脚本字节的调用方（如 host 列内置包）只做结构校验：不报 error、也不告警
  const structuralOnly = validatePack(CORE_GUIMUYA_PACK);
  assert.equal(structuralOnly.ok, true, '结构校验应通过');
  assert.deepEqual(structuralOnly.warnings, []);
});

test('pack.rules：外部规则包声明了脚本却没提供条目时报错（只有内置 rulesId 可自动补）', () => {
  const pack = JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
  const rules = pack.rules as RulePack;
  pack.rules = { ...rules, rulesId: 'third-party-rules' };
  const report = validatePack(pack, { scripts: new Map() });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /不在包内/u);
});

test('pack.rules：rulesId 与 pack.ruleSystem.id 不一致时报错', () => {
  const pack = JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
  pack.rules = { ...(pack.rules as RulePack), rulesId: 'other-rules' };
  const report = validatePack(pack, { scripts: SCRIPTS });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /rulesId/u);
});

test('pack.rules：脚本 sha256 被篡改时报错', () => {
  const pack = JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
  const rules = pack.rules as RulePack;
  rules.scripts = {
    ...rules.scripts,
    validateSheet: { file: 'rules/scripts/sheet.js', sha256: 'a'.repeat(64) },
  };
  pack.rules = rules;
  const report = validatePack(pack, { scripts: SCRIPTS });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /sha256 与规则包清单不符/u);
});

test('pack.rules：缺少脚本条目时报错（导出/导入必须带脚本）', () => {
  const report = validatePack(CORE_GUIMUYA_PACK, { scripts: new Map() });
  assert.equal(report.ok, false);
  assert.match(report.errors.join('\n'), /不在包内/u);
});

// ---------------------------------------------------------------------------
// .trpgpack 集成
// ---------------------------------------------------------------------------

test('trpgpack：导出把 4 个脚本写成独立 zip 条目，pack.json 只留 file+sha256', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  const { entries } = readZip(bytes);
  for (const file of Object.values(DND5E_LITE_SCRIPT_FILES)) {
    assert.ok(entries.has(file), `zip 应包含脚本条目 ${file}`);
    assert.equal(new TextDecoder().decode(entries.get(file)?.data), SCRIPTS.get(file), `${file} 内容应原样写入`);
  }
  const packJson = new TextDecoder().decode(entries.get('pack.json')?.data);
  assert.ok(packJson.includes('"rules/scripts/sheet.js"'), 'pack.json 应保留脚本引用路径');
  assert.ok(!packJson.includes('module.exports'), 'pack.json 不应内联脚本源码');
});

test('trpgpack：内置规则包不传 scripts 也能导出（按 rulesId 自动补内置源码）', () => {
  const auto = packToTrpgpack(CORE_GUIMUYA_PACK);
  const decodedAuto = trpgpackToPack(auto);
  assert.equal(decodedAuto.ok, true, decodedAuto.errors.join('\n'));
  assert.equal(decodedAuto.scripts.size, DND5E_LITE_SCRIPT_SOURCES.length);
  const explicit = packToTrpgpack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  assert.equal(Buffer.compare(Buffer.from(auto), Buffer.from(explicit)), 0, '自动补脚本应与显式传入字节一致');
});

test('trpgpack：解码带脚本的包后脚本条目/哈希可再次导出（字节可复现）', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  const decoded = trpgpackToPack(bytes);
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.equal(decoded.scripts.size, 4);
  assert.deepEqual(decoded.warnings, []);
  const again = packToTrpgpack(decoded.pack as ContentPack, { scripts: decoded.scripts });
  assert.equal(Buffer.compare(Buffer.from(again), Buffer.from(bytes)), 0);
});

/** 把 zip 条目改一改再写回（构造篡改/缺条目/多余条目场景）。 */
function rewriteZip(bytes: Uint8Array, mutate: (entries: ZipWriteEntry[]) => void): Uint8Array {
  const entries: ZipWriteEntry[] = [];
  for (const entry of readZip(bytes).entries.values()) {
    entries.push({
      name: entry.name,
      data: entry.data,
      method: entry.method === 0 ? 'stored' : 'deflate',
    });
  }
  mutate(entries);
  return writeZip(entries);
}

test('trpgpack：脚本内容被篡改 → 解码报 sha256 不符', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  const tampered = rewriteZip(bytes, (entries) => {
    const target = entries.find((entry) => entry.name === 'rules/scripts/combat.js');
    assert.ok(target);
    target.data = encoder.encode('/** 被改过的脚本 */\nmodule.exports = { resolveCheck: function () {} };\n');
  });
  const decoded = trpgpackToPack(tampered);
  assert.equal(decoded.ok, false);
  assert.match(decoded.errors.join('\n'), /sha256 与规则包清单不符/u);
});

test('trpgpack：缺少脚本条目 → 解码报「不在包内」', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  const missing = rewriteZip(bytes, (entries) => {
    const index = entries.findIndex((entry) => entry.name === 'rules/scripts/events.js');
    assert.ok(index >= 0);
    entries.splice(index, 1);
  });
  const decoded = trpgpackToPack(missing);
  assert.equal(decoded.ok, false);
  assert.match(decoded.errors.join('\n'), /不在包内/u);
});

test('trpgpack：清单之外的脚本条目只给孤立脚本 warning，不阻断', () => {
  const bytes = packToTrpgpack(CORE_GUIMUYA_PACK, { scripts: SCRIPTS });
  const extra = rewriteZip(bytes, (entries) => {
    entries.push({
      name: 'rules/scripts/draft.js',
      data: encoder.encode('module.exports = { onEvent: function () { return {}; } };\n'),
      method: 'deflate',
    });
  });
  const decoded = trpgpackToPack(extra);
  assert.equal(decoded.ok, true, decoded.errors.join('\n'));
  assert.match(decoded.warnings.join('\n'), /孤立脚本/u);
  assert.equal(decoded.scripts.size, 5);
});
