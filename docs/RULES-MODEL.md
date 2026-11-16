# 规则模型 v1：数据 + 公式 + JS 钩子（Rule Pack）

> 状态：**已拍板（2026-11-16），M9 实现**｜决策来源：[DECISIONS.md](./DECISIONS.md) 第八轮 #26（物品/图标资产扩展见第九轮 #27；**战斗空间/回合/地图生成与工具泛化见第十轮 #28**）｜关联：[DESIGN.md](./DESIGN.md) §5 规则系统、[CONTENT-MODEL.md](./CONTENT-MODEL.md) 内容包、[UI-CONTRACT.md](./UI-CONTRACT.md)（`items[]` 图标/`assets`/投影 DTO/世界地图页与战棋视图）、[ROADMAP.md](./ROADMAP.md) M9。
> 一句话：规则 = **数据**描述「有什么」，**受限公式**表达简单算法，**JS 钩子**只负责固定时机的复杂逻辑（**核心 8 + 场地/时间/上限 9**，全可选）；核心运行时不含任何具体规则。场地 = **zone-grid 双层**（大区域 + 战棋小格），时间 = **只做回合计数**，行动经济与地图结构也都是数据；地图由 AI 出结构化草稿 + 程序校验 + AI 底图，**结构数据才是权威**。

## 0. 摘要与四条确认

| # | 结论（已拍板，不再讨论） | 含义 | 明确不做 |
|---|---|---|---|
| 1 | **脚本 API 风格 = C 混合** | JSON 描述「有什么」（属性/技能/装备部位/词条/动作/成长/掉落/UI 分组）；受限公式表达简单算法（检定加值、AC、先攻、伤害加值）；JS 钩子只在固定时机接管复杂逻辑 | 不做图灵完备 DSL；不把全部规则塞进 JS；不让作者写任意插件代码 |
| 2 | **内置示例规则包 = dnd5e-lite 重写** | 把写死在 `packages/engine` 的 dnd5e-lite 用新模型重写成默认示例规则包，让「鬼木崖·异光」团继续玩，也给作者直接抄 | 引擎里不保留 dnd5e 分支；不并行维护两套规则实现 |
| 3 | **客户端只渲染主机成果** | 内容包 JS 只在 host 跑（`node:vm` 沙箱）；玩家客户端零脚本执行，只收主机算好的投影（`sheet.view` / `combat.view` / `worldMap.view`） | 不在玩家端求值公式、不跑钩子、不校验规则 |
| 4 | **脚本 = pack zip 内独立文件** | `rules/scripts/*.js`，`pack.json` 按钩子名引用并带 sha256；可 diff、可单测、可编辑器编辑 | 不内联进 `pack.json` 字符串、不打包成不可 diff 的 bundle |

**目标**：理论上能表达任意现有跑团规则（D&D 各版、CoC 骰池、freeform 武侠……），而不是只做一套更复杂的 D&D。**边界**：钩子数量固定（**核心 8 + 场地/时间/上限 9**，外加 1 个可选迁移钩子；全可选），表达力不够时优先让「数据更灵活」（装备槽/词条/公式命名空间/场地、距离算法、回合与行动经济数据），而不是无限制加钩子。

## 1. 为什么需要规则层

| | 线下跑团 | 本产品（线上 + 电脑结算） |
|---|---|---|
| 计算 | 人脑/纸笔，为省事简化规则与战斗（固定部位、固定条数、属性硬范围） | 主机实时算，能支撑复杂装备、词条叠加、多资源、条件链 |
| 呈现 | 口头描述 + 手写卡 | 可视化卡面（资源条、装备槽、词条列表、可用动作），可参考电子游戏装备 UI |
| 一致性 | 靠 GM 记忆与共识 | 规则包是唯一口径，事件日志可回放 |

所以**不必**仿照某个版本的跑团规则：装备不定义「固定部位 / 固定条数 / 固定属性范围」，而是让世界（规则包）自己定义「能穿几件、叫什么、有哪些词条、怎么叠」。现状 `packages/engine` 直接实现 dnd5e-lite，内容包的 `ruleSystem` 只是展示用标识（[CONTENT-MODEL.md](./CONTENT-MODEL.md) §2.4）——第二个规则 = 改引擎，玩家自制规则 = 改源码。规则层把三件事拆开：**核心运行时**（与规则无关的机制）→ **规则包**（数据 + 公式 + 钩子）→ **卡实例**（规则实例化）；引擎只执行规则包，不认识 dnd5e。

## 2. 分层架构

```
世界内容（.trpgpack：模组 / 世界书 / 卡库）                    ← 作者制作，M8
      │ 引用 rulesId + rulesVersion
      ▼
规则包（pack.rules：sheet / actions / formulas / scripts…）     ← 可 diff、可单测
      │ 实例化（validateSheet → 迁移 → computeDerived）
      ▼
角色卡实例（cardId + rulesId/Version + 属性/资源/装备/技能/状态）
      │ 落座上传，主机校验
      ▼
主机计算（唯一写者）= 核心运行时 + 规则执行器
  核心运行时（不含规则）：种子骰 / 回合先攻 / 事件总线 / 效果栈 / 快照 / 公式求值 / 沙箱
      │ 按玩家投影
      ▼
客户端（只渲染卡面/资源条/装备槽/动作/战斗面板）                ← 零脚本执行
```

| 层 | 负责 | 不负责 |
|---|---|---|
| 核心运行时 | 掷骰、先攻轮次、事件序号、效果栈、快照、公式求值、沙箱、校验框架 | 任何具体属性/技能/装备/战斗语义 |
| 规则包 | 定义有哪些数值、怎么算、什么时候调钩子、卡面怎么分组 | 访问文件/网络、决定房间流程、渲染 |
| 卡实例 | 保存玩家数据（属性/资源当前值/装备实例/技能/状态/备注/来源） | 保存派生值（AC、HP 上限、命中加值——由主机实时算） |
| 世界内容 | 模组/世界书/卡库，通过 `ruleSystem` 引用规则包 | 不内联规则实现 |
| 客户端 | 渲染主机下发的投影、提交玩家意图 | 不执行脚本、不计算数值、不判断可用动作 |

## 3. 规则包数据形状（`pack.rules`，schema `trpg.rules/1`）

规则包是内容包里的**自包含段**。同一 schema 两种承载：①M9 默认——内联在 `pack.json` 的 `rules` 段（数据只有一份）；②作者工作目录/未来独立分发——以 `rules/rules.json` 为根清单（便于 diff 与单测，构建时内联进 `pack.json.rules`）。**脚本永远是独立文件** `rules/scripts/*.js`，由 `pack.rules.scripts` 按钩子名引用并记 sha256。

```jsonc
{
  "schemaVersion": "trpg.rules/1", "rulesId": "dnd5e-lite", "rulesVersion": "2.0.0", "name": "D&D 5e-lite",
  "sheet": {
    "attributes": [   // 数值槽：名字/范围/默认值由世界定
      { "id": "str", "name": "力量", "min": 3, "max": 18, "default": 10 }, { "id": "dex", "name": "敏捷", "min": 3, "max": 18, "default": 10 } ],
    "resources": [ { "id": "hp", "name": "生命", "formula": "hpMax" }, { "id": "mana", "name": "真气", "formula": "manaMax" } ],
    "fields": [ { "id": "publicSummary", "name": "公开摘要", "kind": "text" }, { "id": "alignment", "name": "阵营", "kind": "enum", "options": ["守序", "中立", "混乱"] } ],
    "equipment": {
      "slots": [   // 世界自定义部位与可穿数量，不设固定部位/条数
        { "id": "mainHand", "name": "主手", "accepts": ["weapon:melee", "weapon:ranged"] }, { "id": "body", "name": "身上", "accepts": ["armor"] },
        { "id": "trinket", "name": "随身", "accepts": ["*"], "count": 3 } ],
      "stats": [   // 词条池：装备可提供哪些数值、各自怎么叠
        { "id": "攻击", "name": "攻击", "min": -5, "max": 15, "stacking": "add" }, { "id": "防御", "name": "防御", "min": 0, "max": 30, "stacking": "add" },
        { "id": "暴击范围", "name": "暴击范围", "min": 19, "max": 20, "stacking": "min" }, { "id": "先攻", "name": "先攻", "min": -5, "max": 10, "stacking": "add" } ],
      "stacking": { "add": "相加", "max": "取最大", "min": "取最小", "unique": "同名只生效最高一条" }
    },
    "skills": [ { "id": "athletics", "name": "运动", "attribute": "str" }, { "id": "stealth", "name": "潜行", "attribute": "dex" } ],
    "statuses": [ { "id": "poisoned", "name": "中毒", "duration": 3, "stacking": "refresh", "icon": "status/poison" } ]
  },
  "actions": [{   // 可用动作：数据能表达的结算全在数据里
    "actionId": "attack.melee", "name": "近战攻击", "kind": "attack",
    "cost": { "action": 1 }, "targeting": { "type": "single", "range": "engaged", "sides": "enemy" },
    "toHit": "attack", "damage": { "formula": "damage", "dice": "1d8" }, "description": "用主手武器攻击一个接触目标。" }],
  "progression": { "maxLevel": 10, "xpTable": [0, 100, 300, 600], "grants": [{ "atLevel": 1, "skillPoints": 2 }] },
  "tables": [{ "tableId": "loot.common", "roll": "1d100", "entries": [{ "min": 1, "max": 60, "itemId": "huozhezi" }] }],
  "items": [{   // 世界物品库：装备/消耗/材料都在这里；装备实例只存差异（§4）
    "itemId": "hengdao", "name": "横刀", "icon": "item/hengdao", "tags": ["weapon:melee", "锋利"],   // 短 id，加载时归一化为 @pack:assets/icons/item/hengdao.*
    "rarity": "common", "stats": { "攻击": 2 }, "equipSlot": ["mainHand"], "stackable": false,
    "description": "家传旧刀，刀脊有裂纹。" },
    { "itemId": "jinchuangyao", "name": "金创药", "icon": "@pack:assets/icons/item/jinchuangyao.png",
      "tags": ["consumable:heal"], "rarity": "common", "stackable": true, "useAction": "use.heal",
      "description": "恢复 1d8 生命。" }],
  "ui": {
    "groups": [{ "id": "combat", "title": "战斗", "fields": ["resources.hp", "derived.ac", "equipment.stats.攻击"] }],
    "itemCategories": [{ "id": "weapon", "name": "武器", "icon": "category/weapon", "tags": ["weapon"] }],  // 背包分类由物品 tags 生成
    "rarities": [{ "id": "common", "name": "普通", "color": "#9aa0a6" }, { "id": "rare", "name": "稀有", "color": "#4aa3ff" }],
    "templates": { "sheetCompact": ["resources", "attributes", "skills"], "itemCard": ["icon", "stats", "description"] },  // 三屏分组/卡片字段顺序
    "worldMap": { "labelMode": "always", "showConnections": true, "currentZonePulse": true, "exploredOnly": false },  // 世界地图页（主区域）渲染提示
    "battleGrid": { "gridOpacity": 0.2, "tokenSize": "auto", "showMoveRange": true, "showDistanceOnHover": true, "showCoverMarkers": true }  // 战棋视图渲染提示
  },
  "formulas": {   // 命名公式：只能引用变量与白名单函数，只算静态值（不含随机）
    "proficiency": "floor((level - 1) / 4) + 2", "hpMax": "8 + derived.mod.con * level + 5 * level", "manaMax": "level * 3",
    "check": "derived.mod + skill.proficient * proficiency + skill.bonus",
    "attack": "derived.mod + proficiency + equip.攻击", "damage": "derived.mod + equip.攻击",
    "defense": "10 + derived.mod.dex + equip.防御", "initiative": "derived.mod.dex + equip.先攻"
  },
  "scripts": {   // 钩子名 → 独立脚本文件 + sha256（同一文件可被多个钩子引用；场地/时间/上限钩子可选，见 §6）
    "validateSheet": { "file": "rules/scripts/sheet.js", "sha256": "…" }, "computeDerived": { "file": "rules/scripts/sheet.js", "sha256": "…" },
    "resolveCheck": { "file": "rules/scripts/combat.js", "sha256": "…" }, "resolveAttack": { "file": "rules/scripts/combat.js", "sha256": "…" },
    "resolveDamage": { "file": "rules/scripts/combat.js", "sha256": "…" }, "onEvent": { "file": "rules/scripts/events.js", "sha256": "…" },
    "onLevelUp": { "file": "rules/scripts/progression.js", "sha256": "…" }, "generateLoot": { "file": "rules/scripts/progression.js", "sha256": "…" }
  },
  "migrations": []   // 可选：卡/规则版本迁移声明
}
```

| 段 | 关键约束 |
|---|---|
| `sheet.attributes[]` / `fields[]` | 数值槽（`min/max/default` 定范围）；`text/number/enum` 自由字段仅展示与钩子读取，落座时 `validateSheet` 二次校验 |
| `sheet.resources[]` | 上限由命名公式算；**当前值存卡实例**，不存上限 |
| `sheet.equipment.slots[]` | 世界自定义部位与件数；`accepts` 为标签数组，`*` 表示任意 |
| `sheet.equipment.stats[]` | 词条池；只定义「允许哪些数值及范围」，具体数值由装备实例给 |
| `sheet.skills[]` / `statuses[]` | 技能→属性映射（加值 = 条目公式 + 熟练）；状态定义时长（单位 = `time.durationUnit`，v1 恒为回合）/叠加/图标，持续效果由 `onEvent`/`resolveDamage` 处理 |
| `actions[]` | 结算数据；`toHit/damage` 引用命名公式，骰子只写表达式字符串，复杂结算标记钩子 |
| `items[]` | 世界物品库（装备/消耗/材料）：`stats` 是词条基准值（装备实例只存差异）；`equipSlot` 限定可穿槽位；`stackable/useAction` 支撑背包操作；`icon` 指资产（[UI-CONTRACT.md](./UI-CONTRACT.md) §1） |
| `ui.{groups,itemCategories,rarities,templates,worldMap,battleGrid}` | 卡面分组、背包分类与稀有度（含颜色）、三屏模板、世界地图页与战棋视图的渲染提示；**只描述怎么显示，不含任何数值** |
| `space` / `time` / `turn` | 场地（zone-grid：`zones` / `battleMaps` / `terrains`）、时间（仅回合计数 + `maxRounds`）、行动经济（每回合资源池）；均可选，详见本节下方三小节 |
| `formulas{}` | 命名公式（`check/attack/damage/defense/initiative` 为约定键，可扩展） |
| `progression / tables / ui / migrations` | 成长、随机表、卡面分组、版本迁移；均可选 |

**「能数据表达的不写脚本」**：属性范围、技能属性、装备部位与词条叠法、动作消耗与目标、成长点数、掉落表、卡面分组全是 JSON；只有需要循环/查表/条件链时才写钩子。规则包内 id 允许中文（如 `attr.敏`、`equip.攻击`），校验规则 `^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5-]*$`，namespace 内唯一。

### space（场地：zone-grid 大区域 + 战棋小格，可选段）

`space.model`：`none`（默认，theater-of-mind，沿用 v1 距离档位 `engaged/near/far`）`| zone`（只有大区域）`| grid`（只有格子图）`| zone-grid`（**推荐 = 大区域 + 战棋小格双层**）。核心运行时只管「谁在哪、隔多远、有没有掩体、能不能走过去」，**不管怎么画**（渲染见 [UI-CONTRACT.md](./UI-CONTRACT.md) §5.4/§5.5）。与 `items[]`/`ui{}` 一样是 `pack.rules` 的可选顶层段，缺省即无场地概念。

```jsonc
"space": {
  "model": "zone-grid",                   // none（默认）| zone | grid | zone-grid
  "units": "m",                           // 展示单位：m / ft / 格
  "distanceMode": "chebyshev",            // chebyshev（默认）| manhattan | dnd5e | euclid
  "grid": { "cellMeters": 1.5 },          // 战棋格默认格宽（所有 battleMaps 共用；世界地图不使用）
  "world": {                              // 世界/区域层：主区域「世界地图页」的插画底图与热点基准
    "backgroundAssetId": "map/region-qingshizhen",   // AI 生成 2D 插画底图；缺省 → 程序化底图
    "width": 2048, "height": 1536                    // 美术比例参考（热点坐标用 0–1 归一化，不依赖像素）
  },
  "zones": [                              // 大区域：世界地图上的一个热点
    { "zoneId": "qingshi_gate", "name": "镇口", "parentZoneId": null, "tags": ["open"],
      "connections": [{ "to": "cave_mouth", "kind": "road", "distance": 3 }],
      "hotspot": { "x": 0.32, "y": 0.61, "icon": "zone/gate" },
      "battleMapId": null },
    { "zoneId": "cave_mouth", "name": "洞口", "parentZoneId": "qingshi_gate", "tags": ["dark"],
      "connections": [{ "to": "qingshi_gate", "kind": "road", "distance": 3 }],
      "hotspot": { "x": 0.58, "y": 0.44, "icon": "zone/cave" },
      "battleMapId": "map_cave_mouth" }
  ],
  "battleMaps": [                         // 小格子：战棋战斗地图（结构数据 = 权威，底图只是皮肤）
    { "mapId": "map_cave_mouth", "zoneId": "cave_mouth", "cols": 12, "rows": 9,
      "terrain": [                        // rows × cols 地形 id 矩阵，行优先；最外圈默认不可通行
        ["wall","wall","wall","wall","wall","wall","wall","wall","wall","wall","wall","wall"],
        ["wall","floor","floor","floor","rubble","rubble","floor","floor","floor","floor","floor","wall"],
        ["wall","floor","floor","wall","wall","floor","floor","floor","floor","floor","floor","wall"]
        /* …其余行略，必须共 rows 行、每行 cols 个 */
      ],
      "obstacles": [ { "x": 3, "y": 4, "w": 2, "h": 1, "terrain": "rubble", "coverId": "half" } ],
      "spawns": [ { "x": 1, "y": 7, "side": "player", "label": "入口" },
                  { "x": 10, "y": 2, "side": "enemy", "monsterId": "xueshi" } ],
      "backgroundAssetId": "map/battle-cave-mouth",   // AI 生成/程序化的俯视底图
      "calibration": { "offsetX": 0, "offsetY": 0, "cellPx": 64 } }   // 底图与网格对齐参数（只影响显示）
  ],
  "terrains": [ { "id": "floor", "name": "地面", "moveCost": 1 },
                { "id": "wall", "name": "岩壁", "moveCost": 0, "blocksMove": true, "blocksSight": true },
                { "id": "rubble", "name": "碎石", "moveCost": 2 } ],
  "covers": [ { "id": "half", "name": "半掩体", "defenseBonus": 2, "tags": ["wall", "cart"] } ],
  "areas": [ { "areaId": "poison_mist", "name": "毒雾", "shape": "circle", "radius": 2, "effect": "status:poisoned" } ]
},
"formulas": { "distance": "space.cells * 1.5", "movement": "derived.speed * 2" }
```

| 成员 | 约束 |
|---|---|
| `model` | `none` 时忽略其余成员，距离仍按 `actions[].targeting.range` 档位判定——**向后兼容 dnd5e-lite 现状**，现存团不受影响 |
| `distanceMode` | 距离算法是**数据项**（不写死）：`chebyshev`（默认，八方向同耗）/ `manhattan`（四方向）/ `dnd5e`（斜向 5-10-5 交替）/ `euclid`（斜向按 √2）。核心据此算格数；要特殊算法 → `computeDistance` 钩子 |
| `zones[]` | 大区域。`parentZoneId` 表达嵌套（镇 → 镇口）；`connections[]` = 有向可通行边（`kind: road/river/stairs/...`，`distance` 单位取 `units`）；`battleMapId` 指向该区域战斗时用的战棋图（无则 theater-of-mind）；`hotspot` = 世界地图归一化坐标 `x/y ∈ [0,1]` + 可选图标 |
| `battleMaps[]` | 小格子。`cols/rows` **≤ 32×32**；`terrain[][]` 长度 = rows、每行 cols，值必须命中 `terrains[].id`；`obstacles[]` 可带 `coverId`；`spawns[].side` = `player/enemy/neutral`，**同格不重复**；单图 token ≤ 20；`calibration` 只影响显示 |
| `terrains[]` / `covers[]` / `areas[]` | 地形移动力/阻挡、掩体加成、范围效果；具体条件链仍落 §6 钩子 |
| `world.backgroundAssetId` | 世界地图插画底图（资产见 [UI-CONTRACT.md](./UI-CONTRACT.md) §1）；缺省或加载失败 → 程序化底图，热点/连线照常渲染 |
| 上限 | 单张战斗图 **≤ 32×32**、单场 token **≤ 20**、**一个包内地图 ≤ 64 张**（战斗图 + 世界图合计） |

- `distance` / `movement` 是**约定公式键**（不强制）：能数据表达就写公式（`space.*` 变量由核心运行时注入：`cells` 格数、`meters` 米数、`hops` 区域跳数）；区域进出、掩体匹配等条件链交给 §6 的场地/时间/上限 9 钩子。
- **权威顺序**：`terrain/obstacles/spawns` 的结构数据 > 底图美术。底图只负责好看，判定永远读结构数据；换底图不改规则。

### 战斗地图与世界地图生成（M9.5e）

**结论**：地图**不手绘**。作者只说「这一战在哪、谁在场、什么地形」，管线固定为：
**AI 文本生成结构草稿 → 程序校验 → 修正/重生成 → AI 生图出底图 → 预览叠加（底图 + 网格 + 图标）→ 作者微调 → 落盘**。
**结构数据（`cols/rows/terrain/obstacles/spawns`）是唯一权威，底图只是皮肤**；AI 生图失败或离线时用**程序化底图**（按地形矩阵画色块/纹理），战斗照常可玩。

| 步骤 | 输入 | 产出 | 失败/兜底 |
|---|---|---|---|
| ① 结构草稿（AI 文本） | 区域名/地形描述/怪物组/玩家人数 | ASCII 地形矩阵 + 障碍/出生点行 + 一行图例 | 模型输出不可解析 → 重试 ≤3 → 程序生成结构 |
| ② 程序校验（硬闸） | 草稿 | 合法 `battleMaps[]` 或**逐条错误清单** | 任一硬校验失败即**拒绝**，错误原文回给 AI 重生成或作者手改 |
| ③ 底图（AI 生图） | 结构摘要 + 风格档 + 氛围 prompt | 俯视/插画底图 PNG（1024 请求 → 归一化落盘） | 失败/超时 → 程序化底图；不阻塞地图可用 |
| ④ 预览叠加 | 底图 + 网格 + 地形/障碍图标 + 出生点 | 对齐预览（作者调 `offsetX/offsetY/cellPx`） | 对齐失败 → 纯网格模式，底图仅作参考 |
| ⑤ 落盘 | 确认后的结构与底图 | `space.battleMaps[]` + `assets/manifest.json` + `backgroundAssetId` | `validatePack()` 失败 → 回滚（原子写，沿用 M8.1） |

**结构草稿格式（AI 只准输出这个格式），示例**：

```
SIZE 16x8
LEGEND # wall | . floor | ~ rubble
################
#....~~........#
#..##..........#
#..##..........#
#..............#
#....~~........#
#..............#
################
spawns: player 1,6 | enemy 10,2
```

**校验器（缺一不可，M9.5e 单测覆盖）**：

| 校验 | 规则 |
|---|---|
| 尺寸 | `1 ≤ cols,rows ≤ 32`，与 `SIZE` 一致；`terrain[][]` 行列数严格匹配 |
| 边界 | 最外圈默认不可通行（`blocksMove`）；出生点不得在边界上或墙/水里 |
| 连通性 | 从任一玩家出生点 BFS 能到每个敌人出生点（`blocksMove` 的地形不通行） |
| 出生点 | 互不重叠、所在格可站立、玩家/敌人出生区不混；单图 spawn ≤ 20 |
| 引用 | `zoneId` 必须存在于 `zones[]`；`battleMapId` 反向引用一致；`monsterId` 必须存在 |
| 图例 | 未知字符 → 错误（**不静默当墙**）；地形 id 必须在 `terrains[]`，且至少有一种可站立地形 |

**世界地图生成**（同一管线、粗一档）：AI 只出「区域清单 + 关系 + 热点坐标草稿」→ 校验（`connections.to` 都要有对应 zone、父区域无环、热点不重叠且落在画布内）→ AI 生 2D 插画底图 → 预览叠加（底图 + zone 热点/连线 + 当前所在区域）→ 微调。世界地图页只负责展示与导航，**不参与格子级判定**。

**风格档**：世界图 = `2d-illustration`（俯视/等距插画，无网格）；战斗图 = `topdown-2d`（俯视 2D）或 `pixel-topdown`（像素风）两档。底图与网格的**对齐参数**（`offsetX/offsetY/cellPx`）记在 `battleMaps[].calibration`，对齐只影响显示、不影响格坐标。

**与工作台的关系**：生成/校验/对齐的 UI 在 **M9.5e 地图与战棋生成工作台**（[UI-CONTRACT.md](./UI-CONTRACT.md) §10）；结构编辑、底图替换与微调在 **M9.6 地图工坊**。AI GM 可以生成草稿，但**不能直接写 `battleMaps` 结构**（必须过校验器）。

### time（时间：只做回合计数，可选段）

**结论**：v1 **不做时钟/时段/现实时间**，时间只按**回合**推进（一场战斗的一轮 = 一个时间片；非战斗探索也按回合计，由 GM 工具推进）。状态/效果/冷却统一按回合数计。

```jsonc
"time": {
  "model": "round",              // round（默认）| none
  "durationUnit": "round",       // 状态/效果/冷却的唯一计时单位（v1 仅 round）
  "defaultMaxRounds": 10,        // 每场战斗默认回合上限（遭遇/房间可覆盖）
  "onRoundLimit": "end"          // 到上限后：end（默认）| draw（平局收场）| overtime（继续并标记）
}
```

- `maxRounds` 解析顺序：**房间/遭遇覆盖 > `time.defaultMaxRounds`**；到上限触发 §6 的 `onRoundLimit`，钩子可返回 `{action, effects, log}` 接管（如「加时 + 增援」）；钩子未实现 → 按 `time.onRoundLimit` 字面执行。
- 时间只由工具/钩子推进（战斗内 `trpg_combat({action:'nextTurn'})`，非战斗时 `trpg_time_advance`），**不读系统时钟**（确定性）；`onTimeAdvance` 保留，用于记录非战斗的时间推进。
- `durationUnit` v1 恒为 `round`：`sheet.statuses[].duration`、冷却、`onRoundStart/onRoundEnd` 的 tick 全按回合；要引入 minute/hour/day 先改这里（v2）。
- 环境效果（夜/雾/毒雾）不用 `time` 表达：静态的落 `space.areas[]`，随回合变化的落 `onRoundStart/onRoundEnd` 钩子。

### turn（行动经济，可选段）

**结论**：每回合有哪些资源、各几次、移动力多少，全部由**规则数据**定义；核心运行时只做**计数与消耗**，不认识「动作/附赠动作/反应」这些具体名字。`actions[].cost` 的键 = `turn.resources[].id`，因此「D&D 三条资源」与「3 点行动力」是同一套机制。

```jsonc
"turn": {
  "refill": "turnStart",                  // 每回合开始回满（v1 只支持 turnStart）
  "resources": [
    { "id": "action",   "name": "动作",     "perTurn": 1 },
    { "id": "bonus",    "name": "附赠动作", "perTurn": 1 },
    { "id": "reaction", "name": "反应",     "perTurn": 1 },
    { "id": "movement", "name": "移动力",   "perTurnFormula": "movement", "unit": "m" }   // 数值取命名公式
  ],
  "endTurn": { "trigger": "player" }      // player（默认，玩家/工具结束）| auto（资源耗尽自动结束）
}
```

- 动作定义示例：`"cost": { "action": 1 }`；「3 点行动力」风格 = 只建 `[{ "id": "ap", "name": "行动点", "perTurn": 3 }]`，动作写 `{ "cost": { "ap": 1 } }`。
- 核心只校验「资源够不够、扣多少、每回合回满」，**语义（这一下算不算动作）在规则包里**；判定顺序见 §7。
- 移动力是资源的一种：移动提交按 `formulas.movement` + 地形 `moveCost` 计消耗，由核心扣减或 `onMove` 钩子接管；`turn` 段缺省 → 不限制行动次数（自由 RP）。

## 4. 卡实例形状

```jsonc
{
  "schemaVersion": "trpg.card/1", "cardId": "card_aqing", "rulesId": "dnd5e-lite", "rulesVersion": "2.0.0",
  "attributes": { "str": 17, "dex": 14, "con": 15, "int": 10, "wis": 12, "cha": 8 },
  "resources": { "hp": { "current": 22, "max": 22 }, "mana": { "current": 3, "max": 3 } },
  "fields": { "publicSummary": "背刀的山民少女…", "alignment": "中立" },
  "equipmentInstances": [
    { "instanceId": "ins_hengdao", "slot": "mainHand", "name": "横刀", "tags": ["weapon:melee"], "stats": { "攻击": 2 }, "note": "家传旧刀" }
  ],
  "skills": [{ "id": "athletics", "proficient": true, "bonus": 0 }],
  "statuses": [{ "id": "poisoned", "stacks": 1, "remaining": 2 }],
  "assets": {   // 可选：形象资产引用，字段与标准化约束见 UI-CONTRACT §8
    "avatar": "@local:card_aqing:avatar.main", "portrait": "@local:card_aqing:portrait.main",
    "portraitVariants": { "smile": "@local:card_aqing:portrait.smile", "attack": "@local:card_aqing:portrait.attack" },
    "spriteSheet": { "assetId": "card_aqing:sheet.walk", "rows": 4, "cols": 4, "frameSize": 128,
                     "frames": [{ "name": "walk.down.0", "index": 0 }] }
  },
  "notes": "玩家备注", "origin": { "packId": "core-guimuya", "moduleId": "guimuya" }
}
```

- **派生值不存卡**：AC、HP 上限、命中加值、先攻加值、技能总加值、装备词条聚合值全部由主机按 `computeDerived` + `formulas` + 装备实时算；卡只存「角色自己拥有的数据」。
- `assets` 只存**引用**（`@local:` 本地 / `@room:` 落座后），二进制不进卡；尺寸/格式/体积由 [UI-CONTRACT.md](./UI-CONTRACT.md) §3 强制，落座只上传展示用资产（§4.5）。
- `resources.<id>.current` 是唯一在卡里存的运行态；`max` 只是缓存/参考，以主机计算为准。`equipmentInstances[].stats` 是**实例化时的词条快照**（物品定义在内容包/规则数据里，实例只存差异）；换装备由主机重算投影。换规则包后旧卡必须经 `migrations` + `migrateSheet` 迁移，否则只读。

## 5. 受限公式语言

```
expr    := term (('+' | '-') term)*
term    := factor (('*' | '/' | '%') factor)*
factor  := '-'? primary
primary := number | path | func '(' args ')' | '(' expr ')'
path    := id ('.' id)+            // attr.str / derived.mod.dex / equip.攻击 / skill.潜行
func    := min | max | floor | ceil | round | abs | clamp
```

| 变量 | 含义 | 例 |
|---|---|---|
| `attr.<id>` | 属性原始值 | `attr.str`、`attr.敏` |
| `level` | 角色等级 | `floor((level - 1) / 4) + 2` |
| `skill.<id>` | 指定技能的**总加值**（主机算好后注入，可跨技能引用） | `skill.潜行` |
| `equip.<statId>` | 装备词条按 stacking 聚合后的值 | `equip.攻击` |
| `sheet.<fieldId>` / `resource.<id>` | number 类型自由字段 / 资源上限 | `sheet.负重上限`、`resource.hp` |
| `derived.<key>` | `computeDerived` 产出（可嵌套点路径） | `derived.ac`、`derived.mod.dex` |
| 结算上下文 | `proficiency`、`skill.proficient`（0/1）、`skill.bonus`、`derived.mod`（当前属性调整值） | — |
| `space.<key>` / `time.<key>` | 场地/时间上下文（核心运行时注入：`space.hops/cells/meters`、`time.segment/day`） | `space.hops * 3` |
| 运算/函数 | `+ - * / %`、括号、一元负号；`min/max/floor/ceil/round/abs/clamp(x,lo,hi)` | `clamp(derived.ac, 0, 40)` |

**禁止**：赋值/字符串/布尔/比较/三元/函数定义/循环/副作用/文件/网络/随机/时间。需要条件与循环 = 写钩子。

| # | 例 | 公式 |
|---|---|---|
| 1 | 熟练加值 | `floor((level - 1) / 4) + 2` |
| 2 | 技能检定 | `derived.mod + skill.proficient * proficiency + skill.bonus` |
| 3 | AC | `10 + derived.mod.dex + equip.防御` |
| 4 | 命中加值 | `derived.mod + proficiency + equip.攻击` |
| 5 | 伤害加值（骰子另由 `action.damage.dice` 掷） | `derived.mod + equip.攻击` |
| 6 | 先攻 | `derived.mod.dex + equip.先攻` |

**错误处理**：编译期（加载规则包时）校验语法、变量命名空间、函数白名单、公式 id 引用，一次聚合报出全部错误并定位 `formulas.<key>: 第 N 列 未知变量 xxx`；运行期错误（除零、`derived` 缺 key）→ 该次结算回滚 + `rules/error` 事件，不崩房。

## 6. JS 钩子 API（核心 8 + 场地/时间/上限 9）

钩子全部**可选**，缺省走「数据 + 公式」路径。**核心 8** = 下表前 8 行（`validateSheet` … `generateLoot`）；**场地/时间/上限 9** = `computeDistance` / `onMove` / `onEnterZone` / `onLeaveZone` / `computeCover` / `onTimeAdvance` / `onRoundStart` / `onRoundEnd` / `onRoundLimit`（9 个独立时机）；外加可选 `migrateSheet`。脚本是 CommonJS 模块（沙箱提供 `module/exports`，无 `require`），一个文件可导出多个钩子。

| 钩子 | 时机（谁调） | 输入 → 输出 | 缺省行为 |
|---|---|---|---|
| `validateSheet(ctx, sheet)` | 建卡 / 改卡 / 落座 | sheet → `string[]`（空=通过，中文人话） | 只做 schema + 数值范围校验 |
| `computeDerived(ctx, sheet)` | 投影前、每次结算前 | sheet → `Record<string, number\|string>`（`ac`、`hpMax`、`mod.str`） | 返回 `{}` |
| `resolveCheck(ctx, req)` | 检定（`trpg_roll_check`） | `{kind, actor, attribute/skill, dc, mods, mode}` → `{total, success, crit?, degree?, log?}` | `d20 + formulas.check + mods` vs DC |
| `resolveAttack(ctx, req)` | 攻击类动作（`trpg_use_action` 的 kind=attack） | `{actor, target, action, range, mods}` → `{hit, crit, damage, reactions?, log?}` | `d20` vs `formulas.defense`；命中后掷 `damage.dice` + `formulas.damage` |
| `resolveDamage(ctx, evt)` | 伤害落账前 | `{target, amount, type, source, effects}` → `{amount, consumedEffects?, notes?}` | 先扣临时 HP，再扣 HP |
| `onEvent(ctx, event)` | 事件总线：`turn/start\|end`、`action/before\|after`、`damage/after`、`death`、`equip/change`、`status/tick`、`move`、`zone/enter\|leave`、`time/advance`、`round/start\|end\|limit` | event → `{effects?, sheetUpdates?, log?}` | 不做任何事 |
| `onLevelUp(ctx, req)` | 成长结算 | `{level, xp, gains}` → sheet patch | 按 `progression.grants` 自动发点数 |
| `generateLoot(ctx, req)` | 掉落/奖励 | `{tableId?, encounterId?, level}` → 物品实例[] | 按 `tables[]` 用种子骰掷表 |
| `computeDistance(ctx, req)` | 任何需要距离的结算前（攻击/移动/选目标） | `{actor, target, kind}` → `{distance, band?, path?}` | 按 `space.distanceMode` 与 `formulas.distance` 算；`none` → 距离档位 |
| `onMove(ctx, req)` | 移动提交/落位 | `{actorId, from, to, cost}` → `{ok, remaining?, effects?, log?}` | 按 `formulas.movement` 扣移动力，地形 `moveCost` 计入 |
| `onEnterZone(ctx, evt)` | 单位进入区域/格子 | `{actorId, zoneId, via}` → `{effects?, log?}` | 不做任何事 |
| `onLeaveZone(ctx, evt)` | 单位离开区域/格子 | `{actorId, zoneId, via}` → `{effects?, log?}` | 不做任何事 |
| `computeCover(ctx, req)` | 攻击/检定前判掩体 | `{attacker, target, targetZone}` → `{defenseBonus, tags?}` | 按 `space.covers` 数据匹配 |
| `onTimeAdvance(ctx, req)` | 时间推进（非战斗回合计数/休息） | `{from, to, cause}` → `{effects?, sheetUpdates?, log?}` | 推进回合计数，只清过期冷却/持续效果（**不读系统时钟**） |
| `onRoundStart` / `onRoundEnd` | 战斗回合边界 | `{round, order}` → `{effects?, log?}` | 回合计时（冷却/持续效果 tick、`maxRounds` 内继续） |
| `onRoundLimit(ctx, req)` | 回合数达到 `maxRounds` | `{round, maxRounds, order}` → `{action: 'end'\|'draw'\|'overtime', effects?, log?}` | 按 `time.onRoundLimit` 字面执行（`end`/`draw`/`overtime`） |
| `migrateSheet(ctx, sheet, fromVersion)`（可选） | 卡/规则版本迁移 | 旧 sheet → 新 sheet | 只做数据迁移表能表达的改名/补默认值 |

**与 `onEvent` 的关系**：场地/时间/上限钩子在核心运行时里有**明确的调用点**（算距离 → 判移动 → 区域进出 → 掩体 → 时间推进 → 回合边界 → 回合上限），先于通用事件总线执行；它们返回的 `effects/sheetUpdates` 照常进效果栈与事件日志，`onEvent` 之后仍会收到对应事件 kind（`move`、`zone/enter`、`zone/leave`、`time/advance`、`round/start`、`round/end`、`round/limit`）。专用钩子未实现 → 退化为「数据 + 公式」；公式也不够 → 再交给 `onEvent`；两者都不写 = 该规则没有场地/时间概念（`space.model: none`、`time.model: none`），不影响现有团。

**ctx 能力表**

| 能力 | 语义 | 约束 |
|---|---|---|
| `ctx.roll(expression)` / `ctx.rng()` | 种子化掷骰 `{dice,total}` / `[0,1)` 随机 | 必走引擎 RNG，禁止 `Math.random` |
| `ctx.attr(id)` / `ctx.derived(key)` / `ctx.action` / `ctx.target` | 读属性、派生值、当前结算上下文 | 只读 |
| `ctx.sheet.get(path)` / `ctx.sheet.set(path, value)` | 读写卡；`set` 产生 patch | `set` 仅 `onEvent/onLevelUp/migrateSheet` 可用；抛错整体回滚 |
| `ctx.equipment.list()` / `stats(statId)` | 装备实例列表 / 词条聚合 | 只读 |
| `ctx.effects.apply(effect)` / `remove(id)` | 挂/卸持续效果与状态 | 由内核入效果栈 |
| `ctx.resource.get(id)` / `spend(id, n)` | 资源读/扣 | 扣减走内核事务 |
| `ctx.tables.pick(tableId)` | 按种子掷表 | 记录进事件 |
| `ctx.log(text)` | 写规则日志（进 GM 提示/事件） | 有长度上限 |
| `ctx.space` / `ctx.turn` | 位置与回合上下文：`{zoneId, cell?, distance?, round, maxRounds, actorId, seq}` | 只读；**不给系统时间**（确定性） |

**不提供**：文件、网络、子进程、环境变量、系统时间、定时器、`require/import/eval`、完整 `Math`（只给 `floor/ceil/round/abs/min/max/pow`）。**确定性**：钩子内随机数由 `sha256(roomSeed + eventSeq + hookName + 本次调用序号)` 派生，复盘同一 eventSeq 必得同一结果；`ctx.roll` 骰面并入事件日志。

**错误与资源语义**：抛错或超时（默认 **200ms/次**，可配）→ 该次结算**事务回滚**（HP/资源/状态不变），产生 `rules/error` 事件（`alert level=error`，含钩子名/入参摘要/错误/堆栈前 N 行），房间继续；同一钩子连续 3 次失败 → 房间降级并提示房主。脚本 sha256 与清单不符 → 拒绝加载规则包，建房/入房给可读错误。资源限制：单规则包脚本 ≤ 32 个 / ≤ 256 KiB；单场钩子调用 ≤ 10000 次；沙箱单次执行 ≤ 200ms。

## 7. 执行流程（谁调谁）

```
建卡 → validateSheet + schema → 落座（迁移旧卡）→ 投影（computeDerived + formulas + 装备聚合）
检定 → GM 工具 trpg_roll_check(kind) → 内核校验轮次/消耗 → resolveCheck → dice 事件
动作 → GM 工具 trpg_use_action(actionId) → 校验行动经济/距离/目标 → 命中则 resolveAttack → resolveDamage → HP/状态写回 → damage/after
移动 → GM 工具 trpg_move(role, to) → 距离/地形/连通性/移动力 → onMove → move 事件（跨区域时 onLeaveZone/onEnterZone）
战斗 → GM 工具 trpg_combat(action) → start 掷先攻 / nextTurn 走 onRoundStart/End / 到 maxRounds 走 onRoundLimit / end 收场
时间 → 回合推进（战斗内 nextTurn、非战斗 trpg_time_advance）→ onTimeAdvance → status/tick → onEvent
成长 → 工具 gm_award / 结算 XP → onLevelUp → 卡 patch → validateSheet
掉落 → generateLoot → 物品实例 → equip/change 事件 → onEvent
```

**硬规则（沿用 DESIGN §4 五道锁）**：AI GM 只能通过工具触发引擎结算，只能按工具返回的数值叙事；没有工具返回值的数字一律不进状态（锁 2）。状态唯一写者是主机（锁 3），客户端不写。

**例：「我砍它一刀」的完整调用链**

```
1. 玩家输入「我砍它一刀」→ 客户端只发文本（room.say）；host 由 token 绑定 playerId→characterId（锁 1）
2. 会话 Agent（AI GM）判定为攻击，调 `trpg_use_action(actionId="attack.melee", target="血尸")`
3. 规则执行器（host）：a. 核心运行时校验轮次/行动经济（`turn.resources`）/距离（`space.distanceMode`）/目标（非规则代码）→ b. `computeDerived`（脚本）→ `derived.mod.str=3`、ac、hpMax
   c. `resolveAttack`（脚本）→ `ctx.roll("1d20")` 种子骰，得出 hit/crit → d. 命中则骰 `action.damage.dice`，`resolveDamage`（脚本）处理抗性/护盾
   e. 核心运行时写回目标 HP、扣 `action` 资源、记事件 `attack` / `damage/after`；`onEvent`（脚本）做后续
4. 工具结果（骰面/命中/伤害/剩余 HP）返回会话 → AI 只能据此写叙事（锁 2）
5. host 重算并 SSE 下发 `sheet.view` / `combat.view`（战棋视图含位置/行动经济/回合）→ 客户端渲染骰子卡、血条、状态（不执行脚本）
```

### 7.1 GM 工具泛化（M9.4）

**结论**：插件不再为每种规则写死一个工具（`trpg_attack` / `trpg_start_combat` / `trpg_next_turn` …），改为**少量通用工具**；工具参数只说「想做什么」，动作/技能/资源的定义全部从当前房间的 `rules` 段读。工具 = AI GM 与引擎之间**唯一**的结算通道。

| 工具 | 参数（示意） | 引擎行为 | 返回 |
|---|---|---|---|
| `trpg_use_action` | `{actionId, actor?, target?, options?}` | 读 `actions[actionId]` → 校验轮次/行动经济/距离/目标合法性 → 按 kind 走 `resolveAttack`/`resolveDamage` 或对应钩子 | `{ok, actionId, rolls[], delta{hp,resources}, events[], view}` |
| `trpg_move` | `{role, to:{zoneId?\|x,y?}, path?}` | 校验距离/地形/连通性/移动力 → 扣移动力 → `onMove` + 进出区域钩子 | `{ok, from, to, cost, remaining, view}` |
| `trpg_roll_check` | `{kind, actor?, target?, skill?/attribute?, dc?, mode?, mods?}` | `kind` 由规则定义（`attribute/skill/save/opposed/...`）→ `resolveCheck` | `{ok, kind, total, dc, success, crit?, degree?, rolls[], view}` |
| `trpg_combat` | `{action, monsters?, reason?, targets?}` | `start` 掷先攻建场 / `nextTurn` 回合推进（到上限触发 `onRoundLimit`）/ `end` 收场 | `{ok, round, maxRounds, order[], activeActorId, actionEconomy, view}` |

**调用约束（硬规则，与 §7 的硬规则/五道锁一致）**：

1. **AI 只能通过工具触发结算**；工具返回值是叙事的**唯一数值来源**（锁 2）——没出现在返回值里的命中/伤害/HP 一律不许编，也不许自己心算「差 2 点命中」。
2. **工具参数是意图不是结果**：AI 只传 `actionId` 与目标，不传伤害值/骰面/HP 变化；数值由 host 生成（锁 3）。
3. **非法调用返回可读错误**（`{ok:false, error:{code, messageZh, hint}}`），AI 必须把 `hint` 转述给玩家，不得静默重试或改写结果。
4. **动作只能来自规则包**：`actionId` 必须存在于 `actions[]`，否则报 `unknown_action` 并列出可用动作；AI 不得发明动作/技能/物品名。
5. **行动者归位**：工具按 token 绑定的行动者结算（锁 1），AI 不能代其他玩家行动；战斗外自由 RP 不走工具。
6. **两条通道分开**：**RP 文字**仍走原生会话（M6 决策 #23，AI GM 会话说人话）；**机制动作**走工具/命令（玩家 UI 按钮 = 发命令给 host 结算）。玩家说「我砍它一刀」→ host 先确认行动者，再由 AI 调 `trpg_use_action`；掷骰卡/战斗卡仍由 DSH 原生工具卡渲染。
7. **非结算工具不泛化**：`trpg_secret_note` / `trpg_reveal_lore` / `trpg_check_lore` / `trpg_list_party` 保留原名与语义（叙事/检索类）。
8. **地图生成同理**：AI 可以生成地图**草稿**（§3 生成小节），但落盘前必须过校验器；AI 不能直接写 `battleMaps` 结构或坐标。

## 8. 主机权威与客户端投影

```ts
// 协议新增（草案）：每人一份的卡面投影；战斗视图单独扩展
interface SheetView {
  cardId: string; rulesId: string; rulesVersion: string;
  attributes: Record<string, number>;
  resources: Record<string, { name: string; current: number; max: number }>;
  derived: Record<string, number | string>;        // AC / hpMax / 命中加值等，主机算好
  equipped: Array<{ slotId: string; slotName: string; items: Array<{ instanceId: string; name: string; stats: Record<string, number> }> }>;
  equipmentStats: Record<string, number>;          // 词条聚合结果
  actions: Array<{ actionId: string; name: string; kind: string; available: boolean; cost?: Record<string, number>; reason?: string }>;
  statuses: Array<{ id: string; name: string; stacks: number; remaining: number; icon?: string }>;
  fields: Record<string, string | number>; ui?: unknown;   // ui 取自规则包：分组/布局/图标/标签
}
// combat.view → CombatView（战棋）：mapId / cols×rows / terrain / obstacles / tokens / initiative / round / maxRounds / actionEconomy
// WorldMapView（世界地图页）：底图 + zone 热点/连线 + 当前位置；两个 DTO 字段见 UI-CONTRACT.md §6
```

- **客户端零脚本**：只按上述字段渲染；`available=false` 的动作置灰并显示 `reason`（「真气不足」「本回合已用过动作」）。客户端只能提交意图文本或 UI 命令（`move`/`useAction`/`endTurn`），由 host 判定；改卡请求必须过 host 的 `validateSheet`。
- **重连 / 新玩家加入**：host 从事件日志重放或按当前卡重算投影后全量下发；客户端不缓存权威状态、不做本地预测。
- **推送**：沿用 SSE（带 `seq` + `lastSeq` 补发）；事件 kind 新增 `sheet`（投本人，GM 也可见）与 `rules`（规则错误/降级，`to: 'gm'` 或 `all`）；玩家端构建产物不得包含公式求值器/沙箱/规则脚本（构建断言）。

## 9. 存储、快照与复现

```jsonc
// 房间快照（RoomSnapshot，schemaVersion 1 → 2）新增规则引用
{ "content": { "packId": "core-guimuya", "packVersion": "1.1.0", "contentHash": "sha256:…", "moduleId": "guimuya" },
  "rules": { "rulesId": "dnd5e-lite", "rulesVersion": "2.0.0", "rulesHash": "sha256:…" },
  "room": { "seed": 123456789, "rollIndex": 42 /* 其余同现状 */ } }
```

- **快照记录**：`{packId, packVersion, contentHash, rulesId, rulesVersion, rulesHash, roomSeed}`；`rulesHash = sha256(规范化规则数据字节 + 各脚本 sha256)`。`roomSeed + eventSeq` 决定全部骰面，日志记录每次掷骰表达式与结果；`rulesHash` 只用于校验复现环境一致，不进随机流。
- **规则变更检测**：续团时 `rulesId` 或 `rulesVersion`/`rulesHash` 不一致 → 房间照常恢复但标记 `degraded: true` + 红色告警，按快照记录的规则版本执行（本机已无该版本则拒绝开团并提示安装）；**禁止热切换规则**，换规则 = 新开房间。
- **卡迁移**：加载卡时若 `rulesVersion` 更高且有 `migrations` → 依次 `migrateSheet` + `validateSheet`，迁移报告进事件流；失败则卡进只读态并提示，不静默改玩家卡。

## 10. 安全与信任模型

| 项 | 结论 |
|---|---|
| 信任模型 | **host 安装内容包 = 受信代码**（作者/房主自己装的包）；玩家不能上传或执行脚本；LAN 内受信场景可接受 |
| 隔离 | `node:vm` 独立上下文 + 受限 globals + 超时；不提供 `require`/文件/网络/进程/定时器；脚本大小/数量/调用次数上限（§6） |
| 完整性 | `scripts{}` 的 sha256 加载时校验；规则包随内容包走 M8.1 的 zip 结构/大小/路径/CRC 校验 |
| **明确边界** | **`node:vm` 不是强安全边界**（可被逃逸），防误伤与失控脚本，不防恶意作者。将来允许玩家上传 pack 时必须升级 Worker/子进程隔离 + 人工审查/签名（v2） |
| 默认限制 | 单包脚本 ≤ 32 个 / ≤ 256 KiB；单次钩子 ≤ 200ms；单场调用 ≤ 10k；单次结果 payload ≤ 64 KiB；递归深度由 vm 超时兜底（不另设上限） |

## 11. 内置 dnd5e-lite 示例规则包

### 11.1 现有机制 → 新模型映射

| 现有机制（现状代码） | 新模型 | 说明 |
|---|---|---|
| 六属性 3–18（`types.ABILITIES` / `validateCharacterCard`） | `sheet.attributes[]`（str…cha，min 3/max 18） | 卡实例 `attributes` |
| 属性调整值 `floor((x-10)/2)`（`checks.ts`） | `computeDerived` 钩子 → `derived.mod.<attr>` | 公式不能逐属性映射，用钩子（正是「复杂逻辑」边界） |
| 熟练加值 + 技能/豁免熟练（`proficiencyBonus` / `proficiency.skills/saves`） | `formulas.proficiency` = `floor((level-1)/4)+2`；`sheet.skills[]` + 卡 `skills[{id,proficient}]` + `formulas.check` | 熟练是纯公式，属性映射在数据里 |
| AC（`combat.ac`） | `formulas.defense` = `10 + derived.mod.dex + equip.防御` | 护甲是带「防御」词条的装备实例 |
| HP（`combat.hpMax`） | `resources.hp` + `formulas.hpMax` | 当前值存卡，上限实时算 |
| 先攻（`initiativeBonus`） | `formulas.initiative` + 核心运行时掷 d20 | 排序逻辑留在核心运行时 |
| 攻击档案 + 伤害骰（`AttackProfile` / `combat.attack`） | `actions[]` kind=attack + 武器实例 + `action.damage.dice` + `formulas.damage` | 武器 = 带 stats/tags 的装备；骰子字符串在数据 |
| 法术位（`Spellcasting.slots`） | `resources[]`（真气/术法） + `actions[]` kind=spell `cost.resource` | 法术动作进规则包动作表 |
| 八种条件（`Condition`） | `sheet.statuses[]` + `onEvent` / `resolveDamage` | 时长、叠加数据化 |
| 背包（`inventory`） | `equipmentInstances[]` + 世界自定义槽位/词条 | 不设固定部位与条数 |
| 等级/XP（`identity.level`） | `progression` 表 + `onLevelUp` | 成长可以只有数据 |
| 12 怪物 / 20 物品（`packages/content/src/rules/*.ts`） | 内容包数据（按规则包 schema 校验） | 引擎不内置任何怪物/物品 |

### 11.2 文件结构与迁移

```
packages/content/src/rules/dnd5e-lite/     # 作者源码：可 diff、可单测
├─ rules.json                              # pack.rules 同 schema（数据 + scripts 引用）
└─ scripts/
   ├─ sheet.js        # validateSheet / computeDerived / migrateSheet
   ├─ combat.js       # resolveCheck / resolveAttack / resolveDamage
   ├─ events.js       # onEvent（turn/status/equip 的后续效果）
   └─ progression.js  # onLevelUp / generateLoot
```

打包后：`pack.json` 的 `rules` 段内联 `rules.json` 数据，zip 内 `rules/scripts/*.js` 保持独立文件；若未来单独分发纯规则包，其根清单即 `rules/rules.json`，数据形状不变。

1. **M9.1**：属性/技能/动作/成长/表格/UI 写成 `rules.json`（不含钩子），用对照测试固定旧数值口径。
2. **M9.2/M9.3**：依次实现钩子 `computeDerived`（属性调整/AC/HP/法术豁免 DC）→ `resolveCheck` → `resolveAttack/resolveDamage` → `onEvent` → `onLevelUp/generateLoot`；每实现一个就把对应旧 engine 测试改为「经规则包执行」且断言不变。
3. **旧卡迁移**（engine `CharacterCard` schemaVersion:1 → 新卡实例）：`abilities`→`attributes`；`combat.attacks`→`actions` + `equipmentInstances`；`combat.ac/hpMax`→**丢弃**（派生）；`inventory`→`equipmentInstances`；`spells.slots`→`resources.mana`；`proficiency`→`skills[{proficient}]`；`source`→`origin`。由 `migrateSheet` + `validateSheet` 校验，`cardId` 不变，玩家本地卡与 pack 内置卡走同一迁移器。
4. **回滚**：M9 期间保留旧 engine 路径一个版本做数值对照（不对外），M9 验收后删除，引擎不再含 dnd5e。

## 12. 对编辑器的影响（M8.3）

- **M8.3 内容工坊等规则层定稿后再开工**：数据段（属性/资源/槽位/词条/技能/状态/动作/成长/表格/UI）全部由 schema 生成表单。
- 公式/脚本用代码编辑器 + **沙箱试跑** + **断言面板**（给定卡/请求 → 期望 `total/hit/damage/derived`），即「规则测试台」；模板库四套起步：dnd5e-lite（完整）/ d20 简版 / 骰池（CoC 风格）/ 无属性叙事（freeform），v1 至少 d20 + freeform。
- **地图工坊（M9.6）**：`space` 段的结构编辑（ASCII 矩阵 ⇄ 表格双视图）、校验器报错定位、底图替换与对齐微调（`calibration`）、世界地图 zone 热点/连线编辑；M9.5e 的生成结果直接进工坊继续改（生成 ≠ 定稿）。
- **M8.3a 只读卡面可提前**：只依赖 `pack.cards` + 投影 DTO，可在 M9.4 之前先做，让现有团先看到新卡面。

## 13. 分阶段排期（M9 建议）

| 阶段 | 目标 | 交付 | 验收标准 |
|---|---|---|---|
| **M9.1** | 规则 schema + 公式编译/求值 + 卡实例/迁移 + 投影 DTO（纯库 + 测试） | `@dsh-trpg/rules` 包骨架：types、`validateRulesPack()`（含 `space` zone-grid / `time` round / `turn` 行动经济段）、公式 parser/compiler/evaluator、卡实例与迁移、投影 DTO（`SheetView` / `CombatView` / `WorldMapView` 的形状定义）；不接 host | 公式 40+ 例单测（含编译期/运行期错误）、schema 校验（含 zone-grid/round/turn 各 1 组正反例）、旧卡迁移；typecheck 0；不新增运行时依赖 |
| **M9.2** | 核心运行时 + 脚本沙箱 | 种子骰/回合先攻/事件总线/效果栈（与规则无关）+ `vm` 沙箱 + 核心 8 + 场地/时间/上限 9 钩子调度 + 超时/sha256/错误事件 | 核心 8 + 场地/时间/上限 9 各覆盖正常/抛错/超时/回滚；同 eventSeq 回放骰面一致；沙箱逃逸 smoke 记录已知边界 |
| **M9.3** | dnd5e-lite 示例规则包 + 迁移 | `rules.json` + 4 个脚本；`core-guimuya` pack 带 rules 段（含 `space`/`time`/`turn` 数据）；旧卡迁移器；与旧实现对照测试 | CLI 用「鬼木崖·异光」跑完一幕，骰面/命中/伤害/AC/先攻逐项一致；单测迁移后全绿（134 → 新增规则测试） |
| **M9.4** | 协议/房间/客户端卡面与地图视图（主机权威投影） | `sheet.view`/`combat.view`/`worldMap.view` + `sheet`/`rules` 事件 + 重连重算；客户端只读卡面（分组/资源条/装备槽/可用动作/状态）+ **世界地图页（主区域独立页）** + **战棋战斗视图（底图+网格+token+行动经济条）** | 双实例：落座→检定→攻击→移动→断线重连后投影一致；世界地图热点/连线与战棋网格/token/回合/行动经济条正常；玩家端构建产物不含规则执行代码；320–420px 栏宽可读 |
| **M9.5** | **资产、图标与地图生成管线**（新增，详见 [UI-CONTRACT.md](./UI-CONTRACT.md) §10） | a) 纯 JS 归一化器 + SVG 白名单净化 + OpenAI 兼容客户端 + `assets/manifest.json`；b) 工坊图标工作台；c) 开发 shim；d) 玩家立绘/变体/帧表与落座上传；**e) 地图与战棋生成工作台**：AI 结构草稿 + 地图结构校验器（尺寸/边界/连通性/出生点/token/引用/图例）+ AI 底图 + 预览叠加与对齐（`calibration`）+ 离线程序兜底（结构 + 程序化背景） | 同 UI-CONTRACT §10 的 M9.5a–e 验收标准；地图侧另验：≤32×32 / token ≤20 / 包内 ≤64 上限生效，校验器拒绝断连·越界·出生点重叠各 1 例，无 AI 时程序兜底可导出可玩 |
| **M9.6** | 规则编辑器 + **地图工坊**（M8.3 顺延至此；**原编号 M9.5**） | 工坊规则 tab：schema 表单 + 代码编辑器 + 沙箱试跑 + 断言面板 + 模板库；地图工坊：`space` 结构矩阵编辑/校验定位/底图替换与对齐微调/世界地图热点编辑 | 作者不改源码完成一次规则包修改并通过规则测试台；不改源码调整一张战棋图或世界地图热点并通过校验；导出 `.trpgpack` 后另一台机器可玩 |

**依赖关系**：M7 玩家侧镜像可并行（改 client 镜像/会话事件，与规则包文件面不重叠，交叉点只有投影字段与事件类型）；**M8.3 UI 依赖 M9.1 + M9.4**（schema 与投影都定稿）；**M8.3a 只读卡面可提前**（依赖 M8.2 + M9.1 的卡 DTO）；**M9.5e 地图生成依赖 M9.1 的 `space` schema + M9.5a 的资产生图/归一化 + M9.4 的战棋视图壳**；**M9.6 地图工坊依赖 M9.5e 的校验器与 M9.4 的视图**；M8.4/M8.5 不受阻，可穿插。

## 14. 风险与开放问题（默认值已给）

| 风险 | 默认对策 |
|---|---|
| 规则表达力不够 | 优先扩数据（词条/槽位/动作旗标/公式命名空间/场地、距离算法、回合与行动经济数据）；M9 后冻结钩子数量（核心 8 + 场地/时间/上限 9），确实不够再显式评审新增 |
| 作者门槛 / 测试工具 | dnd5e-lite 作为可抄模板 + 四套模板库 + 规则测试台；数据/脚本 fixture 进仓库 CI 回归；文档给「从零到能跑」三段式教程 |
| AI 地图草稿/底图与结构不一致 | **结构数据权威**：判定只读 `terrain/obstacles/spawns`，底图只是皮肤、可替换重生成；预览叠加人工确认；不一致时以结构为准并提示重生成底图（§3 生成小节） |
| 地图体积与包上限 | ≤32×32 / 单场 token ≤20 / 包内地图 ≤64；底图按资产上限（[UI-CONTRACT.md](./UI-CONTRACT.md) §3.1）与整包 ≤64 MiB；超限落盘前拒绝 |
| 性能（每回合钩子调用） | 单动作 ≤ 3 次钩子；`computeDerived` 按 `(卡版本, rulesHash)` 缓存；单次 200ms 上限；先量后调 |
| 规则变更中开团 | 快照冻结 rulesHash，禁止热切换；换规则 = 新房间；旧房间按快照版本继续或降级提示 |
| 脚本错误可观测性 | `rules/error` 事件 + GM 提示 + 房间卡告警 + 日志含钩子/入参/堆栈；连续失败降级 |
| `node:vm` 逃逸 | 明确信任模型；玩家上传 pack 前升级 Worker 隔离 + 人工审查（v2，见 §10） |

## 15. 与现有代码的差异 / 迁移清单

```
packages/rules/（新）                # @dsh-trpg/rules：核心运行时 + 公式编译/求值 + 沙箱 + 卡实例/投影 DTO + 地图结构校验器（M9.5e）
packages/engine/                     # 瘦身：dice/rng 迁入 rules；checks/characters/spells/combat 的 dnd5e 实现移除
packages/content/src/rules/dnd5e-lite/     # 新：示例规则包源码（rules.json + scripts/*.js；space/time/turn 数据段）
packages/content/src/packs/core-guimuya.ts # 新增 pack.rules 段（M9.3）；pack.ts 加 rules 段 schema 与 zip 内脚本 sha256 校验
packages/protocol/src/index.ts       # RoomView 加 rules 引用；SheetView/CombatView/WorldMapView DTO；事件 kind 加 sheet/rules
packages/rooms/src/index.ts          # 卡校验/战斗与移动结算改走规则执行器；投影组装；快照 v2 带 rules
packages/dsh-trpg-table/src/host/gm/tools.ts       # 工具泛化为 trpg_use_action / trpg_move / trpg_roll_check / trpg_combat，透传结构化结果与错误
packages/dsh-trpg-table/src/host/pack-registry.ts  # 解码 rules 段 + 脚本源码入内存 + sha256 校验
packages/dsh-trpg-table/src/client/*               # 卡面/世界地图/战棋视图渲染投影字段；不引入规则执行代码
```

**图标与资产（M9.5，见 [UI-CONTRACT.md](./UI-CONTRACT.md)）**：`pack.rules.items[]`（世界物品库）与各段 `icon` 字段由新资产模型驱动；zip 内新增 `assets/manifest.json`（`trpg.assets/1`），`validatePack()` 增补 `assetId` 存在性/尺寸/体积/sha256 校验；`ZIP_LIMITS` 上限调整（整包 16 → **64 MiB**、解压总量 32 → **64 MiB**、条目数 512 → **520**，单条仍 8 MiB）；卡实例 `assets` 引用（§4）与 `SheetView`/`EquipmentView`/`InventoryView`/`iconRef` DTO 同批落地。三屏布局与三条图标获取路径见 UI-CONTRACT §2/§5。

**现有测试（134）影响**：`dice.test.ts`（骰子表达式/分布）、`zip.test.ts`（zip 容器）、协议信封类基本不动；`combat.test.ts` / `spells.test.ts` / `card.test.ts` / `content.test.ts` 改为经示例规则包执行（断言口径不变）；`pack.test.ts` 增规则段校验；`room.test.ts` / `room-content.test.ts` 增投影字段与规则引用断言；`gm.test.ts` / `table-session.test.ts` 改注入点。新增：公式求值、钩子沙箱、规则包加载、卡迁移、投影一致性五类单测。
