/**
 * 法术结算（v1 简化版）：法术数据来自内容包，引擎负责权限、消耗与效果落地。
 *
 * AI GM 只能通过本模块请求施法；未命中/豁免/消耗都由引擎算完，AI 只负责叙事。
 */
import { abilityMod, saveBonus, spellSaveDC } from './checks.ts';
import { rollDice, rollCheck } from './dice.ts';
import {
  activeCombatant,
  applyDamage,
  canAct,
  getCombatant,
  heal,
  addCondition,
  logEntry,
  type CombatState,
  type RngLike,
} from './combat.ts';
import { RANGE_NAME, type RangeBand, type SpellDef } from './types.ts';

const BAND_ORDER: Record<RangeBand, number> = { engaged: 0, near: 1, far: 2 };

export interface CastInput {
  casterId: string;
  spell: SpellDef;
  targetIds?: string[];
  /** 升环施法：用几环的法术位。默认按法术自身环数。 */
  slotLevel?: number;
}

export interface CastTargetResult {
  targetId: string;
  saved?: boolean;
  saveRoll?: number;
  damage?: number;
  healed?: number;
  condition?: string;
  note?: string;
}

export interface CastResult {
  ok: true;
  casterId: string;
  spellId: string;
  spellName: string;
  slotLevel: number;
  results: CastTargetResult[];
}

function assertCaster(state: CombatState, casterId: string) {
  const caster = getCombatant(state, casterId);
  const active = activeCombatant(state);
  if (active.id !== casterId) throw new Error(`当前轮到 ${active.name} 行动，${caster.name} 不能抢先施法`);
  if (!canAct(caster)) throw new Error(`${caster.name} 现在无法行动`);
  if (state.range === 'far' && caster.range === 'engaged') {
    // 距离只影响需要接触的法术；v1 由 spell.range 决定可达性。
  }
  return caster;
}

export function castSpell(state: CombatState, input: CastInput, rng: RngLike): CastResult {
  const caster = assertCaster(state, input.casterId);
  const spell = input.spell;
  const casting = caster.spellcasting;
  if (!casting) throw new Error(`${caster.name} 不会施法`);
  if (!casting.known.includes(spell.id)) throw new Error(`${caster.name} 没有掌握「${spell.name}」`);

  const economyKey = spell.castingTime === 'action' ? 'action' : 'bonus';
  if (state.economy[economyKey]) {
    throw new Error(`${caster.name} 本回合已经用过${spell.castingTime === 'action' ? '动作' : '附赠动作'}`);
  }

  const slotLevel = spell.level === 0 ? 0 : (input.slotLevel ?? spell.level);
  if (spell.level > 0) {
    if (slotLevel < spell.level) throw new Error(`法术位环数不足：${spell.name} 需要 ${spell.level} 环`);
    const available = casting.slots.current[slotLevel] ?? 0;
    if (available <= 0) throw new Error(`${caster.name} 没有 ${slotLevel} 环法术位了`);
    casting.slots.current[slotLevel] = available - 1;
  }

  if (spell.range !== 'self' && BAND_ORDER[spell.range] < BAND_ORDER[state.range]) {
    throw new Error(`目标超出「${spell.name}」的射程（${RANGE_NAME[spell.range]}）`);
  }

  const targetIds = spell.range === 'self' ? [caster.id] : (input.targetIds ?? []);
  if (spell.effect.kind !== 'utility' && targetIds.length === 0) {
    throw new Error(`「${spell.name}」需要目标`);
  }

  state.economy[economyKey] = true;
  const dc = spellSaveDC(casting.ability, caster.abilities, caster.proficiency);
  const results: CastTargetResult[] = [];

  for (const targetId of targetIds) {
    const target = getCombatant(state, targetId);
    switch (spell.effect.kind) {
      case 'damage': {
        const save = rollCheck(
          {
            modifier: saveBonus(
              { proficiency: target.proficiency, skills: [], saves: target.saves },
              target.abilities,
              spell.effect.saveAbility,
            ),
            dc,
          },
          rng,
        );
        let damage = rollDice(spell.effect.dice, rng).total;
        if (save.success && spell.effect.halfOnSave) damage = Math.floor(damage / 2);
        applyDamage(target, damage, spell.name);
        results.push({ targetId, saved: save.success, saveRoll: save.total, damage });
        break;
      }
      case 'heal': {
        const amount = rollDice(spell.effect.dice, rng).total + (spell.effect.addCastingMod ? abilityMod(caster.abilities[casting.ability]) : 0);
        const healed = heal(target, Math.max(0, amount));
        results.push({ targetId, healed });
        break;
      }
      case 'condition': {
        const save = rollCheck(
          {
            modifier: saveBonus(
              { proficiency: target.proficiency, skills: [], saves: target.saves },
              target.abilities,
              spell.effect.saveAbility,
            ),
            dc,
          },
          rng,
        );
        if (!save.success) addCondition(target, spell.effect.condition, spell.effect.rounds);
        results.push({ targetId, saved: save.success, saveRoll: save.total, condition: save.success ? undefined : spell.effect.condition });
        break;
      }
      case 'utility':
        results.push({ targetId, note: spell.effect.note });
        break;
    }
  }

  logEntry(
    state,
    'attack',
    `${caster.name} 施放「${spell.name}」${spell.level > 0 ? `（${slotLevel} 环）` : ''}：${results
      .map((result) => {
        const targetName = getCombatant(state, result.targetId).name;
        if (result.damage !== undefined) return `${targetName} 受 ${result.damage} 伤害${result.saved ? '（豁免成功）' : ''}`;
        if (result.healed !== undefined) return `${targetName} 恢复 ${result.healed} HP`;
        if (result.condition) return `${targetName} 陷入${result.condition}`;
        return result.note ?? '';
      })
      .join('；')}`,
    { spellId: spell.id, slotLevel, results },
  );

  return { ok: true, casterId: caster.id, spellId: spell.id, spellName: spell.name, slotLevel, results };
}
