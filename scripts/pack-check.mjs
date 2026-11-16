#!/usr/bin/env node
/**
 * 兼容入口：CONTENT-MODEL §6.1 里记的 CLI 名是 `scripts/pack-check.mjs`。
 * 参数与行为完全等同 `node scripts/content-pack.mjs ...`（实现只有一份）。
 */
await import('./content-pack.mjs');
