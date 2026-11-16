# 跑团桌 · TRPG Table

> 局域网多人 AI 跑团桌，以 DSH 插件形态交付。房主建房、AI 当 KP/GM 负责裁定与叙事、玩家只负责 RP。

<p align="center">
  <b>跑团桌</b> · <code>dsh-trpg-table</code> · MIT
</p>

- **AI 只叙事，不兼裁判**：掷骰、检定、伤害、先攻、状态全部由确定性引擎结算，AI 通过工具拿结论写故事——从机制上消灭「角色混淆 / 行动状态异常」。
- **房主制**：谁建房谁是主机，权威状态与事件日志都在房主电脑上；玩家各自用自己的 DSH 客户端加入，账号与角色卡天然隔离。
- **多人桌**：1 房主 + 1–4 玩家，公共叙事 + 私密个人层；战斗走先攻轮，探索自由行动。
- **中式奇幻首发**：D&D 5e-lite 规则 + 原创短模组「鬼木崖·异光」。
- **对话原生 UI（v3）**：不自绘聊天界面——主区域直接用 DSH 原生会话（房主当前会话即牌桌），插件只提供「🎲 跑团桌」入口（正常对话页在对话头部；DSH「新会话」空态页在左上角，点它会先准备一个会话再打开右侧栏）+ 右侧栏「跑团桌」tab（常驻卡片）+ 建房/加入最小表单；详见 [设计文档 §9](./docs/DESIGN.md)。
- **后期接 IM**：房间协议与 DSH 解耦，QQ 群等公网玩家走 adapter 接入。

## 状态

✅ **M6 对话原生牌桌（本机实机验收通过，2026-11-16）**：房主把当前 DSH 会话绑定为牌桌，AI GM 就是这个会话的 Agent（插件注入 GM 系统提示 + `trpg_*` 工具），玩家行动以用户消息注入会话，GM 原生回复与工具卡由 DSH 原生渲染；插件只保留入口（正常对话页在对话头部、空态/新会话页在左上角）+ 右侧栏「跑团桌」tab 常驻卡片 + 建房/加入最小表单。协议/房间服务/会话桥/客户端已落地，单测 **87 passed / 0 failed**、`node scripts/build.mjs` 构建通过；本机 DSH 桌面端截图验收通过（主区域=DSH 原生对话、头部入口打开右侧栏页签、320/360px 栏宽布局正常、建房自动绑定会话、结束房间=关房解绑）。另：DSH「新会话」空态页左上「🎲 跑团桌」入口已修复（2026-11-16，点它先准备会话再打开右侧栏，真机截图验证）。**局域网双机（host + 另 1–3 台真机）验收待执行**。里程碑见 [docs/ROADMAP.md](./docs/ROADMAP.md)（M0–M7），M6 详情见 [docs/milestones/M6.md](./docs/milestones/M6.md)。

当前可用：房主建房（绑定当前会话）→ 朋友用局域网地址 + 邀请码加入并落座 → AI GM 在房主的牌桌会话里原生带团；存档续团、真人 GM 控制台已具备。本机单机链路已验收，局域网双机联调与玩家侧原生会话镜像（M7）待做：`docs/research/player-mirror.md`。

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](./docs/DESIGN.md) | 架构、五道锁、规则系统、协议、AI GM、UI 槽位、风险 |
| [路线图](./docs/ROADMAP.md) | M0–M7 里程碑与验收标准 |
| [M6 验收报告](./docs/milestones/M6.md) | 对话原生牌桌：目标、设计要点、关键文件、本机实机验收证据、已修复 bug（含新会话空态入口）与已知限制 |
| [访谈决策账](./docs/DECISIONS.md) | 立项以来 24 条决策与理由（含 M6 UI v3 补记、空态入口补记） |
| [玩家手册](./docs/PLAYER-GUIDE.md) | 安装、加入房间、落座、掷骰、断线重连、常见问题 |
| [GM / 房主手册](./docs/GM-GUIDE.md) | 建房、AI/真人模式、GM 控制台、存档续团、模组修改 |
| [局域网验收清单](./docs/LAN-ACCEPTANCE.md) | 双机实机跑团的分步检查表 |

## 架构一图

```
房主 DSH（Host 半边）                          玩家 DSH ×N（Client 半边）
┌──────────────────────────────┐   LAN        ┌──────────────────────────┐
│ 房间服务 · 权威状态机         │  HTTP+SSE    │ 房间连接 · 常驻卡片       │
│ 规则引擎 · 事件日志           │◄────────────►│ 角色卡 · 掷骰 · 落座      │
│ AI GM（DSH Agent + tools）    │              │ 行动走原生会话            │
│ GM 控制台（真人 GM 模式）     │              └──────────────────────────┘
└──────────────────────────────┘
```

## 安装（给朋友）

插件以 DSH bundle 形式分发，需要 DSH Desktop（开发时用 profile 的本地链接）。

**方式一：本地 tgz（推荐）**
1. 克隆仓库并构建：`pnpm install && pnpm build`
2. 打包：`pnpm pack:plugin` → 生成 `dist/dsh-trpg-table-0.0.1.tgz`（约 51 KB）
3. 把 tgz 发给朋友；对方在 DSH「插件 → 添加插件」选择该文件（或 `dsh plugin add <tgz 路径>`），启用后重启 DSH。

**方式二：本地目录（开发）**
在「插件 → 添加插件」里选择包目录 `packages/dsh-trpg-table`，或让 Agent 用 `plugin_manager install_bundle` 指定该目录。

> 房主和每位玩家都需要安装（玩家端不需要配置模型，AI 只在房主机器上跑）。

## 开发

> 工具链使用 DSH 自带运行时（Node 24 + pnpm 11），也可用任意 Node 22+ / pnpm 11。

```bash
pnpm install
pnpm typecheck     # 五个包的类型检查
pnpm test          # 引擎/协议/内容/房间单测（node --test，原生跑 TS）
pnpm test:e2e      # 真实 HTTP+SSE 的房间端到端冒烟
pnpm build         # 打包 DSH bundle → packages/dsh-trpg-table/lib
pnpm demo          # 无 UI 的 CLI 对局战报（引擎+内容验收）
```

安装到 DSH（开发模式）：插件页「添加插件」选择本地目录 `packages/dsh-trpg-table`，或在 Agent 里用 `plugin_manager install_bundle` 指定该目录。

## 仓库结构

```
packages/
  protocol/         消息类型与校验
  engine/           D&D 5e-lite 纯函数规则引擎
  content/          规则数据 + 角色卡 + 世界书 + 模组
  dsh-trpg-table/   发布包（DSH host + client 入口）
docs/               设计、路线图、决策账
```

## 协议

MIT © 2026 dsh-trpg contributors
