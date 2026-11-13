/**
 * 内容格式（世界书 / 模组）的类型与校验。
 *
 * 玩家卡契约在引擎里（CharacterCard）；这里只管 GM 侧内容。
 * 校验保持零依赖：内容作者可以在 CLI 里直接跑 `pnpm test` 得到人话错误。
 */
import { SKILL_ABILITY, type SkillId, type ValidationReport } from '@dsh-trpg/engine';

export type Visibility = 'public' | 'gm' | `player:${string}`;

export interface LoreEntry {
  id: string;
  title?: string;
  keys: string[];
  visibility: Visibility;
  priority: number;
  alwaysOn?: boolean;
  content: string;
  tags?: string[];
}

export interface LorebookDef {
  schemaVersion: 1;
  id: string;
  title: string;
  entries: LoreEntry[];
}

export interface NpcDef {
  id: string;
  name: string;
  description: string;
}

export interface BeatDef {
  id: string;
  trigger: string;
  effect: string;
}

export interface CheckDef {
  when: string;
  skill: SkillId;
  dc: number;
  success: string;
  failure: string;
  private?: boolean;
}

export interface MonsterGroup {
  monsterId: string;
  count: number;
}

export interface EncounterDef {
  id: string;
  monsters: MonsterGroup[];
  note?: string;
}

export interface RewardDef {
  xp: number;
  items: string[];
  note?: string;
}

export interface SceneDef {
  id: string;
  title: string;
  entry: string;
  npcs?: string[];
  lore?: string[];
  beats?: BeatDef[];
  checks?: CheckDef[];
  encounters?: EncounterDef[];
  rewards?: RewardDef[];
}

export interface SecretDef {
  id: string;
  content: string;
  revealWhen: string;
}

export interface ModuleDef {
  schemaVersion: 1;
  id: string;
  title: string;
  ruleId: string;
  level: [number, number];
  playerCount: [number, number];
  durationMinutes: number;
  synopsis: string;
  gmNotes?: string;
  npcs: NpcDef[];
  scenes: SceneDef[];
  secrets: SecretDef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isVisibility(value: unknown): value is Visibility {
  return (
    value === 'public' ||
    value === 'gm' ||
    (typeof value === 'string' && value.startsWith('player:') && value.length > 'player:'.length)
  );
}

export function validateLorebook(input: unknown): ValidationReport<LorebookDef> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['世界书必须是对象'] };
  if (input.schemaVersion !== 1) errors.push('世界书 schemaVersion 必须为 1');
  if (!isNonEmptyString(input.id)) errors.push('世界书 id 必填');
  if (!isNonEmptyString(input.title)) errors.push('世界书 title 必填');
  if (!Array.isArray(input.entries)) {
    errors.push('entries 必须是数组');
  } else {
    const ids = new Set<string>();
    input.entries.forEach((entry, index) => {
      if (!isRecord(entry)) {
        errors.push(`entries[${index}] 必须是对象`);
        return;
      }
      if (!isNonEmptyString(entry.id)) errors.push(`entries[${index}].id 必填`);
      else if (ids.has(entry.id)) errors.push(`entries[${index}].id 重复：${entry.id}`);
      else ids.add(entry.id);
      if (!Array.isArray(entry.keys) || entry.keys.length === 0 || entry.keys.some((key) => !isNonEmptyString(key))) {
        errors.push(`entries[${index}].keys 必须是非空字符串数组`);
      }
      if (!isVisibility(entry.visibility)) errors.push(`entries[${index}].visibility 非法`);
      if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority)) {
        errors.push(`entries[${index}].priority 必须是数字`);
      }
      if (!isNonEmptyString(entry.content)) errors.push(`entries[${index}].content 必填`);
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], value: input as unknown as LorebookDef };
}

export function validateModule(input: unknown): ValidationReport<ModuleDef> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['模组必须是对象'] };
  if (input.schemaVersion !== 1) errors.push('模组 schemaVersion 必须为 1');
  if (!isNonEmptyString(input.id)) errors.push('模组 id 必填');
  if (!isNonEmptyString(input.title)) errors.push('模组 title 必填');
  if (!isNonEmptyString(input.ruleId)) errors.push('模组 ruleId 必填');
  if (!isNonEmptyString(input.synopsis)) errors.push('模组 synopsis 必填');
  if (!Array.isArray(input.level) || input.level.length !== 2) errors.push('level 必须是 [min,max]');
  if (!Array.isArray(input.playerCount) || input.playerCount.length !== 2) errors.push('playerCount 必须是 [min,max]');
  if (typeof input.durationMinutes !== 'number' || input.durationMinutes <= 0) errors.push('durationMinutes 必须是正数');

  if (!Array.isArray(input.npcs)) errors.push('npcs 必须是数组');
  if (!Array.isArray(input.secrets)) errors.push('secrets 必须是数组');

  if (!Array.isArray(input.scenes) || input.scenes.length === 0) {
    errors.push('scenes 至少需要一幕');
  } else {
    const sceneIds = new Set<string>();
    input.scenes.forEach((scene, index) => {
      if (!isRecord(scene)) {
        errors.push(`scenes[${index}] 必须是对象`);
        return;
      }
      if (!isNonEmptyString(scene.id)) errors.push(`scenes[${index}].id 必填`);
      else if (sceneIds.has(scene.id)) errors.push(`scenes[${index}].id 重复：${scene.id}`);
      else sceneIds.add(scene.id);
      if (!isNonEmptyString(scene.title)) errors.push(`scenes[${index}].title 必填`);
      if (!isNonEmptyString(scene.entry)) errors.push(`scenes[${index}].entry 必填（开场旁白）`);

      if (scene.checks !== undefined) {
        if (!Array.isArray(scene.checks)) {
          errors.push(`scenes[${index}].checks 必须是数组`);
        } else {
          scene.checks.forEach((check, checkIndex) => {
            if (!isRecord(check)) {
              errors.push(`scenes[${index}].checks[${checkIndex}] 必须是对象`);
              return;
            }
            if (typeof check.skill !== 'string' || !Object.hasOwn(SKILL_ABILITY, check.skill)) {
              errors.push(`scenes[${index}].checks[${checkIndex}].skill 非法：${String(check.skill)}`);
            }
            if (typeof check.dc !== 'number' || check.dc < 1 || check.dc > 30) {
              errors.push(`scenes[${index}].checks[${checkIndex}].dc 必须是 1-30`);
            }
            if (!isNonEmptyString(check.success) || !isNonEmptyString(check.failure)) {
              errors.push(`scenes[${index}].checks[${checkIndex}] 需要 success/failure 文案`);
            }
          });
        }
      }

      if (scene.encounters !== undefined) {
        if (!Array.isArray(scene.encounters)) {
          errors.push(`scenes[${index}].encounters 必须是数组`);
        } else {
          scene.encounters.forEach((encounter, encounterIndex) => {
            if (!isRecord(encounter)) {
              errors.push(`scenes[${index}].encounters[${encounterIndex}] 必须是对象`);
              return;
            }
            if (!isNonEmptyString(encounter.id)) errors.push(`scenes[${index}].encounters[${encounterIndex}].id 必填`);
            if (!Array.isArray(encounter.monsters) || encounter.monsters.length === 0) {
              errors.push(`scenes[${index}].encounters[${encounterIndex}].monsters 至少需要一个怪物组`);
            } else {
              encounter.monsters.forEach((group, groupIndex) => {
                if (!isRecord(group) || !isNonEmptyString(group.monsterId) || typeof group.count !== 'number' || group.count < 1) {
                  errors.push(`scenes[${index}].encounters[${encounterIndex}].monsters[${groupIndex}] 需要 monsterId 与 count>=1`);
                }
              });
            }
          });
        }
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], value: input as unknown as ModuleDef };
}
