/**
 * `@dsh-trpg/assets` —— M9.5a 资产/图标地基库。
 *
 * 纯 TS、零外部依赖（只允许 `node:` 内置模块），host 与客户端跑同一份代码。
 * 六个子模块：
 *
 * | 模块 | 职责 |
 * |---|---|
 * | `png.ts` | 8-bit PNG 解码（灰度/真彩/调色板/RGBA，filter 0–4，CRC 校验，tRNS）与确定性编码 |
 * | `svg.ts` | 极简 XML 解析 + 重建式白名单净化（固定 viewBox/属性序，同输入同字节） |
 * | `normalize.ts` | 目标规格表 + 居中裁剪/等比缩放/留白/去背 + 体积上限，输出 PNG/SVG + sha256 |
 * | `manifest.ts` | `trpg.assets/1` 类型、校验（唯一/路径安全/上限/引用/孤立）、读写与合并 |
 * | `openai.ts` | OpenAI 兼容客户端（chat 出 SVG + images b64_json、超时/重试/中文错误）+ 提示词模板 |
 * | `sha256.ts` | 内容寻址指纹（node:crypto） |
 *
 * 使用约束：不读网络（除 `openai.ts` 里经注入的 fetch）；不读写文件系统；不持有全局状态。
 */

export * from './sha256.ts';
export * from './png.ts';
export * from './svg.ts';
export * from './normalize.ts';
export * from './manifest.ts';
export * from './openai.ts';
