# 路线图（Roadmap）

> 推进方式：自主推进 + 里程碑检查点。每个里程碑结束交付「可验证物 + 3 行摘要 + 下一步」，主理人在检查点验收后再进入下一个。
> 详细设计见 [DESIGN.md](./DESIGN.md)，决策依据见 [DECISIONS.md](./DECISIONS.md)。

## 总览

```
M0 骨架✅ ─► M1 引擎+内容✅ ─► M2 房间+联机✅ ─► M3 AI GM 端到端✅ ─► M4 真人 GM+收尾🔶 ─► M5 局域网验收+发布🔶 ─► M6 对话原生牌桌✅ ─► M7 玩家侧镜像🔬 ─► M8 内容工坊✅ 决策已定 ─► M9 规则运行时🧭 待确认
```

## M0 — 工程骨架 ✅ 2026-11-13

**目标**：能装上、能看到入口、能跑测试。

- [x] pnpm workspace、tsconfig、esbuild 打包脚本、`node --test`
- [x] `@dsh-trpg/protocol`：信封类型、校验、版本协商
- [x] `@dsh-trpg/engine`：骨架 + 骰子表达式解析 + 可复现随机数
- [x] `dsh-trpg-table` bundle：`cordis.patch.yml`、host 入口、client 入口、locale、icon、DETAIL
- [x] Client：对话输入框下方出现「🎲 跑团桌」dock，可探测房主 / 建房 / 列房（v3 已移除，见 M6）
- [x] Host：创建/列出房间（内存态）、`GET /trpg/health` 可访问
- [x] `README.md` / `docs/` 完成

**验收**：`pnpm test` 12 项全绿；插件装进 desktop profile 后 bundle 列表含 `dsh-trpg-table`；活体 `GET /trpg/health` 返回 ok；Client 槽位 `conversation.composer.dock` 占用者含 `dsh-trpg-table`（active）。视觉外观待主理人页面确认。详见 `docs/milestones/M0.md`。

## M1 — 规则引擎 + 内容 ✅ 2026-11-13

**目标**：无 UI 也能跑完一幕。

- [x] D&D 5e-lite 数据：4 种族 / 4 职业 / 15 法术 / 12 怪物 / 20 物品
- [x] 引擎：属性/熟练/检定/优势劣势/AC/HP/先攻/动作经济/条件/法术位/战斗结算
- [x] 可复现随机：seed + 序号，掷骰日志
- [x] 内容：首个模组「鬼木崖·异光」（约 45 分钟，三场：接悬赏 → 查古洞 → 守关战）
- [x] 内容：4 张预制角色卡、世界书（青石镇/枯木崖/古洞 + 3 条 GM 秘密）、NPC 卡
- [x] CLI 对局器：`node scripts/cli-demo.mjs` 无 AI 跑通一幕，输出 Markdown 战报
- [x] 引擎单测覆盖核心结算与回放一致性

**验收**：40 项测试全绿；CLI 场景一洞悉检定 + 场景三 Boss 战 4 轮击败赤目道人+血尸，输出 42 条事件日志、seed 可复现。详见 `docs/milestones/M1.md`。

## M2 — 房间服务 + 联机（先无 AI） ✅ 协议层完成 2026-11-13

**目标**：两个 DSH 实例能同桌。

- [x] 房间服务：邀请码、玩家 token、玩家席、踢人/锁房
- [x] SSE 事件流 + RPC + 断线重连（lastSeq 补发）
- [x] 客户端：加入房间、落座、上传角色卡、叙事流、骰子卡片、队伍面板
- [x] 服务端视图投影（公共/私密）与权限校验
- [x] 协议仿真测试：并发、越权、重放
- [ ] 干净 profile 实测：玩家端不配模型能否正常使用（顺延 M5）

**验收**：`node --test` 53 项全绿；`node scripts/smoke-room.mjs` 真实 HTTP+SSE 21 项检查全通过（建房→加入→落座→公共/私密骰→悄悄话→重连补发→踢人→锁房）。双 DSH 实例实机联调与「玩家端不配模型」的检查顺延到 M5 局域网验收。详见 `docs/milestones/M2.md`。

## M3 — AI GM 端到端 ✅ 实机验证通过 2026-11-13

**目标**：AI 带团，且不串角。

- [x] GM Agent 会话编排（DSH **subagent 通道**：子 Agent 继承宿主会话模型上下文；串行行动队列）
- [x] GM 工具全套（roll_check / roll_dice / secret_note / reveal_lore / check_lore / list_party / start_combat / attack / next_turn / combat_status / end_combat）
- [x] 上下文组装（守则 + 模组 + 世界书 + 场景 + 单行动者绑定 + 最近事件）
- [x] 输出处理：子 Agent 结果 → 房间公共叙事；工具副作用 → 骰子/私密事件
- [x] 反串角回归用例：行动者绑定、单行动者 prompt、私密不越权、工具作用域
- [x] 实机联调：真实模型带团 + 引擎掷骰全链路（游说失败/洞悉成功两例）
- [ ] 叙事流式输出（当前一次性输出）

**验收**：真实 DeepSeek 模型实机开场 + 玩家行动回应 + `roll_check` 引擎掷骰（骰面/DC/成败进事件流），见 `docs/milestones/M3.md`。

## M4 — 真人 GM 模式 + 收尾 🔶 离线部分完成 2026-11-13

- [x] GM 指令 RPC：`gm.narrate` / `gm.secret` / `gm.scene` / `gm.award`（仅 host token）
- [x] 客户端 GM 控制台：旁白、私发、场景推进、发奖励
- [x] 存档/续团：房间快照（token/角色卡/事件/场景/种子）落盘、启动自动恢复、AI 房间重新拉起 GM
- [x] 奖励私密投影（只到目标玩家）+ 场景进度进房间视图
- [x] 实机验证：存档续团（5/5）、真人 GM 指令（7/7）——见 `docs/milestones/M4.md`
- [ ] 成长写回玩家本地角色卡库（需 DSH 客户端存储 API；当前先导出 JSON/JSON patch）
- [ ] 实机验证（DSH 重启后）

**验收**：单测 70 项全绿；房间 E2E 28 项全过；AI GM 假 Agent E2E 全过。详见 `docs/milestones/M4.md`。

## M5 — 局域网验收 + 发布 🔶 安装包就绪 2026-11-13

- [x] 本地 `.tgz` 安装包脚本（`pnpm pack:plugin` → `dist/dsh-trpg-table-0.0.1.tgz`，51 KB）
- [x] 玩家手册 / GM 手册 / 局域网验收清单（`docs/PLAYER-GUIDE.md`、`docs/GM-GUIDE.md`、`docs/LAN-ACCEPTANCE.md`）
- [ ] 局域网验收清单执行（防火墙、IP、邀请码、掉线、手机浏览器）
- [ ] 主理人 + 1–3 位朋友实机跑完一局
- [ ] 推 GitHub 仓库当前已推送；npm 发布材料备好（等成熟后发）

**验收**：真实局域网跑完一局；仓库上线 GitHub（已达成：https://github.com/kkomia/dsh-trpg）。

## M6 — 对话原生牌桌（复用 DSH 会话）✅ 完成 2026-11-16

主理人反馈：不要自绘聊天界面，直接复用 DSH 的 AI 对话框架；控件放对话头部 + 右侧栏常驻卡片。

- [x] 协议/服务：`room.create` 可带 `sessionId`、新增 `room.bind`（host token + 参数校验）、`RoomView.sessionId`、存档携带会话绑定
- [x] 房间服务 `bindSession`：绑定/改绑/解绑，关闭房间自动解绑
- [x] Host 桥 `host/table-session.ts`（`TableSessionBridge`）：房主会话即牌桌——在会话 Agent 上注册 GM 提示段与 GM 工具；玩家行动 → `sessionController.prompt` 注入会话；AI 的 assistant 文本 → 房间 GM 旁白广播
- [x] GM 工具加 `trpg_` 前缀，避开 subagent 全局工具同名遮蔽；系统提示同步实际工具名
- [x] live 会话注入实测（运行中的 DSH）：建房绑定当前会话 → 玩家行动以 `user/message` 进入会话 inbox；系统提示出现 GM 人格与工具（`trpg_roll_check` 等），即 AI GM 就是会话 Agent
- [x] GM 原生回复 + 工具卡实测：assistant 文本回写房间事件（`gmNarrate`），掷骰/战斗等工具卡由 DSH 原生渲染
- [x] 客户端 v3：对话头部「🎲 跑团桌」入口 + 右侧栏「跑团桌」tab（常驻紧凑卡片）；自绘整页面板、feed 气泡流、插件输入框（`main` / dock / composer）已删除
- [x] 清理临时诊断入口 `debug.*`（sessions/create/gateway/fetch/tail/prompt）、`probeCapture`、`probeAgentErrors`、`debugHandlerRef`、`DSH_TRPG_DEBUG_DIR`、`gm-bare`
- [x] **新会话空态入口修复（2026-11-16）**：空态/新会话页没有对话头部操作集群（`conversation.session.header.actions` 在 `hideChrome=blank` 时整块不渲染），新增 root 作用域全局入口 `conversation.header.leading`（single slot，无会话也渲染）：空态页/空白会话页显示「🎲 跑团桌」，有正常会话时让位给原 chip；点击先 `uiWorkspace.startSession()` 准备会话、短重试后 `openTab`，失败给引导文案；真机截图 `.tmp/verify2/20-final-empty-state-no-tab.png`、`21-final-empty-state-open-tab.png` 验证空态页可直接开 tab（gitignored）
- [x] 单测全套 **87 passed / 0 failed**；修复 `gm.test.ts` 的 RNG flake（改为用攻击后实时视图选存活目标，1000 次复跑 0 失败）
- [x] 构建：`node scripts/build.mjs` 成功（`lib/host.js`、`lib/client.js`）
- [x] **实机截图验收（2026-11-16，本机 DSH 桌面应用）：通过**
  - [x] a) 主区域仍是 DSH 原生对话（对话/轨迹/统计 + 原生消息流与输入框），无插件自绘聊天、无空白中心区
  - [x] b) 对话头部「🎲 跑团桌」入口可打开右侧栏「跑团桌」页签（与其它页签并列、无重复页签）；卡片状态：未进房=房主地址/开团（我是房主）/加入朋友的团，进房后=房间状态/玩家席/落座/掷骰/GM 控制台/成长
  - [x] c) 布局：约 320 与 360 CSS px 栏宽下卡片无溢出/重叠、长文案折行、中文无乱码；内容未超高故未触发滚动（root `overflowY:auto` 兜底、无裁切）；≈300px 极窄且多页签时页签标题会截断（卡片本身正常，已知小限制）
  - [x] d) 建房/绑定链路：建房时 `sessionId` 取自当前 tab 会话并自动绑定；卡片显示房间号、牌桌会话短 id、「已绑定本会话」按钮（host-only）
  - [x] 验收中发现并修复 1 个客户端 bug：房主「结束房间」原来只断本地、不发 RPC，房间与「绑定本会话」仍存活（GM 系统提示/`trpg_*` 工具持续注入）；改为房主走 `room.close`、玩家仍走 `room.leave`，重构建+重载复验：建房→`room.list` 1 间→点结束房间→`room.list` 立即为空、UI 回大厅、`onRoomClosed → tableBridge.unbind` 撤销注入
  - 截图：`.tmp/verify/09-fix-verify-room-created.png`（建房+绑定本会话）、`10-fix-verify-room-closed.png`（关房回大厅）；该目录 gitignored，不入库

**关键约束（本机实测）**：只有**正在被 DSH 页面驱动（live）**的会话才能完成模型请求；插件新建/恢复的会话一律 `DeepSeek Messages transport failed [TRANSPORT]`。所以牌桌必须绑定房主已打开的会话；未打开时 `room.bind` 回可读错误（「这个会话当前没有活动的 AI…请先打开该会话再开团」）。

**已知缺口**：1) 插件输入框随 v3 删除后，远端玩家的行动入口尚未接上（`room.say` 目前由探针/回归脚本调用）——「玩家在自己原生会话里写行动 → 转发到房间」随 M7 玩家镜像一并收口；2) tab 已打开时再点对话头部按钮或空态页入口会重开页签（短暂空白 + 右栏宽度回默认，不产生重复页签），待做幂等打开；3) 重载后 localStorage 残留旧房 token 会红字提示「无法恢复房间：令牌无效或已失效」，应改为静默清理；4) 空态入口挂在 `conversation.header.leading`（root 作用域 single slot），将来若有其他插件占用同一 slot 会冲突，需协调挂载点。M6 的玩家行动注入验证走房主侧会话。

**验收**：本机 DSH 桌面端实机验收通过（2026-11-16）：主区域仍是 DSH 原生对话；对话头部入口与空态页左上入口均可打开右侧栏「跑团桌」页签；320/360px 栏宽布局正常；建房自动绑定会话，结束房间=关房并解绑。单测 87 passed / 0 failed、`node scripts/build.mjs` 构建通过；细节与截图清单见 `docs/milestones/M6.md`。局域网双机（host + 另 1–3 台真机）验收待执行。

## M7 — 玩家侧对话镜像 🔬 方案已调研 · 待实机验证 2026-11-16

**目标**：玩家用自己 DSH 的原生会话看整局对话（原生气泡/工具卡/轮次），不跑模型、不配 key，插件不自绘聊天。

调研结论见 [`docs/research/player-mirror.md`](./research/player-mirror.md)：**条件可行**；只能复制 DSH 已知的 Session 事件类型（不能新增插件自定义事件类型），且玩家端要新建「镜像会话」，不能直接打开房主会话。

- **P1 推荐（≈36h / 4.5 人日）**：host `ctx.on('session/event')` → 按收件玩家投影/脱敏 → `GET /trpg/mirror?roomId&lastSeq`（SSE，token 鉴权，与 `/trpg/events` 同源模式）→ 玩家插件 `sessions.create()` 建镜像会话，按白名单 `session.append()` 重放（`turn/start|end`、`step/start|end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`session/title`；`trpg_secret_note` 打码，私密行动只投行动者；丢弃 `system/message`、`request/header`、`compaction/*` 等）→ 玩家客户端 `follow` 原生渲染。
- **P0 兜底（6–10h）**：右栏只读 transcript，复用现有 `/trpg/events` SSE，不写会话、不进原生聊天流。
- **明确不可行**：插件写自定义事件类型（`append` 不带 `ignorable`，重开整份会话不可读）、玩家端跑模型（无 key，违背产品决策）、Live Share（需独立服务器，viewer 是浏览器页不是玩家本机 DSH）。

**待实机验证（3 项，调研未跑运行时）**：

1. 玩家端 DSH **无模型 key** 时，打开插件创建的会话（`follow activate=true`）是否安静通过，会否弹 `api-session/error`；
2. 复制 host 的 `assistant/message` 时 `message.source`（host 的 provider/model 元数据）在玩家端渲染是否正常（预期只影响「请求详情」展示）；
3. `tool/result` 的 meta 卡（掷骰/战斗卡）在玩家端是否原样渲染（依赖对应 tool 的 presentation 插件在玩家端也启用）。

**验收**：玩家本机出现「【牌桌】…」镜像会话，原生渲染整局且全过程无模型请求、不消耗 key；或按 P0 先上线只读 transcript。

## M8 — 内容工坊（统一内容模型）✅ 决策已定 · M8.1 ✅ · M8.2 ✅ · M8.3–M8.5 待 M9 后 2026-11-16

**目标**：模组/世界书/角色卡统一为内容包（Content Pack）：一套 schema 制作、校验、导入导出、分享；制作/分发单元是 `.trpgpack`（**ZIP** 容器：`pack.json` + 可选 `assets/`），房间只引用 `{packId, moduleId}`，GM 按需消费模组数据。4 条分叉已于 2026-11-16 定稿（编辑器=主区域独立页+右栏轻量入口；包=zip；卡=双轨；先地基后 UI），数据形状、zip 结构与校验约定见 [`CONTENT-MODEL.md`](./CONTENT-MODEL.md)（§2、§8）。

- [x] **M8.1 地基（无 UI）✅ 2026-11-16**：统一 pack/card/lorebook/module schema + `validatePack()`/`migratePack()`；内置包 `core-guimuya` 迁移（4 张预制卡 + 10 条世界书）；`.trpgpack` zip 编解码（`node:zlib` 零依赖，stored+deflate、大小上限/路径安全/CRC、时间戳固定可复现）；导入导出/校验 CLI `scripts/content-pack.mjs`（`pack-check.mjs` 兼容别名，根 `package.json` 加 `content:pack`）；引用完整性校验（`loreIds/npcIds/encounterIds/rewardIds/startSceneId` + assets）；修复已知数据 bug（模组 `scene.lore` 值缺 `entry_` 前缀、与世界书 entry id 不匹配）；保留 `GUIMUYA_*`/`PRESET_CARDS` 兼容导出；编解码/恶意 zip/迁移单测。**结果**：实现文件 `packages/content/src/{pack,zip,pack-zip,pack-io}.ts` + `packs/core-guimuya.ts`（`CORE_GUIMUYA_PACK` / `CORE_PACKS`）；单测 114 passed（新增 `pack.test.ts` 14 + `zip.test.ts` 13），typecheck 0 错误，构建通过。
- [x] **M8.2 房间接包 ✅ 2026-11-16**：`room.create` 带 `{packId, moduleId}`、建房选模组、房间记录 `{packVersion, moduleId, contentHash}` 快照引用、pack registry（内置 + 数据目录 `.trpgpack`）与玩家只读拉取、缺包/版本变更降级续团，去 host/client 硬编码。**结果**：`host/pack-registry.ts`（内置 `CORE_PACKS` + 数据目录 `<profile-data>/<profile>/dsh-trpg-table/content/packs/*.trpgpack`，坏包跳过、重复 `packId` 内置优先、可重扫）；协议 `room.create` 可选 `packId/moduleId`、`RoomView.content`/`RoomView.scenes`、RPC `content.list`（脱敏目录，无 token）与 `content.reload`（loopback + host token）；房间只存内容引用 + 场景摘要，包缺失/版本或 hash 漂移 → `degraded` + 警告、GM 回退内置包，重扫后恢复；host 去掉 `GUIMUYA_*` 硬编码，GM 提示/工具按房间解析；客户端大厅「内容包 / 模组」选择（失败静默降级内置包）、建房传内容引用、房间卡展示包/模组/版本 + 降级红色告警、GM 场景下拉改吃 `room.scenes`。单测 **114 → 134**（protocol 2、rooms 9、registry 6、room-http 3），typecheck 0 错误，构建通过；**本机真机验收通过**（大厅选择 / 建房内容展示 / 场景下拉 3 场 / 关房回大厅，截图 `.tmp/verify3/`，gitignored）。
- [ ] **M8.3 内容工坊 UI（排在 M8.1、M8.2 之后）**：主区域独立工具页（角色卡编辑器 / 世界书编辑器 / 模组编辑器三 tab，含卡只读面板）+ 右栏轻量入口；pack 选择、`.trpgpack` 导入导出、校验结果、预览。**顺延至 M9 规则层定稿后**：规则数据/公式/脚本编辑器依赖 M9.1 schema；只读卡面拆为 M8.3a 可提前，完整工坊并到 M9.6（原 M9.5，依赖见 [RULES-MODEL.md](./RULES-MODEL.md) §12/§13）
- [ ] **M8.4 GM 检索注入 + 模组数据消费**：世界书按需检索（alwaysOn/场景关联/已 reveal/关键词 + token 预算）、checks/encounters/rewards/beats 进提示与工具
- [ ] **M8.5 分享与 DiceFrame 适配**：`.trpgpack` 导出/导入与同 `packId` 冲突处理、DiceFrame `schema_version: 2` 卡适配器、内容作者文档（zip 目录结构 + 用编码器打包说明）

**依赖**：先 M8.1 地基（zip 编解码/校验/迁移）→ M8.2 房间接包，M8.3 UI 排在这两步之后（避免 schema 返工；现因规则层定稿**顺延至 M9 之后**，见下 M9）；M8.4 依赖 M8.1/M8.2，M8.5 依赖 M8.1/M8.3。M7 玩家侧镜像可并行，交叉点只在 GM 提示组装（M8.4）与玩家投影。

M8.3 内容工坊 UI 依赖 M9 规则层定稿（见 [RULES-MODEL.md](./RULES-MODEL.md) §12/§13）。

## M9 — 规则运行时（可定义规则）🧭 待确认 2026-11-16

**目标**：引擎不认识任何具体规则。规则 = **数据**（JSON 描述有什么）+ **受限公式**（简单算法）+ **核心 8 + 场地/时间/上限 9 的固定 JS 钩子**（复杂逻辑，全可选）；内置示例规则包 dnd5e-lite 用新模型重写；客户端只渲染主机投影（零脚本执行）。规则模型四条结论已于 2026-11-16 拍板，完整设计、钩子/公式/数据形状与验收标准见 [RULES-MODEL.md](./RULES-MODEL.md)（§0、§3、§6、§13）。M9 内新增 **M9.5 资产、图标与地图生成管线**（人物/装备/背包三屏图标与立绘 + AI 地图生成工作台，见 [UI-CONTRACT.md](./UI-CONTRACT.md) §10），原「M9.5 规则编辑器」顺延为 **M9.6**。第十轮（2026-11-16，DECISIONS #28）补充的**战斗空间与回合模型**——zone-grid 双层地图、只做回合计数、行动经济数据化、GM 工具泛化、AI 地图生成——并入 M9.1/M9.4/M9.5e/M9.6（见 [RULES-MODEL.md](./RULES-MODEL.md) §3/§7.1、[UI-CONTRACT.md](./UI-CONTRACT.md) §5.4/§5.5/§10）。

- **M9.1 规则 schema + 公式编译/求值 + 卡实例/迁移 + 投影 DTO（纯库 + 测试）**：新包 `@dsh-trpg/rules` 骨架（types、`validateRulesPack()` 含 `space` zone-grid / `time` round / `turn` 行动经济段、公式 parser/compiler/evaluator、卡实例与迁移、`SheetView`/`CombatView`/`WorldMapView` 投影 DTO 形状），不接 host。验收：公式 40+ 例单测（含编译期/运行期错误）、schema 校验（含 zone-grid/round/turn 各 1 组正反例）、旧卡迁移；typecheck 0、不新增运行时依赖。
- **M9.2 核心运行时 + 脚本沙箱**：种子骰/回合先攻/事件总线/效果栈（与规则无关）+ `node:vm` 沙箱 + 核心 8 + 场地/时间/上限 9 钩子调度 + 超时/sha256/错误事件。验收：核心 8 + 场地/时间/上限 9 各覆盖正常/抛错/超时/回滚；同 eventSeq 回放骰面一致；沙箱逃逸 smoke 记录已知边界。
- **M9.3 dnd5e-lite 示例规则包 + 迁移**：`rules.json` + 4 个脚本、`core-guimuya` pack 带 rules 段（含 `space`/`time`/`turn` 数据）、旧卡迁移器、与旧 engine 对照测试。验收：CLI 用「鬼木崖·异光」跑完一幕，骰面/命中/伤害/AC/先攻逐项与旧实现一致；单测迁移后全绿（134 → 新增规则测试）。
- **M9.4 协议/房间/客户端卡面与地图视图（主机权威投影）**：`sheet.view`/`combat.view`/`worldMap.view` + `sheet`/`rules` 事件 + 重连重算；客户端只读卡面（分组/资源条/装备槽/可用动作/状态）+ **世界地图页（主区域独立页：插画底图 + zone 热点/连线 + 当前位置）** + **战棋战斗视图（底图 + 半透明网格 + 地形/障碍图标 + token + 回合/行动经济条）**。验收：双实例落座→检定→攻击→移动→断线重连后投影一致；世界地图与战棋视图正常；玩家端构建产物不含规则执行代码；320–420px 栏宽可读。
- **M9.5 资产、图标与地图生成管线（新增，UI-CONTRACT §10）**：人物/装备/背包三屏的图标与立绘体系 + 地图生成工作台。a) **M9.5a 地基**：`@dsh-trpg/assets` 纯 JS 归一化（PNG/SVG、零原生依赖）+ SVG 白名单净化 + OpenAI 兼容客户端（chat/images）+ `assets/manifest.json`（`trpg.assets/1`）与 `validatePack()` 资产校验 + host 只读端点 `GET /trpg/assets/<packId>/<assetPath>` + `iconRef/AssetRef` DTO。b) **M9.5b 工坊图标工作台**：三 tab（导入 / AI SVG / AI 生图）+ 预览/多候选/重生成/批量 + manifest 生成历史 + 原子落盘。c) **M9.5c 开发用 ComfyUI→OpenAI shim**：放 `scripts/dev/`，不打包、不算正式功能，仅本地验证。d) **M9.5d 玩家立绘/变体/精灵帧表 + 落座资产上传**（只传展示用资产，≤8 文件 / ≤8 MiB，按 sha256 去重）。e) **M9.5e 地图与战棋生成工作台**：AI 结构草稿（ASCII 地形矩阵/障碍/出生点）→ **地图结构校验器**（尺寸/边界/连通性/出生点/token/引用/图例）→ AI 底图（世界图 2D 插画 / 战斗图俯视 2D·像素两档）→ 预览叠加与 `calibration` 对齐 → 离线程序兜底（结构 + 程序化背景）。验收：归一化与净化单测（拒 16-bit/交错/JPEG/WebP、恶意 SVG 全拒）+ mock OpenAI 跑通生图链路；工坊给整库批量出图标并确认落盘、导出 `.trpgpack` 后另一台机器可见；双实例落座后队友能看到玩家立绘；给「洞口」生成 ≤32×32 战棋图并拒绝断连/越界/出生点重叠；AI 不可用时程序兜底可导出可玩；`pnpm pack:plugin` 产物不含 shim。
- **M9.6 规则编辑器 + 地图工坊（M8.3 顺延至此；原编号 M9.5）**：工坊规则 tab（schema 表单 + 代码编辑器 + 沙箱试跑 + 断言面板 + 模板库）；**地图工坊**：`space` 结构矩阵编辑/校验定位/底图替换与对齐微调/世界地图热点编辑。验收：作者不改源码完成一次规则包修改并通过规则测试台；不改源码调整一张战棋图或世界地图热点并通过校验；导出 `.trpgpack` 后另一台机器可玩。

**依赖与并行**：**M7 玩家侧镜像可并行**（改 client 镜像/会话事件，与规则包文件面不重叠；交叉点只有投影字段与事件类型）；**M8.3 UI 依赖 M9.1 + M9.4**（schema 与投影定稿后再开工）；**M8.3a 只读卡面可提前**（依赖 M8.2 + M9.1 的卡 DTO，让现有团先看到新卡面）；**M9.5 依赖 M9.1/M9.4 的投影 DTO 与 M8.1 的 zip/资产校验**（三屏骨架与地图视图壳随 M9.4 先落地，M9.5d 才接真图、**M9.5e 才接真底图**；M9.5e 另依赖 M9.1 的 `space` schema + M9.5a 的资产生图/归一化）；**M9.6 依赖 M9.1/M9.4 + M9.5b 的工坊壳 + M9.5e 的地图校验器**（含地图工坊）；M8.4/M8.5 不受阻，可穿插。

**状态**：🧭 待确认——规则模型四条结论与第十轮「战斗空间与回合模型」（DECISIONS #28）已定稿，M9 是否现在启动与 M8.3 拆分方式待主理人拍板。

## 检查点汇报模板

每个 M 结束时给主理人：

1. 这个 M 交付了什么（可验证物路径 / 命令）
2. 怎么验证（一条命令 / 一步操作）
3. 已知问题与下一 M 计划
