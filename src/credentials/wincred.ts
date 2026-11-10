/**
 * Windows 凭据管理器读取层：果办的登录态是分块存放的 UTF-16LE blob，不是一个文件。
 *
 * 枚举靠 `~/.office-claw/users/` 的目录名，而不是 `cmdkey /list` —— 后者不给 blob
 * 大小，也就无从定位分块；目录名本身就是目标名里的 `<domainId>%3A<userId>`。
 *
 * 不变量：先把所有块的文本拼起来、再 base64 解一次。块边界落在 base64 串中间，
 * 逐块解码会把 padding 弄坏，得到的是「长度对、内容是乱码」的 JSON。
 *
 * 非目标：不写、不删、不改任何凭据；读不到就是 `undefined`，任何一步失败都不抛。
 *
 * @module dsh-connect-huaweicloud/credentials/wincred
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { WINCRED_PREFIX, WINCRED_PROVIDER } from '../constants.ts';
import { officeClawUsersDir } from '../paths.ts';

/** 凭据管理器里一条果办账号的定位信息。 */
export interface WinCredTarget {
  /** 凭据管理器里的目标名。 */
  readonly target: string;
  /** `<domainId>%3A<userId>`，即 `users/` 下的目录名；已 URL 编码，不要再解一次。 */
  readonly userDir: string;
}

/**
 * 执行一段固定 PowerShell 脚本，返回 stdout 原文。
 *
 * 注入替身是为了让测试不碰真实凭据管理器：默认实现才真的起 `powershell.exe`。
 */
export type RunPowerShell = (script: string, env: Record<string, string>) => Promise<string>;

/** 读取选项；唯一用途是替换执行器。 */
export interface WinCredReadOptions {
  readonly runPowerShell?: RunPowerShell;
}

/** 默认执行器用它把目标名交给脚本。目标名走环境变量，绝不拼进命令行。 */
export const TARGET_ENV_KEY = 'DSH_OFFICEACE_CRED_TARGET';

/**
 * 固定脚本：按目标名读一条 Generic 凭据，输出原始字节的 base64；不存在输出 MISSING。
 *
 * 不拼接任何外部输入，因此没有注入面；`-EncodedCommand` 让引号/换行/中文路径原样送达。
 */
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DshOfficeAceCred {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
  [StructLayout(LayoutKind.Sequential)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }
  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredReadW(target, 1, 0, out pointer)) { return null; }
    try {
      CREDENTIAL record = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] bytes = new byte[record.CredentialBlobSize];
      if (bytes.Length > 0) { Marshal.Copy(record.CredentialBlob, bytes, 0, bytes.Length); }
      return bytes;
    } finally {
      CredFree(pointer);
    }
  }
}
"@
$target = $env:${TARGET_ENV_KEY}
if ([string]::IsNullOrEmpty($target)) { 'MISSING'; exit }
$bytes = [DshOfficeAceCred]::Read($target)
if ($null -eq $bytes) { 'MISSING' } else { [Convert]::ToBase64String($bytes) }
`;

/** 单次读取的超时；实测约 400 ms，留足冷启动余量。 */
const EXEC_TIMEOUT_MS = 20_000;

/** stdout 上限：一条 provider-state 实测几十 KB，4 MiB 够任何形态。 */
const MAX_EXEC_BUFFER_BYTES = 4 * 1024 * 1024;

/** 分块数上限：坏索引指向天文数字时不能真去读那么多条。 */
const MAX_CHUNK_COUNT = 256;

/** 只接受纯 base64 文本；`Buffer.from(x, 'base64')` 对乱码不抛，只能自己先挡。 */
const BASE64_TEXT = /^[A-Za-z0-9+/=\s]+$/u;

/**
 * 默认执行器：`-EncodedCommand` + `windowsHide`。
 *
 * `windowsHide` 不是可选项 —— 宿主是无控制台的 Electron 进程，少了它每次都闪黑框。
 */
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
 * 枚举本机果办账号。
 *
 * 读不到 `users/` 目录（没装客户端、权限不足）时返回空数组，不抛。
 *
 * @param env - 环境变量（测试注入，`OFFICE_CLAW_HOME` 决定根目录）。
 */
export async function listTargets(env: NodeJS.ProcessEnv = process.env): Promise<WinCredTarget[]> {
  let names: string[];
  try {
    const entries = await readdir(officeClawUsersDir(env), { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  names.sort();
  return names.map((name) => ({
    target: WINCRED_PREFIX + '/' + WINCRED_PROVIDER + '/' + name + '/provider-state',
    userDir: name,
  }));
}

/**
 * 读一条凭据的明文；不存在返回 `undefined`。
 *
 * 分块凭据先拼文本再 base64 解一次。全程只读，不写不改。
 *
 * @param target - 凭据管理器里的目标名（见 `listTargets`）。
 * @param options - 执行器替身（测试用）。
 */
export async function readCredential(
  target: string,
  options: WinCredReadOptions = {},
): Promise<string | undefined> {
  if (target.trim() === '') return undefined;
  // 非 Windows 上不可能有这条凭据；注入替身时仍然照走（测试可以脱离平台）。
  if (options.runPowerShell === undefined && process.platform !== 'win32') return undefined;
  const run = options.runPowerShell ?? defaultRunPowerShell;

  try {
    const indexBytes = await readTargetBytes(target, run);
    if (indexBytes === undefined) return undefined;
    const index = parseChunkedIndex(decodeCredentialText(indexBytes));
    if (index === undefined) return undefined;

    let joined = '';
    for (let chunk = 0; chunk < index.chunkCount; chunk += 1) {
      const bytes = await readTargetBytes(target + '/chunks/' + index.storageId + '/' + chunk, run);
      if (bytes === undefined) return undefined;
      joined += decodeCredentialText(bytes).trim();
    }
    if (!BASE64_TEXT.test(joined)) return undefined;
    return Buffer.from(joined, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

/** 读一条凭据的原始字节；不存在或输出不可解析时 `undefined`。 */
async function readTargetBytes(target: string, run: RunPowerShell): Promise<Buffer | undefined> {
  const text = (await run(POWERSHELL_SCRIPT, { [TARGET_ENV_KEY]: target })).trim();
  if (text === '' || text === 'MISSING') return undefined;
  if (!BASE64_TEXT.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === 0 ? undefined : bytes;
}

/**
 * 把凭据 blob 解成文本。
 *
 * Windows 凭据 blob 一般是 UTF-16LE：偶数长度且每个高位字节为 0。带 BOM 时先剥掉，
 * 否则上面的启发式会把它判成 UTF-8 并给出乱码。两种编码都去掉尾部 NUL。
 */
function decodeCredentialText(bytes: Buffer): string {
  const body = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes;
  if (body.length >= 2 && body.length % 2 === 0) {
    let looksUtf16 = true;
    for (let index = 1; index < body.length; index += 2) {
      if (body[index] !== 0) {
        looksUtf16 = false;
        break;
      }
    }
    if (looksUtf16) return body.toString('utf16le').replace(/\u0000+$/u, '');
  }
  return body.toString('utf8').replace(/\u0000+$/u, '');
}

/** 分块索引：`{"schemaVersion":2,"encoding":"base64","storageId":"…","chunkCount":N}`。 */
interface ChunkedIndex {
  readonly storageId: string;
  readonly chunkCount: number;
}

/**
 * 解析分块索引。
 *
 * 上游随时可能换形态；解析不出来就当「没有凭据」，由调用方给可读文案，而不是抛异常
 * 把整个状态接口带崩。
 */
function parseChunkedIndex(text: string): ChunkedIndex | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const storageId = record['storageId'];
  const chunkCount = record['chunkCount'];
  if (typeof storageId !== 'string' || storageId === '') return undefined;
  if (typeof chunkCount !== 'number' || !Number.isInteger(chunkCount)) return undefined;
  if (chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return undefined;
  return { storageId, chunkCount };
}
