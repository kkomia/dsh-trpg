# 玩家端会话镜像可行性调研

环境：DSH 0.2.2-rc.2（`F:\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json:4`，Desktop profile，ASAR 内附带 `src/`）。仓库 `dsh-trpg-table` 现状：host 把房间绑定到房主已打开的会话（`packages/dsh-trpg-table/src/host/table-session.ts`）。

## 结论摘要

**总体：条件可行**。玩家自己的 DSH 能显示同一局对话，但有硬边界：**只能复制 DSH 已知的 Session 事件类型，不能新增插件自定义事件类型**；且玩家端要**新开一个本机会话**（“镜像会话”），不能直接“打开 host 的会话”。

推荐分两档落地：
- **P0（低风险兜底，1 人日）**：右栏/主区只读 transcript，复用现有房间 SSE（不写会话、不进原生聊天流）。
- **P1（推荐目标，≈4.5 人日）**：玩家本机插件 `sessions.create()` 建镜像会话，host 按收件玩家把会话事件投影后经中继流下发，玩家插件按序 `session.append()` 重放；玩家用 **DSH 原生会话界面**看整局（原生气泡/工具卡/轮次），不跑模型、不调 key。

明确不可行的三条路：① 插件写自定义事件（如 `trpg/mirror`）——`append` 不写 `ignorable`，读回会整份会话被判不可读；② 玩家端跑模型——玩家无 key，且违背产品决策；③ Live Share——需独立 Liveshare 服务器 + owner 身份 + 隧道，viewer 是房主域名下的浏览器页，不是玩家自己的 DSH。

## 证据

### 1. 持久化与事件模型

- 格式版本 4：`session.v4.jsonl.zstd` 由 `logPath(..., SESSION_FORMAT_VERSION, ...)` 决定
  - `dsh-session/src/types.ts:90` `export const SESSION_FORMAT_VERSION = 4`
  - `dsh-session-format/src/filename.ts:16` `return generation === 0 ? 'session.jsonl' : \`session.v${generation}.jsonl\``
  - `dsh-session-persistence-jsonl/src/format.ts:304` `return generationLogPath(root, cwd, id, SESSION_FORMAT_VERSION, compression)`
- **写入者 = 持久化后端订阅 `session/event`**（不是 agent 写文件）：
  - `dsh-session-persistence-jsonl/src/storage.ts:549`
    ```ts
    yield ctx.on('session/event', (session: Session, event) => {
      writers.get(session.id)?.enqueueLive(event, (error) => { ... })
    })
    ```
  - `dsh-session-persistence/src/handle.ts` / README:57：后端按 session id 路由到该会话的 write handle，异步批量落盘。
- 事件类型全集（含 `user/message`、`assistant/message`、`turn/*`、`step/*`、`tool/call`、`tool/result`、`agent/inbox/spliced` 等 60 余种）：`dsh-session/src/known-event-types.ts:22-86`。
- **免模型追加 API 存在**：`session.append(type, data, { surfaceOp: 'append' })`
  - `dsh-session/src/index.ts:853-871`（重载签名＋`:865` `snapshotAppend` / `:868` `createAppendEvent`）
  - `dsh-session/src/surface.ts:302-327`：surface 类型事件必须带 `surfaceOp`（`'append'` 或 replace），否则拒绝；不校验 turn/step 顺序。
  - `dsh-session/src/surface.ts:166-220`：payload 校验很薄（只查 developer/tool/request-header 的局部一致性），**原样复制的 host 事件天然合法**。
- 事件循环不会因“追加 user/message”而跑模型：
  - `dsh-agent-loop/src/agent.ts:473-482`：`session.append('user/message', ...)` 只发生在 preStep **领取 inbox 之后**。
  - `dsh-agent-loop/src/agent.ts:171-189`：`send(msg,target,wakeup)` / `inject()` 才写 inbox，只有 `wakeup=true` 才 `wakeDriver()`；纯 `append` 不触发。

### 2. 玩家端“建会话 + 同步事件 + 原生界面”

- 插件可建会话：`ctx.sessions.create(id?, opts?)`
  - `dsh-session/src/index.ts:1206-1217`：`prepare`→`enter`→`announce`，归属调用 fiber；返回已入 store、已公告的 live Session（可直接 `append`）。
- 会话出现在玩家侧边栏无需刷新：`dsh-api-session-controller/src/index.ts:224-226`
  ```ts
  ctx.on('session/created', (session) => {
    ctx.emit('api-session/added', this.listState.summaryFor(session))
  })
  ```
  客户端订阅：`dsh-api-session-controller/src/client/index.ts:116` `ctx.remote.$on('api-session/added', ...)`。
- 打开会话后增量可见：`follow` 流
  - `dsh-api-session-controller/src/client/transport.ts:179-183`：`this.remote.session.follow({ address, activate: true, assistantStream: true, ... })`
  - `dsh-api-session-controller/src/web/controller.ts:32-77`：先发 snapshot，再 `yield* queue.items()` 持续推后续事件；因此玩家插件在会话打开期间 append 的事件会实时出现在聊天流里。
  - 未打开的会话不丢：冷会话重新打开时经 `sessionQuery.observeSession`（live 优先，否则持久化冷读 `dsh-session-query/src/cold-read.ts:1-37`）读全量，见 `dsh-api-session-controller/src/history/controller.ts:166-194`。
- 原生渲染复用现成 Definition：`dsh-client-ui-chat/src/client/conversation-nodes/register.ts` 注册 user/assistant/tool/turn 节点；`message.ts:85-134` 中 `user/message` 且 `source.kind === 'user'` → 用户气泡，其它 kind → 折叠的 context 行。
- 自定义事件类型这条路被堵死（关键边界）：
  - `dsh-session/src/index.ts:540-545` `createAppendEvent` 构造的 envelope 只有 `type/seq/time/data`，**无法带 `ignorable: true`**；`appendPluginRecord` 只允许 experimental 包调用（`:498-503`）。
  - 未知且非 ignorable 的事件在读取时整份会话报错：`dsh-session-persistence-jsonl/lib/worker.cjs:7587` `... contains event type "..." unknown to this build`；`known-event-types.ts:8-21` 说明这是故意设计。
  - `docs/subsystems/conversation.md:56-68` 的“Replayable event families + SessionEventMap merge”文档是给**仓内**生产者的；第三方插件往里写会在重开时炸。
- 镜像会话打开会激活 Agent 但**不跑模型**：`follow.activate=true`（transport.ts:181）→ `web/controller.ts:62-71` `promote()`；只建 Agent，不产生模型请求；只有 `sessionController.prompt` 才会请求模型（本仓 `host/index.ts:150-165` 走的就是它）。
- 标题副作用可控：`dsh-session-title/src/index.ts:511,519,542-552` 自动标题必须等一条匹配的 `request/header` 才启动 → 镜像会话无 `request/header`，**不会发标题 LLM 请求**；落到确定性 fallback（`dsh-session-title/src/index.ts:818-824` 的 `fallbackSessionTitle`，纯本地、无 provider 调用）。可用 `session.append('session/title', { title, messageSeqs, source: {kind:'user'} })`（`dsh-session-title/src/types.ts:41-48`）自设标题。

## 推荐方案（P1）与实施步骤

**数据流**：host `ctx.on('session/event')` → 按收件玩家做投影/脱敏 → 中继端点（SSE，带 `lastSeq`）→ 玩家插件 host 侧 → 玩家本机镜像会话 `append` → 玩家客户端 `follow` 流原生渲染。

1. **host 侧中继**（`packages/dsh-trpg-table/src/host`）：在 `TableSessionBridge` 增加 `session/event` 订阅（现有 `onSessionEvent` 只转 `assistant/message`/`turn/end`，见 `table-session.ts:175-200`），在 `room-http.ts` 加 `GET /trpg/mirror?roomId&lastSeq`（SSE，token 鉴权，与 `/trpg/events` 同源模式，`room-http.ts:8`）。
2. **按玩家投影**：白名单事件类型 = `turn/start|end`、`step/start|end`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`session/title`；丢弃 `system/message`、`request/header`、`assistant/attempt`、`compaction/*`、`model/selection`、`subagent/*`、`team/*`、`plugin:*`。对 `trpg_secret_note` 的 `tool/call.arguments` 与 `tool/result.message.content` 做玩家级打码；私密行动只投给行动者。
3. **玩家侧镜像会话**（`ctx.inject(['sessions'], ...)`）：加入房间时 `sessions.create()`（`cwd` 可设为玩家工作区），按 `lastSeq` 回放 backlog 后持续 append；`type+data` 原样复制，仅给 surface 事件补 `{ surfaceOp: 'append' }`；`seq/time` 由 append 重分配，`turn/step` 沿用 host 值。标题用 `session/title`。
4. **入口与防误触**：插件面板“进入牌桌”按钮提示/引导玩家点开镜像会话（客户端没有稳定的“选中会话”公开 API，见 `dsh-client-ui-session/src/client/index.ts:158-181` 只读选择器）；注册 `conversation.composer` chain slot（`dsh-client-ui-conversation/src/client/contract/slots.ts:290`）替换 composer 为“把行动发给房间”，避免玩家误触原生 prompt（无 key 会报 transport 失败，本仓已实测，见 `table-session.ts:9-10`）。

## host 事件 ↔ 会话事件映射（Q4）

| 房间/牌桌语义 | 镜像 session 事件 | 最小字段 |
|---|---|---|
| 玩家行动（host 注入 prompt） | `user/message`（`source.kind='user'`） | `id, role, content[{type:'text',text}], source` |
| GM 叙事 | `assistant/message`（原样复制 host 事件） | `turn, step, message{id,role,content,source}, stream[]`（可空 usage） |
| 掷骰/检定/状态/combat 工具卡 | `tool/call` + `tool/result`（原样复制） | `turn, step, callId, name, arguments`；`message{toolCallId,...}` |
| 轮次结构 | `turn/start|end`、`step/start|end` | `turn`、`{turn, reason}`、`{turn, step}` |
| 私密消息 | 不进公共镜像；仅收件玩家看到（打码后） | — |
| 房间协议现有 `EventKind`（narration/dice/alert/scene/combat/private/award） | 不再单独镜像，作为工具卡的补充或 P0 面板用 | `packages/protocol/src/index.ts:56` |

副作用清单：镜像会话会多一份 `session.v4.jsonl.zstd`、多一条侧边栏会话（建议标题带“【牌桌】”）、进入会话搜索索引；`api-session/activity` 只在 `user/message` 且 `source.kind==='user'` 时更新（`dsh-api-session-controller/src/index.ts:243-246`），无模型调用、无 token 消耗；插件重载（HMR）时 `sessions.create` 归属 fiber 销毁会把会话移出 store（`index.ts:1186-1189`），日志仍在磁盘，重开可恢复。

## 备选方案排序

1. **P1 镜像会话 + 事件中继**（推荐）：原生界面/原生渲染/原生持久化，成本 ≈36h。
2. **P0 右栏只读 transcript**：复用现有 `/trpg/events` SSE（`packages/dsh-trpg-table/src/client/index.ts:558-561` 已在用），只做渲染，成本 6-10h；不满足“原生会话”要求，但可先上线。
3. **哑会话 + 插件自绘聊天**：把自绘组件塞进会话区，成本 12-16h；本质仍是自绘聊天，违背“复用 DSH 原生渲染”的初衷，且需要 hack 会话骨架，不建议。
4. **Live Share（`dsh-experimental-liveshare`）**：原生共享但需独立 Liveshare server（OAuth/DB/路由，`README.md:12,38-58`），viewer 是 relay 页面不是玩家本地 DSH；运维成本 2-3 人日且与“玩家装 DSH 加入”的产品形态不符，只作参考。
5. **把 host 的 Web UI 反向代理给玩家**：2h 演示级，但暴露房主会话与权限，不可用于产品。

## 风险与工作量（人时）

| 项 | 工作量 | 风险 |
|---|---|---|
| 中继通道 + 玩家级投影/脱敏 | 8h | 私密泄漏（必须按收件人投影，不能广播原始事件） |
| 镜像会话创建 + 事件映射 + backlog 续传 | 12h | 断线/中途加入必须从 seq 0 顺序补，append 不允许跳号 |
| 客户端入口 + 替换 composer + 标题 | 6h | 无稳定“自动选中会话”API，需玩家手点一次 |
| 双机联调（重连、插件重载、无 key 激活失败） | 10h | `follow.activate=true` 会为镜像会话建 Agent，无 key 时的表现需实机验证（可能出 error 横幅） |
| 合计 | ≈36h（4.5 人日） | 若 agent 激活在无 key 机器上失败，需 +8h 兜底（改用 P0 面板） |

## 待实机验证（本调研未跑运行时）

1. 玩家端 DSH **无模型 key** 时，打开插件创建的会话（`follow activate=true`）是否安静通过；会否弹 `api-session/error`。
2. 复制 host `assistant/message` 时 `message.source`（host 的 provider/model 元数据）在玩家端渲染是否正常（预期只影响“请求详情”展示）。
3. `tool/result` 的 `meta` 卡（掷骰/战斗卡）在玩家端是否原样渲染（依赖对应 tool 的 presentation 插件在玩家端也启用）。
