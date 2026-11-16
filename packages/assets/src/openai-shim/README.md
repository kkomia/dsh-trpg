# 开发用 ComfyUI → OpenAI 协议 shim（约定文档）

> 状态：**仅约定，代码在 M9.5c 实现**（`scripts/dev/comfyui-openai-shim.mjs`）。本文只固定协议形状，
> 防止 M9.5a 的 OpenAI 兼容客户端（`packages/assets/src/openai.ts`）与本地联调时各写一套。
> **shim 只用于开发验证，不进插件产物、不被任何生产代码 import。**

## 0. 定位

- 目标：本机 ComfyUI 出图 → 让工坊「AI 生图」按 **OpenAI 兼容协议**直接跑通（归一化/预览/落盘链路不变）。
- 非目标：不在插件代码里为本地后端写适配分支、不内置任何后端、不代理线上第三方 API。
- 运行形态：单文件 Node 脚本（`node:http` + `node:fs`，**零 npm 依赖**），默认只绑 `127.0.0.1`。
- 关闭 shim 后，客户端必须给出可读错误（「网络错误：无法请求模型接口（POST …）」或连接被拒），**不能崩、不能静默失败**。

## 1. 端点（与 `openai.ts` 对齐）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/images/generations` | **必须实现**：生图（文生图），返回 `b64_json` |
| POST | `/v1/chat/completions` | 可选：本地 LLM 出 SVG 文本时用；不实现时返回 404 JSON |
| GET | `/healthz` | 可选：shim 自检（探活/ComfyUI 连通性），不参与 OpenAI 协议 |

客户端固定请求 `{baseUrl}/v1/images/generations`：`baseUrl` 归一化后**不带** `/v1`
（`openai.ts` 会剥掉配置末尾的 `/v1`），shim 侧按完整路径匹配即可。

## 2. `/v1/images/generations` 请求

```json
{
  "model": "sd-xl",
  "prompt": "……（含 Avoid：负向段的完整正向提示词）",
  "size": "1024x1024",
  "n": 1,
  "response_format": "b64_json",
  "seed": 1234,
  "negative_prompt": "文字、水印",
  "steps": 24,
  "cfg_scale": 7,
  "sampler": "euler"
}
```

| 字段 | 约定 |
|---|---|
| `model` | shim 用它选工作流（如 `pixel-32` / `game-2d` / `sd-xl`）；未知值 → 400 可读错误 |
| `prompt` | 正向提示词。客户端默认已把负向以 `Avoid：…` 段拼进来（契约 §2.2） |
| `negative_prompt` | 可选独立负向（客户端 `extra` 透传）。shim **优先用它**填负向 CLIPTextEncode；没有时从 prompt 的 `Avoid：` 段提取 |
| `size` | 只支持下表三档；其它值 → 400 并列出支持档位 |
| `n` | 候选张数（1–4）；逐张生成，返回数组等长 |
| `response_format` | 只接受 `b64_json`（客户端只发这个）；其它值 → 400 |
| `seed` | 有则透传 KSampler `seed`，无则由 shim 随机并回读（客户端写 manifest 复现） |
| `steps/cfg_scale/sampler` | 可选透传；未知字段忽略（不报错） |

### 2.1 尺寸映射（ComfyUI 需 64 对齐，三档均满足）

| OpenAI `size` | ComfyUI 空 latent 宽×高 | 归一化目标（客户端侧） |
|---|---|---|
| `1024x1024` | 1024×1024 | `pixel-32`（32× 整数倍） |
| `512x512` | 512×512 | `icon-128`（4× 整数倍） |
| `768x1024` | 768×1024 | `portrait` / `variant`（768×1024） |

> 头像/封面/地图等其它目标由客户端把请求尺寸就近取上表档位再归一化；shim 不做缩放。
> 不在表内的 `size` 一律 400，**不要偷偷取整**（避免像素风出现非整数倍缩放）。

## 3. `/v1/images/generations` 响应

```json
{
  "created": 1763300000,
  "model": "sd-xl",
  "data": [
    { "b64_json": "iVBORw0KGgoAAAANSUhEUg...", "seed": 1234 }
  ]
}
```

- `data[*].b64_json`：**纯 Base64 字符串**（PNG 字节；不要带 `data:image/png;base64,` 前缀、不要换行）。
- `data[*].seed`：实际使用的种子（数字）。客户端优先回读它写 manifest；缺失时回读请求里的 `seed`。
- **禁止返回 `url` 字段来替代 `b64_json`**：客户端明确拒绝 url-only（防 SSRF，不代抓外链）。
- 未知字段忽略；`created/model` 可选。

## 4. 错误响应

HTTP 非 2xx 一律回 JSON，`message` 为中文可读原因（客户端会把 status 映射成中文提示）：

```json
{ "error": { "message": "ComfyUI 未启动：无法连接 http://127.0.0.1:8188", "type": "upstream_error", "code": "comfyui_unreachable" } }
```

| HTTP | 场景（建议） |
|---|---|
| 400 | 参数非法（未知 model / 不支持的 size / response_format≠b64_json / prompt 为空） |
| 404 | 未实现的端点（例如没实现 chat） |
| 500 | ComfyUI 执行失败（工作流错误） |
| 504 | 轮询超时（客户端自身 120s 超时也会先触发，二者都可能） |

注意：shim 不校验 `Authorization`（本地开发，客户端随便填 `apiKey: "dev"` 即可）；
**shim 绝不能监听 0.0.0.0，也绝不能出现在 `pnpm pack:plugin` 产物里。**

## 5. 工作流与轮询

- shim 侧配置（环境变量，M9.5c 定稿）：
  - `COMFYUI_BASE_URL`：默认 `http://127.0.0.1:8188`
  - `SHIM_HOST` / `SHIM_PORT`：默认 `127.0.0.1:8099`
  - `COMFYUI_WORKFLOW_DIR`：API 格式工作流目录（`model` → 工作流 JSON 的映射表）
- 生成流程：`POST /prompt` 提交 → 轮询 `GET /history/<prompt_id>` → 读 `outputs.*.images[0]` →
  `GET /view?filename=…&subfolder=…&type=output` 取 PNG 字节 → Base64 回包。
- 轮询上限 < 120s（客户端超时 120s），失败要给可读 `error.message`。
- `negative_prompt` → 工作流负向 CLIPTextEncode 节点；`steps/cfg_scale/sampler` 覆盖对应节点默认值。

## 6. 客户端联调配置示例

```ts
const client = createOpenAICompatClient({
  baseUrl: 'http://127.0.0.1:8099', // 不要写 /v1，写了也会被剥离
  apiKey: 'dev',
  imageModel: 'pixel-32',           // shim 用它映射工作流
  timeoutMs: 120_000,
  retries: 1,
});
```

M9.5c 验收：本机 ComfyUI 出图 → 走工坊生图 → 归一化 → 预览落盘；关掉 shim 插件给可读错误；
`pnpm pack:plugin` 产物不含 `scripts/dev/`。
