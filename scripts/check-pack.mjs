/**
 * 打包前自检：`files` 白名单必须覆盖运行时真正要用的每一类文件。
 *
 * 漏一个目录的后果是「本地全绿、装的人拿到一个没界面的包」—— 这种错在开发机上
 * 永远不会暴露，因为开发时读的是源码目录。
 *
 * 用法：`node scripts/check-pack.mjs`（失败非 0 退出）
 */

import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const files = Array.isArray(pkg.files) ? pkg.files : [];

if (files.length === 0) {
  console.error('package.json 的 files 白名单是空的：会把整个仓库（含 reference/ 与 node_modules）发出去');
  process.exit(1);
}

/** 每一项都必须在磁盘上存在。 */
const missingOnDisk = files.filter((entry) => !existsSync(entry) && !entry.includes('*'));
if (missingOnDisk.length > 0) {
  console.error(`files 里这些项在磁盘上不存在：${missingOnDisk.join(', ')}`);
  process.exit(1);
}

const problems = [];

/** 导出面指向的文件必须被 `files` 覆盖（否则装了也 require 不到）。 */
const exportTargets = [];
const exportsField = pkg.exports ?? {};
for (const [key, value] of Object.entries(exportsField)) {
  if (key === './package.json') continue;
  const target = typeof value === 'string' ? value : value?.default;
  if (typeof target === 'string') exportTargets.push(target);
}

for (const target of exportTargets) {
  const relative = target.replace(/^\.\//u, '');
  const covered = files.some((entry) => {
    const clean = entry.replace(/^\.\//u, '');
    return relative === clean || relative.startsWith(clean.replace(/\/$/u, '') + '/');
  });
  if (!covered) problems.push(`exports 指向 ${target}，但 files 里没有覆盖它的目录`);
}

/** 有浏览器半边就必须同时有 client.js 与 dsh.client 声明。 */
const hasClientExport = exportTargets.some((target) => target.includes('client'));
const declaresClient = pkg.dsh?.client !== undefined;
if (hasClientExport !== declaresClient) {
  problems.push('exports["./client"] 与 package.json 的 dsh.client 必须同时存在或同时缺失');
}

/** bundle 的 patch 文件必须在白名单里。 */
if (pkg.dsh?.bundle?.patch !== undefined) {
  const patch = pkg.dsh.bundle.patch.replace(/^\.\//u, '');
  if (!files.some((entry) => entry.replace(/^\.\//u, '') === patch)) {
    problems.push(`dsh.bundle.patch 指向 ${patch}，但它不在 files 白名单里`);
  }
}

/**
 * `reference/` 是调研取证的第三方源码副本，绝不能进发布包。
 *
 * 它包含其它项目的实现与文档，发出去等于把别人的代码打包进自己的包。
 */
if (files.some((entry) => entry.replace(/^\.\//u, '').startsWith('reference'))) {
  problems.push('files 不能包含 reference/（那是第三方源码副本）');
}

if (problems.length > 0) {
  console.error('files 白名单有问题：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`ok   files ${files.length} 项，覆盖全部 exports 目标`);
