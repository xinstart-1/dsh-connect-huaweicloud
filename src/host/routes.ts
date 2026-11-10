/**
 * 宿主 HTTP 路由：`/plugins/dsh-connect-huaweicloud/status` 与 `.../action`。
 *
 * 为什么需要这两条而不是让页面直接问上游：令牌**不能进页面**。页面能拿到的只有
 * 已经归一好的展示数据，以及一个受白名单约束的动作入口。
 *
 * 安全边界（三重，缺一条都算把本机开给同网段）：
 * 1. 只接受**回环** Host 头 —— webServer 可能绑在 0.0.0.0 上，此时同网段机器也能
 *    发请求；Host 头是唯一能便宜判断「这是本机」的信号。
 * 2. 动作走**白名单**，页面不能借这条路由去打上游任意接口。
 * 3. 请求体上限 64 KiB，坏 JSON 当错误 —— 这条路由只收小的开关 payload。
 *
 * @module dsh-connect-huaweicloud/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ACTION_PATH, STATUS_PATH } from '../constants.ts';
import type { ActionResult, HostAction, StatusSnapshot } from '../types.ts';

/** 动作白名单（路由层校验用，与 `HostAction` 类型同源）。 */
export const ACTIONS: readonly HostAction[] = [
  'refresh',
  'sync-desktop',
  'login-start',
  'login-status',
  'login-cancel',
  'switch-account',
  'remove-account',
  'members',
  'settings',
  'test-account',
];

/** 请求体上限：这条路由只收开关，不该有更大的东西。 */
const MAX_BODY_BYTES = 64 * 1024;

/** webServer 注册项的最小形状。 */
export interface WebServerEntry {
  readonly kind: 'exact';
  readonly path: string;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** webServer 服务的最小形状（只用到 register）。 */
export interface WebServerLike {
  register(entry: WebServerEntry): () => void;
}

/** `ctx.inject` 的最小形状。 */
export interface RoutesHost {
  inject(
    services: readonly string[],
    callback: (webCtx: {
      effect: (fn: () => () => void) => void;
      webServer: WebServerLike;
    }) => void,
  ): void;
}

/** 路由依赖：业务逻辑全部由调用方注入，便于单测。 */
export interface RouteDeps {
  /** 构建最新状态文档（可以发网络，调用方负责缓存）。 */
  readonly status: () => Promise<StatusSnapshot>;
  /** 执行动作；返回给浏览器的结果。 */
  readonly action: (action: HostAction, body: Record<string, unknown>) => Promise<ActionResult>;
}

/**
 * 判断 Host 头是不是本机。
 *
 * `127.0.0.0/8` 的任意地址、`localhost`、`[::1]` / `::1` 都算；其余一律不算
 * （宁可误拒，不可误放）。
 *
 * @param host - `Host` 头原值（可能带端口）。
 * @returns 本机为 true。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const trimmed = host.trim().toLowerCase();
  if (trimmed === '') return false;
  // 裸 IPv6 先判：`::1` 里也有 `:1`，先剥端口会把它剥成 `:`。
  if (trimmed === '::1') return true;
  const name = trimmed.replace(/:\d+$/u, '');
  if (name === 'localhost' || name === '[::1]' || name === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(name);
  if (ipv4 === null) return false;
  return Number(ipv4[1]) === 127;
}

/** 动作路由放宽的条件：Host 缺失时还有 Origin 可判（某些客户端不回传 Host）。 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

/** 写一个 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读请求体，超上限就截断（body 只是开关，截断足够安全）。 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.push(chunk.subarray(0, Math.max(0, MAX_BODY_BYTES - (size - chunk.length))));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 把 `{action, ...}` 请求体解析成结构化输入；坏输入返回错误文案。 */
export function parseAction(
  raw: string,
): { action: HostAction; body: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: '请求体不是合法 JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  const record = parsed as Record<string, unknown>;
  const action = record['action'];
  if (typeof action !== 'string' || !ACTIONS.includes(action as HostAction)) {
    return { error: `未知动作：${String(action)}` };
  }
  return { action: action as HostAction, body: record };
}

/**
 * 注册两条路由。
 *
 * @param ctx - 宿主上下文（只用到 `inject(['webServer'])`）。
 * @param deps - 状态与动作的实现。
 */
export function registerRoutes(ctx: RoutesHost, deps: RouteDeps): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          if (!isLoopbackHost(req.headers.host)) {
            sendJson(res, 403, { ok: false, error: { code: 'loopback-only', message: '只接受本机请求' } });
            return;
          }
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只接受 GET' } });
            return;
          }
          void deps.status().then(
            (status) => {
              sendJson(res, 200, status);
            },
            (error: unknown) => {
              sendJson(res, 500, {
                ok: false,
                error: {
                  code: 'status-failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            },
          );
        },
      }),
    );

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: ACTION_PATH,
        handler: (req, res) => {
          if (!isLoopbackHost(req.headers.host) && !isLoopbackOrigin(req.headers.origin)) {
            sendJson(res, 403, { ok: false, error: { code: 'loopback-only', message: '只接受本机请求' } });
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: '只接受 POST' } });
            return;
          }
          void readBody(req)
            .then((raw) => {
              const parsed = parseAction(raw);
              if ('error' in parsed) {
                sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: parsed.error } });
                return;
              }
              return deps.action(parsed.action, parsed.body).then(
                (result) => {
                  sendJson(res, 200, result);
                },
                (error: unknown) => {
                  const code =
                    typeof (error as { code?: unknown }).code === 'string'
                      ? (error as { code: string }).code
                      : 'action-failed';
                  sendJson(res, 200, {
                    ok: false,
                    message: error instanceof Error ? error.message : String(error),
                  });
                },
              );
            })
            .catch((error: unknown) => {
              sendJson(res, 400, {
                ok: false,
                error: {
                  code: 'bad-request',
                  message: error instanceof Error ? error.message : String(error),
                },
              });
            });
        },
      }),
    );
  });
}
