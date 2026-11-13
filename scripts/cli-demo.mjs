/**
 * M1 CLI 对局器：不接 AI、不接 UI，用真实引擎 + 内容跑一幕，输出 Markdown 战报。
 *
 * 用法：node scripts/cli-demo.mjs
 * 验收标准（docs/ROADMAP.md M1）：能无 UI 跑完一幕并产出可读战报。
 */
import {
  activeCombatant,
  attack,
  castSpell,
  advanceTurn,
  combatantFromCard,
  combatantFromMonster,
  createRng,
  isAlive,
  rollSkillCheck,
  startCombat,
} from '../packages/engine/src/index.ts';
import { CARDS, GUIMUYA_MODULE, MONSTERS, SPELL_BY_ID } from '../packages/content/src/index.ts';

const lines = [];
const say = (line = '') => {
  lines.push(line);
  console.log(line);
};

const module = GUIMUYA_MODULE;
const bossScene = module.scenes.find((scene) => scene.id === 'scene_shendong');
const firstScene = module.scenes[0];
const monsterById = new Map(MONSTERS.map((monster) => [monster.id, monster]));
const aliveSorted = (list) => list.filter((entry) => isAlive(entry)).sort((a, b) => a.hp.current - b.hp.current);

say(`# ${module.title} — CLI 对局战报`);
say();
say(`> ${module.synopsis}`);
say();
say(`规则：${module.ruleId} · 等级 ${module.level.join('-')} · 建议 ${module.playerCount.join('-')} 人 · 约 ${module.durationMinutes} 分钟`);
say();

// ---------------------------------------------------------------------------
// 场景 1：一次技能检定（白露·洞悉）
// ---------------------------------------------------------------------------
const bailu = CARDS.find((card) => card.id === 'card_bailu');
const sceneOneCheck = firstScene.checks.find((check) => check.skill === 'insight');
const checkRng = createRng(20261113);
const checkResult = rollSkillCheck(
  { proficiency: bailu.proficiency.bonus, skills: bailu.proficiency.skills, saves: bailu.proficiency.saves },
  bailu.abilities,
  sceneOneCheck.skill,
  sceneOneCheck.dc,
  checkRng,
);
say(`## 场景一 · ${firstScene.title}`);
say();
say(`**${sceneOneCheck.skill} 检定**：d20=${checkResult.d20} + ${checkResult.bonus} = **${checkResult.total}** vs DC ${sceneOneCheck.dc} → ${checkResult.success ? '成功' : '失败'}`);
say();
say(`> ${checkResult.success ? sceneOneCheck.success : sceneOneCheck.failure}`);
say();

// ---------------------------------------------------------------------------
// 场景 3：Boss 战（四名预制角色 vs 赤目道人 + 血尸）
// ---------------------------------------------------------------------------
const party = CARDS.map((card) => combatantFromCard(card));
const encounter = bossScene.encounters[0];
const enemies = encounter.monsters.flatMap((group) =>
  Array.from({ length: group.count }, (_, index) => {
    const def = monsterById.get(group.monsterId);
    return combatantFromMonster(def, { id: `${def.id}_${index + 1}` });
  }),
);

const rng = createRng(20261113);
const state = startCombat([...party, ...enemies], rng);

say(`## 场景三 · ${bossScene.title}`);
say();
say(`**参战**：${party.map((pc) => `${pc.name}（HP ${pc.hp.current}）`).join('、')} vs ${enemies.map((mob) => mob.name).join('、')}`);
say();
say(`**先攻**：${state.order.map((id) => state.participants.find((entry) => entry.id === id).name).join(' → ')}`);
say();

const strategy = {
  card_aqing: (actor) => {
    const target = aliveSorted(state.participants.filter((entry) => entry.kind === 'monster'))[0];
    return attack(state, { attackerId: actor.id, targetId: target.id }, rng);
  },
  card_bailu: (actor) => {
    const target = aliveSorted(state.participants.filter((entry) => entry.kind === 'monster'))[0];
    return attack(state, { attackerId: actor.id, targetId: target.id }, rng);
  },
  card_sujiu: (actor) => {
    const target = aliveSorted(state.participants.filter((entry) => entry.kind === 'monster'))[0];
    const slots = actor.spellcasting.slots.current;
    if ((slots[2] ?? 0) > 0) {
      return castSpell(state, { casterId: actor.id, spell: SPELL_BY_ID.huoqiu, targetIds: [target.id], slotLevel: 2 }, rng);
    }
    if ((slots[1] ?? 0) > 0 && state.range === 'engaged') {
      return castSpell(state, { casterId: actor.id, spell: SPELL_BY_ID.zhuoyan, targetIds: [target.id] }, rng);
    }
    return castSpell(state, { casterId: actor.id, spell: SPELL_BY_ID.yinhuo, targetIds: [target.id] }, rng);
  },
  card_xuanzhen: (actor) => {
    const allies = state.participants.filter((entry) => entry.kind === 'pc');
    const wounded = aliveSorted(allies).find((ally) => ally.hp.current < ally.hp.max * 0.6);
    const slots = actor.spellcasting.slots.current;
    if (wounded && (slots[1] ?? 0) > 0) {
      return castSpell(state, { casterId: actor.id, spell: SPELL_BY_ID.liaoshang, targetIds: [wounded.id] }, rng);
    }
    const target = aliveSorted(state.participants.filter((entry) => entry.kind === 'monster'))[0];
    return attack(state, { attackerId: actor.id, targetId: target.id }, rng);
  },
};

let rounds = 0;
while (rounds < 12) {
  const actor = activeCombatant(state);
  if (state.round !== rounds) {
    rounds = state.round;
    say(`### 第 ${rounds} 轮`);
    say();
  }
  const foes = state.participants.filter((entry) => entry.kind === 'monster');
  const allies = state.participants.filter((entry) => entry.kind === 'pc');
  const logStart = state.log.length;

  if (actor.kind === 'pc' && allies.some((ally) => isAlive(ally)) && foes.some((foe) => isAlive(foe))) {
    try {
      strategy[actor.id]?.(actor);
    } catch (error) {
      say(`- ${actor.name}：${error.message}（跳过）`);
    }
  } else if (actor.kind === 'monster' && isAlive(actor)) {
    const target = aliveSorted(allies)[0];
    if (target) {
      try {
        attack(state, { attackerId: actor.id, targetId: target.id }, rng);
      } catch (error) {
        say(`- ${actor.name}：${error.message}（跳过）`);
      }
    }
  }

  for (const entry of state.log.slice(logStart)) {
    if (entry.kind === 'turn' || entry.kind === 'move') continue;
    say(`- ${entry.text}`);
  }
  if (!foes.some((foe) => isAlive(foe))) break;
  if (!allies.some((ally) => isAlive(ally) && !ally.downed)) break;
  advanceTurn(state);
}
say();

say('## 战报结算');
say();
for (const combatant of state.participants) {
  const status = combatant.dead ? '阵亡' : combatant.downed ? '倒地' : `HP ${combatant.hp.current}/${combatant.hp.max}`;
  say(`- ${combatant.name}：${status}`);
}
say();
const foesLeft = state.participants.filter((entry) => entry.kind === 'monster' && isAlive(entry));
const alliesLeft = state.participants.filter((entry) => entry.kind === 'pc' && isAlive(entry) && !entry.downed);
say(`**结果**：${foesLeft.length === 0 ? '玩家方胜利 🎉' : alliesLeft.length === 0 ? '团灭…' : `战斗在第 ${state.round} 轮中断（仍有 ${foesLeft.length} 个敌人）`}`);
say();
say(`> 事件日志共 ${state.log.length} 条；掷骰由 seed=20261113 决定，可复现。`);
