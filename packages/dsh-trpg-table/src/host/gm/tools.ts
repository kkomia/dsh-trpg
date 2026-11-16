/**
 * GM 工具集：AI 只能通过这里请求结算。每个工具都绑定到一个房间与房间服务，
 * 返回值是给模型看的结构化文本，副作用（骰子/私密消息）直接落进房间事件流。
 */
import { SKILL_ABILITY, SKILL_NAME, type SkillId } from '@dsh-trpg/engine';
import type { LorebookDef } from '@dsh-trpg/content';
import type { RoomService } from '@dsh-trpg/rooms';
import type { CombatRuntime } from './combat.ts';

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

const SKILL_IDS = Object.keys(SKILL_ABILITY) as SkillId[];

function findPlayer(roomService: RoomService, roomId: string, playerName: string) {
  const party = roomService.gmParty(roomId);
  const normalized = playerName.trim();
  const player = party.find(
    (entry) => entry.name === normalized || entry.character?.identity.name === normalized || entry.playerId === normalized,
  );
  if (!player) throw new Error(`找不到玩家「${playerName}」，当前队伍：${party.map((entry) => entry.name).join('、')}`);
  return player;
}

export function createGmTools(options: {
  roomService: RoomService;
  /** 固定房间 id，或解析器（subagent 模式按 childId 动态解析）。 */
  roomId: string | (() => string);
  /** 世界书：固定对象，或按房间解析（不同房间可能引用不同内容包）。 */
  lorebook: LorebookDef | (() => LorebookDef);
  combat?: CombatRuntime | (() => CombatRuntime | undefined);
}): GmToolDefinition[] {
  const { roomService } = options;
  const combat = options.combat;
  const roomOf = (): string => (typeof options.roomId === 'string' ? options.roomId : options.roomId());
  const lorebookOf = (): LorebookDef => (typeof options.lorebook === 'function' ? options.lorebook() : options.lorebook);
  const combatOf = (): CombatRuntime | undefined => (typeof combat === 'function' ? combat() : combat);
  const render = (_args: Record<string, unknown>, value: { text: string }) => [{ type: 'text' as const, text: value.text }];
  const output = { schema: { type: 'object' }, render };

  return [
    {
      name: 'roll_check',
      description:
        '对一名玩家角色做技能/属性检定：引擎用房间种子掷 d20 并计算加值，返回骰面、总值、DC 与成败。需要判定玩家行动时调用，不要在叙事里自己编骰子。',
      parameters: {
        type: 'object',
        properties: {
          playerName: { type: 'string', description: '玩家名或角色名' },
          skill: { type: 'string', enum: SKILL_IDS, description: '技能 id' },
          dc: { type: 'integer', minimum: 5, maximum: 30, description: '难度 DC' },
          reason: { type: 'string', description: '这次检定的原因（中文短语）' },
          private: { type: 'boolean', description: 'true = 暗骰，只把骰面告诉该玩家与 GM' },
        },
        required: ['playerName', 'skill', 'dc'],
      },
      output,
      async execute(args) {
        const player = findPlayer(roomService, roomOf(), String(args.playerName ?? ''));
        if (!player.character) throw new Error(`${player.name} 还没有角色卡，先让玩家落座`);
        const skill = String(args.skill ?? '') as SkillId;
        if (!SKILL_IDS.includes(skill)) throw new Error(`未知技能：${skill}`);
        const dc = Number(args.dc);
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
        const entry = lorebook.entries.find((item) => item.id === String(args.entryId ?? ''));
        if (!entry) throw new Error(`世界书没有条目：${String(args.entryId ?? '')}；可用条目：${lorebook.entries.map((item) => item.id).join('、')}`);
        roomService.gmNarrate(roomOf(), entry.content);
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
            .map((entry) => `〔${entry.visibility === 'gm' ? 'GM秘密' : '公开'}〕${entry.title ?? entry.id}：${entry.content}`)
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
      name: 'start_combat',
      description:
        '开始一场战斗：玩家方自动取已落座角色，怪物方用 monsterId 指定。引擎会掷先攻并维护轮次；开战后只能用 attack/next_turn 推进，不能跳回合。',
      parameters: {
        type: 'object',
        properties: {
          monsters: { type: 'string', description: '怪物列表，格式 "shanxiao*2,xueshi*1"；id 见模组遭遇或 list_monsters' },
          reason: { type: 'string', description: '开战原因（中文短语）' },
        },
        required: ['monsters'],
      },
      output,
      execute(args) {
        const currentCombat = combatOf();
        if (!currentCombat) throw new Error('战斗系统未初始化');
        const { text } = currentCombat.start(String(args.monsters ?? ''));
        return { text };
      },
    },
    {
      name: 'attack',
      description:
        '让当前行动者攻击一个目标（引擎掷命中与伤害）。只能对当前行动者调用；不是它的回合会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          attacker: { type: 'string', description: '当前行动者的名字（玩家角色名或怪物名）' },
          target: { type: 'string', description: '目标名字' },
          attackName: { type: 'string', description: '使用哪个攻击（可选，默认第一个）' },
        },
        required: ['attacker', 'target'],
      },
      output,
      execute(args) {
        const currentCombat = combatOf();
        if (!currentCombat) throw new Error('战斗系统未初始化');
        const { text } = currentCombat.attack(
          String(args.attacker ?? ''),
          String(args.target ?? ''),
          typeof args.attackName === 'string' ? args.attackName : undefined,
        );
        return { text };
      },
    },
    {
      name: 'next_turn',
      description: '结束当前行动者的回合，轮到先攻顺序里的下一个可行动者。',
      parameters: { type: 'object', properties: {}, required: [] },
      output,
      execute() {
        const currentCombat = combatOf();
        if (!currentCombat) throw new Error('战斗系统未初始化');
        const { text } = currentCombat.nextTurn();
        return { text };
      },
    },
    {
      name: 'combat_status',
      description: '查看当前战斗状态：第几轮、轮到谁、双方 HP。',
      parameters: { type: 'object', properties: {}, required: [] },
      output,
      execute() {
        const currentCombat = combatOf();
        if (!currentCombat || !currentCombat.running) return { text: '当前没有进行中的战斗' };
        return { text: currentCombat.status() };
      },
    },
    {
      name: 'end_combat',
      description: '结束当前战斗（玩家逃跑、敌人清空或剧情收尾）。',
      parameters: { type: 'object', properties: {}, required: [] },
      output,
      execute() {
        const currentCombat = combatOf();
        if (!currentCombat || !currentCombat.running) throw new Error('当前没有进行中的战斗');
        return { text: currentCombat.end() };
      },
    },
  ];
}
