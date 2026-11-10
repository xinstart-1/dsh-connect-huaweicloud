/**
 * 浏览器半边的静态自检。
 *
 * 浏览器半边没有类型检查兜底（它是手写经典脚本，进不了 tsc），所以这里用可执行的
 * 检查替代：语法、无模块语法、i18n 键集一致、`t()` 引用的键都存在、宿主路由逐字一致。
 *
 * 每一项都写成导出纯函数（接收源码字符串），这样 `test/client.test.ts` 能直接测
 * 「好的通过」与「坏的被抓住」——只测前者等于没测。
 *
 * 用法：`node scripts/check-client.mjs`（失败非 0 退出）
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** 检查项：每项返回 `{ ok, problems }`。 */
function verdict(problems) {
  return { ok: problems.length === 0, problems };
}

/**
 * 语法检查：用 `Function` 构造器解析（不执行）。
 *
 * @param {string} source - 浏览器半边源码。
 */
export function checkSyntax(source) {
  try {
    // 只解析不执行：构造器会把源码编译一遍，语法错立刻抛。
    new Function(source);
    return verdict([]);
  } catch (error) {
    return verdict([`语法错误：${error instanceof Error ? error.message : String(error)}`]);
  }
}

/**
 * 模块语法检查：经典脚本里不能有 `import` / `export` 语句。
 *
 * 只匹配行首（允许缩进）的语句，避开字符串与注释里的同名词。
 *
 * @param {string} source - 浏览器半边源码。
 */
export function checkNoModuleSyntax(source) {
  const problems = [];
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*import\s+[\w{*'"]/u.test(line) || /^\s*import\s*\(/u.test(line)) {
      problems.push(`第 ${String(index + 1)} 行有 import：浏览器半边必须是经典脚本`);
    }
    if (/^\s*export\s+[\w{*]/u.test(line)) {
      problems.push(`第 ${String(index + 1)} 行有 export：浏览器半边必须是经典脚本`);
    }
  }
  return verdict(problems);
}

/**
 * 从源码里抽出 `var zh = {...}` / `var en = {...}` 的键集。
 *
 * 用括号配平而不是正则整段匹配：字典里有嵌套对象与中文，正则很容易截断。
 *
 * @param {string} source - 浏览器半边源码。
 * @param {'zh'|'en'} language - 要抽哪一份。
 * @returns {string[]} 顶层键；抽不到时返回空数组。
 */
export function dictionaryKeys(source, language) {
  const marker = new RegExp(`var\\s+${language}\\s*=\\s*\\{`, 'u');
  const match = marker.exec(source);
  if (match === null) return [];

  const start = match.index + match[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return [];

  const body = source.slice(start + 1, end);
  const keys = [];
  // 只取深度 0 的键：`navLabel: '…'` 这种形态。
  let level = 0;
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (level === 0) {
      const keyMatch = /^([A-Za-z_$][\w$]*)\s*:/u.exec(line);
      if (keyMatch !== null) keys.push(keyMatch[1]);
    }
    for (const char of line) {
      if (char === '{' || char === '[') level += 1;
      else if (char === '}' || char === ']') level -= 1;
    }
  }
  return keys;
}

/**
 * i18n 检查：`zh` 与 `en` 必须同键，且 `t('…')` 引用的键都存在。
 *
 * @param {string} source - 浏览器半边源码。
 */
export function checkLocale(source) {
  const zhKeys = dictionaryKeys(source, 'zh');
  const enKeys = dictionaryKeys(source, 'en');
  const problems = [];

  if (zhKeys.length === 0) problems.push('找不到 `var zh = {…}` 字典');
  if (enKeys.length === 0) problems.push('找不到 `var en = {…}` 字典');

  const zhSet = new Set(zhKeys);
  const enSet = new Set(enKeys);
  for (const key of zhSet) {
    if (!enSet.has(key)) problems.push(`en 缺键：${key}`);
  }
  for (const key of enSet) {
    if (!zhSet.has(key)) problems.push(`zh 缺键：${key}`);
  }

  // `t('key')` / `t("key")` 的引用都必须存在；漏一个只会在切换语言时露出原始键名。
  const referenced = new Set();
  const callPattern = /\bt\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*\)/gu;
  let call = callPattern.exec(source);
  while (call !== null) {
    referenced.add(call[1]);
    call = callPattern.exec(source);
  }
  for (const key of referenced) {
    if (!zhSet.has(key)) problems.push(`t('${key}') 引用了不存在的键`);
  }

  return verdict(problems);
}

/**
 * 宿主路由检查：文件里写的路径必须与 `src/constants.ts` 逐字一致。
 *
 * @param {string} source - 浏览器半边源码。
 * @param {string} statusPath - 常量里的状态路由。
 * @param {string} actionPath - 常量里的动作路由。
 */
export function checkRoutes(source, statusPath, actionPath) {
  const problems = [];
  const found = [];
  const pattern = /['"](\/plugins\/[^'"]+)['"]/gu;
  let match = pattern.exec(source);
  while (match !== null) {
    found.push(match[1]);
    match = pattern.exec(source);
  }
  if (found.length === 0) problems.push('文件里找不到任何 /plugins/ 路由');
  for (const path of found) {
    if (path !== statusPath && path !== actionPath) {
      problems.push(`路由 ${path} 与 constants.ts 不一致（应为 ${statusPath} 或 ${actionPath}）`);
    }
  }
  if (!found.includes(statusPath)) problems.push(`缺少状态路由 ${statusPath}`);
  if (!found.includes(actionPath)) problems.push(`缺少动作路由 ${actionPath}`);
  return verdict(problems);
}

/**
 * 颜色检查：样式里不能出现字面色值。
 *
 * 为什么单列这一项：字面色值在开发用的深色主题下看着正常，切到浅色就变成
 * 「浅底浅字」或「深底深字」。这类问题截图不一定暴露（截图只拍了当前主题），
 * 但一定会被用户遇到。全部走 `--dsw-alias-*` token 才能跟主题走。
 *
 * @param {string} source - 浏览器半边源码。
 */
export function checkNoLiteralColors(source) {
  const cssMatch = /var CSS = \[([\s\S]*?)\]\.join\(''\);/u.exec(source);
  if (cssMatch === null) return verdict(['找不到 CSS 数组']);
  let css;
  try {
    css = new Function(`return [${cssMatch[1]}].join('');`)();
  } catch (error) {
    return verdict([`CSS 数组无法求值：${error instanceof Error ? error.message : String(error)}`]);
  }

  const problems = [];
  const patterns = [
    [/#[0-9a-fA-F]{3,8}\b/gu, '十六进制色值'],
    [/\brgba?\([^)]*\)/gu, 'rgb() 色值'],
    [/\bhsla?\([^)]*\)/gu, 'hsl() 色值'],
  ];
  for (const [pattern, label] of patterns) {
    for (const match of css.matchAll(pattern)) {
      problems.push(`CSS 里有${label}：${match[0]}（应改用 --dsw-alias-* token）`);
    }
  }
  return verdict(problems);
}

/** 全部检查项的名字；脚本与测试共用同一份清单。 */
export const CHECKS = ['syntax', 'no-module-syntax', 'locale', 'routes', 'no-literal-colors'];

/**
 * 跑全部检查。
 *
 * @param {string} source - 浏览器半边源码。
 * @param {{statusPath: string, actionPath: string}} routes - 期望的路由。
 * @returns {{ok: boolean, problems: string[]}} 汇总结果。
 */
export function runAllChecks(source, routes) {
  const results = [
    checkSyntax(source),
    checkNoModuleSyntax(source),
    checkLocale(source),
    checkRoutes(source, routes.statusPath, routes.actionPath),
    checkNoLiteralColors(source),
  ];
  const problems = [];
  for (const result of results) problems.push(...result.problems);
  return verdict(problems);
}

/** 从 `src/constants.ts` 里读出两条路由常量。 */
async function readRouteConstants() {
  const constants = await readFile(resolve('src/constants.ts'), 'utf8');
  const status = /export const STATUS_PATH = '([^']+)'/u.exec(constants);
  const action = /export const ACTION_PATH = '([^']+)'/u.exec(constants);
  if (status === null || action === null) throw new Error('src/constants.ts 里找不到 STATUS_PATH / ACTION_PATH');
  return { statusPath: status[1], actionPath: action[1] };
}

/** 直接执行时才跑检查（被测试 import 时不跑）。 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const source = await readFile(resolve('src/client/bundle.js'), 'utf8');
  const routes = await readRouteConstants();
  const result = runAllChecks(source, routes);
  if (result.ok) {
    console.log(`ok   client 自检通过：${CHECKS.join(' / ')}`);
  } else {
    console.error('浏览器半边自检失败：');
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
