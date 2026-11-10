/**
 * 果办浏览器登录与 STS 续期。
 *
 * 两条回调路线按序自动选：路线 B 让云端接住授权码（本机不开端口，首选）；只有 state
 * 登记失败时才回落到路线 A 的本机回环服务。两条路线共用 PKCE、DPoP 与换 token。
 * 不负责落盘：凭据只驻留内存，续期是破坏性操作（旧 refresh_token 立即失效），
 * 调用方必须拿到结果后立刻写进凭据仓库。凭据禁止写日志。
 *
 * @module dsh-connect-huaweicloud/auth/oauth
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AUTH_BASE,
  AUTHORIZE_PATH,
  CLAW_BASE,
  CLIENT_ID,
  CLOUD_REDIRECT_URI,
  CODE_PATH,
  CODE_POLL_INTERVAL_MS,
  LOGIN_PAGE,
  LOGIN_TIMEOUT_MS,
  LOOPBACK_REDIRECT_PATH,
  REQUEST_TIMEOUT_MS,
  STATE_PATH,
  STS_TOKEN_URL,
} from '../constants.ts';
import type { DpopJwk, StsCredential } from '../types.ts';
import { newDpopKey, signDpopProof } from './dpop.ts';

/** 注入用的 fetch 形状；测试传替身即可不触网。 */
export type AuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 一次进行中的登录。 */
export interface LoginHandle {
  /** 授权地址；等 state 登记或本机端口就绪后才可用。 */
  readonly authorizeUrl: Promise<string>;
  /** 用户完成授权后 resolve 成 STS 凭据；取消、超时、换 token 失败都 reject。 */
  readonly result: Promise<StsCredential>;
  /** 放弃这次登录（取消或超时后用）。幂等。 */
  cancel(): void;
}

/** 授权页拼装所需的全部输入。 */
interface AuthorizeInput {
  readonly state: string;
  readonly challenge: string;
  readonly redirectUri: string;
}

/** 已选定的回调路线。 */
interface CallbackRoute {
  readonly authorizeUrl: string;
  readonly redirectUri: string;
  readonly waitForCode: () => Promise<string>;
}

/** 本机回环回调服务。 */
interface Loopback {
  readonly redirectUri: string;
  readonly waitForCode: () => Promise<string>;
  readonly close: () => void;
}

/**
 * 起一次浏览器登录。
 *
 * 立刻返回，不在内部等用户完成授权：`authorizeUrl` 与 `result` 各自推进。
 *
 * @param options.timeoutMs - 整场登录的超时；超时与 `cancel()` 走同一条收尾路径。
 * @param options.pollIntervalMs - 路线 B 轮询授权码的间隔；测试注入用。
 * @param options.fetch - fetch 替身；测试注入用，缺省用 `globalThis.fetch`。
 * @returns 授权地址、结果与取消入口。
 */
export function startLogin(
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    fetch?: AuthFetch;
  } = {},
): LoginHandle {
  const fetcher: AuthFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CODE_POLL_INTERVAL_MS;
  const dpopPrivateJwk = newDpopKey();
  const { verifier, challenge } = pkce();
  const deadline = Date.now() + timeoutMs;

  let stopped = false;
  let cleaned = false;
  let closeLoopback: (() => void) | undefined;
  let rejectCancellation: (error: Error) => void = () => {};

  // 取消与超时共用一个拒绝出口：两条路线上等待中的 promise 都会被同一次 race 打断。
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  void cancellation.catch(() => {
    // 只是给这个 promise 挂一个消费者：没人 race 它时也不该报 unhandled rejection。
  });

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    closeLoopback?.();
    closeLoopback = undefined;
  };

  const abort = (message: string): void => {
    if (stopped) return;
    stopped = true;
    cleanup();
    rejectCancellation(new Error(message));
  };

  const timeoutHandle: NodeJS.Timeout = setTimeout(
    () => abort('登录超时，未等到授权码'),
    timeoutMs,
  );
  timeoutHandle.unref();

  const prepared = (async (): Promise<CallbackRoute> => {
    const cloudState = await registerState(fetcher);
    if (cloudState !== undefined) {
      return {
        authorizeUrl: buildAuthorizeUrl({ state: cloudState, challenge, redirectUri: CLOUD_REDIRECT_URI }),
        redirectUri: CLOUD_REDIRECT_URI,
        waitForCode: () =>
          pollAuthorizationCode(fetcher, cloudState, pollIntervalMs, deadline, () => stopped),
      };
    }

    // 路线 B 的 state 登记失败（网络错误或非 2xx）→ 本机回环接住 ?code=。
    if (stopped) throw new Error('登录已取消');
    const loopback = await startLoopback();
    closeLoopback = loopback.close;
    if (stopped) {
      loopback.close();
      throw new Error('登录已取消');
    }
    const state = randomBytes(16).toString('hex');
    return {
      authorizeUrl: buildAuthorizeUrl({ state, challenge, redirectUri: loopback.redirectUri }),
      redirectUri: loopback.redirectUri,
      waitForCode: loopback.waitForCode,
    };
  })();

  const work = (async (): Promise<StsCredential> => {
    const route = await prepared;
    const code = await route.waitForCode();
    const credential = await requestToken(
      fetcher,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: route.redirectUri,
      }),
      dpopPrivateJwk,
    );
    cleanup();
    return credential;
  })();

  return {
    authorizeUrl: Promise.race([prepared.then((route) => route.authorizeUrl), cancellation]),
    result: Promise.race([work, cancellation]),
    cancel: () => abort('登录已取消'),
  };
}

/**
 * 用 refresh_token 续期。
 *
 * 破坏性：成功后上游立刻作废旧 refresh_token，返回值必须马上落盘；同一账号同时只能
 * 有一个续期在跑（单飞由调用方保证），否则第二次会拿着已消费的 token 去换。
 *
 * @param credential - 当前凭据；`dpopPrivateJwk` 必须与 refresh_token 绑定的是同一把。
 * @returns 新凭据；响应里没给 refresh_token 时为空串（表示不可再续期，需重新登录）。
 * @throws 上游非 2xx、响应缺凭据或不是 JSON 时。
 */
export async function refreshSts(credential: StsCredential): Promise<StsCredential> {
  if (credential.refreshToken === '') {
    throw new Error('没有 refresh_token，无法续期（需要重新登录）');
  }
  return requestToken(
    globalThis.fetch,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: CLIENT_ID,
    }),
    credential.dpopPrivateJwk,
  );
}

/**
 * 在云端登记登录 state（路线 B 的第一步）。
 *
 * @returns 登记到的 state；登记失败（网络错误、非 2xx、响应缺 state）返回 `undefined`，
 *   由调用方回落到本机回环。
 */
async function registerState(fetcher: AuthFetch): Promise<string | undefined> {
  try {
    const response = await fetcher(CLAW_BASE + STATE_PATH, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const json: unknown = await response.json();
    return nestedString(json, 'state') ?? nestedString(json, 'data', 'state');
  } catch {
    return undefined;
  }
}

/**
 * 轮询云端取授权码（路线 B）。
 *
 * @param deadline - 绝对截止时刻；到点后抛错。
 * @param isStopped - 取消标记；取消后立刻停止轮询。
 * @throws 取消或超过 deadline 时。
 */
async function pollAuthorizationCode(
  fetcher: AuthFetch,
  state: string,
  intervalMs: number,
  deadline: number,
  isStopped: () => boolean,
): Promise<string> {
  const url = CLAW_BASE + CODE_PATH + '?state=' + encodeURIComponent(state);
  for (;;) {
    if (isStopped()) throw new Error('登录已取消');
    if (Date.now() >= deadline) throw new Error('等待授权码超时');
    await sleep(intervalMs);
    const code = await readAuthorizationCode(fetcher, url);
    if (code !== undefined) return code;
  }
}

/** 读一次授权码；还没生成或这次读失败都返回 `undefined`，由轮询继续等。 */
async function readAuthorizationCode(fetcher: AuthFetch, url: string): Promise<string | undefined> {
  try {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const json: unknown = await response.json();
    return nestedString(json, 'code') ?? nestedString(json, 'data', 'code');
  } catch {
    return undefined;
  }
}

/**
 * 起本机回环回调服务（路线 A）。
 *
 * 只监听 `127.0.0.1` 的随机端口，只接受 {@link LOOPBACK_REDIRECT_PATH} 上的 `?code=`，
 * 其余路径一律 404 —— 它只活一次登录的时间。
 *
 * @throws 端口监听失败时。
 */
async function startLoopback(): Promise<Loopback> {
  const server = createServer();
  let resolveCode: (code: string) => void = () => {};
  let settled = false;
  const code = new Promise<string>((resolve) => {
    resolveCode = resolve;
  });
  void code.catch(() => {
    // 只是让这个 promise 有消费者；实际的拒绝由取消 race 负责。
  });

  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== LOOPBACK_REDIRECT_PATH) {
      response.writeHead(404).end();
      return;
    }
    const received = url.searchParams.get('code');
    if (received === null || received === '') {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<h3>授权未返回 code，请重试。</h3>');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<h3>授权成功，可以关闭此页面回到 DSH。</h3>');
    if (!settled) {
      settled = true;
      resolveCode(received);
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('本机回环端口分配失败'));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    redirectUri: 'http://127.0.0.1:' + port + LOOPBACK_REDIRECT_PATH,
    waitForCode: () => code,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * 换 token 与续期共用的请求。
 *
 * @param form - 表单体，`grant_type` 由调用方决定。
 * @param dpopPrivateJwk - 签 DPoP proof 的私钥；每次请求都要新 `jti`。
 * @returns 归一后的凭据。
 * @throws 上游非 2xx、响应不是 JSON、或缺少 AK/SK/security_token 时。
 */
async function requestToken(
  fetcher: AuthFetch,
  form: URLSearchParams,
  dpopPrivateJwk: DpopJwk,
): Promise<StsCredential> {
  const response = await fetcher(STS_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: signDpopProof(dpopPrivateJwk, STS_TOKEN_URL),
    },
    body: form.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // 只截断长度：响应体可能带上游给的令牌片段，禁止整段落日志。
    throw new Error('换 token 失败：HTTP ' + response.status + ' ' + text.slice(0, 200));
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('换 token 响应不是 JSON');
  }
  return normalizeToken(json, dpopPrivateJwk);
}

/**
 * 把上游 token 响应归一成 {@link StsCredential}。
 *
 * 响应里没有 refresh_token 时留空串：华为每次续期都换一个新 token，旧的那份此刻已
 * 失效，不能拿它顶替（那样下一次续期必然被拒）。
 *
 * @param json - 已解析的响应体。
 * @param dpopPrivateJwk - 本次请求用的私钥，与 refresh_token 绑定。
 * @throws 缺 AK/SK/security_token 时。
 */
function normalizeToken(json: unknown, dpopPrivateJwk: DpopJwk): StsCredential {
  const credentials = asRecord(asRecord(json)['credentials']);
  const accessKeyId = pickString(credentials, 'access_key_id', 'AccessKeyID');
  const secretAccessKey = pickString(credentials, 'secret_access_key', 'SecretAccessKey');
  const securityToken = pickString(credentials, 'security_token', 'SecurityToken');
  if (accessKeyId === '' || secretAccessKey === '' || securityToken === '') {
    throw new Error('换 token 响应缺少凭据');
  }
  const root = asRecord(json);
  return {
    accessKeyId,
    secretAccessKey,
    securityToken,
    projectId: pickString(credentials, 'project_id', 'ProjectID'),
    expiresAt: pickString(credentials, 'expiration', 'Expiration'),
    refreshToken: pickString(root, 'refresh_token', 'RefreshToken'),
    dpopPrivateJwk,
    domainId: pickString(root, 'domain_id'),
  };
}

/**
 * 拼授权页地址。
 *
 * 果办套了一层登录页：真正的授权地址作为 `service` 参数整条塞进去，所以内层参数只
 * encode 一次、`service` 再整体 encode 一次。
 *
 * @param input - state、PKCE challenge 与实际使用的 redirect_uri。
 * @returns 可直接交给浏览器的地址。
 */
function buildAuthorizeUrl(input: AuthorizeInput): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code_challenge: input.challenge,
    code_challenge_method: PKCE_METHOD,
    state: input.state,
    scope: 'openid',
    redirect_uri: input.redirectUri,
    response_type: 'code',
  });
  const inner = AUTH_BASE + AUTHORIZE_PATH + '?' + params.toString();
  return LOGIN_PAGE + '?service=' + encodeURIComponent(inner);
}

/**
 * 生成 PKCE 对。
 *
 * verifier 取 64 字节随机数的 base64url；method 必须写成 `SHA-256`，写成 `S256` 会被
 * IAM 报 `IAM.0007`。
 */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

/** PKCE 的 method 字面量；服务端只认这一个写法。 */
const PKCE_METHOD = 'SHA-256';

/** 读取嵌套字段；任一层不是对象或值不是非空字符串时返回空串。 */
function nestedString(value: unknown, ...path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current !== '' ? current : undefined;
}

/** 把未知值收敛成对象；非对象给空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 按顺序取第一个非空字符串字段；都没有返回空串。 */
function pickString(record: Record<string, unknown>, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * 睡一会儿。
 *
 * 刻意**不** unref：调用方 await 登录结果时若没有别的句柄，unref 的计时器会让进程
 * 直接退出，登录永远不结算。单次最长只有一个轮询间隔（默认 2 秒）。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
