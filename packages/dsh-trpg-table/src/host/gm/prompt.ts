/**
 * GM 上下文组装（纯函数，可单测）。
 *
 * 设计约束（DESIGN §4 锁 1/2/5、§8）：
 * - 行动者身份由服务端在 prompt 里显式写出，AI 不推断；
 * - 骰子/数值只能来自工具结果，prompt 里明确禁止自算；
 * - 最近事件按序带上 seq，私密事件只出现在 GM 侧（GM 本来就全见）。
 */
import type { LorebookDef, ModuleDef } from '@dsh-trpg/content';

export interface PromptPlayer {
  playerId: string;
  name: string;
  characterName?: string;
  characterClass?: string;
  level?: number;
  hp?: number;
  hpMax?: number;
  ac?: number;
  publicSummary?: string;
}

export interface PromptEvent {
  seq: number;
  kind: string;
  to: string;
  text: string;
}

export interface TurnPromptInput {
  module: ModuleDef;
  roomTitle: string;
  actor: { playerName: string; characterName?: string };
  actionText: string;
  private: boolean;
  party: PromptPlayer[];
  recent: PromptEvent[];
  sceneIndex?: number;
}

function lorebookLines(lorebook: LorebookDef): string {
  return lorebook.entries
    .map((entry) => {
      const scope = entry.visibility === 'gm' ? '〔GM 秘密〕' : entry.visibility === 'public' ? '〔公开〕' : '〔限人〕';
      return `- ${scope}${entry.title ?? entry.id}（id: ${entry.id}）：${entry.content}`;
    })
    .join('\n');
}

export type ToolNameMap = Record<string, string>;

/** 系统提示：GM 守则 + 模组 + 世界书。每个房间的 GM 会话常驻一份。 */
export function buildGmSystemPrompt(module: ModuleDef, lorebook: LorebookDef, toolNames: ToolNameMap = {}): string {
  const n = (name: string): string => toolNames[name] ?? name;
  const scenes = module.scenes
    .map((scene) => `- 【${scene.title}】${scene.entry}`)
    .join('\n');
  const npcs = module.npcs.map((npc) => `- ${npc.name}：${npc.description}`).join('\n');
  return [
    `你是《${module.title}》的 KP/GM（主持人），正在一个局域网跑团桌上带团。规则是 D&D 5e-lite（中文奇幻皮）。`,
    '',
    '## 你的职责',
    '- 描述场景、扮演所有 NPC、判定玩家行动的后果、推进剧情；玩家只负责扮演自己的角色。',
    '- 需要判定时调用工具掷骰，用工具返回的骰面与成败来叙述结果。',
    '',
    '## 硬规则（违反会让整桌跑团崩坏）',
    '1. 绝不替玩家角色写行动、台词或心理活动；玩家角色说过什么、做过什么，只以玩家提交的内容为准。',
    '2. 每次只回应「本次行动者」一个人提交的行动；其他玩家没有动作时，不要替他们行动或发言。',
    '3. 骰子、检定、伤害数值只能来自工具结果；不要自己编造数值，也不要假装掷骰。',
    `3b. 以下行动一律必须先调用 ${n('roll_check')} 工具再叙述结果：观察/偷听/搜索/调查/识破谎言/威吓/说服/潜行/攀爬/辨认符文/任何有失败可能的尝试。工具报错就如实告诉玩家“判定失败”，不得用文字替代掷骰。`,
    `3c. 战斗相关一律走 ${n('start_combat')} / ${n('attack')} / ${n('next_turn')} 工具，不要用叙事直接决定命中或伤害。`,
    '4. 一次回复 2–6 句，节奏紧凑，中文第二人称（“你”指行动者），结尾留出下一步的选择或问题。',
    `5. 标〔GM 秘密〕的内容不得直接说破；只有调用 ${n('reveal_lore')} 揭示给全桌后，才可以作为公开信息使用。`,
    `6. 只想让某一位玩家知道的信息，用 ${n('secret_note')} 工具私发，不要写进公共叙事。`,    '7. 不要向玩家解释规则术语或工具机制，用世界内的语言描述结果。',
    '',
    '## 模组概要',
    module.synopsis,
    '',
    module.gmNotes ? `## GM 备注\n${module.gmNotes}` : '',
    '',
    '## 场景（按顺序推进，由你判断何时切换）',
    scenes,
    '',
    '## NPC',
    npcs,
    '',
    '## 世界书',
    lorebookLines(lorebook),
    '',
    '## 可用工具',
    `- ${n('roll_check')}：对指定玩家做技能/属性检定（引擎掷骰，返回成败）。`,
    `- ${n('roll_dice')}：自由掷骰（伤害、随机表等）。`,
    `- ${n('secret_note')}：给某位玩家发私密信息。`,
    `- ${n('reveal_lore')}：把某条世界书内容揭示给全桌。`,
    `- ${n('check_lore')}：按关键词查世界书。`,
    `- ${n('list_party')}：查看队伍角色卡摘要。`,
    `- ${n('start_combat')} / ${n('attack')} / ${n('next_turn')} / ${n('combat_status')} / ${n('end_combat')}：战斗结算（先攻、攻击、轮次）。`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatRecent(events: PromptEvent[]): string {
  if (events.length === 0) return '（本桌还没有发生过事件）';
  return events
    .map((event) => {
      const target = event.to === 'all' ? '' : event.to === 'gm' ? '（仅GM）' : '（私密）';
      return `[${event.seq}] ${event.kind}${target}：${event.text.slice(0, 160)}`;
    })
    .join('\n');
}

/** 单次行动的 user 消息：只包含本次行动者与最近事件，避免 AI 把多个玩家混在一起。 */
export function buildTurnPrompt(input: TurnPromptInput): string {
  const partyLines = input.party
    .map((player) => {
      const character = player.characterName
        ? `${player.characterName}（${player.characterClass ?? '?'} ${player.level ?? '?'} 级，HP ${player.hp ?? '?'}/${player.hpMax ?? '?'}，AC ${player.ac ?? '?'}）`
        : '未落座';
      return `- 玩家「${player.name}」：${character}${player.publicSummary ? ` — ${player.publicSummary}` : ''}`;
    })
    .join('\n');

  return [
    `【房间】${input.roomTitle}`,
    `【行动者】玩家「${input.actor.playerName}」${input.actor.characterName ? `（角色：${input.actor.characterName}）` : ''}`,
    '本次只有这一位玩家行动；请只回应该行动，不要替其他玩家做决定。',
    '',
    '【队伍】',
    partyLines,
    '',
    '【最近事件】',
    formatRecent(input.recent),
    '',
    input.private ? '【行动内容（悄悄话，只有你和该玩家知道）】' : '【行动内容】',
    input.actionText,
    '',
    '请以 GM 身份叙述这次行动的结果。需要判定就调用 roll_check；不要自己编骰子结果。',
  ].join('\n');
}

/** 给 GM 的简短场景上下文（工具 list_scene 用，M3 暂未启用）。 */
export function currentSceneIndex(module: ModuleDef, sceneId: string | undefined): number {
  if (!sceneId) return 0;
  const index = module.scenes.findIndex((scene) => scene.id === sceneId);
  return index >= 0 ? index : 0;
}
