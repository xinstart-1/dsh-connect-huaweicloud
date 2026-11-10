/**
 * 构建：宿主半侧（TS → ESM）。
 *
 * 浏览器半侧**不进这个构建**：它是一份手写的经典脚本，由
 * `scripts/copy-client.mjs` 在 tsdown 之后原样拷到 `lib/client.js`。
 * 为什么不在 bundler 里做：宿主用 `<script>` 加载它、`require('react')`
 * 解析到宿主自己的 React，一旦被打包就会变成两份 React，hooks 立刻崩。
 */

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  // `dts` 打开后 tsdown 默认会给声明文件加内容 hash（`index-B_YEzRqf.d.ts`），
  // 而 package.json 的 `types` 指向稳定的 `lib/index.d.ts` —— 文件名一变类型就解析不到。
  // `hash: false` 让产物名与 `types`/`exports` 里写的完全一致。
  dts: { sourcemap: false },
  hash: false,
  clean: true,
  outDir: 'lib',
  fixedExtension: false,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/schemastery',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/api/openai-completions.lazy',
    ],
  },
});
