/**
 * auth 层测试：DPoP 可验签、签名稳定、登录双路线、网关补全。
 *
 * 不发真实网络请求：所有 `fetch` 都注入替身。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { newDpopKey, signDpopProof } from '../src/auth/dpop.ts';
import { huaweiBasicAuth, signHuaweiRequest } from '../src/auth/sign.ts';
import { fetchGateway } from '../src/auth/subscription.ts';
import { STS_TOKEN_URL } from '../src/constants.ts';
import type { StsCredential } from '../src/types.ts';

/** 把 base64url 段解成对象。 */
function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** P-256 的阶；低 S 归一化要拿它做上界。 */
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const P256_HALF = P256_ORDER >> 1n;

describe('DPoP', () => {
  test('生成的 proof：三段、header 带公钥且不含私钥', () => {
    const jwk = newDpopKey();
    const proof = signDpopProof(jwk, STS_TOKEN_URL);
    const segments = proof.split('.');
    assert.equal(segments.length, 3, 'JWT 必须是三段');

    const header = decodeSegment(segments[0] as string);
    assert.equal(header['alg'], 'ES256');
    assert.equal(header['typ'], 'dpop+jwt');
    const publicJwk = header['jwk'] as Record<string, unknown>;
    assert.equal(publicJwk['kty'], 'EC');
    assert.equal(publicJwk['crv'], 'P-256');
    assert.equal(publicJwk['x'], jwk.x);
    assert.equal(publicJwk['y'], jwk.y);
    assert.equal(publicJwk['d'], undefined, 'header 里绝不能带私钥分量 d');
  });

  test('proof 能被公钥验签通过', () => {
    const jwk = newDpopKey();
    const proof = signDpopProof(jwk, STS_TOKEN_URL);
    const segments = proof.split('.');
    const header = decodeSegment(segments[0] as string);
    const publicJwk = header['jwk'] as Record<string, unknown>;

    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: publicJwk['x'], y: publicJwk['y'] },
      format: 'jwk',
    });
    const signingInput = `${segments[0]}.${segments[1]}`;
    const signature = Buffer.from(segments[2] as string, 'base64url');
    const ok = createVerify('SHA256').update(signingInput).verify({ key, dsaEncoding: 'ieee-p1363' }, signature);
    assert.equal(ok, true, 'proof 必须能被 header 里的公钥验签');
  });

  test('签名值做了低 S 归一化（s ≤ n/2）', () => {
    // 归一化是必需项：部分服务端只接受 s <= n/2 的那一半，不归一化会随机失败。
    const jwk = newDpopKey();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const proof = signDpopProof(jwk, STS_TOKEN_URL);
      const signature = Buffer.from(proof.split('.')[2] as string, 'base64url');
      assert.equal(signature.length, 64, 'P-256 签名必须是 64 字节 r||s');
      const s = BigInt('0x' + signature.subarray(32, 64).toString('hex'));
      assert.ok(s <= P256_HALF, `s 超过 n/2（第 ${String(attempt)} 次）`);
    }
  });

  test('payload 绑定方法与地址，且 jti 每次不同', () => {
    const jwk = newDpopKey();
    const first = decodeSegment(signDpopProof(jwk, STS_TOKEN_URL, 'POST').split('.')[1] as string);
    const second = decodeSegment(signDpopProof(jwk, STS_TOKEN_URL, 'POST').split('.')[1] as string);
    assert.equal(first['htm'], 'POST');
    assert.equal(first['htu'], STS_TOKEN_URL);
    assert.equal(typeof first['iat'], 'number');
    assert.notEqual(first['jti'], second['jti'], 'jti 每次都必须是新的，否则会被重放检测拒');
  });
});

describe('华为云签名', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'SECRETEXAMPLE', securityToken: 'TOKEN' };

  test('同一输入两次签名完全一致', () => {
    const url = 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-permission-validate';
    const fixed = new Date('2026-11-10T04:00:00Z');
    const first = signHuaweiRequest({ method: 'GET', url, credentials, now: fixed });
    const second = signHuaweiRequest({ method: 'GET', url, credentials, now: fixed });
    assert.deepEqual(first, second, 'canonical request 必须稳定，否则同一请求两次签名不同');
  });

  test('SignedHeaders 包含 host（fetch 禁止手设但它必须参与签名）', () => {
    const url = 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-permission-validate';
    const headers = signHuaweiRequest({ method: 'GET', url, credentials });
    const authorization = headers['Authorization'] ?? '';
    assert.ok(authorization.startsWith('SDK-HMAC-SHA256 '), '算法名必须是 SDK-HMAC-SHA256');
    const signedHeaders = /SignedHeaders=([^,]+)/u.exec(authorization)?.[1] ?? '';
    assert.ok(signedHeaders.split(';').includes('host'), `SignedHeaders 里缺 host：${signedHeaders}`);
  });

  test('改了请求头 → 签名变化', () => {
    const url = 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-subscription';
    const base = signHuaweiRequest({ method: 'POST', url, body: '{}', credentials });
    const changed = signHuaweiRequest({
      method: 'POST',
      url,
      body: '{}',
      credentials,
      headers: { 'x-subscription-type': 'v2' },
    });
    assert.notEqual(base['Authorization'], changed['Authorization']);
  });

  test('body 变化 → 签名变化', () => {
    const url = 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-subscription';
    const first = signHuaweiRequest({ method: 'POST', url, body: '{}', credentials });
    const second = signHuaweiRequest({ method: 'POST', url, body: '{"a":1}', credentials });
    assert.notEqual(first['Authorization'], second['Authorization']);
  });

  test('Basic 认证形态是 base64(appKey:appSecret)', () => {
    const value = huaweiBasicAuth('key123', 'secret456');
    assert.equal(value, 'Basic ' + Buffer.from('key123:secret456', 'utf8').toString('base64'));
  });
});

/** 造一份可用于 fetchGateway 的 STS 凭据。 */
function stsCredential(): StsCredential {
  return {
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    securityToken: 'STS',
    projectId: 'PROJECT',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    refreshToken: 'REFRESH',
    dpopPrivateJwk: newDpopKey(),
    domainId: 'DOMAIN',
  };
}

/** 造一个按 URL 分派的 fetch 替身，记录调用。 */
function fakeFetch(routes: Record<string, () => Response>): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: (url) => {
      calls.push(url);
      const key = Object.keys(routes).find((pattern) => url.includes(pattern));
      if (key === undefined) return Promise.reject(new Error(`没有为 ${url} 准备替身`));
      return Promise.resolve((routes[key] as () => Response)());
    },
  };
}

describe('网关凭据', () => {
  test('权限接口已给 model_info → 不调 client-subscription', async () => {
    const body = {
      subscription: {
        model_info: {
          model_api_url_base: 'modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com',
          model_auth_info: { model_app_key: 'APPKEY', model_app_secret: 'APPSECRET' },
        },
      },
    };
    const fake = fakeFetch({
      'client-permission-validate': () => new Response(JSON.stringify(body), { status: 200 }),
    });
    const gateway = await fetchGateway(stsCredential(), fake.fetch);

    assert.ok(gateway !== undefined);
    assert.equal(gateway.base, 'https://modelgw-0009.officeace.cn-southwest-2.huaweicloud-agentarts.com/v2');
    assert.equal(gateway.appKey, 'APPKEY');
    assert.equal(gateway.appSecret, 'APPSECRET');
    assert.equal(fake.calls.length, 1, '有 model_info 时不该再调 client-subscription');
  });

  test('缺 model_auth_info → 补一次 client-subscription，且带 x-subscription-type: v2', async () => {
    const seen: Array<Record<string, string>> = [];
    const fake = (url: string, init?: RequestInit): Promise<Response> => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      if (url.includes('client-permission-validate')) {
        return Promise.resolve(
          new Response(JSON.stringify({ subscription: { model_info: { model_api_url_base: 'gw.example.com' } } }), {
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model_info: {
              model_api_url_base: 'gw.example.com',
              model_auth_info: { model_app_key: 'K2', model_app_secret: 'S2' },
            },
          }),
          { status: 200 },
        ),
      );
    };

    const gateway = await fetchGateway(stsCredential(), fake);
    assert.ok(gateway !== undefined);
    assert.equal(gateway.appKey, 'K2');
    assert.equal(seen.length, 2, '缺 model_info 时必须补一次 client-subscription');

    // 签名会把头名小写化，所以按小写键找。
    const second = seen[1] ?? {};
    const lowered: Record<string, string> = {};
    for (const [key, value] of Object.entries(second)) lowered[key.toLowerCase()] = value;
    assert.equal(lowered['x-subscription-type'], 'v2');
  });

  test('base 已带 scheme 与 /v2 → 不重复补', async () => {
    const body = {
      subscription: {
        model_info: {
          model_api_url_base: 'https://gw.example.com/v2',
          model_auth_info: { model_app_key: 'K', model_app_secret: 'S' },
        },
      },
    };
    const fake = fakeFetch({
      'client-permission-validate': () => new Response(JSON.stringify(body), { status: 200 }),
    });
    const gateway = await fetchGateway(stsCredential(), fake.fetch);
    assert.equal(gateway?.base, 'https://gw.example.com/v2');
  });

  test('拿不到网关时返回 undefined 而不是抛', async () => {
    const fake = fakeFetch({
      'client-permission-validate': () => new Response('{}', { status: 200 }),
      'client-subscription': () => new Response('{}', { status: 200 }),
    });
    const gateway = await fetchGateway(stsCredential(), fake.fetch);
    assert.equal(gateway, undefined);
  });
});

describe('PKCE 形状（通过登录 handle 观察）', () => {
  test('授权页 URL 里的 code_challenge_method 是 SHA-256，且 challenge 由 verifier 派生', async () => {
    // 这里只验 URL 形状：真实登录需要浏览器，端到端由 live 验证负责。
    const { startLogin } = await import('../src/auth/oauth.ts');
    const fake = fakeFetch({
      'auth/state': () => new Response(JSON.stringify({ state: 'STATE123' }), { status: 200 }),
    });
    const handle = startLogin({ fetch: fake.fetch });
    // 取消会让 result 这个 promise reject；先挂一个空 catch，否则会变成 unhandledRejection。
    const settled = handle.result.catch(() => undefined);
    const url = await handle.authorizeUrl;
    handle.cancel();
    await settled;

    assert.ok(url.includes('auth.huaweicloud.com/authui/login.html?service='), '必须套一层登录页');
    const decoded = decodeURIComponent(url);
    assert.ok(decoded.includes('code_challenge_method=SHA-256'), '方法名必须写成 SHA-256（不是 S256）');
    assert.ok(decoded.includes('client_id=pdp5_for_agentarts'));
    assert.ok(decoded.includes('state=STATE123'));
    assert.ok(decoded.includes('response_type=code'));

    const challenge = /code_challenge=([\w-]+)/u.exec(decoded)?.[1];
    assert.ok(
      challenge !== undefined && challenge.length === 43,
      `challenge 应是 base64url 的 sha256（43 字符），实际 ${String(challenge)}`,
    );
  });

  test('state 登记失败 → 回落到本机回环路线', async () => {
    const { startLogin } = await import('../src/auth/oauth.ts');
    const fake = fakeFetch({
      'auth/state': () => new Response('boom', { status: 500 }),
    });
    const handle = startLogin({ fetch: fake.fetch });
    const settled = handle.result.catch(() => undefined);
    const url = await handle.authorizeUrl;
    handle.cancel();
    await settled;

    // 只看 `redirect_uri` 的值本身：整个 URL 套了两层编码（外层登录页的 service=，
    // 内层授权页的 query），解一次 `decodeURIComponent` 后内层仍是 `%3A` 形态。
    const redirect = /redirect_uri=([^&]+)/u.exec(decodeURIComponent(url))?.[1] ?? '';
    assert.ok(
      decodeURIComponent(redirect).startsWith('http://127.0.0.1:'),
      `应回落到本机回环，实际 redirect_uri=${redirect}`,
    );
  });
});
