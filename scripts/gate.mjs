/**
 * 一条命令跑完全部校验。
 *
 * 存在的理由：在这个 Windows 终端里手敲多条 `|` / `&` 组合容易被 PowerShell
 * 与 cmd 的引号规则打架，写进脚本就只剩一次调用。
 *
 * 用法：`node scripts/gate.mjs`（任何一项失败即以非 0 退出）
 */

import { spawnSync } from 'node:child_process';

const NODE = process.execPath;

const steps = [
  // 版本号两处必须一致，否则「用户报的 bug 对应哪个构建」无法定位。
  ['check-version', [NODE, 'scripts/check-version.mjs']],
  ['typecheck', [NODE, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']],
  ['build', [NODE, 'node_modules/tsdown/dist/run.mjs']],
  // 浏览器半边没有类型检查兜底：语法 / 无模块语法 / i18n 键 / 宿主路径逐字一致。
  ['copy-client', [NODE, 'scripts/copy-client.mjs']],
  ['check-client', [NODE, 'scripts/check-client.mjs']],
  // 宿主能不能真的 import 这个包、client.js 能不能解析。
  ['check-host', [NODE, 'scripts/check-host.mjs']],
  // files 白名单漏一个目录 = 本地全绿、装的人拿到一个没界面的包。
  ['check-pack', [NODE, 'scripts/check-pack.mjs']],
  ['tests', [NODE, '--experimental-strip-types', '--test', 'test/*.test.ts']],
  // 单测逐层覆盖，但没有一处证明 apply() 真的把它们接起来了。
  ['smoke-apply', [NODE, 'scripts/smoke-apply.mjs']],
];

const failures = [];
for (const [name, command] of steps) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failures.push(name);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (output !== '') console.log(output.split(/\r?\n/u).slice(-25).join('\n'));
  }
}

console.log('');
if (failures.length === 0) {
  console.log(`全部通过：${steps.map(([name]) => name).join(' / ')}`);
} else {
  console.error(`失败项：${failures.join(', ')}`);
  process.exit(1);
}
