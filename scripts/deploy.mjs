/**
 * 把插件部署进 profile，并逐项校验「装进去的确实是刚刚构建的那一份」。
 *
 * 为什么需要这个脚本：部署是三步有序动作 —— 改版本号 → 构建 → 安装。手工做时
 * 很容易把安装插在构建之前，结果是 profile 里出现「client.js 是新版、index.js 还是
 * 旧版」的混搭。这种情况界面上表现为「版式变了但版本号没变」，看起来像 UI 没生效，
 * 实际是部署漏了一步。`pnpm install` 用的是 `file:` 依赖，它会**复制**一份而不是
 * 链接，所以复制之后就与源码脱钩了，必须重新安装才会更新。
 *
 * 用法：`node scripts/deploy.mjs [profile]`，profile 默认是 desktop。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const BUNDLE = 'dsh-connect-huaweicloud';
const root = process.cwd();
const profileName = process.argv[2] ?? 'desktop';
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profileName);
const installedDir = join(profileDir, 'node_modules', BUNDLE);

/** 从 lib/index.js 里取构建时固定的版本常量。 */
function versionOfIndex(built) {
  const found = /VERSION = "([^"]+)"/u.exec(built);
  return found === null ? undefined : found[1];
}

function fail(message, hints = []) {
  console.error(`失败：${message}`);
  for (const hint of hints) console.error(`  - ${hint}`);
  process.exit(1);
}

// ── 前置检查 ────────────────────────────────────────────────────────────────
if (!existsSync(profileDir)) fail(`找不到 profile 目录：${profileDir}`);

const sourceVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

// ── 1. 构建：让 lib/ 与 src/ 对齐 ───────────────────────────────────────────
// 必须在安装之前跑，否则装进去的是上一次的产物。
console.log('1/3 构建（tsdown + 拷浏览器半边）…');
execFileSync(process.execPath, [resolve(root, 'scripts/gate.mjs')], { stdio: 'inherit' });

// 构建后立刻确认产物自洽：构建步骤若静默失败，后面安装的仍是旧文件。
const builtVersion = versionOfIndex(readFileSync(resolve(root, 'lib', 'index.js'), 'utf8'));
if (builtVersion !== sourceVersion) {
  fail(`构建产物版本是 ${String(builtVersion)}，源码是 ${sourceVersion}`, [
    'tsdown 可能没有重新生成 lib/：先删掉 lib/ 再重跑',
    '检查 src/constants.ts 的 VERSION 是否与 package.json 同步',
  ]);
}

// ── 2. 安装：强制重新复制 ──────────────────────────────────────────────────
// 只跑 `pnpm install` 不够：`file:` 依赖的判断依据是版本号与 lockfile，
// 当 package.json 的 version 没变（例如只改了界面），pnpm 会认为依赖未变化而
// **跳过复制**，于是 profile 里留着上一版的 lib/。先删掉旧副本再装，才能保证
// 装进去的就是刚构建的那一份。
console.log(`2/3 安装到 profile「${profileName}」…`);
rmSync(installedDir, { recursive: true, force: true });
execFileSync(process.execPath, [
  join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  '--dir', profileDir,
  'install',
], { stdio: 'inherit' });

// ── 3. 校验：装进去的三样东西必须都等于源码 ─────────────────────────────────
console.log('3/3 校验安装副本…');

const installedPkg = join(installedDir, 'package.json');
if (!existsSync(installedPkg)) fail(`安装后仍找不到 ${installedPkg}`);

const checks = [];
const installedVersion = JSON.parse(readFileSync(installedPkg, 'utf8')).version;
checks.push(['package.json 版本', installedVersion, sourceVersion]);

const builtIndex = readFileSync(join(installedDir, 'lib', 'index.js'), 'utf8');
checks.push(['lib/index.js VERSION', versionOfIndex(builtIndex), sourceVersion]);

// 浏览器半边必须与源码逐字节相同：它是手写脚本，没有任何构建步骤，
// 一旦不同就说明 copy-client 没跑或跑在旧源码上。
const sourceClient = readFileSync(resolve(root, 'src', 'client', 'bundle.js'), 'utf8');
const installedClient = readFileSync(join(installedDir, 'lib', 'client.js'), 'utf8');
checks.push(['lib/client.js 与源码一致', installedClient === sourceClient ? 'identical' : 'differs', 'identical']);

// profile 必须真的会加载这个插件：只在 dependencies 里而没进 bundles 是加载不到的。
const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
checks.push(['已在 profile.bundles 中', bundles.includes(BUNDLE) ? 'yes' : 'no', 'yes']);

let bad = 0;
for (const [name, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}：${String(actual)}${ok ? '' : `（应为 ${String(expected)}）`}`);
}

if (bad > 0) {
  fail(
    `${String(bad)} 项不一致，宿主重启后仍会看到旧界面`,
    [
      '若 lib/client.js differs：检查 scripts/copy-client.mjs 是否在 build 之后运行',
      '若版本不一致：确认已 bump src/constants.ts 与 package.json 后重跑本脚本',
    ],
  );
}

console.log(`\n部署完成：${BUNDLE}@${sourceVersion} → ${profileName}`);
console.log('下一步：完全退出 DSH（含托盘）再启动，设置页才会加载新代码。');
