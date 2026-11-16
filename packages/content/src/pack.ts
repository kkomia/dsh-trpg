/**
 * 内容包（Content Pack）统一模型：`trpg.pack/1`。
 *
 * 一个包 = 元数据 + `ruleSystem` 引用 + 1 个模组（`modules[]`，v1 长度 1）+ 1 本世界书
 * + pack 内置卡库（`cards[]`）。制作/分发单元是 `.trpgpack`（ZIP，见 `pack-zip.ts`），
 * 但本文件只做纯数据层：类型、校验、旧格式迁移、D12 兼容适配，不碰 zip / 文件系统。
 *
 * 校验约定（CONTENT-MODEL §2.2 / §9 / UI-CONTRACT §1.2/§1.4）：
 * - 错误聚合返回（`errors: string[]`，全中文人话），一次给出全部问题，不 fail-fast；
 * - 除字段合法性外，重点查「引用完整性」与「重 id」：pack.defaultModuleId、module.startSceneId、
 *   scene.{loreIds,npcIds,encounterIds,rewardIds}、card.ruleSystem 等；
 * - 素材引用（`icon`）在传入 `assetPaths` / `assets` 时校验存在性；
 * - 传入素材字节时，若 zip 内含 `assets/manifest.json`（`trpg.assets/1`），额外校验资产清单
 *   （file 存在、bytes/sha256 匹配、被引用的 assetId 存在、孤立资产 warning，见 `asset-manifest.ts`）；
 *   没有清单时保持 M8.1 行为（孤立素材逐文件 warning）。
 *
 * 兼容（D12）：`migratePack()` 把旧草案/旧源码形状迁移到 v1；`toCharacterCard()` /
 * `toLegacyModuleDef()` / `toLegacyLorebook()` 把 pack 反推回旧导出形状，
 * `GUIMUYA_*` / `CARDS` 等旧导出靠它们保持稳定。
 */
import {
  SKILL_ABILITY,
  validateCharacterCard,
  type CharacterCard,
  type SkillId,
} from '@dsh-trpg/engine';
import type { LorebookDef, ModuleDef, SceneDef, Visibility } from './schema.ts';
import { verifyPackScripts, type PackScriptsInput } from './pack-scripts.ts';
import { RULE_PACK_SCHEMA_VERSION, validateRulePack, type RulePack } from './rules-bridge.ts';
import { ASSET_MANIFEST_ENTRY, verifyPackAssetManifest } from './asset-manifest.ts';

export const CONTENT_PACK_SCHEMA_VERSION = 'trpg.pack/1';

/** 子对象（module / lorebook / card）各自的 schemaVersion。 */
export const CONTENT_PACK_OBJECT_SCHEMA_VERSION = 1;

/** packId 规范：小写 slug，内置包保留 `core-` 前缀。 */
export const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 版本号规范：semver（允许 prerelease / build 后缀）。 */
export const PACK_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 素材路径规范：只允许 `assets/**` 相对路径。 */
export const ASSET_PATH_PREFIX = 'assets/';

export interface PackRuleSystem {
  /** 规则 id，例如 `dnd5e-lite`。 */
  id: string;
  /** 规则展示名，例如 `D&D 5e-lite`。 */
  name: string;
}

/** `validatePack()` 可选注入的规则数据索引：查到就校验，查不到不阻断。 */
export interface PackRuleDataIndex {
  monsterIds?: Iterable<string>;
  itemIds?: Iterable<string>;
  spellIds?: Iterable<string>;
}

/** 素材字节输入：`assets/xxx.png` → 字节（字符串按 UTF-8 编码）。 */
export type PackAssetBytesInput = Map<string, Uint8Array> | Record<string, Uint8Array | string>;

export interface PackValidateOptions {
  /**
   * 包内实际携带的素材字节（zip 解码 / 导出时传入）：`assets/**` 路径 → 字节。
   * 传入后：校验 icon 引用、`assets/manifest.json`（含 bytes/sha256）与 assetId 引用完整性
   * （UI-CONTRACT §1.2/§1.4）。
   */
  assets?: PackAssetBytesInput;
  /**
   * 包内实际携带的素材路径（只有路径、没有字节的场景，如 host 列内置包）；
   * 传入后校验 icon 引用存在性 + 清单的结构/文件存在性（跳过 bytes/sha256）。
   */
  assetPaths?: Iterable<string>;
  /**
   * `assets/manifest.json` 的原始文本（不含在 `assets` 里时单独传，如源码目录读取）：
   * 用于「有清单但没读素材字节」的降级校验（结构与 file 存在性，跳过 sha256）。
   */
  assetManifestText?: string;
  /** 规则数据索引（怪物/物品/法术 id）；由调用方按规则系统提供。 */
  ruleData?: PackRuleDataIndex;
  /**
   * 包内实际携带的规则脚本（`rules/scripts/**.js`）：传入后校验 `pack.rules.scripts[]`
   * 声明的文件都存在且 sha256 一致（docs/RULES-MODEL §3/§6/§10）。
   * 不传 = 只做结构校验并跳过 sha256（host 列内置包等「没读字节」的场景）；
   * 导出/导入/加载这些包边界一律会传（见 `pack-zip.ts` / `pack-io.ts`）。
   */
  scripts?: PackScriptsInput;
}

export interface PackValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  value?: ContentPack;
}

export interface PackCardOwner {
  /** pack 内置预制卡约定为 null；玩家私卡本地生成 id。 */
  playerId: string | null;
  displayName?: string;
}

/**
 * 规范化角色卡定义：复用 engine 的 `CharacterCard` 字段契约，只把主键改成 `cardId`，
 * 并显式带上 `ruleSystem` 引用；落座前用 `toCharacterCard()` 转回 engine 形状。
 */
export interface CharacterCardDef extends Omit<CharacterCard, 'id' | 'owner'> {
  cardId: string;
  owner?: PackCardOwner;
  /** 显式规则引用；缺省时由 pack.ruleSystem 兜底（校验不强制）。 */
  ruleSystem?: PackRuleSystem;
}

export interface PackNpcDef {
  npcId: string;
  name: string;
  description: string;
}

export interface PackBeatDef {
  beatId: string;
  trigger: string;
  effect: string;
}

export interface PackCheckDef {
  checkId: string;
  when: string;
  skill: SkillId;
  dc: number;
  success: string;
  failure: string;
  private?: boolean;
}

export interface PackMonsterGroup {
  monsterId: string;
  count: number;
}

export interface PackEncounterDef {
  encounterId: string;
  monsters: PackMonsterGroup[];
  note?: string;
}

export interface PackRewardDef {
  rewardId: string;
  xp: number;
  items: string[];
  note?: string;
}

export interface PackSceneDef {
  sceneId: string;
  title: string;
  entry: string;
  npcIds?: string[];
  loreIds?: string[];
  beats?: PackBeatDef[];
  checks?: PackCheckDef[];
  /** 引用模组级 `encounters[]`。 */
  encounterIds?: string[];
  /** 引用模组级 `rewards[]`。 */
  rewardIds?: string[];
}

export interface PackSecretDef {
  secretId: string;
  content: string;
  revealWhen: string;
}

export interface PackModuleDef {
  schemaVersion: 1;
  moduleId: string;
  title: string;
  level: [number, number];
  playerCount: [number, number];
  durationMinutes: number;
  synopsis: string;
  gmNotes?: string;
  /** 起始场景：必须是本模组 `scenes[].sceneId` 之一。 */
  startSceneId: string;
  npcs: PackNpcDef[];
  scenes: PackSceneDef[];
  encounters: PackEncounterDef[];
  rewards: PackRewardDef[];
  secrets: PackSecretDef[];
}

export interface PackLoreEntry {
  loreId: string;
  title?: string;
  keys: string[];
  visibility: Visibility;
  priority: number;
  alwaysOn?: boolean;
  content: string;
  tags?: string[];
}

export interface PackLorebookDef {
  schemaVersion: 1;
  lorebookId: string;
  title: string;
  entries: PackLoreEntry[];
}

/** `.trpgpack` 内 `pack.json` 的完整形状。 */
export interface ContentPack {
  schemaVersion: typeof CONTENT_PACK_SCHEMA_VERSION;
  packId: string;
  name: string;
  version: string;
  author: string;
  description?: string;
  license?: string;
  /** 封面/图标：`assets/...` 相对路径，或内联 SVG 小图标（≤ 32 KiB 建议）。 */
  icon?: string;
  ruleSystem: PackRuleSystem;
  /**
   * 内联规则包（`trpg.rules/1`，docs/RULES-MODEL §3）：属性/资源/公式/动作/物品/成长/行动经济等数据段。
   * 规则脚本**不内联**：`rules.scripts[].file` 指向 zip 内的 `rules/scripts/*.js` 独立条目，
   * 这里只记 `{ file, sha256 }`（见 `pack-scripts.ts`）。缺省 = 内容包引用宿主内置规则。
   */
  rules?: RulePack;
  /** v1 必须等于 `modules[0].moduleId`。 */
  defaultModuleId: string;
  modules: PackModuleDef[];
  lorebook: PackLorebookDef;
  cards: CharacterCardDef[];
}

/** 校验失败时抛出，带全部聚合错误。 */
export class PackValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`内容包校验失败（${errors.length} 个问题）：\n- ${errors.join('\n- ')}`);
    this.name = 'PackValidationError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// 基础类型守卫
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function isVisibility(value: unknown): value is Visibility {
  return (
    value === 'public' ||
    value === 'gm' ||
    (typeof value === 'string' && value.startsWith('player:') && value.length > 'player:'.length)
  );
}

function isNumberTuple(value: unknown): value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const min = value[0];
  const max = value[1];
  return (
    typeof min === 'number' &&
    typeof max === 'number' &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min <= max
  );
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) if (isNonEmptyString(value)) return value;
  return undefined;
}

/** 素材路径是否合法：`assets/` 前缀、相对、无 `..` / 盘符 / 控制字符。 */
export function isSafePackAssetPath(path: string): boolean {
  if (!path.startsWith(ASSET_PATH_PREFIX)) return false;
  if (path.length <= ASSET_PATH_PREFIX.length) return false;
  if (path.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false;
  return true;
}

/** 素材字节输入规范化成 Map（字符串按 UTF-8 编码）；未传返回 undefined。 */
function normalizeAssetBytes(input: PackAssetBytesInput | undefined): Map<string, Uint8Array> | undefined {
  if (input === undefined) return undefined;
  const encoder = new TextEncoder();
  const output = new Map<string, Uint8Array>();
  const entries: Array<[string, Uint8Array | string]> =
    input instanceof Map ? [...input.entries()] : Object.entries(input);
  for (const [name, data] of entries) {
    output.set(name, typeof data === 'string' ? encoder.encode(data) : data);
  }
  return output;
}

// ---------------------------------------------------------------------------
// 校验：validatePack / assertContentPack
// ---------------------------------------------------------------------------

/**
 * 校验一个 `pack.json`（规范化 v1 形状）。返回聚合错误与 warning，不抛异常。
 * 需要兼容旧格式时先用 `migratePack()`。
 */
export function validatePack(input: unknown, options: PackValidateOptions = {}): PackValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string): void => {
    errors.push(message);
  };

  if (!isRecord(input)) {
    return { ok: false, errors: ['内容包必须是对象（pack.json 顶层是一个 JSON 对象）'], warnings };
  }

  // ---- 顶部元数据 ----
  if (input.schemaVersion !== CONTENT_PACK_SCHEMA_VERSION) {
    fail(
      `schemaVersion 必须为 "${CONTENT_PACK_SCHEMA_VERSION}"，当前为 ${JSON.stringify(input.schemaVersion)}`,
    );
  }
  if (!isNonEmptyString(input.packId)) fail('packId 必填');
  else if (!PACK_ID_PATTERN.test(input.packId)) {
    fail(`packId 必须是小写 slug（如 my-pack），当前为 "${input.packId}"`);
  }
  if (!isNonEmptyString(input.name)) fail('name 必填');
  if (!isNonEmptyString(input.version)) fail('version 必填');
  else if (!PACK_VERSION_PATTERN.test(input.version)) {
    fail(`version 必须是 semver（如 1.0.0），当前为 "${input.version}"`);
  }
  if (!isOptionalString(input.author)) fail('author 必须是字符串');
  if (!isNonEmptyString(input.author)) fail('author 必填');
  if (!isOptionalString(input.description)) fail('description 必须是字符串');
  if (!isOptionalString(input.license)) fail('license 必须是字符串');
  if (!isOptionalString(input.icon)) fail('icon 必须是字符串');
  const packIcon = input.icon;
  if (typeof packIcon === 'string' && packIcon.length > 0 && !packIcon.startsWith(ASSET_PATH_PREFIX) && !packIcon.startsWith('<svg')) {
    fail(`icon 必须是 assets/ 相对路径或内联 SVG，当前为 "${packIcon}"`);
  }

  let ruleSystemId: string | undefined;
  const ruleSystem = input.ruleSystem;
  if (!isRecord(ruleSystem)) {
    fail('ruleSystem 必填（{ id, name }）');
  } else {
    if (!isNonEmptyString(ruleSystem.id)) fail('ruleSystem.id 必填');
    else ruleSystemId = ruleSystem.id;
    if (!isNonEmptyString(ruleSystem.name)) fail('ruleSystem.name 必填');
  }

  const monsterIds =
    options.ruleData?.monsterIds !== undefined ? new Set(options.ruleData.monsterIds) : undefined;
  const itemIds = options.ruleData?.itemIds !== undefined ? new Set(options.ruleData.itemIds) : undefined;
  const spellIds = options.ruleData?.spellIds !== undefined ? new Set(options.ruleData.spellIds) : undefined;

  // ---- 世界书（先校验，模组的 loreIds 要用） ----
  const loreIds = new Set<string>();
  const lorebook = input.lorebook;
  if (!isRecord(lorebook)) {
    fail('lorebook 必填（v1 一个包只带 1 本世界书）');
  } else {
    if (lorebook.schemaVersion !== CONTENT_PACK_OBJECT_SCHEMA_VERSION) {
      fail('lorebook.schemaVersion 必须为 1');
    }
    if (!isNonEmptyString(lorebook.lorebookId)) fail('lorebook.lorebookId 必填');
    if (!isNonEmptyString(lorebook.title)) fail('lorebook.title 必填');
    const entries = lorebook.entries;
    if (!Array.isArray(entries)) {
      fail('lorebook.entries 必须是数组');
    } else {
      entries.forEach((entry, index) => {
        if (!isRecord(entry)) {
          fail(`lorebook.entries[${index}] 必须是对象`);
          return;
        }
        const label = isNonEmptyString(entry.loreId) ? `世界书条目(${entry.loreId})` : `lorebook.entries[${index}]`;
        if (!isNonEmptyString(entry.loreId)) fail(`${label} 的 loreId 必填`);
        else if (loreIds.has(entry.loreId)) fail(`世界书条目 loreId 重复：${entry.loreId}`);
        else loreIds.add(entry.loreId);
        if (!isStringArray(entry.keys) || entry.keys.length === 0) {
          fail(`${label} 的 keys 必须是非空字符串数组`);
        }
        if (!isVisibility(entry.visibility)) fail(`${label} 的 visibility 非法：${JSON.stringify(entry.visibility)}`);
        if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority)) {
          fail(`${label} 的 priority 必须是数字`);
        }
        if (!isNonEmptyString(entry.content)) fail(`${label} 的 content 必填`);
        if (!isOptionalString(entry.title)) fail(`${label} 的 title 必须是字符串`);
        if (entry.alwaysOn !== undefined && typeof entry.alwaysOn !== 'boolean') {
          fail(`${label} 的 alwaysOn 必须是布尔值`);
        }
        if (entry.tags !== undefined && !isStringArray(entry.tags)) {
          fail(`${label} 的 tags 必须是字符串数组`);
        }
      });
    }
  }

  // ---- 模组 ----
  const modules = input.modules;
  const moduleIds = new Set<string>();
  if (!Array.isArray(modules)) {
    fail('modules 必须是数组');
  } else {
    if (modules.length !== 1) {
      fail(`modules 长度必须为 1（v1 一个包只带 1 个模组），当前为 ${modules.length}`);
    }
    modules.forEach((module, moduleIndex) => {
      validatePackModule(module, moduleIndex, { loreIds, monsterIds, itemIds, fail }, moduleIds);
    });
  }

  if (!isNonEmptyString(input.defaultModuleId)) {
    fail('defaultModuleId 必填');
  } else if (moduleIds.size > 0 && !moduleIds.has(input.defaultModuleId)) {
    fail(`defaultModuleId "${input.defaultModuleId}" 不在 modules[].moduleId 中`);
  } else if (Array.isArray(modules) && modules.length === 1) {
    const onlyModule = modules[0];
    if (isRecord(onlyModule) && isNonEmptyString(onlyModule.moduleId) && input.defaultModuleId !== onlyModule.moduleId) {
      fail(`defaultModuleId 必须等于 modules[0].moduleId（"${onlyModule.moduleId}"）`);
    }
  }

  // ---- 角色卡（pack 内置卡库） ----
  const cards = input.cards;
  const cardIds = new Set<string>();
  if (!Array.isArray(cards)) {
    fail('cards 必须是数组');
  } else {
    cards.forEach((card, index) => {
      if (!isRecord(card)) {
        fail(`cards[${index}] 必须是对象`);
        return;
      }
      const cardId = isNonEmptyString(card.cardId) ? card.cardId : undefined;
      const label = cardId ? `角色卡(${cardId})` : `cards[${index}]`;
      if (!cardId) fail(`${label} 的 cardId 必填`);
      else if (cardIds.has(cardId)) fail(`角色卡 cardId 重复：${cardId}`);
      else cardIds.add(cardId);

      if (card.owner !== undefined) {
        if (!isRecord(card.owner)) {
          fail(`${label} 的 owner 必须是对象`);
        } else {
          const playerId = card.owner.playerId;
          if (playerId !== null && playerId !== undefined && !isNonEmptyString(playerId)) {
            fail(`${label} 的 owner.playerId 必须是字符串或 null（预制卡用 null）`);
          }
          if (!isOptionalString(card.owner.displayName)) fail(`${label} 的 owner.displayName 必须是字符串`);
        }
      }

      // 显式规则引用 + 旧 source.ruleId 都必须与 pack.ruleSystem 一致
      if (card.ruleSystem !== undefined) {
        if (!isRecord(card.ruleSystem) || !isNonEmptyString(card.ruleSystem.id)) {
          fail(`${label} 的 ruleSystem 必须是 { id, name }`);
        } else if (ruleSystemId && card.ruleSystem.id !== ruleSystemId) {
          fail(`${label} 的 ruleSystem.id "${card.ruleSystem.id}" 与 pack.ruleSystem.id "${ruleSystemId}" 不一致`);
        }
      }
      if (isRecord(card.source) && isNonEmptyString(card.source.ruleId)) {
        if (ruleSystemId && card.source.ruleId !== ruleSystemId) {
          fail(`${label} 的 source.ruleId "${card.source.ruleId}" 与 pack.ruleSystem.id "${ruleSystemId}" 不一致`);
        }
      }

      if (cardId) {
        // 复用 engine 的角色卡校验（落座前同一套契约），错误带上包内位置
        const normalized: Record<string, unknown> = { ...card, id: cardId };
        const report = validateCharacterCard(normalized);
        for (const error of report.errors) fail(`${label}：${error}`);
        if (spellIds && isRecord(card.spells) && Array.isArray(card.spells.known)) {
          for (const spellId of card.spells.known) {
            if (typeof spellId === 'string' && !spellIds.has(spellId)) {
              fail(`${label} 的法术 ${spellId} 不在规则集中`);
            }
          }
        }
      }
    });
  }

  // ---- 规则包（可选段：trpg.rules/1） ----
  const rules = input.rules;
  if (rules !== undefined) {
    if (!isRecord(rules)) {
      fail('rules 必须是对象（trpg.rules/1 规则包数据段）');
    } else {
      let ruleReport: ReturnType<typeof validateRulePack> | undefined;
      try {
        ruleReport = validateRulePack(rules);
      } catch (error) {
        fail(`规则包校验异常：${error instanceof Error ? error.message : String(error)}`);
      }
      if (ruleReport !== undefined) {
        for (const error of ruleReport.errors) fail(`规则包（pack.rules）：${error}`);
        for (const warning of ruleReport.warnings) warnings.push(`规则包（pack.rules）：${warning}`);
        const declaredRulesId = rules.rulesId;
        if (
          ruleSystemId !== undefined &&
          isNonEmptyString(declaredRulesId) &&
          declaredRulesId !== ruleSystemId
        ) {
          fail(`规则包 rulesId "${declaredRulesId}" 与 pack.ruleSystem.id "${ruleSystemId}" 不一致`);
        }
      }
      // 脚本条目 ↔ `pack.rules.scripts` 清单（存在性 + sha256）；规则包结构坏了就不重复报脚本错误
      if (ruleReport === undefined || ruleReport.ok) {
        const scriptReport = verifyPackScripts(ruleReport?.value, options.scripts);
        for (const error of scriptReport.errors) fail(error);
        for (const warning of scriptReport.warnings) warnings.push(warning);
      }
    }
  } else if (options.scripts !== undefined) {
    // 有脚本条目但规则包没声明：当作孤立脚本提示（不阻断，便于作者暂存草稿）
    const scriptReport = verifyPackScripts(undefined, options.scripts);
    for (const error of scriptReport.errors) fail(error);
    for (const warning of scriptReport.warnings) warnings.push(warning);
  }

  // ---- 素材引用（M8.1 路径检查 + M9.5b 资产清单校验） ----
  // 素材字节（zip 解码/导出）优先；只有路径时退化为存在性校验（不阻断 sha256 校验）。
  const assetBytes = normalizeAssetBytes(options.assets);
  const declaredPaths =
    assetBytes !== undefined
      ? [...assetBytes.keys()]
      : options.assetPaths !== undefined
        ? [...options.assetPaths]
        : undefined;
  // 清单条目：显式文本优先，其次从素材字节里取 `assets/manifest.json`
  const manifestInput: string | Uint8Array | undefined =
    options.assetManifestText ?? assetBytes?.get(ASSET_MANIFEST_ENTRY);
  if (declaredPaths !== undefined) {
    const declared = new Set<string>();
    for (const assetPath of declaredPaths) {
      // 清单是元数据条目，不是素材（否则会误报孤立素材）
      if (assetPath === ASSET_MANIFEST_ENTRY) continue;
      if (typeof assetPath !== 'string' || !isSafePackAssetPath(assetPath)) {
        fail(`素材路径非法（必须是以 assets/ 开头的相对路径）：${String(assetPath)}`);
      } else {
        declared.add(assetPath);
      }
    }
    const icon = input.icon;
    if (isNonEmptyString(icon) && icon.startsWith(ASSET_PATH_PREFIX)) {
      if (!declared.has(icon)) fail(`icon 引用的素材不存在：${icon}`);
    }
    // 有资产清单时，孤立资产由清单校验给出（以 assetId 为口径）；无清单沿用 M8.1 的逐文件口径。
    if (manifestInput === undefined) {
      for (const assetPath of [...declared].sort()) {
        if (isNonEmptyString(icon) && icon === assetPath) continue;
        warnings.push(`孤立素材（pack.json 未引用，不阻断）：${assetPath}`);
      }
    }
  }
  if (manifestInput !== undefined) {
    const assetReport = verifyPackAssetManifest({
      manifest: manifestInput,
      pack: input,
      ...(declaredPaths !== undefined ? { files: declaredPaths } : {}),
      ...(assetBytes !== undefined ? { contents: assetBytes } : {}),
    });
    for (const item of assetReport.errors) fail(item.message);
    for (const item of assetReport.warnings) warnings.push(item.message);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, errors: [], warnings, value: input as unknown as ContentPack };
}

interface ModuleValidateContext {
  loreIds: Set<string>;
  monsterIds?: Set<string>;
  itemIds?: Set<string>;
  fail: (message: string) => void;
}

function validatePackModule(
  module: unknown,
  moduleIndex: number,
  context: ModuleValidateContext,
  moduleIds: Set<string>,
): void {
  const { fail, loreIds, monsterIds, itemIds } = context;
  const label = `modules[${moduleIndex}]`;
  if (!isRecord(module)) {
    fail(`${label} 必须是对象`);
    return;
  }
  if (module.schemaVersion !== CONTENT_PACK_OBJECT_SCHEMA_VERSION) fail(`${label}.schemaVersion 必须为 1`);
  if (!isNonEmptyString(module.moduleId)) fail(`${label}.moduleId 必填`);
  else if (moduleIds.has(module.moduleId)) fail(`模组 moduleId 重复：${module.moduleId}`);
  else moduleIds.add(module.moduleId);
  if (!isNonEmptyString(module.title)) fail(`${label}.title 必填`);
  if (!isNumberTuple(module.level)) fail(`${label}.level 必须是 [min,max] 且 min<=max`);
  if (!isNumberTuple(module.playerCount)) fail(`${label}.playerCount 必须是 [min,max] 且 min<=max`);
  if (typeof module.durationMinutes !== 'number' || !Number.isFinite(module.durationMinutes) || module.durationMinutes <= 0) {
    fail(`${label}.durationMinutes 必须是正数`);
  }
  if (!isNonEmptyString(module.synopsis)) fail(`${label}.synopsis 必填`);
  if (!isOptionalString(module.gmNotes)) fail(`${label}.gmNotes 必须是字符串`);

  // NPC
  const npcIds = new Set<string>();
  if (!Array.isArray(module.npcs)) {
    fail(`${label}.npcs 必须是数组`);
  } else {
    module.npcs.forEach((npc, index) => {
      if (!isRecord(npc)) {
        fail(`${label}.npcs[${index}] 必须是对象`);
        return;
      }
      if (!isNonEmptyString(npc.npcId)) fail(`${label}.npcs[${index}].npcId 必填`);
      else if (npcIds.has(npc.npcId)) fail(`模组内 npcId 重复：${npc.npcId}`);
      else npcIds.add(npc.npcId);
      if (!isNonEmptyString(npc.name)) fail(`${label}.npcs[${index}].name 必填`);
      if (!isNonEmptyString(npc.description)) fail(`${label}.npcs[${index}].description 必填`);
    });
  }

  // 模组级遭遇
  const encounterIds = new Set<string>();
  if (!Array.isArray(module.encounters)) {
    fail(`${label}.encounters 必须是数组（旧的内联遭遇请先 migratePack）`);
  } else {
    module.encounters.forEach((encounter, index) => {
      if (!isRecord(encounter)) {
        fail(`${label}.encounters[${index}] 必须是对象`);
        return;
      }
      const encLabel = isNonEmptyString(encounter.encounterId)
        ? `遭遇(${encounter.encounterId})`
        : `${label}.encounters[${index}]`;
      if (!isNonEmptyString(encounter.encounterId)) fail(`${label}.encounters[${index}].encounterId 必填`);
      else if (encounterIds.has(encounter.encounterId)) fail(`encounterId 重复：${encounter.encounterId}`);
      else encounterIds.add(encounter.encounterId);
      if (!Array.isArray(encounter.monsters) || encounter.monsters.length === 0) {
        fail(`${encLabel} 的 monsters 至少需要一个怪物组`);
      } else {
        encounter.monsters.forEach((group, groupIndex) => {
          if (!isRecord(group) || !isNonEmptyString(group.monsterId) || typeof group.count !== 'number' || group.count < 1) {
            fail(`${encLabel} 的 monsters[${groupIndex}] 需要 monsterId 与 count>=1`);
            return;
          }
          if (monsterIds && !monsterIds.has(group.monsterId)) {
            fail(`${encLabel} 引用了规则集中不存在的怪物：${group.monsterId}`);
          }
        });
      }
      if (!isOptionalString(encounter.note)) fail(`${encLabel} 的 note 必须是字符串`);
    });
  }

  // 模组级奖励
  const rewardIds = new Set<string>();
  if (!Array.isArray(module.rewards)) {
    fail(`${label}.rewards 必须是数组（旧的内联奖励请先 migratePack）`);
  } else {
    module.rewards.forEach((reward, index) => {
      if (!isRecord(reward)) {
        fail(`${label}.rewards[${index}] 必须是对象`);
        return;
      }
      const rewardLabel = isNonEmptyString(reward.rewardId)
        ? `奖励(${reward.rewardId})`
        : `${label}.rewards[${index}]`;
      if (!isNonEmptyString(reward.rewardId)) fail(`${label}.rewards[${index}].rewardId 必填`);
      else if (rewardIds.has(reward.rewardId)) fail(`rewardId 重复：${reward.rewardId}`);
      else rewardIds.add(reward.rewardId);
      if (typeof reward.xp !== 'number' || !Number.isFinite(reward.xp) || reward.xp < 0) {
        fail(`${rewardLabel} 的 xp 必须是 >= 0 的数字`);
      }
      if (!Array.isArray(reward.items) || !reward.items.every((item) => typeof item === 'string')) {
        fail(`${rewardLabel} 的 items 必须是字符串数组`);
      } else if (itemIds) {
        for (const itemId of reward.items) {
          if (!itemIds.has(itemId)) fail(`${rewardLabel} 引用了规则集中不存在的物品：${itemId}`);
        }
      }
      if (!isOptionalString(reward.note)) fail(`${rewardLabel} 的 note 必须是字符串`);
    });
  }

  // 场景
  const sceneIds = new Set<string>();
  if (!Array.isArray(module.scenes) || module.scenes.length === 0) {
    fail(`${label}.scenes 至少需要一幕`);
  } else {
    module.scenes.forEach((scene, index) => {
      if (!isRecord(scene)) {
        fail(`${label}.scenes[${index}] 必须是对象`);
        return;
      }
      const sceneLabel = isNonEmptyString(scene.sceneId) ? `场景(${scene.sceneId})` : `${label}.scenes[${index}]`;
      if (!isNonEmptyString(scene.sceneId)) fail(`${label}.scenes[${index}].sceneId 必填`);
      else if (sceneIds.has(scene.sceneId)) fail(`sceneId 重复：${scene.sceneId}`);
      else sceneIds.add(scene.sceneId);
      if (!isNonEmptyString(scene.title)) fail(`${sceneLabel} 的 title 必填`);
      if (!isNonEmptyString(scene.entry)) fail(`${sceneLabel} 的 entry 必填（开场旁白）`);

      if (scene.npcIds !== undefined) {
        if (!Array.isArray(scene.npcIds)) fail(`${sceneLabel} 的 npcIds 必须是数组`);
        else {
          for (const npcId of scene.npcIds) {
            if (!isNonEmptyString(npcId) || !npcIds.has(npcId)) {
              fail(`${sceneLabel} 的 npcIds 引用了不存在的 NPC：${String(npcId)}`);
            }
          }
        }
      }
      if (scene.loreIds !== undefined) {
        if (!Array.isArray(scene.loreIds)) fail(`${sceneLabel} 的 loreIds 必须是数组`);
        else {
          for (const loreId of scene.loreIds) {
            if (!isNonEmptyString(loreId) || !loreIds.has(loreId)) {
              fail(`${sceneLabel} 的 loreIds 引用了不存在的世界书条目：${String(loreId)}`);
            }
          }
        }
      }
      if (scene.encounterIds !== undefined) {
        if (!Array.isArray(scene.encounterIds)) fail(`${sceneLabel} 的 encounterIds 必须是数组`);
        else {
          for (const encounterId of scene.encounterIds) {
            if (!isNonEmptyString(encounterId) || !encounterIds.has(encounterId)) {
              fail(`${sceneLabel} 的 encounterIds 引用了不存在的遭遇：${String(encounterId)}`);
            }
          }
        }
      }
      if (scene.rewardIds !== undefined) {
        if (!Array.isArray(scene.rewardIds)) fail(`${sceneLabel} 的 rewardIds 必须是数组`);
        else {
          for (const rewardId of scene.rewardIds) {
            if (!isNonEmptyString(rewardId) || !rewardIds.has(rewardId)) {
              fail(`${sceneLabel} 的 rewardIds 引用了不存在的奖励：${String(rewardId)}`);
            }
          }
        }
      }
      if (scene.beats !== undefined) {
        if (!Array.isArray(scene.beats)) fail(`${sceneLabel} 的 beats 必须是数组`);
        else {
          const beatIds = new Set<string>();
          scene.beats.forEach((beat, beatIndex) => {
            if (!isRecord(beat)) {
              fail(`${sceneLabel} 的 beats[${beatIndex}] 必须是对象`);
              return;
            }
            if (!isNonEmptyString(beat.beatId)) fail(`${sceneLabel} 的 beats[${beatIndex}].beatId 必填`);
            else if (beatIds.has(beat.beatId)) fail(`beatId 重复：${beat.beatId}`);
            else beatIds.add(beat.beatId);
            if (!isNonEmptyString(beat.trigger)) fail(`${sceneLabel} 的 beats[${beatIndex}].trigger 必填`);
            if (!isNonEmptyString(beat.effect)) fail(`${sceneLabel} 的 beats[${beatIndex}].effect 必填`);
          });
        }
      }
      if (scene.checks !== undefined) {
        if (!Array.isArray(scene.checks)) fail(`${sceneLabel} 的 checks 必须是数组`);
        else {
          const checkIds = new Set<string>();
          scene.checks.forEach((check, checkIndex) => {
            if (!isRecord(check)) {
              fail(`${sceneLabel} 的 checks[${checkIndex}] 必须是对象`);
              return;
            }
            const checkLabel = `${sceneLabel} 的 checks[${checkIndex}]`;
            if (!isNonEmptyString(check.checkId)) fail(`${checkLabel}.checkId 必填`);
            else if (checkIds.has(check.checkId)) fail(`checkId 重复：${check.checkId}`);
            else checkIds.add(check.checkId);
            if (typeof check.skill !== 'string' || !Object.hasOwn(SKILL_ABILITY, check.skill)) {
              fail(`${checkLabel}.skill 非法：${String(check.skill)}`);
            }
            if (typeof check.dc !== 'number' || !Number.isInteger(check.dc) || check.dc < 1 || check.dc > 30) {
              fail(`${checkLabel}.dc 必须是 1-30 的整数`);
            }
            if (!isNonEmptyString(check.success) || !isNonEmptyString(check.failure)) {
              fail(`${checkLabel} 需要 success/failure 文案`);
            }
            if (check.private !== undefined && typeof check.private !== 'boolean') {
              fail(`${checkLabel}.private 必须是布尔值`);
            }
          });
        }
      }
    });
  }

  // 起始场景引用
  if (!isNonEmptyString(module.startSceneId)) {
    fail(`${label}.startSceneId 必填（起始场景）`);
  } else if (sceneIds.size > 0 && !sceneIds.has(module.startSceneId)) {
    fail(`${label}.startSceneId "${module.startSceneId}" 不在本模组 scenes[].sceneId 中`);
  }

  // 秘密
  if (!Array.isArray(module.secrets)) {
    fail(`${label}.secrets 必须是数组`);
  } else {
    const secretIds = new Set<string>();
    module.secrets.forEach((secret, index) => {
      if (!isRecord(secret)) {
        fail(`${label}.secrets[${index}] 必须是对象`);
        return;
      }
      if (!isNonEmptyString(secret.secretId)) fail(`${label}.secrets[${index}].secretId 必填`);
      else if (secretIds.has(secret.secretId)) fail(`secretId 重复：${secret.secretId}`);
      else secretIds.add(secret.secretId);
      if (!isNonEmptyString(secret.content)) fail(`${label}.secrets[${index}].content 必填`);
      if (!isNonEmptyString(secret.revealWhen)) fail(`${label}.secrets[${index}].revealWhen 必填`);
    });
  }
}

/** 校验并返回包；不合法直接抛 `PackValidationError`（带全部错误）。 */
export function assertContentPack(input: unknown, options: PackValidateOptions = {}): ContentPack {
  const report = validatePack(input, options);
  if (!report.ok || !report.value) throw new PackValidationError(report.errors);
  return report.value;
}

// ---------------------------------------------------------------------------
// 迁移：旧草案 JSON → trpg.pack/1（migratePack）
// ---------------------------------------------------------------------------

export interface PackMigrationResult {
  /** 迁移后的候选对象（未校验；交给 validatePack）。 */
  pack: unknown;
  warnings: string[];
  /** 是否真的改写了字段（false = 输入已是 v1 规范形状）。 */
  migrated: boolean;
}

interface MigrationContext {
  warnings: string[];
  warn: (message: string) => void;
}

function isCanonicalPack(input: Record<string, unknown>): boolean {
  if (input.schemaVersion !== CONTENT_PACK_SCHEMA_VERSION) return false;
  if (!isRecord(input.ruleSystem) || !isNonEmptyString(input.ruleSystem.id) || !isNonEmptyString(input.ruleSystem.name)) {
    return false;
  }
  if (!Array.isArray(input.modules)) return false;
  if (
    !input.modules.every(
      (module) =>
        isRecord(module) &&
        isNonEmptyString(module.moduleId) &&
        isNonEmptyString(module.startSceneId) &&
        Array.isArray(module.scenes) &&
        Array.isArray(module.encounters) &&
        Array.isArray(module.rewards),
    )
  ) {
    return false;
  }
  if (!isRecord(input.lorebook) || !isNonEmptyString(input.lorebook.lorebookId)) return false;
  if (!Array.isArray(input.lorebook.entries)) return false;
  if (
    !input.lorebook.entries.every((entry) => isRecord(entry) && isNonEmptyString(entry.loreId))
  ) {
    return false;
  }
  if (!Array.isArray(input.cards)) return false;
  if (!input.cards.every((card) => isRecord(card) && isNonEmptyString(card.cardId))) return false;
  return true;
}

/**
 * 把旧草案 / 旧源码形状迁移到 `trpg.pack/1`：
 * - `title` → `name`；`rules` / `ruleSystem.{ruleId,ruleVersion}` → `ruleSystem.{id,name}`；
 * - `module.id` → `moduleId`、`scene.id` → `sceneId`、`npc.id` → `npcId`、`secret.id` → `secretId`；
 * - `scene.lore` → `scene.loreIds`（缺 `entry_` 前缀的按世界书 id 自动补齐）；
 * - 场景内联 `encounters` / `rewards` → 模组级集合 + `scene.encounterIds/rewardIds`（自动补 id）；
 * - 旧模组没有 `startSceneId` → 取第一幕；
 * - `card.id` → `cardId`，并补显式 `ruleSystem`。
 *
 * 已是 v1 规范形状时原样返回（保证 `decode → encode` 字节可复现）。
 */
export function migratePack(input: unknown): PackMigrationResult {
  const warnings: string[] = [];
  const context: MigrationContext = {
    warnings,
    warn: (message: string) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
  };
  if (!isRecord(input)) return { pack: input, warnings, migrated: false };
  if (isCanonicalPack(input)) return { pack: input, warnings, migrated: false };

  let migrated = false;

  // 元数据
  const name = pickString(input.name, input.title);
  if (!isNonEmptyString(input.name) && isNonEmptyString(input.title)) {
    migrated = true;
    context.warn('字段 title 已迁移为 name');
  }
  const packId = pickString(input.packId, input.id);

  // 规则系统
  let ruleSystem = normalizeRuleSystem(input.ruleSystem);
  if (!ruleSystem) {
    ruleSystem = normalizeRuleSystem(input.rules);
    if (ruleSystem) {
      migrated = true;
      context.warn('旧字段 rules 已迁移为 ruleSystem');
    }
  }

  // 世界书
  const rawLorebook =
    input.lorebook ?? (Array.isArray(input.lorebooks) ? input.lorebooks[0] : undefined);
  if (input.lorebook === undefined && rawLorebook !== undefined) {
    migrated = true;
    context.warn('lorebooks[] 已迁移为单个 lorebook');
  }
  const loreMigration = migrateLorebook(rawLorebook, context);
  const loreIds = loreMigration.loreIds;

  // 模组（单个 module 也接受）
  let rawModules: unknown[] = [];
  if (Array.isArray(input.modules)) rawModules = input.modules;
  else if (input.module !== undefined) {
    rawModules = [input.module];
    migrated = true;
    context.warn('旧字段 module 已迁移为 modules[]');
  } else if (input.modules !== undefined) {
    context.warn('modules 不是数组，已按空模组列表迁移');
  }
  const firstModuleRuleId = rawModules
    .map((module) => (isRecord(module) ? pickString(module.ruleId, module.ruleSystemId) : undefined))
    .find((value) => value !== undefined);
  if (!ruleSystem && firstModuleRuleId) {
    ruleSystem = { id: firstModuleRuleId, name: firstModuleRuleId };
    migrated = true;
    context.warn(`ruleSystem 缺失，按模组 ruleId 推导为 "${firstModuleRuleId}"`);
  }

  const modules = rawModules.map((module, index) =>
    migrateModule(module, index, { loreIds, ruleSystem, warn: context.warn, warnings }),
  );
  if (rawModules.some((module) => isRecord(module) && (module.id !== undefined || module.scenes !== undefined))) {
    migrated = true;
  }

  // 角色卡
  if (input.cards !== undefined && !Array.isArray(input.cards)) {
    context.warn('cards 不是数组，已按空卡库迁移');
  }
  const rawCards = Array.isArray(input.cards) ? input.cards : [];
  const cards = rawCards.map((card) => migrateCard(card, ruleSystem, context));

  const author = isNonEmptyString(input.author) ? input.author : 'unknown';
  if (author === 'unknown') context.warn('author 缺失，已填 "unknown"');
  const version = isNonEmptyString(input.version) ? input.version : '0.0.0';
  if (version === '0.0.0') context.warn('version 缺失，已填 "0.0.0"（请尽快改成真实版本）');

  const pack = {
    schemaVersion: CONTENT_PACK_SCHEMA_VERSION,
    packId,
    name,
    version,
    author,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.license !== undefined ? { license: input.license } : {}),
    ...(input.icon !== undefined ? { icon: input.icon } : {}),
    ruleSystem,
    // 规则包数据段（trpg.rules/1）原样透传；注意旧草案里的 `rules: { ruleId }` 是「规则系统引用」，
    // 已在上面迁移成 ruleSystem，不能误当规则包（用 schemaVersion/sheet 判别）。
    ...(isRulePackObject(input.rules) ? { rules: input.rules } : {}),
    defaultModuleId: pickString(input.defaultModuleId, input.defaultModule),
    modules,
    lorebook: loreMigration.lorebook,
    cards,
  };
  return { pack, warnings, migrated: migrated || warnings.length > 0 };
}

/** 判断是否是 `trpg.rules/1` 规则包（而不是旧草案里 `rules: { ruleId }` 的规则系统引用）。 */
function isRulePackObject(value: unknown): value is RulePack {
  if (!isRecord(value)) return false;
  if (value.schemaVersion === RULE_PACK_SCHEMA_VERSION) return true;
  return isRecord(value.sheet) && typeof value.rulesId === 'string';
}

function normalizeRuleSystem(value: unknown): PackRuleSystem | undefined {
  if (isNonEmptyString(value)) return { id: value, name: value };
  if (!isRecord(value)) return undefined;
  const id = pickString(value.id, value.ruleId);
  if (!id) return undefined;
  return { id, name: pickString(value.name) ?? id };
}

function migrateLorebook(
  raw: unknown,
  context: MigrationContext,
): { lorebook: unknown; loreIds: Set<string> | undefined } {
  if (!isRecord(raw)) return { lorebook: raw, loreIds: undefined };
  const lorebookId = pickString(raw.lorebookId, raw.id);
  if (!isNonEmptyString(raw.lorebookId) && isNonEmptyString(raw.id)) {
    context.warn('世界书 id 已迁移为 lorebookId');
  }
  const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
  const loreIds = new Set<string>();
  const entries = entriesRaw.map((entry) => {
    if (!isRecord(entry)) return entry;
    const loreId = pickString(entry.loreId, entry.id);
    if (loreId) loreIds.add(loreId);
    if (!isNonEmptyString(entry.loreId) && isNonEmptyString(entry.id)) {
      context.warn('世界书条目 id 已迁移为 loreId（entry_* 值不变）');
    }
    return {
      ...(loreId !== undefined ? { loreId } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      keys: entry.keys,
      visibility: entry.visibility,
      priority: entry.priority,
      ...(entry.alwaysOn !== undefined ? { alwaysOn: entry.alwaysOn } : {}),
      content: entry.content,
      ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
    };
  });
  return {
    lorebook: {
      schemaVersion: CONTENT_PACK_OBJECT_SCHEMA_VERSION,
      lorebookId,
      title: raw.title,
      entries,
    },
    loreIds,
  };
}

interface ModuleMigrationContext {
  loreIds: Set<string> | undefined;
  ruleSystem: PackRuleSystem | undefined;
  warnings: string[];
  warn: (message: string) => void;
}

function migrateModule(raw: unknown, index: number, context: ModuleMigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const moduleId = pickString(raw.moduleId, raw.id);
  if (!isNonEmptyString(raw.moduleId) && isNonEmptyString(raw.id)) {
    context.warn('模组 id 已迁移为 moduleId');
  }
  const sceneLabelPrefix = moduleId ?? `module_${index + 1}`;

  const encounters: unknown[] = Array.isArray(raw.encounters)
    ? raw.encounters.map((encounter) => migrateEncounter(encounter))
    : [];
  const rewards: unknown[] = Array.isArray(raw.rewards) ? raw.rewards.map((reward) => migrateReward(reward)) : [];

  const scenesRaw = Array.isArray(raw.scenes) ? raw.scenes : [];
  const scenes = scenesRaw.map((sceneRaw, sceneIndex) =>
    migrateScene(sceneRaw, sceneIndex, {
      ...context,
      sceneLabelPrefix,
      encounters,
      rewards,
    }),
  );

  const startSceneId =
    pickString(raw.startSceneId, raw.defaultSceneId) ??
    (isRecord(scenes[0]) ? pickString(scenes[0].sceneId) : undefined);
  if (!isNonEmptyString(raw.startSceneId) && isNonEmptyString(raw.defaultSceneId)) {
    context.warn('模组 defaultSceneId 已迁移为 startSceneId');
  } else if (!isNonEmptyString(raw.startSceneId)) {
    context.warn(`模组缺少 startSceneId，已取第一幕 ${String(startSceneId)}`);
  }

  return {
    schemaVersion: CONTENT_PACK_OBJECT_SCHEMA_VERSION,
    moduleId,
    title: raw.title,
    level: raw.level,
    playerCount: raw.playerCount,
    durationMinutes: raw.durationMinutes,
    synopsis: raw.synopsis,
    ...(raw.gmNotes !== undefined ? { gmNotes: raw.gmNotes } : {}),
    startSceneId,
    npcs: (Array.isArray(raw.npcs) ? raw.npcs : []).map((npc) => migrateNpc(npc, context)),
    scenes,
    encounters,
    rewards,
    secrets: (Array.isArray(raw.secrets) ? raw.secrets : []).map((secret) => migrateSecret(secret, context)),
  };
}

function migrateNpc(raw: unknown, context: MigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const npcId = pickString(raw.npcId, raw.id);
  if (!isNonEmptyString(raw.npcId) && isNonEmptyString(raw.id)) context.warn('NPC id 已迁移为 npcId');
  return {
    ...(npcId !== undefined ? { npcId } : {}),
    name: raw.name,
    description: raw.description,
  };
}

function migrateSecret(raw: unknown, context: MigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const secretId = pickString(raw.secretId, raw.id);
  if (!isNonEmptyString(raw.secretId) && isNonEmptyString(raw.id)) context.warn('秘密 id 已迁移为 secretId');
  return {
    ...(secretId !== undefined ? { secretId } : {}),
    content: raw.content,
    revealWhen: raw.revealWhen,
  };
}

function migrateEncounter(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  return {
    encounterId: pickString(raw.encounterId, raw.id),
    monsters: raw.monsters,
    ...(raw.note !== undefined ? { note: raw.note } : {}),
  };
}

function migrateReward(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  return {
    rewardId: pickString(raw.rewardId, raw.id),
    xp: raw.xp,
    items: raw.items,
    ...(raw.note !== undefined ? { note: raw.note } : {}),
  };
}

interface SceneMigrationContext extends ModuleMigrationContext {
  sceneLabelPrefix: string;
  encounters: unknown[];
  rewards: unknown[];
}

function migrateScene(raw: unknown, index: number, context: SceneMigrationContext): unknown {
  if (!isRecord(raw)) return raw;
  const sceneId = pickString(raw.sceneId, raw.id) ?? `${context.sceneLabelPrefix}_scene_${index + 1}`;
  if (!isNonEmptyString(raw.sceneId) && isNonEmptyString(raw.id)) context.warn('场景 id 已迁移为 sceneId');

  // 世界书引用：lore → loreIds，缺 entry_ 前缀的值按世界书 id 补齐
  const rawLoreRefs = Array.isArray(raw.loreIds) ? raw.loreIds : Array.isArray(raw.lore) ? raw.lore : [];
  const loreIds = rawLoreRefs.map((value) => fixLoreRef(value, context));
  if (!Array.isArray(raw.loreIds) && Array.isArray(raw.lore)) context.warn('场景 lore 已迁移为 loreIds');

  // 旧的内联遭遇 / 奖励上移到模组级
  const encounterIds: string[] = Array.isArray(raw.encounterIds) ? raw.encounterIds.filter(isNonEmptyString) : [];
  if (Array.isArray(raw.encounters)) {
    raw.encounters.forEach((encounter, encounterIndex) => {
      if (!isRecord(encounter)) {
        context.encounters.push(encounter);
        return;
      }
      const encounterId = pickString(encounter.encounterId, encounter.id) ?? `${sceneId}_enc_${encounterIndex + 1}`;
      context.encounters.push({
        encounterId,
        monsters: encounter.monsters,
        ...(encounter.note !== undefined ? { note: encounter.note } : {}),
      });
      encounterIds.push(encounterId);
    });
    context.warn('场景内联遭遇已上移到模组级 encounters[] + scene.encounterIds');
  }

  const rewardIds: string[] = Array.isArray(raw.rewardIds) ? raw.rewardIds.filter(isNonEmptyString) : [];
  if (Array.isArray(raw.rewards)) {
    raw.rewards.forEach((reward, rewardIndex) => {
      if (!isRecord(reward)) {
        context.rewards.push(reward);
        return;
      }
      const rewardId = pickString(reward.rewardId, reward.id) ?? `${sceneId}_reward_${rewardIndex + 1}`;
      context.rewards.push({
        rewardId,
        xp: reward.xp,
        items: reward.items,
        ...(reward.note !== undefined ? { note: reward.note } : {}),
      });
      rewardIds.push(rewardId);
    });
    context.warn('场景内联奖励已上移到模组级 rewards[] + scene.rewardIds');
  }

  // checks：补 checkId；beats：id → beatId
  const checks = Array.isArray(raw.checks)
    ? raw.checks.map((check, checkIndex) => {
        if (!isRecord(check)) return check;
        const checkId = pickString(check.checkId, check.id) ?? `${sceneId}_check_${checkIndex + 1}`;
        return {
          checkId,
          when: check.when,
          skill: check.skill,
          dc: check.dc,
          success: check.success,
          failure: check.failure,
          ...(check.private !== undefined ? { private: check.private } : {}),
        };
      })
    : undefined;
  const beats = Array.isArray(raw.beats)
    ? raw.beats.map((beat, beatIndex) => {
        if (!isRecord(beat)) return beat;
        const beatId = pickString(beat.beatId, beat.id) ?? `${sceneId}_beat_${beatIndex + 1}`;
        return { beatId, trigger: beat.trigger, effect: beat.effect };
      })
    : undefined;

  const npcIds = Array.isArray(raw.npcIds)
    ? raw.npcIds
    : Array.isArray(raw.npcs)
      ? raw.npcs
      : undefined;
  if (!Array.isArray(raw.npcIds) && Array.isArray(raw.npcs)) context.warn('场景 npcs 已迁移为 npcIds');

  return {
    sceneId,
    title: raw.title,
    entry: raw.entry,
    ...(npcIds !== undefined ? { npcIds } : {}),
    ...(loreIds.length > 0 ? { loreIds } : {}),
    ...(beats !== undefined ? { beats } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(encounterIds.length > 0 ? { encounterIds } : {}),
    ...(rewardIds.length > 0 ? { rewardIds } : {}),
  };
}

function fixLoreRef(value: unknown, context: ModuleMigrationContext): unknown {
  if (typeof value !== 'string' || !value) return value;
  const loreIds = context.loreIds;
  if (!loreIds || loreIds.has(value)) return value;
  const prefixed = `entry_${value}`;
  if (loreIds.has(prefixed)) {
    context.warn(`世界书引用缺前缀已自动补齐：${value} → ${prefixed}`);
    return prefixed;
  }
  return value;
}

function migrateCard(
  raw: unknown,
  ruleSystem: PackRuleSystem | undefined,
  context: MigrationContext,
): unknown {
  if (!isRecord(raw)) return raw;
  const cardId = pickString(raw.cardId, raw.id);
  if (!isNonEmptyString(raw.cardId) && isNonEmptyString(raw.id)) {
    context.warn('角色卡 id 已迁移为 cardId');
  }
  const next: Record<string, unknown> = { ...raw };
  delete next.id;
  if (cardId !== undefined) next.cardId = cardId;
  // legacy 卡显式补规则引用来路（已有则不动）
  if (next.ruleSystem === undefined && ruleSystem) next.ruleSystem = ruleSystem;
  return next;
}

// ---------------------------------------------------------------------------
// D12 兼容适配：pack → 旧导出形状
// ---------------------------------------------------------------------------

/** pack 卡 → engine `CharacterCard`（落座/导入旧路径用，engine 校验契约不变）。 */
export function toCharacterCard(def: CharacterCardDef): CharacterCard {
  const { cardId, ruleSystem: _ruleSystem, ...rest } = def;
  return { ...(rest as Omit<CharacterCard, 'id'>), id: cardId } as unknown as CharacterCard;
}

/** pack 模组 → 旧 `ModuleDef`（把模组级 encounters/rewards 重新内联回场景）。 */
export function toLegacyModuleDef(module: PackModuleDef, ruleSystem: PackRuleSystem): ModuleDef {
  const encounterById = new Map(module.encounters.map((encounter) => [encounter.encounterId, encounter]));
  const rewardById = new Map(module.rewards.map((reward) => [reward.rewardId, reward]));
  const scenes: SceneDef[] = module.scenes.map((scene) => {
    const legacyScene: SceneDef = {
      id: scene.sceneId,
      title: scene.title,
      entry: scene.entry,
    };
    if (scene.npcIds && scene.npcIds.length > 0) legacyScene.npcs = [...scene.npcIds];
    if (scene.loreIds && scene.loreIds.length > 0) legacyScene.lore = [...scene.loreIds];
    if (scene.beats && scene.beats.length > 0) {
      legacyScene.beats = scene.beats.map((beat) => ({ id: beat.beatId, trigger: beat.trigger, effect: beat.effect }));
    }
    if (scene.checks && scene.checks.length > 0) {
      legacyScene.checks = scene.checks.map((check) => ({
        when: check.when,
        skill: check.skill,
        dc: check.dc,
        success: check.success,
        failure: check.failure,
        ...(check.private !== undefined ? { private: check.private } : {}),
      }));
    }
    const encounters = (scene.encounterIds ?? [])
      .map((encounterId) => encounterById.get(encounterId))
      .filter((encounter): encounter is PackEncounterDef => encounter !== undefined)
      .map((encounter) => ({
        id: encounter.encounterId,
        monsters: encounter.monsters.map((group) => ({ monsterId: group.monsterId, count: group.count })),
        ...(encounter.note !== undefined ? { note: encounter.note } : {}),
      }));
    if (encounters.length > 0) legacyScene.encounters = encounters;
    const rewards = (scene.rewardIds ?? [])
      .map((rewardId) => rewardById.get(rewardId))
      .filter((reward): reward is PackRewardDef => reward !== undefined)
      .map((reward) => ({
        xp: reward.xp,
        items: [...reward.items],
        ...(reward.note !== undefined ? { note: reward.note } : {}),
      }));
    if (rewards.length > 0) legacyScene.rewards = rewards;
    return legacyScene;
  });

  return {
    schemaVersion: CONTENT_PACK_OBJECT_SCHEMA_VERSION,
    id: module.moduleId,
    title: module.title,
    ruleId: ruleSystem.id,
    level: [module.level[0], module.level[1]],
    playerCount: [module.playerCount[0], module.playerCount[1]],
    durationMinutes: module.durationMinutes,
    synopsis: module.synopsis,
    ...(module.gmNotes !== undefined ? { gmNotes: module.gmNotes } : {}),
    npcs: module.npcs.map((npc) => ({ id: npc.npcId, name: npc.name, description: npc.description })),
    scenes,
    secrets: module.secrets.map((secret) => ({
      id: secret.secretId,
      content: secret.content,
      revealWhen: secret.revealWhen,
    })),
  };
}

/** pack 世界书 → 旧 `LorebookDef`。 */
export function toLegacyLorebook(lorebook: PackLorebookDef): LorebookDef {
  return {
    schemaVersion: CONTENT_PACK_OBJECT_SCHEMA_VERSION,
    id: lorebook.lorebookId,
    title: lorebook.title,
    entries: lorebook.entries.map((entry) => ({
      id: entry.loreId,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      keys: [...entry.keys],
      visibility: entry.visibility,
      priority: entry.priority,
      ...(entry.alwaysOn !== undefined ? { alwaysOn: entry.alwaysOn } : {}),
      content: entry.content,
      ...(entry.tags !== undefined ? { tags: [...entry.tags] } : {}),
    })),
  };
}
