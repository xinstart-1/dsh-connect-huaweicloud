/**
 * 本机控制面的会话凭据：`session.cookie` 是 DPAPI（CurrentUser）加密的 JSON。
 *
 * 文件两行 —— 标记行 `OC-DPAPI-1` 与 base64 密文。标记不在就是上游换了形态，
 * 此时**不做猜测**：返回 `undefined`，让上层提示「先打开果办」，而不是拿一段
 * 解不开的字节去拼 cookie。
 *
 * 非目标：本模块只解出 `value`，不实现 HTTP 客户端；cookie 名 `oc_sid` 的用法
 * （打哪个端口、带什么头）由上层决定。
 *
 * @module dsh-connect-huaweicloud/credentials/dpapi
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { SESSION_COOKIE_MARKER } from '../constants.ts';
import { sessionCookiePath } from '../paths.ts';

/** 解出的一份本机会话。 */
export interface LocalSession {
  /** cookie 值（形如 `<domainId>%3A<userId>.<sessionId>.<sig>`）。 */
  readonly value: string;
  /** unix 秒。 */
  readonly expiresAtSec: number;
}

/** 执行一段固定 PowerShell 脚本，返回 stdout 原文；注入替身让测试不碰真实 DPAPI。 */
export type RunPowerShell = (script: string, env: Record<string, string>) => Promise<string>;

/** 解密选项；唯一用途是替换执行器。 */
export interface DpapiOptions {
  readonly runPowerShell?: RunPowerShell;
}

/** 密文走环境变量传给脚本，绝不拼进命令行。 */
export const BLOB_ENV_KEY = 'DSH_OFFICEACE_DPAPI_BLOB';

/**
 * 固定脚本：base64 密文进，base64 明文出；缺输入或解不开输出 MISSING。
 *
 * `System.Security` 必须先加载，否则 `ProtectedData` 在 PowerShell 5.1 里不存在。
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$payload = $env:${BLOB_ENV_KEY}
if ([string]::IsNullOrEmpty($payload)) { 'MISSING'; exit }
try {
  $bytes = [Convert]::FromBase64String($payload)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
} catch {
  'MISSING'; exit
}
[Convert]::ToBase64String($plain)
`;

/** 单次解密超时；起一个 PowerShell 冷启动约 200 ms，留足余量。 */
const EXEC_TIMEOUT_MS = 20_000;

/** 明文就是一个小 JSON，几 KB 足够；上限设大只为不吃到默认 1 MiB 的坑。 */
const MAX_EXEC_BUFFER_BYTES = 1024 * 1024;

/** 只接受纯 base64 文本；`Buffer.from(x,'base64')` 对乱码不抛，只能自己先挡。 */
const BASE64_TEXT = /^[A-Za-z0-9+/=\s]+$/u;

/** 默认执行器：`-EncodedCommand` + `windowsHide`（宿主无控制台，否则每次闪黑框）。 */
const defaultRunPowerShell: RunPowerShell = (script, extraEnv) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_EXEC_BUFFER_BYTES,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });

/**
 * 解密一段 DPAPI（CurrentUser 作用域）密文；失败返回 `undefined`。
 *
 * @param blobBase64 - base64 的 DPAPI blob。
 * @param options - 执行器替身（测试用）。
 */
export async function unprotect(blobBase64: string, options: DpapiOptions = {}): Promise<string | undefined> {
  const blob = blobBase64.trim();
  if (blob === '' || !BASE64_TEXT.test(blob)) return undefined;
  if (options.runPowerShell === undefined && process.platform !== 'win32') return undefined;
  const run = options.runPowerShell ?? defaultRunPowerShell;

  let plainBase64: string;
  try {
    plainBase64 = (await run(POWERSHELL_SCRIPT, { [BLOB_ENV_KEY]: blob })).trim();
  } catch {
    return undefined;
  }
  if (plainBase64 === '' || plainBase64 === 'MISSING' || !BASE64_TEXT.test(plainBase64)) return undefined;
  const plain = Buffer.from(plainBase64, 'base64').toString('utf8').replace(/\u0000+$/u, '');
  return plain === '' ? undefined : plain;
}

/**
 * 读并解密 `session.cookie`；文件不存在、标记不符、密文解不开都返回 `undefined`。
 *
 * @param env - 环境变量（测试注入，`OFFICE_CLAW_HOME` 决定根目录）。
 * @param options - 执行器替身（测试用）。
 */
export async function readLocalSession(
  env: NodeJS.ProcessEnv = process.env,
  options: DpapiOptions = {},
): Promise<LocalSession | undefined> {
  let raw: string;
  try {
    raw = await readFile(sessionCookiePath(env), 'utf8');
  } catch {
    return undefined;
  }

  const lines = raw.replace(/^\uFEFF/u, '').split(/\r?\n/u).map((line) => line.trim());
  // 标记必须出现在第一行非空内容上：换成别的编码形态时，解出来的只会是垃圾。
  const marker = lines.find((line) => line !== '');
  if (marker !== SESSION_COOKIE_MARKER) return undefined;
  const blob = lines.slice(lines.indexOf(SESSION_COOKIE_MARKER) + 1).find((line) => line !== '');
  if (blob === undefined) return undefined;

  const plain = await unprotect(blob, options);
  if (plain === undefined) return undefined;
  return parseSessionPayload(plain);
}

/** 明文 JSON = `{"value":"…","expires":<unix 秒>}`；逐字段校验，坏形状返回 `undefined`。 */
function parseSessionPayload(plain: string): LocalSession | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const value = record['value'];
  if (typeof value !== 'string' || value === '') return undefined;
  const expires = record['expires'];
  const expiresAtSec =
    typeof expires === 'number' && Number.isFinite(expires) && expires > 0 ? Math.trunc(expires) : 0;
  return { value, expiresAtSec };
}
