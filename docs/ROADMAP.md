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

## M1 — 规则引擎 + 内容

**目标**：无 UI 也能跑完一幕。

- [ ] D&D 5e-lite 数据：4 种族 / 4 职业 / 15 法术 / 12 怪物 / 20 物品
- [ ] 引擎：属性/熟练/检定/优势劣势/AC/HP/先攻/动作经济/条件/法术位/战斗结算
- [ ] 可复现随机：seed + 序号，掷骰日志
- [ ] 内容：首个模组「鬼木崖·异光」（约 45 分钟，三场：接悬赏 → 查古洞 → 守关战）
- [ ] 内容：4 张预制角色卡、世界书（青石镇/枯木崖/古洞）、NPC 卡
- [ ] CLI 对局器：`pnpm cli --module guimuya` 无 AI 跑通一幕，输出 Markdown 战报
- [ ] 引擎单测覆盖核心结算与回放一致性

**验收**：CLI 能完整跑完一幕并产出战报；单测覆盖骰子、检定、战斗、先攻、条件、回放。

## M2 — 房间服务 + 联机（先无 AI）

**目标**：两个 DSH 实例能同桌。

- [ ] 房间服务：邀请码、玩家 token、玩家席、踢人/锁房
- [ ] SSE 事件流 + RPC + 断线重连（lastSeq 补发）
- [ ] 客户端：加入房间、落座、上传角色卡、叙事流、骰子卡片、队伍面板
- [ ] 服务端视图投影（公共/私密）与权限校验
- [ ] 协议仿真测试：并发、越权、重放
- [ ] 干净 profile 实测：玩家端不配模型能否正常使用

**验收**：本机两个 DSH profile（host / player1）完成 建房 → 加入 → 落座 → 掷骰 → 断线重连 → 踢人 全流程。

## M3 — AI GM 端到端

**目标**：AI 带团，且不串角。

- [ ] GM Agent 会话编排（`agentLoop.create` + `followup`）
- [ ] GM 工具全套（roll_check / combat_attack / cast_spell / damage / initiative / npc_speak / reveal / secret_note …）
- [ ] 上下文组装（守则 + 规则摘要 + 世界书命中 + 场景状态 + 行动 + 最近事件 + 私密层）
- [ ] 输出三段处理：narrative / private / toolCalls
- [ ] 反串角回归用例：跨玩家行动拒绝、未调工具不改状态、非当前行动者被拒、私密不越权、GM 秘密不泄露
- [ ] 叙事流式输出

**验收**：本机双实例由 AI GM 带完模组前半段；全部反串角用例通过。

## M4 — 真人 GM 模式 + 收尾

- [ ] GM 面板：场景游标、秘密揭示、先攻控制、事件日志、玩家管理
- [ ] 叙事草稿：AI 产出进候选框，房主采纳/改写/丢弃
- [ ] 散团：战报、成长/战利品回传玩家本地卡
- [ ] 存档与续团：快照 + 日志回放
- [ ] 两种 GM 模式各跑一幕验收

**验收**：两种模式各完成一幕；散团后玩家本地卡拿到成长；续团能接着上次继续。

## M5 — 局域网验收 + 发布

- [ ] 本地 `.tgz` 安装包 + 安装说明（房主 / 玩家两种角色）
- [ ] 玩家手册、GM 手册、模组作者指南
- [ ] 局域网验收清单（防火墙、IP、房间码、掉线、手机浏览器）
- [ ] 主理人 + 1–3 位朋友实机跑完一局
- [ ] 推 GitHub 仓库；npm 发布材料备好（等成熟后发）

**验收**：真实局域网跑完一局；仓库上线 GitHub。

## 检查点汇报模板

每个 M 结束时给主理人：

1. 这个 M 交付了什么（可验证物路径 / 命令）
2. 怎么验证（一条命令 / 一步操作）
3. 已知问题与下一 M 计划
