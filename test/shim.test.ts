/**
 * shim 测试：认证边界、换号顺序、不换号的失败、流中断不重试。
 *
 * 用真 HTTP 请求打跑起来的 shim（随机端口，每个 test 结束时关闭）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startShim, type ShimAttempt, type ShimOptions } from '../src/shim/server.ts';
import { UpstreamError } from '../src/protocol/errors.ts';
import type { GatewayCredential } from '../src/types.ts';

/** 造一个网关凭据；shim 自己不用它，只是转交给 `chat`。 */
function gatewayOf(label: string): GatewayCredential {
  return { base: 'https://' + label + '.example.com/v2', appKey: label, appSecret: label };
}

/** 造一个 async 生成器，产出给定文本。 */
async function* frames(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

/** 向 shim 发一次对话请求。 */
async function postChat(
  handle: { baseUrl: string; token: string },
  options: { token?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(handle.baseUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (options.token ?? handle.token),
    },
    body: JSON.stringify(options.body ?? { model: 'glm-5.3', messages: [] }),
  });
}

/** 起一个 shim，跑完关掉。 */
async function withShim(
  options: Partial<ShimOptions> & Pick<ShimOptions, 'attempts' | 'chat'>,
  run: (handle: { baseUrl: string; token: string }) => Promise<void>,
): Promise<void> {
  const handle = await startShim({
    attempts: options.attempts,
    chat: options.chat,
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.onSuccess === undefined ? {} : { onSuccess: options.onSuccess }),
    ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }),
  });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

describe('认证边界', () => {
  test('没有 Authorization 头 → 401', async () => {
    await withShim(
      {
        attempts: () => Promise.resolve([]),
        chat: () => Promise.resolve(frames('')),
      },
      async (handle) => {
        const response = await fetch(handle.baseUrl + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 401);
      },
    );
  });

  test('错误的 token → 401', async () => {
    await withShim(
      {
        attempts: () => Promise.resolve([]),
        chat: () => Promise.resolve(frames('')),
      },
      async (handle) => {
        const response = await postChat(handle, { token: 'wrong-token' });
        assert.equal(response.status, 401);
      },
    );
  });

  test('正确 token → 200 且字节与注入的 chat 一致', async () => {
    const payload = 'data:{"choices":[{"delta":{"content":"你好"}}]}\n\ndata:[DONE]\n\n';
    const attempt: ShimAttempt = { attemptId: 'acc_a', gateway: gatewayOf('a') };
    await withShim(
      {
        attempts: () => Promise.resolve([attempt]),
        chat: () => Promise.resolve(frames(payload)),
      },
      async (handle) => {
        const response = await postChat(handle);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), payload);
      },
    );
  });
});

describe('换号', () => {
  test('首个账号认证失败 → 换下一个，客户端只收到成功那个的内容', async () => {
    const calls: string[] = [];
    const attempts: ShimAttempt[] = [
      { attemptId: 'acc_a', gateway: gatewayOf('a') },
      { attemptId: 'acc_b', gateway: gatewayOf('b') },
    ];
    await withShim(
      {
        attempts: () => Promise.resolve(attempts),
        chat: ({ attempt }) => {
          calls.push(attempt.attemptId);
          if (attempt.attemptId === 'acc_a') {
            return Promise.reject(new UpstreamError('凭据失效', { kind: 'authentication', status: 401 }));
          }
          return Promise.resolve(frames('来自 B 的回答'));
        },
      },
      async (handle) => {
        const response = await postChat(handle);
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.ok(text.includes('来自 B 的回答'), `应拿到 B 的内容，实际 ${text}`);
        assert.deepEqual(calls, ['acc_a', 'acc_b'], '应按顺序试两个账号');
      },
    );
  });

  test('kind 为 client 的失败 → 不换号（只调一次）', async () => {
    let callCount = 0;
    const attempts: ShimAttempt[] = [
      { attemptId: 'acc_a', gateway: gatewayOf('a') },
      { attemptId: 'acc_b', gateway: gatewayOf('b') },
    ];
    await withShim(
      {
        attempts: () => Promise.resolve(attempts),
        chat: () => {
          callCount += 1;
          return Promise.reject(new UpstreamError('请求体不合法', { kind: 'client', status: 400 }));
        },
      },
      async (handle) => {
        const response = await postChat(handle);
        // 同一个请求体换谁都一样 400，重试只是让用户多等几轮看到同一个错误。
        assert.equal(callCount, 1, `client 分类不该换号，实际调了 ${String(callCount)} 次`);
        assert.notEqual(response.status, 200);
      },
    );
  });

  test('流已开始后断开 → 不重试，客户端收到已发出的那一帧', async () => {
    let callCount = 0;
    const attempts: ShimAttempt[] = [
      { attemptId: 'acc_a', gateway: gatewayOf('a') },
      { attemptId: 'acc_b', gateway: gatewayOf('b') },
    ];
    await withShim(
      {
        attempts: () => Promise.resolve(attempts),
        chat: () => {
          callCount += 1;
          // 先 yield 一帧，再抛错：字节已经发出去了。
          return Promise.resolve(
            (async function* broken(): AsyncGenerator<Uint8Array> {
              yield new TextEncoder().encode('data:{"choices":[{"delta":{"content":"前半段"}}]}\n\n');
              throw new UpstreamError('上游中途断了', { kind: 'server', status: 502 });
            })(),
          );
        },
      },
      async (handle) => {
        const response = await postChat(handle);
        const text = await response.text();
        assert.ok(text.includes('前半段'), `已发出的帧应保留，实际 ${text}`);
        // 重放会拼出两段回答，所以绝不能换号重试。
        assert.equal(callCount, 1, `流中断不该重试，实际调了 ${String(callCount)} 次`);
      },
    );
  });

  test('全部候选失败 → 返回错误状态，onFailure 被逐次调用', async () => {
    const failures: string[] = [];
    const attempts: ShimAttempt[] = [
      { attemptId: 'acc_a', gateway: gatewayOf('a') },
      { attemptId: 'acc_b', gateway: gatewayOf('b') },
    ];
    await withShim(
      {
        attempts: () => Promise.resolve(attempts),
        chat: () => Promise.reject(new UpstreamError('上游 502', { kind: 'server', status: 502 })),
        onFailure: (detail) => {
          failures.push(detail.attemptId);
        },
      },
      async (handle) => {
        const response = await postChat(handle);
        assert.notEqual(response.status, 200, '全失败不该返回 200');
        assert.deepEqual(failures, ['acc_a', 'acc_b'], `应逐次回报失败，实际 ${failures.join(',')}`);
      },
    );
  });

  test('成功时 onSuccess 回报实际服务的账号', async () => {
    const served: string[] = [];
    const attempt: ShimAttempt = { attemptId: 'acc_ok', gateway: gatewayOf('ok') };
    await withShim(
      {
        attempts: () => Promise.resolve([attempt]),
        chat: () => Promise.resolve(frames('ok')),
        onSuccess: (attemptId) => {
          served.push(attemptId);
        },
      },
      async (handle) => {
        await postChat(handle);
        assert.deepEqual(served, ['acc_ok']);
      },
    );
  });
});

describe('请求边界', () => {
  test('候选为空 → 返回错误而不是挂住', async () => {
    await withShim(
      {
        attempts: () => Promise.resolve([]),
        chat: () => Promise.resolve(frames('')),
      },
      async (handle) => {
        const response = await postChat(handle);
        assert.notEqual(response.status, 200);
      },
    );
  });

  test('只监听回环地址', async () => {
    await withShim(
      {
        attempts: () => Promise.resolve([]),
        chat: () => Promise.resolve(frames('')),
      },
      async (handle) => {
        assert.ok(handle.baseUrl.startsWith('http://127.0.0.1:'), `必须只监听回环，实际 ${handle.baseUrl}`);
      },
    );
  });
});
