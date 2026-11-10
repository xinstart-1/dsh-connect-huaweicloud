/**
 * 果办模型网关（OpenAI 兼容 `/v2`）的协议层：拉目录、开聊天流、把请求体钳进上游硬限。
 * 只产出 SSE 字节流，不解析成消息、不重试、不记账——换号与重放由上层 shim 决定。
 * 两条不变量：
 * 1. 钳制必须在**发请求前**做：`max_tokens` 超限与 `developer` 角色都是流内错误，
 *    HTTP 已经 200，那一轮无法重放。
 * 2. HTTP 200 也可能是错误：网关限流把 `{"error":…}` 塞进 SSE 首帧，直接透传会让上层
 *    收到「流正常结束但没有内容」，所以首帧必须先判定再放行。
 *
 * @module dsh-connect-huaweicloud/protocol/client
 */

import { CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MAAS_PATH_PREFIX, REQUEST_TIMEOUT_MS } from '../constants.ts';
import type { GatewayCredential } from '../types.ts';
import { huaweiBasicAuth } from '../auth/sign.ts';
import { UpstreamError, classifyFailure } from './errors.ts';

/** 目录里的一行模型；字段全部由 id 推断，上游只回 id。 */
export interface GatewayModel {
  readonly id: string;
  /** 展示名；与 `id` 相同，上游不给人类可读名。 */
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** 由 id 推断（`vl` / `vision` / `multimodal`）；不可靠时为 `false`，宁可不发图。 */
  readonly supportsImages: boolean;
}

/** 首帧判定的缓冲上限：超过就放弃判定直接透传，避免把无限流扣在内存里。 */
const MAX_PROBE_BYTES = 64 * 1024;

/** 图片块在无视觉能力的模型上被替换成的文字。 */
const IMAGE_PLACEHOLDER = '[图片已省略]';

/** 流内错误没有 HTTP 状态码，统一记成这个值，便于与上游 200 区分。 */
const STREAM_ERROR_STATUS = 502;

/**
 * 拉模型目录。
 *
 * @param gateway - 网关凭据；`base` 缺 `/v2` 时由本函数补齐。
 * @param signal - 取消信号。
 * @returns 目录里的模型；`data`/`models` 两种形状都认。
 * @throws {UpstreamError} 上游非 2xx、响应不是 JSON、或目录为空时。
 */
export async function listModels(gateway: GatewayCredential, signal?: AbortSignal): Promise<GatewayModel[]> {
  const response = await request(`${gatewayBase(gateway)}/models`, {
    method: 'GET',
    headers: {
      Authorization: huaweiBasicAuth(gateway.appKey, gateway.appSecret),
      Accept: 'application/json',
    },
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await readText(response);
  if (!response.ok) throw failureFrom(response.status, text);

  const body = asRecord(parseJson(text));
  const rows = Array.isArray(body?.['data']) ? body['data'] : Array.isArray(body?.['models']) ? body['models'] : [];
  const models: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row === 'string' ? row.trim() : firstString(asRecord(row)?.['id']);
    // 去重：上游目录里偶有同 id 重复行，重复注册会让模型选择器出现两行同款。
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      contextWindow: CONTEXT_WINDOW,
      maxTokens: MAX_OUTPUT_TOKENS,
      supportsImages: /vl|vision|multimodal/i.test(id),
    });
  }
  if (models.length === 0) {
    // 空目录只说明「这个凭据背后没有可开通的模型」，不该按凭据损坏处理：
    // 按 authentication 记会让一个可能健康的账号被停用一小时。
    throw new UpstreamError('果办模型目录为空：当前凭据没有任何可用模型', {
      kind: 'model-unavailable',
      status: response.status,
    });
  }
  return models;
}

/**
 * 发一次对话请求。
 *
 * @param input - 网关凭据、已钳制的 OpenAI 请求体、取消信号。
 * @returns 已做首帧错误检查的 SSE 字节流；字节原样透传，不重新编码。
 * @throws {UpstreamError} 上游非 2xx，或首帧就是 `{"error":…}` 时。
 */
export async function chatStream(input: {
  gateway: GatewayCredential;
  body: unknown;
  signal?: AbortSignal;
}): Promise<AsyncIterable<Uint8Array>> {
  const body = asRecord(input.body);
  if (body === undefined) {
    throw new UpstreamError('请求体必须是 JSON 对象', { kind: 'client', status: 400 });
  }
  const response = await request(`${gatewayBase(input.gateway)}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: huaweiBasicAuth(input.gateway.appKey, input.gateway.appSecret),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok || response.body === null) {
    throw failureFrom(response.status, await readText(response));
  }
  return guardFirstFrame(response.body);
}

/**
 * 把请求体钳到上游硬限以内。
 *
 * 纯函数：不修改入参，原对象可被冻结。无法识别的形状原样返回，由上游回 400——
 * 在这里猜结构只会把真正的参数错误改成另一个错。
 *
 * @param body - 待发送的 OpenAI 请求体（`unknown`，逐字段校验）。
 * @param model - 目标模型；`supportsImages` 决定图片块是否降级。
 * @returns 新对象；钳制未命中任何一条时字段值保持不变。
 */
export function clampRequestBody(body: unknown, model: GatewayModel): unknown {
  const source = asRecord(body);
  if (source === undefined) return body;
  const out: Record<string, unknown> = { ...source };

  out['max_tokens'] = clampTokens(source['max_tokens']);
  out['max_completion_tokens'] = clampTokens(source['max_completion_tokens']);

  const messages = source['messages'];
  if (Array.isArray(messages)) {
    out['messages'] = messages.map((message) => rewriteMessage(message, model.supportsImages));
  }
  return out;
}

/**
 * 发一次 HTTP 请求：超时只覆盖到响应头。
 *
 * 为什么不等读完流：45 秒对长回答是常态，把流也圈进超时会把正常生成掐断；
 * 流内的空闲判定交给调用方。
 */
async function request(url: string, init: RequestInit): Promise<Response> {
  const caller = init.signal;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const forward = (): void => controller.abort();
  caller?.addEventListener('abort', forward, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (caller?.aborted === true) throw error;
    if (timedOut) {
      throw new UpstreamError(`果办模型网关 ${REQUEST_TIMEOUT_MS / 1000} 秒内没有响应`, {
        kind: 'server',
        status: 0,
        cause: error,
      });
    }
    throw new UpstreamError(`无法连接果办模型网关：${errorText(error)}`, { kind: 'server', status: 0, cause: error });
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener('abort', forward);
  }
}

/**
 * 首帧伪错误检查。
 *
 * 网关限流时回 HTTP 200 + `data:{"error":…}`；不透传就无法与「模型一个字没说」区分。
 * 首帧判定完就把缓冲整段吐出去，之后的字节不再解析——重新编码会破坏多字节字符边界。
 */
async function* guardFirstFrame(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder('utf-8');
  const pending: Uint8Array[] = [];
  let text = '';
  let bytes = 0;
  let decided = false;

  for await (const chunk of iterate(stream)) {
    if (decided) {
      yield chunk;
      continue;
    }
    pending.push(chunk);
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    const frameEnd = firstFrameEnd(text);
    if (frameEnd !== -1) {
      throwIfErrorFrame(text.slice(0, frameEnd));
      decided = true;
      for (const buffered of pending.splice(0)) yield buffered;
      continue;
    }
    if (bytes > MAX_PROBE_BYTES) {
      // 首帧异常大（如超长 system prompt 回显）：判定成本超过收益，直接放行。
      decided = true;
      for (const buffered of pending.splice(0)) yield buffered;
    }
  }
  if (pending.length > 0) {
    // 流在首帧结束前就断了：整段缓冲即是全部内容，仍值得判一次错误。
    if (!decided) throwIfErrorFrame(text);
    for (const buffered of pending.splice(0)) yield buffered;
  }
}

/** 从一帧 SSE 文本里提取上游错误；没有错误时安静返回。 */
function throwIfErrorFrame(frame: string): void {
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    const body = asRecord(parseJson(payload));
    if (body === undefined || body['error'] === undefined || body['error'] === null) continue;
    const kind = classifyFailure(STREAM_ERROR_STATUS, payload);
    throw new UpstreamError(kind.message, {
      kind: kind.kind,
      status: STREAM_ERROR_STATUS,
      ...(kind.upstreamCode === undefined ? {} : { upstreamCode: kind.upstreamCode }),
    });
  }
}

/** 找首帧的结束位置（`\n\n` 或 `\r\n\r\n`）；还没收全返回 -1。 */
function firstFrameEnd(text: string): number {
  const match = /\r?\n\r?\n/.exec(text);
  return match === null ? -1 : match.index;
}

/** `ReadableStream` → 异步迭代；Node 的类型没有暴露 `[Symbol.asyncIterator]`。 */
async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) return;
      yield step.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 网关基址：去掉尾部斜杠并保证带 `/v2`（云端下发的主机名不带它）。
 *
 * @param gateway - 网关凭据。
 * @returns 可直接拼接 `/models`、`/chat/completions` 的前缀。
 */
function gatewayBase(gateway: GatewayCredential): string {
  const base = gateway.base.replace(/\/+$/, '');
  return base.endsWith(MAAS_PATH_PREFIX) ? base : base + MAAS_PATH_PREFIX;
}

/** 读响应体文本；读失败当成空体，让状态码决定分类而不是让 IO 异常冒出去。 */
async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** 非 2xx 响应 → 统一错误；分类与文案都来自 {@link classifyFailure}。 */
function failureFrom(status: number, text: string): UpstreamError {
  const failure = classifyFailure(status, text);
  return new UpstreamError(failure.message, {
    kind: failure.kind,
    status,
    ...(failure.upstreamCode === undefined ? {} : { upstreamCode: failure.upstreamCode }),
  });
}

/** 单项令牌上限钳制；非数字或未超限时原样返回，避免给上游凭空加字段。 */
function clampTokens(value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  return value > MAX_OUTPUT_TOKENS ? MAX_OUTPUT_TOKENS : value;
}

/** 单条消息：`developer` 角色降级，无视觉能力的模型上图片块换文字占位。 */
function rewriteMessage(message: unknown, supportsImages: boolean): unknown {
  const source = asRecord(message);
  if (source === undefined) return message;
  const out: Record<string, unknown> = { ...source };
  // 上游把 developer 角色当成空角色，回 InferHub.001001044.400；system 语义等价。
  if (out['role'] === 'developer') out['role'] = 'system';
  const content = out['content'];
  if (!supportsImages && Array.isArray(content)) {
    out['content'] = content.map((block) => (isImageBlock(block) ? { type: 'text', text: IMAGE_PLACEHOLDER } : block));
  }
  return out;
}

/** 图片块判定：OpenAI 的 `image_url` 与部分网关用的 `image` 都要认。 */
function isImageBlock(block: unknown): boolean {
  const type = asRecord(block)?.['type'];
  return type === 'image_url' || type === 'image';
}

/** 解析 JSON；非 JSON 是上游常态（HTML 网关页），因此返回 `undefined` 而不是抛。 */
function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 把 `unknown` 收窄成普通对象；数组与 null 都不算。 */
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

/** 异常压成一句，避免把堆栈灌进错误气泡。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
