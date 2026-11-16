/**
 * 内容包注册表（M8.2）：内置包 + 数据目录 `.trpgpack` 的 host 侧唯一内容权威。
 *
 * 路径约定（CONTENT-MODEL §2.7）：与房间存档同一父目录
 * `<DSH_HOME>/profile-data/<profile>/dsh-trpg-table/content/packs/*.trpgpack`
 * （复用 `persistence.ts` 的 profile-data 约定；一个包 = 一个文件）。
 *
 * 加载策略：
 * - 内置包优先（`CORE_PACKS`，随插件零配置可用），数据目录包按文件名排序追加；
 * - 统一走 `trpgpackToPack()`（含 migrate + validate，含 zip 结构/大小/路径/CRC 校验），
 *   不允许旁路直接 `JSON.parse` 绕过校验；
 * - 坏包只记 warning 并跳过，不崩服务；重复 `packId` 给可读警告（内置包优先，数据目录先加载者优先）；
 * - `reload()` 重建清单；目录整体读取失败时保留上一份数据包清单（只重建内置包）。
 *
 * 房间侧只需要 `RoomContentResolver`（`resolveModule` / `hasPack` / `defaultPackId`）：
 * 房间只存 `{ packId, moduleId }` 引用，内容始终从本注册表解析，不复制进房间。
 *
 * M9.4：注册表同时实现 `RoomRulesResolver`（`resolveRules`）——把内容包的 `rules` 段与
 * `rules/scripts/*.js` 脚本源码交给 rooms 建规则运行时。内置包的脚本源码随代码发布
 * （`@dsh-trpg/content/rules-pack`），数据目录包的脚本来自 zip 条目。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  CORE_PACKS,
  toLegacyLorebook,
  toLegacyModuleDef,
  validatePack,
  type ContentPack,
  type LorebookDef,
  type ModuleDef,
  type PackModuleDef,
} from '@dsh-trpg/content';
import { contentHashOfPack, trpgpackToPack } from '@dsh-trpg/content/pack-zip';
import { scriptSourcesForRules } from '@dsh-trpg/content/rules-pack';
import type { CatalogPack } from '@dsh-trpg/protocol';
import type {
  RoomContentModule,
  RoomContentResolver,
  RoomRuleScript,
  RoomRulesInput,
  RoomRulesResolver,
} from '@dsh-trpg/rooms';
import { hashRules } from '@dsh-trpg/rooms';
import { defaultRoomsDir } from './persistence.ts';

/** 缺省内容包：内置包 `core-guimuya`（旧客户端不传 packId 时的兜底）。 */
export const DEFAULT_PACK_ID = 'core-guimuya';

export const PACK_FILE_EXTENSION = '.trpgpack';

/** 内容包来源：内置（随插件编译）或数据目录（.trpgpack 文件）。 */
export type PackSource = 'builtin' | 'data';

/** 注册表里的一条内容包（host 侧，含完整包数据；不要直接下发给玩家）。 */
export interface PackEntry {
  pack: ContentPack;
  /** sha256(规范化 pack.json)，用于房间快照比对。 */
  contentHash: string;
  source: PackSource;
  /** 数据目录包的绝对路径；内置包为 undefined。 */
  filePath?: string;
  /** 包内内联规则包（M9.4；`pack.rules` 缺省 = 内容包不带规则）。 */
  rules?: RoomRulesInput['rules'];
  /** 规则脚本源码（`rules/scripts/*.js`；与 `rules.scripts` 清单 sha256 对应）。 */
  scripts?: RoomRuleScript[];
}

/** 包内带 `rules` 段时解析出的规则运行时来源（供 rooms 建房）。 */
export interface ResolvedPackRules extends RoomRulesInput {
  packId: string;
  packVersion: string;
}

/** 脚本源码 → 清单条目（sha256 用 node:crypto 现算，与内容包校验口径一致）。 */
function scriptEntryOf(file: string, code: string, expectedSha256?: string): RoomRuleScript {
  const sha256 = createHash('sha256').update(code, 'utf8').digest('hex');
  return { file, code, sha256: expectedSha256 ?? sha256 };
}

/** 读取内置规则包随代码发布的脚本源码（`rules/scripts/*.js`）。 */
function builtinScriptsFor(rules: RoomRulesInput['rules'] | undefined): RoomRuleScript[] {
  if (rules === undefined) return [];
  const sources = scriptSourcesForRules(rules);
  if (sources === undefined) return [];
  return sources.map((source) => scriptEntryOf(source.file, source.code, source.sha256));
}

/** 数据目录包的脚本条目（zip 解出的 UTF-8 字节）→ 源码条目。 */
function decodedScriptsOf(scripts: Map<string, Uint8Array> | undefined): RoomRuleScript[] {
  if (scripts === undefined || scripts.size === 0) return [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const output: RoomRuleScript[] = [];
  for (const [file, bytes] of [...scripts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    try {
      output.push(scriptEntryOf(file, decoder.decode(bytes).replace(/^\uFEFF/u, '')));
    } catch {
      /* 非法 UTF-8：validatePack 已经报错，这里忽略（运行时按缺脚本降级） */
    }
  }
  return output;
}

/** 解析出的模组（房间解析结果的超集，额外带 GM 侧需要的整包/模组数据）。 */
export interface ResolvedPackModule extends RoomContentModule {
  pack: ContentPack;
  module: PackModuleDef;
}

/** GM 运行时使用的旧形状内容（engine/提示词按旧 `ModuleDef`/`LorebookDef` 消费）。 */
export interface ResolvedLegacyContent {
  packId: string;
  packVersion: string;
  moduleId: string;
  contentHash: string;
  module: ModuleDef;
  lorebook: LorebookDef;
}

export interface PackRegistryOptions {
  /** 数据目录（测试/自定义用）；默认 `defaultPacksDir()`。 */
  dir?: string;
  /** 内置包；默认 `CORE_PACKS`。 */
  builtin?: readonly ContentPack[];
  /** 缺省包 id；默认 `core-guimuya`，找不到时回退到第一个内置包。 */
  defaultPackId?: string;
  log?: (message: string) => void;
}

export interface PackRegistryReloadResult {
  /** 本次加载成功的内容包数量（内置 + 数据目录）。 */
  packs: number;
  /** 可读警告（坏包、重复 packId、被忽略条目等）。 */
  warnings: string[];
}

/** 数据目录默认路径：与房间存档同一父目录下的 `content/packs`。 */
export function defaultPacksDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultRoomsDir(env)), 'content', 'packs');
}

/**
 * 内容包注册表。构造后调用 `reload()` 加载；`reload()` 可重复调用（M8.3 导入包后重扫）。
 * 同时实现 rooms 的 `RoomContentResolver`，直接注入 `new RoomService({ content: registry })`。
 */
export class PackRegistry implements RoomContentResolver, RoomRulesResolver {
  readonly dir: string;
  private readonly options: PackRegistryOptions;
  private readonly log: (message: string) => void;
  private entries = new Map<string, PackEntry>();
  private lastWarnings: string[] = [];

  constructor(options: PackRegistryOptions = {}) {
    this.options = options;
    this.dir = options.dir ?? defaultPacksDir();
    this.log = options.log ?? (() => {});
  }

  /** 缺省包 id：内置包优先，缺失时回退到第一个已加载包。 */
  get defaultPackId(): string {
    const wanted = this.options.defaultPackId ?? DEFAULT_PACK_ID;
    if (this.entries.has(wanted)) return wanted;
    const first = this.entries.keys().next();
    return first.done ? wanted : first.value;
  }

  /**
   * 重扫内容包：内置包 + 数据目录 `.trpgpack`。
   * 坏包/重复包只记 warning 并跳过；目录读取失败时保留上一份数据包清单。
   * @returns 加载数量与本轮警告（同时写入 `warnings()` 与 log）。
   */
  reload(): PackRegistryReloadResult {
    const warnings: string[] = [];
    const entries = new Map<string, PackEntry>();

    // ---- 1. 内置包（随插件编译，永远优先） ----
    for (const builtinPack of this.options.builtin ?? CORE_PACKS) {
      const report = validatePack(builtinPack);
      if (!report.ok || !report.value) {
        const message = `内置内容包「${String((builtinPack as { packId?: unknown }).packId ?? '?')}」校验失败，已跳过：${report.errors.join('；')}`;
        warnings.push(message);
        continue;
      }
      const pack = report.value;
      if (entries.has(pack.packId)) {
        warnings.push(`内置内容包 packId 重复：${pack.packId}（保留先加载的）`);
        continue;
      }
      const rules = (pack as ContentPack & { rules?: RoomRulesInput['rules'] }).rules;
      const scripts = builtinScriptsFor(rules);
      if (
        rules !== undefined &&
        rules.scripts !== undefined &&
        Object.keys(rules.scripts).length > 0 &&
        scripts.length === 0
      ) {
        warnings.push(`内置内容包「${pack.packId}」的规则包声明了脚本，但本机没有对应内置脚本源码：规则运行时将降级`);
      }
      entries.set(pack.packId, {
        pack,
        contentHash: contentHashOfPack(pack),
        source: 'builtin',
        ...(rules !== undefined ? { rules } : {}),
        ...(scripts.length > 0 ? { scripts } : {}),
      });
      for (const warning of report.warnings) warnings.push(`内置内容包「${pack.packId}」：${warning}`);
    }

    // ---- 2. 数据目录（.trpgpack，一个文件一个包） ----
    let fileNames: string[] = [];
    try {
      if (existsSync(this.dir)) {
        fileNames = readdirSync(this.dir)
          .filter((name) => name.toLowerCase().endsWith(PACK_FILE_EXTENSION))
          .sort((left, right) => left.localeCompare(right));
      }
    } catch (error) {
      const message = `内容包目录读取失败：${this.dir}（${error instanceof Error ? error.message : String(error)}）；已保留上一份数据包清单`;
      warnings.push(message);
      for (const entry of this.entries.values()) {
        if (entry.source !== 'data') continue;
        if (entries.has(entry.pack.packId)) continue;
        entries.set(entry.pack.packId, entry);
      }
      fileNames = [];
    }

    for (const name of fileNames) {
      const filePath = join(this.dir, name);
      let decoded;
      try {
        const bytes = new Uint8Array(readFileSync(filePath));
        decoded = trpgpackToPack(bytes);
      } catch (error) {
        warnings.push(`内容包 ${name} 读取失败，已跳过：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!decoded.ok || !decoded.pack || !decoded.contentHash) {
        warnings.push(`内容包 ${name} 校验失败，已跳过：${decoded.errors.join('；')}`);
        continue;
      }
      const pack = decoded.pack;
      const existing = entries.get(pack.packId);
      if (existing) {
        const kept = existing.source === 'builtin' ? '内置包' : basename(existing.filePath ?? '已加载文件');
        warnings.push(
          existing.source === 'builtin'
            ? `内容包 ${name} 的 packId "${pack.packId}" 与内置包重名，已忽略数据目录版本（内置包优先）`
            : `内容包 ${name} 的 packId "${pack.packId}" 重复，已忽略（保留 ${kept}）`,
        );
        continue;
      }
      entries.set(pack.packId, {
        pack,
        contentHash: decoded.contentHash,
        source: 'data',
        filePath,
        ...((pack as ContentPack & { rules?: RoomRulesInput['rules'] }).rules !== undefined
          ? { rules: (pack as ContentPack & { rules?: RoomRulesInput['rules'] }).rules }
          : {}),
        ...(decoded.scripts.size > 0 ? { scripts: decodedScriptsOf(decoded.scripts) } : {}),
      });
      for (const warning of decoded.warnings) warnings.push(`内容包 ${name}：${warning}`);
    }

    this.entries = entries;
    this.lastWarnings = warnings;
    for (const warning of warnings) this.log(warning);
    return { packs: entries.size, warnings: [...warnings] };
  }

  /** 本轮重扫的警告（供诊断/RPC）。 */
  warnings(): readonly string[] {
    return [...this.lastWarnings];
  }

  /** 全部内容包（内置在前，数据目录按文件名排序）。host 侧使用，含完整内容。 */
  list(): PackEntry[] {
    return [...this.entries.values()];
  }

  /** 取内容包；不存在返回 undefined。 */
  get(packId: string): ContentPack | undefined {
    return this.entries.get(packId)?.pack;
  }

  /** 取注册表条目（含来源/路径/内容指纹）。 */
  getEntry(packId: string): PackEntry | undefined {
    return this.entries.get(packId);
  }

  /** 包是否已安装。 */
  hasPack(packId: string): boolean {
    return this.entries.has(packId);
  }

  /** 内容指纹（sha256(规范化 pack.json)）；不存在返回 undefined。 */
  contentHashOf(packId: string): string | undefined {
    return this.entries.get(packId)?.contentHash;
  }

  /**
   * 解析包内模组（`RoomContentResolver` 实现）：moduleId 缺省用包 `defaultModuleId`。
   * 包或模组不存在返回 undefined。
   */
  resolveModule(packId: string, moduleId?: string): ResolvedPackModule | undefined {
    const entry = this.entries.get(packId);
    if (!entry) return undefined;
    const targetModuleId = moduleId?.trim() || entry.pack.defaultModuleId;
    const module = entry.pack.modules.find((candidate) => candidate.moduleId === targetModuleId);
    if (!module) return undefined;
    return {
      packId: entry.pack.packId,
      packVersion: entry.pack.version,
      packName: entry.pack.name,
      moduleId: module.moduleId,
      moduleTitle: module.title,
      contentHash: entry.contentHash,
      scenes: module.scenes.map((scene) => ({ sceneId: scene.sceneId, title: scene.title })),
      pack: entry.pack,
      module,
    };
  }

  /** 解析成 GM 运行时使用的旧形状（`ModuleDef`/`LorebookDef`）；找不到返回 undefined。 */
  resolveLegacy(packId: string, moduleId?: string): ResolvedLegacyContent | undefined {
    const resolved = this.resolveModule(packId, moduleId);
    if (!resolved) return undefined;
    return {
      packId: resolved.packId,
      packVersion: resolved.packVersion,
      moduleId: resolved.moduleId,
      contentHash: resolved.contentHash,
      module: toLegacyModuleDef(resolved.module, resolved.pack.ruleSystem),
      lorebook: toLegacyLorebook(resolved.pack.lorebook),
    };
  }

  /**
   * 解析包内规则（`RoomRulesResolver` 实现）：包不存在或没带 `rules` 段返回 undefined。
   *
   * 规则包是**包级数据**（模组只引用规则，不覆盖规则），所以 `moduleId` 只为对齐接口签名。
   * 返回的 `rulesHash` = sha256(规范化规则数据 + 脚本清单 sha256)，房间快照用它检测漂移。
   */
  resolveRules(packId: string, moduleId?: string): ResolvedPackRules | undefined {
    void moduleId;
    const entry = this.entries.get(packId);
    if (!entry) return undefined;
    const rules = entry.rules ?? (entry.pack as ContentPack & { rules?: RoomRulesInput['rules'] }).rules;
    if (rules === undefined) return undefined;
    const scripts = entry.scripts ?? builtinScriptsFor(rules);
    return {
      packId: entry.pack.packId,
      packVersion: entry.pack.version,
      rules,
      ...(scripts.length > 0 ? { scripts } : {}),
      rulesHash: hashRules(rules, scripts),
    };
  }

  /**
   * 玩家可见的**脱敏目录**（`content.list`）：只有元数据、模组摘要与计数，
   * 不含 gmNotes / secrets / encounters / checks / rewards / 世界书正文 / 场景开场。
   */
  publicCatalog(): CatalogPack[] {
    return [...this.entries.values()].map((entry) => {
      const pack = entry.pack;
      return {
        packId: pack.packId,
        name: pack.name,
        version: pack.version,
        ...(pack.description !== undefined ? { description: pack.description } : {}),
        author: pack.author,
        ruleSystem: { id: pack.ruleSystem.id, name: pack.ruleSystem.name },
        defaultModuleId: pack.defaultModuleId,
        modules: pack.modules.map((module) => ({
          moduleId: module.moduleId,
          title: module.title,
          level: [module.level[0], module.level[1]] as [number, number],
          playerCount: [module.playerCount[0], module.playerCount[1]] as [number, number],
          sceneCount: module.scenes.length,
        })),
        cardCount: pack.cards.length,
        loreCount: pack.lorebook.entries.length,
        source: entry.source,
      };
    });
  }
}
