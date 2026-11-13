# 路线图（Roadmap）

> 推进方式：自主推进 + 里程碑检查点。每个里程碑结束交付「可验证物 + 3 行摘要 + 下一步」，主理人在检查点验收后再进入下一个。
> 详细设计见 [DESIGN.md](./DESIGN.md)，决策依据见 [DECISIONS.md](./DECISIONS.md)。

## 总览

```
M0 骨架 ─► M1 引擎+内容 ─► M2 房间+联机 ─► M3 AI GM 端到端 ─► M4 真人 GM+收尾 ─► M5 局域网验收+发布
```

## M0 — 工程骨架 ✅ 2026-11-13

**目标**：能装上、能看到入口、能跑测试。

- [x] pnpm workspace、tsconfig、esbuild 打包脚本、`node --test`
- [x] `@dsh-trpg/protocol`：信封类型、校验、版本协商
- [x] `@dsh-trpg/engine`：骨架 + 骰子表达式解析 + 可复现随机数
- [x] `dsh-trpg-table` bundle：`cordis.patch.yml`、host 入口、client 入口、locale、icon、DETAIL
- [x] Client：对话输入框下方出现「🎲 跑团桌」dock，可探测房主 / 建房 / 列房
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

## M3 — AI GM 端到端 🔶 编排完成，待实机联调（2026-11-13）

**目标**：AI 带团，且不串角。

- [x] GM Agent 会话编排（`agents.create` + 专属工具/系统提示作用域 + 串行行动队列）
- [x] GM 工具初版（roll_check / roll_dice / secret_note / reveal_lore / check_lore / list_party）
- [x] 上下文组装（守则 + 模组 + 世界书 + 场景 + 单行动者绑定 + 最近事件）
- [x] 输出处理：assistant 文本 → 房间公共叙事；工具副作用 → 骰子/私密事件
- [x] 反串角回归用例：行动者绑定、单行动者 prompt、私密不越权、工具作用域隔离
- [x] 战斗工具（start_combat / attack / next_turn / combat_status / end_combat，引擎强制轮次）
- [ ] 实机联调：重启 DSH 后 `node scripts/probe-live-gm.mjs` 验证真实模型开口（**待主理人重启**）
- [ ] 叙事流式输出

**验收**：`node --test` 64 项全绿；`node scripts/smoke-gm.mjs` 假 Agent 全链路 14 项检查通过；实机探针待重启后执行。详见 `docs/milestones/M3.md`。

## M4 — 真人 GM 模式 + 收尾 🔶 离线部分完成 2026-11-13

- [x] GM 指令 RPC：`gm.narrate` / `gm.secret` / `gm.scene` / `gm.award`（仅 host token）
- [x] 客户端 GM 控制台：旁白、私发、场景推进、发奖励
- [x] 存档/续团：房间快照（token/角色卡/事件/场景/种子）落盘、启动自动恢复、AI 房间重新拉起 GM
- [x] 奖励私密投影（只到目标玩家）+ 场景进度进房间视图
- [x] 战报导出 Markdown + 成长导出 JSON（客户端本地累计，SSE 补发去重）
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

## 检查点汇报模板

每个 M 结束时给主理人：

1. 这个 M 交付了什么（可验证物路径 / 命令）
2. 怎么验证（一条命令 / 一步操作）
3. 已知问题与下一 M 计划
