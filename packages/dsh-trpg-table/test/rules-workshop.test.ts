/**
 * M9.6b 规则校验 / 规则测试台（host/studio/rules-workshop.ts）：
 * `rules.validate` 的正常/草稿/脚本缺失/sha256 不符，`rules.test` 的派生/检定/动作/未知动作/
 * 合成样本卡/草稿试跑/脚本超时/脚本语法错误/种子复现。
 *
 * 全部离线临时目录：内置包来自 `@dsh-trpg/content`，数据目录包在 tmpdir 现场编码（不碰真实 profile-data）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_GUIMUYA_PACK, type ContentPack } from '@dsh-trpg/content';
import { writePackFile } from '@dsh-trpg/content/pack-io';
import { trpgpackFileName } from '@dsh-trpg/content/pack-zip';
import { scriptSourcesForRules } from '@dsh-trpg/content/rules-pack';
import type { RulePack } from '../../rules/src/types.ts';
import { PackRegistry } from '../src/host/pack-registry.ts';
import { RulesWorkshop } from '../src/host/studio/index.ts';

const BUILTIN_ID = CORE_GUIMUYA_PACK.packId;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface Harness {
  dir: string;
  registry: PackRegistry;
  workshop: RulesWorkshop;
  install: (pack: ContentPack, scripts?: readonly { file: string; code: string }[]) => Promise<void>;
  close: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trpg-rules-ws-'));
  const registry = new PackRegistry({ dir, log: () => {} });
  registry.reload();
  let clock = 1_760_000_000_000;
  const workshop = new RulesWorkshop({ registry, now: () => (clock += 5), log: () => {} });
  return {
    dir,
    registry,
    workshop,
    async install(pack, scripts) {
      mkdirSync(dir, { recursive: true });
      await writePackFile(join(dir, trpgpackFileName(pack)), pack, {
        ...(scripts !== undefined ? { scripts } : {}),
      });
      registry.reload();
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 内置包 clone + 换 packId/version（保留 rules/lorebook/modules/cards）。 */
function clonePack(packId: string, version = '1.0.0'): ContentPack {
  const clone = structuredClone(CORE_GUIMUYA_PACK) as ContentPack;
  clone.packId = packId;
  clone.version = version;
  clone.name = `测试包 ${packId}`;
  clone.author = 'm96b 测试';
  return clone;
}

function rulesOf(pack: ContentPack): RulePack {
  assert.ok(pack.rules !== undefined, '测试包应带 rules 段');
  return pack.rules;
}

// ---------------------------------------------------------------------------
// rules.validate
// ---------------------------------------------------------------------------

test('rules.validate：内置包通过（validateRulePack + 脚本 sha256 全部一致）', () => {
  const { workshop, close } = harness();
  try {
    const result = workshop.validate({ packId: BUILTIN_ID });
    assert.equal(result.ok, true, result.errors.join('；'));
    assert.equal(result.rulesId, CORE_GUIMUYA_PACK.rules?.rulesId);
    assert.equal(result.draft, false);
    assert.ok(result.scripts.length >= 8, `内置包应有 8 个钩子脚本条目，实际 ${result.scripts.length}`);
    for (const script of result.scripts) {
      assert.equal(script.exists, true, `${script.file} 应存在`);
      assert.equal(script.sha256Ok, true, `${script.file} sha256 应一致（${script.message}）`);
      assert.equal(script.actualSha256, script.declaredSha256);
      assert.match(script.message, /一致/);
    }
    assert.deepEqual(result.errors, []);
    assert.equal(typeof result.durationMs, 'number');
  } finally {
    close();
  }
});

test('rules.validate：内容包不存在 → not-found 中文错误', () => {
  const { workshop, close } = harness();
  try {
    assert.throws(
      () => workshop.validate({ packId: 'nope' }),
      (error: unknown) => {
        assert.match(String(error), /内容包不存在/);
        return true;
      },
    );
  } finally {
    close();
  }
});

test('rules.validate：没有 rules 段的包 → 明确错误（纯叙事包）', async () => {
  const { workshop, install, close } = harness();
  try {
    const pack = clonePack('plain-pack');
    delete (pack as ContentPack & { rules?: unknown }).rules;
    await install(pack);
    const result = workshop.validate({ packId: 'plain-pack' });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('；'), /没有 rules 段/);
    assert.equal(result.rulesId, null);
  } finally {
    close();
  }
});

test('rules.validate：草稿 pack 校验不落盘（规则数据错误只出现在草稿结果里）', () => {
  const { workshop, registry, close } = harness();
  try {
    const draft = structuredClone(CORE_GUIMUYA_PACK) as ContentPack;
    const rules = rulesOf(draft);
    rules.rulesId = ''; // 必填字段清空 → validateRulePack 报错
    const result = workshop.validate({ packId: BUILTIN_ID, pack: draft });
    assert.equal(result.ok, false);
    assert.equal(result.draft, true);
    assert.match(result.errors.join('；'), /rulesId/);
    // 不落盘：注册表里的内置包规则没被改动
    assert.equal(registry.getEntry(BUILTIN_ID)?.pack.rules?.rulesId, CORE_GUIMUYA_PACK.rules?.rulesId);
  } finally {
    close();
  }
});

test('rules.validate：草稿 pack 的脚本 sha256 被改坏 → 报「与清单不符」（不落盘）', () => {
  const { workshop, close } = harness();
  try {
    const draft = structuredClone(CORE_GUIMUYA_PACK) as ContentPack;
    const rules = rulesOf(draft);
    const firstHook = Object.keys(rules.scripts ?? {})[0];
    assert.ok(firstHook !== undefined);
    const ref = rules.scripts![firstHook as keyof NonNullable<RulePack['scripts']>]!;
    rules.scripts![firstHook as keyof NonNullable<RulePack['scripts']>] = { ...ref, sha256: '0'.repeat(64) };
    const result = workshop.validate({ packId: BUILTIN_ID, pack: draft });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('；'), /sha256 与清单不符/);
    const broken = result.scripts.find((script) => script.sha256Ok === false);
    assert.ok(broken !== undefined, '应给出一条 sha256 不符的脚本结果');
    assert.equal(broken?.exists, true);
    assert.equal(broken?.actualSha256?.length, 64);
  } finally {
    close();
  }
});

test('rules.validate：草稿 pack 声称一个不存在的脚本文件 → 报「不存在于主机内容包」', () => {
  const { workshop, close } = harness();
  try {
    const draft = structuredClone(CORE_GUIMUYA_PACK) as ContentPack;
    const rules = rulesOf(draft);
    rules.scripts = {
      ...rules.scripts,
      resolveDamage: { file: 'rules/scripts/missing.js', sha256: 'a'.repeat(64) },
    };
    const result = workshop.validate({ packId: BUILTIN_ID, pack: draft });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('；'), /不存在于主机内容包/);
    const missing = result.scripts.find((script) => script.file === 'rules/scripts/missing.js');
    assert.equal(missing?.exists, false);
    assert.equal(missing?.sha256Ok, false);
    assert.equal(missing?.actualSha256, null);
  } finally {
    close();
  }
});

test('rules.validate：草稿 packId 与参数不一致 → 中文错误', () => {
  const { workshop, close } = harness();
  try {
    const draft = clonePack('other-pack');
    assert.throws(
      () => workshop.validate({ packId: BUILTIN_ID, pack: draft }),
      /pack 草稿的 packId 必须与参数一致/,
    );
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// rules.test
// ---------------------------------------------------------------------------

test('rules.test：derived 返回派生值 + trace（样本卡来自 pack.cards）', () => {
  const { workshop, close } = harness();
  try {
    const cardId = CORE_GUIMUYA_PACK.cards[0]?.cardId;
    assert.ok(cardId !== undefined);
    const result = workshop.test({
      packId: BUILTIN_ID,
      requests: [{ kind: 'derived', actorCardId: cardId }],
    });
    assert.equal(result.ok, true, result.errors.join('；') + JSON.stringify(result.outcomes[0]?.error ?? {}));
    assert.equal(result.draft, false);
    assert.equal(result.sampleActorId, cardId);
    assert.equal(result.sampleSource, 'pack');
    assert.equal(result.outcomes.length, 1);
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.kind, 'derived');
    assert.equal(outcome.rolls.length, 0);
    assert.ok(outcome.trace.lines.length > 0, 'trace 应有人话行');
    const derived = outcome.result?.derived as Record<string, unknown>;
    assert.ok(derived !== undefined && Object.keys(derived).length > 0, '派生值表不能为空');
    assert.equal(typeof derived.hpMax, 'number');
    assert.equal(typeof derived['mod.str'], 'number');
    assert.ok(result.outcomes.every((entry) => typeof entry.durationMs === 'number'));
  } finally {
    close();
  }
});

test('rules.test：技能检定返回 rolls/total/成败，同 seed 可复现', () => {
  const { workshop, close } = harness();
  try {
    const request = { kind: 'check' as const, skillId: 'athletics', dc: 12 };
    const first = workshop.test({ packId: BUILTIN_ID, requests: [request], seed: 424242 });
    const second = workshop.test({ packId: BUILTIN_ID, requests: [request], seed: 424242 });
    assert.equal(first.ok, true, JSON.stringify(first.outcomes[0]?.error ?? {}));
    const outcome = first.outcomes[0]!;
    assert.equal(outcome.ok, true);
    assert.ok(outcome.rolls.length >= 1, '检定应至少返回一颗 d20');
    assert.equal(typeof outcome.result?.total, 'number');
    assert.equal(typeof outcome.result?.success, 'boolean');
    assert.equal(typeof outcome.result?.degree, 'string');
    assert.ok(outcome.trace.lines.some((line) => /DC 12/.test(line)), `trace 应包含 DC：${outcome.trace.lines.join(' / ')}`);
    // 同 seed 复现：骰面/总值/成败一致
    assert.deepEqual(second.outcomes[0]?.rolls, outcome.rolls);
    assert.equal(second.outcomes[0]?.result?.total, outcome.result?.total);
    assert.equal(second.outcomes[0]?.result?.success, outcome.result?.success);
  } finally {
    close();
  }
});

test('rules.test：动作试跑（attack.melee → 命中/伤害/HP 变化取自运行时）', () => {
  const { workshop, close } = harness();
  try {
    const result = workshop.test({
      packId: BUILTIN_ID,
      requests: [{ kind: 'action', actionId: 'attack.melee', dc: 15 }],
      seed: 2026,
    });
    assert.equal(result.ok, true, JSON.stringify(result.outcomes[0]?.error ?? {}));
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.kind, 'action');
    assert.ok(outcome.rolls.length >= 1, '攻击应至少返回命中骰');
    assert.equal(typeof outcome.result?.hit, 'boolean');
    assert.equal(outcome.result?.actionId, 'attack.melee');
    assert.ok(outcome.trace.lines.some((line) => /命中判定/.test(line)), outcome.trace.lines.join(' / '));
    assert.ok(result.events.length > 0, '事件栏应记录动作事件');
  } finally {
    close();
  }
});

test('rules.test：未知动作 → 可读错误并列出可用动作提示', () => {
  const { workshop, close } = harness();
  try {
    const result = workshop.test({
      packId: BUILTIN_ID,
      requests: [{ kind: 'action', actionId: 'attack.nope' }],
    });
    assert.equal(result.ok, false);
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error?.messageZh ?? '', /规则包没有动作「attack\.nope」/);
    assert.match(outcome.error?.hint ?? '', /可用动作/);
  } finally {
    close();
  }
});

test('rules.test：包内没有指定样本卡 → 退回合成卡并给提示（sampleSource=synthetic）', () => {
  const { workshop, close } = harness();
  try {
    const result = workshop.test({
      packId: BUILTIN_ID,
      requests: [{ kind: 'check', actorCardId: 'no-such-card', dc: 10 }],
    });
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.ok, true, JSON.stringify(outcome.error ?? {}));
    assert.equal(result.sampleSource, 'synthetic');
    assert.match(result.sampleActorId ?? '', /^test-actor-/);
    assert.ok(outcome.trace.lines.some((line) => /合成样本卡/.test(line)), outcome.trace.lines.join(' / '));
  } finally {
    close();
  }
});

test('rules.test：草稿 pack 试跑不落盘（改动作名后验证草稿生效、注册表不变）', () => {
  const { workshop, registry, close } = harness();
  try {
    const before = workshop.test({
      packId: BUILTIN_ID,
      requests: [{ kind: 'action', actionId: 'attack.melee' }],
      seed: 9,
    });
    assert.equal(before.ok, true);
    const installedName = (registry.getEntry(BUILTIN_ID)?.pack.rules?.actions ?? []).find(
      (action) => action.actionId === 'attack.melee',
    )?.name;
    const draft = structuredClone(CORE_GUIMUYA_PACK) as ContentPack;
    const rules = rulesOf(draft);
    const draftAction = (rules.actions ?? []).find((action) => action.actionId === 'attack.melee');
    assert.ok(draftAction !== undefined);
    draftAction.name = '草稿版近战';
    const after = workshop.test({
      packId: BUILTIN_ID,
      requests: [{ kind: 'action', actionId: 'attack.melee' }],
      seed: 9,
      pack: draft,
    });
    assert.equal(after.ok, true, after.errors.join('；'));
    assert.equal(after.draft, true);
    assert.equal(after.outcomes[0]?.result?.actionName, '草稿版近战');
    assert.notEqual(installedName, '草稿版近战');
    const installedAfter = (registry.getEntry(BUILTIN_ID)?.pack.rules?.actions ?? []).find(
      (action) => action.actionId === 'attack.melee',
    )?.name;
    assert.equal(installedAfter, installedName, '草稿试跑不应改动已安装包');
  } finally {
    close();
  }
});

test('rules.test：脚本超时 → 可读中文（钩子执行超时，退回缺省结算）', async () => {
  const { workshop, install, close } = harness();
  try {
    const pack = clonePack('timeout-pack');
    const rules = rulesOf(pack);
    const timeoutCode = 'module.exports = { resolveCheck(ctx, req) { while (true) {} } };\n';
    rules.scripts = { ...rules.scripts, resolveCheck: { file: 'rules/scripts/timeout-check.js', sha256: sha256(timeoutCode) } };
    const sources = [...(scriptSourcesForRules(rules) ?? []).filter((source) => source.file !== 'rules/scripts/timeout-check.js'), { file: 'rules/scripts/timeout-check.js', code: timeoutCode }];
    await install(pack, sources);
    // 先确认 validate 的脚本全一致（超时是运行期问题，不是完整性）
    const validated = workshop.validate({ packId: 'timeout-pack' });
    assert.equal(validated.ok, true, validated.errors.join('；'));
    const started = Date.now();
    const result = workshop.test({
      packId: 'timeout-pack',
      requests: [{ kind: 'check', skillId: 'athletics', dc: 10 }],
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false, '脚本超时该条应判失败');
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error?.messageZh ?? '', /执行超时/);
    assert.match(outcome.error?.messageZh ?? '', /200ms/);
    assert.ok(outcome.trace.lines.some((line) => /超时/.test(line)), outcome.trace.lines.join(' / '));
    assert.ok(elapsed < 5000, `超时应在 200ms 级别返回（实际 ${elapsed}ms）`);
  } finally {
    close();
  }
});

test('rules.test：脚本语法错误 → 运行时创建失败给可读中文', async () => {
  const { workshop, install, close } = harness();
  try {
    const pack = clonePack('syntax-pack');
    const rules = rulesOf(pack);
    const badCode = 'module.exports = { resolveCheck(ctx, req) { return { total: } } };\n';
    rules.scripts = { ...rules.scripts, resolveCheck: { file: 'rules/scripts/syntax.js', sha256: sha256(badCode) } };
    const sources = [...(scriptSourcesForRules(rules) ?? []).filter((source) => source.file !== 'rules/scripts/syntax.js'), { file: 'rules/scripts/syntax.js', code: badCode }];
    await install(pack, sources);
    const validated = workshop.validate({ packId: 'syntax-pack' });
    assert.equal(validated.ok, true, validated.errors.join('；'));
    const result = workshop.test({ packId: 'syntax-pack', requests: [{ kind: 'check', dc: 10 }] });
    assert.equal(result.ok, false);
    const outcome = result.outcomes[0]!;
    assert.equal(outcome.ok, false);
    assert.match(outcome.error?.messageZh ?? '', /脚本加载失败|规则脚本/);
  } finally {
    close();
  }
});

test('rules.test：数据目录包可试跑（写盘 → reload → 试跑与内置包同路径）', async () => {
  const { workshop, install, close } = harness();
  try {
    const pack = clonePack('data-pack');
    await install(pack);
    const result = workshop.test({
      packId: 'data-pack',
      requests: [{ kind: 'derived' }, { kind: 'check', skillId: 'stealth', dc: 15 }],
    });
    assert.equal(result.ok, true, JSON.stringify(result.outcomes.map((outcome) => outcome.error ?? null)));
    assert.equal(result.outcomes.length, 2);
    assert.equal(result.draft, false);
    assert.ok((result.outcomes[1]?.rolls.length ?? 0) >= 1);
  } finally {
    close();
  }
});

test('rules.test：没有 rules 段 / 空 requests 边界', async () => {
  const { workshop, install, close } = harness();
  try {
    const plain = clonePack('plain-pack-2');
    delete (plain as ContentPack & { rules?: unknown }).rules;
    await install(plain);
    const noRules = workshop.test({ packId: 'plain-pack-2', requests: [{ kind: 'derived' }] });
    assert.equal(noRules.ok, false);
    assert.match(noRules.errors.join('；'), /没有 rules 段/);
    // 空 requests 由协议层拦截，这里直接调服务应返回空 outcomes（防御性断言）
    const empty = workshop.test({ packId: BUILTIN_ID, requests: [] });
    assert.equal(empty.outcomes.length, 0);
    assert.equal(empty.ok, true);
  } finally {
    close();
  }
});
