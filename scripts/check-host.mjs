/**
 * 宿主装载自检：这个包能不能被真的 import 进来。
 *
 * 单元测试逐层覆盖，但没有一处证明「构建产物是可加载的模块」。构建产物里少一个
 * 相对 import 的目标、多一个没解析的裸包名，都会在这里暴露，而不是等用户装完
 * 重启之后看到一个起不来的插件。
 *
 * 用法：`node scripts/check-host.mjs`（失败非 0 退出）
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const entry = resolve('lib/index.js');

if (!existsSync(entry)) {
  console.error(`构建产物不存在：${entry}（先跑 pnpm build）`);
  process.exit(1);
}

let module;
try {
  module = await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(`import ${entry} 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const problems = [];

/** 函数式插件必须是命名导出四件套，且**不能**有 default（有 default 会让 Loader 丢 inject）。 */
if (typeof module.name !== 'string' || module.name === '') {
  problems.push('缺少命名导出 name（Cordis 插件入口）');
}
if (typeof module.apply !== 'function') {
  problems.push('缺少命名导出 apply');
}
if (module.Config === undefined) {
  problems.push('缺少命名导出 Config（配置 schema）');
}
if (module.default !== undefined) {
  problems.push('导出里有 default：Loader 的 unwrapExports 会取 default 并静默忽略命名导出的 inject');
}

/** 浏览器半边要能被解析（它是手写脚本，语法错只会在浏览器里炸）。 */
const clientEntry = resolve('lib/client.js');
if (!existsSync(clientEntry)) {
  problems.push(`浏览器半边不存在：${clientEntry}（先跑 scripts/copy-client.mjs）`);
} else {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(clientEntry, 'utf8');
  try {
    // 只用 Function 构造器解析，不执行：目的是语法检查。
    new Function(source);
  } catch (error) {
    problems.push(`lib/client.js 语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!source.includes('__ModuleLoader__')) {
    problems.push('lib/client.js 里没有 __ModuleLoader__：宿主不会把它当插件加载');
  }
}

if (problems.length > 0) {
  console.error('宿主装载自检失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`ok   lib/index.js 导出 name=${module.name}，lib/client.js 可解析`);
