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

🚧 **M2 完成（协议层）**（2026-11-13）：M0 骨架 → M1 规则引擎与内容 → M2 局域网房间服务（邀请码/token/玩家席/SSE 断线重连/私密投影/踢人锁房）。路线图见 [docs/ROADMAP.md](./docs/ROADMAP.md)，里程碑验收报告见 `docs/milestones/`。

当前可用：房主在「🎲 跑团桌」面板创建房间 → 朋友填房主局域网地址 + 邀请码加入 → 落座预制角色 → 服务端掷骰（支持私骰）→ 叙事流/悄悄话/踢人/锁房/断线重连。AI GM 在 M3 接入。

## 文档

| 文档 | 内容 |
|---|---|
| [设计文档](./docs/DESIGN.md) | 架构、五道锁、规则系统、协议、AI GM、UI 槽位、风险 |
| [路线图](./docs/ROADMAP.md) | M0–M5 里程碑与验收标准 |
| [访谈决策账](./docs/DECISIONS.md) | 立项以来 22 条决策与理由 |

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
