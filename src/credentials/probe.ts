/**
 * 桌面端探测：只读取本机果办客户端已经持有的凭据，供「自动读账号」使用。
 *
 * 果办有两代凭据入口，形态完全不同，**两个都要试**，因为同一台机器可能只有其一：
 *   1. `wincred` —— Windows 凭据管理器里分块存放的 provider-state（OAuth 形态）。
 *   2. `models-json` —— `routing_state/users/<userId>/models.json` 的 APIG APP 认证
 *      形态，`Authorization: Basic base64(appKey:appSecret)` 是**已经算好**的明文。
 *
 * `reason` 是给界面看的闭集分类（缺客户端 / 读不出 / 没凭据），界面据此给不同建议：
 * 「去装客户端」与「先登录果办」不是同一句话，混成一个 "not found" 用户没法行动。
 *
 * 非目标：不刷新、不写回、不改客户端任何文件；本模块没有可用凭据时只是返回空数组。
 *
 * @module dsh-connect-huaweicloud/credentials/probe
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAAS_PATH_PREFIX, OFFICIAL_MAAS_BASE } from '../constants.ts';
import { officeClawRoot, officeClawUsersDir, routingStateUsersDir } from '../paths.ts';
import type { GatewayCredential } from '../types.ts';
import { listTargets, readCredential } from './wincred.ts';
import type { RunPowerShell } from './wincred.ts';

/** 从桌面端读到的一份账号凭据。 */
export interface ImportedAccount {
  readonly userId: string;
  readonly userName: string;
  readonly gateway?: GatewayCredential;
  /** 读到了 STS 但拿不到对应私钥时，这里只有元信息（不能续期）。 */
  readonly sts?: { readonly securityToken: string; readonly expiresAt: string };
  /** 这份凭据是从哪个入口读到的；诊断用。 */
  readonly via: 'wincred' | 'models-json';
}

/** 一次桌面端探测的结果。 */
export interface DesktopProbe {
  /** 本机是否装了果办客户端并读到可用凭据（任一入口命中即 true）。 */
  readonly installed: boolean;
  /** 探测不到时的人话原因；`installed` 为 true 时为空。 */
  readonly reason?: string;
  /** 从桌面端读到的账号（可能为空数组）。 */
  readonly accounts: readonly ImportedAccount[];
}

/** `reason` 的闭集取值；写成联合类型是为了让界面能靠模式匹配给建议。 */
export type DesktopProbeReason = 'desktop-missing' | 'desktop-unreadable' | 'desktop-no-gateway';

/** 目录项的最小形状；只要名字与「是不是目录」，便于测试注入。 */
export interface DirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
}

/** 探测的外部依赖替身；默认实现才真的碰磁盘与 Powershell。 */
export interface ProbeOptions {
  /** 凭据读取的执行器替身（测试用）。 */
  readonly runPowerShell?: RunPowerShell;
  /** 目录枚举替身（测试用）；默认 `fs.readdir`。 */
  readonly readDirectory?: (dir: string) => Promise<readonly DirectoryEntry[]>;
  /** 文本文件读取替身（测试用）；默认 `fs.readFile`。 */
  readonly readTextFile?: (file: string) => Promise<string>;
}

/** 目录枚举结果；`errorCode` 保留原始 errno，用来区分「不存在」与「读不出」。 */
interface DirSnapshot {
  readonly names: readonly string[];
  readonly errorCode?: string;
}

/** Windows 上是 EPERM/EACCES；只要不是 ENOENT 就说明目录在但读不出来。 */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * 探测本机桌面端。只读，不刷新、不写回、不抛。
 *
 * @param env - 环境变量（测试注入，`OFFICE_CLAW_HOME` 决定根目录）。
 * @param options - 执行器/文件系统替身（测试用）。
 */
export async function probeDesktop(
  env: NodeJS.ProcessEnv = process.env,
  options: ProbeOptions = {},
): Promise<DesktopProbe> {
  const readDirectory = options.readDirectory ?? ((dir: string) => readdir(dir, { withFileTypes: true }));
  const readTextFile = options.readTextFile ?? ((file: string) => readFile(file, 'utf8'));
  const readEntry = (dir: string): Promise<DirSnapshot> => snapshotOf(dir, readDirectory);

  const rootSnapshot = await readEntry(officeClawRoot(env));
  const usersSnapshot = await readEntry(officeClawUsersDir(env));
  const routingSnapshot = await readEntry(routingStateUsersDir(env));

  const accounts: ImportedAccount[] = [];
  accounts.push(...(await readWinCredAccounts(env, options)));
  accounts.push(...(await readModelsJsonAccounts(env, routingSnapshot.names, readTextFile)));
  const merged = mergeAccounts(accounts);

  if (merged.length > 0) return { installed: true, accounts: merged };
  return { installed: false, reason: classifyFailure([rootSnapshot, usersSnapshot, routingSnapshot]), accounts: [] };
}

/** 目录枚举；失败时把 errno 留住，别丢了分类依据。 */
async function snapshotOf(
  dir: string,
  readDirectory: (dir: string) => Promise<readonly DirectoryEntry[]>,
): Promise<DirSnapshot> {
  try {
    const entries = await readDirectory(dir);
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    names.sort();
    return { names };
  } catch (error) {
    const code = errorCodeOf(error);
    return code === undefined ? { names: [] } : { names: [], errorCode: code };
  }
}

/** Node 的 fs 错误码在 `code` 上；不是 Error 的抛出物没有可用的码。 */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 三段目录状态 → `reason`。
 *
 * 顺序不能换：根目录都不存在才是「没装」，否则「有目录但空」只是「装了没登录」——
 * 这两种给用户的建议完全不同。
 */
function classifyFailure(snapshots: readonly DirSnapshot[]): DesktopProbeReason {
  const codes = snapshots.map((snapshot) => snapshot.errorCode);
  const hasUnreadable = codes.some((code) => code !== undefined && !NOT_FOUND_CODES.has(code));
  if (hasUnreadable) return 'desktop-unreadable';
  const allMissing = codes.every((code) => code !== undefined && NOT_FOUND_CODES.has(code));
  if (allMissing) return 'desktop-missing';
  return 'desktop-no-gateway';
}

/** 入口 1：凭据管理器 → provider-state JSON → 网关与身份。 */
async function readWinCredAccounts(env: NodeJS.ProcessEnv, options: ProbeOptions): Promise<ImportedAccount[]> {
  const targets = await listTargets(env).catch(() => []);
  const accounts: ImportedAccount[] = [];
  for (const item of targets) {
    let text: string | undefined;
    try {
      text = await readCredential(item.target, {
        ...(options.runPowerShell === undefined ? {} : { runPowerShell: options.runPowerShell }),
      });
    } catch {
      continue;
    }
    if (text === undefined) continue;
    const account = accountOfProviderState(text);
    if (account !== undefined) accounts.push(account);
  }
  return accounts;
}

/** 凭据文本可能是 `{providerState:{…}}`，也可能直接是 providerState；两种都收。 */
function accountOfProviderState(text: string): ImportedAccount | undefined {
  const root = asRecord(parseJson(text));
  if (root === undefined) return undefined;
  const normalized = asRecord(root['providerState']) ?? root;
  const gateway = gatewayOfProviderState(normalized);
  const userId = firstString(normalized['user_id']);
  if (userId === '') return undefined;
  const userName = firstString(normalized['user_name']);
  const sts = stsOfProviderState(normalized);
  return {
    userId,
    userName: userName === '' ? userId : userName,
    ...(gateway === undefined ? {} : { gateway }),
    ...(sts === undefined ? {} : { sts }),
    via: 'wincred',
  };
}

/**
 * `providerState.modelInfo` → 网关凭据（照 `modelGatewayOf()`）。
 *
 * 云端下发的 `model_api_url_base` 只给主机名，没有 scheme 也没有 `/v2`，两样都要补；
 * 主机名缺失时用 `OFFICIAL_MAAS_BASE` 兜底，但 key/secret 缺一不可。
 */
function gatewayOfProviderState(providerState: Record<string, unknown>): GatewayCredential | undefined {
  const modelInfo = asRecord(providerState['modelInfo']);
  if (modelInfo === undefined) return undefined;
  const auth = asRecord(modelInfo['model_auth_info']);
  if (auth === undefined) return undefined;
  const appKey = firstString(auth['model_app_key']);
  const appSecret = firstString(auth['model_app_secret']);
  if (appKey === '' || appSecret === '') return undefined;
  const rawBase = firstString(modelInfo['model_api_url_base']);
  const base = normalizeBase(rawBase === '' ? OFFICIAL_MAAS_BASE : rawBase);
  if (base === undefined) return undefined;
  const maasApiKey = firstString(auth['maas_api_key']);
  return {
    base,
    appKey,
    appSecret,
    ...(maasApiKey === '' ? {} : { maasApiKey }),
  };
}

/**
 * providerState 里的 STS 元信息。
 *
 * 只存到 `security_token` 与到期时间：本插件拿不到客户端那把 DPoP 私钥，
 * 这段凭据只能展示、不能续期，所以不往 `StsCredential` 的形状上凑。
 */
function stsOfProviderState(
  providerState: Record<string, unknown>,
): { securityToken: string; expiresAt: string } | undefined {
  for (const key of ['credentialV3', 'credential']) {
    const credential = asRecord(providerState[key]);
    if (credential === undefined) continue;
    const securityToken = firstString(credential['security_token'], credential['securityToken']);
    if (securityToken === '') continue;
    const expiresAt = firstString(credential['expires_at'], credential['expiresAt'], credential['expiration']);
    return expiresAt === '' ? { securityToken, expiresAt: '' } : { securityToken, expiresAt };
  }
  return undefined;
}

/** 入口 2：`routing_state/users/<userId>/models.json` → APIG APP 认证。 */
async function readModelsJsonAccounts(
  env: NodeJS.ProcessEnv,
  userIds: readonly string[],
  readTextFile: (file: string) => Promise<string>,
): Promise<ImportedAccount[]> {
  // 必须用传入的 env：少了它，测试注入的 `OFFICE_CLAW_HOME` 会被忽略，
  // 探测实际读的是真实家目录——那会让「本机没装客户端」的机器读到别的目录。
  const routingUsers = routingStateUsersDir(env);
  const accounts: ImportedAccount[] = [];
  for (const userDir of userIds) {
    let text: string;
    try {
      text = await readTextFile(join(routingUsers, userDir, 'models.json'));
    } catch {
      continue;
    }
    const account = accountOfModelsJson(text, userDir);
    if (account !== undefined) accounts.push(account);
  }
  return accounts;
}

/** `defaults[]` 里第一条同时带 `api_base` 与 `Authorization` 的配置就是凭据。 */
function accountOfModelsJson(text: string, fallbackUserId: string): ImportedAccount | undefined {
  const document = asRecord(parseJson(text));
  if (document === undefined) return undefined;
  const defaults = document['defaults'];
  if (!Array.isArray(defaults)) return undefined;

  for (const item of defaults) {
    const entry = asRecord(item);
    if (entry === undefined) continue;
    const config = asRecord(entry['model_client_config']);
    if (config === undefined) continue;
    const apiBase = firstString(config['api_base']);
    // `Authorization` 在客户端的真实文件里位于 `custom_headers` 下；也接受它直接挂在
    // `model_client_config` 上，因为不同客户端版本两种形态都出现过。
    const customHeaders = asRecord(config['custom_headers']);
    const authorization = firstString(
      customHeaders?.['Authorization'],
      customHeaders?.['authorization'],
      config['Authorization'],
      config['authorization'],
    );
    if (apiBase === '' || authorization === '') continue;

    const pair = parseBasicAuthorization(authorization);
    if (pair === undefined) continue;
    const base = normalizeBase(apiBase);
    if (base === undefined) continue;

    const userId = firstString(entry['user_id']);
    const userName = firstString(entry['user_name']);
    return {
      userId: userId === '' ? fallbackUserId : userId,
      userName: userName === '' ? (userId === '' ? fallbackUserId : userId) : userName,
      gateway: { base, appKey: pair.appKey, appSecret: pair.appSecret },
      via: 'models-json',
    };
  }
  return undefined;
}

/** `Basic base64(appKey:appSecret)` → 两段；前缀或 base64 不对就放弃这一条。 */
function parseBasicAuthorization(value: string): { appKey: string; appSecret: string } | undefined {
  const matched = /^Basic\s+(\S+)$/iu.exec(value.trim());
  const encoded = matched?.[1];
  if (encoded === undefined) return undefined;
  if (!/^[A-Za-z0-9+/=]+$/u.test(encoded)) return undefined;
  const plain = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = plain.indexOf(':');
  if (separator <= 0 || separator === plain.length - 1) return undefined;
  return { appKey: plain.slice(0, separator), appSecret: plain.slice(separator + 1) };
}

/**
 * 网关基址归一：去尾斜杠 → 补 `https://` → 补 `/v2`。
 *
 * 三件事都必须做，少哪一步都会得到「签名/凭据都对但 404」：
 * 云端下发的主机名不带 scheme，而 `/models` 只在 `/v2` 下存在。
 */
function normalizeBase(rawBase: string): string | undefined {
  const trimmed = rawBase.trim().replace(/\/+$/u, '');
  if (trimmed === '') return undefined;
  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : 'https://' + trimmed;
  try {
    const parsed = new URL(withScheme);
    if (parsed.hostname === '') return undefined;
  } catch {
    return undefined;
  }
  return withScheme.endsWith(MAAS_PATH_PREFIX) ? withScheme : withScheme + MAAS_PATH_PREFIX;
}

/**
 * 合并两个入口。
 *
 * 同一 `userId` 只留一条，优先带网关、其次优先 `wincred`：凭据管理器那条还可能带 STS
 * 元信息，而 `models.json` 只有 Basic 头。顺序稳定（先出现的先留），便于测试复现。
 */
function mergeAccounts(accounts: readonly ImportedAccount[]): ImportedAccount[] {
  const byUser = new Map<string, ImportedAccount>();
  for (const account of accounts) {
    const existing = byUser.get(account.userId);
    if (existing === undefined) {
      byUser.set(account.userId, account);
      continue;
    }
    if (existing.gateway === undefined && account.gateway !== undefined) byUser.set(account.userId, account);
  }
  return [...byUser.values()];
}

/** 只接受普通对象；数组与 null 都当成「没有」。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 解析 JSON；坏文本返回 `undefined`（客户端随时可能写出半个文件）。 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 第一个非空字符串；上游各代字段名不一致时按顺序试。 */
function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}
