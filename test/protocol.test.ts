/**
 * 协议层测试：请求形状、SSE 首帧错误识别、请求体钳制、错误分类。
 *
 * 全部用本机 http server 做替身，不访问公网。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chatStream, clampRequestBody, listModels } from '../src/protocol/client.ts';
import { classifyFailure, UpstreamError } from '../src/protocol/errors.ts';
import { MAX_OUTPUT_TOKENS } from '../src/constants.ts';
import type { GatewayCredential } from '../src/types.ts';

/** 起一个替身 server，跑完关掉。 */
async function withServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  run: (gateway: GatewayCredential, seen: Array<{ url?: string; authorization?: string }>) => Promise<void>,
): Promise<void> {
  const seen: Array<{ url?: string; authorization?: string }> = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const gateway: GatewayCredential = {
    base: `http://127.0.0.1:${String(port)}/v2`,
    appKey: 'AK',
    appSecret: 'SK',
  };
  try {
    await run(gateway, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('模型目录', () => {
  test('请求路径与 Basic 认证头正确，并解出模型', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'deepseek-v4.1-flash' }, { id: 'qwen-vl-max' }] }));
      },
      async (gateway, seen) => {
        const models = await listModels(gateway);
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.url, '/v2/models');
        assert.equal(seen[0]?.authorization, 'Basic ' + Buffer.from('AK:SK', 'utf8').toString('base64'));

        assert.equal(models.length, 3);
        assert.equal(models[0]?.id, 'glm-5.3');
        // 目录只给 id，能力靠 id 推断：含 vl/vision/multimodal 的才认多模态。
        assert.equal(models[0]?.supportsImages, false);
        assert.equal(models[2]?.supportsImages, true);
        assert.equal(models[0]?.contextWindow, 1_000_000);
        assert.equal(models[0]?.maxTokens, MAX_OUTPUT_TOKENS);
      },
    );
  });

  test('上游 401 → 抛 authentication 分类的错误', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid credential', code: 'APIGW.0301' } }));
      },
      async (gateway) => {
        await assert.rejects(
          () => listModels(gateway),
          (error: unknown) => {
            assert.ok(error instanceof UpstreamError, '应抛 UpstreamError');
            assert.equal(error.kind, 'authentication');
            return true;
          },
        );
      },
    );
  });
});

describe('对话流', () => {
  test('请求体带 stream: true，SSE 字节原样透传', async () => {
    const frames = 'data:{"choices":[{"delta":{"content":"你好"}}]}\n\ndata:[DONE]\n\n';
    let body = '';
    await withServer(
      (req, res) => {
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(frames);
        });
      },
      async (gateway) => {
        const stream = await chatStream({ gateway, body: { model: 'glm-5.3', messages: [] } });
        let received = '';
        const decoder = new TextDecoder();
        for await (const chunk of stream) received += decoder.decode(chunk, { stream: true });

        const parsed = JSON.parse(body) as Record<string, unknown>;
        assert.equal(parsed['stream'], true, '必须强制 stream: true');
        assert.equal(received, frames, 'SSE 字节必须原样透传');
      },
    );
  });

  test('HTTP 200 但首帧是错误 → 迭代时抛 UpstreamError（不是返回空流）', async () => {
    // 这是果办限流的真实形态：状态码 200，错误藏在 SSE 首帧里。
    // 直接透传会让上层只看到「流正常结束但没内容」。
    //
    // 注意：错误在**迭代时**抛，不在 `chatStream` 返回时抛 —— 首帧要读到才知道是错误。
    // 所以 shim 必须在把第一帧写给客户端之前完成这一步判定。
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data:{"error":{"message":"并发会话数已达上限","code":"TM.00001041"}}\n\n');
      },
      async (gateway) => {
        const stream = await chatStream({ gateway, body: { model: 'glm-5.3', messages: [] } });
        await assert.rejects(
          async () => {
            for await (const _chunk of stream) {
              // 不该有任何帧被吐出来：首帧本身就是错误。
              assert.fail('首帧是错误时不该透传出任何字节');
            }
          },
          (error: unknown) => {
            assert.ok(error instanceof UpstreamError, '应抛 UpstreamError');
            assert.ok(error.message.includes('并发会话数已达上限'), `错误消息应透出上游文案，实际 ${error.message}`);
            return true;
          },
        );
      },
    );
  });

  test('首帧正常 → 后续帧照常透传', async () => {
    const frames =
      'data:{"choices":[{"delta":{"content":"第一段"}}]}\n\ndata:{"choices":[{"delta":{"content":"第二段"}}]}\n\ndata:[DONE]\n\n';
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(frames);
      },
      async (gateway) => {
        const stream = await chatStream({ gateway, body: { model: 'glm-5.3', messages: [] } });
        let received = '';
        const decoder = new TextDecoder();
        for await (const chunk of stream) received += decoder.decode(chunk, { stream: true });
        assert.ok(received.includes('第一段'));
        assert.ok(received.includes('第二段'));
      },
    );
  });
});

describe('请求体钳制', () => {
  const textModel = {
    id: 'glm-5.3',
    name: 'glm-5.3',
    contextWindow: 1_000_000,
    maxTokens: MAX_OUTPUT_TOKENS,
    supportsImages: false,
  };

  test('max_tokens 超限 → 钳到上限', () => {
    const clamped = clampRequestBody({ max_tokens: 999_999, messages: [] }, textModel) as Record<string, unknown>;
    assert.equal(clamped['max_tokens'], MAX_OUTPUT_TOKENS);
  });

  test('role: developer → 改写成 system', () => {
    const clamped = clampRequestBody(
      { messages: [{ role: 'developer', content: '你是助手' }] },
      textModel,
    ) as { messages: Array<{ role: string }> };
    assert.equal(clamped.messages[0]?.role, 'system', '上游对 developer 角色回 001001044.400');
  });

  test('纯文本模型收到图片 → 换成文字占位', () => {
    const clamped = clampRequestBody(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看图' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            ],
          },
        ],
      },
      textModel,
    ) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    const parts = clamped.messages[0]?.content ?? [];
    assert.equal(parts[1]?.type, 'text', '图片块必须换成文字，否则上游回 81001');
    assert.ok((parts[1]?.text ?? '').includes('图片'));
  });

  test('支持图片的模型 → 图片块保留', () => {
    const visionModel = { ...textModel, id: 'qwen-vl-max', supportsImages: true };
    const clamped = clampRequestBody(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
          },
        ],
      },
      visionModel,
    ) as { messages: Array<{ content: Array<{ type: string }> }> };
    assert.equal(clamped.messages[0]?.content[0]?.type, 'image_url');
  });

  test('不修改入参（传入冻结对象不抛）', () => {
    const input = Object.freeze({
      max_tokens: 999_999,
      messages: Object.freeze([Object.freeze({ role: 'developer', content: 'x' })]),
    });
    assert.doesNotThrow(() => clampRequestBody(input, textModel));
    // 冻结对象没被改：原始值仍在。
    assert.equal(input.max_tokens, 999_999);
  });
});

describe('错误分类', () => {
  const cases: Array<[number, string, string]> = [
    [401, '', 'authentication'],
    [403, '', 'authentication'],
    [402, '', 'hard-credit'],
    [429, '', 'soft-rate'],
    [500, '', 'server'],
    [502, '', 'server'],
    [400, '{"error":{"message":"bad"}}', 'client'],
    [404, '{"error":{"code":"APIGW.0101","message":"API 不存在"}}', 'not-found'],
    [400, '{"error":{"code":"InferHub.001001044.400","message":"role cannot empty"}}', 'client'],
  ];

  for (const [status, body, expected] of cases) {
    test(`HTTP ${String(status)} + ${body === '' ? '空体' : '错误体'} → ${expected}`, () => {
      const result = classifyFailure(status, body);
      assert.equal(result.kind, expected, `实际 ${result.kind}，消息 ${result.message}`);
    });
  }

  test('限流文案（无 429 状态）也归到 soft-rate', () => {
    const result = classifyFailure(200, '{"error":{"message":"rate limit exceeded"}}');
    assert.equal(result.kind, 'soft-rate');
  });

  test('错误消息里带上游 code', () => {
    const result = classifyFailure(400, '{"error":{"code":"ModelArts.81001","message":"不支持"}}');
    assert.ok(result.message.includes('ModelArts.81001'), `消息应含上游 code，实际 ${result.message}`);
  });
});
