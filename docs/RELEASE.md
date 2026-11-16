# 发布与安装（Release）

> 当前版本 **0.1.0**（2026-11-17 打包验证）。本机验收证据与「局域网双机待办」见
> [ACCEPTANCE.md](./ACCEPTANCE.md)；玩家/GM 操作见 [PLAYER-GUIDE.md](./PLAYER-GUIDE.md)、[GM-GUIDE.md](./GM-GUIDE.md)。

## 1. 版本策略（0.x 语义）

- 0.x 阶段遵循语义化版本的宽松口径：**minor（0.1→0.2）** = 里程碑级能力或行为变更（可能含不兼容改动），
  **patch（0.1.0→0.1.1）** = 修 bug/文档/打包修正，**不保证** 0.x 内配置与数据格式完全向后兼容。
- 数据兼容：`.trpgpack`、房间存档、角色卡均有显式 schema 版本与迁移（`migratePack()`/卡迁移）；
  升级后旧存档按降级/迁移策略处理，但仍建议发布前跑一遍 `docs/ACCEPTANCE.md` 的本机检查。
- 版本唯一来源：`packages/dsh-trpg-table/package.json` 的 `version`；根 `package.json`（private）版本同步但不发布。
  改动版本时必须同步 `CHANGELOG.md`，并由 `scripts/check-pack.mjs` 校验 tgz 文件名/包内版本一致。
- npm 发布标签：0.x 默认发 `latest`；预发布可用 `--tag next`（不要把 `latest` 指向预发布）。

## 2. 构建与打包

环境：DSH 自带运行时（Node 24 + pnpm 11）或任意 Node ≥22 / pnpm 11；`pnpm install` 后执行：

```bash
pnpm build          # esbuild：packages/dsh-trpg-table/lib/host.js、lib/client.js
pnpm pack:plugin    # build + pnpm pack → dist/dsh-trpg-table-0.1.0.tgz
pnpm pack:verify    # node scripts/check-pack.mjs：校验 tgz 内容/版本/许可证/patch
```

`pack:plugin` 通过 DSH 自带 pnpm 打包（脚本自动在 `$DSH_HOME/dsh-runtimes` 找 `pnpm.mjs`；
找不到时设 `DSH_PNPM=<pnpm.mjs 路径>`）。

### 2.1 产物与内容清单（0.1.0 实测）

| 指标 | 值 |
|---|---|
| tgz | `dist/dsh-trpg-table-0.1.0.tgz` |
| 体积 | **462,830 B（约 452 KiB）**；解包 1991 KB；10 个文件 |
| 内容 | `package.json`、`lib/host.js`（1136.0 KB）、`lib/client.js`（842.7 KB）、`locale/zh.json`、`locale/en.json`、`icon.svg`、`cordis.patch.yml`、`README.md`、`docs/DETAIL.md`、`LICENSE` |
| 不含（已断言） | `src/`、`test/`、`scripts/`、`scripts/dev/`（ComfyUI shim）、`node_modules/`、`.tmp/`、`tsconfig.json`、lockfile、嵌套 tgz |

`pnpm pack:verify` 结果：**✓ 内容符合发布要求**（必备条目齐全、无开发产物、版本/许可证/patch 一致）。
`dsh.bundle.patch` 指向 `./cordis.patch.yml`（insert 条目 id/name 均为 `dsh-trpg-table`）；
`dsh.client` 为 `platform: web`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-conversation"]`
（该 client 包存在于 DSH web bundle；插件在真机桌面端已正常运行）。

## 3. 本地 link 安装（当前开发方式）

本机开发/联调用 DSH profile 的 link 依赖 + bundle include，不走 tgz：

```jsonc
// <profile>/package.json（如 ~/.dsh/profiles/desktop/package.json）
{
  "dependencies": { "dsh-trpg-table": "link:D:/gitlab/dsh-trpg/packages/dsh-trpg-table" },
  "dsh": { "profile": { "bundles": ["...", "dsh-trpg-table"] } }   // 即 include 该 bundle
}
```

改完源码后：`pnpm build` → profile 目录 `pnpm install`（刷新 link 产物）→ **重启 DSH**（Host 代码只在启动时加载；
client 侧由 DSH 插件重载/HMR 生效）。等价做法：插件页「添加插件」选本地目录，或让 Agent 用
`plugin_manager install_bundle` 指定 `packages/dsh-trpg-table` 目录。

## 4. tgz 安装（给朋友）

1. 房主与每位玩家安装**同一版本**的 `dsh-trpg-table-0.1.0.tgz`，装完**重启 DSH**。
2. 安装：DSH「插件 → 添加插件」选择该 tgz（或 `dsh plugin add <tgz 绝对路径>`；
   Agent 侧可 `plugin_manager install_bundle` 指向 tgz）。给朋友的只需要 tgz，不需要仓库与构建环境。
3. 启用后确认插件列表出现「跑团桌 · TRPG Table」；插件 Host 加载（DSH 启动/启用插件）后即监听房间端口，
   本机 `http://127.0.0.1:45871/trpg/health` 应返回 `ok:true`；局域网内玩家用 `http://<房主IP>:45871/trpg/health` 验证连通。
4. 升级 = 卸载旧包 → 安装新 tgz → 重启 DSH；房间存档与内容包在 profile-data 下，升级不丢。

## 5. npm 发布（仅在局域网验收通过后执行）

前置：npm 账号已登录（`npm login`）且**开启双因素**（发布会被要求 OTP）；`npm view dsh-trpg-table` 确认包名未被占用；
当前工作区干净、版本/CHANGELOG 已提交并打 tag。

```bash
cd packages/dsh-trpg-table
npm publish --access public        # 包为 public；发布后该版本号不可覆盖
```

- **不可逆提醒**：npm 同一版本号发布后不能重新发布（只能 `npm deprecate` 或发新 patch）；24 小时内可
  `npm unpublish --force`（有限制且会被记录），请先本地 `pnpm pack:verify` + 双机验收通过再发。
- 发布后核对：`npm view dsh-trpg-table version dist.tarball`、`tar -tzf` 内容与 §2.1 一致；
  在干净 DSH profile 里从 npm 安装一次并跑 `docs/ACCEPTANCE.md` 的冒烟项。
- 仓库侧：推 tag（如 `v0.1.0`）、GitHub Release 附 tgz 与 CHANGELOG 摘要；回滚用新版本号修复，不改已发布版本。

## 6. 发布前检查表（0.1.0 实测结果）

| 检查项 | 命令/依据 | 0.1.0 状态 |
|---|---|---|
| typecheck 0 错误 | `pnpm typecheck`（7 个包） | ✅ 通过 |
| 单元测试全绿 | `pnpm test`（node --test，7 个包） | ✅ 1130 passed / 0 failed |
| 房间 E2E 冒烟 | `pnpm test:e2e`（真实 HTTP+SSE 全流程） | ✅ ALL PASS |
| 构建通过 | `pnpm build`（host/client 两产物） | ✅ 通过 |
| pack 内容/体积/版本 | `pnpm pack:plugin && pnpm pack:verify` | ✅ 462,830 B（约 452 KiB）/ 10 文件 / 校验通过 |
| 版本号一致 | 插件 `0.1.0`；tgz 名与包内 version 一致 | ✅ |
| CHANGELOG | `CHANGELOG.md` 有 0.1.0 条目与日期 | ✅ |
| LICENSE | 根 LICENSE + 包内 LICENSE（MIT，内容一致） | ✅ |
| 发布元数据 | repository/homepage/bugs/keywords/license/engines/files | ✅ |
| 文档与实现对齐 | README / DETAIL / RELEASE / ACCEPTANCE | ✅ |
| GM 假 Agent 冒烟 | `pnpm test:gm` | ✅ ALL PASS（脚本已适配 M8.4 `resolveContent` 与工具数量，commit 3a2e38f） |
| 局域网双机实机 | `docs/ACCEPTANCE.md` §2（用户执行） | ⬜ 待执行（发布 npm 的前置） |
| npm 发布 | §5（用户执行） | ⬜ 未执行 |

## 7. 发布后

- 在 README/文档索引记录 npm 包地址与版本；把本次 `dist/*.tgz` 留档（`dist/` 已 gitignore，不作为唯一副本）。
- 下一版起：每改动 `packages/dsh-trpg-table/package.json` 版本即更新 CHANGELOG；打 tag 前重跑 §6 全表。
