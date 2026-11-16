# 跑团桌 · TRPG Table — 设计文档

> 产品名：**跑团桌 / TRPG Table**
> 仓库：`dsh-trpg` · npm 包（暂定）：`dsh-trpg-table` · 协议：MIT
> 状态：v0.1 草案（2026-11-13），待项目主理人过目后开工
> 定位：**局域网多人 AI 跑团桌**——房主建房、AI 当 KP/GM、玩家只负责 RP。以 DSH 插件形态交付，后期通过 IM（QQ 等）接入公网玩家。
> 内容（模组/世界书/角色卡）的制作与数据模型见 [CONTENT-MODEL.md](./CONTENT-MODEL.md)（内容包 Content Pack，M8）。
> 规则层（可定义规则：数据 + 受限公式 + 8 个 JS 钩子、任意规则目标、主机权威投影）见 [RULES-MODEL.md](./RULES-MODEL.md)（M9）。

---

## 1. 产品定义

### 1.1 一句话

> 房主在自己电脑上打开 DSH，新建一间跑团房；朋友各自的 DSH 客户端加入房间；AI 负责 KP/GM 的全部裁定、掷骰、NPC 扮演与场景叙事；玩家只提交「我的角色要做什么」并 RP。

### 1.2 三种角色

| 角色 | 载体 | 职责 | 不做什么 |
|---|---|---|---|
| **房主（Host）** | 房主自己的 DSH 桌面 + 本插件 Host 半边 | 建房、发邀请码、掌权状态、存档、可选当 GM 或当玩家 | 不需要手动算数值（引擎算）、不需要照本宣科念模组（AI 念） |
| **玩家（Player）** | 玩家各自的 DSH 桌面 + 本插件 Client 半边 | 建自己的角色卡、提交行动、RP 对话 | 不能改数值、不能替别人行动、看不到别人私密层 |
| **AI GM** | 房主 DSH 内的牌桌会话 Agent（房间绑定房主当前打开的会话；`ctx.agents` / `sessionController`） | 叙事、NPC 扮演、调用结算工具、把控节奏 | 不计算数值、不直接改状态、不替玩家写行动或台词 |

### 1.3 两种 GM 模式（开局二选一）

1. **AI GM 模式（默认）**：AI 全权带团；房主可以只是一个玩家，也可以旁观/干预（GM 控制台仍在右侧栏 tab 内）。
2. **真人 GM 模式**：房主当 KP，AI 退为副手——负责结算、NPC 扮演、场景描述草稿；房主可以改写每一段叙事、私发秘密、强制推进。

两种模式共用同一套引擎、协议与常驻卡片，差别只在「谁拥有叙事权」。

### 1.4 v1 非目标

- ❌ v1 不做 3D/实时地图与玩家自制 UI；网格战术地图自 M9 起作为 zone-grid 战棋实现（见 [RULES-MODEL.md](./RULES-MODEL.md) §3/§6、[UI-CONTRACT.md](./UI-CONTRACT.md) §5.5）
- ❌ 语音、配音、配图（留给社区插件，如 ComfyUI 联动）
- ❌ 公网直连与账号中心（v1 只做局域网；QQ/公网 adapter 在 v2）
- ❌ 多房间、多房主联邦、围观模式
- ❌ 除 D&D 5e-lite 外的规则（引擎留适配接口，但 v1 只发一套）
- ❌ 玩家端跑大模型（玩家端**不需要模型 key**）

---

## 2. 一局长什么样（核心体验）

1. **建房**：房主在 DSH 里打开一个会话（它将成为牌桌；也可停在「新会话」空态页）→ 点「🎲 跑团桌」（正常对话页在对话头部，空态页在左上角，见 §9「入口双形态」）→ 右侧栏「跑团桌」tab：先在「内容包 / 模组」卡选择本次要跑的内容（默认内置包 `core-guimuya` + 默认模组「鬼木崖·异光」），再「创建房间」（团名 / GM 模式）→ 生成房间码（如 `7F3K9Q`）与邀请码；房间绑定当前会话，房间卡显示所选内容包/模组/版本（内容缺失或变更时红色降级告警）。内容由 host 的内容包 registry 按 `room.content` 引用解析，缺省内置包。
2. **就座**：朋友在各自 DSH 里点「🎲 跑团桌」（对话头部或空态页左上角）→ 右侧栏 tab 填房主局域网地址 + 邀请码 → 加入房间、选择/创建角色 → 落座（玩家席可见）。
3. **建卡**：玩家在自己机器上创建 D&D 5e-lite 角色卡（或从模组预制卡里挑一张），进房上传「公开摘要 + 规则数值」，完整卡与秘密留在本地/房主均可。
4. **开场**：房主在牌桌会话里说一句开场（如「开始」）→ AI GM 从模组第一幕开场，回复直接出现在会话里，每人的私密层分别推送。
5. **行动**：玩家在牌桌会话（原生对话）里用自然语言写「我推开祠堂的门，先看门缝」→ 服务端把行动绑定到该玩家角色 → AI GM 决定要不要检定 → 调 `trpg_roll_check` → 引擎掷骰 → AI 依据掷骰结果写结果叙事。
6. **战斗**：进入先攻轮次，服务器点名「轮到阿青」，其他人只能 RP、不能抢先结算；轮外的临时动作由 GM 决定是否允许（并会明确标注）。
7. **散团**：房主宣布结束本幕 → 服务器生成战报、成长结果（经验/战利品/状态）回传到每个玩家本地卡；房间存档可下次续团。

---

## 3. 系统架构

### 3.1 拓扑

```
房主电脑                                                    玩家电脑 ×N
┌──────────────────────────────────────────┐               ┌─────────────────────────────┐
│ DSH 桌面（desktop profile）               │               │ DSH 桌面（desktop profile）  │
│ ┌──────────────────────────────────────┐ │  LAN 内网     │ ┌─────────────────────────┐ │
│ │ 跑团桌 Host 半边（本插件）            │ │  HTTP+SSE    │ │ 跑团桌 Client 半边       │ │
│ │  · 房间服务 0.0.0.0:45871（可配）     │◄─────────────►│ │  · 房间连接 / 断线重连   │ │
│ │  · 事件日志（唯一事实来源）           │               │ │  · 右侧栏 tab / 常驻卡片 │ │
│ │  · D&D-lite 规则引擎（纯函数）        │               │ │  · 本地角色卡（真源）    │ │
│ │  · 权威状态机 / 先攻 / 可见性投影     │               │ │  · 行动走原生会话        │ │
│ │  · 内容包 registry（按 room.content   │               │ └─────────────────────────┘ │
│ │    解析；缺省内置包；可重扫）         │               │                             │
│ │  · AI GM 编排（DSH Agent + tools）    │               │                             │
│ │  · GM 控制台（真人 GM 模式）          │               │                             │
│ └──────────────────────────────────────┘ │               │                             │
└──────────────────────────────────────────┘               └─────────────────────────────┘
        ▲ v2：IM 适配层（QQ 群 / 网页 / 桌面客户端）接入同一个房间协议
```

### 3.2 关键技术选型（已按 DSH 实机能力核实）

| 能力 | 选型 | 依据（本机 DSH 0.2.2-rc.2 实机 inspection） |
|---|---|---|
| 房间内网服务 | 插件自带 `node:http` 服务，绑 `0.0.0.0`，默认 `45871` | 不依赖 DSH web server 的绑定策略；`ctx.webServer` 仅用于同源页面内通道 |
| 实时推送 | **HTTP + SSE**（服务端→客户端），客户端→服务端用 POST | 零第三方依赖、断线重连语义简单、玩团是回合制，延迟完全够 |
| 传输升级 | 预留 WebSocket 升级位（`webServer.registerUpgrade` / 自建 upgrade） | 后续需要更低延迟的实时战斗时启用 |
| AI GM | DSH Agent：`ctx.agentLoop.create()` / `ctx.agents.create()` + `agent.followup()` | Host 服务目录已确认存在 |
| GM 工具 | `ctx.tools.register()` 注册 `roll_check` / `combat_attack` 等 | 已有 Tool Registry 与 guard/restrict 机制 |
| 提示词注入 | `ctx.systemPrompt.section()` / `ctx.systemPrompt.context()` | 已有 |
| 持久化 | DSH `storageDomain` / 插件数据目录下的 JSON + 事件日志 append-only | 已有 storage 服务；事件日志同时是可回放存档 |
| UI | Client 插件（v3 对话原生）：**「🎲 跑团桌」入口（正常对话页在对话头部 `conversation.session.header.actions`，空态/新会话页在 `conversation.header.leading` 全局入口）+ 右侧栏「跑团桌」tab（常驻紧凑卡片）** + tab 内建房/加入最小表单；主区域直接用 DSH 原生会话，不自绘聊天页、不提供插件输入框 | 已通过 Slots inspection 确认可注册；详见 §9 |
| 发布 | DSH bundle（`dsh.bundle.patch` + `dsh.client`），单包 `dsh-trpg-table` | 与 dsh-tavern / dsh-lora 同款形态 |

### 3.3 仓库结构（monorepo）

```
dsh-trpg/
├─ packages/
│  ├─ protocol/            # @dsh-trpg/protocol：消息类型、校验、版本
│  ├─ engine/              # @dsh-trpg/engine：纯函数 D&D-lite 规则引擎 + 骰子 + 状态机
│  ├─ content/             # @dsh-trpg/content：规则数据、种族/职业/法术/怪物/物品
│  │                       #   + 示例角色卡、世界书、首个原创模组
│  └─ dsh-trpg-table/      # 发布包：DSH bundle（host 入口 + client 入口），打包上面三包
├─ docs/                   # 本设计文档、访谈决策账、路线图、玩家手册、GM 手册
├─ scripts/                # 构建、打包 .tgz、本地双实例联调
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md
```

**构建**：TypeScript 强类型 → `tsc` 校验 + `esbuild` 把 host/client 各打包成单文件 ESM（`lib/index.js`、`lib/client.js`）。测试用 `node --test`（Node 24 原生跑 TS）。

---

## 4. 五道锁：从机制上消灭「角色混淆 / 行动状态异常」

> 这是本项目相对 DiceFrame 的核心差异点，也是验收时最该盯的指标。DiceFrame 的病根是「AI 同时当裁判、状态机和叙事者」；我们把这三件事拆给三个组件，AI 只剩叙事。

### 锁 1 — 身份由服务器绑定，不由 AI 推断

- 每条连接持有 `playerToken → playerId → characterId` 的绑定，玩家提交行动时只带 token，**服务端填充角色身份**。
- 行动文本里出现「我」「他」「阿青」等指代，只作为叙事内容，永远不参与「谁在行动」的判定。
- 玩家 A 连接无法提交 B 的角色行动；GM 控制台显式操作除外（并会写入审计日志）。

### 锁 2 — AI 只拿结论，不拿原始状态去"算"

- 需要判定时，AI 调用工具（`roll_check` / `combat_attack` / `cast_spell` …），**引擎掷骰并算出结果**，把结构化结论（骰面、加值、DC、成败、伤害、剩余 HP）交回给 AI。
- AI 的叙事必须基于工具返回值；**AI 自己写出的数字不进入状态**。
- 未调用工具的数值描述只当氛围，不改状态。

### 锁 3 — 状态唯一写者

- 角色 HP、状态、法术位、先攻顺序、场景标记，只有引擎能写入。
- AI 的写请求必须经工具校验（目标存在、轮到谁、资源是否足够、距离/条件是否合法），非法变更被拒并回给 AI 错误，AI 需重新组织叙事。
- 每次状态变更都是一个带序号的领域事件，落进事件日志；可从日志完整回放。

### 锁 4 — 行动许可状态机

- **探索**：自由行动，先到先结算，服务端按序处理，一人一行动一台处理不掉队。
- **战斗**：进入先攻轮，服务端维护 `currentActor`；只有 `currentActor` 的行动会被接受，其他人的输入变成「RP/待机」并明确回执「现在轮到阿青，你的动作将在你的回合可用」。
- 玩家掉线自动跳过，并在回来后补一次「这轮发生了什么」的私密摘要。

### 锁 5 — 按人投影的视图（不是共享一份状态）

- 服务端为每个玩家计算**投影视图**：公共叙事 + 自己的角色卡 + 自己的私骰结果 + 发给自己的私密消息；GM 看到全量。
- 广播给客户端的是投影后的结果，**不是全量状态再靠前端隐藏**。私密信息在网络上就不会到其他玩家手里。
- AI GM 的提示词同样分两层：公共上下文（全桌可见）+ 私密通道（只与当前行动者相关）。

---

## 5. 规则系统：D&D 5e-lite（v1 范围）

### 5.1 核心

- 六属性（3–18）：力量、敏捷、体质、智力、感知、魅力；调整值 `floor((属性-10)/2)`。
- 熟练加值：1 级 +2；熟练技能/豁免。
- 检定：`d20 + 属性调整 + 熟练（若熟练）` vs DC（5/10/15/20/25/30 阶梯）。
- 优势/劣势：2d20 取高/低；不叠加，只抵消。
- 战斗：先攻 `d20 + 敏捷调整`；AC；HP = 职业基础 + 体质调整×等级；伤害骰；暴击 20 双骰；0 HP = 倒地 + 死亡豁免。
- 行动经济：动作 / 附赠动作 / 反应 / 移动（距离档位：接触 ↔ 近 ↔ 远，一次移动换一档）。
- 条件（v1 八种）：中毒、倒地、恐惧、束缚、目盲、失能、隐身、加速。
- 法术：0–2 环 15 个（中式奇幻皮：术法=法术，真气=法术位），施法检定统一走 d20+施法属性。
- 怪物 12 种（含 1 个守关 Boss），物品 20 件，种族 4（山民/蛮裔/灵裔/半妖），职业 4（武者/游侠/术士/方士）。

### 5.2 可复现

- 引擎随机数：`seed + 序号` 决定每次掷骰（`xorshift`/`splitmix` 实现），骰子结果写进事件日志；重放或复盘时结果一致。
- 所有判定输出统一结构：`{ kind, target, d20, mods, total, dc, success, extra }`，UI 直接渲染成骰子卡片。

### 5.3 数据驱动

种族/职业/法术/怪物/物品全部是数据（v1 为 `packages/content/rules/dnd5e-lite/*.json`，M9 起并入内容包 `rules` 段），引擎只认 schema；**换规则 = 换规则包**（数据 + 受限公式 + 8 个 JS 钩子，见 [RULES-MODEL.md](./RULES-MODEL.md)，M9），结算由规则包内的公式/钩子定义，适配器不再是主要手段。历史过渡：v1 靠「换数据 + 换结算适配器」落地，原「v2 做适配层接口」的设想已由规则包模型取代。

---

## 6. 内容格式（自研，结构参考 DiceFrame）

> **v1 起统一为内容包（Content Pack，M8）**：一个包 = `pack.json` + 可选 `assets/`，以 `.trpgpack`（**ZIP**）制作/分发；下面 6.1–6.3 是包内对象 schema 的示意，字段名与迁移规则以 [CONTENT-MODEL.md](./CONTENT-MODEL.md) §2 为准（如 `id` → `cardId`、`scene.lore` → `scene.loreIds`、模组/世界书/卡都进同一个 `pack.json`）。

### 6.1 角色卡 `card.schema.json`

```jsonc
{
  "schemaVersion": 1,
  "id": "card_<nanos>_<hex>",
  "owner": { "playerId": "...", "displayName": "..." },
  "identity": { "name": "...", "race": "山民", "class": "武者", "level": 1, "background": "…" },
  "abilities": { "str": 15, "dex": 12, "con": 14, "int": 8, "wis": 11, "cha": 10 },
  "proficiency": { "bonus": 2, "skills": ["运动", "威吓"], "saves": ["str", "con"] },
  "combat": { "ac": 16, "hp": { "max": 12, "current": 12, "temp": 0 }, "initiativeBonus": 1,
              "attacks": [{ "name": "横刀", "toHit": 5, "damage": "1d8+3", "range": "接触" }] },
  "spells": { "ability": "cha", "slots": { "1": 2 }, "known": ["燃灯咒", "踏罡步"] },
  "inventory": [{ "name": "火折子", "qty": 1, "effect": "照明" }],
  "publicSummary": "一句话对外形象，供队友与其他玩家看到",
  "appearance": "…", "personality": "…",
  "notes": "玩家自己的备注",
  "source": { "moduleId": null, "ruleId": "dnd5e-lite", "ruleVersion": "1.0" }
}
```

- **玩家本地为真源**：卡存在玩家插件数据目录；进房上传「规则数值 + publicSummary」；GM 可见全卡；其他玩家只看 `publicSummary` 与公开状态（HP 档位可选）。
- 散团后房主把成长/战利品/日志摘要回传，客户端本地合并（可选冲突提示）。

### 6.2 世界书 `lorebook.schema.json`

```jsonc
{
  "schemaVersion": 1, "id": "lore_...", "title": "枯木崖",
  "entries": [{
    "id": "entry_...",
    "keys": ["枯木崖", "绿光", "古洞"],       // 关键词触发
    "visibility": "public" | "player:<id>" | "gm",
    "priority": 100,
    "alwaysOn": false,
    "content": "…",
    "tags": ["地点", "秘密"]
  }]
}
```
- AI GM 按当前场景 + 最近事件 + 关键词命中检索注入（不是整本塞上下文）。
- `visibility=gm` 的条目只进 GM 上下文；`player:<id>` 只在给该玩家的私密通道里出现。

### 6.3 模组/剧本 `module.schema.json`

```jsonc
{
  "schemaVersion": 1, "id": "module_guimuya", "title": "鬼木崖·异光",
  "ruleId": "dnd5e-lite", "level": [1, 2], "playerCount": [1, 4], "durationMinutes": 45,
  "synopsis": "…", "gmNotes": "…",
  "scenes": [{
    "id": "scene_01", "title": "青石镇·悬赏", "entry": "…",
    "npcs": ["柳掌柜"], "lore": ["青石镇"],
    "beats": [{ "id": "beat_1", "trigger": "玩家接下悬赏", "effect": "→ scene_02" }],
    "checks": [{ "when": "打探消息", "skill": "persuasion", "dc": 12,
                "success": "…", "failure": "…", "private": true }],
    "rewards": { "xp": 50, "items": ["…"] }
  }],
  "secrets": [{ "id": "secret_1", "content": "…", "revealWhen": "…" }]
}
```

### 6.4 存档 `save.schema.json`

- 存档 = 模组进度（当前场景/beat 游标）+ 全角色快照 + 房间事件日志（append-only JSONL）。
- 续团 = 载入快照 + 回放日志尾部；事件日志同时是「战报」（可导出 Markdown）。

---

## 7. 协议（局域网房间协议 v1）

### 7.1 传输

- 房主端 HTTP 服务：`GET /trpg/health`、`POST /trpg/rpc`、`GET /trpg/events?token=…`（SSE）、静态资源无害。
- 绑定 `0.0.0.0:45871`（可配置）；启动时提示局域网地址（`http://192.168.x.x:45871`）与二维码文本。
- 服务发现（v1.1）：UDP 广播 `_trpg-table._udp` 让同网段客户端自动列出房间；v1 先支持手动输入 `IP:端口 + 房间码`。

### 7.2 消息信封

```ts
type Envelope =
  | { v: 1, type: 'hello',     roomId, protocol: 1, playerToken?: string }
  | { v: 1, type: 'join',      inviteCode, playerName, clientVersion }
  | { v: 1, type: 'seat',      characterCard }
  | { v: 1, type: 'action',    text, tags?: ActionTag[] }   // 服务器补 characterId
  | { v: 1, type: 'rpc',       method, params, id }
  | { v: 1, type: 'event',     seq, kind, payload, to?: playerId | 'gm' | 'all' }
  | { v: 1, type: 'ack' | 'error', id, code, message }
```

- 所有 `event` 带单调递增 `seq`；客户端断线重连时带 `lastSeq` 请求补发。
- 服务端每连接维护 `to` 投影；`to` 只在服务端决定，客户端无法伪造。
- **IM adapter 的接口**：`RoomAdapter`（`onPlayerMessage(playerId, text)` / `sendToPlayer(playerId, event)` / `listPlayers()`）。QQ 群机器人、网页版玩家都实现这个接口，房间服务不感知来源。

### 7.3 安全（v1）

- 房间码（6 位）+ 邀请码（一次性或限时）+ 每玩家 token（首次加入签发，存本地）。
- 局域网明文 HTTP；不做公网暴露。v2 加入 TLS / 公网网关 / 账号绑定。
- 房主可踢人、锁房、暂停房间。

---

## 8. AI GM 设计

### 8.1 会话与上下文

> **v3 对话原生路径（当前默认）**：房间绑定房主当前打开的一个 DSH 会话，AI GM 就是这个会话的 Agent——GM 提示段（人格/模组/硬规则，含 `trpg_*` 工具名映射）在绑定时注册到会话 Agent，玩家行动以 `user/message` 注入会话，原生对话历史即上下文；不再为每次行动新建会话或重组提示。未绑定会话的房间仍走下面这套 subagent GM 编排。

- 每个房间一个 **GM Agent Session**（DSH 会话），人设由 `systemPrompt.section()` 注入。
- 每次行动组装的上下文顺序：
  1. GM 守则（叙事风格 / 不替玩家行动 / 只用工具给的数值 / 不泄露 gm 可见性内容）
  2. 规则摘要（当前角色相关条目）
  3. 世界书命中条目（按可见性过滤）
  4. 场景状态（场景、在场 NPC、先攻顺序、当前行动者）
  5. 本次行动（已绑定角色 + 行动文本 + 可选标签）
  6. 最近 N 条公共事件（压缩后的叙事摘要 + 骰子结果）
  7. 私密层（仅当行动者或相关玩家）
- 输出分三段处理：`narrative`（广播）/ `private`（单播）/ `toolCalls`（状态变更）。解析失败或未调工具即不改变状态。

### 8.2 工具清单（GM 可调用，引擎执行）

| 工具 | 作用 |
|---|---|
| `roll_check(skill, dc, target?, advantage?)` | 技能/属性检定，返回骰面与成败 |
| `combat_attack(target, weapon?, advantage?)` | 一次攻击结算（命中/伤害/暴击） |
| `cast_spell(spell, targets, slotLevel?)` | 施法结算与消耗 |
| `apply_damage / heal / add_condition / remove_condition` | 状态变更 |
| `start_combat(participants)` / `end_combat()` / `advance_turn()` | 先攻轮控制 |
| `move_scene(sceneId, reason)` | 场景推进 |
| `npc_speak(npcId, line)` | NPC 台词（进公共叙事） |
| `reveal(loreId, to?)` | 揭示世界书条目（可定向） |
| `secret_note(playerId, text)` | 私密消息 |
| `grant_item(playerId, item)` / `grant_xp(playerId, n)` | 奖励 |
| `request_action(playerId, prompt)` | 向某玩家发行动请求（轮次里点名） |
| `end_scene(summary)` | 结束一幕并生成战报 |

### 8.3 真人与 AI 的边界

- 真人 GM 模式：AI 工具权限不变，但叙事写入权交给房主；AI 输出作为「草稿」进 GM 控制台候选框，房主一键采纳/改写/丢弃。
- 两种模式下引擎与日志完全一致，所以 GM 模式可以中途切换（v1.1）。

### 8.4 叙事守则（写进系统提示）

- 只用第二人称描述玩家角色的**结果**与**环境**，不写玩家角色的行动与台词（除非玩家授权「帮我把这段演完」）。
- 每个行动回应 2–6 句，战斗快节奏；不替玩家做抉择。
- 数值只引用工具返回，不自行生成 HP/伤害/DC。
- 不向玩家泄露 `visibility=gm` 的内容；私密信息只通过 `secret_note`。

---

## 9. UI / UX（对话原生 + 右侧栏常驻卡片）

**当前形态 v3（2026-11-16 主理人拍板，取代 v2）**：跑团桌**不自绘聊天界面**，主区域直接用 DSH 原生会话——
房主当前打开并绑定为牌桌的那个会话就是牌桌，AI GM 就是这个会话的 Agent；GM 的原生回复（markdown/流式）
与 `trpg_*` 工具的卡片都由 DSH 原生渲染。插件只保留四样东西（入口为双形态，见下「入口双形态」）：

1. **对话头部入口（有活动会话时）**：`conversation.session.header.actions` 里的「🎲 跑团桌」按钮 → `sidebarRight.openTab('trpg-table')`；按钮顺带把当前 `sessionId` 写进 localStorage，作为建房/绑定的兜底。
2. **空态/新会话全局入口**：`conversation.header.leading` 里的「🎲 跑团桌」按钮——该 slot 是 root 作用域（无会话也渲染），空态页/空白会话页靠它进入；有正常会话时它自动让位给对话头部 chip，同一时刻只有一个入口。点击逻辑见下「入口双形态」。
3. **右侧栏「跑团桌」tab**（常驻紧凑卡片）：`sidebarRightTabs.register({ id: 'dsh-trpg-table:table', kind: 'trpg-table', title })` 注册 tab 类型，正文注册到 `slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-trpg-table:table' })`（key = tab 定义 id）；`openTab(kind)` 按 `kind` 点名打开。正文从 `props.sessionId` 拿到当前会话（右侧栏按会话作用域注入），建房/`room.bind` 优先用它。
4. **建房/加入最小表单**：没有房间时 tab 内就是「房主地址 + 建房 + 加入 + 玩家名」的最小表单，不占用主区域。

**入口双形态（2026-11-16 修复，用户报「新会话空态页没有入口」）**

| 页面状态 | 入口 | slot / 作用域 | 行为 |
|---|---|---|---|
| 正常对话页（有活动会话） | 对话头部「🎲 跑团桌」chip | `conversation.session.header.actions`（会话作用域） | 点击 `sidebarRight.openTab('trpg-table')`，并记住当前 `sessionId` |
| 「新会话」空态页 / 空白会话页 | 左上角「🎲 跑团桌」 | `conversation.header.leading`（root 作用域 **single slot**，无会话也渲染） | 有在屏会话就直接开 tab；没有则先准备会话再开（见下） |

- **根因**：`conversation.session.header.actions` 在 `hideChrome=blank` 时整块不渲染（DSH `ui-conversation` 的 `ConversationSession.tsx:148,205-207`；`ConversationHeader.tsx:26` 传 `hideChrome: blank`）。空态页其实已有一个 blank 会话（右侧栏有会话面），但会话头没有操作集群，所以原先唯一的入口看不见、点不到。
- **为什么挂在 `conversation.header.leading`**：该 slot 是 root 作用域，无会话也渲染（证据：`ui-conversation/src/client/contract/slots.ts:266`，slot-catalog 注「Global navigation before the Session title, available without a Session」）。
- **让位规则**：全局入口组件只在「右侧栏没有在屏会话」或「在屏会话是空白会话（blank）」时显示；有正常会话时返回 `null`，入口由原对话头部 chip 提供——同一时刻只有一个入口。
- **点击逻辑（ensureSession）**：
  1. 先试 `sidebarRight.openTab('trpg-table')`；右侧栏已有在屏会话面时直接成功。
  2. 失败（空态页无会话面）：调 `uiWorkspace.startSession()` 让 DSH 自己新建会话，随后以 300ms 间隔短重试 `openTab`（约 12 次 / 3.6s），等右侧栏出现会话面；
  3. 仍失败：在入口旁显示引导「先在左侧「新会话」建一个会话，再打开跑团桌」；完全没有工作区时 DSH 自己不会新建会话，属预期。
- **tab 内兜底**：tab 拿不到 `sessionId` 时不再静默——显示「当前没有可绑定的会话：请在对话页顶栏打开跑团桌后再绑定」；建房未绑定时提示「未绑定会话：请在对话页顶栏打开跑团桌后点「绑定当前会话」」。
- **验证**：typecheck 0 error、`node scripts/build.mjs` 构建成功、插件重载；真机截图 `.tmp/verify2/20-final-empty-state-no-tab.png`（空态页入口可见）与 `21-final-empty-state-open-tab.png`（点击后右侧栏打开「跑团桌」tab）；该目录 gitignored，不入库。详见 `docs/milestones/M6.md`。
- **限制**：`conversation.header.leading` 是 **single slot**（只能有一个占用者），将来若有其他插件注册同一 slot 会冲突，需协调挂载点（当前仅本插件使用）。

> **v2 历史方案（已废弃）**：曾把主区域改成整页面板（`main` key=`trpg`，自带叙事流 / 插件行动输入框 / 右侧桌面），入口用 `sidebar.panellist` + `ctx.layout.selectPanel('trpg')`。该面板已于 M6 删除，代码与交互均不再存在，此处仅作沿革说明。

### 9.1 布局与卡片清单

| 区域 | 形态 | 内容 |
|---|---|---|
| 主区域 | DSH 原生会话（插件不接管） | AI GM 原生回复；玩家行动以 `user/message` 注入；GM 工具走原生工具卡片 |
| 对话头部 | `conversation.session.header.actions` | 有活动会话时：「🎲 跑团桌」→ 打开右侧栏 tab；记住当前会话 |
| 空态页 / 新会话 | `conversation.header.leading`（root 作用域） | 无在屏会话或空白会话时：左上角「🎲 跑团桌」→ 先准备会话再打开右侧栏 tab；有正常会话时让位给对话头部 chip |
| 右侧栏 tab | `sidebarRightTabs` + `sidebar.right.pane.tab` | 常驻紧凑卡片，约 320–420px 栏宽、纵向滚动；无房间时显示大厅 |
| 建房/加入 | tab 内最小表单 | 房主地址、团名、GM 模式、创建/加入、玩家名、邀请码 |
| 输入框 | **不提供**（无插件输入框） | 行动写在原生会话里；插件不再自绘 composer/dock |
| 设置 | `settings.section`（预留） | 房间服务端口、绑定地址、GM 模式、可见性偏好 |

右侧栏 tab 卡片（自上而下）：

1. **房间状态**：邀请码（点击复制）、房间号、在线人数、牌桌会话短 id、「绑定当前会话 / 已绑定本会话」、场景；房主「结束房间」= 关房并解绑牌桌会话 / 玩家「退出房间」= 只离席；
2. **大厅**（无房间时）：房主地址、开团（团名 / AI 或真人 GM）、加入（邀请码 + 玩家名）；
3. **玩家席**（在线状态、角色名、房主移除）；
4. **落座 / 角色卡库**（本地卡、预制卡、导入/导出/合并成长）；
5. **GM 控制台**（房主专属，可折叠：旁白、私发、推进场景、发奖励）；
6. **掷骰**（表达式、私骰、最近记录）；
7. **我的成长 / 战报**（XP、物品、导出成长 JSON、导出战报 MD）。

### 9.2 服务与 slot 一览

| 层 | 名称 | 用途 |
|---|---|---|
| Client slot | `conversation.session.header.actions` | 对话头部「🎲 跑团桌」入口（有活动会话时；`hideChrome=blank` 时整块不渲染） |
| Client slot | `conversation.header.leading` | 空态页/空白会话页的全局「🎲 跑团桌」入口（root 作用域、single slot；无会话也渲染，有正常会话时让位） |
| Client 服务 | `sidebarRightTabs.register({ id, kind, title })` | 注册右侧栏 tab 类型（id=`dsh-trpg-table:table`，kind=`trpg-table`） |
| Client slot | `sidebar.right.pane.tab`（key=`dsh-trpg-table:table`） | tab 正文：常驻卡片；`props.sessionId` = 当前会话 |
| Client 服务 | `sidebarRight.openTab(kind)` | 打开右侧栏 tab（kind=`trpg-table`） |
| Host 桥 | `host/table-session.ts`（`TableSessionBridge`） | 房间↔会话：绑定时在会话 Agent 注册 GM 提示段 + `trpg_*` 工具；解绑时撤销 |
| Host RPC | `room.create`（可带 `sessionId`）/ `room.bind`（host token） | 建房即绑定，或建房后绑定/改绑/解绑当前会话 |
| Host RPC | `room.say` | 玩家行动文本 → `sessionController.prompt` 注入会话（前缀如 `【角色名】…`） |
| Host 事件 | `ctx.on('session/event')`：`assistant/message` / `turn/end` | AI 文本 → `roomService.gmNarrate` 广播；异常回合 → `gmAlert` |
| Client 事件流 | `GET /trpg/events?token=…&lastSeq=…`（SSE） | 房间视图、骰子、私密、奖励等；M7 玩家镜像复用同源模式 |

- 玩家端与 GM 端是同一个 Client 插件，按房间角色显示不同卡片；不替换应用根、不使用 iframe。
- 窄屏不额外接管布局（由 DSH 右侧栏原生行为处理），插件卡片按栏宽自适应。

### 9.3 关键约束与待办

- **live 会话约束（本机实测）**：只有被 DSH 页面驱动（live）的会话能完成模型请求；插件新建/`resolveAgent` 恢复的会话一律 `DeepSeek Messages transport failed [TRANSPORT]`（5 次重试后整轮失败）。所以 `room.bind` 要求会话已打开，未打开时回可读错误：「这个会话当前没有活动的 AI…请先打开该会话再开团」。
- **本机实机验收通过（2026-11-16，本机 DSH 桌面应用）**：a) 主区域仍是 DSH 原生对话；b) 对话头部「🎲 跑团桌」打开右侧栏「跑团桌」页签（与其它页签并列、无重复页签），未进房=大厅（房主地址/开团/加入）、进房=房间状态/玩家席/落座/掷骰/GM 控制台/成长；空态/新会话页由左上全局入口进入（2026-11-16 修复，见上「入口双形态」）；c) 约 320/360 CSS px 栏宽下卡片无溢出/重叠、长文案折行、中文无乱码，内容未超高故未触发滚动（root `overflowY:auto` 兜底）；d) 建房时 `sessionId` 取自当前 tab 会话并自动绑定，卡片显示房间号、牌桌会话短 id、「已绑定本会话」（host-only）。证据与截图清单见 `docs/milestones/M6.md`。
- **结束房间 = 关房并解绑**：房主「结束房间」走 `room.close`（服务端 `onRoomClosed → tableBridge.unbind`，撤销 GM 提示段与 `trpg_*` 工具注入）；玩家「退出房间」走 `room.leave`，只离席、不关房（设计如此）。修复前房主只断本地、不发 RPC，会出现「关房后仍被 GM 注入」的 bug，已在 M6 验收中修复。
- **已知限制（M6）**：1) 重载后 localStorage 残留旧房 token 会红字提示「无法恢复房间：令牌无效或已失效」，应改为静默清理（尚未做）；2) 页签已打开时再点对话头部按钮或空态页入口会重开页签（短暂空白 + 右栏宽度回默认），不产生重复页签；3) 极窄 ≈300px 且多页签时页签标题截断（卡片本身正常）；4) 远端玩家行动入口随 M7 开放，`room.say` 目前由探针/回归脚本调用；5) 空态入口依赖 `conversation.header.leading` 这个 root 作用域 single slot——该槽位只能有一个占用者，将来若有其他插件占用会冲突，需协调挂载点。
- **玩家侧镜像（M7 方向）**：玩家本机 `sessions.create()` 建镜像会话，按收件人投影后 `session.append()` 原生渲染，不跑模型、不配 key；P1≈36h，P0 右栏只读 transcript 6–10h。详见 `docs/research/player-mirror.md`。


---

## 10. 里程碑与验收

| 里程碑 | 交付 | 验收方式 |
|---|---|---|
| **M0 骨架** | monorepo、协议/引擎包、DSH bundle 冒烟、`docs` 齐 | 插件装上后 DSH 出现「跑团桌」入口，能创建/销毁房间，`pnpm test` 绿 |
| **M1 引擎 + 内容** | D&D 5e-lite 全套规则数据、骰子、检定/战斗/先攻、CLI 对局脚本、首个模组（鬼木崖·异光）+ 4 张预制卡 + 世界书 | `node --test` 覆盖核心结算；CLI 能无 UI 跑完一幕，输出可读战报 |
| **M2 房间 + 联机** | 房间服务、邀请码、账号 token、SSE、断线重连、玩家席、骰子/聊天（先无 AI） | 本机两个 DSH 实例：建房→加入→落座→掷骰→断线重连全部通 |
| **M3 AI GM 端到端** | GM Agent 编排、工具、上下文组装、视图投影、私密层、反串角守则 | 本机双实例：AI 带完前半段模组；串角/越权/状态漂移用例全部通过 |
| **M4 真人 GM + 收尾** | GM 控制台（场景/秘密/先攻/日志/玩家管理）、叙事草稿采纳、散团回传、存档续团 | 两种模式各跑一幕；散团后玩家本地卡拿到成长 |
| **M5 局域网验收 + 发布** | 本地 .tgz 安装包、安装文档、玩家手册、GM 手册、GitHub 仓库 | 你 + 1–3 个朋友在真实局域网跑完一局；仓库推到 GitHub |
| **M6 对话原生牌桌** | 房间绑定 DSH 会话、GM 提示段 + `trpg_*` 工具进会话、右侧栏 tab 客户端、debug 清理 | 构建 + 单测 87 全绿；**本机实机验收通过**（主区域原生对话、头部入口/空态页入口打开右栏 tab、320/360px 布局、建房自动绑定、结束房间=关房解绑），截图见 `docs/milestones/M6.md`；局域网双机验收待做 |
| **M7 玩家侧镜像** | host 会话事件中继 + 玩家本机镜像会话 replay（P1），或右栏只读 transcript（P0） | 玩家端无 key 时原生渲染整局、无模型请求；调研的 3 项待实机验证通过 |

---

## 11. 测试策略

- **引擎单测**（`node --test`）：骰子分布、优势/劣势、检定边界、伤害/暴击、先攻、条件、法术位、回放一致性。
- **协议仿真**：进程内起真实 HTTP 房间服务，多个假客户端并发提交，断言投影/权限/序号/重连补发。
- **反串角回归用例**（重点）：跨玩家行动拒绝、AI 未调工具不改状态、非当前行动者被拒、私密不越权、GM 秘密不泄露。
- **本机双实例 E2E**：两个 DSH profile（`host` / `player1`）+ 脚本化点击；UI 关键路径截图存档。
- **真实局域网手测**：出验收清单（防火墙、IP、房间码、掉线、手机浏览器）。

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| DSH API 处于 preview 期，插件接口会变 | 升级后插件可能挂 | 只用本次 inspection 确认过的服务；把 DSH 交互集中在 `packages/dsh-trpg-table/src/dsh/*` 薄适配层；升级时先跑冒烟用例 |
| 玩家端 DSH 首次启动可能要求配置模型 | 朋友进不了门 | 玩家端功能不调用 LLM；M2 前用干净 profile 实测 onboarding，若强制模型则提供「跳过/本地占位」引导文档 |
| Windows 防火墙拦截 0.0.0.0 端口 | 局域网连不上 | 启动时提示放行；文档写清；后续支持手动指定端口 |
| AI 叙事质量/越权 | 体验差、串角 | 系统提示守则 + 工具白名单 + 反串角回归用例 + 真人与 AI 模式切换 |
| LLM 延迟/成本 | 一回合太慢 | 上下文只注入命中条目与最近事件；叙事流式输出；引擎结算本地零延迟 |
| 多人并发动作 | 状态竞争 | 房间服务单写者串行队列；所有变更走事件日志 |
| 单机双实例难以模拟真实网络 | 验收漏问题 | 本机 E2E + 你局域网实机验收双轨 |

---

## 13. 待你确认的开放项

1. **包名**：`dsh-trpg-table`（暂定，`dsh-trpg` 已被他人占用）；显示名「跑团桌」。
2. **GitHub 用户名 / 仓库地址**：登录与推送用（本机无 gh CLI、无全局 git 身份）。
3. 玩家端是否允许「无 DSH 的浏览器玩家」作为 v2 的第一个扩展（协议已预留）。
4. v1 规则规模（4 种族 / 4 职业 / 15 法术 / 12 怪物 / 20 物品 / 1 模组）是否够用。
5. 首个模组名与长度：「鬼木崖·异光」，约 45 分钟 / 一幕三场（接悬赏 → 查古洞 → 守关战）。
