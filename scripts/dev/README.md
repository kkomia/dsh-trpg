# `scripts/dev/`：开发验证脚本（**不进插件产物**）

> M9.5c 交付：本机 ComfyUI → OpenAI 兼容协议的验证用 shim。
> 协议形状的权威约定在 [`packages/assets/src/openai-shim/README.md`](../../packages/assets/src/openai-shim/README.md)；
> 本文只讲**怎么跑、怎么配、怎么验证**。

## 0. 边界（先读）

- **只用于开发联调**：插件生产代码不为本地后端写任何适配分支（DECISIONS #27）。shim 不打包、
  不被 `packages/**` import；`pnpm pack:plugin` 的产物只含 `packages/dsh-trpg-table`（`lib/locale/docs/...`），
  整个仓库根目录的 `scripts/` 都不在其中。
- 零 npm 依赖（只用 `node:http` / `node:fs` / `node:zlib`），Node ≥ 22（本机 DSH 自带 Node 24）。
- 默认只绑 `127.0.0.1`；传非 loopback 地址会直接启动失败（README 契约 §4）。
- 不校验 `Authorization`：工坊里 `apiKey` 随便填 `dev` 即可。
- shim 只做协议翻译：**不做归一化、不做去背/缩放、不落盘**——那些是 `@dsh-trpg/assets` 的职责。

## 1. 快速开始

### 1.1 不连 ComfyUI：`--fake`（推荐先跑这个）

```bash
node scripts/dev/comfyui-openai-shim.mjs --fake
# [shim] listening on http://127.0.0.1:8099（mode=fake）
```

`POST /v1/images/generations` 会按 `seed` 返回**确定性 PNG**（尺寸取请求 `size`），用于在不装模型/
不开 ComfyUI 的机器上验证「工坊生图 → 归一化 → 预览 → 落盘」整条链路与多候选流程。

### 1.2 本机 ComfyUI 出真图

```bash
node scripts/dev/comfyui-openai-shim.mjs \
  --comfyui http://127.0.0.1:8188 \
  --workflow scripts/dev/workflows/my-sdxl-txt2img.json
```

- 不给 `--workflow` 时用内置的 SD1.5 文生图 API 模板占位（节点 id 与 ComfyUI 官方默认图一致，
  checkpoint 默认 `v1-5-pruned-emaonly.safetensors`，可用 `--checkpoint` 覆盖）。
- 工作流必须是 **ComfyUI API 格式**（`node id → { class_type, inputs }`），可在 ComfyUI 里
  「工作流 → 导出（API）」得到。
- 按 `model` 选工作流：`--model-workflow game-2d=./wfl/game2d.json --model-workflow pixel-32=./wfl/pixel.json`
  （工坊里的 `imageModel` 填同名即可；给了映射后未知 model → 400）。

### 1.3 工坊侧配置

| 配置项 | 值 |
|---|---|
| `baseUrl` | `http://127.0.0.1:8099`（不要写 `/v1`，客户端会剥掉再拼） |
| `apiKey` | `dev`（shim 不校验） |
| `imageModel` | `sd-xl`（默认）/ 自定义 `--model-workflow` 的 key |
| 超时 | 客户端 120s；shim 轮询上限默认 100s（`--poll-timeout-ms` 调小更快失败） |

## 2. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/images/generations` | 主路径：OpenAI 生图格式 → ComfyUI `/prompt` → 轮询 `/history` → `/view` 取图 → `{created, data:[{b64_json, seed}]}` |
| POST | `/v1/chat/completions` | 仅 `--fake-svg` 时实现：返回合法 128×128 SVG，用于 M9.5a 的 SVG 净化管线联调；未启用时 404 可读错误 |
| GET | `/health`（别名 `/healthz`） | 探活：`{ok, mode, fakeSvg, comfyui:{ok,url}, defaultModel, models, uptimeSeconds}` |

请求/响应字段、错误码、`b64_json` 约定见
[契约文档](../../packages/assets/src/openai-shim/README.md) §1–§4。shim 侧关键实现：

- `size` 只接受 `1024x1024` / `512x512` / `768x1024`，其它值 400（**不偷偷取整**，避免像素风非整数倍缩放）；
- `n` 1–4：逐张提交，`data` 等长，`data[i].seed = seed + i`（回读写进 manifest 便于复现）；
- `negative_prompt` 优先；没有时从 `prompt` 的 `Avoid：` 段提取；
- `steps` / `cfg_scale` / `sampler` 覆盖工作流里 `KSampler` 的默认值；
- 失败一律 JSON + 中文 `error.message`：`400` 参数非法、`404` 未实现端点、`500` 工作流执行失败、
  `502` ComfyUI 不可达、`504` 轮询超时。

## 3. 工作流填充规则（`shim-core.mjs#fillWorkflowTemplate`）

两种写法可混用，**优先占位符**：

1. **占位符**（自定义模板推荐）：任意字符串里写
   `{{prompt}}` / `{{positive_prompt}}` / `{{negative_prompt}}` / `{{seed}}` /
   `{{width}}` / `{{height}}` / `{{n}}` / `{{steps}}` / `{{cfg_scale}}` /
   `{{sampler}}` / `{{model}}` / `{{checkpoint}}`；
   整串就是占位符时替换成对应类型（如 `"{{seed}}"` → 数字），否则按字符串内插值；
   未提供的可选参数保留原占位不替换（便于模板自带默认值）。
2. **按节点 class_type 覆盖**（内置默认模板走这条）：`CLIPTextEncode` 第 1 个收正向、
   第 2 个收负向，`EmptyLatentImage` 收 `width/height/batch_size=1`，
   `KSampler` 收 `seed/steps/cfg/sampler_name`，`CheckpointLoaderSimple` 的 `ckpt_name`
   只在给了 `--checkpoint` 时覆盖。

## 4. 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--fake` | off | 不连 ComfyUI，返回确定性 PNG |
| `--fake-svg` | off | 启用 `/v1/chat/completions` 返回 fake SVG |
| `--comfyui <url>` | `http://127.0.0.1:8188`（或 `COMFYUI_BASE_URL`） | ComfyUI 地址 |
| `--workflow <file>` | 内置 SD1.5 模板占位 | 默认 API 工作流 JSON |
| `--model-workflow <model>=<file>` | — | model → 工作流映射，可重复 |
| `--checkpoint <name>` | 不改 | 覆盖 `CheckpointLoaderSimple.ckpt_name` |
| `--default-model <name>` | `sd-xl` | 请求缺 `model` 时用 |
| `--host` / `--port` | `127.0.0.1:8099`（或 `SHIM_HOST`/`SHIM_PORT`） | 非 loopback 直接拒绝 |
| `--poll-timeout-ms` / `--poll-interval-ms` | `100000` / `750` | 轮询上限必须 < 客户端 120s |
| `--help` | — | 用法 |

## 5. 验证

```bash
# shim 单测（映射逻辑 + fake PNG/SVG + HTTP 端到端；不占用七包 glob，单独跑）
node --test "scripts/dev/shim-core.test.mjs"

# 手动冒烟
node scripts/dev/comfyui-openai-shim.mjs --fake &
curl -s http://127.0.0.1:8099/health
curl -s -X POST http://127.0.0.1:8099/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"model":"sd-xl","prompt":"像素风图标\nAvoid：文字","size":"512x512","n":1,"seed":7,"response_format":"b64_json"}'

# 确认插件产物不含 shim（tgz 里只应有 packages/dsh-trpg-table 的文件）
pnpm pack:plugin && tar -tf dist/dsh-trpg-table-*.tgz | grep -c 'scripts/dev'   # 期望 0
```

M9.5c 验收：本机 ComfyUI 出图 → 走工坊生图 → 归一化 → 预览落盘；关掉 shim 后客户端给
可读网络错误（不崩不静默失败）；`pnpm pack:plugin` 产物不含 `scripts/dev/`。
