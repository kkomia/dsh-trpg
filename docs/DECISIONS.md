# 访谈决策账（Grill Ledger）

> 本文记录立项访谈中主理人拍板的每一条决策、当时的备选与理由。后续所有实现都应能追溯到这里；改主意时请改这里并注明日期，不要悄悄漂移。
> 访谈方式：每轮只问「前置已定」的分叉，每题给推荐答案；四轮共 22 条。M6 追加 1 条补记（第五轮）；空态入口修复追加 1 条（第六轮）。

## 第一轮：产品与玩法（2026-11-13）

| # | 决策点 | 结论 | 备选与理由 |
|---|---|---|---|
| 1 | 玩家怎么进团 | **玩家各装 DSH 客户端 + 本插件**（玩家端不配模型，AI 只在房主那台跑） | 备选：插件自带玩家网页 / 共用房主 DSH Web UI。选 DSH 客户端：账号与数据天然隔离、朋友们本来都在用 DSH；代价是对外拉新门槛高，交给 v2 的网页/IM adapter。 |
| 2 | 插件交付形态 | **单 bundle 装进现有 desktop profile** | 备选：独立 trpg profile + 启动器（dsh-tavern 形态）。先单 bundle：开发调试最快；独立 profile 留到 v1 之后。 |
| 3 | 数值内核 | **插件内确定性引擎 + AI 调工具结算** | 备选：AI 自由演算（开发快但必漂移）。选引擎：这是消灭 DiceFrame「状态异常」病根的前提。 |
| 4 | v1 规则与内容 | **自研 D&D 5e-lite + 中文原创短模组** | 备选：DiceFrame freeform_wuxia 复用素材 / 规则适配层。D&D-lite 规则面完整、适合验证引擎；适配层留 v2。 |
| 5 | GM 身份 | **两种模式开局可选**（AI GM；真人 GM + AI 助手） | AI 负责一切裁定与 NPC；真人模式给有经验的 KP。 |
| 6 | v1 验收标准 | **端到端一局可玩**（1 房主 + 1–4 玩家、局域网、账号+房间码、建卡、AI 带完一个模组、存档可续） | 备选：先引擎骨架 / 先设计文档。要能真玩一局。 |

## 第二轮：系统与数据（2026-11-13）

| # | 决策点 | 结论 | 备选与理由 |
|---|---|---|---|
| 7 | 房间协议 | **与 DSH 解耦的独立 HTTP/SSE 协议**，预留 IM adapter | 备选：只为 DSH 客户端定制。解耦换 v2 QQ/网页零改造接入。 |
| 8 | 角色卡真源 | **玩家本地为真源**，对局中房主服务端权威，散团回传成长 | 备选：房主服务器为真源 / 双向同步。玩家换团不丢卡，也避免双写冲突。 |
| 9 | 信息可见性 | **公共叙事 + 私密个人层** | 自己的卡/HP/状态/背包、私骰结果只自己 + GM 可见；队友只见主动公开信息。 |
| 10 | 双 GM 模式范围 | **v1 两种都做，AI GM 模式先验收** | 真人 GM 模式复用同一引擎与面板，增量可控。 |
| 11 | 行动与回合 | **自由 RP + 战斗先攻轮** | 探索/社交随时行动；战斗由服务器点名行动者，插话只能 RP。这是「行动状态异常」的直接对策。 |
| 12 | 内容格式 | **自研 schema（结构参考 DiceFrame）+ 后续导入适配器** | 备选：直接兼容 DiceFrame / SillyTavern。D&D 数值与旧格式语义差异大，自研更干净。 |
| 13 | 验收环境 | **本机双 DSH 实例自动化联调 + 主理人局域网实机验收** | 你的朋友本来就都在用 DSH，实机验收可拉 1–3 人。 |

## 第三轮：工程与内容口味（2026-11-13）

| # | 决策点 | 结论 | 备选与理由 |
|---|---|---|---|
| 14 | 工程栈 | **TypeScript monorepo**（pnpm workspaces；tsc 校验 + esbuild 打包；node --test） | 备选：纯 ESM JS。引擎/协议/状态机用强类型，规格即类型；参照 dsh-tavern 工程形态。 |
| 15 | 界面形态 | **对话区 = 叙事流；顶栏 = 房间状态/场景/开战；右侧栏 = 角色卡/骰子/队伍；输入框 = 发行动**（主理人原话） | 不做全屏接管，最大化复用 DSH 原生布局与历史能力。 |
| 16 | 首个模组风味 | **中式奇幻**（东方小镇/古洞/道术，套 D&D-lite） | 备选：经典西幻地城 / 克苏鲁悬疑。复用既有世界书素材、差异化强。 |
| 17 | 仓库与分发 | **先推 GitHub；npm 等成熟后再发** | 本地 tgz 先给朋友装；公开包名后定。 |
| 18 | 推进节奏 | **自主推进 + 里程碑检查点**（设计文档先过目） | 每个 M 交可验证物 + 简短汇报，你在检查点验收。 |

## 第四轮：命名与发布（2026-11-13）

| # | 决策点 | 结论 | 备选与理由 |
|---|---|---|---|
| 19 | 名字 | **trpg + 后缀**：暂定 `dsh-trpg-table`，显示名「跑团桌」 | `dsh-trpg` 已被他人 npm 占用（haibiandefengshu/dsh-trpg，QQ 群 CoC 跑团）；后缀保留 trpg 词根。 |
| 20 | 玩家环境 | **朋友们本来就在用 DSH** | 玩家端无需模型 key（DSH 首次启动是否强制配置模型，M2 前实机验证）。 |
| 21 | 开源协议 | **MIT** | 生态友好；Copyright (c) 2026 dsh-trpg contributors。 |
| 22 | UI 布局确认 | **确认按第 15 条实现** | 追问过是否要全屏大屏模式：v1 先侧栏版，验收后追加。 |

## 第五轮：M6 UI 改版补记（2026-11-16）

| # | 决策点 | 结论 | 备选与理由 |
|---|---|---|---|
| 23 | 界面形态改版 v3 | **不复用/不重绘聊天 UI，主区域直接用 DSH 原生会话**：房主当前打开并绑定的会话即牌桌，AI GM 由该会话 Agent 担任（插件注入 GM 系统提示 + `trpg_*` 工具），玩家行动以 `user/message` 注入会话；插件只保留对话头部入口 + 右侧栏「跑团桌」tab（常驻紧凑卡片）+ 建房/加入最小表单。**否决** v2 自绘主区域整页面板与 `composer.dock` 输入框条 | 自绘聊天重复 DSH 已有能力且难维护；且本机实测只有 live（被页面驱动）的会话能完成模型请求，牌桌必须绑定房主已打开的会话 |

## 第六轮：新会话空态入口补记（2026-11-16）

| # | 决策点 | 结论 | 备选与理由 |
|---|---|---|---|
| 24 | 新会话空态页入口 | **在 `conversation.header.leading`（root 作用域 single slot）加全局「🎲 跑团桌」入口**：空态页/空白会话页显示，有正常会话时让位给 `conversation.session.header.actions` chip，同一时刻只有一个入口；点击先 `uiWorkspace.startSession()` 准备会话，300ms 间隔短重试后 `sidebarRight.openTab('trpg-table')`，仍失败给引导文案。**否决**：a) 只留头部 chip、要求用户先手动建会话或先发一条消息再看到入口（空态页本来就点不到，正是用户报的 bug）；b) 在左侧栏/导航另挂一个常驻重复入口（同屏两个入口、语义重复且占位）。 | 根因：`conversation.session.header.actions` 在 `hideChrome=blank` 时整块不渲染（`ConversationSession.tsx:148,205-207`、`ConversationHeader.tsx:26`），空态页虽有 blank 会话但没有会话头操作集群；`conversation.header.leading` 无会话也渲染（`slots.ts:266`）。已知限制：single slot 若被其他插件占用会冲突 |

## 已核实的环境事实（2026-11-13）

- 工作区 `D:\gitlab\dsh-trpg` 为空；无 node/pnpm on PATH，但 DSH 自带 `node v24.21.0` + `pnpm 11.28.5`，npm 源可达。
- npm：`dsh-trpg` 已被占用；`dsh-trpg-table` / `dsh-trpg-party` / `dsh-trpg-lan` 等后缀名可用。
- 本机无 `gh` CLI、无全局 git 身份；`.dsh` 凭据中没有 GitHub/npm token（只有 DeepSeek 账号与一个 QQBot secret）。
- DSH 实机版本 0.2.2-rc.2（Desktop，packaged app.asar）。
- Host 服务已确认存在：`agents` / `agentLoop` / `tools` / `systemPrompt` / `webServer`（含 `registerUpgrade`）/ `storageDomain`。
- Client 槽位已确认存在：`conversation.view`、`sidebar.right.pane.tab`、`conversation.session.header.actions`、`conversation.composer`、`settings.section`。
- 参考源码：`C:\Users\kkomia\.dsh\apps\dsh-tavern`（launcher + tavern profile + dsh-tavern-plugin / dsh-tavern-remote / dsh-pocket）；本机 `dsh-tavern` 1.5.3 启动器已装。
