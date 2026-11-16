# 规则模型 v1：数据 + 公式 + JS 钩子（Rule Pack）

> 状态：**已拍板（2026-11-16），M9 实现**｜决策来源：[DECISIONS.md](./DECISIONS.md) 第八轮 #26｜关联：[DESIGN.md](./DESIGN.md) §5 规则系统、[CONTENT-MODEL.md](./CONTENT-MODEL.md) 内容包、[ROADMAP.md](./ROADMAP.md) M9。
> 一句话：规则 = **数据**描述「有什么」，**受限公式**表达简单算法，**JS 钩子**只负责 8 个固定时机的复杂逻辑；核心运行时不含任何具体规则。

## 0. 摘要与四条确认

| # | 结论（已拍板，不再讨论） | 含义 | 明确不做 |
|---|---|---|---|
| 1 | **脚本 API 风格 = C 混合** | JSON 描述「有什么」（属性/技能/装备部位/词条/动作/成长/掉落/UI 分组）；受限公式表达简单算法（检定加值、AC、先攻、伤害加值）；JS 钩子只在固定时机接管复杂逻辑 | 不做图灵完备 DSL；不把全部规则塞进 JS；不让作者写任意插件代码 |
| 2 | **内置示例规则包 = dnd5e-lite 重写** | 把写死在 `packages/engine` 的 dnd5e-lite 用新模型重写成默认示例规则包，让「鬼木崖·异光」团继续玩，也给作者直接抄 | 引擎里不保留 dnd5e 分支；不并行维护两套规则实现 |
| 3 | **客户端只渲染主机成果** | 内容包 JS 只在 host 跑（`node:vm` 沙箱）；玩家客户端零脚本执行，只收主机算好的投影（`sheet.view` / `combat.view`） | 不在玩家端求值公式、不跑钩子、不校验规则 |
| 4 | **脚本 = pack zip 内独立文件** | `rules/scripts/*.js`，`pack.json` 按钩子名引用并带 sha256；可 diff、可单测、可编辑器编辑 | 不内联进 `pack.json` 字符串、不打包成不可 diff 的 bundle |

**目标**：理论上能表达任意现有跑团规则（D&D 各版、CoC 骰池、freeform 武侠……），而不是只做一套更复杂的 D&D。**边界**：钩子数量固定（8 个 + 1 个可选迁移钩子），表达力不够时优先让「数据更灵活」（装备槽/词条/公式命名空间），而不是无限制加钩子。

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
    "cost": { "action": 1, "resource": null }, "targeting": { "type": "single", "range": "engaged", "sides": "enemy" },
    "toHit": "attack", "damage": { "formula": "damage", "dice": "1d8" }, "description": "用主手武器攻击一个接触目标。" }],
  "progression": { "maxLevel": 10, "xpTable": [0, 100, 300, 600], "grants": [{ "atLevel": 1, "skillPoints": 2 }] },
  "tables": [{ "tableId": "loot.common", "roll": "1d100", "entries": [{ "min": 1, "max": 60, "itemId": "huozhezi" }] }],
  "ui": { "groups": [{ "id": "combat", "title": "战斗", "fields": ["resources.hp", "derived.ac", "equipment.stats.攻击"] }] },
  "formulas": {   // 命名公式：只能引用变量与白名单函数，只算静态值（不含随机）
    "proficiency": "floor((level - 1) / 4) + 2", "hpMax": "8 + derived.mod.con * level + 5 * level", "manaMax": "level * 3",
    "check": "derived.mod + skill.proficient * proficiency + skill.bonus",
    "attack": "derived.mod + proficiency + equip.攻击", "damage": "derived.mod + equip.攻击",
    "defense": "10 + derived.mod.dex + equip.防御", "initiative": "derived.mod.dex + equip.先攻"
  },
  "scripts": {   // 钩子名 → 独立脚本文件 + sha256（同一文件可被多个钩子引用）
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
| `sheet.skills[]` / `statuses[]` | 技能→属性映射（加值 = 条目公式 + 熟练）；状态定义时长/叠加/图标，持续效果由 `onEvent`/`resolveDamage` 处理 |
| `actions[]` | 结算数据；`toHit/damage` 引用命名公式，骰子只写表达式字符串，复杂结算标记钩子 |
| `formulas{}` | 命名公式（`check/attack/damage/defense/initiative` 为约定键，可扩展） |
| `progression / tables / ui / migrations` | 成长、随机表、卡面分组、版本迁移；均可选 |

**「能数据表达的不写脚本」**：属性范围、技能属性、装备部位与词条叠法、动作消耗与目标、成长点数、掉落表、卡面分组全是 JSON；只有需要循环/查表/条件链时才写钩子。规则包内 id 允许中文（如 `attr.敏`、`equip.攻击`），校验规则 `^[A-Za-z0-9_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5-]*$`，namespace 内唯一。

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
  "notes": "玩家备注", "origin": { "packId": "core-guimuya", "moduleId": "guimuya" }
}
```

- **派生值不存卡**：AC、HP 上限、命中加值、先攻加值、技能总加值、装备词条聚合值全部由主机按 `computeDerived` + `formulas` + 装备实时算；卡只存「角色自己拥有的数据」。
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

## 6. JS 钩子 API（核心）

钩子全部**可选**，缺省走「数据 + 公式」路径。脚本是 CommonJS 模块（沙箱提供 `module/exports`，无 `require`），一个文件可导出多个钩子。

| 钩子 | 时机（谁调） | 输入 → 输出 | 缺省行为 |
|---|---|---|---|
| `validateSheet(ctx, sheet)` | 建卡 / 改卡 / 落座 | sheet → `string[]`（空=通过，中文人话） | 只做 schema + 数值范围校验 |
| `computeDerived(ctx, sheet)` | 投影前、每次结算前 | sheet → `Record<string, number\|string>`（`ac`、`hpMax`、`mod.str`） | 返回 `{}` |
| `resolveCheck(ctx, req)` | 检定（`trpg_roll_check`） | `{kind, actor, attribute/skill, dc, mods, mode}` → `{total, success, crit?, degree?, log?}` | `d20 + formulas.check + mods` vs DC |
| `resolveAttack(ctx, req)` | 攻击（`trpg_attack`） | `{actor, target, action, range, mods}` → `{hit, crit, damage, reactions?, log?}` | `d20` vs `formulas.defense`；命中后掷 `damage.dice` + `formulas.damage` |
| `resolveDamage(ctx, evt)` | 伤害落账前 | `{target, amount, type, source, effects}` → `{amount, consumedEffects?, notes?}` | 先扣临时 HP，再扣 HP |
| `onEvent(ctx, event)` | 事件总线：`turn/start\|end`、`action/before\|after`、`damage/after`、`death`、`equip/change`、`status/tick` | event → `{effects?, sheetUpdates?, log?}` | 不做任何事 |
| `onLevelUp(ctx, req)` | 成长结算 | `{level, xp, gains}` → sheet patch | 按 `progression.grants` 自动发点数 |
| `generateLoot(ctx, req)` | 掉落/奖励 | `{tableId?, encounterId?, level}` → 物品实例[] | 按 `tables[]` 用种子骰掷表 |
| `migrateSheet(ctx, sheet, fromVersion)`（可选） | 卡/规则版本迁移 | 旧 sheet → 新 sheet | 只做数据迁移表能表达的改名/补默认值 |

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
| `ctx.turn` | `{round, actorId, seq}` 回合序号 | **不给系统时间**（确定性） |

**不提供**：文件、网络、子进程、环境变量、系统时间、定时器、`require/import/eval`、完整 `Math`（只给 `floor/ceil/round/abs/min/max/pow`）。**确定性**：钩子内随机数由 `sha256(roomSeed + eventSeq + hookName + 本次调用序号)` 派生，复盘同一 eventSeq 必得同一结果；`ctx.roll` 骰面并入事件日志。

**错误与资源语义**：抛错或超时（默认 **200ms/次**，可配）→ 该次结算**事务回滚**（HP/资源/状态不变），产生 `rules/error` 事件（`alert level=error`，含钩子名/入参摘要/错误/堆栈前 N 行），房间继续；同一钩子连续 3 次失败 → 房间降级并提示房主。脚本 sha256 与清单不符 → 拒绝加载规则包，建房/入房给可读错误。资源限制：单规则包脚本 ≤ 32 个 / ≤ 256 KiB；单场钩子调用 ≤ 10000 次；沙箱单次执行 ≤ 200ms。

## 7. 执行流程（谁调谁）

```
建卡 → validateSheet + schema → 落座（迁移旧卡）→ 投影（computeDerived + formulas + 装备聚合）
检定 → GM 工具 trpg_roll_check → 内核校验轮次/消耗 → resolveCheck → dice 事件
攻击 → GM 工具 trpg_attack → 校验行动经济/距离 → resolveAttack → resolveDamage → HP/状态写回 → damage/after
回合 → 工具 trpg_next_turn → turn/end → onEvent → turn/start → status/tick → onEvent；成长 → 工具 gm_award / 结算 XP → onLevelUp → 卡 patch → validateSheet
掉落 → generateLoot → 物品实例 → equip/change 事件 → onEvent
```

**硬规则（沿用 DESIGN §4 五道锁）**：AI GM 只能通过工具触发引擎结算，只能按工具返回的数值叙事；没有工具返回值的数字一律不进状态（锁 2）。状态唯一写者是主机（锁 3），客户端不写。

**例：「我砍它一刀」的完整调用链**

```
1. 玩家输入「我砍它一刀」→ 客户端只发文本（room.say）；host 由 token 绑定 playerId→characterId（锁 1）
2. 会话 Agent（AI GM）判定为攻击，调 trpg_attack(target=血尸, action=attack.melee)
3. 规则执行器（host）：a. 核心运行时校验轮次/动作可用/距离档位（非规则代码）→ b. `computeDerived`（脚本）→ `derived.mod.str=3`、ac、hpMax
   c. `resolveAttack`（脚本）→ `ctx.roll("1d20")` 种子骰，得出 hit/crit → d. 命中则骰 `action.damage.dice`，`resolveDamage`（脚本）处理抗性/护盾
   e. 核心运行时写回目标 HP、扣动作、记事件 `attack` / `damage/after`；`onEvent`（脚本）做后续
4. 工具结果（骰面/命中/伤害/剩余 HP）返回会话 → AI 只能据此写叙事（锁 2）
5. host 重算并 SSE 下发 `sheet.view` / `combat.view` → 客户端渲染骰子卡、血条、状态（不执行脚本）
```

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
// combat.view 扩展：round / order[{id, initiative, hp, conditions}] / activeActorId / economy / range
```

- **客户端零脚本**：只按上述字段渲染；`available=false` 的动作置灰并显示 `reason`（「真气不足」「本回合已用过动作」）。客户端只能提交意图文本；改卡请求必须过 host 的 `validateSheet`。
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
- **M8.3a 只读卡面可提前**：只依赖 `pack.cards` + 投影 DTO，可在 M9.4 之前先做，让现有团先看到新卡面。

## 13. 分阶段排期（M9 建议）

| 阶段 | 目标 | 交付 | 验收标准 |
|---|---|---|---|
| **M9.1** | 规则 schema + 公式求值 + 卡实例/投影 DTO（纯库 + 测试） | `@dsh-trpg/rules` 包骨架：types、`validateRulesPack()`、公式 parser/evaluator、卡实例与迁移、投影 DTO；不接 host | 公式 40+ 例单测（含编译期/运行期错误）、schema 校验、旧卡迁移；typecheck 0；不新增运行时依赖 |
| **M9.2** | 核心运行时 + 脚本沙箱 | 种子骰/回合先攻/事件总线/效果栈（与规则无关）+ `vm` 沙箱 + 8 钩子调度 + 超时/sha256/错误事件 | 8 钩子各覆盖正常/抛错/超时/回滚；同 eventSeq 回放骰面一致；沙箱逃逸 smoke 记录已知边界 |
| **M9.3** | dnd5e-lite 示例规则包 + 迁移 | `rules.json` + 4 个脚本；`core-guimuya` pack 带 rules 段；旧卡迁移器；与旧实现对照测试 | CLI 用「鬼木崖·异光」跑完一幕，骰面/命中/伤害/AC/先攻逐项一致；单测迁移后全绿（134 → 新增规则测试） |
| **M9.4** | 协议/房间/客户端卡面（主机权威投影） | `sheet.view`/`combat.view` + `sheet`/`rules` 事件 + 重连重算；客户端只读卡面（分组/资源条/装备槽/可用动作/状态） | 双实例：落座→检定→攻击→断线重连后投影一致；玩家端构建产物不含规则执行代码；320–420px 栏宽可读 |
| **M9.5** | 规则编辑器（M8.3 顺延至此） | 工坊规则 tab：schema 表单 + 代码编辑器 + 沙箱试跑 + 断言面板 + 模板库 | 作者不改源码完成一次规则包修改并通过规则测试台；导出 `.trpgpack` 后另一台机器可玩 |

**依赖关系**：M7 玩家侧镜像可并行（改 client 镜像/会话事件，与规则包文件面不重叠，交叉点只有投影字段与事件类型）；**M8.3 UI 依赖 M9.1 + M9.4**（schema 与投影都定稿）；**M8.3a 只读卡面可提前**（依赖 M8.2 + M9.1 的卡 DTO）；M8.4/M8.5 不受阻，可穿插。

## 14. 风险与开放问题（默认值已给）

| 风险 | 默认对策 |
|---|---|
| 规则表达力不够 | 优先扩数据（词条/槽位/动作旗标/公式命名空间）；M9 后冻结钩子数量，确实不够再评估第 9 个 |
| 作者门槛 / 测试工具 | dnd5e-lite 作为可抄模板 + 四套模板库 + 规则测试台；数据/脚本 fixture 进仓库 CI 回归；文档给「从零到能跑」三段式教程 |
| 性能（每回合钩子调用） | 单动作 ≤ 3 次钩子；`computeDerived` 按 `(卡版本, rulesHash)` 缓存；单次 200ms 上限；先量后调 |
| 规则变更中开团 | 快照冻结 rulesHash，禁止热切换；换规则 = 新房间；旧房间按快照版本继续或降级提示 |
| 脚本错误可观测性 | `rules/error` 事件 + GM 提示 + 房间卡告警 + 日志含钩子/入参/堆栈；连续失败降级 |
| `node:vm` 逃逸 | 明确信任模型；玩家上传 pack 前升级 Worker 隔离 + 人工审查（v2，见 §10） |

## 15. 与现有代码的差异 / 迁移清单

```
packages/rules/（新）                # @dsh-trpg/rules：核心运行时 + 公式求值 + 沙箱 + 卡实例/投影 DTO
packages/engine/                     # 瘦身：dice/rng 迁入 rules；checks/characters/spells/combat 的 dnd5e 实现移除
packages/content/src/rules/dnd5e-lite/     # 新：示例规则包源码（rules.json + scripts/*.js）
packages/content/src/packs/core-guimuya.ts # 新增 pack.rules 段（M9.3）；pack.ts 加 rules 段 schema 与 zip 内脚本 sha256 校验
packages/protocol/src/index.ts       # RoomView 加 rules 引用；SheetView/CombatView DTO；事件 kind 加 sheet/rules
packages/rooms/src/index.ts          # 卡校验/战斗结算改走规则执行器；投影组装；快照 v2 带 rules
packages/dsh-trpg-table/src/host/gm/tools.ts       # 工具改为调规则执行器，透传结构化结果与错误
packages/dsh-trpg-table/src/host/pack-registry.ts  # 解码 rules 段 + 脚本源码入内存 + sha256 校验
packages/dsh-trpg-table/src/client/*               # 卡面渲染投影字段；不引入规则执行代码
```

**现有测试（134）影响**：`dice.test.ts`（骰子表达式/分布）、`zip.test.ts`（zip 容器）、协议信封类基本不动；`combat.test.ts` / `spells.test.ts` / `card.test.ts` / `content.test.ts` 改为经示例规则包执行（断言口径不变）；`pack.test.ts` 增规则段校验；`room.test.ts` / `room-content.test.ts` 增投影字段与规则引用断言；`gm.test.ts` / `table-session.test.ts` 改注入点。新增：公式求值、钩子沙箱、规则包加载、卡迁移、投影一致性五类单测。
