import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCharacterCard } from '@dsh-trpg/engine';
import {
  CARDS,
  CORE_GUIMUYA_PACK,
  CORE_GUIMUYA_PACK_ID,
  CORE_GUIMUYA_PACK_NAME,
  CORE_GUIMUYA_PACK_VERSION,
  GUIMUYA_LOREBOOK,
  GUIMUYA_MODULE,
  ITEMS,
  MONSTERS,
  PRESET_CARDS,
  SPELLS,
  PackValidationError,
  assertContentPack,
  migratePack,
  toCharacterCard,
  toLegacyLorebook,
  toLegacyModuleDef,
  validateLorebook,
  validateModule,
  validatePack,
  type CharacterCardDef,
  type ContentPack,
} from '../src/index.ts';
import { contentHashOfPack } from '../src/pack-zip.ts';
import { validatePack as validatePackFromPackModule } from '../src/pack.ts';
import { importPackFile, readPackFile, readPackJsonFile, writePackFile } from '../src/pack-io.ts';
import { DND5E_LITE_SCRIPT_SOURCES } from '../src/rules-pack/index.ts';

const RULE_DATA = {
  monsterIds: MONSTERS.map((monster) => monster.id),
  itemIds: ITEMS.map((item) => item.id),
  spellIds: SPELLS.map((spell) => spell.id),
};

/** 内置规则包的脚本源码（校验 `pack.rules.scripts` 的 sha256 需要）。 */
const SCRIPTS = new Map(DND5E_LITE_SCRIPT_SOURCES.map((source) => [source.file, source.code]));

function clonePack(): ContentPack {
  return JSON.parse(JSON.stringify(CORE_GUIMUYA_PACK)) as ContentPack;
}

function packErrors(report: { errors: string[] }): string {
  return report.errors.join('\n');
}

test('pack: 内置包 core-guimuya 校验通过，模组/世界书/卡数量符合约定', () => {
  const report = validatePack(CORE_GUIMUYA_PACK, { ruleData: RULE_DATA, scripts: SCRIPTS });
  assert.equal(report.ok, true, packErrors(report));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);

  assert.equal(CORE_GUIMUYA_PACK.schemaVersion, 'trpg.pack/1');
  assert.equal(CORE_GUIMUYA_PACK.packId, 'core-guimuya');
  assert.equal(CORE_GUIMUYA_PACK.version, '1.0.0');
  assert.equal(CORE_GUIMUYA_PACK.name, '鬼木崖·异光');
  assert.deepEqual(CORE_GUIMUYA_PACK.ruleSystem, { id: 'dnd5e-lite', name: 'D&D 5e-lite' });
  assert.equal(CORE_GUIMUYA_PACK.rules?.rulesId, 'dnd5e-lite');
  assert.equal(CORE_GUIMUYA_PACK.rules?.rulesVersion, '2.0.0');
  assert.equal(CORE_GUIMUYA_PACK.modules.length, 1);
  assert.equal(CORE_GUIMUYA_PACK.modules[0]?.moduleId, 'guimuya');
  assert.equal(CORE_GUIMUYA_PACK.defaultModuleId, CORE_GUIMUYA_PACK.modules[0]?.moduleId);
  assert.equal(CORE_GUIMUYA_PACK.modules[0]?.startSceneId, 'scene_qingshi');
  assert.equal(CORE_GUIMUYA_PACK.lorebook.entries.length, 10);
  assert.equal(CORE_GUIMUYA_PACK.cards.length, 4);
  assert.equal(CORE_GUIMUYA_PACK.modules[0]?.scenes.length, 3);
  assert.equal(CORE_GUIMUYA_PACK.modules[0]?.encounters.length, 3);
  assert.equal(CORE_GUIMUYA_PACK.modules[0]?.rewards.length, 4);
});

test('pack: 场景 loreIds 全部命中世界书条目（已知 scene.lore 数据 bug 已修）', () => {
  const loreIds = new Set(CORE_GUIMUYA_PACK.lorebook.entries.map((entry) => entry.loreId));
  for (const module of CORE_GUIMUYA_PACK.modules) {
    for (const scene of module.scenes) {
      for (const loreId of scene.loreIds ?? []) {
        assert.ok(loreIds.has(loreId), `场景 ${scene.sceneId} 引用了不存在的世界书条目：${loreId}`);
      }
    }
  }
  const qingshi = CORE_GUIMUYA_PACK.modules[0]?.scenes.find((scene) => scene.sceneId === 'scene_qingshi');
  assert.deepEqual(qingshi?.loreIds, [
    'entry_qingshi',
    'entry_bounty',
    'entry_guimuya',
    'entry_liuzhanggui',
    'entry_laolieren',
  ]);
  // 旧导出形状里也是修正后的值（D12 适配）
  assert.deepEqual(GUIMUYA_MODULE.scenes[0]?.lore, qingshi?.loreIds);
  const loreEntryIds = new Set(GUIMUYA_LOREBOOK.entries.map((entry) => entry.id));
  for (const loreId of qingshi?.loreIds ?? []) assert.ok(loreEntryIds.has(loreId));
});

test('pack: 引用完整性负例（lore/npc/encounter/reward/startScene/defaultModule）聚合报错', () => {
  const broken = clonePack();
  const module = broken.modules[0]!;
  module.scenes[0]!.loreIds = ['entry_qingshi', 'entry_missing'];
  module.scenes[0]!.npcIds = ['npc_missing'];
  module.scenes[1]!.encounterIds = ['enc_missing'];
  module.scenes[2]!.rewardIds = ['reward_missing'];
  module.startSceneId = 'scene_missing';
  broken.defaultModuleId = 'module_missing';

  const report = validatePack(broken, { ruleData: RULE_DATA });
  assert.equal(report.ok, false);
  const text = packErrors(report);
  assert.match(text, /世界书条目/);
  assert.match(text, /NPC/);
  assert.match(text, /遭遇/);
  assert.match(text, /奖励/);
  assert.match(text, /startSceneId/);
  assert.match(text, /defaultModuleId/);
});

test('pack: 重 id 报错（loreId / cardId / sceneId / encounterId / rewardId）', () => {
  const broken = clonePack();
  const lorebook = broken.lorebook;
  lorebook.entries[1]!.loreId = lorebook.entries[0]!.loreId;
  broken.cards[1]!.cardId = broken.cards[0]!.cardId;
  const module = broken.modules[0]!;
  module.scenes[1]!.sceneId = module.scenes[0]!.sceneId;
  module.encounters[1]!.encounterId = module.encounters[0]!.encounterId;
  module.rewards[1]!.rewardId = module.rewards[0]!.rewardId;

  const report = validatePack(broken, { ruleData: RULE_DATA });
  assert.equal(report.ok, false);
  const text = packErrors(report);
  for (const fragment of ['loreId 重复', 'cardId 重复', 'sceneId 重复', 'encounterId 重复', 'rewardId 重复']) {
    assert.match(text, new RegExp(fragment));
  }
});

test('pack: 卡 ruleSystem / source.ruleId 必须与 pack.ruleSystem 一致', () => {
  const broken = clonePack();
  broken.cards[0]!.ruleSystem = { id: 'other-rule', name: 'Other' };
  broken.cards[1]!.source = { ruleId: 'other-rule', ruleVersion: '1.0' };
  const report = validatePack(broken, { ruleData: RULE_DATA });
  assert.equal(report.ok, false);
  const text = packErrors(report);
  assert.match(text, /ruleSystem\.id/);
  assert.match(text, /source\.ruleId/);
});

test('pack: 素材引用（icon）与路径安全校验', () => {
  const withIcon = clonePack();
  withIcon.icon = 'assets/cover.svg';
  assert.equal(validatePack(withIcon, { ruleData: RULE_DATA }).ok, true, '未提供 assetPaths 时只校验路径形状');

  const missing = validatePack(withIcon, { ruleData: RULE_DATA, assetPaths: [] });
  assert.equal(missing.ok, false);
  assert.match(packErrors(missing), /icon 引用的素材不存在/);

  const present = validatePack(withIcon, { ruleData: RULE_DATA, assetPaths: ['assets/cover.svg'] });
  assert.equal(present.ok, true, packErrors(present));

  const unsafe = validatePack(clonePack(), { ruleData: RULE_DATA, assetPaths: ['assets/../evil.png'] });
  assert.equal(unsafe.ok, false);
  assert.match(packErrors(unsafe), /素材路径非法/);

  const badIcon = clonePack();
  badIcon.icon = 'https://example.com/cover.png';
  assert.equal(validatePack(badIcon).ok, false, 'icon 只能是 assets/ 相对路径或内联 SVG');
});

test('pack: 规则数据索引可查怪物/物品/法术引用', () => {
  const broken = clonePack();
  broken.modules[0]!.encounters[0]!.monsters[0]!.monsterId = 'monster_missing';
  broken.modules[0]!.rewards[0]!.items = ['item_missing'];
  const report = validatePack(broken, {
    ruleData: { monsterIds: MONSTERS.map((monster) => monster.id), itemIds: ITEMS.map((item) => item.id) },
  });
  assert.equal(report.ok, false);
  const text = packErrors(report);
  assert.match(text, /不存在的怪物/);
  assert.match(text, /不存在的物品/);
});

test('pack: v1 约束（schemaVersion / modules 长度 / defaultModuleId）', () => {
  const wrongSchema: unknown = { ...clonePack(), schemaVersion: 'trpg.pack/2' };
  assert.match(packErrors(validatePack(wrongSchema)), /schemaVersion 必须为 "trpg.pack\/1"/);

  const multi = clonePack() as unknown as { modules: unknown[] };
  multi.modules.push(JSON.parse(JSON.stringify(multi.modules[0])) as unknown);
  const report = validatePack(multi);
  assert.equal(report.ok, false);
  assert.match(packErrors(report), /modules 长度必须为 1/);
});

test('pack: migratePack 迁移旧 bundle（id→*Id、lore 前缀、内联遭遇/奖励上移、cardId）', () => {
  const legacy = {
    packId: 'legacy-demo',
    title: '旧草案包',
    version: '0.1.0',
    author: 'tester',
    rules: { ruleId: 'dnd5e-lite' },
    defaultModule: 'demo',
    lorebook: {
      schemaVersion: 1,
      id: 'lore_demo',
      title: '旧世界书',
      entries: [
        {
          id: 'entry_qingshi',
          title: '青石镇',
          keys: ['青石镇'],
          visibility: 'public',
          priority: 10,
          content: '旧世界书条目',
        },
      ],
    },
    modules: [
      {
        schemaVersion: 1,
        id: 'demo',
        title: '旧模组',
        ruleId: 'dnd5e-lite',
        level: [1, 1],
        playerCount: [1, 2],
        durationMinutes: 10,
        synopsis: '旧模组简介',
        defaultSceneId: 'scene_a',
        npcs: [{ id: 'npc_a', name: '甲', description: 'NPC 甲' }],
        scenes: [
          {
            id: 'scene_a',
            title: '第一幕',
            entry: '足够长的开场旁白，用来占位。',
            npcs: ['npc_a'],
            lore: ['qingshi'],
            encounters: [{ id: 'enc_a', monsters: [{ monsterId: 'guihuo', count: 1 }] }],
            checks: [{ when: '观察', skill: 'perception', dc: 10, success: '成功', failure: '失败' }],
            rewards: [{ xp: 5, items: [] }],
          },
        ],
        secrets: [{ id: 'secret_a', content: '秘密内容', revealWhen: '某时' }],
      },
    ],
    cards: [
      {
        schemaVersion: 1,
        id: 'card_legacy',
        identity: { name: '旧卡', race: '山民', class: '武者', level: 1 },
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        proficiency: { bonus: 2, skills: ['athletics'], saves: ['str'] },
        combat: { ac: 12, hpMax: 8, attacks: [{ name: '拳', ability: 'str', proficient: true, damage: '1d4', range: 'engaged' }] },
        inventory: [],
        publicSummary: '旧卡摘要',
      },
    ],
  };

  const migration = migratePack(legacy);
  assert.equal(migration.migrated, true);
  assert.ok(migration.warnings.some((warning) => warning.includes('entry_qingshi')), '应提示 lore 前缀自动补齐');
  const report = validatePack(migration.pack, { ruleData: { monsterIds: ['guihuo'] } });
  assert.equal(report.ok, true, packErrors(report));
  const pack = report.value!;

  assert.equal(pack.schemaVersion, 'trpg.pack/1');
  assert.equal(pack.name, '旧草案包');
  assert.deepEqual(pack.ruleSystem, { id: 'dnd5e-lite', name: 'dnd5e-lite' });
  assert.equal(pack.defaultModuleId, 'demo');
  assert.equal(pack.lorebook.lorebookId, 'lore_demo');
  assert.equal(pack.lorebook.entries[0]?.loreId, 'entry_qingshi');
  const module = pack.modules[0]!;
  assert.equal(module.moduleId, 'demo');
  assert.equal(module.startSceneId, 'scene_a');
  assert.deepEqual(module.scenes[0]?.loreIds, ['entry_qingshi']);
  assert.deepEqual(module.scenes[0]?.npcIds, ['npc_a']);
  assert.deepEqual(module.scenes[0]?.encounterIds, ['enc_a']);
  assert.deepEqual(module.scenes[0]?.rewardIds, ['scene_a_reward_1']);
  assert.equal(module.encounters[0]?.encounterId, 'enc_a');
  assert.equal(module.rewards[0]?.rewardId, 'scene_a_reward_1');
  assert.equal(module.scenes[0]?.checks?.[0]?.checkId, 'scene_a_check_1');
  assert.equal(module.npcs[0]?.npcId, 'npc_a');
  assert.equal(module.secrets[0]?.secretId, 'secret_a');
  const card = pack.cards[0]!;
  assert.equal(card.cardId, 'card_legacy');
  assert.deepEqual(card.ruleSystem, { id: 'dnd5e-lite', name: 'dnd5e-lite' });
});

test('pack: migratePack 对规范包原样返回（内容指纹可复现的前提）', () => {
  const migration = migratePack(CORE_GUIMUYA_PACK);
  assert.equal(migration.migrated, false);
  assert.deepEqual(migration.warnings, []);
  assert.equal(migration.pack, CORE_GUIMUYA_PACK);
  assert.equal(contentHashOfPack(migration.pack as ContentPack), contentHashOfPack(CORE_GUIMUYA_PACK));
});

test('pack: D12 兼容导出与 pack 一致，旧 schema 校验仍通过', () => {
  assert.equal(CORE_GUIMUYA_PACK_ID, 'core-guimuya');
  assert.equal(CORE_GUIMUYA_PACK_VERSION, '1.0.0');
  assert.equal(CORE_GUIMUYA_PACK_NAME, '鬼木崖·异光');
  assert.equal(CARDS.length, 4);
  assert.equal(PRESET_CARDS, CARDS);
  assert.equal(CARDS[0]?.id, 'card_aqing');
  for (const card of CARDS) {
    const report = validateCharacterCard(card);
    assert.equal(report.ok, true, `${card.id}: ${report.errors.join('; ')}`);
  }
  const legacyModuleReport = validateModule(GUIMUYA_MODULE);
  assert.equal(legacyModuleReport.ok, true, legacyModuleReport.errors.join('; '));
  assert.equal(GUIMUYA_MODULE.id, 'guimuya');
  assert.equal(GUIMUYA_MODULE.ruleId, 'dnd5e-lite');
  assert.equal(GUIMUYA_MODULE.scenes.length, 3);
  assert.equal(GUIMUYA_MODULE.scenes[0]?.rewards?.length, 1, '旧形状里奖励应重新内联回场景');
  assert.equal(GUIMUYA_MODULE.scenes[1]?.encounters?.length, 2, '旧形状里遭遇应重新内联回场景');
  assert.equal(GUIMUYA_MODULE.scenes[2]?.encounters?.length, 1);
  assert.equal(GUIMUYA_MODULE.scenes[2]?.rewards?.length, 2);
  const legacyLorebookReport = validateLorebook(GUIMUYA_LOREBOOK);
  assert.equal(legacyLorebookReport.ok, true, legacyLorebookReport.errors.join('; '));
  assert.equal(GUIMUYA_LOREBOOK.id, 'lore_guimuya');
  assert.equal(GUIMUYA_LOREBOOK.entries.length, 10);

  const module = CORE_GUIMUYA_PACK.modules[0]!;
  assert.deepEqual(toLegacyModuleDef(module, CORE_GUIMUYA_PACK.ruleSystem), GUIMUYA_MODULE);
  assert.deepEqual(toLegacyLorebook(CORE_GUIMUYA_PACK.lorebook), GUIMUYA_LOREBOOK);
  const firstPackCard: CharacterCardDef | undefined = CORE_GUIMUYA_PACK.cards[0];
  assert.ok(firstPackCard);
  assert.deepEqual(toCharacterCard(firstPackCard), CARDS[0]);
});

test('pack: assertContentPack 校验失败时抛 PackValidationError（带聚合错误）', () => {
  assert.throws(
    () => assertContentPack({ schemaVersion: 'trpg.pack/1' }),
    (error: unknown) =>
      error instanceof PackValidationError &&
      error.errors.length >= 3 &&
      error.errors.some((message) => message.includes('packId')),
  );
});

test('pack: validatePack 与 pack.ts 导出的同一函数（index 重导出）', () => {
  assert.equal(validatePack, validatePackFromPackModule);
});

test('pack-io: writePackFile → readPackFile → importPackFile 往返（pack.json / 素材 / 规则脚本落盘）', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-trpg-pack-io-'));
  try {
    const pack = clonePack();
    pack.icon = 'assets/cover.svg';
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const filePath = join(workDir, 'core-guimuya-1.0.0.trpgpack');
    const written = await writePackFile(filePath, pack, { assets: new Map([['assets/cover.svg', svg]]), scripts: SCRIPTS });
    assert.equal(written.contentHash, contentHashOfPack(pack));
    assert.ok((await readFile(filePath)).length > 0);

    const readBack = await readPackFile(filePath);
    assert.equal(readBack.ok, true, readBack.errors.join('\n'));
    assert.equal(readBack.pack?.packId, 'core-guimuya');
    assert.ok(readBack.assets.has('assets/cover.svg'));
    assert.equal(readBack.scripts.size, SCRIPTS.size, '规则脚本条目应随包解码');

    const imported = await importPackFile(filePath, join(workDir, 'content', 'packs'));
    assert.equal(imported.ok, true, imported.errors.join('\n'));
    assert.equal(imported.packId, 'core-guimuya');
    assert.equal(imported.version, '1.0.0');
    const outputDir = imported.outputDir;
    assert.ok(outputDir);
    assert.ok((await stat(join(outputDir, 'pack.json'))).isFile());
    assert.ok((await stat(join(outputDir, 'assets', 'cover.svg'))).isFile());
    assert.deepEqual(imported.scriptPaths, [...SCRIPTS.keys()].sort());
    assert.ok((await stat(join(outputDir, 'rules', 'scripts', 'combat.js'))).isFile());

    const revalidated = await readPackJsonFile(join(outputDir, 'pack.json'), { loadAssets: true });
    assert.equal(revalidated.ok, true, revalidated.errors.join('\n'));
    assert.deepEqual(revalidated.assetPaths, ['assets/cover.svg']);
    assert.deepEqual(revalidated.scriptPaths, [...SCRIPTS.keys()].sort());
    assert.equal(revalidated.contentHash, contentHashOfPack(pack));
    assert.deepEqual([...(revalidated.assets.get('assets/cover.svg') ?? [])], [...svg]);

    // 源码目录形状 → 再导出，必须与原 .trpgpack 字节一致（contentHash 相同 + 固定 zip 元数据）
    const reexported = await writePackFile(join(workDir, 'reexported.trpgpack'), revalidated.pack!, {
      assets: revalidated.assets,
      scripts: revalidated.scripts,
    });
    assert.equal(Buffer.compare(Buffer.from(reexported.bytes), Buffer.from(written.bytes)), 0);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
