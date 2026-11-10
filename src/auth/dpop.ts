/**
 * DPoP（RFC 9449）证明 JWT：华为云 STS 每个换 token 请求都要带一个。
 *
 * 私钥与 refresh_token 在签发时就绑定：续期时服务端核对 proof 里的公钥是不是当初那把，
 * 换了就报 `InvalidDPoPHeader`，所以 `dpopPrivateJwk` 必须与 refresh_token 一起保存。
 * 私钥只驻留内存与凭据仓库，禁止写日志。
 *
 * @module dsh-connect-huaweicloud/auth/dpop
 */

import { createPrivateKey, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DpopJwk } from '../types.ts';

/** secp256r1 的阶 n。 */
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');

/** ⌊n/2⌋；低 S 归一化的分界。 */
const P256_HALF = P256_ORDER >> 1n;

/** proof 的 header：`jwk` 只含公钥分量。 */
interface DpopHeader {
  readonly alg: 'ES256';
  readonly typ: 'dpop+jwt';
  readonly jwk: { readonly kty: string; readonly crv: string; readonly x: string; readonly y: string };
}

/** proof 的 payload：绑定本次请求的方法与地址，`jti` 每次新。 */
interface DpopPayload {
  readonly htm: string;
  readonly htu: string;
  readonly iat: number;
  readonly jti: string;
}

/** 生成新的 P-256 私钥（JWK 形态，便于直接落盘）。 */
export function newDpopKey(): DpopJwk {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const { kty, crv, x, y, d } = jwk;
  if (kty === undefined || crv === undefined || x === undefined || y === undefined || d === undefined) {
    throw new Error('生成的 P-256 私钥缺少 JWK 字段');
  }
  return { kty, crv, x, y, d };
}

/**
 * 生成 DPoP proof JWT。
 *
 * @param jwk - 与 refresh_token 绑定的那把私钥。
 * @param htu - 完整 token 端点地址（含 scheme 与 host）；服务端严格比对。
 * @param htm - HTTP 方法，默认 `POST`。
 * @returns `header.payload.signature`；签名已做低 S 归一化。
 */
export function signDpopProof(jwk: DpopJwk, htu: string, htm: string = 'POST'): string {
  const key = createPrivateKey({
    format: 'jwk',
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
  });

  const header: DpopHeader = {
    alg: 'ES256',
    typ: 'dpop+jwt',
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  };
  const payload: DpopPayload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString('hex'),
  };

  const signingInput =
    base64url(Buffer.from(JSON.stringify(header), 'utf8')) +
    '.' +
    base64url(Buffer.from(JSON.stringify(payload), 'utf8'));

  // `ieee-p1363` 给出定长 64 字节的 r||s；默认的 DER 编码没法按位归一化 s。
  const signature = createSign('SHA256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
  const r = signature.subarray(0, 32);
  const s = signature.subarray(32, 64);

  // (r, s) 与 (r, n-s) 等价，但部分服务端只接受 s ≤ n/2 的那一半。不归一化的话
  // 大约一半请求会随机失败——失败取决于每次签名的随机数，极难复现。
  const sBig = BigInt('0x' + s.toString('hex'));
  const normalized = sBig > P256_HALF ? P256_ORDER - sBig : sBig;
  const sOut =
    normalized === sBig ? s : Buffer.from(normalized.toString(16).padStart(64, '0'), 'hex');

  return signingInput + '.' + base64url(Buffer.concat([r, sOut]));
}

/** JWT 段用的 base64url（无填充）。 */
function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
