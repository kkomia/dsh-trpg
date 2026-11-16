# 跑团桌 · TRPG Table

> 局域网多人 AI 跑团桌，以 DSH 插件形态交付。房主建房、AI 当 KP/GM 负责裁定与叙事、玩家只负责 RP。

<p align="center">
  <b>跑团桌</b> · <code>dsh-trpg-table</code> · v0.1.0 · MIT
</p>

- **AI 只叙事，不兼裁判**：掷骰、检定、伤害、先攻、行动经济全部由确定性规则运行时结算，AI 通过工具拿结论写故事。
- **规则是数据**：规则包 = JSON 数据 + 受限公式 + 固定 JS 钩子（`node:vm` 沙箱）；内置 D&D 5e-lite 规则包与短模组「鬼木崖·异光」。
- **房主制**：谁建房谁是主机，权威状态与事件日志都在房主电脑上；玩家各自用自己的 DSH 客户端加入。
- **对话原生**：不自绘聊天界面——房主当前 DSH 会话即牌桌，AI GM 回复与工具卡由 DSH 原生渲染；插件提供对话头部/空态页「🎲 跑团桌」入口与右侧栏常驻卡片。
- **内容包可制作可分享**：模组/世界书/角色卡统一为 `.trpgpack`（ZIP），内置内容工坊可编辑、导入导出、生成图标与地图资产。
- **玩家侧对话镜像**：玩家本机用 DSH 原生会话看整局（原生气泡/工具卡/轮次），不跑模型、不配 key。
- **后期接 IM**：房间协议与 DSH 解耦，QQ 群等公网玩家走 adapter 接入（v2）。

## 状态

✅ **M0–M9 全部规划里程碑完成（2026-11-17）**：协议/引擎/房间联机、AI GM 与真人 GM、存档续团、对话原生牌桌（M6）、
内容包 `.trpgpack` + 房间接包 + 检索注入（M8）、规则运行时与沙箱、三屏/世界地图/战棋、资产与生图管线、
内容工坊（M9）、玩家侧对话镜像（M7）。本机自动化与桌面端 UI 验收通过：**单测 1130 passed / 0 failed**、
typecheck **0 错误**、`pnpm build` 通过、`pnpm test:e2e` 与 `pnpm test:gm` 冒烟均 **ALL PASS**、
`pnpm pack:plugin` 产出 `dist/dsh-trpg-table-0.1.0.tgz`（**462,830 B（约 452 KiB）**，10 个文件）。

⚠️ **尚未执行（用户侧）**：局域网双机实机验收（host + 1–3 台真机）与 npm 正式发布——分别见
[docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md) §2 与 [docs/RELEASE.md](./docs/RELEASE.md) §5。
M9.6b 内容编辑器与规则测试台改动已提交（commit dad882d，已含在本 tgz）。

当前可用链路：房主打开一个 DSH 会话 → 建房并自动绑定为牌桌 → 朋友用局域网地址 + 邀请码加入并落座 →
AI GM 在牌桌会话里原生带团（工具卡走规则运行时）→ 右栏三屏/世界地图/战棋与工坊；玩家侧原生镜像会话可看整局。

## 文档

| 文档 | 内容 |
|---|---|
| [发布与安装](./docs/RELEASE.md) | 版本策略、构建打包、本地 link/tgz 安装、npm 发布、发布前检查表 |
| [验收清单](./docs/ACCEPTANCE.md) | 本机已验证项与证据、待用户执行的局域网双机验收、已知限制、记录表模板 |
| [路线图](./docs/ROADMAP.md) | M0–M9 里程碑与验收标准（M6/M8/M9 详情、待办项） |
| [设计文档](./docs/DESIGN.md) | 架构、五道锁、协议、AI GM、UI 槽位、风险 |
| [规则模型](./docs/RULES-MODEL.md) / [内容模型](./docs/CONTENT-MODEL.md) / [UI 契约](./docs/UI-CONTRACT.md) | 规则运行时、`.trpgpack` 内容包、三屏/工坊/资产契约 |
| [玩家手册](./docs/PLAYER-GUIDE.md) | 安装、加入房间、落座、掷骰、断线重连、镜像、常见问题 |
| [GM / 房主手册](./docs/GM-GUIDE.md) | 建房、AI/真人模式、GM 控制台、存档续团、模组与工坊 |
| [局域网验收清单](./docs/LAN-ACCEPTANCE.md) | 双机实机跑团的分步检查表（配合 ACCEPTANCE 使用） |
| [CHANGELOG](./CHANGELOG.md) | 0.1.0 交付清单与 0.0.1 初始版本 |

## 架构一图

```
房主 DSH（Host 半边）                                玩家 DSH ×N（Client 半边）
┌────────────────────────────────────────┐   LAN     ┌──────────────────────────────┐
│ 房间服务 · 权威状态机 · 事件日志        │  HTTP+SSE │ 房间连接 · 右侧栏常驻卡片      │
│ 规则运行时（沙箱/种子骰/回合）           │◄────────►│ 三屏/掷骰/落座 · 内容工坊(host) │
│ 内容包 registry（内置+数据目录）         │           │ 玩家本机镜像会话（原生渲染）   │
│ AI GM（牌桌会话 Agent + trpg_* 工具）    │           │ 行动文本 → 房主会话             │
│ 内容工坊/资产与生图（仅 loopback）       │           └──────────────────────────────┘
└────────────────────────────────────────┘
```

## 安装（给朋友）

插件以 DSH bundle 形式分发，需要 DSH Desktop。房主和每位玩家都安装同一版本；玩家端不需要配置模型（AI 只在房主机器上跑）。

**方式一：本地 tgz（推荐）**
1. 仓库构建打包：`pnpm install && pnpm pack:plugin` → `dist/dsh-trpg-table-0.1.0.tgz`（462,830 B，约 452 KiB）
2. 校验（可选）：`pnpm pack:verify`（检查内容清单/版本/许可证，不含 src/test/scripts）
3. 把 tgz 发给朋友；对方在 DSH「插件 → 添加插件」选择该文件（或 `dsh plugin add <tgz 路径>`），启用后**重启 DSH**。

**方式二：本地目录（开发）**
在「插件 → 添加插件」里选择包目录 `packages/dsh-trpg-table`，或让 Agent 用 `plugin_manager install_bundle` 指定该目录；
本机当前开发方式为 profile `link:` 依赖 + `dsh.profile.bundles` 包含 `dsh-trpg-table`（详见 [RELEASE.md](./docs/RELEASE.md) §3）。

## 开发

> 工具链使用 DSH 自带运行时（Node 24 + pnpm 11），也可用任意 Node 22+ / pnpm 11。

```bash
pnpm install
pnpm typecheck     # 七个包的类型检查
pnpm test          # 引擎/协议/内容/房间/插件/规则/资产单测（node --test，原生跑 TS；1130 项）
pnpm test:e2e      # 真实 HTTP+SSE 的房间端到端冒烟
pnpm build         # 打包 DSH bundle → packages/dsh-trpg-table/lib
pnpm pack:plugin   # build + 打 tgz → dist/
pnpm pack:verify   # 校验 tgz 内容（发布检查用）
pnpm content:pack  # 内容包导入/导出/校验 CLI
pnpm demo          # 无 UI 的 CLI 对局战报（引擎+内容验收）
```

## 仓库结构

```
packages/
  protocol/         消息类型与校验
  engine/           D&D 5e-lite 纯函数规则引擎（旧路径，规则运行时对照用）
  rules/            规则包 schema/公式/沙箱/投影 DTO/规则运行时（M9）
  content/          内置内容包 core-guimuya + .trpgpack 编解码与校验
  assets/           PNG/SVG 归一化、SVG 净化、OpenAI 兼容生图客户端（M9.5）
  rooms/            房间服务、规则运行时接入、存档
  dsh-trpg-table/   发布包（DSH host + client 入口）
docs/               设计、路线图、规则/内容/UI 契约、发布与验收
```

## 已知限制

玩家侧镜像只读（行动仍由房主代录）；AI GM 只能绑定当前打开（live）的会话；局域网明文 HTTP 仅限内网；
工坊/写回/生图仅 host loopback；内置包只读需复制副本；zip64/加密 zip 与 JPEG/WebP 资产不支持；
局域网双机与 npm 发布待执行。完整清单见 [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md) §3。

## License

MIT © 2026 dsh-trpg contributors
