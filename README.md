# 跑团桌 · TRPG Table

> 局域网多人 AI 跑团桌，以 DSH 插件形态交付。房主建房、AI 当 KP/GM 负责裁定与叙事、玩家只负责 RP。

<p align="center">
  <b>跑团桌</b> · <code>dsh-trpg-table</code> · MIT
</p>

- **AI 只叙事，不兼裁判**：掷骰、检定、伤害、先攻、状态全部由确定性引擎结算，AI 通过工具拿结论写故事——从机制上消灭「角色混淆 / 行动状态异常」。
- **房主制**：谁建房谁是主机，权威状态与事件日志都在房主电脑上；玩家各自用自己的 DSH 客户端加入，账号与角色卡天然隔离。
- **多人桌**：1 房主 + 1–4 玩家，公共叙事 + 私密个人层；战斗走先攻轮，探索自由行动。
- **中式奇幻首发**：D&D 5e-lite 规则 + 原创短模组「鬼木崖·异光」。
- **后期接 IM**：房间协议与 DSH 解耦，QQ 群等公网玩家走 adapter 接入。

## 状态

🚧 **M3 实机带团验证成功**（2026-11-13）：M0 骨架 → M1 规则引擎与内容 → M2 局域网房间服务 → M3 AI GM（DSH subagent 通道，真实模型实机连跑 3 回合，自动开场、回应玩家行动、按需调用 `roll_check`）。路线图见 [docs/ROADMAP.md](./docs/ROADMAP.md)，里程碑验收报告见 `docs/milestones/`。

当前可用：房主在「🎲 跑团桌」创建 AI GM 房间 → 朋友用局域网地址 + 邀请码加入并落座 → 玩家发言/行动 → AI GM 以 KP 身份回应。真人 GM 面板、存档续团已具备；最后一步是干净重启后的工具掷骰链路验证与局域网验收。

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](./docs/DESIGN.md) | 架构、五道锁、规则系统、协议、AI GM、UI 槽位、风险 |
| [路线图](./docs/ROADMAP.md) | M0–M5 里程碑与验收标准 |
| [访谈决策账](./docs/DECISIONS.md) | 立项以来 22 条决策与理由 |
| [玩家手册](./docs/PLAYER-GUIDE.md) | 安装、加入房间、落座、行动/私聊/掷骰、断线重连、常见问题 |
| [GM / 房主手册](./docs/GM-GUIDE.md) | 建房、AI/真人模式、GM 控制台、存档续团、模组修改 |
| [局域网验收清单](./docs/LAN-ACCEPTANCE.md) | 双机实机跑团的分步检查表 |

## 架构一图

```
房主 DSH（Host 半边）                          玩家 DSH ×N（Client 半边）
┌──────────────────────────────┐   LAN        ┌──────────────────────────┐
│ 房间服务 · 权威状态机         │  HTTP+SSE    │ 房间连接 · 叙事视图       │
│ 规则引擎 · 事件日志           │◄────────────►│ 角色卡 · 骰子 · 队伍      │
│ AI GM（DSH Agent + tools）    │              │ 输入框 = 行动             │
│ GM 面板（真人 GM 模式）       │              └──────────────────────────┘
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
