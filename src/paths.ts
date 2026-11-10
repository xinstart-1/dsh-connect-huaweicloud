/**
 * 本插件的落盘位置。
 *
 * 刻意**不**复用上游客户端的目录：只读取它们（登录态、模型清单），所有写入都落在
 * `$DSH_HOME` 下，这样卸载插件、或上游客户端升级换目录，都不会互相破坏。
 * `$DSH_HOME` 的判定顺序与 DSH 保持一致（`DSH_HOME` 优先，其次 `~/.dsh`），
 * 否则同一个账号会被当成两份。
 *
 * @module dsh-connect-huaweicloud/paths
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  OFFICE_CLAW_DIRNAME,
  ROUTING_STATE_SEGMENTS,
  SESSION_COOKIE_FILENAME,
} from './constants.ts';

/**
 * DSH 家目录。
 *
 * @param env - 环境变量（测试注入）。
 * @returns `DSH_HOME` 非空时用它，否则 `~/.dsh`。
 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DSH_HOME'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return join(homedir(), '.dsh');
}

/** 本插件自己的目录（`$DSH_HOME/.huaweicloud-connect`）。 */
export function huaweicloudHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), '.huaweicloud-connect');
}

/**
 * 果办桌面端的用户目录。
 *
 * `OFFICE_CLAW_HOME` 可整体覆盖；默认 `~/.office-claw`（发行版实测值）。
 *
 * @param env - 环境变量（测试注入）。
 */
export function officeClawRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['OFFICE_CLAW_HOME'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return join(homedir(), OFFICE_CLAW_DIRNAME);
}

/** 本机控制面的会话 cookie 文件（DPAPI 加密）。 */
export function sessionCookiePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(officeClawRoot(env), SESSION_COOKIE_FILENAME);
}

/** 桌面端按用户分目录的根（`~/.office-claw/users`）；凭据管理器的目标名由它的目录名拼出。 */
export function officeClawUsersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(officeClawRoot(env), 'users');
}

/**
 * `routing_state` 下按用户分目录的根。
 *
 * 这里放的是 APIG「APP 认证」形态的 `models.json`，与外层 `users/` 的
 * OAuth 形态是两代实现；两种都要看。
 */
export function routingStateUsersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(officeClawRoot(env), ...ROUTING_STATE_SEGMENTS.slice(1));
}
