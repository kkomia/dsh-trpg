/**
 * GM 工具集：AI 只能通过这里请求结算。每个工具都绑定到一个房间与房间服务，
 * 返回值是给模型看的结构化文本，副作用（骰子/私密消息/战斗）直接落进房间事件流。
 *
 * M8.4：
 * - 有规则运行时的房间额外注册通用工具（RULES-MODEL §7.1）：
 *   `use_action` / `move` / `combat` / 泛化的 `roll_check`；它们全部走
 *   `RoomService` 的运行命令，并把返回值里的 `rolls` / `trace` / 战斗视图作为
 *   **唯一叙事数值来源**（AI 不得自算）。
 * - 无规则运行时的房间保留旧工具（`start_combat` / `attack` / `next_turn` /
 *   `combat_status` / `end_combat`）与旧引擎检定，行为兼容；同名 `roll_check`
 *   按「有运行时走通用、无运行时走旧引擎」双路由，避免工具名冲突。
 * - 旧名在规则房间保留为别名（内部等价映射到通用工具），AI 习惯的调用不会断。
 * - 模组数据消费：`scene`（查看/推进场景）、`reward`（复用 gmAward）、
 *   `combat({action:'start', encounterId})`（按模组遭遇展开怪物并覆盖 maxRounds/battleMapId）。
 */
import { SKILL_ABILITY, SKILL_NAME, type SkillId } from '@dsh-trpg/engine';
import { MONSTERS, type LorebookDef, type ModuleDef } from '@dsh-trpg/content';
import type {
  ActionOutcomeView,
  CheckView,
  CombatView,
  DiceRollView,
  MoveOutcomeView,
  PlayerId,
} from '@dsh-trpg/protocol';
import type { Principal, RoomService } from '@dsh-trpg/rooms';
import type { CombatRuntime } from './combat.ts';
import {
  currentSceneIndex,
  findEncounterInModule,
  findSceneIndex,
  formatSceneData,
  sceneDataOf,
  type SceneDataView,
  type SceneEncounterView,
  type ToolNameMap,
} from './prompt.ts';
import { noteRevealedLore } from './lore-reveal.ts';

export interface GmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: Record<string, unknown>, value: { text: string }) => Array<{ type: 'text'; text: string }>;
  };
  timeoutMs?: number;
  execute: (args: Record<string, unknown>) => Promise<{ text: string }> | { text: string };
}

export interface GmToolsOptions {
  roomService: RoomService;
  /** 固定房间 id，或解析器（subagent 模式按 childId 动态解析）。 */
  roomId: string | (() => string);
  /** 世界书：固定对象，或按房间解析（不同房间可能引用不同内容包）。 */
  lorebook: LorebookDef | (() => LorebookDef);
  /** 旧战斗运行时（无规则运行时的房间用）。 */
  combat?: CombatRuntime | (() => CombatRuntime | undefined);
  /** 当前房间模组（scene/reward/encounter 数据消费；缺省这些工具报中文错误）。 */
  module?: ModuleDef | (() => ModuleDef | undefined);
  /**
   * 是否注册通用规则工具（use_action/move/combat）。
   * 缺省 = 按创建时的房间自动判断（有规则运行时才注册）。
   */
  includeGenericTools?: boolean;
  /** 工具名映射（table-session 的 trpg_ 前缀 / subagent 的世代后缀）；可延后读取。 */
  toolNames?: ToolNameMap | (() => ToolNameMap);
}

/** 房间规则运行时（从 RoomService 公开签名推导，避免对外暴露 rules 包类型）。 */
type RoomRuntime = NonNullable<ReturnType<RoomService['runtimeOf']>>;

const SKILL_IDS = Object.keys(SKILL_ABILITY) as SkillId[];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function findPlayer(roomService: RoomService, roomId: string, playerName: string) {
  const party = roomService.gmParty(roomId);
  const normalized = playerName.trim();
  const player = party.find(
    (entry) => entry.name === normalized || entry.character?.identity.name === normalized || entry.playerId === normalized,
  );
  if (!player) throw new Error(`找不到玩家「${playerName}」，当前队伍：${party.map((entry) => entry.name).join('、')}`);
  return player;
}

/** GM 工具走房主身份（服务端受信任编排面；所有命令由 host 结算）。 */
function hostPrincipal(roomId: string): Principal {
  return { kind: 'host', roomId };
}

/** 骰面 → 一行文本（叙事数值只能来自这里）。 */
export function formatRolls(rolls: readonly DiceRollView[]): string {
  return rolls
    .map((roll) => `${roll.expression}=[${roll.dice.join(', ')}]${roll.modifier !== 0 ? `${roll.modifier > 0 ? '+' : ''}${roll.modifier}` : ''}=${roll.total}`)
    .join('；');
}

/** trace → 文本行（规则运行时的判定链是权威解释）。 */
function formatTrace(trace: { lines: readonly string[] } | undefined): string {
  if (trace === undefined || trace.lines.length === 0) return '';
  return trace.lines.slice(0, 8).join(' → ');
}

function degreeLabel(check: CheckView): string {
  if (check.degree === 'crit') return '暴击成功';
  if (check.degree === 'fumble') return '大失败';
  return check.success ? '成功' : '失败';
}

function checkKindLabel(check: CheckView): string {
  if (check.kind === 'skill' && check.skillId !== undefined) return `技能「${check.skillId}」`;
  if (check.kind === 'attribute' && check.attributeId !== undefined) return `属性「${check.attributeId}」`;
  if (check.kind === 'save') return '豁免';
  return check.kind;
}

/** 检定结果 → 文本（d20/加值/总值/DC/成败 + trace + 骰面）。 */
export function formatCheckResult(check: CheckView, subject?: string): string {
  const lines = [
    `${subject !== undefined ? `${subject} 的` : ''}${checkKindLabel(check)}检定：d20=${check.d20 ?? '?'} + ${check.modifier} = ${check.total} vs DC ${check.dc} → ${degreeLabel(check)}`,
  ];
  const trace = formatTrace(check.trace);
  if (trace.length > 0) lines.push(`判定链：${trace}`);
  if (check.rolls.length > 0) lines.push(`骰面：${formatRolls(check.rolls)}`);
  return lines.join('\n');
}

function turnText(turn: Record<string, number>): string {
  const entries = Object.entries(turn);
  if (entries.length === 0) return '';
  return entries.map(([id, value]) => `${id} ${value}`).join('，');
}

/** 动作结算结果 → 文本（命中/伤害/检定/行动经济只取自返回值）。 */
export function formatActionOutcome(action: ActionOutcomeView, subject?: string): string {
  const lines: string[] = [];
  const head: string[] = [`${subject !== undefined ? `${subject} 使用` : '使用'}「${action.actionName}」（${action.actionId}）`];
  if (action.hit !== undefined) head.push(action.hit ? (action.crit === true ? '暴击命中' : '命中') : '未命中');
  if (action.check !== undefined) {
    head.push(`检定 d20=${action.check.d20 ?? '?'} + ${action.check.modifier} = ${action.check.total} vs DC ${action.check.dc} → ${degreeLabel(action.check)}`);
  }
  lines.push(head.join('，'));
  if (action.damage !== undefined) {
    lines.push(
      `伤害 ${action.damage.amount}（HP ${action.damage.hpBefore}→${action.damage.hpAfter}${action.damage.dead ? '，已倒下' : ''}${action.damage.absorbedByTempHp > 0 ? `；护盾吸收 ${action.damage.absorbedByTempHp}` : ''}）`,
    );
  }
  const trace = formatTrace(action.trace);
  if (trace.length > 0) lines.push(`判定链：${trace}`);
  if (action.rolls.length > 0) lines.push(`骰面：${formatRolls(action.rolls)}`);
  const turn = turnText(action.turn);
  if (turn.length > 0) lines.push(`剩余行动：${turn}`);
  if (action.autoEndedTurn) lines.push('（回合已自动结束）');
  return lines.join('\n');
}

/** 移动结果 → 文本。 */
export function formatMoveOutcome(move: MoveOutcomeView): string {
  const from = move.from.cell !== undefined ? `(${move.from.cell.x},${move.from.cell.y})` : (move.from.zoneId ?? '?');
  const to = move.to.cell !== undefined ? `(${move.to.cell.x},${move.to.cell.y})` : (move.to.zoneId ?? '?');
  const lines = [`移动：${from} → ${to}，消耗 ${move.cost}${move.remaining !== null ? `，剩余移动 ${move.remaining}` : ''}`];
  const trace = formatTrace(move.trace);
  if (trace.length > 0) lines.push(`判定链：${trace}`);
  return lines.join('\n');
}

/** 战斗视图 → 紧凑文本（轮次/先攻/当前行动者/HP/回合上限）。 */
export function formatCombatView(combat: CombatView): string {
  const parts: string[] = [];
  if (!combat.active) {
    parts.push('当前没有进行中的战斗');
  } else {
    parts.push(`第 ${combat.round} 轮${combat.maxRounds > 0 ? `/${combat.maxRounds}（回合上限）` : ''}`);
  }
  if (combat.initiative.length > 0) {
    parts.push(
      `先攻：${combat.initiative.map((entry) => `${entry.name}(${entry.initiative}${entry.dead ? '，已倒下' : ''})`).join(' → ')}`,
    );
  }
  const active = combat.activeActorId === null ? undefined : combat.initiative.find((entry) => entry.actorId === combat.activeActorId);
  if (active !== undefined) parts.push(`当前行动者：${active.name}`);
  const hp = combat.tokens
    .filter((token) => token.hp !== undefined)
    .map((token) => `${token.name} ${token.dead ? '倒下' : `${token.hp?.current ?? '?'}${token.hp?.max !== undefined ? `/${token.hp.max}` : ''}`}`)
    .join('；');
  if (hp.length > 0) parts.push(`HP：${hp}`);
  if (combat.endedReason !== undefined) parts.push(`结束原因：${combat.endedReason}`);
  if (combat.warnings !== undefined && combat.warnings.length > 0) parts.push(`提示：${combat.warnings.slice(0, 2).join('；')}`);
  return parts.join('；');
}

/** 旧怪物串（`shanxiao*2,xueshi*1`）→ 敌方行动者名字列表（含中文名）。 */
function parseMonsterSpec(spec: string): string[] {
  const byId = new Map(MONSTERS.map((monster) => [monster.id, monster]));
  const names: string[] = [];
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [rawId, rawCount] = trimmed.split('*');
    const id = (rawId ?? '').trim();
    const monster = byId.get(id);
    if (!monster) throw new Error(`未知怪物 id：${id}；可用：${[...byId.keys()].join('、')}`);
    const parsed = Number.parseInt((rawCount ?? '1').trim(), 10);
    const count = Number.isInteger(parsed) && parsed > 0 && parsed <= 6 ? parsed : 1;
    for (let index = 0; index < count; index += 1) names.push(monster.name);
  }
  return names;
}

/** 模组遭遇 → 敌方行动者名字列表（怪物 id 换中文名；规则运行时按规则包生成杂兵卡）。 */
function encounterEnemyNames(encounter: SceneEncounterView): string[] {
  const names: string[] = [];
  for (const group of encounter.monsters) {
    const display = MONSTERS.find((monster) => monster.id === group.monsterId)?.name ?? group.monsterId;
    const count = Number.isInteger(group.count) && group.count > 0 ? group.count : 1;
    for (let index = 0; index < count; index += 1) names.push(display);
  }
  return names;
}

function sceneListText(module: ModuleDef): string {
  return module.scenes.map((scene, index) => `${index} ${scene.title}（${scene.id}）`).join('；');
}

export function createGmTools(options: GmToolsOptions): GmToolDefinition[] {
  const { roomService } = options;
  const combat = options.combat;
  const roomOf = (): string => (typeof options.roomId === 'string' ? options.roomId : options.roomId());
  const lorebookOf = (): LorebookDef => (typeof options.lorebook === 'function' ? options.lorebook() : options.lorebook);
  const combatOf = (): CombatRuntime | undefined => (typeof combat === 'function' ? combat() : combat);
  const moduleOf = (): ModuleDef | undefined => (typeof options.module === 'function' ? options.module() : options.module);
  const toolNamesOf = (): ToolNameMap => {
    if (options.toolNames === undefined) return {};
    return typeof options.toolNames === 'function' ? options.toolNames() : options.toolNames;
  };
  const nameOf = (name: string): string => toolNamesOf()[name] ?? name;
  const runtimeOf = (): RoomRuntime | undefined => {
    try {
      return roomService.runtimeOf(roomOf());
    } catch {
      return undefined;
    }
  };
  const includeGenericTools =
    options.includeGenericTools ?? (() => {
      try {
        return roomService.runtimeOf(roomOf()) !== undefined;
      } catch {
        return false;
      }
    })();
  const render = (_args: Record<string, unknown>, value: { text: string }) => [{ type: 'text' as const, text: value.text }];
  const output = { schema: { type: 'object' }, render };

  function requireModule(): ModuleDef {
    const module = moduleOf();
    if (module === undefined) throw new Error('这个 GM 工具需要模组内容，但当前房间没有解析到模组');
    return module;
  }

  function requireRuntime(): RoomRuntime {
    const runtime = runtimeOf();
    if (runtime === undefined) {
      throw new Error('本房间没有规则运行时（内容包未带 rules 段）：通用规则工具不可用，请用旧工具或纯叙事处理');
    }
    return runtime;
  }

  /** 当前场景下标（房间 gmScene 推进过就按房间场景，否则第一幕）。 */
  function currentSceneFor(module: ModuleDef): number {
    let sceneId: string | undefined;
    try {
      sceneId = roomService.gmView(roomOf()).scene?.sceneId;
    } catch {
      sceneId = undefined;
    }
    return currentSceneIndex(module, sceneId);
  }

  function requireScene(module: ModuleDef, sceneIndex: number): SceneDataView {
    const scene = sceneDataOf(module, sceneIndex);
    if (scene === undefined) {
      throw new Error(`模组没有第 ${sceneIndex} 幕（共 ${module.scenes.length} 幕）；可用场景：${sceneListText(module)}`);
    }
    return scene;
  }

  function resolveActorId(runtime: RoomRuntime, reference: string, label: string): string {
    const normalized = reference.trim();
    const actors = runtime.listActors();
    const roster = actors.map((actor) => `${actor.name}(${actor.actorId})`).join('、') || '无';
    if (normalized.length === 0) throw new Error(`缺少 ${label}：请指定行动者；在场：${roster}`);
    const byId = actors.find((actor) => actor.actorId === normalized);
    if (byId !== undefined) return byId.actorId;
    const byName = actors.find((actor) => actor.name === normalized);
    if (byName !== undefined) return byName.actorId;
    throw new Error(`找不到${label}「${reference}」；在场：${roster}`);
  }

  function actorNameOf(runtime: RoomRuntime, actorId: string): string | undefined {
    return runtime.listActors().find((actor) => actor.actorId === actorId)?.name;
  }

  function requireActorReference(args: Record<string, unknown>, label = 'actorId'): string {
    const reference = optionalString(args, 'actorId') ?? optionalString(args, 'playerName');
    if (reference === undefined) throw new Error(`缺少 ${label}：请指定行动者（actorId 或在场名字）`);
    return reference;
  }

  // -------------------------------------------------------------------------
  // 通用规则工具（有规则运行时才有意义；无运行时给出可读错误）
  // -------------------------------------------------------------------------

  function startCombatTool(args: {
    monsters?: string;
    encounterId?: string;
    maxRounds?: number;
    battleMapId?: string;
    reason?: string;
  }): { text: string } {
    const runtime = requireRuntime();
    const roomId = roomOf();
    let enemyNames: string[] = [];
    let encounter: SceneEncounterView | undefined;
    let encounterScene: SceneDataView | undefined;
    if (args.encounterId !== undefined) {
      const module = requireModule();
      const found = findEncounterInModule(module, args.encounterId);
      if (found === undefined) {
        const known = module.scenes.flatMap((scene) => (scene.encounters ?? []).map((entry) => entry.id));
        throw new Error(`模组里没有遭遇「${args.encounterId}」；可用遭遇：${known.join('、') || '无'}`);
      }
      encounter = found.encounter;
      encounterScene = found.scene;
      enemyNames = encounterEnemyNames(encounter);
    } else if (args.monsters !== undefined) {
      enemyNames = parseMonsterSpec(args.monsters);
    } else {
      throw new Error('开战需要 encounterId（按模组遭遇展开）或 monsters（如 "shanxiao*2,xueshi*1"）');
    }
    if (enemyNames.length === 0) throw new Error('这场遭遇没有可上场的怪物');
    const maxRounds = args.maxRounds ?? encounter?.maxRounds;
    if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || maxRounds <= 0)) {
      throw new Error(`maxRounds 必须是正整数（收到 ${String(maxRounds)}）`);
    }
    const wantedMap = args.battleMapId ?? encounter?.battleMapId;
    const maps = (runtime.rules.space?.battleMaps ?? []).map((map) => map.mapId);
    const mapId = wantedMap !== undefined && maps.includes(wantedMap) ? wantedMap : undefined;
    const notes: string[] = [];
    if (wantedMap !== undefined && mapId === undefined) {
      notes.push(`本房间规则包没有战斗地图「${wantedMap}」，本场按 theater-of-mind 结算（battleMapId 覆盖未生效）`);
    }
    const result = roomService.startCombat(hostPrincipal(roomId), {
      enemies: enemyNames.map((name) => ({ name })),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(mapId !== undefined ? { mapId } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    });
    const lines = [`战斗开始（遭遇${encounterScene !== undefined ? `：${encounterScene.title}` : ''}；敌人：${enemyNames.join('、')}）。${formatCombatView(result.combat)}`];
    if (result.rolls.length > 0) lines.push(`先攻骰：${formatRolls(result.rolls)}`);
    if (maxRounds !== undefined) lines.push(`本场回合上限 maxRounds=${maxRounds}${encounter?.maxRounds !== undefined && args.maxRounds === undefined ? '（取自模组遭遇）' : ''}`);
    for (const note of notes) lines.push(`提示：${note}`);
    return { text: lines.join('\n') };
  }

  function startLegacyCombat(args: { monsters: string }): { text: string } {
    const currentCombat = combatOf();
    if (!currentCombat) throw new Error('战斗系统未初始化');
    const { text } = currentCombat.start(args.monsters);
    return { text };
  }

  /** 旧名 attack 在规则房间 = 通用动作（优先同名/kind=attack 的动作）。 */
  function attackViaRuntime(args: { attacker: string; target: string; attackName?: string }): { text: string } {
    const runtime = requireRuntime();
    const actions = runtime.rules.actions ?? [];
    let actionId: string;
    if (args.attackName !== undefined) {
      const matched = actions.find((action) => action.actionId === args.attackName);
      if (matched === undefined) {
        throw new Error(`规则包没有动作「${args.attackName}」；可用动作：${actions.map((action) => action.actionId).join('、') || '无'}`);
      }
      actionId = matched.actionId;
    } else {
      const attack = actions.find((action) => action.kind === 'attack');
      if (attack === undefined) throw new Error('规则包没有 kind=attack 的动作；请用 use_action 指定 actionId');
      actionId = attack.actionId;
    }
    const actorId = resolveActorId(runtime, args.attacker, '攻击者');
    const targetId = resolveActorId(runtime, args.target, '目标');
    const result = roomService.useAction(hostPrincipal(roomOf()), { actionId, actorId, targetId });
    return { text: `${formatActionOutcome(result.action, actorNameOf(runtime, actorId))}\n${formatCombatView(result.combat)}` };
  }

  // -------------------------------------------------------------------------
  // 工具集
  // -------------------------------------------------------------------------

  const tools: GmToolDefinition[] = [
    {
      name: 'roll_check',
      description:
        '做技能/属性/豁免检定：引擎掷骰并返回骰面、总值、DC 与成败。需要判定玩家行动时调用，不要在叙事里自己编骰子。有规则运行时用 actorId + kind/skill + dc（走规则运行时，trace 为权威）；无规则运行时用 playerName + skill + dc（旧引擎检定）。',
      parameters: {
        type: 'object',
        properties: {
          playerName: { type: 'string', description: '玩家名或角色名（无规则运行时的旧参数）' },
          actorId: { type: 'string', description: '行动者 actorId 或在场名字（有规则运行时）' },
          skill: { type: 'string', description: '技能 id（如 perception；有规则运行时也可用 skillId）' },
          kind: { type: 'string', description: '检定类型：attribute/skill/save/opposed/custom（规则包定义）' },
          attributeId: { type: 'string', description: '属性 id（kind=attribute 时）' },
          dc: { type: 'integer', minimum: 0, maximum: 60, description: '难度 DC（缺省 10）' },
          reason: { type: 'string', description: '这次检定的原因（中文短语）' },
          mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: '掷骰模式' },
          private: { type: 'boolean', description: '旧路径：true = 暗骰，只把骰面告诉该玩家与 GM' },
        },
        required: ['dc'],
      },
      output,
      async execute(args) {
        const runtime = runtimeOf();
        if (runtime !== undefined) {
          const actorReference = requireActorReference(args);
          const actorId = resolveActorId(runtime, actorReference, '行动者');
          const skillId = optionalString(args, 'skill') ?? optionalString(args, 'skillId');
          const attributeId = optionalString(args, 'attributeId');
          const kind = optionalString(args, 'kind') ?? (skillId !== undefined ? 'skill' : attributeId !== undefined ? 'attribute' : undefined);
          const dc = optionalNumber(args, 'dc');
          if (dc !== undefined && (!Number.isInteger(dc) || dc < 0 || dc > 60)) {
            throw new Error(`DC 必须是 0–60 的整数（收到 ${String(dc)}）`);
          }
          const mode = optionalString(args, 'mode');
          if (mode !== undefined && mode !== 'normal' && mode !== 'advantage' && mode !== 'disadvantage') {
            throw new Error(`mode 只能是 normal/advantage/disadvantage（收到 ${mode}）`);
          }
          const result = roomService.rollCheck(hostPrincipal(roomOf()), {
            actorId,
            ...(skillId !== undefined ? { skillId } : {}),
            ...(attributeId !== undefined ? { attributeId } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(dc !== undefined ? { dc } : {}),
            ...(optionalString(args, 'reason') !== undefined ? { reason: optionalString(args, 'reason') as string } : {}),
            ...(mode !== undefined ? { mode: mode as 'normal' | 'advantage' | 'disadvantage' } : {}),
          });
          return { text: formatCheckResult(result.check, actorNameOf(runtime, actorId)) };
        }
        const player = findPlayer(roomService, roomOf(), String(args.playerName ?? ''));
        if (!player.character) throw new Error(`${player.name} 还没有角色卡，先让玩家落座`);
        const skill = String(args.skill ?? '') as SkillId;
        if (!SKILL_IDS.includes(skill)) throw new Error(`未知技能：${skill}`);
        const dc = Number(args.dc);
        if (!Number.isInteger(dc) || dc < 5 || dc > 30) throw new Error(`DC 必须是 5–30 的整数（收到 ${String(args.dc)}）`);
        const event = roomService.gmCheck(roomOf(), {
          playerId: player.playerId,
          skill,
          dc,
          label: typeof args.reason === 'string' ? args.reason : undefined,
          private: args.private === true,
        });
        const payload = event.payload;
        const outcome = payload.check?.success ? '成功' : '失败';
        return {
          text: `${player.character.identity.name} 的${SKILL_NAME[skill]}检定：d20=[${payload.dice.join(', ')}] + ${payload.modifier} = ${payload.total} vs DC ${dc} → ${outcome}${args.private === true ? '（暗骰）' : ''}`,
        };
      },
    },
    {
      name: 'roll_dice',
      description: '自由掷骰（伤害骰、随机表等）。引擎用房间种子掷骰并把结果广播给全桌。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '骰子表达式，如 2d6+3、1d8、d20' },
          label: { type: 'string', description: '这次掷骰的用途（中文）' },
        },
        required: ['expression'],
      },
      output,
      execute(args) {
        const event = roomService.gmRoll(roomOf(), {
          expression: String(args.expression ?? ''),
          label: typeof args.label === 'string' ? args.label : undefined,
        });
        const payload = event.payload;
        return { text: `${payload.expression} = [${payload.dice.join(', ')}]${payload.modifier ? ` + ${payload.modifier}` : ''} = ${payload.total}` };
      },
    },
    {
      name: 'secret_note',
      description: '给某位玩家发一条只有他自己（和 GM）能看到的私密信息。',
      parameters: {
        type: 'object',
        properties: {
          playerName: { type: 'string', description: '玩家名或角色名' },
          text: { type: 'string', description: '私密内容（中文）' },
        },
        required: ['playerName', 'text'],
      },
      output,
      execute(args) {
        const player = findPlayer(roomService, roomOf(), String(args.playerName ?? ''));
        roomService.gmSecret(roomOf(), player.playerId, String(args.text ?? ''));
        return { text: `已私发 ${player.name}：${String(args.text ?? '')}` };
      },
    },
    {
      name: 'reveal_lore',
      description: '把世界书里的一条内容揭示给全桌（进入公共叙事）。用于玩家调查成功、线索被发现时。',
      parameters: {
        type: 'object',
        properties: {
          entryId: { type: 'string', description: '世界书条目 id，例如 entry_guimuya' },
        },
        required: ['entryId'],
      },
      output,
      execute(args) {
        const lorebook = lorebookOf();
        const entryId = String(args.entryId ?? '');
        const entry = lorebook.entries.find((item) => item.id === entryId);
        if (!entry) throw new Error(`世界书没有条目：${entryId}；可用条目：${lorebook.entries.map((item) => item.id).join('、')}`);
        roomService.gmNarrate(roomOf(), entry.content);
        noteRevealedLore(roomOf(), entry.id);
        return { text: `已揭示「${entry.title ?? entry.id}」：${entry.content}` };
      },
    },
    {
      name: 'check_lore',
      description: '按关键词搜世界书（含 GM 秘密），返回最相关的至多 5 条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词' },
        },
        required: ['query'],
      },
      output,
      execute(args) {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('query 不能为空');
        const lorebook = lorebookOf();
        const matches = lorebook.entries
          .filter(
            (entry) =>
              entry.id.includes(query) ||
              (entry.title ?? '').includes(query) ||
              entry.content.includes(query) ||
              entry.keys.some((key) => key.includes(query)),
          )
          .slice(0, 5);
        if (matches.length === 0) return { text: `没有匹配「${query}」的世界书条目` };
        return {
          text: matches
            .map((entry) => `〔${entry.visibility === 'gm' ? 'GM秘密' : entry.visibility === 'public' ? '公开' : '限人'}〕${entry.title ?? entry.id}：${entry.content}`)
            .join('\n'),
        };
      },
    },
    {
      name: 'list_party',
      description: '查看当前队伍的角色卡摘要（职业、等级、HP、AC、技能、已知法术）。',
      parameters: { type: 'object', properties: {}, required: [] },
      output,
      execute() {
        const party = roomService.gmParty(roomOf());
        if (party.length === 0) return { text: '还没有玩家落座' };
        return {
          text: party
            .map((player) => {
              const card = player.character;
              if (!card) return `- ${player.name}：未落座`;
              return `- 玩家「${player.name}」角色「${card.identity.name}」：${card.identity.race}${card.identity.class} ${card.identity.level} 级，HP ${card.combat.hpMax}，AC ${card.combat.ac}，技能 ${card.proficiency.skills.map((skill) => SKILL_NAME[skill]).join('/')}${card.spells ? `，法术 ${card.spells.known.join('/')}` : ''}`;
            })
            .join('\n'),
        };
      },
    },
    {
      name: 'scene',
      description: '查看/推进当前场景：返回本场判定（when/skill/DC/成败文案）、遭遇（encounterId + 怪物组 + maxRounds/battleMapId）、奖励与节拍。玩家不可见。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['view', 'advance'], description: 'view=查看当前场景（缺省）；advance=推进场景' },
          sceneId: { type: 'string', description: 'advance 时指定目标场景 id；view 时指定要查看的场景 id' },
          index: { type: 'integer', minimum: 0, description: '场景下标（0 起）' },
          title: { type: 'string', description: 'advance 时可覆盖场景标题（可选）' },
        },
        required: [],
      },
      output,
      execute(args) {
        const module = requireModule();
        const action = optionalString(args, 'action') ?? 'view';
        const indexArg = optionalNumber(args, 'index');
        if (action === 'view') {
          let sceneIndex = currentSceneFor(module);
          const wantedSceneId = optionalString(args, 'sceneId');
          if (wantedSceneId !== undefined) {
            const found = findSceneIndex(module, wantedSceneId);
            if (found < 0) throw new Error(`模组没有场景「${wantedSceneId}」；可用场景：${sceneListText(module)}`);
            sceneIndex = found;
          } else if (indexArg !== undefined) {
            sceneIndex = Math.trunc(indexArg);
          }
          const scene = requireScene(module, sceneIndex);
          return {
            text: `当前场景：第 ${sceneIndex + 1}/${module.scenes.length} 幕\n${formatSceneData(scene, toolNamesOf())}\n场景进度：${sceneListText(module)}`,
          };
        }
        if (action === 'advance') {
          let sceneIndex: number;
          const wantedSceneId = optionalString(args, 'sceneId');
          if (wantedSceneId !== undefined) {
            const found = findSceneIndex(module, wantedSceneId);
            if (found < 0) throw new Error(`模组没有场景「${wantedSceneId}」；可用场景：${sceneListText(module)}`);
            sceneIndex = found;
          } else if (indexArg !== undefined) {
            sceneIndex = Math.trunc(indexArg);
          } else {
            sceneIndex = currentSceneFor(module) + 1;
          }
          const scene = requireScene(module, sceneIndex);
          roomService.gmScene(roomOf(), scene.id, optionalString(args, 'title') ?? scene.title);
          return {
            text: `已推进到场景 ${sceneIndex + 1}/${module.scenes.length}：${scene.title}\n${formatSceneData(scene, toolNamesOf())}`,
          };
        }
        throw new Error(`未知 action「${action}」：只能是 view 或 advance`);
      },
    },
    {
      name: 'reward',
      description: '给某位玩家发奖励（复用 gm.award 私发）：可指定本场奖励下标自动取 XP/物品，也可直接给 xp/items。',
      parameters: {
        type: 'object',
        properties: {
          playerName: { type: 'string', description: '玩家名或角色名' },
          rewardIndex: { type: 'integer', minimum: 0, description: '本场 rewards 的下标（0 起，缺省 0）' },
          sceneId: { type: 'string', description: '取奖励的场景 id（缺省当前场景）' },
          xp: { type: 'integer', minimum: 0, description: '直接指定 XP（缺省取场景奖励）' },
          items: { type: 'array', items: { type: 'string' }, description: '直接指定物品 id 列表' },
          note: { type: 'string', description: '奖励备注' },
        },
        required: ['playerName'],
      },
      output,
      execute(args) {
        const player = findPlayer(roomService, roomOf(), String(args.playerName ?? ''));
        let xp = optionalNumber(args, 'xp');
        let items: string[] = Array.isArray(args.items)
          ? args.items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
        let note = optionalString(args, 'note');
        let source = '自定义';
        if (xp === undefined) {
          const module = requireModule();
          const wantedSceneId = optionalString(args, 'sceneId');
          const sceneIndex = wantedSceneId !== undefined ? (() => {
            const found = findSceneIndex(module, wantedSceneId);
            if (found < 0) throw new Error(`模组没有场景「${wantedSceneId}」；可用场景：${sceneListText(module)}`);
            return found;
          })() : currentSceneFor(module);
          const scene = requireScene(module, sceneIndex);
          const rewardIndex = optionalNumber(args, 'rewardIndex');
          const targetIndex = rewardIndex !== undefined ? Math.trunc(rewardIndex) : 0;
          const reward = scene.rewards[targetIndex];
          if (reward === undefined) {
            throw new Error(`场景「${scene.title}」没有第 ${targetIndex + 1} 项奖励（共 ${scene.rewards.length} 项）`);
          }
          xp = reward.xp;
          if (items.length === 0) items = [...reward.items];
          note = note ?? reward.note;
          source = `场景奖励 ${targetIndex + 1}/${scene.rewards.length}`;
        }
        if (!Number.isInteger(xp) || xp < 0) throw new Error(`xp 必须是 >= 0 的整数（收到 ${String(xp)}）`);
        roomService.gmAward(roomOf(), player.playerId as PlayerId, {
          xp,
          ...(items.length > 0 ? { items } : {}),
          ...(note !== undefined ? { note } : {}),
        });
        return { text: `已把奖励发给 ${player.name}（私发）：${source}；XP ${xp}；物品：${items.length > 0 ? items.join('、') : '无'}${note !== undefined ? `；备注：${note}` : ''}` };
      },
    },
  ];

  if (includeGenericTools) {
    tools.push(
      {
        name: 'use_action',
        description:
          '按规则包动作结算（如 attack.melee）：{actionId, actorId, targetId?}。命中/伤害/检定/行动经济只以返回值为叙事来源；动作定义来自当前房间规则包。',
        parameters: {
          type: 'object',
          properties: {
            actionId: { type: 'string', description: '规则包动作 id（如 attack.melee）' },
            actorId: { type: 'string', description: '行动者 actorId 或在场名字' },
            targetId: { type: 'string', description: '目标 actorId 或名字（可选）' },
            mods: { type: 'integer', description: '临时加值（可选）' },
            mode: { type: 'string', enum: ['normal', 'advantage', 'disadvantage'], description: '检定模式（可选）' },
            dc: { type: 'integer', description: '覆盖检定 DC（可选）' },
            skillId: { type: 'string', description: '用哪个技能做对抗/检定（可选）' },
          },
          required: ['actionId', 'actorId'],
        },
        output,
        execute(args) {
          const runtime = requireRuntime();
          const actionId = optionalString(args, 'actionId');
          if (actionId === undefined) throw new Error('缺少 actionId：请用规则包里的动作 id（如 attack.melee）');
          const known = (runtime.rules.actions ?? []).map((action) => action.actionId);
          if (!known.includes(actionId)) {
            throw new Error(`规则包没有动作「${actionId}」；可用动作：${known.join('、') || '无'}`);
          }
          const actorId = resolveActorId(runtime, requireActorReference(args), '行动者');
          const targetReference = optionalString(args, 'targetId');
          const targetId = targetReference !== undefined ? resolveActorId(runtime, targetReference, '目标') : undefined;
          const mods = optionalNumber(args, 'mods');
          const mode = optionalString(args, 'mode');
          const dc = optionalNumber(args, 'dc');
          const skillId = optionalString(args, 'skillId');
          const options: { mods?: number; mode?: 'normal' | 'advantage' | 'disadvantage'; dc?: number; skillId?: string } = {};
          if (mods !== undefined) options.mods = Math.trunc(mods);
          if (mode === 'normal' || mode === 'advantage' || mode === 'disadvantage') options.mode = mode;
          else if (mode !== undefined) throw new Error(`mode 只能是 normal/advantage/disadvantage（收到 ${mode}）`);
          if (dc !== undefined) options.dc = Math.trunc(dc);
          if (skillId !== undefined) options.skillId = skillId;
          const result = roomService.useAction(hostPrincipal(roomOf()), {
            actionId,
            actorId,
            ...(targetId !== undefined ? { targetId } : {}),
            ...(Object.keys(options).length > 0 ? { options } : {}),
          });
          return { text: `${formatActionOutcome(result.action, actorNameOf(runtime, actorId))}\n${formatCombatView(result.combat)}` };
        },
      },
      {
        name: 'move',
        description: '按格子/区域移动行动者：{actorId, to:{x,y} 或 {zoneId}}。距离/地形/连通性/移动力由规则运行时校验。',
        parameters: {
          type: 'object',
          properties: {
            actorId: { type: 'string', description: '行动者 actorId 或在场名字' },
            to: {
              type: 'object',
              properties: {
                x: { type: 'integer', description: '目标列（格子坐标）' },
                y: { type: 'integer', description: '目标行（格子坐标）' },
                zoneId: { type: 'string', description: '目标区域 id（区域移动）' },
              },
            },
            via: { type: 'string', description: '移动方式（walk/climb/...，可选）' },
          },
          required: ['actorId', 'to'],
        },
        output,
        execute(args) {
          const runtime = requireRuntime();
          const actorId = resolveActorId(runtime, requireActorReference(args), '行动者');
          const rawTo = asRecord(args.to);
          if (rawTo === undefined) throw new Error('缺少 to：请传 {x,y} 或 {zoneId}');
          const nestedCell = asRecord(rawTo.cell);
          const x = optionalNumber(rawTo, 'x') ?? (nestedCell !== undefined ? optionalNumber(nestedCell, 'x') : undefined);
          const y = optionalNumber(rawTo, 'y') ?? (nestedCell !== undefined ? optionalNumber(nestedCell, 'y') : undefined);
          const zoneId = optionalString(rawTo, 'zoneId');
          if (x === undefined && y === undefined && zoneId === undefined) {
            throw new Error('to 必须是 {x,y}（格子）或 {zoneId}（区域）');
          }
          if ((x === undefined) !== (y === undefined)) throw new Error('to 的 x 与 y 必须同时提供');
          const result = roomService.move(hostPrincipal(roomOf()), {
            actorId,
            to: {
              ...(x !== undefined && y !== undefined ? { cell: { x: Math.trunc(x), y: Math.trunc(y) } } : {}),
              ...(zoneId !== undefined ? { zoneId } : {}),
            },
            ...(optionalString(args, 'via') !== undefined ? { via: optionalString(args, 'via') as string } : {}),
          });
          return { text: `${actorNameOf(runtime, actorId) ?? actorId}：${formatMoveOutcome(result.move)}\n${formatCombatView(result.combat)}` };
        },
      },
      {
        name: 'combat',
        description:
          '战斗结算：start（可传 encounterId 展开模组遭遇并应用本场 maxRounds/battleMapId，或传 monsters）、next（推进回合）、end（收场）、status（查看）。数值只取自返回值。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'next', 'end', 'status'], description: '战斗操作' },
            encounterId: { type: 'string', description: 'start 时展开的模组遭遇 id' },
            monsters: { type: 'string', description: 'start 时的怪物列表 "shanxiao*2,xueshi*1"' },
            maxRounds: { type: 'integer', minimum: 1, description: '覆盖本场回合上限（缺省取遭遇数据）' },
            battleMapId: { type: 'string', description: '覆盖本场战斗地图（引用规则包 battleMaps[].mapId）' },
            reason: { type: 'string', description: '开战/收场原因' },
          },
          required: ['action'],
        },
        output,
        execute(args) {
          const action = optionalString(args, 'action');
          const roomId = roomOf();
          if (action === 'start') {
            return startCombatTool({
              ...(optionalString(args, 'monsters') !== undefined ? { monsters: optionalString(args, 'monsters') as string } : {}),
              ...(optionalString(args, 'encounterId') !== undefined ? { encounterId: optionalString(args, 'encounterId') as string } : {}),
              ...(optionalNumber(args, 'maxRounds') !== undefined ? { maxRounds: Math.trunc(optionalNumber(args, 'maxRounds') as number) } : {}),
              ...(optionalString(args, 'battleMapId') !== undefined ? { battleMapId: optionalString(args, 'battleMapId') as string } : {}),
              ...(optionalString(args, 'reason') !== undefined ? { reason: optionalString(args, 'reason') as string } : {}),
            });
          }
          if (action === 'next') {
            requireRuntime();
            const result = roomService.endTurn(hostPrincipal(roomId), {});
            const active = result.combat.activeActorId === null ? undefined : result.combat.initiative.find((entry) => entry.actorId === result.combat.activeActorId);
            return { text: `${formatCombatView(result.combat)}${active !== undefined ? `\n现在轮到：${active.name}` : ''}` };
          }
          if (action === 'end') {
            requireRuntime();
            const result = roomService.endCombat(hostPrincipal(roomId), {
              ...(optionalString(args, 'reason') !== undefined ? { reason: optionalString(args, 'reason') as string } : {}),
            });
            return { text: `战斗结束。${formatCombatView(result.combat)}` };
          }
          if (action === 'status') {
            requireRuntime();
            return { text: formatCombatView(roomService.combatView(hostPrincipal(roomId)).combat) };
          }
          throw new Error(`未知 action「${String(action)}」：只能是 start/next/end/status`);
        },
      },
    );
  }

  // -------------------------------------------------------------------------
  // 旧工具（兼容）：有规则运行时时同名旧工具作为通用工具的别名
  // -------------------------------------------------------------------------
  tools.push(
    {
      name: 'start_combat',
      description:
        '开始一场战斗。有规则运行时时等价于 combat({action:"start"})（支持 encounterId/maxRounds/battleMapId）；无规则运行时用 monsterId 列表开旧战斗。',
      parameters: {
        type: 'object',
        properties: {
          monsters: { type: 'string', description: '怪物列表，格式 "shanxiao*2,xueshi*1"；id 见模组遭遇或 list_monsters' },
          encounterId: { type: 'string', description: '有规则运行时时：按模组遭遇 id 开战（自动展开怪物并覆盖本场 maxRounds/battleMapId）' },
          maxRounds: { type: 'integer', minimum: 1, description: '有规则运行时时：覆盖本场回合上限' },
          battleMapId: { type: 'string', description: '有规则运行时时：覆盖本场战斗地图' },
          reason: { type: 'string', description: '开战原因（中文短语）' },
        },
        required: [],
      },
      output,
      execute(args) {
        if (runtimeOf() !== undefined) {
          return startCombatTool({
            ...(optionalString(args, 'monsters') !== undefined ? { monsters: optionalString(args, 'monsters') as string } : {}),
            ...(optionalString(args, 'encounterId') !== undefined ? { encounterId: optionalString(args, 'encounterId') as string } : {}),
            ...(optionalNumber(args, 'maxRounds') !== undefined ? { maxRounds: Math.trunc(optionalNumber(args, 'maxRounds') as number) } : {}),
            ...(optionalString(args, 'battleMapId') !== undefined ? { battleMapId: optionalString(args, 'battleMapId') as string } : {}),
            ...(optionalString(args, 'reason') !== undefined ? { reason: optionalString(args, 'reason') as string } : {}),
          });
        }
        const monsters = optionalString(args, 'monsters');
        if (monsters === undefined) throw new Error('缺少 monsters：格式 "shanxiao*2,xueshi*1"（本房间没有规则运行时）');
        return startLegacyCombat({ monsters });
      },
    },
    {
      name: 'attack',
      description:
        '让当前行动者攻击一个目标。有规则运行时时等价于 use_action（动作 id 取 attackName，或规则包 kind=attack 的第一个动作）；无规则运行时用旧引擎战斗结算。',
      parameters: {
        type: 'object',
        properties: {
          attacker: { type: 'string', description: '当前行动者的名字（玩家角色名或怪物名）' },
          target: { type: 'string', description: '目标名字' },
          attackName: { type: 'string', description: '使用哪个攻击（可选；有规则运行时时为动作 id）' },
        },
        required: ['attacker', 'target'],
      },
      output,
      execute(args) {
        const attacker = String(args.attacker ?? '');
        const target = String(args.target ?? '');
        if (runtimeOf() !== undefined) {
          return attackViaRuntime({
            attacker,
            target,
            ...(optionalString(args, 'attackName') !== undefined ? { attackName: optionalString(args, 'attackName') as string } : {}),
          });
        }
        const currentCombat = combatOf();
        if (!currentCombat) throw new Error('战斗系统未初始化');
        const { text } = currentCombat.attack(attacker, target, typeof args.attackName === 'string' ? args.attackName : undefined);
        return { text };
      },
    },
    {
      name: 'next_turn',
      description: '结束当前行动者的回合，轮到先攻顺序里的下一个可行动者（有规则运行时时等价于 combat({action:"next"})）。',
      parameters: { type: 'object', properties: {}, required: [] },
      output,
      execute() {
        if (runtimeOf() !== undefined) {
          requireRuntime();
          const result = roomService.endTurn(hostPrincipal(roomOf()), {});
          return { text: formatCombatView(result.combat) };
        }
        const currentCombat = combatOf();
        if (!currentCombat) throw new Error('战斗系统未初始化');
        const { text } = currentCombat.nextTurn();
        return { text };
      },
    },
    {
      name: 'combat_status',
      description: '查看当前战斗状态：第几轮、轮到谁、双方 HP（有规则运行时时等价于 combat({action:"status"})）。',
      parameters: { type: 'object', properties: {}, required: [] },
      output,
      execute() {
        if (runtimeOf() !== undefined) {
          requireRuntime();
          return { text: formatCombatView(roomService.combatView(hostPrincipal(roomOf())).combat) };
        }
        const currentCombat = combatOf();
        if (!currentCombat || !currentCombat.running) return { text: '当前没有进行中的战斗' };
        return { text: currentCombat.status() };
      },
    },
    {
      name: 'end_combat',
      description: '结束当前战斗（玩家逃跑、敌人清空或剧情收尾）；有规则运行时时等价于 combat({action:"end"})。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '收场原因（可选）' },
        },
        required: [],
      },
      output,
      execute(args) {
        if (runtimeOf() !== undefined) {
          requireRuntime();
          const result = roomService.endCombat(hostPrincipal(roomOf()), {
            ...(optionalString(args, 'reason') !== undefined ? { reason: optionalString(args, 'reason') as string } : {}),
          });
          return { text: `战斗结束。${formatCombatView(result.combat)}` };
        }
        const currentCombat = combatOf();
        if (!currentCombat || !currentCombat.running) throw new Error('当前没有进行中的战斗');
        return { text: currentCombat.end() };
      },
    },
  );

  return tools;
}
