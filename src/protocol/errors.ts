/**
 * 上游失败的分类与统一错误：池据 {@link FailureKind} 决定换号、冷却还是原样报错。
 * 只读 HTTP 状态与响应体文本，不发请求、不重试；网络层失败由调用方以 status 0 传入。
 * 分错比漏判贵得多——`client` 会白烧一次真实额度，`authentication` 会把健康账号停用一小时，
 * 所以业务码优先于状态码，状态码只做兜底。
 *
 * @module dsh-connect-huaweicloud/protocol/errors
 */

/** 失败分类；池据此决定要不要换号。 */
export type FailureKind =
  /** 401/403：凭据坏了 → 换号。 */
  | 'authentication'
  /** 402/额度耗尽 → 换号 + 冷却。 */
  | 'hard-credit'
  /** 5xx/网络 → 换号 + 短冷却。 */
  | 'server'
  /** 429 → 换号 + 15s 冷却。 */
  | 'soft-rate'
  /** 400 请求本身不合法 → **不换号**。 */
  | 'client'
  /** 403/404 但文案指向模型级拒绝 → **不惩罚账号**。 */
  | 'model-unavailable'
  /** 路径或模型名根本不存在。 */
  | 'not-found';

/** 一次上游失败的统一载体；`message` 已是给用户看的一句话。 */
export class UpstreamError extends Error {
  /** 分类，见 {@link FailureKind}。 */
  readonly kind: FailureKind;
  /** HTTP 状态码；网络层失败为 0，SSE 流内错误按错误码推断。 */
  readonly status: number;
  /** 上游给的业务码（形如 `ModelArts.81001`），有则带上。 */
  readonly upstreamCode?: string;

  /**
   * @param message - 已压缩成人话的失败原因；不拼协议层细节，调用方直接展示。
   * @param init - 分类、状态码与可选业务码；`cause` 只用于保留原始异常。
   */
  constructor(
    message: string,
    init: { kind: FailureKind; status: number; upstreamCode?: string; cause?: unknown },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'UpstreamError';
    this.kind = init.kind;
    this.status = init.status;
    this.upstreamCode = init.upstreamCode;
  }
}

/**
 * 把 HTTP 状态 + 响应体归一成分类与一句人话。
 *
 * @param status - HTTP 状态码；网络层失败传 0。
 * @param text - 原始响应体（可能为空、可能不是 JSON）。
 * @returns 分类结果；`message` 已截断到 300 字符，有上游业务码时拼成 `消息（code）`。
 */
export function classifyFailure(
  status: number,
  text: string,
): { kind: FailureKind; message: string; upstreamCode?: string } {
  const raw = text.trim();
  const body = parseErrorBody(raw);
  const message = body.message ?? (raw === '' ? `果办上游返回 HTTP ${status}` : truncate(raw));
  const kind = kindOf(status, `${body.code ?? ''} ${body.message ?? ''} ${raw}`);
  return {
    kind,
    message: body.message !== undefined && body.code !== undefined ? `${message}（${body.code}）` : message,
    ...(body.code === undefined ? {} : { upstreamCode: body.code }),
  };
}

/** 原文兜底时的截断长度：完整响应体只进日志，不进用户可见文案。 */
const MAX_MESSAGE_CHARS = 300;

/** 错误体里承载文案与业务码的字段解析结果。 */
interface ErrorBody {
  readonly message?: string;
  readonly code?: string;
}

/**
 * 按业务码判定分类。
 *
 * 顺序即优先级：参数类业务码排在泛化的 `limit`/`rate` 之前，否则上游把
 * `max_tokens` 超限描述成「超过 limit」时会被误判成限流，白换一个号。
 */
function kindOf(status: number, haystack: string): FailureKind {
  if (/InferHub\.001001044|Message role cannot empty/iu.test(haystack)) return 'client';
  if (/InferHub\.001001005|ModelArts\.81001|参数非法|invalid[ _]param/iu.test(haystack)) return 'client';
  if (/APIGW\.0101/iu.test(haystack)) return 'not-found';
  if (/ModelArts\.81(?:004|009|010)|Invalid model|No available backend|do not have access/iu.test(haystack)) {
    return 'model-unavailable';
  }
  if (/积分|额度|余额|quota|insufficient[ _]credits?|credits?[ _](?:exhaust|insufficient)/iu.test(haystack)) {
    return 'hard-credit';
  }
  if (/ModelArts\.81114|rate|limit|throttl/iu.test(haystack)) return 'soft-rate';
  if (/APIG\.(?:0301|1009)|APIGW\.0301|AppKey or AppSecret is invalid|decrypt token fail|x-auth-token not found/iu.test(haystack)) {
    return 'authentication';
  }
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'hard-credit';
  if (status === 404) return 'not-found';
  if (status === 429) return 'soft-rate';
  // 200 却带着错误体、408、5xx 都只可能是上游自身问题；网络失败由调用方传 0。
  if (status === 0 || status === 408 || status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'server';
}

/** 从响应体里取文案与业务码；非 JSON、字段缺失都只是「没取到」，不算错误。 */
function parseErrorBody(raw: string): ErrorBody {
  const root = asRecord(parseJson(raw));
  if (root === undefined) return {};
  const nested = asRecord(root['error']);
  const inline = root['error'];
  const message = firstString(
    nested?.['message'],
    nested?.['error_msg'],
    root['error_msg'],
    root['message'],
    typeof inline === 'string' ? inline : undefined,
  );
  const code = firstString(nested?.['code'], nested?.['error_code'], root['error_code'], root['code']);
  return {
    ...(message === undefined ? {} : { message }),
    ...(code === undefined ? {} : { code }),
  };
}

/** 解析 JSON；非 JSON 文本是上游的常态（HTML 网关页、纯文本限流提示），因此不抛。 */
function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 把 unknown 收窄成普通对象；数组与 null 都不算。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 取第一个非空字符串；其余类型一律跳过。 */
function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 超长原文压成一句：截断比把整页 HTML 塞进错误气泡有用。 */
function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}
