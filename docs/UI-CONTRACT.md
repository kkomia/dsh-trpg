# UI 与资产契约 v1：三屏（人物 / 装备 / 背包）+ 三条图标获取路径

> 状态：**已拍板（2026-11-16），M9.5 实现**｜决策来源：[DECISIONS.md](./DECISIONS.md) 第九轮 #27｜关联：[RULES-MODEL.md](./RULES-MODEL.md) §3/§4/§8/§13、[CONTENT-MODEL.md](./CONTENT-MODEL.md) §2（`assets/` 与 zip 上限）、[ROADMAP.md](./ROADMAP.md) M9.5。
> 一句话：跑团桌第一优先级是**三个数据界面**（人物 / 装备 / 背包），**图标是一等公民**（不内置图标库，来自本地导入 / AI 生成 SVG / AI 生图三条路径），落盘前**内部强制标准化**，客户端只渲染 host 投影与 `iconRef`。本文是实现依据（契约，不是提案）；结论冲突回 DECISIONS.md 改，不在这里漂移。

## 0. 摘要与已确认决策

| # | 结论（已拍板，不再讨论） | 含义 | 明确不做 |
|---|---|---|---|
| 1 | **三屏优先** | 界面第一优先级 = 人物、装备、背包三屏 | 不做全屏自绘聊天（沿用 #23 对话原生牌桌） |
| 2 | **必须引入图标机制** | 物品/动作/状态/资源/属性/头像/立绘都能挂图标 | 不把「只有文字的列表」当最终形态 |
| 3 | **不内置图标库** | 插件产物不带任何图标素材，图由三条路径获得 | 不做内置图标集、不随包发行图标集 |
| 4 | **三条获取路径** | ①本地导入（PNG/SVG）②AI 生成 SVG（文本模型出代码→白名单净化）③AI 生图（像素风/2D 游戏风） | 不做图标搜索、不下载在线图库 |
| 5 | **图标图片有兜底** | 无图时渲染**程序化几何徽记**（按 id/标签哈希生成形状+配色） | 不退回纯文字、不用 emoji 顶替 |
| 6 | **纯 JS 自研归一化** | 零原生依赖；**v1 只收 PNG/SVG**，不收 JPEG/WebP | 不引 `sharp`/`jimp`/Canvas 原生库 |
| 7 | **只对 OpenAI 兼容协议** | 文本（出 SVG）与生图各配一套 `baseUrl/key/model`；本地 ComfyUI 不改进插件代码 | 不为本地后端写适配分支，只另写开发用 shim |
| 8 | **玩家资产走 host 或自备接口** | 头像/立绘可走 host 生图服务（host 可开关+限流），也可玩家自备 OpenAI 兼容接口；默认推荐 host | 不强制玩家配 key、不代保管第三方 key |
| 9 | **立绘 768×1024 够用** | 立绘/表情/动作变体统一 768×1024 档 | 不做超大立绘、不做动态立绘 |
| 10 | **预览确认才落盘 + 内部强制限制** | 导入/生成先预览，确认才写盘；尺寸/格式/体积由我们内部拒绝 | 不做「先落盘再清理」、不靠模型自觉 |

三屏都是 host 投影的纯渲染（#26 结论 3），不新增规则计算；装备/背包的**规则语义**（槽位、词条、可用动作、堆叠）来自 [RULES-MODEL.md](./RULES-MODEL.md) 的 `sheet.equipment` / `items[]`，本文只定 UI 与资产契约。

## 1. 资产与图标模型

### 1.1 `iconRef` 语法

| 形态 | 例 | 用在哪 | 说明 |
|---|---|---|---|
| 包资产（正式） | `@pack:assets/icons/item/hengdao.svg` | 物品/动作/状态/资源/属性/槽位/NPC/封面 | 相对当前房间的包根，必须以 `assets/` 开头 |
| 玩家本地卡资产 | `@local:card_aqing:portrait.main` | 头像/立绘/变体/帧表（IndexedDB） | 仅玩家本机可见，落座前不离开本机 |
| 房间展示资产 | `@room:<roomId>/<assetId>` | 落座上传后的展示图 | 同房玩家与 GM 可读，散团随房间清理 |
| 短 id（仅源数据） | `"icon": "status/poison"` | 规则包/内容包源 JSON | 加载时归一化为 `@pack:assets/icons/status/poison.svg` 并存回；**DTO 里永不出现短 id** |

短 id 归一化：先查 manifest 的 `assetId` 别名，再查路径约定 `assets/icons/a/b.<svg|png>`；都查不到 → 校验 warning + 运行时几何徽记。跨包引用 v1 不支持（一房一包），`@pack:` 首段恒为 `assets/`。

### 1.2 资产清单 `assets/manifest.json`（zip 内 `assets/manifest.json`）

```jsonc
{ "schemaVersion": "trpg.assets/1", "packId": "core-guimuya",
  "assets": [{
    "assetId": "icon.item.hengdao",            // <kind>.<scope>.<slug>，包内唯一
    "file": "assets/icons/item/hengdao.svg",   // 必须存在的 zip 条目
    "format": "svg",                           // png | svg
    "size": { "w": 128, "h": 128 },            // SVG 取 viewBox
    "bytes": 4311, "sha256": "9f2c…",          // 归一化后字节的指纹（去重/缓存/校验）
    "kind": "item", "style": "game-2d",        // kind: item|action|status|resource|attribute|slot|avatar|portrait|variant|spritesheet|npc|cover
    "seed": null, "prompt": null,              // AI 生成时记 prompt/seed，本地导入为 null
    "provenance": { "source": "ai-image", "model": "sd-xl", "createdAt": "2026-11-16T18:00:00+08:00" }
  }] }
```

`validatePack()` 增补（M9.5a）：`file` 存在、`format` 与扩展名一致、`bytes`/`sha256`/尺寸/体积符合 §3.1；被引用的 `assetId` 必须在 manifest 中；有 manifest 但无人引用 → 孤立资产 **warning**（沿用 M8.1 口径）。有资产必须有 manifest，无资产可缺；manifest 在 `assets/**` 白名单内，无需改 zip 结构。

### 1.3 挂载点（哪些数据能挂图标）

`items[].icon`；`actions[].icon`；`sheet.statuses[].icon`（沿用现有字段）；`sheet.resources[].icon`；`sheet.attributes[].icon`；`sheet.equipment.slots[].icon`（**空槽底图**）；`ui.itemCategories[].icon` / `ui.rarities[].color`；卡实例 `assets`（§8）；`pack.icon`（封面，CONTENT-MODEL §2.4 已支持）；模组 `npcs[].icon`（可选）。

### 1.4 引用校验与缺失降级

- 加载/导出：引用不存在、格式不符、超尺寸/超体积、sha256 不符 → **错误**；孤立资产、短 id 无对应文件 → **warning**。
- 运行时降级链：`iconRef` 有效 → 真实图 → 404 / 解码失败 / 授权失败 → **几何徽记**（§1.5）+ console warning；不弹窗、不阻塞、不写回数据。
- 投影只下发 `iconRef`（+ 可选 `iconUrl`），客户端不自行拼 URL（§4.2）。

### 1.5 程序化几何徽记（兜底，永不落盘）

`seed = sha256(`${packId}:${kind}:${id}`)`；形状 = `seed[0..3] % 8`（圆/方/菱形/六边/三角/盾/星/环）；色相 = `seed[4..5] % 360`，饱和度/明度固定区间，暗色主题对比度 ≥ 4.5:1。统一 128×128 `viewBox` 内联 SVG（不抖布局），像素风容器内退化为 32×32 四象限图形。同一 `id` 在任何界面形状/配色一致（可当识别锚点）；配好真图自动消失，不进 manifest。

## 2. 三条获取路径

统一管线：**输入 → 归一化 → 预览（临时态，不落盘）→ 用户确认 → 落盘（`assets/` + manifest + `pack.json` 引用）→ `validatePack()` → 投影刷新**。三条路径只差「输入」与「提示词/参数」。预览必须显示原尺寸 + 目标尺寸 + 字节数 + 格式 + 去背结果 + 失败原因，出口只有「重生成 / 换候选 / 手动裁剪 / 取消 / 确认落盘」。

### 2.1 本地导入

- **UI**：工坊（或玩家卡资产区）「导入」→ ①文件选择（`accept=".png,.svg"`）②粘贴（`paste` 读 `clipboardData.files`）③拖入文件（v1 支持拖入**文件**，不做拖拽排序）。
- **数据流**：`File → ArrayBuffer → magic 嗅探 → normalize({kind, style}) → {bytes, meta} → 预览 → assets.commit({kind:'import'}) → 落盘`。
- **拒收**：JPEG/WebP/GIF/BMP 与伪装扩展名（按 magic 判定不按后缀）→ 提示「v1 只支持 PNG/SVG，请另存为标准 PNG 或 SVG」。

### 2.2 AI 生成 SVG

- **UI**：工坊「图标」tab →「AI SVG」子 tab → 变量区（`{{name}}/{{tags}}/{{description}}/{{artDirection}}` 可改）+ 自定义提示词补丁 + 生成（候选 1–4）。
- **数据流**：`POST {baseUrl}/v1/chat/completions` → `choices[0].message.content` → 剥 Markdown 围栏与前后废话 → **白名单净化** → 预览 → 落盘（**保留净化后 SVG**，不转 PNG）。
- **为什么保留 SVG**：128 档矢量更小更清晰、可换色；转 PNG 是无谓的二次有损（位图需求交给 §2.3）。
- **提示词模板**（发送前替换变量）：

```
你是 2D 游戏图标设计师。只输出一个 SVG 文档，不要 Markdown 代码块，不要解释。
主题：{{name}}；标签：{{tags}}；描述：{{description}}；风格：{{artDirection}}
硬约束：viewBox="0 0 128 128"；单一主体居中；2–3 主色 + 1 强调色；闭合路径；不使用 <text>；
不使用外链与 <script>/<foreignObject>/<image>/<filter>；总元素 ≤ 300。
Avoid：文字、水印、边框、照片、3D 渲染、渐变背景、多个主体、模糊。
```

- **负向约束**：以 `Avoid:` 段追加进 prompt；后端若接受独立 `negative_prompt` 字段则原样透传（不重复拼进 prompt）。
- **SVG 白名单净化**（落盘前必过；不合规 → 重新生成 ≤3 次，仍失败退回本地导入）：
  - 允许元素：`svg/g/path/rect/circle/ellipse/line/polyline/polygon/defs/linearGradient/radialGradient/stop/clipPath/title/desc`；
  - 允许属性：`id/class/d/points/x/y/x1/y1/x2/y2/cx/cy/r/rx/ry/width/height/viewBox/transform/fill/stroke/stroke-width/stroke-linecap/stroke-linejoin/fill-rule/opacity/fill-opacity/stroke-opacity/offset/stop-color/stop-opacity/gradientUnits/clip-path`；
  - **拒绝**：`script/foreignObject/image/use/a/animate*/set/style/filter/iframe/object/embed` 元素、`on*` 事件属性、非 `#fragment` 的 `href`/`xlink:href`、`<!DOCTYPE`/`<!ENTITY`、`@import`、`url(http…)`/`url(//…)`/`url(data:…)`；
  - 体量：元素 ≤ 300、单路径点 ≤ 2000、文件 ≤ 64 KiB；根元素强制 `viewBox="0 0 128 128"`，剥离 `width/height`，仅保留 `xmlns="http://www.w3.org/2000/svg"`，属性按固定顺序重建（同输入同字节）；
  - 渲染一律走 `<img src=…>`（host 端点或 data URL），**绝不 inline 注入**（第二道保险，§11）。
- **实现**：host 侧自研 XML 解析器 + 白名单重建（零依赖，与 M8.1 手写 zip 解析同风格）；导出 `.trpgpack` 前再扫一遍。

### 2.3 AI 生图

| 风格预设 | 请求尺寸 | 归一化到 | 提示词要点 |
|---|---|---|---|
| `pixel-32` | 1024×1024 | **32×32 PNG 透明** | 16-bit 像素、硬边、**无抗锯齿**、限色板、单主体居中、无文字/边框 |
| `game-2d`（图标） | 512×512 | **128×128 PNG** | 扁平 2D、粗描边、双色阴影、剪影清晰、纯色背景（便于去背） |
| `game-2d`（立绘） | 768×1024 | **768×1024 PNG** | 半身、扁平描边、纯色背景（可选去背） |

请求尺寸取 1024/512 是为**整数倍**缩小（1024→32 = 32×，512→128 = 4×），像素风才干净。统一请求（OpenAI 兼容 images API）：

```
POST {baseUrl}/v1/images/generations     Authorization: Bearer <apiKey>
{ "model": "<imageModel>", "prompt": "<模板 + Avoid 段>", "size": "1024x1024",
  "n": 1, "response_format": "b64_json", "seed": 1234 }
```

- 只接受 `data[0].b64_json`；后端只回 `url` → 明确报错（**不代抓外链**，避免 SSRF）。`n>1` 仅用于「多候选」预览。
- `baseUrl` 归一化：配置以 `/v1` 结尾自动剥离；chat 拼 `/v1/chat/completions`，生图拼 `/v1/images/generations`。超时 120s，仅网络错误/5xx 重试 1 次。
- 尊重后端扩展：可透传 `negative_prompt/steps/cfg_scale/sampler`；未知返回字段忽略；回读 `seed` 写 manifest 便于复现。
- **透明背景不保证**：API 不承诺透明 → 归一化器做近纯色去背（§3.2）；失败保留背景并在预览提示「背景未去除」，由用户决定换提示词/换色/重生成。

### 2.4 三条路径对照

| | ①本地导入 | ②AI SVG | ③AI 生图 |
|---|---|---|---|
| 输入 | 用户文件/粘贴/拖入 | 文本模型输出的 SVG 文本 | 生图接口 b64 位图 |
| 归一化 | 裁剪/缩放/去背 | 白名单净化（改 viewBox，不缩放） | 裁剪/缩放/去背/转 PNG |
| 落盘格式 | PNG 或 SVG | **净化后 SVG** | PNG |
| 默认 style | `imported` | `game-2d` | `pixel-32` / `game-2d` |
| 失败态 | 拒收 + 可读原因 | 净化解不出 → 重生成 ≤3 | 接口错误/超限 → 重试/降档 |
| 可复现参数 | `sha256` | `prompt + model` | `prompt + seed + model + size` |

## 3. 标准化与归一化管线

### 3.1 硬约束表（内部强制，不靠模型自觉）

| 用途 | kind | 尺寸 | 格式 | 体积上限 | 附加约束 |
|---|---|---|---|---|---|
| 像素图标 | item/action/status/resource | **32×32** | PNG（透明） | **16 KiB** | 整数倍最近邻、无抗锯齿、限色板 |
| 图标 | 同上 | SVG `viewBox 0 0 128 128` 或 PNG 128×128 | SVG / PNG | **64 KiB** | 居中，留白 ≥ 8% |
| 头像 | avatar | **256×256** | PNG | **128 KiB** | 方图，可去背 |
| 立绘 | portrait | **768×1024** | PNG | **512 KiB** | 3:4 |
| 表情/动作变体 | variant | **768×1024** | PNG | **512 KiB** | 同立绘，最多 5 个 |
| 帧表 | spritesheet | 每格 **128×128**（4×4 → 512×512） | PNG | **2 MiB** | 行列整数、格内无 padding |
| 封面 | cover | ≤1024×576 | PNG | 512 KiB | 可选 |
| 单包资产 | — | — | — | **≤512 个 / 总量 ≤64 MiB** | 见下方待办 |
| 落座单卡上传 | — | — | — | **≤8 个文件 / ≤8 MiB** | 只传展示用资产（§4.5） |

超限行为：**拒绝落盘**，预览显示「当前 X KB / 上限 Y KB」+ 三个出口（重新生成并降档 / 手动裁剪 / 取消）。

**待办（M8.1 常量调整，M9.5a 前置）**：`ZIP_LIMITS.maxArchiveBytes` 16 → **64 MiB**、`maxTotalUncompressedBytes` 32 → **64 MiB**、`maxEntries` 512 → **520**（`pack.json` + 规则脚本 + 512 资产）；`maxEntryBytes` 保持 **8 MiB**、`maxPackJsonBytes` 保持 4 MiB。落地时同步改 [CONTENT-MODEL.md](./CONTENT-MODEL.md) §2.2/§9 的上限数字。

### 3.2 归一化器职责（新包 `@dsh-trpg/assets`，纯 TS、零原生依赖）

- **解码**：PNG（用 Node 内置 `node:zlib` 的 `inflateRawSync` 解压 + 自研 PNG 过滤器/CRC 校验，与 M8.1 zip 同口径、零外部依赖）/ SVG（自研 XML 解析 + §2.2 白名单）；不实现 JPEG/WebP。
- **几何**：`contain`（等比缩放 + 留白）与 `cover`（等比缩放 + 居中裁剪）；图标默认 `contain`，头像/立绘默认 `cover`。
- **缩放**：`pixel-32` **只允许整数倍最近邻**（1024→32 = 32×、512→128 = 4×），downscale 用面积平均（box）；**禁双线性/禁模糊**（像素风糊边视为失败，重生成）。
- **去背（可选，默认开）**：四角取样颜色一致（ΔRGB ≤ 8）且占比 > 90% → 从边框 4 连通 flood fill 置 `alpha=0`；**内部同色像素不动**（避免把物体挖空）；失败保留原背景并在预览提示。
- **输出确定性**：PNG 固定「8-bit RGBA + 非交错 + 单 IDAT + 每行 filter=None + 固定 chunk 集」，SVG 输出白名单重建后的规范属性序 → **同输入同字节同 sha256**（缓存与去重才有意义）。
- **边界**：归一化器不做调色/描边/超分/风格迁移（那是生图模型的事），也不做用户手绘。

### 3.3 PNG 编解码支持范围（纯 JS 的明确边界）

| 项 | v1 支持 | 拒绝（给可读原因） |
|---|---|---|
| 位深 | 8-bit | 16-bit →「请导出 8-bit PNG」 |
| 色彩类型 | 0 灰度 / 2 真彩 / 3 调色板 / 4 灰+alpha / 6 RGBA | 非法类型 |
| 交错 | 非交错 | Adam7 交错 →「请另存为非交错 PNG」 |
| 透明 | 直接 alpha / 调色板 tRNS / 单色 tRNS | — |
| 多 IDAT | 支持拼接 | — |
| 其它 | sRGB/gAMA 忽略 | APNG（`acTL`）、CRC 损坏 → 明确报错 |

编码只写上述标准子集（不接受非标准扩展）。

**元数据与可复现**：manifest 记录 `prompt/seed/model/style/size/sha256`（§1.2）；「重新生成」默认复用上次 prompt+seed，只有改 style 才换模板；manifest 同时是生成历史的第一现场（§7.1）。

## 4. 资产交付与存储

**4.1 host 只读资产端点。** `GET /trpg/assets/<packId>/<assetPath>`，`<assetPath>` 为去掉 `assets/` 前缀的相对路径（如 `icons/item/hengdao.svg`）：响应 200 + `Content-Type: image/png | image/svg+xml` + `ETag: "<sha256 前 16>"` + `Cache-Control: public, max-age=31536000, immutable`；不存在 404、路径非法/越权 403；**只读，无写接口**。`GET /trpg/room-assets/<roomId>/<assetId>?token=…` 给落座上传的展示资产（按房间生命周期存活、进快照、散团清理、同房可读）。immutable 与内容寻址：host 下发的 `iconUrl` 自带 `?h=<sha256 前 8>`，客户端缓存 key 用 `sha256`，换图即换 URL、永不强刷。

**4.2 DTO 只给 `iconRef`。** 主字段是 `iconRef`（稳定、内容寻址），`iconUrl` 只是 host 生成的便利字段（可忽略）；客户端不自行拼端点（除本地兜底）。

**4.3 客户端缓存与降级。** 三级：内存 LRU（≤200 张 / ≤32 MiB）→ IndexedDB（库 `dsh-trpg-assets`，key=`sha256`）→ HTTP（immutable）。解码失败/404 → 几何徽记 + console warning；不阻塞、不弹窗，下次进界面重试一次。

**4.4 玩家私卡资产（本地）。** 存 **IndexedDB**（库 `dsh-trpg-assets`，store `cardAssets`，key=`<cardId>:<assetId>`），**不进 localStorage**（二进制 + 配额）。本地卡导出 JSON 先只带 manifest + sha256 清单，二进制随卡导出排 M9.6（与工坊导出同一条路）。

**4.5 落座上传（只传展示用）。** 白名单 `avatar/portrait/portraitVariants/spriteSheet`；**私密字段（`notes`、私密备注、GM 秘密引用）永不上传**。按 `sha256` 去重（同房已有同内容只登记引用、不重复传输）；限额单卡 ≤8 个文件 / ≤8 MiB，超限拒绝落座并提示「删掉不用的表情或换更小的图」。立绘/表情进房间资产区、队友可见；头像在玩家席/队伍面板显示。上传失败不阻断落座（先入座、立绘显示几何徽记 + 重试入口）。

## 5. 三个界面的布局契约

前提：三屏都吃 [RULES-MODEL.md §8](./RULES-MODEL.md) 的投影（`SheetView` / `EquipmentView` / `InventoryView`）；**客户端不算规则**，所有数值与「计算过程 trace」由 host 算好下发。位置：右栏「跑团桌」tab 内新增「人物 / 装备 / 背包」三个**紧凑版**子页签（320–420px 单列，与现有卡片并列）；主区域工具页（M9.6）为**详细版**（双列）；同组件两档密度。

### 5.1 人物界面

```
┌ 人物 ────────────────────────┐
│ [立绘3:4] 阿青 山民·武者 Lv.1 │
│           背景 / 公开摘要…   │
│ ♥生命 22/22 ▓▓▓▓▓ ✦真气 3/3 │
│ 属性栅格（图标+值+调整值→点看trace）│
│ ⚔力量17+3 🏃敏捷14+2        │
│ 🛡体质15+2 📖智力10+0 …     │
│ 技能/豁免：★熟练 + [检定]    │
│ 状态区 [☠中毒×2 剩2轮]      │
│ 外貌/性格/成长记录（XP/历史） │
└──────────────────────────────┘
```

- 头像/立绘：有 `portrait` 用立绘，否则 `avatar`，都没有 → 几何徽记；变体按场景切换（§8）。
- 资源条：`resources[]` 全量渲染，图标缺失用徽记；数值只来自投影，**不做本地预测**。
- 属性栅格：每格 = 图标 + 主值 + `derived.mod`；点击展开 `trace`（公式 + 组成部分），trace 缺失时只显示「由 host 计算」，客户端不自行推导。
- 技能/豁免：熟练 ★ 图标 + 总加值；`[检定]` = 请求 host 掷骰（提交意图，不本地掷）。
- 状态区：图标 + 名称 + 层数/剩余轮；空态显示「无状态」占位（不隐藏区块，避免布局跳动）。
- 详细版（主区域）额外常显属性 trace、技能全表、装备词条来源、成长时间线。

### 5.2 装备界面

```
┌ 装备 ────────────────────────┐
│ 槽位栅格（sheet.equipment.slots[]）│
│ ┌────┐┌────┐┌──────┐         │
│ │主手││身上││随身1/3│        │
│ │横刀││短打││[ 空 ] │        │
│ └────┘└────┘└──────┘         │
│ [大图标] 横刀 ★★ 稀有度边框   │
│  攻击+2 · 锋利 · 家用        │
│ 词条总览：攻击+2 防御+4 先攻+1│
│ 来源分解：▲横刀+2 ▲短打+4    │
└──────────────────────────────┘
```

- 槽位栅格完全由 `slots[]` 生成（世界自定义部位/件数），空槽画 `slots[].icon` 底图（无图 → 徽记），**不写死部位**。
- 点槽 → 选择器：只列 `accepts` 匹配的物品（`*` 通配），不匹配的灰显 + 原因。
- **对比预览**：选择后先调 `previewEquip`，host 返回增量（`before/after/delta`）+ 词条 trace + warning，确认才 `equip`；预览不落状态，取消即丢弃。
- 物品卡：大图标 + 稀有度颜色边框（`ui.rarities[].color`）+ 词条行（每行带词条图标）+ 描述。
- 词条总览与来源分解：`statTotals` + `trace.parts`（哪件装备贡献多少、叠加是 add/max/min/unique）。

### 5.3 背包界面

```
┌ 背包 ────────────────────────┐
│ [全部][武器][消耗] 🔍搜索 ↕排序│
│ 容量 18/24 ▓▓▓▓▓▓▓▓▓░░       │  ← 规则定义了才显示
│ ┌ 网格 ─────┐ ┌ 详情 ──────┐ │
│ │[🗡]¹ [🧪]³ │ │ 金创药 消耗  │ │
│ │[🪵]⁵ [?]   │ │ 恢复 1d8 生命│ │
│ └───────────┘ │[装备][使用] │ │
│               │[拆分][丢弃] │ │
│               └─────────────┘ │
└──────────────────────────────┘
```

- 分类由物品 `tags` 生成（映射在 `ui.itemCategories[]`），含「全部」；搜索按名字/标签/描述；排序按名字/稀有度/获得时间。
- 网格：图标 + 右下数量角标（`qty>1` 才显示）；无图 → 徽记；**v1 点击操作**（选中后用按钮），拖拽排 v2。
- 详情动作：装备（走 §5.2 预览确认）/ 使用（`useItem`，host 结算）/ 拆分（`splitStack`）/ 丢弃（二次确认）。
- 容量条：仅当规则定义了 `capacity` 才显示，未定义时整块隐藏（不显示假上限）。掉落/奖励新物品进包给一次性高亮（纯视觉，不写状态）。

## 6. 投影 DTO 与命令

```ts
// packages/protocol/src/index.ts（M9.5 新增/扩展；示意，字段以实现为准）
export type IconRef = string; // `@pack:assets/...` | `@local:<assetId>` | `@room:<roomId>/<assetId>`
export interface AssetRef { assetId: string; iconRef: IconRef; format: 'png'|'svg'; size: { w: number; h: number }; bytes: number; sha256: string; iconUrl?: string }
export interface TraceView { key: string; label: string; formula?: string; value: number|string; parts: Array<{ label: string; value: number|string; source?: string }> }
export interface ItemCardView { instanceId?: string; itemId: string; name: string; icon?: IconRef; rarity?: string; rarityColor?: string; tags: string[]; stats?: Array<{ statId: string; name: string; value: number; icon?: IconRef }>; description?: string; stack?: number; equippedSlotId?: string; actions?: Array<{ kind: 'equip'|'use'|'split'|'drop'; available: boolean; reason?: string }> }
export interface EquipmentView { slots: Array<{ slotId: string; name: string; accepts: string[]; count: number; icon?: IconRef; items: ItemCardView[] }>; statTotals: Array<{ statId: string; name: string; total: number; icon?: IconRef }>; trace: Array<{ statId: string; total: number; parts: Array<{ sourceId: string; sourceName: string; value: number; stack: string }> }> }
export interface InventoryView { capacity?: { used: number; max: number; unit?: string }; categories: Array<{ id: string; name: string; icon?: IconRef; count: number }>; items: Array<ItemCardView & { qty: number }> }
export interface SheetView {
  cardId: string; rulesId: string; rulesVersion: string;
  identity: { name: string; race?: string; class?: string; level: number; tags?: string[] };
  media: { avatar?: AssetRef; portrait?: AssetRef; variants?: Record<string, AssetRef>; spriteSheet?: { rows: number; cols: number; frameSize: number; frames: Array<{ name: string; index: number; assetRef: AssetRef }> } };
  resources: Array<{ id: string; name: string; current: number; max: number; icon?: IconRef; traceId?: string }>;
  attributes: Array<{ id: string; name: string; value: number; mod?: number; icon?: IconRef; traceId?: string }>;
  derived: Record<string, number|string>; equipment: EquipmentView; inventory: InventoryView;
  skills: Array<{ id: string; name: string; attribute?: string; total: number; proficient: boolean; icon?: IconRef }>;
  saves: Array<{ attr: string; name: string; total: number; proficient: boolean; icon?: IconRef }>;
  statuses: Array<{ id: string; name: string; stacks?: number; remaining?: number; icon?: IconRef }>;
  profile: { background?: string; appearance?: string; personality?: string; summary?: string };
  progression?: { xp: number; level: number; history: Array<{ at: string; text: string }> };
  traces: TraceView[] }                    // 属性/资源/词条的计算过程（点击展开）
export interface EquipPreview { slotId: string; adds: ItemCardView; removes?: ItemCardView; deltas: Array<{ statId: string; name: string; before: number; after: number; delta: number }>; warnings: string[]; trace: EquipmentView['trace'] }
```

| 命令（RPC） | 参数 | 返回/回推 | 说明 |
|---|---|---|---|
| `previewEquip` | `{slotId, instanceId?}` | `EquipPreview` | 纯预览，不落状态 |
| `equip` | `{slotId, instanceId}` | 回推 `sheet`/`equipment`/`inventory` | host 校验 `accepts`/件数/行动经济后重算 |
| `unequip` | `{slotId, instanceId}` | 同上 | 卸下 → 词条聚合重算 |
| `useItem` | `{instanceId, targetId?}` | 回推投影 + `dice`/`effect` 事件 | 效果走规则钩子，客户端只发意图 |
| `splitStack` | `{instanceId, count}` | 回推 `inventory` | 生成新实例，上限/堆叠由 host 判 |
| `assets.*`（**作者侧工坊，仅 host**） | `import`/`generateSvg`/`generateImage`/`commit`/`discard`/`list`/`remove`/`batchGenerate` | 预览或落盘结果 | 走 `{data: base64}`（单图 ≤512 KiB，loopback + host token），**不开放给玩家** |

**规则类变更一律 host 算后回推**（`previewEquip` 也只是 host 算的只读结果）；客户端零规则计算、零本地预测，`available=false` 置灰并显示 `reason`。事件沿用 SSE（`seq` + `lastSeq` 补发），新增 `assets` 事件（包内资产变更，客户端失效对应缓存）。

## 7. 工坊里的图标工作台（M9.5b）与玩家侧入口

### 7.1 三 tab（主区域工坊页新增「图标」tab）

```
┌ 图标工作台 ──────────────────────────────────┐
│ 包: core-guimuya  [导入][AI SVG][AI 生图] [批量]│
├ 资产列表 ─────┬ 预览画布 ───────┬ 参数面板 ──┤
│ 全部/物品/状态│ 原图 ⇄ 目标尺寸  │ 模板变量    │
│ 搜索…         │ 透明棋盘格       │ 自定义提示词│
│ ▸未配图标(12) │ [候选1][2][3]    │ 风格/尺寸档 │
│ ▸物品 24      │ 128²·4.3KB      │ seed/候选数 │
│ ▸状态 8       │ [确认落盘][丢弃] │[生成/重生成]│
└───────────────┴──────────────────┴─────────────┘
```

- **生成**：候选 1–4（`n` 参数或逐次请求），预览里挑一个其余丢弃。**批量**：选中整库 → 队列并发 2 → 网格预览页逐条确认/替换；失败条目进「待重试」列表（可单条重试）。
- **命名/归类**：`assetId` 自动 `<kind>.<scope>.<slug>`（冲突加 `-2`）；`kind` 必填；**替换** = 同 `assetId` 换 sha256（引用不断、界面自动刷新）。
- **落盘一致性**：每次落盘写 `assets/manifest.json` + `pack.json` 引用 + 跑 `validatePack()`；失败回滚（临时文件 + 原子 rename，沿用 M8.1 安装写法）。
- **生成历史**：manifest 视图（时间倒序，含来源/模型/prompt/seed/尺寸/状态），可「用这条 prompt 重生成」「复制 JSON」「查看差异」。

### 7.2 玩家侧生成入口（本地卡）

右栏「跑团桌」tab → 我的卡 → 头像/立绘/表情/动作：流程同工坊，但资产落**本地 IndexedDB**（§4.4），不写 host 包。host 生图服务可用（开关打开）时默认走 host（一次点击、低配额）；不可用时引导「配置我自己的 OpenAI 兼容接口」并提供**测试连接**。玩家自备接口时由**玩家本机 host 侧**代发请求（key 存本机 profile-data，不进房间、不共享、不经过 LAN 房间服务）。

## 8. 玩家角色资产与变体

### 8.1 卡上的 `assets` 形状（`trpg.card/1` 扩展，全部可选）

```jsonc
"assets": {
  "avatar": "card_aqing:avatar.main",                  // 256×256
  "portrait": "card_aqing:portrait.main",              // 768×1024
  "portraitVariants": {                                // 最多 5 个
    "idle": "card_aqing:portrait.idle", "smile": "card_aqing:portrait.smile", "sad": "card_aqing:portrait.sad",
    "angry": "card_aqing:portrait.angry", "attack": "card_aqing:portrait.attack" },
  "spriteSheet": { "assetId": "card_aqing:sheet.walk", "rows": 4, "cols": 4, "frameSize": 128,   // 每格 128²，整表 512²
    "frames": [{ "name": "walk.down.0", "index": 0 }, { "name": "walk.down.1", "index": 1 }] }
}
```

值 = `@local:<assetId>`（本地卡）或 `@room:<roomId>/<assetId>`（落座后）；host 投影换成可读 `AssetRef`。变体名建议固定集 `idle/smile/sad/angry/attack`，未配的按 `portrait` 回退，界面按状态/动作切静态帧。帧表 `index = row*cols + col`，命名 `动作.方向.序号`；**切分在归一化阶段一次完成**并写 manifest（运行时不切）；缺格留空、越界 index 丢弃 + warning。

### 8.2 生成流程与尺寸强制

- 两种模式：①**一组一次**（一次请求画 4–5 个表情的九宫格 → 归一化按网格切分；便宜、风格一致，但可能对不齐）②**逐张**（一张一次，可控但贵）。默认 ①，检测到对不齐/缺头自动回退 ②。
- 强制尺寸：变体一律 768×1024（≤512 KiB），帧表每格 128×128（整表 ≤2 MiB）；超限自动降档重生成或要求手动裁剪，**不接受模型返回的任意尺寸**。生成后必须预览确认（§2 统一管线），确认前只在内存态。

## 9. 进度与本版不做

| v1 明确不做 | 原因 / 替代 |
|---|---|
| 内置图标库 | 三条路径 + 几何徽记兜底（决策 #3） |
| WebP/JPEG 导入 | 只收 PNG/SVG（决策 #6），提示用户转存 |
| 拖拽操作（装备槽/背包排序） | v1 点击选择，拖拽排 v2 |
| 玩家上传 pack / 图标包 | host 装包 = 受信代码（RULES-MODEL §10），v2 才开 |
| 自动去背失败重试 | 失败保留背景 + 提示，人工决定 |
| 动画播放（精灵动画循环） | 只做静态帧切换/表情切换 |
| 图标编辑器（画布绘图） | 用外部工具或 AI 生成，不自研绘图 |
| 在线图标搜索/图库下载 | 版权与信任面不可控 |

## 10. 分阶段落地（M9.5 内）

| 阶段 | 目标 | 交付 | 验收标准 |
|---|---|---|---|
| **M9.5a** 地基 | 归一化器 + OpenAI 兼容客户端 + manifest/端点 + DTO | `@dsh-trpg/assets`（纯 TS PNG/SVG 归一化、SVG 白名单净化、sha256/去背/缩放）；OpenAI 兼容 client（chat + images）；`trpg.assets/1` schema 与 `validatePack()` 资产校验；`GET /trpg/assets/<packId>/<assetPath>`；`AssetRef/IconRef/TraceView/EquipPreview` DTO | 归一化单测：尺寸/体积/去背/确定性 sha256/拒 16-bit·交错·JPEG·WebP；SVG 净化用例（script/foreignObject/外链/事件属性/实体各 1 全拒，合法图标通过且字节可复现）；mock OpenAI 跑通 chat + images（b64_json）；端点 404/403/ETag/immutable 断言；typecheck 0、**不新增运行时依赖** |
| **M9.5b** 工坊图标工作台 | 三 tab + 预览 + 批量 + 历史 + 原子落盘 | 工坊「图标」tab；预览画布/多候选/重生成/手动裁剪；批量给整库生成 + 待重试列表；manifest 历史与替换；落盘前后 `validatePack()` | 不改源码给内置物品库批量生成图标并确认落盘；导出 `.trpgpack` 后另一台机器图标正常显示；坏 SVG/超限资产被拒且原因可读；孤立资产只 warning |
| **M9.5c** 开发用 shim（仅验证） | ComfyUI → OpenAI 协议（`scripts/dev/`，**不打包**） | `scripts/dev/comfyui-openai-shim.mjs`：`/v1/images/generations`（+ 可选 `/v1/chat/completions`）兼容层，b64 返回、seed 映射、轮询与超时 | 本机 ComfyUI 出图 → 走工坊生图 → 归一化 → 预览落盘；关掉 shim 插件给可读错误（**无 shim 依赖**）；`pnpm pack:plugin` 产物不含 shim |
| **M9.5d** 玩家资产与落座上传 | 头像/立绘/变体/帧表 + 上传展示资产（三屏接真图） | 玩家侧生成入口（host 服务或自备接口）；IndexedDB 私卡资产；`room.seat` 扩展 `assets[]`；`GET /trpg/room-assets/…`；三屏渲染 `media` 与图标 | 双实例：玩家本地生成立绘 → 落座 → 队友端看到立绘；断线重连不重复上传（sha256 去重）；超 8 文件/8 MiB 被拒；抓包断言私密字段未上传 |

**编号与依赖**：M9 内新增 **M9.5 资产与图标管线**（本节 a–d），原「M9.5 规则编辑器」顺延为 **M9.6**（工坊页壳与规则 tab 在 M9.6，图标工作台 tab 在 M9.5b 先落）；三屏骨架随 M9.4 的投影先落地（无真图时用几何徽记），M9.5d 才接真图；装备/背包命令（§6）依赖 M9.1/M9.2 的规则执行器，**不在客户端算任何数值**。

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| OpenAI 图像接口不保证透明背景 | 归一化器近纯色去背（§3.2）；失败保留背景并在预览明确提示；提示词引导纯色背景；对外**不承诺透明** |
| 模型出图不稳定（构图/风格漂移） | 预览确认才落盘 + 多候选 + 重试上限 3 + 记录 seed 便于复现 + 批量失败进待重试列表 |
| 纯 JS PNG 编解码边界 | 明确支持矩阵（§3.3）；拒 16-bit/交错/APNG/坏 CRC 并给可读原因；编码只写标准子集；不做渐进式 |
| 资产总量与 LAN 带宽 | 单包 ≤64 MiB、单图体积上限（§3.1）、端点 immutable + ETag、客户端 LRU + IndexedDB、落座只传展示图 ≤8 MiB；必要时再加「按屏懒加载」 |
| SVG 净化被绕过 | 自研白名单**重建**（不保留原字符串）+ 客户端一律 `<img>` 渲染（不 inline）+ 导出前二次扫描 + 不信任 `use/href` |
| host 生图服务被玩家滥用 | **默认关闭**、房主显式开启、按玩家限流（建议 10 张/时、100 张/天，可配）、超限 429 + 中文提示；玩家自备接口则自担费用 |
| 归一化跨端不一致 | 纯 JS 无 Canvas，host 与客户端跑同一份代码；输出字节确定（同输入同 sha256），以此做缓存与去重 |
| manifest 与 `pack.json` 引用漂移 | 落盘即 `validatePack()`；引用缺失报错、孤立资产 warning；导出前再校验一次 |
| zip 上限与资产上限冲突 | M8.1 常量待办（§3.1）：整包 16→64 MiB、解压总量 32→64 MiB、条目数 512→520，单条仍 8 MiB |
