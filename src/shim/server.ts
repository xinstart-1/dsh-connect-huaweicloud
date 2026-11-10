/**
 * 回环 shim：让「换号」发生在第一个字节交给客户端之前。
 *
 * 非目标：不做协议翻译（果办网关本就是 OpenAI 兼容），也不做模型目录（`/v1/models`
 * 由 adapter 侧的目录回调负责，契约没给这条端点）。
 *
 * 依赖：全部行为由注入的 `attempts` / `chat` 提供，本文件不读磁盘、不读时钟、不知道账号池。
 *
 * 不变量：只监听 `127.0.0.1` 的随机端口；请求必须带对 Bearer；请求体上限 8 MiB；
 * 已经写出至少一帧后绝不重试 —— 重放会让客户端收到两段拼接的回答。
 *
 * @module dsh-connect-huaweicloud/shim/server
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FailureKind } from '../protocol/errors.ts';
import type { GatewayCredential } from '../types.ts';

/**
 * `UpstreamError` 的公开字段子集（`message` 走 `Error` 自带的那个）。
 *
 * 刻意声明成**接口**而不是同名类：`chat` 抛的一定是对面模块里的真类，本文件若用
 * `instanceof` 自己的替身类，接上真模块的那一刻所有错误都会退化成 `server`。
 * 所以只按 `kind` 这个字段做结构化判定。
 */
interface UpstreamFailure {
  readonly kind: FailureKind;
  readonly status: number;
  readonly upstreamCode?: string;
}

/** 一个可尝试的账号；`gateway` 只被转交给 `chat`，shim 自己不读其中的密钥。 */
export interface ShimAttempt {
  readonly attemptId: string;
  readonly gateway: GatewayCredential;
}

/** shim 的全部依赖。 */
export interface ShimOptions {
  /** 按优先级返回候选账号（已由池过滤排序）；每次请求调用一次，池状态会变。 */
  attempts: () => Promise<readonly ShimAttempt[]>;
  /** 用一个账号发流；打不开时抛 `UpstreamError`。 */
  chat: (input: {
    attempt: ShimAttempt;
    body: unknown;
    signal?: AbortSignal;
  }) => Promise<AsyncIterable<Uint8Array>>;
  /** 某个账号失败时回调（池据此记冷却）。 */
  onFailure?: (detail: { attemptId: string; kind: FailureKind; message: string }) => void;
  /** 某个账号真把流跑完时回调。 */
  onSuccess?: (attemptId: string) => void;
  /** 诊断日志；换号、放弃都会写一条。 */
  onWarn?: (message: string) => void;
}

/** 启动后的句柄。 */
export interface ShimHandle {
  /** 形如 `http://127.0.0.1:54321`，不含 `/v1`。 */
  readonly baseUrl: string;
  /** 进程内随机密钥；真实令牌永不出宿主进程。 */
  readonly token: string;
  /** 停止监听并等在途请求收尾；幂等。 */
  close(): Promise<void>;
}

/** 唯一的端点。 */
const CHAT_PATH = '/v1/chat/completions';

/** 请求体上限。超过即刻判超限，不把整个体读进内存再判断。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * 值得换号的失败分类。
 *
 * 只有「换一个账号可能不同」的失败才在里面：`client` 是请求体本身不合法、
 * `model-unavailable` / `not-found` 是模型级问题，同一份请求换谁都一样，
 * 重试只会让用户多等一轮看到同一个错误。
 */
const RETRYABLE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'authentication',
  'hard-credit',
  'soft-rate',
  'server',
]);

/** 放弃时回给下游的 HTTP 状态；与 OpenAI 兼容客户端的期望对齐。 */
const STATUS_BY_KIND: Readonly<Record<FailureKind, number>> = {
  authentication: 401,
  'hard-credit': 402,
  server: 502,
  'soft-rate': 429,
  client: 400,
  'model-unavailable': 403,
  'not-found': 404,
};

/** 全部合法分类（判定任意异常是不是上游错误时用）。 */
const FAILURE_KINDS: readonly FailureKind[] = [
  'authentication',
  'hard-credit',
  'server',
  'soft-rate',
  'client',
  'model-unavailable',
  'not-found',
];

/** 一次失败归一后的样子：`kind` 决定换不换号，`message` 决定回给客户端什么。 */
interface ShimFailure {
  readonly kind: FailureKind;
  readonly message: string;
  readonly status: number;
}

/** 请求体超限的内部信号；只在本文件的读取器与处理器之间传递。 */
class BodyTooLargeError extends Error {
  constructor() {
    super('请求体超过 8 MiB 上限');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * 判断一个值是不是合法的失败分类。
 *
 * @param value - 任意值。
 * @returns 是七种分类之一时为 true。
 */
function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value);
}

/**
 * 把任意异常归一成 `ShimFailure`。
 *
 * 上游错误按 `kind` 字段识别（见 {@link UpstreamFailure} 的说明），
 * 其它异常（网络抖动、socket 断开）一律当 `server`——它们是「换一个账号也许能成」。
 *
 * @param error - `chat` 或中止后抛出的任意值。
 * @returns 分类、文案与回给下游的状态码。
 */
function failureOf(error: unknown): ShimFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof error === 'object' && error !== null) {
    const records = error as { kind?: unknown; status?: unknown };
    if (isFailureKind(records.kind)) {
      const kind = records.kind;
      const declared = typeof records.status === 'number' ? records.status : STATUS_BY_KIND[kind];
      return { kind, message, status: declared };
    }
  }
  return { kind: 'server', message, status: STATUS_BY_KIND['server'] };
}

/**
 * 读完整请求体，超过上限立刻失败。
 *
 * 判超限后只做排空（`resume()`）不再累积：直接断 socket 会让客户端拿不到 413，
 * 而继续往数组里塞字节则等于让一个坏请求把内存打满。
 *
 * @param req - 请求。
 * @returns UTF-8 请求体。
 * @throws {@link BodyTooLargeError} 超过 {@link MAX_BODY_BYTES}。
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * 常量时间校验 Bearer 令牌。
 *
 * 长度不等必须先返回 false：`timingSafeEqual` 对不等长输入直接抛异常。
 *
 * @param header - `Authorization` 头的原文。
 * @param expected - 本进程的令牌字节。
 * @returns 令牌正确时为 true。
 */
function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = /^Bearer\s+(.+)$/iu.exec(header?.trim() ?? '');
  const presentedText = match?.[1];
  if (presentedText === undefined) return false;
  const presented = Buffer.from(presentedText.trim(), 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

/**
 * 写一个 OpenAI 形状的错误响应。
 *
 * @param res - 响应。
 * @param status - HTTP 状态码。
 * @param code - 稳定的错误码（写进 `error.code`）。
 * @param message - 人话说明。
 */
function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: { message, type: code, code } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 一次透传的结果：决定还能不能换号。 */
type RelayOutcome =
  | { readonly kind: 'complete' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'broken'; readonly error: unknown };

/**
 * 把一条上游字节流原样写给客户端。
 *
 * 第一帧取到之前不写响应头：那一帧之前的任何失败都还没被客户端看到，
 * 换号是安全的。一旦写下 200，后续失败只能收尾（`broken`），绝不能重开一条回复。
 *
 * @param stream - `chat` 给出的字节流。
 * @param res - 响应。
 * @param signal - 客户端断开时被中止。
 * @returns 透传结果。
 */
async function relay(
  stream: AsyncIterable<Uint8Array>,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<RelayOutcome> {
  const iterator = stream[Symbol.asyncIterator]();
  let first: IteratorResult<Uint8Array>;
  try {
    first = await iterator.next();
  } catch (error) {
    return { kind: 'failed', error };
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    if (first.done !== true) res.write(first.value);
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) break;
      if (signal.aborted) {
        if (!res.writableEnded) res.end();
        return { kind: 'aborted' };
      }
      res.write(step.value);
    }
    if (!res.writableEnded) res.end();
    return { kind: 'complete' };
  } catch (error) {
    // 字节已经发出去了：这一轮只能到此为止，重放会拼出两段回答。
    if (!res.writableEnded) res.end();
    return { kind: 'broken', error };
  } finally {
    try {
      await iterator.return?.();
    } catch {
      // 上游清理失败不影响已经写出的响应。
    }
  }
}

/**
 * 启动 shim。
 *
 * @param options - 候选序列、上游调用与回调。
 * @returns 句柄；`baseUrl` 与 `token` 交给 adapter。
 * @throws 端口监听失败（此时已经关掉自己，不留半开的服务器）。
 */
export async function startShim(options: ShimOptions): Promise<ShimHandle> {
  const token = randomBytes(32).toString('base64url');
  const expectedToken = Buffer.from(token, 'utf8');
  const warn = options.onWarn ?? ((message: string): void => void message);
  /** 在途请求；`close()` 要等它们收尾。 */
  const inflight = new Set<Promise<void>>();

  const server: Server = createServer((req, res) => {
    const task: Promise<void> = handle(req, res).catch((error: unknown) => {
      // 任何没被处理的异常都只在本条连接内消化，绝不外抛到进程。
      writeError(res, 500, 'shim-error', error instanceof Error ? error.message : String(error));
    });
    inflight.add(task);
    // 完成时把自己从在途集合里摘掉；`task` 已带 catch，这里不会产生未处理拒绝。
    void task.then(() => inflight.delete(task));
  });

  /**
   * 一路请求的入口：路由、方法、鉴权之后交给 {@link serveChat}。
   *
   * @param req - 请求。
   * @param res - 响应。
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path !== CHAT_PATH) {
      writeError(res, 404, 'not-found', 'shim 只提供 POST /v1/chat/completions');
      return;
    }
    if (req.method !== 'POST') {
      writeError(res, 405, 'method-not-allowed', '只接受 POST');
      return;
    }
    if (!authorized(req.headers.authorization, expectedToken)) {
      writeError(res, 401, 'unauthorized', '未授权');
      return;
    }
    await serveChat(req, res);
  }

  /**
   * 换号主循环：按候选顺序试，直到某次真的把字节写给客户端。
   *
   * @param req - 请求（只用来读体与感知断开）。
   * @param res - 响应。
   */
  async function serveChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        writeError(res, 413, 'payload-too-large', '请求体超过 8 MiB 上限');
        return;
      }
      writeError(res, 400, 'bad-request', '请求体读取失败');
      return;
    }

    let body: unknown;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        writeError(res, 400, 'bad-request', '请求体必须是 JSON 对象');
        return;
      }
      body = parsed;
    } catch {
      writeError(res, 400, 'bad-request', '请求体不是合法 JSON');
      return;
    }

    let attempts: readonly ShimAttempt[];
    try {
      attempts = await options.attempts();
    } catch (error) {
      options.onWarn?.(
        `取候选账号失败：${error instanceof Error ? error.message : String(error)}`,
      );
      writeError(res, 503, 'not-configured', '没有可用账号');
      return;
    }
    if (attempts.length === 0) {
      writeError(res, 503, 'not-configured', '没有可用账号，请先在插件卡片里登录或同步');
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      // 客户端点了停止：把上游连接也断开，别让对面继续算。
      if (!res.writableEnded) controller.abort();
    });

    const reportFailure = (attemptId: string, failure: ShimFailure): void => {
      options.onFailure?.({ attemptId, kind: failure.kind, message: failure.message });
    };

    const warnFailover = (fromId: string, toId: string | undefined, failure: ShimFailure): void => {
      warn(
        toId === undefined
          ? `账号 ${fromId} 失败（${failure.kind}：${failure.message}），没有更多候选`
          : `账号 ${fromId} 失败（${failure.kind}：${failure.message}），换到 ${toId}`,
      );
    };

    let lastFailure: ShimFailure = { kind: 'server', message: '没有尝试任何账号', status: 502 };

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      if (attempt === undefined) continue;
      const nextId = attempts[index + 1]?.attemptId;

      let stream: AsyncIterable<Uint8Array>;
      try {
        stream = await options.chat({ attempt, body, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = failureOf(error);
        lastFailure = failure;
        // 每个被放弃的账号都记一次：全池失败时宿主也要知道谁试过、怎么坏的。
        reportFailure(attempt.attemptId, failure);
        if (!RETRYABLE_KINDS.has(failure.kind)) {
          writeError(res, failure.status, failure.kind, failure.message);
          return;
        }
        warnFailover(attempt.attemptId, nextId, failure);
        continue;
      }

      const outcome = await relay(stream, res, controller.signal);
      if (outcome.kind === 'complete') {
        options.onSuccess?.(attempt.attemptId);
        return;
      }
      if (outcome.kind === 'aborted') return;
      if (outcome.kind === 'broken') {
        // 流已经开始：不重试，只记账。
        const failure = failureOf(outcome.error);
        reportFailure(attempt.attemptId, failure);
        warn(`账号 ${attempt.attemptId} 的流中途断开（${failure.message}），已发出的内容保留`);
        return;
      }
      // 第一帧都没拿到：与 `chat` 打不开同等对待，可以换号。
      if (controller.signal.aborted) return;
      const failure = failureOf(outcome.error);
      lastFailure = failure;
      reportFailure(attempt.attemptId, failure);
      if (!RETRYABLE_KINDS.has(failure.kind)) {
        writeError(res, failure.status, failure.kind, failure.message);
        return;
      }
      warnFailover(attempt.attemptId, nextId, failure);
    }

    writeError(res, lastFailure.status, lastFailure.kind, lastFailure.message);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new Error('shim 未能取得监听端口');
  }

  // 监听成功之后的错误（重置、半开连接）只记日志：它们不该把宿主进程带崩。
  server.on('error', (error: Error) => {
    warn(`shim 服务器错误：${error.message}`);
  });

  let closing: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    // 空闲的 keep-alive 连接不会自己走，先放掉，否则 close 永远等不到回调。
    server.closeIdleConnections();
    await Promise.all([...inflight]);
    server.closeAllConnections();
    await closed;
  };

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    token,
    close: (): Promise<void> => {
      closing ??= shutdown();
      return closing;
    },
  };
}
