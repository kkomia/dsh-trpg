/**
 * 房间战斗运行时（M3）：把引擎的 CombatState 装进 GM 工具层。
 *
 * 为什么放在服务端而不是 AI 记忆里：先攻顺序、当前行动者、HP 都是权威状态；
 * AI 每次只能请求「让当前行动者攻击谁」，引擎校验轮次并结算。
 */
import {
  activeCombatant,
  advanceTurn,
  attack as engineAttack,
  combatantFromCard,
  combatantFromMonster,
  createRng,
  deriveRollSeed,
  getCombatant,
  isAlive,
  startCombat,
  type CombatState,
  type Combatant,
  type MonsterDef,
  type RangeBand,
} from '@dsh-trpg/engine';
import { MONSTERS } from '@dsh-trpg/content';
import type { RoomService } from '@dsh-trpg/rooms';

export interface CombatOrderEntry {
  id: string;
  name: string;
  kind: 'pc' | 'monster';
  hp: number;
  maxHp: number;
  ac: number;
  downed: boolean;
  dead: boolean;
}

export interface CombatView {
  round: number;
  activeId: string;
  activeName: string;
  order: CombatOrderEntry[];
}

export interface CombatRuntimeOptions {
  roomService: RoomService;
  roomId: string;
  log?: (message: string) => void;
}

export class CombatRuntime {
  private readonly options: CombatRuntimeOptions;
  private state: CombatState | null = null;
  private rollIndex = 0;

  constructor(options: CombatRuntimeOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.state !== null;
  }

  /** 开战：玩家方 = 已落座角色，怪物方来自内容包的 monsterId。 */
  start(monsterSpec: string): { text: string; view: CombatView } {
    if (this.state) throw new Error('战斗已经开始了；先结束当前战斗再开新的');
    const party = this.options.roomService.gmParty(this.options.roomId).filter((player) => player.character);
    if (party.length === 0) throw new Error('还没有玩家落座，无法开战');
    const monsters = this.parseMonsters(monsterSpec);
    if (monsters.length === 0) throw new Error('没有可用的怪物；格式示例：shanxiao*2,xueshi*1');

    const players: Combatant[] = party.map((player) =>
      combatantFromCard(player.character as NonNullable<typeof player.character>, { id: player.playerId, range: 'near' }),
    );
    const enemies = monsters.map((entry, index) => combatantFromMonster(entry, { id: `monster_${entry.id}_${index + 1}`, range: 'near' }));
    const rng = this.rng();
    this.state = startCombat([...players, ...enemies], rng, { seed: 1, range: 'near' as RangeBand });
    const view = this.view();
    const order = view.order.map((entry) => entry.name).join(' → ');
    const text = `战斗开始（第 1 轮）。先攻顺序：${order}。现在轮到 ${view.activeName}。`;
    this.broadcast(text);
    return { text, view };
  }

  /** 当前行动者攻击目标：轮次由引擎强制，AI 无法跳回合。 */
  attack(attackerName: string, targetName: string, attackName?: string): { text: string; view: CombatView } {
    const state = this.requireState();
    const attacker = this.findCombatant(attackerName);
    const target = this.findCombatant(targetName);
    const active = activeCombatant(state);
    if (active.id !== attacker.id) {
      throw new Error(`现在轮到 ${active.name} 行动，${attacker.name} 不能抢先攻击`);
    }
    const result = engineAttack(state, { attackerId: attacker.id, targetId: target.id, attackName }, this.rng());
    const text = result.hit
      ? `${attacker.name} 用${result.attackName}命中 ${target.name}${result.critical ? '（暴击）' : ''}，造成 ${result.damage} 伤害；${target.name} 剩余 HP ${result.targetHp}${result.downed ? '，已倒地' : ''}。`
      : `${attacker.name} 用${result.attackName}攻击 ${target.name} 未命中（d20=${result.d20}+${result.attackBonus}=${result.total} vs AC ${result.targetAc}）。`;
    const view = this.view();
    this.broadcast(text);
    return { text, view };
  }

  /** 推进到下一个行动者。 */
  nextTurn(): { text: string; view: CombatView } {
    const state = this.requireState();
    const next = advanceTurn(state);
    const view = this.view();
    const text = `第 ${state.round} 轮，现在轮到 ${next.name} 行动。`;
    this.broadcast(text);
    return { text, view };
  }

  status(): string {
    const view = this.view();
    const hp = view.order
      .map((entry) => `${entry.name} ${entry.dead ? '阵亡' : entry.downed ? '倒地' : `${entry.hp}/${entry.maxHp}`}`)
      .join('；');
    return `第 ${view.round} 轮，轮到 ${view.activeName}。${hp}`;
  }

  end(): string {
    if (!this.state) throw new Error('当前没有进行中的战斗');
    this.state = null;
    const text = '战斗结束。';
    this.broadcast(text);
    return text;
  }

  view(): CombatView {
    const state = this.requireState();
    return {
      round: state.round,
      activeId: activeCombatant(state).id,
      activeName: activeCombatant(state).name,
      order: state.order.map((id) => {
        const combatant = getCombatant(state, id);
        return {
          id: combatant.id,
          name: combatant.name,
          kind: combatant.kind,
          hp: combatant.hp.current,
          maxHp: combatant.hp.max,
          ac: combatant.ac,
          downed: combatant.downed,
          dead: combatant.dead,
        };
      }),
    };
  }

  // -------------------------------------------------------------------------

  private requireState(): CombatState {
    if (!this.state) throw new Error('当前没有进行中的战斗；先调用 start_combat');
    return this.state;
  }

  private findCombatant(name: string): Combatant {
    const state = this.requireState();
    const found = state.participants.find(
      (combatant) => combatant.name === name || combatant.id === name || (combatant.kind === 'pc' && combatant.name === name),
    );
    if (!found) {
      const names = state.participants.map((combatant) => combatant.name).join('、');
      throw new Error(`找不到参战者「${name}」；在场：${names}`);
    }
    if (!isAlive(found)) throw new Error(`${found.name} 已经无法行动`);
    return found;
  }

  private parseMonsters(spec: string): MonsterDef[] {
    const byId = new Map(MONSTERS.map((monster) => [monster.id, monster]));
    const result: MonsterDef[] = [];
    for (const part of spec.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [rawId, rawCount] = trimmed.split('*');
      const id = (rawId ?? '').trim();
      const count = Number.parseInt((rawCount ?? '1').trim(), 10);
      const monster = byId.get(id);
      if (!monster) throw new Error(`未知怪物 id：${id}；可用：${[...byId.keys()].join('、')}`);
      const total = Number.isInteger(count) && count > 0 && count <= 6 ? count : 1;
      for (let index = 0; index < total; index += 1) result.push(monster);
    }
    return result;
  }

  private rng() {
    this.rollIndex += 1;
    const seed = this.options.roomService.gmRoomSeed(this.options.roomId);
    return createRng(deriveRollSeed(seed, 900000 + this.rollIndex));
  }

  private broadcast(text: string): void {
    try {
      this.options.roomService.gmCombat(this.options.roomId, this.view(), text);
    } catch (error) {
      this.options.log?.(`combat broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
