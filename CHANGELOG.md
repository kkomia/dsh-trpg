# Changelog

本项目的主要版本记录遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)（0.x 阶段见 [docs/RELEASE.md](./docs/RELEASE.md) §1）。

## [Unreleased]

### 计划中

- 局域网双机实机验收（host + 1–3 台真机）与 npm 正式发布，见 [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md)。
- `pnpm test:gm`（假 Agent GM 冒烟脚本）自 M8.4 接口变更后未同步，待按新 `resolveContent` 口径更新。

## [0.1.0] - 2026-11-17

首个可分发版本：M0–M9 主要能力与 M7 玩家侧镜像完成，`pnpm pack:plugin` 产出可安装 tgz。

### Added

- **内容包 `.trpgpack`（M8.1/M8.2）**：模组/世界书/角色卡统一为 ZIP 内容包（`pack.json` + `assets/`），
  统一 schema、`validatePack()`/`migratePack()`、零依赖 zip 编解码（stored+deflate、大小/路径/CRC 防恶意、可复现）；
  导入导出/校验 CLI（`pnpm content:pack`）；内置包 `core-guimuya`（4 张预制卡、10 条世界书、模组「鬼木崖·异光」）；
  房间按 `{packId, moduleId, packVersion, contentHash}` 引用内容，pack registry 支持内置包 + 数据目录包，
  缺包/版本漂移时降级续团并重扫恢复，`content.list`/`content.reload` RPC 与大厅内容选择器。
- **AI GM 与房间（M2–M4、M6）**：邀请码/玩家 token/落座/踢人/锁房、SSE 事件流与 `lastSeq` 断线补发、
  公共/私密投影；AI GM 全套 `trpg_*` 工具（检定/掷骰/私密/世界书/队伍/战斗/场景/奖励）、
  真人 GM 控制台（旁白/私发/场景推进/发奖励）、存档续团；M6 对话原生牌桌——房主当前会话即牌桌，
  插件在会话 Agent 上注入 GM 提示段与工具，玩家行动注入会话、GM 原生回复与工具卡由 DSH 渲染。
- **规则运行时（M9.1/M9.2/M9.3）**：新包 `@dsh-trpg/rules`——规则 schema（含 `space` zone-grid、`time` 回合、
  `turn` 行动经济）、受限公式编译求值、卡实例与迁移、投影 DTO；种子骰/先攻/回合/效果栈事件总线；
  `node:vm` 脚本沙箱 + 8 个核心钩子 + 场地/时间/上限 9 个钩子（超时/报错/回滚）；dnd5e-lite 规则包重写并随
  `core-guimuya` 分发；旧引擎数值对照测试。
- **主机权威投影与三屏（M9.4/M9.5）**：`sheet.view`/`combat.view`/`worldMap.view` 与 12 个规则 RPC；
  客户端右栏「人物/装备/背包」子页签、主区域人物详情/世界地图页/战棋视图（地形、障碍、token、回合与行动经济条、
  移动范围）；规则类变更全部 host 结算（客户端零规则计算）。
- **资产与生图管线（M9.5a–e）**：`@dsh-trpg/assets`（纯 JS PNG 编解码、SVG 白名单重建式净化、尺寸/体积归一化、
  sha256、`trpg.assets/1` manifest）；OpenAI 兼容客户端；host 只读资产端点 `GET /trpg/assets/…`（ETag/304/403/404）；
  玩家立绘/头像/变体/帧表与落座上传（IndexedDB 本地卡资产 + `GET /trpg/room-assets/…`）；
  地图/战棋生成工作台（AI 结构 → 校验器硬闸 → 重试 ≤2 → 程序化确定性兜底；底图生图后归一化）；
  开发用 ComfyUI→OpenAI shim（`scripts/dev/`，**不打包**）。
- **内容工坊（M9.6a + M9.6b）**：主区域 keyed 工坊页 8 个 tab（概览/角色卡/世界书/模组/规则/图标/地图/分享），
  左栏内容包列表；图标三路径（本地导入 / AI SVG / AI 生图，物品库批量 ≤6）→ `pack.assetPut`；
  地图工作室（生成/预览/保存 battleMaps·zones·world，底图 `target=battle-map|world-map`）；
  分享 tab（导出下载、导入冲突策略 `reject`/`overwrite`/`rename`、内置包复制为可编辑副本）；
  M9.6b 补齐可编辑表单（角色卡/世界书/模组/规则）、规则校验与测试台（`rules.validate`/`rules.test`，临时运行时、不落盘）、
  DiceFrame 卡粘贴导入 UI、地图结构手改与 `calibration` 对齐。
- **GM 检索注入（M8.4）**：世界书改为检索式注入（alwaysOn/场景关联/已揭示/关键词，字符预算 6000；
  未选中 GM 秘密不进提示、玩家可见只取 public）；当前场景 beats/checks/encounters/rewards 与遭遇
  `maxRounds`/`battleMapId` 进 GM 提示；新增 `trpg_scene`/`trpg_reward`，通用 `trpg_use_action`/`trpg_move`/`trpg_combat`
  接规则运行时，旧工具名保留为别名。
- **玩家侧对话镜像（M7）**：host 按收件人投影会话事件（公开叙事/骰子/战斗全桌，私密只投目标，GM 秘密与暗骰不出 GM），
  `GET /trpg/mirror?token&roomId&lastSeq` SSE（环形缓冲+断线重放+心跳）；玩家插件在加入后自动建本机镜像会话
  （白名单事件 `session.append`，标题「跑团桌：<房名>」），用 DSH 原生会话渲染整局，**不跑模型、不消耗 key**；
  右栏「对话镜像」卡显示连接/已同步条数并提供打开入口。
- **DiceFrame 卡适配（M8.5a）**：`schema_version: 2` 卡适配器（属性/技能/资源/装备/叙事字段中英文别名映射、
  `cardId` 稳定派生、个人世界书另导、未映射字段 warning）。
- **发布与验收材料**：插件元数据（repository/homepage/bugs/keywords/license/engines/files、`publishConfig.access=public`、
  包内 LICENSE）、`pnpm pack:plugin` tgz、`scripts/check-pack.mjs`（tgz 内容/版本/许可证/patch 校验）、
  玩家手册与 GM 手册、局域网验收清单、[docs/RELEASE.md](./docs/RELEASE.md)、[docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md)。

### Changed

- 插件版本 `0.0.1` → **`0.1.0`**（仓库根 `package.json` 同步版本与发布元数据，仍为 private）。
- 客户端 UI v3：不再自绘聊天页与插件输入框；入口 = 对话头部「🎲 跑团桌」+ 空态页左上入口 + 右侧栏「跑团桌」tab；
  主区域始终是 DSH 原生会话。
- 打包产物 `dist/dsh-trpg-table-0.1.0.tgz`：**452 KB**（压缩）/ 1991 KB（解包）/ 10 个文件；
  0.0.1 时为 51 KB（内容从 M0 壳增长到 M9 全量）。
- 单元测试 12 → **1130 passed / 0 failed**（七个包）；typecheck 0 错误；`pnpm build` 通过。

### Fixed

- 模组 `scene.lore` 值缺 `entry_` 前缀、与世界书 entry id 不匹配。
- DSH「新会话」空态页无入口：新增 root 作用域 `conversation.header.leading` 全局入口（点它先准备会话再开右栏）。
- 房主「结束房间」只断本地不发 RPC：改为 `room.close`，关房并解绑牌桌会话（撤销 GM 注入）。
- `gm.test.ts` RNG flake（改为按攻击后实时视图选存活目标）。

### Known limitations

完整清单见 [docs/ACCEPTANCE.md](./docs/ACCEPTANCE.md) §3。要点：玩家镜像只读（玩家行动仍由房主在牌桌会话代录）；
AI GM 只能绑定当前打开（live）的会话；局域网明文 HTTP 仅限内网；工坊/生成仅 host loopback + host token；
内置包只读需「复制为可编辑副本」；zip64/加密 zip 与 JPEG/WebP 资产不支持；局域网双机实机验收与 npm 发布未执行。

## [0.0.1] - 2026-11-13

### Added

- 初始工程骨架：pnpm workspace、tsconfig、esbuild 打包、`node --test`；协议信封与校验；引擎骨架
  （骰子表达式、可复现随机）；插件 bundle（`cordis.patch.yml`、host/client 入口、locale、icon）；
  内存态房间（创建/列出）与 `GET /trpg/health`；基础文档与设计稿。单测 12 项。
