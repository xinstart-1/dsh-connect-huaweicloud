/**
 * 华为云请求签名（SDK-HMAC-SHA256）。
 *
 * 果办的权限校验与订阅接口都要 AK/SK 签名；模型网关用的是另一套（HTTP Basic）。
 * canonical request 必须与服务端逐字节一致，差一个字段只会得到
 * `Incorrect IAM authentication information`，不告诉你差在哪。
 *
 * 关键约束：`Host` 不在 headers 对象里（fetch 禁止手设）但签名必须含它；
 * Authorization 里的 `SignedHeaders` 必须与实际发出的头完全对应，所以返回值是
 * **新的**头对象，调用方必须把这一份交给 fetch。
 *
 * @module dsh-connect-huaweicloud/auth/sign
 */

import { createHash, createHmac } from 'node:crypto';

/** 签名算法名，逐字进 Authorization。 */
const ALGORITHM = 'SDK-HMAC-SHA256';

/**
 * 给一组请求头补上签名四件套：X-Sdk-Date、X-Sdk-Content-Sha256、
 * X-Security-Token（调用方传了才带）、Authorization。
 *
 * @param options.method - HTTP 方法；签名里统一大写。
 * @param options.url - 完整请求地址；host、path、query 都从它取。
 * @param options.body - 请求体原文；缺省按空串算 SHA-256。
 * @param options.credentials - AK/SK；`securityToken` 有则额外签入。
 * @param options.headers - 调用方已有的头（会被复制，不会就地改）。
 * @param options.now - 签名时刻；测试注入用，缺省取当前时间。
 * @returns 新的头对象；把它交给 fetch，不要改造原对象。
 */
export function signHuaweiRequest(options: {
  method: string;
  url: string;
  body?: string;
  credentials: { accessKeyId: string; secretAccessKey: string; securityToken?: string };
  headers?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const { method, url, body = '', credentials, now } = options;
  const parsed = new URL(url);
  const xSdkDate = sdkDate(now ?? new Date());
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    'X-Sdk-Date': xSdkDate,
    'X-Sdk-Content-Sha256': payloadHash,
  };
  const securityToken = credentials.securityToken;
  if (securityToken !== undefined && securityToken !== '') {
    headers['X-Security-Token'] = securityToken;
  }

  const entries: Array<[string, string]> = Object.entries(headers).map(([key, value]) => [
    key.toLowerCase(),
    String(value).trim(),
  ]);
  // Host 只能进签名，不能进实际请求头——浏览器与 undici 都禁止手设它。
  entries.push(['host', parsed.host]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let canonicalHeaders = '';
  const signedNames: string[] = [];
  for (const [name, value] of entries) {
    canonicalHeaders += name + ':' + value + '\n';
    signedNames.push(name);
  }
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [
    String(method).toUpperCase(),
    canonicalUri(parsed.pathname),
    canonicalQuery(parsed.search.replace(/^\?/u, '')),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, xSdkDate, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacHex(credentials.secretAccessKey, stringToSign);

  headers['Authorization'] =
    ALGORITHM +
    ' Access=' +
    credentials.accessKeyId +
    ', SignedHeaders=' +
    signedHeaders +
    ', Signature=' +
    signature;
  return headers;
}

/**
 * 模型网关的认证形态。
 *
 * @returns `'Basic ' + base64(appKey + ':' + appSecret)`，按 UTF-8 编。
 */
export function huaweiBasicAuth(appKey: string, appSecret: string): string {
  return 'Basic ' + Buffer.from(appKey + ':' + appSecret, 'utf8').toString('base64');
}

/** 华为云 X-Sdk-Date 格式：`20060102T150405Z`（UTC，无分隔符、无毫秒）。 */
function sdkDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

/** 每一段单独 encode，并规整成以 `/` 结尾（空段也要保留）。 */
function canonicalUri(pathname: string): string {
  let out = pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (!out.endsWith('/')) out += '/';
  return out;
}

/** query 按 key 排序，同一个 key 的多个值也排序。 */
function canonicalQuery(search: string): string {
  if (search === '') return '';
  const params = new URLSearchParams(search);
  const keys = [...new Set(params.keys())].sort();
  const parts: string[] = [];
  for (const key of keys) {
    for (const value of params.getAll(key).sort()) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    }
  }
  return parts.join('&');
}

/** 十六进制 SHA-256。 */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 十六进制 HMAC-SHA256。 */
function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message).digest('hex');
}
