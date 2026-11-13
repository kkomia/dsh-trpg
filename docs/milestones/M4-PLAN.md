# M4 实施计划（真人 GM 面板 + 存档/散团）

日期：2026-11-13
状态：待实机重启后开工（M3 实机验证是前置）

## 1. 真人 GM 模式（human）

目标：房主当 KP，AI 退为助手，复用同一套引擎与房间协议。

| 能力 | 实现要点 |
|---|---|
| GM 面板 | Client：`settings.section` 或右侧栏页签，显示场景游标、玩家席、秘密清单、事件日志、战斗控制 |
| 叙事写入权 | `room.gm.say` RPC（host token），走与 AI 相同的 narration 事件通道；不再启动 GM Agent |
| 私发秘密 | GM 面板选中玩家 → `secret_note`；复用 rooms.gmSecret |
| 状态干预 | GM 面板可改 HP/状态/场景（走房间服务新方法 `gmSetHp`/`gmSetScene`，带审计事件） |
| AI 助手 | 可选：GM 面板内「让 AI 写一段草稿」按钮 → 启动一次性 Agent turn，输出进候选框，由房主采纳 |

## 2. 存档与续团

- 存档内容：房间元信息 + 玩家席（角色卡快照）+ 事件日志（append-only JSONL）+ 模块/场景游标 + 战斗状态。
- 存储位置：DSH 插件数据目录 `$DSH_HOME/profile-data/desktop/dsh-trpg-table/rooms/<roomId>/`。
- 触发：房主「保存」按钮 / 每 N 个事件自动快照（保留最近 3 份）。
- 续团：载入快照 → 重新发布 room 事件 → GM 收到「续团上下文」（最近 20 条事件摘要）→ 继续。
- 事件日志同时导出 Markdown 战报。

## 3. 散团回传

- 散团时 GM 工具 `end_session` 产出成长结果（XP/物品/状态）→ 以 playerId 定向事件发给每个玩家。
- 玩家客户端收到成长包 → 提示「合并到本地角色卡」（M4 先做展示 + 导出 JSON；写回玩家本地卡库在 M5）。
- 战利品/经验规则：模组 rewards × 完成度（GM 可手改）。

## 4. 测试

- rooms：存档序列化/反序列化往返、快照裁剪、续团事件补发。
- host：GM 面板 RPC 权限（只有 host token 可写）、状态干预审计事件。
- E2E：human 模式建房 → 不启动 Agent → host 用 RPC 发叙事 → 玩家收到；保存→重启服务→载入→事件序号连续。

## 5. 依赖与风险

- **前置**：M3 实机验证（需主理人重启 DSH）。
- 存储用 DSH 自带的 storage/domain 服务（若可用）否则插件数据目录 JSON 文件；先做文件方案，storage 迁移留 M5。
- 写回玩家本地角色卡依赖 DSH Client 侧存储 API，M5 落地。
