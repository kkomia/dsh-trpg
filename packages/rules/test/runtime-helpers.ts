/** M9.2 运行时测试共享工具：脚本构造（带真实 sha256）、卡工厂、事件收集。 */
import {
  CARD_SCHEMA_VERSION,
  MINIMAL_RULE_PACK,
  SAMPLE_CARD_AQING,
  SAMPLE_CARD_BAILU,
  createRuleRuntime,
  sha256Hex,
  type CardInstance,
  type HookName,
  type PositionState,
  type RulePack,
  type RuleRuntime,
  type RuntimeEvent,
  type RuntimeLogEntry,
  type SpawnSide,
} from '../src/index.ts';

export { SAMPLE_CARD_AQING, SAMPLE_CARD_BAILU };

export function clonePack(): RulePack {
  return structuredClone(MINIMAL_RULE_PACK);
}

export function withPack(mutate: (pack: RulePack) => void): RulePack {
  const pack = clonePack();
  mutate(pack);
  return pack;
}

export interface TestScript {
  file: string;
  code: string;
  sha256: string;
}

/** 构造一个内容真实、sha256 正确的脚本来源。 */
export function makeScript(fileName: string, code: string): TestScript {
  return { file: `rules/scripts/${fileName}`, code, sha256: sha256Hex(code) };
}

/** 在规则包 `scripts` 段声明 hooks → 同一个脚本文件（构建声明与传入脚本的一致性）。 */
export function attachScripts(pack: RulePack, script: TestScript, hooks: readonly HookName[]): RulePack {
  const scripts: NonNullable<RulePack['scripts']> = {};
  for (const hook of hooks) {
    (scripts as Record<string, { file: string; sha256: string }>)[hook] = { file: script.file, sha256: script.sha256 };
  }
  pack.scripts = scripts;
  return pack;
}

export interface CreateRuntimeOptions {
  rules?: RulePack;
  roomSeed?: number;
  scripts?: TestScript[];
  timeoutMs?: number;
  /** 收集日志（ctx.log / console / 内核日志）。 */
  logs?: RuntimeLogEntry[];
  maxHookCalls?: number;
  failureThreshold?: number;
}

export function createRuntime(options: CreateRuntimeOptions = {}): RuleRuntime {
  const logs = options.logs;
  return createRuleRuntime({
    rules: options.rules ?? clonePack(),
    roomSeed: options.roomSeed ?? 20261116,
    ...(options.scripts !== undefined ? { scripts: options.scripts } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxHookCalls !== undefined ? { maxHookCalls: options.maxHookCalls } : {}),
    ...(options.failureThreshold !== undefined ? { failureThreshold: options.failureThreshold } : {}),
    ...(logs !== undefined
      ? {
          log: (entry: RuntimeLogEntry) => {
            logs.push(entry);
          },
        }
      : {}),
  });
}

export interface MakeCardOptions {
  cardId: string;
  name?: string;
  str?: number;
  dex?: number;
  con?: number;
  level?: number;
  hp?: number;
  hpMax?: number;
}

/** 构造一张合法的最小 d20 卡（数值可调）。 */
export function makeCard(options: MakeCardOptions): CardInstance {
  const name = options.name ?? options.cardId;
  return {
    schemaVersion: CARD_SCHEMA_VERSION,
    cardId: options.cardId,
    rulesId: MINIMAL_RULE_PACK.rulesId,
    rulesVersion: MINIMAL_RULE_PACK.rulesVersion,
    attributes: { str: options.str ?? 10, dex: options.dex ?? 10, con: options.con ?? 10 },
    resources: { hp: { current: options.hp ?? 20, max: options.hpMax ?? 20 } },
    fields: { name, level: options.level ?? 1 },
    equipmentInstances: [],
    skills: [],
    statuses: [],
  };
}

export interface AddActorOptions {
  team?: SpawnSide;
  position?: PositionState;
}

/** addActor 并断言成功（测试辅助，失败直接抛中文错误）。 */
export function addActor(rt: RuleRuntime, card: CardInstance, options: AddActorOptions = {}) {
  const result = rt.addActor({
    card,
    ...(options.team !== undefined ? { team: options.team } : {}),
    ...(options.position !== undefined ? { position: options.position } : {}),
  });
  if (!result.ok) throw new Error(`addActor 失败：${result.error.messageZh}`);
  return result.actor;
}

/** 建立两名角色（玩家/敌人）并开战，返回行动者/目标（含确定性先攻顺序）。 */
export function setupDuel(options: CreateRuntimeOptions & { attackerPosition?: PositionState; defenderPosition?: PositionState } = {}) {
  const runtime = createRuntime(options);
  const attackerCard = makeCard({ cardId: 'card_hero', name: '阿青', str: 17, dex: 14, con: 15, hp: 20, hpMax: 20 });
  const defenderCard = makeCard({ cardId: 'card_foe', name: '血尸', str: 14, dex: 12, con: 12, hp: 18, hpMax: 18 });
  addActor(runtime, attackerCard, {
    team: 'player',
    position: options.attackerPosition ?? { zoneId: 'cave', cell: { x: 1, y: 3 } },
  });
  addActor(runtime, defenderCard, {
    team: 'enemy',
    position: options.defenderPosition ?? { zoneId: 'cave', cell: { x: 2, y: 3 } },
  });
  const started = runtime.startCombat({ reason: '测试' });
  if (!started.ok) throw new Error(`startCombat 失败：${started.error.messageZh}`);
  const view = started.view;
  const activeId = view.activeActorId;
  if (activeId === null) throw new Error('战斗没有当前行动者');
  const activeIsHero = activeId === 'card_hero';
  return {
    runtime,
    attacker: { actorId: 'card_hero', name: '阿青', card: attackerCard },
    defender: { actorId: 'card_foe', name: '血尸', card: defenderCard },
    activeId,
    otherId: activeIsHero ? 'card_foe' : 'card_hero',
    view,
    started,
  };
}

export interface EventCollector {
  events: RuntimeEvent[];
  kinds(): string[];
  of(kind: string): RuntimeEvent[];
  clear(): void;
}

/** 订阅事件流做断言用。 */
export function collectEvents(runtime: RuleRuntime): EventCollector {
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return {
    events,
    kinds: () => events.map((event) => event.kind),
    of: (kind) => events.filter((event) => event.kind === kind),
    clear: () => {
      events.length = 0;
    },
  };
}

/** 断言一次 RuleResult 成功并取数据（类型收窄辅助）。 */
export function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`预期成功，实际失败：${JSON.stringify((result as unknown as { error?: unknown }).error)}`);
  return result as Extract<T, { ok: true }>;
}

/** 断言一次 RuleResult 失败并返回错误信息。 */
export function expectErr<T extends { ok: boolean }>(result: T): { code: string; messageZh: string } {
  if (result.ok) throw new Error('预期失败，实际成功');
  return (result as unknown as { error: { code: string; messageZh: string } }).error;
}

/** 当前 HP（约定资源 id=hp）。 */
export function hpOf(rt: RuleRuntime, actorId: string): number {
  const actor = expectOk(rt.getActor(actorId)).actor;
  return actor.card.resources.hp?.current ?? 0;
}
