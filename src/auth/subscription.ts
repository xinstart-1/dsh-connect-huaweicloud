/**
 * 权限校验 + 缺 model_info 时补一次「接入模型」，产出模型网关凭据。
 *
 * 登录只给 STS；网关的 appKey/appSecret 要问 `client-permission-validate`。账号还没
 * 开通 MaaS 时该接口不给 `model_auth_info`，此时要调一次 `client-subscription`（与
 * 客户端「接入模型」按钮背后同一个端点）——那是**写操作**，只在确实缺时才发。
 * 凭据只驻留内存，禁止写日志。
 *
 * @module dsh-connect-huaweicloud/auth/subscription
 */

import {
  CLAW_BASE,
  MAAS_PATH_PREFIX,
  OFFICIAL_MAAS_BASE,
  PERMISSION_PATH,
  REQUEST_TIMEOUT_MS,
  SUBSCRIPTION_CLAW_PATH,
} from '../constants.ts';
import type { GatewayCredential, StsCredential } from '../types.ts';
import { signHuaweiRequest } from './sign.ts';

/** 注入用的 fetch 形状；测试传替身即可不触网。 */
export type SubscriptionFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 订阅端点返回的 `model_info` 片段。 */
interface ModelInfo {
  readonly base: string;
  readonly appKey: string;
  readonly appSecret: string;
  readonly maasApiKey: string;
}

/**
 * 读一次权限校验接口，缺 `model_auth_info` 时补一次接入模型。
 *
 * @param credential - 有效的 STS 凭据；临期会读不到，调用方应先续期。
 * @param fetcher - fetch 替身；缺省用 `globalThis.fetch`。
 * @returns 归一后的网关凭据；任何一步失败都返回 `undefined`，不抛。
 */
export async function fetchGateway(
  credential: StsCredential,
  fetcher: SubscriptionFetch = globalThis.fetch,
): Promise<GatewayCredential | undefined> {
  const permission = await requestSigned(fetcher, {
    method: 'GET',
    url: CLAW_BASE + PERMISSION_PATH,
    body: '',
    credential,
    headers: { 'content-type': 'application/json' },
  });
  if (permission === undefined) return undefined;

  const subscription = asRecord(permission['subscription']);
  const modelInfo = asRecord(subscription['model_info']);
  let info = readModelInfo(modelInfo);

  if (info === undefined) {
    // 写操作：替用户点一次「接入模型」。只在缺 model_auth_info 时发一次，不重试。
    const granted = await requestSigned(fetcher, {
      method: 'POST',
      url: CLAW_BASE + SUBSCRIPTION_CLAW_PATH,
      body: '{}',
      credential,
      headers: {
        'content-type': 'application/json;charset=utf8',
        'x-subscription-type': 'v2',
      },
    });
    if (granted === undefined) return undefined;
    info = readModelInfo(asRecord(asRecord(granted['model_info'])));
    if (info === undefined) {
      info = readModelInfo(asRecord(asRecord(granted['subscription'])['model_info']));
    }
  }

  if (info === undefined) return undefined;
  return {
    base: gatewayBase(info.base),
    appKey: info.appKey,
    appSecret: info.appSecret,
    ...(info.maasApiKey === '' ? {} : { maasApiKey: info.maasApiKey }),
  };
}

/**
 * 发一次带 SDK-HMAC-SHA256 签名的 CLAW 请求。
 *
 * @returns 解析后的响应体；网络错误、非 2xx、响应不是 JSON 都返回 `undefined`。
 */
async function requestSigned(
  fetcher: SubscriptionFetch,
  input: {
    method: string;
    url: string;
    body: string;
    credential: StsCredential;
    headers: Record<string, string>;
  },
): Promise<Record<string, unknown> | undefined> {
  const { credential } = input;
  const headers: Record<string, string> = {
    ...input.headers,
    'x-security-token': credential.securityToken,
  };
  if (credential.projectId !== '') headers['x-project-id'] = credential.projectId;

  // 签名结果必须原样交给 fetch：Authorization 里的 SignedHeaders 与实际头逐字对应。
  const signed = signHuaweiRequest({
    method: input.method,
    url: input.url,
    body: input.body,
    credentials: {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      securityToken: credential.securityToken,
    },
    headers,
  });

  try {
    const response = await fetcher(input.url, {
      method: input.method,
      headers: signed,
      ...(input.method === 'GET' ? {} : { body: input.body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

/**
 * 从 `model_info` 里取网关三要素。
 *
 * @returns 缺任何一项都返回 `undefined`：缺一项就用不了，全部失败归成「没开通」。
 */
function readModelInfo(modelInfo: Record<string, unknown>): ModelInfo | undefined {
  const auth = asRecord(modelInfo['model_auth_info']);
  const appKey = pickString(auth, 'model_app_key');
  const appSecret = pickString(auth, 'model_app_secret');
  if (appKey === '' || appSecret === '') return undefined;
  return {
    base: pickString(modelInfo, 'model_api_url_base'),
    appKey,
    appSecret,
    maasApiKey: pickString(auth, 'maas_api_key'),
  };
}

/**
 * 把云端下发的主机名补成可用的基址。
 *
 * 实测下发的只是主机名：没有 scheme 也没有 `/v2`，两样都要补；完全没给时退回官方
 * 直连地址（{@link OFFICIAL_MAAS_BASE}）。
 */
function gatewayBase(raw: string): string {
  let base = (raw === '' ? OFFICIAL_MAAS_BASE : raw).trim().replace(/\/+$/u, '');
  if (!/^https?:\/\//iu.test(base)) base = 'https://' + base;
  if (!base.endsWith(MAAS_PATH_PREFIX)) base += MAAS_PATH_PREFIX;
  return base;
}

/** 把未知值收敛成对象；非对象给空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 取第一个非空字符串字段；没有返回空串。 */
function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}
