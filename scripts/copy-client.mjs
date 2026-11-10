/**
 * 把浏览器半边拷成 `lib/client.js`。
 *
 * 为什么不交给打包器：宿主用 `<script>` 加载它，`require('react')` 必须解析到宿主
 * 自己的 React；一旦被打包就会变成第二份 React，hooks 立刻崩。所以这里只做原样拷贝，
 * 并且在拷完立刻跑一次自检。
 *
 * 用法：`node scripts/copy-client.mjs`
 */

import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE = resolve('src/client/bundle.js');
const TARGET = resolve('lib/client.js');

const sourceStat = await stat(SOURCE).catch(() => undefined);
if (sourceStat === undefined) {
  console.error(`浏览器半边不存在：${SOURCE}`);
  process.exit(1);
}

await mkdir(dirname(TARGET), { recursive: true });
await copyFile(SOURCE, TARGET);

const bytes = (await readFile(TARGET)).byteLength;
console.log(`ok   client → lib/client.js (${String(bytes)} bytes)`);
