/**
 * 版本一致性：`package.json` 与 `src/constants.ts` 的 `VERSION` 必须逐字相同。
 *
 * 靠人记必然出错：卡片上显示的版本与包管理器看到的版本不一致时，用户报的 bug
 * 就没法定位到构建。
 *
 * 用法：`node scripts/check-version.mjs`
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const constants = readFileSync('src/constants.ts', 'utf8');
const match = /export const VERSION = '([^']+)'/.exec(constants);

if (match === null) {
  console.error('src/constants.ts 里找不到 VERSION 常量');
  process.exit(1);
}
if (match[1] !== pkg.version) {
  console.error(`版本不一致：package.json=${pkg.version} vs constants.ts=${match[1]}`);
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.error(`版本号必须是三位 semver：${pkg.version}`);
  process.exit(1);
}
console.log(`ok   version ${pkg.version}（package.json 与 constants.ts 一致）`);
