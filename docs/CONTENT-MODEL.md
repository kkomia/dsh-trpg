# 内容模型 v1：内容包（Content Pack）统一模组/世界书/角色卡

> 状态：**已定稿（2026-11-16）**；**M8.1 已实现（2026-11-16，单测 114）/ M8.2 已实现（2026-11-16，单测 134）**｜决策来源：[DECISIONS.md](./DECISIONS.md) 第七轮 #25｜关联：[DESIGN.md](./DESIGN.md) §6 内容格式、[ROADMAP.md](./ROADMAP.md) M8。
> 本文是 M8 内容工坊的实现依据。D1–D12 由 lead 拍定，§8 的 4 个 Open Questions 已于 2026-11-16 由用户拍板；其中 **Q2 把分发形态定为 ZIP 容器 `.trpgpack`**，§2、§6、§9 已按 zip 重写。实现中若发现结论冲突，回 DECISIONS.md 改，不在这里漂移。

## 0. 决策摘要

**一个内容包（Content Pack）统管三件东西**：模组、世界书、角色卡以同一个容器制作、校验、导入导出与分享；房间只引用包，不再硬编码任何「鬼木崖」。

- 唯一可制作/分发单元 = `.trpgpack`（ZIP 容器：`pack.json` + 可选 `assets/`）（D1）；单一 schema 家族 + 显式版本 `trpg.pack/1`（D2）；包内对象有稳定 id 与引用存在性校验（D3）。
- 房间只存引用 + 场景公开摘要（D4），包缺失/漂移时降级续团并回退内置包；内容权威在 host：内置包零配置可用，数据目录包可加载、可重扫（D5）。
- zip 容器自带实现约定（§2.2）：零外部依赖（`node:zlib`）、读支持 stored/deflate、导入校验结构/大小/路径/CRC、导出时间戳固定保证可复现；编解码与校验已在 M8.1 完成（2026-11-16）。
- 角色卡双轨（Q3，贯穿 §4/§6）：pack 内置卡库随包分发；玩家私卡存本地（`localStorage` 或 profile-data），落座上传后由 host 校验；玩家不能改 host pack。

## 1. 为什么统一

### 1.1 三个现状痛点

| 痛点（M8 前） | 当时的证据 | 后果 |
|---|---|---|
| 硬编码单模组（**M8.2 已解决**：`room.create` 可选 `packId/moduleId`，host 按房间引用解析内容） | 当时 host/client 直接 `import { GUIMUYA_MODULE }`（`host/index.ts:10,145,425,445`、`client/index.ts:16,450` 场景下拉框写死 `GUIMUYA_MODULE.scenes`），建房无法选择内容包/模组 | 第二个模组 = 改源码重新打包；玩家无法选择/预览 |
| 两套 id 与引用 | 角色卡 `id`、世界书/模组各自 `schemaVersion: 1`；模组 `scene.lore: ["qingshi", …]` 与世界书条目 `entry_qingshi` 对不上，且 `validateModule()` 不检查引用存在性 | 内容作者手改 JSON 不报错，运行时静默失效（场景关联 lore 目前根本没被消费） |
| 制作无入口 | 改内容只能编辑 `packages/content/{cards,modules,lorebooks}/*.json` 再重编译；角色卡只有「导入/复制预制卡」，没有新建/编辑表单与只读卡面 | 门槛 = 会改源码；玩家卡不可视、不可改 |

### 1.2 统一后的收益

- 一个 `.trpgpack` = 一次导入/导出/分享（单文件，可带素材）；换模组 = 换 `packId`，host 与玩家都不改代码。
- 校验入口只有 `validatePack()` 一个：id 唯一、引用存在、字段合法、zip 结构与素材完整，错误给中文人话。
- 模组里的 checks/encounters/rewards/beats 从「JSON 摆设」变成 GM 提示与工具里的可用内容（D8）。
- 房间记录 `packId + packVersion + contentHash`，内容更新可检测、可降级续团（D4）；玩家私卡与 pack 内置卡共用 schema，落座路径统一（D9）。

## 2. 数据模型（D1–D5）

### 2.1 容器结构：`.trpgpack` = ZIP

分发与制作单元是一个 zip 文件，`pack.json` 是整包唯一内容清单，`assets/` 是可选素材目录；导入时只认这两个顶层条目，其余条目告警后忽略（见 §2.2）。

```
<packId>-<version>.trpgpack       # ZIP 容器；文件名固定 <packId>-<version>.trpgpack
├─ pack.json                      # 整包内容（UTF-8 JSON，唯一必需条目）
│    schemaVersion   "trpg.pack/1"
│    packId / name / version / author / description
│    ruleSystem     { id, name }              # 只引用规则，不内联：id=规则标识，name=规则名
│    defaultModuleId
│    modules[]      # v1 长度恒 1（数组为 v2 多模组预留）
│    lorebook       # 1 本
│    cards[]        # 0..N 张预制卡（pack 内置卡库）
└─ assets/                         # 可选：封面图 / NPC 立绘 / 地图等
     └─ …                          # pack.json 内一律用相对路径引用，如 "assets/cover.png"
```

- 导出文件名固定 `<packId>-<version>.trpgpack`（如 `core-guimuya-1.0.0.trpgpack`）；MIME `application/zip`；导入入口校验扩展名 + magic `PK\x03\x04`。
- `packId` 为小写 slug（`^[a-z0-9][a-z0-9-]*$`），内置包保留 `core-` 前缀；`version` 为 semver。
- 一个 pack 只带 1 个模组、1 本世界书（v1 约定）：`modules` 以数组承载、长度恒 1，`defaultModuleId` 必须等于 `modules[0].moduleId`；规则数据（种族/职业/法术/怪物/物品）不内联，只以 `ruleSystem.id`（规则标识）+ `ruleSystem.name`（规则名）引用（D1）；规则版本记录在 pack 的 `rules` 段（`schemaVersion: 'trpg.rules/1'` + `rulesVersion`，见 [RULES-MODEL.md](./RULES-MODEL.md) §3/§9）。
- `contentHash = sha256(规范化 pack.json 字节)`：键排序、无多余空白、不含 zip 元数据；供房间快照做变更检测。实现可另算整包 `packHash = sha256(zip 字节)` 用于断言「导出可复现」（同 pack 同版本必须字节一致）。
- 仓库内内置包由 `packages/content/src/packs/core-guimuya.ts` 从现有源码 JSON（`cards/`、`modules/`、`lorebooks/`，旧形状、便于 diff/评审）经 `migratePack()` 组装为 `CORE_GUIMUYA_PACK`（注册在 `CORE_PACKS`）；用同一编码器产出 `.trpgpack` 才是分发/导入形态（CLI `export`，内置包暂不带 `assets/`）。源码 JSON 不是分发形态，`.trpgpack` 才是。

### 2.2 zip 编解码与导入校验（M8.1 已实现）

实现集中在 `@dsh-trpg/content` 的 `zip.ts`（底层读写、CRC32 手写查表）与 `pack-zip.ts`（`packToTrpgpack()` / `trpgpackToPack()`，兼容别名 `encodePackZip()` / `decodePackZip()`），文件落盘在 `pack-io.ts`。v1 **不引入外部依赖**：只用 `node:zlib`（`deflateRawSync` / `inflateRawSync`，本机 Node v24 已提供）与内置 `Buffer`，不调系统 `zip/unzip`；zip 解析手写（EOCD → 中央目录 → local header），只做本场景需要的子集。

**读（导入 `decodePackZip(buffer)`）**

1. **结构**：从尾部找 EOCD（`PK\x05\x06`）→ 读中央目录 → 按偏移读 local header 定位数据；**大小/CRC 以中央目录记录为准**（容忍通用标志 bit 3 数据描述符，local header 的 size 为 0 不作为错误）。local 与中央目录冲突时以中央目录为准并记 warning。
2. **压缩方法**：只接受 `0`（stored）与 `8`（deflate，`inflateRawSync`）；其它方法（如 9/12/14）→ 明确报「不支持的压缩方式」。
3. **拒绝**：加密条目（标志 bit 0）、zip64（发现 zip64 EOCD locator / 需 zip64 时 v1 直接报「包过大，需 <4 GiB」）、重复条目名（大小写不敏感）、条目名无法按 UTF-8 解码、`pack.json` 缺失（提示「pack.json 必须在 zip 根目录」——作者常把目录整个压进去）。
4. **大小上限**（常量从 `zip.ts` 的 `ZIP_LIMITS` 导出，单测直接断言）：整包 ≤ **64 MiB**；`pack.json` 解压后 ≤ **4 MiB**（不变）；单条目解压后 ≤ **8 MiB**（不变）；条目数 ≤ **520**（`pack.json` + 规则脚本 + 512 资产）；解压总量 ≤ **64 MiB**。超限立刻中止（防压缩炸弹），错误信息带「已解压 X / 上限 Y」；上限口径见 [UI-CONTRACT.md](./UI-CONTRACT.md) §3.1（M9.5b/c 上调并已实装）。
5. **路径安全**：条目名统一 `/` 分隔并 NFC 规范化（`\` 转 `/` 并 warning）；拒绝绝对路径（`/` 开头、`C:`、UNC `\\`）、`..` 段、空名、控制字符；v1 只接受 `pack.json` 与 `assets/**` 两个前缀，其余记 warning 后忽略且不落盘（兼容 macOS 打包产生的 `__MACOSX/`、`.DS_Store`）。
6. **完整性**：每条解压后重算 CRC32 与中央目录比对，不一致报「第 N 个条目 CRC 校验失败」；`pack.json` 走 `JSON.parse`（失败给出可读的解析位置）→ `migratePack()` → `validatePack()`；zip 内含 `assets/manifest.json`（`trpg.assets/1`）时额外**全量校验**（M9.5b/c 已实装）：清单结构/尺寸/体积/`bytes`/`sha256` 与实际文件一致、被引用的 `assetId` 存在、孤立资产 warning（`packages/content/src/asset-manifest.ts`）。
7. **不落盘**：返回 `{ pack, assets: Map<string, Uint8Array>, warnings[] }`，由调用方决定是否安装；导入即落盘会留下半成品。

**写（导出 `encodePackZip(pack, assets)`）**

- 条目顺序固定：`pack.json` 第一，`assets/` 按路径字典序；
- 时间戳固定（DOS 时间 1980-01-01 00:00:00），不写 extra field / comment / 数据描述符，`version made by`、外部属性、文件名 UTF-8 标志（bit 11）全部固定；
- 压缩：`pack.json` 用 deflate；素材里已压缩的格式（png/jpg/webp/zip）可用 stored，其余用 deflate；压缩级别固定（v1 取 zlib 默认 6），不随机器变化；
- 写出前先跑 `validatePack()`，校验不过不产出文件（CLI 退出码非 0）；
- 同一 pack 内容必须产出**字节一致**的 zip，`packHash` 可作为 fixture 断言与 CI 回归门。

### 2.3 `pack.json` 示例（内置包 `core-guimuya`，裁剪）

```jsonc
{
  "schemaVersion": "trpg.pack/1", "packId": "core-guimuya", "name": "鬼木崖·异光", "version": "1.0.0",
  "author": "dsh-trpg contributors", "license": "MIT",
  "description": "45 分钟中式奇幻短模组：接悬赏 → 探古洞 → 破邪阵。",
  "icon": "assets/cover.png",
  "ruleSystem": { "id": "dnd5e-lite", "name": "D&D 5e-lite" },
  "defaultModuleId": "guimuya",
  "modules": [{
    "schemaVersion": 1, "moduleId": "guimuya", "title": "鬼木崖·异光",
    "level": [1, 2], "playerCount": [1, 4], "durationMinutes": 45, "startSceneId": "scene_qingshi",
    "synopsis": "青石镇西边的枯木崖夜夜泛绿光…", "gmNotes": "一幕三场：打听 → 探洞 → 守关。",
    "npcs": [{ "npcId": "liu_zhanggui", "name": "柳掌柜", "description": "清风茶馆掌柜，实际是昆仑剑宗眼线。" }],
    "scenes": [{
      "sceneId": "scene_qingshi", "title": "青石镇·悬赏", "entry": "逢五的集市刚散，镇口告示墙前还围着人…",
      "npcIds": ["liu_zhanggui", "wang_laohan", "zhenzhang"],
      "loreIds": ["entry_qingshi", "entry_bounty", "entry_guimuya", "entry_liuzhanggui", "entry_laolieren"],
      "checks": [{ "checkId": "check_liu_persuade", "when": "向柳掌柜打听绿光", "skill": "persuasion", "dc": 12, "success": "柳掌柜说漏了嘴：绿光起于子时…", "failure": "柳掌柜只是笑，把话头引到茶价上。" }],
      "encounterIds": ["enc_guihuo", "enc_shanzei"],
      "beats": [{ "beatId": "beat_accept", "trigger": "玩家接下悬赏或承诺救人", "effect": "进入 scene_guimuya" }],
      "rewardIds": ["reward_qingshi"]
    }],
    "encounters": [{ "encounterId": "enc_guihuo", "monsters": [{ "monsterId": "guihuo", "count": 2 }, { "monsterId": "zhiren", "count": 2 }], "maxRounds": 8, "battleMapId": "map_cave_mouth", "note": "惊动洞口的守卫。" }],
    "rewards": [{ "rewardId": "reward_qingshi", "xp": 20, "items": [] }],
    "secrets": [{ "secretId": "secret_aman", "content": "阿满被摄入阵中，还活着。", "revealWhen": "场景 3 进入密室时揭示" }]
  }],
  "lorebook": { "schemaVersion": 1, "lorebookId": "lore_guimuya", "title": "鬼木崖·异光 · 世界书",
    "entries": [{ "loreId": "entry_guimuya", "title": "枯木崖", "keys": ["枯木崖", "绿光", "异光"], "visibility": "public", "priority": 100, "content": "青石镇以西三里，崖顶有一株千年枯松…", "tags": ["地点"] }]
  },
  "cards": [{ "schemaVersion": 1, "cardId": "card_aqing", "owner": { "playerId": null, "displayName": "未分配" },
    "identity": { "name": "阿青", "race": "山民", "class": "武者", "level": 1, "background": "铁匠铺的学徒。" },
    "abilities": { "str": 17, "dex": 14, "con": 15, "int": 10, "wis": 12, "cha": 8 },
    "proficiency": { "bonus": 2, "skills": ["athletics", "intimidation"], "saves": ["str", "con"] },
    "combat": { "ac": 16, "hpMax": 12, "initiativeBonus": 2, "attacks": [{ "name": "横刀", "ability": "str", "proficient": true, "damage": "1d8", "range": "engaged" }] },
    "inventory": [{ "name": "横刀", "qty": 1 }], "publicSummary": "背刀的山民少女，话不多，眼睛很亮。",
    "appearance": "短打劲装，右手虎口有旧茧。", "personality": "护短、认死理。", "source": { "ruleId": "dnd5e-lite", "ruleVersion": "1.0", "moduleId": "guimuya" }
  }]
}
```

### 2.4 zip 内部结构与字段说明

| 层级 | 字段（路径） | 类型 / 必填 | 说明 |
|---|---|---|---|
| zip | `pack.json` | 唯一必需条目 | 整包内容清单；缺失即导入失败；根目录下必须叫这个名 |
| zip | `assets/**` | 可选目录 | 封面/立绘/地图等二进制素材；`pack.json` 用相对路径引用，引用必须存在（`validatePack()` 查） |
| pack | `schemaVersion` | `"trpg.pack/1"` 必填 | 唯一入口版本；子对象（module/lorebook/card）各自 `schemaVersion: 1` |
| pack | `packId` / `version` | slug / semver 必填 | 导出名 `<packId>-<version>.trpgpack`；用于房间记录、导入冲突与 contentHash；内置包保留 `core-` 前缀 |
| pack | `name` / `description` / `author` | 必填 | 展示与归属；旧草案字段 `title` → `name`，迁移期兼容读 `title`，导出只写 `name` |
| pack | `license` / `icon` | 可选 | `icon` 走 `assets/**` 相对路径，也接受内联 SVG 小图标；v1 二进制素材一律进 `assets/` |
| pack | `ruleSystem` | `{ id, name }` 必填 | 只引用不内联（D1）：`id` 为规则标识（如 `dnd5e-lite`）、`name` 为规则名（如 `D&D 5e-lite`）；旧 `{ ruleId, ruleVersion }` 由 `migratePack()` 归一为 `{ id, name }`（缺 `name` 时以 id 兜底），旧 `rules` / 模组 `ruleId` 也迁移到这里；**规则版本**：pack 内 `rules` 段自带 `schemaVersion: 'trpg.rules/1'` 与规则内容指纹；房间快照记录 `rulesVersion/rulesHash`（见 [RULES-MODEL.md](./RULES-MODEL.md) §9）；pack 整体版本仍为 `pack.version`；导出后模块内不再带 `ruleId` |
| pack | `defaultModuleId` | 必填 | 必须是 `modules[].moduleId` 之一；v1 等于 `modules[0].moduleId` |
| pack | `modules[]` | 必填，v1 长度 1 | 模组对象数组；多模组是 v2 的事，v1 校验器直接拒绝长度 ≠ 1 |
| module | `moduleId` / `startSceneId` | 必填 | `startSceneId` 必须是本模组场景之一 |
| module | `scenes[].{loreIds,npcIds,encounterIds,rewardIds}` | 可选数组 | 跨对象引用；`validatePack()` 检查存在性（含 `loreIds` 必须命中 lorebook `loreId`） |
| module | `encounters[]` / `checks[].checkId` | 模组级集合 / 必填 | 场景用 `encounterIds` 引用；判定是数据 + GM 提示，不自动执行 |
| module | `encounters[].{maxRounds?,battleMapId?}` | 可选：正整数 / `mapId` 引用 | 覆盖本场回合上限（缺省取 `rules.time.defaultMaxRounds`）与指定本场战斗地图（引用 `rules.space.battleMaps[].mapId`）；随房间快照固定，解析顺序见 [RULES-MODEL.md](./RULES-MODEL.md) §3 |
| lorebook | `entries[].{loreId,visibility}` | 必填 | `visibility: public \| gm \| player:<id>`；`gm` 条目只进 GM 上下文、不进玩家可见上下文 |
| cards | `cards[].cardId` / `owner.playerId` | 必填 | pack 卡库即 `owner.playerId = null` 的预制卡（§6.2）；卡可用显式 `ruleSystem: { id, name }`，缺省由 `pack.ruleSystem` 兜底、显式时 id 必须与 pack 一致；玩家私卡同一 schema，来源仍用 engine 旧形状 `source: { ruleId, ruleVersion, moduleId }` 标注 |
| assets | 引用路径 | 相对路径 | 禁止绝对路径与 `..`；只允许 `assets/` 前缀；孤立素材给 warning（不阻断） |

### 2.5 与现状字段的映射

| 现状 | pack v1 | 迁移规则（D2/D12） |
|---|---|---|
| `packages/content/cards/*.json` + `CARDS`（4 张，`id`） | `pack.cards[]`（`cardId`） | 值不变（`card_aqing` 等），`id` → `cardId`；`PRESET_CARDS` 兼容导出时反向映射回 `id` |
| `lorebooks/guimuya.json` + `GUIMUYA_LOREBOOK`（10 条 = 7 公开 + 3 GM） | `pack.lorebook` | `id` → `lorebookId`；`entries[].id` → `loreId`（`entry_*` 值不变） |
| `modules/guimuya.json` + `GUIMUYA_MODULE`（3 幕 4 NPC 3 秘密） | `pack.modules[0]` | 模组 `id` → `moduleId`；`scenes[].id` → `sceneId`；`npcs[].id` → `npcId`；`secrets[].id` → `secretId` |
| 场景内联 encounters / checks / rewards | 模组级 `encounters[]` + 场景 `encounterIds`；checks/rewards 补 id | 遭遇值（`enc_guihuo` 等）不变；checks/rewards 原本无 id → 一次性手写补 `checkId/rewardId` |
| `scene.lore: ["qingshi", …]` | `scene.loreIds: ["entry_qingshi", …]` | **现有值缺 `entry_` 前缀，全部对不上**；M8.1 已由 `migratePack()` 自动补齐并纳入 `validatePack()` 挡回归 |
| `CONTENT_VERSION` / `RULE_ID` / `RULE_VERSION` / 模组 `ruleId` | `pack.version` / `ruleSystem.id`（+ 规则名 `ruleSystem.name`） | `CONTENT_VERSION` → `pack.version`；`RULE_ID` → `ruleSystem.id`；规则名（`RULE_SYSTEM_NAME`）→ `ruleSystem.name`；`RULE_VERSION` 与模组 `ruleId` 不再进入 pack 顶层（规则版本记录在 `rules.rulesVersion`，见 [RULES-MODEL.md](./RULES-MODEL.md)；兼容导出时由 `ruleSystem.id` 回填模组 `ruleId`）；`GUIMUYA_*` 旧导出保持不变（D12） |
| 文件位置 `packages/content/{cards,modules,lorebooks}/*.json` | `packages/content/src/packs/core-guimuya.ts`（组装 `CORE_GUIMUYA_PACK`） | 旧源码 JSON 仍在仓库内（便于 diff），由 TS 模块经 `migratePack()` 组装；导出产物 `core-guimuya-<version>.trpgpack` 才是分发/导入形态（host 已接 pack registry：M8.2） |
| 玩家本地卡 `dsh-trpg:cards:v1`；DiceFrame `schema_version: 2` | pack card | 旧卡启动时一次性迁移（`id` → `cardId`，值不变），落座前转 `CharacterCard`（engine 校验不变）；DiceFrame 后置 M8.5 适配器，属性/技能/装备映射，`source.ruleId = "diceframe:freeform_wuxia"` 标注来源 |

### 2.6 房间只引用不复制（D4，M8.2 已实现）

`room.create` 增加可选 `{ packId, moduleId }`：

- 显式指定的包/模组必须已安装，否则中文报错（「内容包 X 不存在」/「内容包 X 里没有模组 Y」）；
- 都缺省 = host 内容包 registry 的缺省包（内置 `core-guimuya`）+ 其 `defaultModuleId`；
- 缺省包本身不可用（内置包加载失败）时不卡建房，按降级内容开局。

房间记录（存档）与房间视图（`RoomView`）分开：

- **存档引用**：`content: { packId, packVersion, moduleId, contentHash, packName?, moduleTitle?, scenes: [{sceneId, title}] }`。房间不复制整包，也不落完整派生场景（`entry/checks/encounters` 不进房间），只留**场景公开摘要**供视图与 GM 控制台使用；内容始终由 host 的 pack registry 按引用解析。
- **视图投影**：`RoomView.content: { packId, packVersion, moduleId, packName?, moduleTitle?, degraded? }` + `RoomView.scenes: [{sceneId, title}]`；`contentHash` 只留在 host、不下发玩家。
- **向后兼容**：旧快照无 `content` 字段时按「缺省包 + 默认模组」补齐。
- **降级续团**：包/模组在本机缺失，或 `packVersion`/`contentHash` 与快照不一致 → 房间照常恢复，`content.degraded = true` 并广播 warning，GM 提示与工具回退内置包（不静默失败、不锁死房间）；导入对应 `.trpgpack` 后重扫（`content.reload` 或重启 DSH）可恢复原引用、清除降级（§9）。

### 2.7 内容来源与权威（D5）

- **内置包**：`packages/content/src/packs/core-guimuya.ts` 由现有源码 JSON 经 `migratePack()` 组装出 `CORE_GUIMUYA_PACK`（注册在 `CORE_PACKS`；1.0.0 = 1 模组 / 10 条世界书 / 4 卡），随 `@dsh-trpg/content` 零配置可用、不往磁盘写临时文件；需要分发/归档时用 `packToTrpgpack()`（CLI `export`）产出 `.trpgpack`。host 已接 pack registry（M8.2，`host/pack-registry.ts`），内置包永远优先、零配置可用。
- **数据目录包**：`<DSH_HOME>/profile-data/<profile>/dsh-trpg-table/content/packs/*.trpgpack`（一个包 = 一个文件，与房间存档同一父目录）。host 启动扫描并解码校验（`trpgpackToPack()` → `migratePack()` → `validatePack()`）：坏包跳过并记 warning，重复 `packId` 内置包优先、其余按文件名先加载者优先；目录整体读取失败时保留上一份数据包清单。重扫入口 = RPC `content.reload`（仅 loopback + host token，重扫后让降级房间恢复）；客户端「导入包 / 重扫」按钮在 M8.3 工坊。**只支持 `.trpgpack`**，不保留目录式安装（此前无存量需要迁移）。
- **统一解析路径**：内置包与数据目录包都走 `decodePackZip()` → `migratePack()` → `validatePack()`，不允许任何一条旁路直接 `import pack.json` 绕过校验。
- **权威与只读拉取**：host 是内容权威，玩家不能改 host 包。选包/展示走同一条 `/trpg/rpc` 通道的 RPC（不是独立的 HTTP GET）：

  - `content.list`：**无需 token**、玩家可读，返回**脱敏目录** `CatalogPack[]`——`packId/name/version/description?/author?/ruleSystem{id,name}/defaultModuleId/modules[]{moduleId,title,level,playerCount,sceneCount}/cardCount/loreCount/source('builtin'|'data')`；**不含** `gmNotes`/`secrets`/`encounters`/`checks`/`rewards`/世界书正文/场景开场（M8.2 单测断言不泄漏）。
  - `content.reload`：**仅 loopback + host token**（重扫会影响所有房间）；返回 `{packs, warnings, recoveredRooms?}`（重扫后的包数与警告、从降级恢复的房间数）。
  - M8.2 **不提供**整包 `pack.json` 与素材的只读下载接口：玩家端选包只需脱敏目录，GM 内容留在 host（M8.3 工坊/预览与 M8.5 分享再定接口）。玩家私卡仍在本地，落座时上传、host 校验后入房。

## 3. 三块内容的能力矩阵（D6/D9）

| 内容块 | 制作 | 编辑 | 预览 | 导入/导出 | 分享 | 权限 |
|---|---|---|---|---|---|---|
| 内容包 | 源码 JSON + CLI 导出（M8.1 ✅）/ 工坊（M8.3） | 三个编辑器 tab（M8.3） | 校验结果 + 包概要 | `.trpgpack`（M8.1 库/CLI，M8.3 UI） | 单文件即一包 | host 安装/启用/重扫（M8.2 ✅ 内置 registry + 数据目录 + `content.reload`）；玩家只读脱敏目录（`content.list`） |
| 角色卡 | 新建空白/预制模板（M8.3） | 字段表单（M8.3） | 只读卡面（M8.3，战斗可见 HP/AC/法术位） | 单卡 JSON（M8.1 库 + M8.3 UI）；pack 内卡随 `.trpgpack` | 本地卡可给朋友；pack 卡随包（M8.5） | 玩家本地真源；pack 卡只读、可复制成本地卡 |
| 世界书 | 手写 JSON（M8.1）；表单（M8.3） | 条目表单 + 关键词/可见性（M8.3） | 检索试算（M8.4） | 随 `.trpgpack`（M8.1/M8.3） | 随包（M8.5） | host 包只读；`gm` 条目仅 GM |
| 模组 | 手写 JSON（M8.1）；表单（M8.3） | 场景/遭遇/判定/奖励编辑（M8.3） | 场景大纲与开场预览（M8.3） | 随 `.trpgpack`；选包/选模组建房（M8.2 ✅） | 随包（M8.5） | host 安装/启用 |

## 4. 作者 UI：内容工坊（D6）与角色卡能力（D9）

- **位置已确认（Q1，2026-11-16）：主区域独立页 + 右栏轻量入口**。主区域独立页（keyed `main` panel）：工坊页，三个 tab = 角色卡编辑器 / 世界书编辑器 / 模组编辑器；共用顶部 pack 选择器 + `.trpgpack` 导入/导出 + 校验结果 + 预览。**右栏轻量入口**：保留在现有「跑团桌」tab 内——选择模组、我的卡、打开工坊（跳主区域页）。
- 不违背 v3（#23）：工坊是工具页，不是自绘聊天；打开时聊天会话仍在（切页签），玩家仍用原生会话行动。理由：三栏编辑器 + 大表单需要宽度，右栏 320–420px 放不下。
- 实现顺序（M8.3）：卡只读面板 → 卡编辑器 → 世界书编辑器 → 模组编辑器；每步复用 M8.1 的 `validatePack()`，不做第二套校验。
- **实现状态（2026-11-16）**：主区域工坊页已随 **M9.6a** 落地——左栏内容包列表 + 右侧 **8 个 tab（概览 / 角色卡 / 世界书 / 模组 / 规则 只读；图标 / 地图 工作台；分享）**，只读 tab 为列表 + 分页折叠；右栏「跑团桌」新增 host 专属「内容工坊」入口。**工坊写回 / 导入导出 RPC 已实现（M9.5e 后端 + M9.6a UI）**：`pack.detail` / `pack.update` / `pack.export` / `pack.import` / `pack.assetPut` / `pack.assetDelete`，全部**仅 loopback + host token**；`pack.update` 走 `validatePack()` 后「临时文件 + rename」原子写回 `.trpgpack`，`pack.assetPut` 归一化后原子更新 `assets/manifest.json`，`pack.import` 支持 `reject` / `overwrite` / `rename`。**内置包只读**：对内置包的 `pack.update` / `pack.assetPut` / `pack.assetDelete` 一律 `conflict`（工坊提示「内置包只读」）；要编辑须先在「概览 → 复制为可编辑副本」，即 `pack.import` `strategy=rename` 产出 `<packId>-copy-N` 数据目录包后再写。可编辑表单（三个编辑器）与规则 tab 编辑器仍在 M9.6b，工坊页目前以只读列表 + 图标/地图工作台为主。

**角色卡双轨（Q3 已确认，2026-11-16）：pack 内置卡库 + 玩家本地私卡**

1. **pack 内置卡库**：作者在工坊里编辑 `pack.cards[]`，随 `.trpgpack` 分发；玩家导入/开团后出现在「落座/角色卡库」的「本团预制卡」分组，**只读**（不能就地改 host pack 或玩家端缓存的包内容），可选「复制为我的卡」生成一张本地私卡再改。
2. **玩家私卡**：真源在玩家本地——现状 `localStorage["dsh-trpg:cards:v1"]`（D9）；若后续接入 DSH 存储 API 则改存 profile-data，键名与数据结构不变。卡编辑器/卡库直接读写本地，不依赖 host 在线。
3. **落座**：玩家把本地卡转 `CharacterCard` 上传，host 按同一 card schema 校验（字段、数值范围、来源标注）后入房；host 不接受「在房间里改 pack 卡」，也不把玩家私卡写进 host pack。
4. **冲突与来源**：`cardId` 由玩家本地生成（`card_<nanos>_<hex>`），与 pack 卡撞 id 时以 pack 卡为准、本地卡另起 id（`-copy-1` 后缀）；复制 pack 卡得到的本地卡在 `source` 里保留 `{ ruleId, ruleVersion, moduleId }`（沿用 engine 旧形状，pack 级来源不写进卡）以便追溯。

角色卡编辑能力（D9）：新建空白卡 / 从预制模板或 pack 卡库复制；六属性、技能熟练、AC/HP/先攻、法术（属性/法术位/已知）、背包、外貌/性格/公开摘要；导入兼容本插件旧 v1 卡（`id` → `cardId`）与 DiceFrame `schema_version: 2`（M8.5 适配器，`source.ruleId` 标注来源）；只读卡面在战斗中也能看到 HP/AC/法术位（数据来自房间投影，不写回卡）。

## 5. GM 运行时消费（D7/D8）

### 5.1 世界书按需检索（替换全量注入）

现状 `buildGmSystemPrompt()` 把整本世界书拼进系统提示（`host/gm/prompt.ts:41-48,87-88`）。替换为：

```
候选 = alwaysOn ∪ 当前场景 loreIds ∪ 已 reveal 条目 ∪ 关键词命中(title/keys/content)
查询 = 最近玩家行动 + 当前场景标题/关键词
排序 = alwaysOn > 场景关联 > 已 reveal > 关键词命中；同档按 priority 降序
预算 = 最多 12 条 / 约 1200 tokens（常量可配），超出截断；可见性 = GM 提示可用 public + gm，玩家可见上下文只 public / player:<id>
```

- 系统提示只留守则 + 模组骨架 + 场景骨架 + 检索策略说明；每次行动把检索结果注入 user turn。
- 新增房间态 `revealedLoreIds`（`reveal_lore` 时写入并进快照）；`gm` 秘密默认只进 GM 提示、不进玩家可见上下文，`reveal_lore` 揭示后才可作为公开信息。

### 5.2 模组数据被真正消费（D8）

每次行动的场景提示段附「本场可用内容」：判定（when/skill/DC/success/failure）、遭遇（encounterId + 怪物组）、奖励（rewardId/XP/物品）、节拍（trigger/effect）。示例：

```
【本场可用（scene_qingshi）】
- 判定：向柳掌柜打听绿光 → persuasion DC 12（成功：…；失败：…）
- 遭遇：enc_guihuo（guihuo×2、zhiren×2）→ trpg_combat({action:'start'}) 的 monsters 参数（本场 maxRounds / battleMapId 取自遭遇数据）
- 奖励：reward_qingshi（XP 20）→ 场景清完后 gmAward；推进：玩家接下悬赏 → scene_guimuya
```

判定由 GM 调 `trpg_roll_check`；遭遇用 `trpg_combat`（`action:'start'`，按 encounterId 展开 monsters，并覆盖本场回合上限/战斗地图）；动作与移动用 `trpg_use_action` / `trpg_move`，具体动作从当前房间规则包读（见 [RULES-MODEL.md](./RULES-MODEL.md) §7.1）；奖励用 `gmAward`。不引入新状态机，只把数据变成 GM 可读内容。可选：`list_scene` 工具返回当前场景可用判定/遭遇/奖励，供 GM 重查（M8.4）。（v1 旧工具名 `trpg_start_combat` / `trpg_attack` / `trpg_next_turn` 为历史口径；`trpg_roll_check` 名称保留、语义泛化为 `kind` 由规则包定义。）

## 6. 分发、版本与权限（D10/D11）

### 6.1 导出、导入与校验流程

- **唯一分发形态**：`.trpgpack`（zip）。导出文件名 `<packId>-<version>.trpgpack`；素材进 `assets/`，`pack.json` 用相对路径引用（v1 已支持二进制素材，不再限制 inline SVG/base64）。
- **导入校验顺序**（全在 `decodePackZip` + `validatePack` 内，任一失败即拒绝并给中文原因）：zip 结构/魔数 → 条目大小与总量上限 → 路径安全与条目白名单 → 逐条 CRC32 → `pack.json` JSON 解析 → schema 与 `schemaVersion` → id 唯一与引用完整性（modules ↔ lorebook ↔ cards ↔ assets）→ 版本冲突处理。
- **CLI（M8.1 已交付，无 UI 也能完成全部导入导出）**：主入口 `scripts/content-pack.mjs`（子命令 `validate` / `export` / `import` / `inspect`；`scripts/pack-check.mjs` 为完全等价的兼容别名，旧写法 `pack-check.mjs <file>` / `--pack/-o` / `--verify` 继续可用）；根 `package.json` 提供 `content:pack`（`pnpm content:pack <子命令> …`）。

```
node scripts/content-pack.mjs export --pack core-guimuya \
  -o dist/core-guimuya-1.0.0.trpgpack --verify        # 导出内置包 + 重导出比对字节（断言可复现）
node scripts/content-pack.mjs validate dist/core-guimuya-1.0.0.trpgpack   # 校验 zip（结构/大小/路径/CRC/字段/引用/素材）
node scripts/content-pack.mjs import dist/core-guimuya-1.0.0.trpgpack --target content/packs   # 解包为 pack.json + assets/
node scripts/content-pack.mjs inspect dist/core-guimuya-1.0.0.trpgpack    # 打印包概要（模组/世界书/卡/素材/哈希）
```

- **冲突与覆盖**：同 `packId` 且同 `version` → 提示已安装（可跳过）；同 `packId` 不同版本 → 明确提示：覆盖（仅数据目录包）/ 另存副本（新 `packId` 后缀 `-copy-1`）；内置包不可覆盖。工坊「分享」tab 把这套策略做成下拉（`reject` / `overwrite` / `rename`），内置包用「复制为可编辑副本」= `pack.import` `strategy=rename`。
- **工坊 RPC（✅ 已实现 M9.5e 后端 + M9.6a UI，2026-11-16）**：导出/导入/写回不依赖 CLI 也能完成——`pack.export`（返回 `<packId>-<version>.trpgpack` 的 b64 + `packHash`）、`pack.import`（`reject` / `overwrite`（仅数据目录包）/ `rename`，内置包不可覆盖）、`pack.update`（整包 `validatePack()` 后原子写回）、`pack.detail`（读完整包）、`pack.assetPut` / `pack.assetDelete`（资产归一化 + `assets/manifest.json` 原子更新）；全部**仅 loopback + host token**，玩家不可调用。
- 安装写盘用「临时文件 + rename」原子落盘；安装前先全量校验，坏包不落盘、不进 registry。

### 6.2 角色卡双轨（Q3 已确认）

- **pack 内置卡库**：随 `.trpgpack` 分发，`pack.cards[]` 里 `owner.playerId = null` 即预制卡；host 与玩家端都以只读方式消费，玩家复制后成为本地私卡（§4）。
- **玩家私卡**：本地真源（`localStorage` 或 profile-data），不进 host pack、不随包分发；落座上传由 host 用同一 card schema 校验后入房（D8/D9）。
- **host pack 只读**：玩家不能改 host 上的包（无写接口、无写权限）；玩家可有自己的草稿 pack，但不入房，除非 host 导入。玩家上传 pack 给 host 审批列为 v2，不在 M8 做。

### 6.3 版本语义

`packVersion` 语义化；房间记录所用版本，续团时版本不一致走降级（§9）；内容更新不改 `packId`、只递增 `version`，`contentHash` 用于检测「同版本内容被替换」。

## 7. 分阶段排期（D12）

| 阶段 | 目标 | 交付/验收 | 依赖 |
|---|---|---|---|
| M8.1 ✅ 完成 2026-11-16 | **地基**：统一 schema + 内置包迁移 + zip 编解码 + 导入导出/校验（库/CLI，无 UI） | ①✅ `@dsh-trpg/content` 统一 pack/card/lorebook/module schema 与 `validatePack()`/`migratePack()`；②✅ 内置包 `core-guimuya` 迁移（4 卡 + 10 条世界书）；③✅ `.trpgpack` zip 编解码（`packToTrpgpack/trpgpackToPack`，别名 `encodePackZip/decodePackZip`；stored+deflate、大小/路径/CRC 校验、固定时间戳可复现）；④✅ 导入导出/校验 CLI `scripts/content-pack.mjs`（`pack-check.mjs` 兼容别名，根 `package.json` 加 `content:pack`）；⑤✅ 引用完整性校验（`loreIds/npcIds/encounterIds/rewardIds/startSceneId` + assets 引用存在）；⑥✅ 修复已知数据 bug（模组 `scene.lore` 值缺 `entry_` 前缀、与世界书 entry id 不匹配）；⑦✅ 保留 `GUIMUYA_*`/`PRESET_CARDS` 兼容导出；⑧✅ 单测：编解码/可复现/恶意 zip（炸弹·路径穿越·CRC 损坏）/迁移（`pack.test.ts` 14 + `zip.test.ts` 13） | 无 |
| M8.2 ✅ 完成 2026-11-16 | **房间接包**：`{packId, moduleId}` + 建房选模组 + 快照引用（去硬编码） | ①✅ `room.create` 可选 `packId/moduleId`（显式不存在给中文错误；缺省 = registry 缺省包 + `defaultModuleId`）；②✅ pack registry（内置 + 数据目录 `.trpgpack`，坏包跳过 / 重复 `packId` 内置优先 / 可重扫）；③✅ `RoomView.content` 与 `RoomView.scenes`；④✅ RPC `content.list`（脱敏目录，无 token）与 `content.reload`（loopback + host token）；⑤✅ 快照引用 + 包缺失/hash 漂移 `degraded` 降级续团、重扫恢复；⑥✅ GM 提示/工具按 `room.content` 解析、host 去 `GUIMUYA_*` 硬编码；⑦✅ 客户端大厅「内容包 / 模组」选择器、建房传 `packId/moduleId`、房间卡内容展示 + 降级红色告警、GM 场景下拉改吃 `room.scenes`；⑧✅ 单测新增（protocol 2 + rooms 9 + registry 6 + room-http 3）；真机验收通过 | M8.1 |
| M8.3 | 内容工坊 UI（主区域独立页 + 右栏轻量入口；卡只读面板 → 卡编辑器 → 世界书编辑器 → 模组编辑器） | 3 tab + pack 选择 + `.trpgpack` 导入导出 + 校验结果 + 预览；**在 M8.1、M8.2 完成后开工** | M8.1、M8.2 |
| M8.4 | GM 检索注入 + 模组数据消费 | 检索器 + token 预算、`revealedLoreIds`、本场可用内容提示段、`list_scene`、GM 秘密不泄露回归用例 | M8.1、M8.2 |
| M8.5 a ✅ 2026-11-16 · b ⬜ | 分享与 DiceFrame 适配 | `.trpgpack` 分享/导入冲突处理、DiceFrame `schema_version: 2` 卡适配器、内容作者文档（含 zip 目录结构与用编码器打包说明） | M8.1、M8.3 |

**M8.1 交付摘要（✅ 完成 2026-11-16）**：pack schema（`pack.ts`：`ContentPack` / `validatePack()` / `migratePack()` / `assertContentPack()` + D12 兼容适配）、内置包迁移（`packs/core-guimuya.ts`：`CORE_GUIMUYA_PACK` / `CORE_PACKS`，1.0.0 = 1 模组 / 10 条世界书 / 4 卡）、zip 编解码（`zip.ts` + `pack-zip.ts`：零依赖、stored+deflate、上限/路径/CRC、时间戳固定可复现）、文件落盘（`pack-io.ts`）、CLI（`scripts/content-pack.mjs` + `pack-check.mjs` 兼容别名，根 `package.json` 加 `content:pack`）、引用完整性校验、`scene.lore` 数据 bug 修复全部落地；单测 **87 → 114**（M8.1 阶段，`pack.test.ts` 14 + `zip.test.ts` 13），`typecheck` 0 错误，`node scripts/build.mjs` 构建通过。
**M8.2 交付摘要（✅ 完成 2026-11-16）**：host 内容权威 = `host/pack-registry.ts`（内置 `CORE_PACKS` + 数据目录 `<profile-data>/<profile>/dsh-trpg-table/content/packs/*.trpgpack`；统一走 `trpgpackToPack()` 校验；坏包跳过并记 warning、重复 `packId` 内置优先、目录整体读取失败保留上一份清单；`reload()` 可重扫）；协议 `room.create` 可选 `{packId, moduleId}`、`RoomView.{content, scenes}`、`content.list`（脱敏目录，无 token）与 `content.reload`（loopback + host token）；rooms 只存引用（`content: {packId, packVersion, moduleId, contentHash, packName?, moduleTitle?, scenes[]}`），旧快照按内置包补齐，包缺失/版本或 hash 漂移 → `degraded` + warning、GM 回退内置包，重扫后恢复原引用；host 去掉 `GUIMUYA_*` 直接依赖，GM 提示与 `trpg_*` 工具按房间解析模组/世界书；客户端大厅「内容包 / 模组」卡（`content.list` 失败静默降级内置包、不挡建房）、建房带内容引用、房间卡显示包/模组/版本 + degraded 红色告警、GM 控制台场景下拉优先 `room.scenes`（旧数据回退内置模组）。单测 **114 → 134**（protocol 2、rooms 9、registry 6、room-http 3），`typecheck` 0 错误，`node scripts/build.mjs` 构建通过；本机真机验收通过（大厅选择 / 建房后内容展示 / 场景下拉 3 场 / 关房回大厅，截图 `.tmp/verify3/`，gitignored）。
**M8.1 已知限制**：不支持 zip64（包 ≥ 4 GiB 直接报错）与加密/分卷 zip；`assets/` 目前只校验 `icon` 引用与 `assets/**` 路径安全（其它素材引用待 M8.3 工坊与 M8.5 分享），孤立素材只 warning；内置包暂不带 `assets/`。
**M8.2 已知限制**：没有客户端「导入包 / 重扫」UI——数据目录包需手工放入并重启 DSH（或走 `content.reload` RPC，工坊入口在 M8.3）；大厅内容目录失败只显示「目录不可用」并静默用内置包，不展示具体原因；`content.list` 不含封面/素材，包预览待 M8.3。

**M9.6a 工坊页交付摘要（✅ 完成 2026-11-16，承接 M8.3）**：主区域 keyed 工坊页 **8 tab（概览 / 角色卡 / 世界书 / 模组 / 规则 只读 + 图标 / 地图 工作台 + 分享）**，左栏包列表、只读 tab 用列表 + 分页折叠；图标工作台三路径（本地导入 / AI SVG / AI 生图含物品库批量 ≤6）→ `pack.assetPut`；地图工作室（`map.generate` / `world.generate` 预览 → 写入 `rules.space.battleMaps/zones/world` → `pack.update`，无 AI 走 procedural）；分享 tab：导出下载 `.trpgpack`、导入冲突策略、内置包「复制为可编辑副本」；大厅新增房主本机恢复；真机截图 `.tmp/verify6/01–06`。**M8.3 剩余**：三个可编辑表单（角色卡 / 世界书 / 模组）与规则编辑器随 M9.6b。
**M8.5a 交付摘要（✅ 完成 2026-11-16）**：`adaptDiceFrameCard` / `isDiceFrameCard` / `diceFrameToRulesCardJson`（DiceFrame `schema_version: 2` → `trpg.card/1` 与规则包）——属性/技能/资源/装备/叙事字段中英文别名映射、未映射 warning、`cardId` 稳定派生、个人世界书片段以 `personalLore` 另导；47 用例，**全量单测 957 → 1004**。**M8.5b 剩余**：卡库导入路径的 UI 接入、内容作者文档（zip 目录结构与用编码器打包说明）、另一台机器验收；分享 UI 已在 M9.6a 部分实现。

- 顺序理由（D12）：先保证地基（M8.1/M8.2）再上 UI，避免 schema 返工；zip 编解码是 M8.1 的头等交付（导入、导出、CLI、内置包构建都依赖它），放在统一 schema 之后、UI 之前。`packages/content` 重构为「内置 pack 定义 + 兼容导出」，host 已走 pack registry（M8.2），不一次性大爆炸。**M7 玩家侧镜像可并行**：它改 client 镜像/会话事件中继，与内容模型文件面基本不重叠；交叉点是 GM 提示组装（M8.4）与玩家投影，合入时一起回归。

## 8. 已确认决策（2026-11-16）

| # | 问题 | 结论 | 理由 / 影响 |
|---|---|---|---|
| Q1 | 内容工坊放哪？ | **主区域独立页 + 右栏轻量入口**（即 D6） | 三栏编辑器 + 大表单需要宽度，右栏 320–420px 放不下；右栏只保留选模组/我的卡/跳转工坊的轻量入口。主区域页需 keyed `main` panel 机制（v2 用过、已删），M8.3 实现 |
| Q2 | pack 形态？ | **`.trpgpack` = ZIP 容器**（`pack.json` + 可选 `assets/`），导出名 `<packId>-<version>.trpgpack` | 选 zip 而非单 JSON：后续要带图片/立绘/地图等素材，且单文件即一包、便于分享与版本归档；代价是需要内置 zip 编解码与导入校验（结构/大小上限/路径安全/CRC/可复现），**M8.1 就实现**（§2.2），不引入外部依赖（`node:zlib`）；单 JSON 无法承载二进制素材，目录式多文件分享易丢文件 |
| Q3 | 角色卡归属？ | **双轨：pack 内置卡库 + 玩家本地私卡** | 符合决策 #8「玩家本地真源」；pack 卡随包分发、只读、可复制成本地卡；本地私卡落座上传、host 校验；host pack 玩家不可改。需规定 `cardId` 冲突与 `source` 来源标注（§4/§6.2） |
| Q4 | 先地基还是先卡可视化？ | **先 M8.1（schema + zip + 导入导出/校验）→ M8.2（房间接包）→ 再 M8.3 UI** | 先 UI 会二次返工 schema；代价是一段时间没有可见界面，需向用户说明。M8.1 完成即可用 CLI 导入导出/校验打包，可见产物是 `.trpgpack` 与校验报告 |

## 9. 风险与兼容

| 风险 | 说明 | 对策 |
|---|---|---|
| 生效方式 / 编译进 host | 内置包是 `@dsh-trpg/content` 的 TS 数据模块（`CORE_PACKS`），改动需重装插件；数据目录包启动时扫描，运行中重扫走 `content.reload`（M8.2 ✅） | 内置包与 CLI 导出共用同一套 `packToTrpgpack()` 校验/编码；重扫失败给可读 warning 并保留上一份数据包清单（目录读取失败时）；`pack.version` 独立语义化，内置包变更走 `contentHash`，禁止运行时改内置包文件 |
| zip 压缩炸弹 | 恶意/畸形包可声明巨大解压体积耗尽内存 | 整包 **64 MiB** / 单条目 8 MiB / 解压总量 **64 MiB** / `pack.json` 4 MiB / 条目数 **520** 上限（M9.5b/c 已实装），解压即累计计数、超限立刻中止；拒绝 zip64 与非常规压缩方法；常量集中导出、单测注入超限 fixture |
| zip 路径穿越 / 结构异常 | 条目名 `../`、绝对路径、盘符、重复条目、加密条目、非 UTF-8 名 | 解析以中央目录为准；条目名规范化并白名单（仅 `pack.json` + `assets/**`）；拒绝绝对路径与 `..`；重复名（大小写不敏感）拒绝；不支持的标志/方法明确报错；解码只返回内存 Map、不直接落盘 |
| 导出不可复现 | 同一内容不同机器导出字节不同，`packHash` 与快照比对失真 | 固定条目顺序、DOS 时间戳（1980-01-01）、压缩级别 6、无 extra/comment/数据描述符；`--verify` 重导出比对字节；fixture 断言 `packHash` |
| CRC / 包损坏 | 传输截断或手改 zip 导致内容静默损坏 | 逐条 CRC32 与中央目录比对，失败报「第 N 个条目 CRC 校验失败」；校验不过不安装、不导出；registry 加载时坏包跳过并记 warning，不崩服务 |
| 素材缺失 / 解码失败 | `pack.json` 引用不存在的素材，或玩家端拉取素材失败 | `validatePack()` 在导入时拦「引用不存在」；运行时（缺包/玩家端拉取失败）用占位图 + warning 降级，不阻断开局；孤立素材只 warning |
| 快照引用失效 | 包被删/改版本/改 hash 后续团 | 房间照常恢复但标记 `degraded` + 广播 warning，GM 提示/工具回退内置包（场景摘要随快照保留，可继续玩）；导入对应 `.trpgpack` 后 `content.reload`（或重启 DSH）恢复原引用、清除降级；不静默换包 |
| DiceFrame 格式漂移 | `schema_version: 2` 语义与 D&D-lite 差异大 | 适配器隔离、版本守卫（只认 2）、未知字段不猜、`source.ruleId` 标注、fixture 单测；失败给迁移报告 |
| 现有引用已坏 | `scene.lore` 值与世界书 id 对不上（`qingshi` vs `entry_qingshi`） | M8.1 已由 `migratePack()` 自动补齐（`qingshi` → `entry_qingshi`）并靠 `validatePack()` 挡回归；旧导出保持兼容（D12） |
| 兼容导出漂移 | `id` → `*Id` 会改变 `GUIMUYA_MODULE` 等导出形状 | 适配层 `toLegacyModuleDef()/toCharacterCard()` 在 M8.1 落地；M8.2 后现有 **134** 项测试作为回归门（M8.1 时 114） |
