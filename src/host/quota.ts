/**
 * 本机控制面的额度读数（只读）。
 *
 * 果办桌面端自己在本机起了两个 HTTPS 端口（3004 / 3003，自签证书），暴露套餐与积分。
 * 请求必须带 cookie `oc_sid=<session.cookie 里解出来的 value>`——cookie 名写错
 * （`oc_session` / `oc_pt` / `auth` 都试过）一律 401 `AUTH_SESSION_INVALID`。
 *
 * 为什么额度走本机而不是模型网关：网关只认 Basic(appKey:appSecret)，不提供积分接口；
 * 积分是控制面的事实。代价是**必须有客户端在跑**——没有客户端时这里返回 undefined，
 * 界面就不显示额度（不是显示 0，0 会被误读成「额度用完」）。
 *
 * 为什么用 `node:https` 而不是 `fetch`：本机控制面是自签证书，`fetch` 要关校验得靠
 * undici 的 dispatcher，而 undici 不是稳定的内置入口；`https.request` 的
 * `rejectUnauthorized: false` 是标准 API。
 *
 * 不变量：只读、不改账号状态；关校验的前提是**只连 127.0.0.1**。
 *
 * @module dsh-connect-huaweicloud/host/quota
 */

import { request } from 'node:https';
import { LOCAL_CONTROL_PORTS, QUOTA_TTL_MS, SESSION_COOKIE_NAME } from '../constants.ts';
import type { LocalSession } from '../credentials/dpapi.ts';
import type { QuotaReading } from '../types.ts';

/** 单次请求超时；本机控制面正常在几十毫秒内回。 */
const REQUEST_TIMEOUT_MS = 5_000;

/** 读一次额度所需的东西。 */
export interface QuotaDeps {
  /** 读本机会话；没有客户端或没登录时返回 undefined。 */
  readonly readSession: () => Promise<LocalSession | undefined>;
  /** 失败原因只在 debug 级别记：卡片轮询会反复调，不该刷满日志。 */
  readonly warn: (message: string) => void;
  readonly now?: () => number;
}

/** 额度读取器。 */
export interface QuotaReader {
  /** 取某账号的额度；同一账号在 TTL 内复用上次结果。 */
  read(accountId: string, userId: string): Promise<QuotaReading | undefined>;
  /** 丢弃缓存（同步账号或点「刷新」后调）。 */
  clear(): void;
}

/** 用户目录名里 domainId 与 userId 的分隔符。 */
const USER_DIR_SEPARATOR = '%3A';

/**
 * 从 session value 里取出 userId。
 *
 * session 的形状是 `<domainId>%3A<userId>.<sessionId>.<sig>`；只取第一段里
 * `%3A` 之后的部分。取不到时返回 undefined —— 那说明这个 cookie 不属于任何已知账号。
 *
 * @param value - `session.cookie` 里解出来的 cookie 值。
 * @returns userId；形状不符时 undefined。
 */
export function userIdOfSessionValue(value: string): string | undefined {
  const head = value.split('.')[0];
  if (head === undefined || head === '') return undefined;
  const index = head.indexOf(USER_DIR_SEPARATOR);
  if (index === -1) return undefined;
  const userId = head.slice(index + USER_DIR_SEPARATOR.length);
  return userId === '' ? undefined : userId;
}

/**
 * 把上游响应归一成读数。
 *
 * 字段位置在几层里浮动（顶层 / `data` / `subscription` / `package`），逐个候选试；
 * 宁可少显示一个字段，也不显示错的数字。
 *
 * @param body - 已解析的响应体。
 * @param readAtMs - 读取时刻，用于判断缓存是否过期。
 */
export function toQuotaReading(body: unknown, readAtMs: number): QuotaReading {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { readAtMs };
  const record = body as Record<string, unknown>;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

  const nested = record['data'] ?? record['subscription'] ?? record['package'];
  const source =
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;

  const total = num(source['total']) ?? num(source['quota']);
  const used = num(source['used']);
  const remaining =
    num(source['remaining']) ?? (total !== undefined && used !== undefined ? total - used : undefined);
  const plan =
    typeof source['plan'] === 'string'
      ? source['plan']
      : typeof source['package_name'] === 'string'
        ? source['package_name']
        : undefined;

  return {
    ...(total === undefined ? {} : { total }),
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(plan === undefined ? {} : { plan }),
    readAtMs,
  };
}

/** 发一次 GET，返回解析后的 JSON；失败返回 undefined。 */
function getJson(port: number, path: string, cookieValue: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Cookie: SESSION_COOKIE_NAME + '=' + cookieValue,
        },
        // 只连回环，证书是客户端自己签的，没有可信链可校。
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (status < 200 || status >= 300) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(undefined);
          }
        });
        res.on('error', () => {
          resolve(undefined);
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.on('error', () => {
      resolve(undefined);
    });
    req.end();
  });
}

/**
 * 建额度读取器。
 *
 * @param deps - 会话读取与日志。
 * @returns 带 TTL 缓存与并发去重的读取器。
 */
export function createQuotaReader(deps: QuotaDeps): QuotaReader {
  const now = deps.now ?? ((): number => Date.now());
  const cache = new Map<string, QuotaReading>();
  const inflight = new Map<string, Promise<QuotaReading | undefined>>();

  const fetchOnce = async (userId: string): Promise<QuotaReading | undefined> => {
    const session = await deps.readSession();
    if (session === undefined) return undefined;
    if (session.expiresAtSec * 1000 <= now()) return undefined;

    const sessionUserId = userIdOfSessionValue(session.value);
    // 会话属于别的账号：本机控制面只认当前登录的那一个，别人的额度读不到。
    if (sessionUserId !== undefined && userId !== '' && sessionUserId !== userId) return undefined;

    for (const port of LOCAL_CONTROL_PORTS) {
      const body = await getJson(port, '/api/subscription/current', session.value);
      if (body === undefined) continue;
      return toQuotaReading(body, now());
    }
    deps.warn('两个控制面端口都没读到额度（客户端可能没在跑）');
    return undefined;
  };

  return {
    async read(accountId, userId) {
      const cached = cache.get(accountId);
      if (cached !== undefined && now() - cached.readAtMs < QUOTA_TTL_MS) return cached;

      const pending = inflight.get(accountId);
      if (pending !== undefined) return pending;

      const task = fetchOnce(userId)
        .then((reading) => {
          if (reading !== undefined) cache.set(accountId, reading);
          return reading;
        })
        .catch(() => undefined)
        .finally(() => {
          inflight.delete(accountId);
        });
      inflight.set(accountId, task);
      return task;
    },

    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}
