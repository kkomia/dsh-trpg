/**
 * M9.6b 规则校验 / 规则测试台（host 侧，工坊 RPC `rules.validate` / `rules.test` 的实现）。
 *
 * 口径（RULES-MODEL §3/§6/§12）：
 * - `rules.validate`：`validateRulePack()` 全量校验规则数据段 + 逐条脚本完整性
 *   （`rules.scripts[hook].file` 在主机上是否存在、实际内容 sha256 是否与清单一致）；
 *   可带**草稿 pack**（完整 pack.json）——只校验、不落盘；
 * - `rules.test`：**临时运行时 + 样本卡**跑一遍（不建房间、不写任何文件、不影响用户房间）：
 *   每条请求新建一个 `createRuleRuntime`（同 seed），从 `pack.cards[]` 取样本卡（旧卡先迁移）、
 *   没有卡就用合成卡；按 kind=check/action/derived 调运行时，把 `rolls` / `trace` / `result`
 *   原样返回；脚本抛错/超时从 `rules/error` 事件转成可读中文；
 * - 数值只来自运行时返回值（客户端不重算），与文档「主机权威」一致。
 */
import { createHash } from 'node:crypto';
import { migratePack, type ContentPack } from '@dsh-trpg/content';
import { RoomError, toCardInstance } from '@dsh-trpg/rooms';
import {
  CARD_SCHEMA_VERSION,
  LEVEL_FIELD_ID,
  createRuleRuntime,
  validateRulePack,
  type CardInstance,
  type CardSkillState,
  type RulePack,
  type RuleRuntime,
  type RuntimeEvent,
} from '../../../../rules/src/index.ts';
import type {
  RulesScriptCheck,
  RulesTestOutcome,
  RulesTestParams,
  RulesTestRequest,
  RulesTestResult,
  RulesValidateParams,
  RulesValidateResult,
} from '@dsh-trpg/protocol';
import type { PackEntry, PackRegistry } from '../pack-registry.ts';

export interface RulesWorkshopOptions {
  registry: PackRegistry;
  log?: (message: string) => void;
  now?: () => number;
}

/** 与运行时默认值一致：单次钩子上限 200ms（RULES-MODEL §6）。 */
const TEST_TIMEOUT_MS = 200;
const MAX_EVENT_LINES = 80;

/** sha256（与内容包脚本清单同口径：UTF-8 文本）。 */
function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结构化结果的 JSON 净化（运行时返回值应已是纯 JSON；这里兜底防循环引用）。 */
function plainJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/** 稳定派生测试种子（同 packId + rulesId 得到同一种子，便于复现）。 */
function deriveSeed(packId: string, rulesId: string): number {
  const digest = createHash('sha256').update(`rules-test:${packId}:${rulesId}`).digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

/** 运行时事件 → 一行中文摘要（测试台「事件」栏）。 */
function eventLine(event: RuntimeEvent): string {
  const data = isRecord(event.data) ? event.data : {};
  const bits: string[] = [];
  for (const key of ['actorId', 'targetId', 'actionId', 'hook', 'kind', 'amount', 'total', 'success', 'hpAfter']) {
    const value = data[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') bits.push(`${key}=${String(value)}`);
  }
  return `#${event.seq} ${event.kind}${bits.length > 0 ? `（${bits.join('，')}）` : ''}`;
}

/** 运行时事件里的 `rules/error` → 可读中文错误（脚本抛错/超时/返回值非法等）。 */
function hookErrorOf(event: RuntimeEvent): { code: string; messageZh: string; hint?: string } | null {
  if (event.kind !== 'rules/error') return null;
  const data = isRecord(event.data) ? event.data : {};
  const hook = typeof data.hook === 'string' ? data.hook : '未知钩子';
  const kind = typeof data.kind === 'string' ? data.kind : 'throw';
  const message = typeof data.message === 'string' ? data.message : '未知脚本错误';
  const label =
    kind === 'timeout'
      ? '执行超时（单次钩子上限 200ms）'
      : kind === 'shape'
        ? '返回值形状非法'
        : kind === 'limit'
          ? '调用次数超上限'
          : kind === 'integrity' || kind === 'syntax'
            ? '脚本完整性/语法错误'
            : '执行抛错';
  return {
    code: `hook_${kind}`,
    messageZh: `规则钩子「${hook}」${label}：${message}（本次已退回缺省行为，数值来自缺省结算）`,
    hint: '修正脚本后重新落盘脚本并更新 rules.scripts 里的 sha256（pack.update 只写 pack.json，不写脚本字节）',
  };
}

/** 合成样本卡（包内没有可用卡时）：按规则声明填默认属性/资源/技能/等级。 */
function syntheticCard(rules: RulePack, cardId: string, name: string): CardInstance {
  const attributes: Record<string, number> = {};
  for (const attribute of rules.sheet.attributes) attributes[attribute.id] = attribute.default;
  const resources: Record<string, { current: number }> = {};
  for (const resource of rules.sheet.resources) resources[resource.id] = { current: 1 };
  const skills: CardSkillState[] = rules.sheet.skills.map((skill) => ({ id: skill.id, proficient: false }));
  const fields: Record<string, string | number> = {};
  for (const field of rules.sheet.fields) {
    if (field.kind === 'number') fields[field.id] = field.id === LEVEL_FIELD_ID ? 1 : 0;
    else if (field.kind === 'enum') fields[field.id] = field.options?.[0] ?? '';
    else fields[field.id] = '';
  }
  return {
    schemaVersion: CARD_SCHEMA_VERSION,
    cardId,
    rulesId: rules.rulesId,
    rulesVersion: rules.rulesVersion,
    attributes,
    resources,
    fields,
    equipmentInstances: [],
    skills,
    statuses: [],
    notes: `测试台合成样本卡（${name}）`,
  };
}

/** 包内卡 → 卡实例（pack 卡是 `CharacterCardDef`：旧形状且只有 cardId，补 id 后走 rooms 迁移器）。 */
function packCardInstance(rules: RulePack, rawCard: unknown): { card?: CardInstance; error?: string } {
  const candidate =
    isRecord(rawCard) && rawCard.schemaVersion !== CARD_SCHEMA_VERSION
      ? { id: rawCard.cardId ?? rawCard.id, ...rawCard }
      : rawCard;
  const converted = toCardInstance(rules, candidate);
  if (converted.card === undefined) return { error: converted.error ?? '角色卡无法转换为规则卡实例' };
  return { card: converted.card };
}

/** 校验规则包内声明的脚本：文件存在性 + 实际内容 sha256（与清单比对）。 */
export function checkRulesScripts(
  rules: RulePack | undefined,
  entry: PackEntry | undefined,
): { checks: RulesScriptCheck[]; errors: string[]; warnings: string[] } {
  const checks: RulesScriptCheck[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const declared = rules?.scripts;
  const scripts = entry?.scripts ?? [];
  const byFile = new Map(scripts.map((script) => [script.file, script]));
  if (declared === undefined) {
    if (scripts.length > 0) {
      warnings.push(`主机上有 ${scripts.length} 个规则脚本文件，但 rules.scripts 清单为空（运行时不会加载脚本）`);
    }
    return { checks, errors, warnings };
  }
  const referenced = new Set<string>();
  for (const [hook, ref] of Object.entries(declared)) {
    const file = typeof ref?.file === 'string' ? ref.file : '';
    const declaredSha256 = typeof ref?.sha256 === 'string' ? ref.sha256 : '';
    referenced.add(file);
    const source = byFile.get(file);
    if (source === undefined) {
      const message = `脚本「${file}」（钩子 ${hook}）不存在于主机内容包：内置包脚本未随代码发布，或数据包 zip 缺少 rules/scripts 条目`;
      checks.push({ hook, file, declaredSha256, actualSha256: null, exists: false, sha256Ok: false, message });
      errors.push(message);
      continue;
    }
    const actualSha256 = sha256Text(source.code);
    const sha256Ok = declaredSha256.length > 0 && actualSha256 === declaredSha256;
    const message = sha256Ok
      ? `脚本「${file}」（钩子 ${hook}）存在，sha256 与清单一致`
      : `脚本「${file}」（钩子 ${hook}）的 sha256 与清单不符（清单 ${declaredSha256.slice(0, 12)}…，实际 ${actualSha256.slice(0, 12)}…）：修改脚本后必须重新计算并更新 rules.scripts[].sha256，否则运行时会拒绝加载`;
    checks.push({ hook, file, declaredSha256, actualSha256, exists: true, sha256Ok, message });
    if (!sha256Ok) errors.push(message);
  }
  for (const script of scripts) {
    if (!referenced.has(script.file)) {
      warnings.push(`脚本「${script.file}」没有被 rules.scripts 引用（运行时会忽略该文件）`);
    }
  }
  return { checks, errors, warnings };
}

/** 一条测试请求的准备结果（临时运行时 + 已入场的样本卡/假人）。 */
interface PreparedRun {
  runtime: RuleRuntime;
  actorId: string;
  targetId?: string;
  warnings: string[];
  dispose: () => void;
}

/** 规则包校验/测试台服务（工坊 RPC 的实现；宿主错误统一 `RoomError`）。 */
export class RulesWorkshop {
  private readonly registry: PackRegistry;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  constructor(options: RulesWorkshopOptions) {
    this.registry = options.registry;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  private entryOrThrow(packId: string): PackEntry {
    const entry = this.registry.getEntry(packId);
    if (entry === undefined) throw new RoomError('not-found', `内容包不存在：${packId}`);
    return entry;
  }

  /** 解析目标包：草稿优先（不落盘），否则用已安装包。 */
  private resolvePack(params: { packId: string; pack?: unknown }): {
    entry: PackEntry;
    pack: ContentPack;
    draft: boolean;
    warnings: string[];
  } {
    const entry = this.entryOrThrow(params.packId);
    if (params.pack === undefined) return { entry, pack: entry.pack, draft: false, warnings: [] };
    if (!isRecord(params.pack)) throw new RoomError('bad-request', 'pack 草稿必须是对象（完整 pack.json）');
    if (params.pack.packId !== params.packId) {
      throw new RoomError(
        'bad-request',
        `pack 草稿的 packId 必须与参数一致（参数 ${JSON.stringify(params.packId)}，草稿 ${JSON.stringify(params.pack.packId)}）`,
      );
    }
    const migration = migratePack(params.pack);
    return { entry, pack: migration.pack as ContentPack, draft: true, warnings: migration.warnings };
  }

  /** `rules.validate`：validateRulePack + 脚本 sha256/存在性；草稿不落盘。 */
  validate(params: RulesValidateParams): RulesValidateResult {
    const started = this.now();
    const resolved = this.resolvePack(params);
    const rules = resolved.pack.rules;
    const report = validateRulePack(rules);
    const errors = [...report.errors];
    const warnings = [...resolved.warnings, ...report.warnings];
    if (rules === undefined) {
      errors.unshift('该内容包没有 rules 段（纯叙事包）：没有属性/资源/技能/动作/公式可校验');
    }
    const scripts = checkRulesScripts(rules, resolved.entry);
    errors.push(...scripts.errors);
    warnings.push(...scripts.warnings);
    const result: RulesValidateResult = {
      ok: errors.length === 0,
      errors,
      warnings,
      packId: params.packId,
      rulesId: rules?.rulesId ?? null,
      draft: resolved.draft,
      scripts: scripts.checks,
      durationMs: Math.max(0, this.now() - started),
    };
    this.log(`rules.validate ${params.packId}${resolved.draft ? '（草稿）' : ''}: ${result.ok ? 'ok' : `${errors.length} errors`}`);
    return result;
  }

  /** 建一个临时运行时并放入样本卡（+ 动作需要的敌方假人）。每条请求独立，互不污染。 */
  private prepare(entry: PackEntry, rules: RulePack, pack: ContentPack, request: RulesTestRequest, index: number, seed: number): PreparedRun {
    const warnings: string[] = [];
    const scripts = (entry.scripts ?? []).map((script) => ({ file: script.file, code: script.code, sha256: script.sha256 }));
    const runtime = createRuleRuntime({
      rules,
      roomSeed: seed,
      timeoutMs: TEST_TIMEOUT_MS,
      ...(scripts.length > 0 ? { scripts } : {}),
    });
    const dispose = (): void => runtime.dispose();
    // 1) 样本卡：显式 actorCardId → 包内卡；缺省 → 第一张包卡；都没有 → 合成卡
    const cards = Array.isArray(pack.cards) ? pack.cards : [];
    const wanted = request.actorCardId;
    const rawActor = wanted !== undefined ? cards.find((card) => (card as { cardId?: unknown }).cardId === wanted) : cards[0];
    let actorCard: CardInstance | undefined;
    if (rawActor !== undefined) {
      const converted = packCardInstance(rules, rawActor);
      if (converted.card !== undefined) actorCard = converted.card;
      else warnings.push(`样本卡「${wanted ?? '包内第一张卡'}」不可用（${converted.error}），已改用合成样本卡`);
    } else if (wanted !== undefined) {
      warnings.push(`包内没有 cardId=${wanted} 的角色卡，已改用合成样本卡`);
    }
    if (actorCard === undefined) actorCard = syntheticCard(rules, `test-actor-${index}`, '试跑角色');
    const actorId = actorCard.cardId;
    const added = runtime.addActor({ card: actorCard, actorId, name: actorCard.cardId, team: 'player' });
    if (!added.ok) {
      dispose();
      throw new RoomError(
        'bad-request',
        `样本卡无法进入规则运行时：${added.error?.messageZh ?? '未知错误'}${added.error?.hint !== undefined ? `（${added.error.hint}）` : ''}`,
      );
    }
    warnings.push(...added.validation);
    // 2) 目标：显式 targetId → 包内卡；动作/显式目标缺省 → 合成敌方假人
    let targetCard: CardInstance | undefined;
    if (request.targetId !== undefined) {
      const rawTarget = cards.find((card) => (card as { cardId?: unknown }).cardId === request.targetId);
      if (rawTarget !== undefined) {
        const converted = packCardInstance(rules, rawTarget);
        if (converted.card !== undefined && converted.card.cardId !== actorId) targetCard = converted.card;
        else if (converted.error !== undefined) warnings.push(`目标卡「${request.targetId}」不可用（${converted.error}），已改用合成假人`);
      } else {
        warnings.push(`包内没有 cardId=${request.targetId} 的目标卡，已改用合成假人`);
      }
    }
    if (targetCard === undefined && (request.kind === 'action' || request.targetId !== undefined)) {
      targetCard = syntheticCard(rules, 'test-dummy', '训练假人');
    }
    let targetId: string | undefined;
    if (targetCard !== undefined) {
      const targetAdded = runtime.addActor({ card: targetCard, actorId: targetCard.cardId, name: '训练假人', team: 'enemy' });
      if (!targetAdded.ok) {
        dispose();
        throw new RoomError('bad-request', `目标卡无法进入规则运行时：${targetAdded.error?.messageZh ?? '未知错误'}`);
      }
      targetId = targetCard.cardId;
    }
    return { runtime, actorId, ...(targetId !== undefined ? { targetId } : {}), warnings, dispose };
  }

  /** 对已准备好的临时运行时执行一条请求（rolls/trace/result 全部取自运行时返回值）。 */
  private execute(prepared: PreparedRun, request: RulesTestRequest, index: number, label: string, started: number, events: RuntimeEvent[]): RulesTestOutcome {
    const { runtime, actorId } = prepared;
    let outcome: RulesTestOutcome;
    if (request.kind === 'derived') {
      const derived = runtime.getDerived(actorId);
      if (!derived.ok) return this.failureOutcome(index, request, label, started, derived.error);
      const data = plainJson(derived.derived ?? {});
      outcome = {
        index,
        kind: request.kind,
        label,
        ok: true,
        rolls: [],
        trace: {
          lines: Object.entries(data).map(([key, value]) => `${key} = ${String(value)}`),
          data: { derived: data },
        },
        result: plainJson({ actorId, derived: data }) as unknown as Record<string, unknown>,
        durationMs: Math.max(0, this.now() - started),
      };
    } else if (request.kind === 'check') {
      const checked = runtime.rollCheck({
        actorId,
        kind: request.skillId !== undefined ? 'skill' : request.attributeId !== undefined ? 'attribute' : 'custom',
        ...(request.skillId !== undefined ? { skillId: request.skillId } : {}),
        ...(request.attributeId !== undefined ? { attributeId: request.attributeId } : {}),
        ...(request.targetId !== undefined && prepared.targetId !== undefined ? { targetId: prepared.targetId } : {}),
        ...(request.dc !== undefined ? { dc: request.dc } : {}),
        ...(request.mode !== undefined ? { mode: request.mode } : {}),
        ...(request.mods !== undefined ? { mods: request.mods } : {}),
        reason: '规则测试台试跑',
      });
      if (!checked.ok) return this.failureOutcome(index, request, label, started, checked.error);
      outcome = {
        index,
        kind: request.kind,
        label,
        ok: true,
        rolls: (checked.rolls ?? []).map((roll) => ({ ...roll, dice: [...roll.dice] })),
        trace: { lines: [...(checked.trace?.lines ?? [])], data: plainJson(checked.trace?.data ?? {}) },
        result: plainJson(checked) as unknown as Record<string, unknown>,
        durationMs: Math.max(0, this.now() - started),
      };
    } else {
      const used = runtime.useAction({
        actorId,
        actionId: request.actionId ?? '',
        ...(prepared.targetId !== undefined ? { targetId: prepared.targetId } : {}),
        options: {
          ...(request.dc !== undefined ? { dc: request.dc } : {}),
          ...(request.mods !== undefined ? { mods: request.mods } : {}),
          ...(request.mode !== undefined ? { mode: request.mode } : {}),
          ...(request.skillId !== undefined ? { skillId: request.skillId } : {}),
        },
      });
      if (!used.ok) return this.failureOutcome(index, request, label, started, used.error);
      outcome = {
        index,
        kind: request.kind,
        label,
        ok: true,
        rolls: (used.rolls ?? []).map((roll) => ({ ...roll, dice: [...roll.dice] })),
        trace: { lines: [...(used.trace?.lines ?? [])], data: plainJson(used.trace?.data ?? {}) },
        result: plainJson(used) as unknown as Record<string, unknown>,
        durationMs: Math.max(0, this.now() - started),
      };
    }
    // 脚本钩子错误（抛错/超时/返回值非法）：运行时已退回缺省行为，这里转成可读错误 + trace 提示
    const hookErrors = events.map(hookErrorOf).filter((entryValue) => entryValue !== null);
    if (hookErrors.length > 0) {
      outcome.ok = false;
      outcome.error = hookErrors[0] ?? outcome.error;
    }
    const lines = [...outcome.trace.lines];
    for (const hookError of hookErrors) if (hookError !== null) lines.push(`⚠ ${hookError.messageZh}`);
    for (const warning of prepared.warnings) lines.push(`提示：${warning}`);
    outcome.trace = { lines, data: outcome.trace.data };
    return outcome;
  }

  private failureOutcome(
    index: number,
    request: RulesTestRequest,
    label: string,
    started: number,
    error: { code: string; messageZh: string; hint?: string } | undefined,
  ): RulesTestOutcome {
    return {
      index,
      kind: request.kind,
      label,
      ok: false,
      rolls: [],
      trace: { lines: [], data: {} },
      result: null,
      error: error ?? { code: 'runtime_error', messageZh: '运行时返回了失败但没有错误信息' },
      durationMs: Math.max(0, this.now() - started),
    };
  }

  /** 跑一条请求：准备 → 订阅事件 → 结算 → 收尾（临时运行时用完即释放）。 */
  private runOne(
    entry: PackEntry,
    rules: RulePack,
    pack: ContentPack,
    request: RulesTestRequest,
    index: number,
    seed: number,
    onEvent: (event: RuntimeEvent) => void,
  ): RulesTestOutcome {
    const started = this.now();
    const label = describeRequest(request);
    let prepared: PreparedRun;
    try {
      prepared = this.prepare(entry, rules, pack, request, index, seed);
    } catch (error) {
      return {
        index,
        kind: request.kind,
        label,
        ok: false,
        rolls: [],
        trace: { lines: [], data: {} },
        result: null,
        error: {
          code: error instanceof RoomError ? error.code : 'runtime_error',
          messageZh: error instanceof Error ? error.message : String(error),
        },
        durationMs: Math.max(0, this.now() - started),
      };
    }
    const events: RuntimeEvent[] = [];
    const stop = prepared.runtime.subscribe((event) => {
      events.push(event);
      onEvent(event);
    });
    try {
      return this.execute(prepared, request, index, label, started, events);
    } catch (error) {
      return this.failureOutcome(index, request, label, started, {
        code: error instanceof RoomError ? error.code : 'internal',
        messageZh: error instanceof Error ? error.message : String(error),
      });
    } finally {
      stop();
      prepared.dispose();
    }
  }

  /** `rules.test`：临时运行时逐条试跑（草稿可试跑未保存的规则修改）。 */
  test(params: RulesTestParams): RulesTestResult {
    const started = this.now();
    const resolved = this.resolvePack(params);
    const rules = resolved.pack.rules;
    const warnings = [...resolved.warnings];
    const errors: string[] = [];
    if (rules === undefined) {
      return {
        ok: false,
        packId: params.packId,
        rulesId: null,
        seed: 0,
        draft: resolved.draft,
        sampleActorId: null,
        sampleSource: null,
        events: [],
        outcomes: [],
        errors: ['该内容包没有 rules 段（纯叙事包）：规则测试台无内容可试跑'],
        warnings,
        durationMs: Math.max(0, this.now() - started),
      };
    }
    const scriptReport = checkRulesScripts(rules, resolved.entry);
    errors.push(...scriptReport.errors);
    warnings.push(...scriptReport.warnings);
    const seed = params.seed ?? deriveSeed(params.packId, rules.rulesId);
    if (errors.length > 0) {
      return {
        ok: false,
        packId: params.packId,
        rulesId: rules.rulesId,
        seed,
        draft: resolved.draft,
        sampleActorId: null,
        sampleSource: null,
        events: [],
        outcomes: [],
        errors,
        warnings,
        durationMs: Math.max(0, this.now() - started),
      };
    }
    const outcomes: RulesTestOutcome[] = [];
    const eventLines: string[] = [];
    for (let index = 0; index < params.requests.length; index += 1) {
      const request = params.requests[index];
      if (request === undefined) continue;
      const outcome = this.runOne(resolved.entry, rules, resolved.pack, request, index, seed, (event) => {
        if (eventLines.length < MAX_EVENT_LINES) eventLines.push(`[#${index}] ${eventLine(event)}`);
      });
      outcomes.push(outcome);
    }
    // 样本卡 id/来源：取第一条成功运行的 actorId（合成卡 id 以 test-actor 前缀标识）
    let sampleActorId: string | null = null;
    let sampleSource: 'pack' | 'synthetic' | null = null;
    for (const outcome of outcomes) {
      const resultActorId = outcome.result?.actorId;
      if (typeof resultActorId !== 'string') continue;
      sampleActorId = resultActorId;
      sampleSource = resultActorId.startsWith('test-actor') ? 'synthetic' : 'pack';
      break;
    }
    const result: RulesTestResult = {
      ok: errors.length === 0 && outcomes.every((outcome) => outcome.ok),
      packId: params.packId,
      rulesId: rules.rulesId,
      seed,
      draft: resolved.draft,
      sampleActorId,
      sampleSource,
      events: eventLines,
      outcomes,
      errors,
      warnings,
      durationMs: Math.max(0, this.now() - started),
    };
    this.log(`rules.test ${params.packId}${resolved.draft ? '（草稿）' : ''}: ${outcomes.length} 条，${result.ok ? 'ok' : '有失败'}`);
    return result;
  }
}

/** 请求 → 人话标题（测试台结果行）。 */
function describeRequest(request: RulesTestRequest): string {
  if (request.kind === 'derived') return `派生值（${request.actorCardId ?? '样本卡'}）`;
  if (request.kind === 'check') {
    const who =
      request.skillId !== undefined
        ? `技能 ${request.skillId}`
        : request.attributeId !== undefined
          ? `属性 ${request.attributeId}`
          : '自定义检定';
    const mode = request.mode !== undefined && request.mode !== 'normal' ? `（${request.mode === 'advantage' ? '优势' : '劣势'}）` : '';
    return `${who} DC ${request.dc ?? 10}${mode}`;
  }
  return `动作 ${request.actionId ?? '—'}${request.targetId !== undefined ? ` → ${request.targetId}` : ''}`;
}
