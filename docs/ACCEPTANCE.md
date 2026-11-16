# 验收清单（Acceptance）

> 目标：区分**已在本机验证**的能力与**必须由用户/真机执行**的验收项，并记录已知限制。
> 发布/安装步骤见 [RELEASE.md](./RELEASE.md)；逐步操作清单见 [LAN-ACCEPTANCE.md](./LAN-ACCEPTANCE.md)。
> 状态（2026-11-17）：全部规划里程碑完成；本机自动化与桌面端 UI 验收已完成；**局域网双机（host + 1–3 台真机）与 npm 发布待用户执行**（§2）。

## 1. 本机已验证（含证据位置）

| 项 | 结果 | 证据位置 |
|---|---|---|
| 单元测试（7 个包） | ✅ 1130 passed / 0 failed | 2026-11-17 `node --test` 全量输出；分项：engine/protocol/content/rooms/dsh-trpg-table/rules/assets |
| 类型检查 | ✅ 0 错误（7 个包） | `pnpm typecheck`；各包 `tsc -p` 全 OK |
| 构建 | ✅ host.js + client.js | `pnpm build`；产物 `packages/dsh-trpg-table/lib/` |
| 打包内容/体积 | ✅ 462 KB（462,830 B；按 KiB 记 452 KB）/ 10 文件，无开发产物 | `pnpm pack:plugin && pnpm pack:verify`；`dist/dsh-trpg-table-0.1.0.tgz`；`scripts/check-pack.mjs` 校验通过 |
| 房间 E2E（真实 HTTP+SSE） | ✅ ALL PASS（建房→加入→落座→骰→悄悄话→重连补发→踢人→锁房） | `pnpm test:e2e`（`scripts/smoke-room.mjs`） |
| GM 冒烟（假 Agent） | ✅ ALL PASS（已适配 M8.4 `resolveContent` 与工具数量，commit 3a2e38f） | `pnpm test:gm`（`scripts/smoke-gm.mjs`） |
| M6 对话原生牌桌 + 空态入口 | ✅ 真机截图（本机桌面端） | `.tmp/verify/00–10`、`.tmp/verify2/00–21`（gitignored） |
| M7 玩家侧对话镜像 | ✅ 真机截图（本机模拟玩家身份） | `.tmp/verify7/00–44`（镜像会话/右栏镜像卡/工具卡/玩家身份） |
| M8.2 房间接包（选包/降级/场景下拉） | ✅ 真机截图 | `.tmp/verify3/01–03` |
| M9.4 三屏 + 世界地图 + 战棋 | ✅ 真机截图 | `.tmp/verify4/01–10` |
| M9.5d 玩家资产/立绘 + 对话框 | ✅ 真机截图（双实例立绘互见已验） | `.tmp/verify5/01–31`（资产/立绘/对话框）；双实例互见在 §2 双机验收时顺带复核 |
| M9.5e / M9.6a 地图工作室 + 工坊 8 tab + 分享 | ✅ 真机截图 | `.tmp/verify6/01–06`（导出/导入冲突/复制内置包） |
| M9.6b 工坊编辑器 + 规则测试台 + DiceFrame 导入 + 地图校准 | ✅ 真机截图（commit dad882d） | `.tmp/verify8/01–06`（世界书/模组/规则/角色卡编辑器、规则测试台、DiceFrame 导入、地图校准） |
| 各阶段真机截图目录（汇总，均 gitignored） | ✅ | `.tmp/verify/00–10`、`.tmp/verify2/00–21`、`.tmp/verify3/01–03`、`.tmp/verify4/01–10`、`.tmp/verify5/01–31`、`.tmp/verify6/01–06`、`.tmp/verify7/00–44`、`.tmp/verify8/01–06` |
| 打包不含 `scripts/dev` shim | ✅ | 见 `pnpm pack:verify` 输出 |

> 截图目录在 `.tmp/`（gitignored，不入库）。需要归档时把关键截图复制到 `docs/acceptance-shots/` 后再提交。

## 2. 待用户执行（两项）：局域网双机验收 → npm 发布

> 两项都由用户在本机执行：Agent 无 npm 凭据（发布需账号 + 双因素 OTP），也无法代替真机/局域网环境。发布口径见 [DECISIONS.md](./DECISIONS.md) #29（第十一轮）。

### 2.1 局域网双机验收（发布 npm 的前置）

准备：房主 + 1–3 台真机安装**同一版本 tgz（0.1.0）**并重启 DSH；房主确认模型可用；查房主局域网 IP
（`ipconfig`，与玩家同网段）；Windows 防火墙放行 TCP **45871**（或首次弹窗允许专用网络）。玩家端**不配模型**，
同时验证「无 key 也能看完整局」。操作步骤按 [LAN-ACCEPTANCE.md](./LAN-ACCEPTANCE.md) §0–§6 逐项打勾，重点观察：

1. **连通**：`http://<房主IP>:45871/trpg/health` 返回 `ok:true`；玩家能加入、落座，房主「玩家席」看到角色名。
2. **AI 带团**：房主打开作牌桌的会话 → 建房（自动绑定）→ 开场叙事；需要判定时出现 DSH 原生工具卡
   （骰面/DC/成败），叙事与工具数字一致；私骰/悄悄话只到目标玩家。
3. **玩家镜像（M7）**：玩家加入后右栏「对话镜像」显示「已连接，已同步 N 条」；点开本机「跑团桌：<房名>」
   会话可原生查看整局；**全程玩家端无模型请求、不消耗 key**；GM 秘密工具与暗骰不出现在玩家镜像。
   ⚠️ 镜像当前是**只读**的：玩家在自己镜像会话里写发言不会转发进房间，请勿依赖它提交行动。
4. **桌面与战棋**：右栏人物/装备/背包三屏有数据；主区域人物详情、世界地图（热点/当前位置）、
   战棋（底图/网格/token/回合条）正常；320–420px 栏宽可读；双实例落座后队友能看到对方立绘（M9.5d 复核）。
5. **稳定性**：玩家断网/刷新 → 自动重连并补发事件；房主踢人 → token 失效；房主重启 DSH → 房间恢复、
   牌桌会话重新打开后可续团；房主「结束房间」= 关房解绑，玩家「退出房间」只离席。
6. **内容包换机（M8.5b 收尾）**：工坊「分享」导出 `.trpgpack` → 拷到另一台机器导入 → 选该包建房并进入第一幕，
   验证打包素材/规则/卡与另一台机器一致。

异常排查：health 不通 → 防火墙/房主插件是否启用并重启过 DSH（Host 监听 0.0.0.0:45871）；加入失败 → 地址（含端口）与邀请码；
AI 不回话 → 牌桌会话是否仍打开（live）、模型是否可用；镜像不可用 → 玩家插件是否重载、是否 Web/桌面宿主、
是否已落座；工具数字与叙事不符 → 记录事件序号与截图反馈；换机包不可用 → 包内 schema 版本/资产 manifest 校验结果。

### 2.2 npm 发布（局域网验收通过后，用户执行）

前置：`npm login` 已登录且账号开启双因素（发布会被要求 OTP）；`npm view dsh-trpg-table` 确认包名未被占用；
工作区干净、版本与 [CHANGELOG.md](../CHANGELOG.md) 已提交。

```bash
cd packages/dsh-trpg-table
npm publish --access public        # 包为 public；发布后该版本号不可覆盖
```

- **不可逆提醒**：npm 同一版本号发布后不能重新发布（只能 `npm deprecate` 或发新 patch）；24 小时内
  `npm unpublish --force` 有条件且会被记录。所以先 `pnpm pack:plugin && pnpm pack:verify` + §2.1 双机验收通过再发。
- 发布后核对：`npm view dsh-trpg-table version dist.tarball`、`tar -tzf` 内容与 [RELEASE.md](./RELEASE.md) §2.1 一致；
  在干净 DSH profile 里从 npm 安装一次并跑 §1 冒烟项；推 `v0.1.0` tag、GitHub Release 附 tgz 与 CHANGELOG 摘要。
- 完整步骤与回滚口径见 [RELEASE.md](./RELEASE.md) §5–§6；发布结果填进 §4 记录表并反馈维护者。

## 3. 已知限制（0.1.0）

1. **玩家镜像只读**：行动转发的本机入口（composer 替换）未实现；玩家行动仍由房主在牌桌会话代录。
   在镜像会话里直接发言不会进房间，且玩家端无模型 key 时原生 prompt 会报错。
2. **AI GM 只绑定 live 会话**：只有 DSH 页面正打开的会话能发模型请求；插件新建/恢复的会话会 transport 失败。
3. 镜像依赖本机插件 host 的同源接口（`/api/dsh-trpg-table/mirror`），需 Web/桌面宿主；插件升级后需重启/重载。
4. 重载后 localStorage 残留旧房 token 会红字提示「无法恢复房间：令牌无效或已失效」（未静默清理）。
5. 页签已打开时再点头部入口会重开页签（短暂空白，不产生重复页签）；≈300px 极窄 + 多页签时页签标题截断。
6. 空态入口占用 root 作用域 single slot `conversation.header.leading`，与其它插件存在占用冲突风险。
7. 局域网明文 HTTP，仅限内网；公网/IM（QQ 等）接入是 v2。Windows 首次监听端口会弹防火墙授权。
8. 内容工坊/地图生成/`pack.*` 写操作仅 **loopback + host token**；玩家不能用工坊；内置包 `core-guimuya` 只读，
   编辑需先「复制为可编辑副本」；图标清单预览依赖 `pack.export` 浏览器内解包（大包首次稍慢），批量生成单次 ≤6。
9. 地图风格枚举收敛（战棋 `topdown-2d`/`pixel-topdown`，世界图 `2d-illustration`）；生成历史/差异视图未实现（见第 14 条）。
10. 资产只收 PNG/SVG（拒 JPEG/WebP 等）；zip 不支持 zip64/加密/分卷（包 ≥4 GiB 直接报错）。
11. 规则包脚本宿主侧执行（`node:vm` 沙箱是隔离不是安全边界）：只装可信内容包，玩家不能上传规则包。
12. 待验证项（均由用户执行）：局域网双机一局实跑、导出 `.trpgpack` 换机器可玩（M8.5b 收尾，并入 §2.1）、
    npm 发布与干净 profile 从 npm 安装复验（§2.2）。本机侧的 M9.5d 双实例立绘互见与 M9.6b 真机验收已完成（2026-11-17）。
13. 工坊编辑器限制（M9.6b）：规则脚本只读——`pack.detail`/`pack.update` 不传脚本字节，改脚本须导出 `.trpgpack` →
    改 zip 内 `rules/scripts/*.js` → 重算 sha256 写回 `rules.scripts` → 导入；世界书保存真机端到端自动化未完全验证
    （链路有单测 + 隔离 host 证据）；地图 `calibration.rotation` 为显示层扩展（schema v1 校验器忽略未知键）；
    生成历史/差异视图未实现。详见 [UI-CONTRACT.md](./UI-CONTRACT.md) §7.3、[RULES-MODEL.md](./RULES-MODEL.md) §15。
14. `pnpm test:gm`（假 Agent GM 冒烟）此前自 M8.4 接口变更后失败，已于 2026-11-17 适配 `resolveContent` 与工具数量，
    现 ALL PASS（commit 3a2e38f）。

## 4. 验收记录表模板

| 字段 | 记录 |
|---|---|
| 日期 / 验收人 | |
| 版本 | `dsh-trpg-table` 0.1.0（tgz 或 npm） |
| 房主机型 / OS / DSH 版本 | |
| 玩家数（含机型/OS） | |
| 模式（AI GM / 真人 GM） | |
| 内容包 / 模组 | `core-guimuya` / 鬼木崖·异光（或自定义） |
| 本文件 §1–§2 结果 | ⬜ 通过 / ⬜ 有问题（附编号） |
| 一局时长 / 事件序号 | |
| 问题清单（复现步骤 + 截图 + `seq`） | |
| 关键截图目录 | |
| 结论（可发布 / 需修复） | |
