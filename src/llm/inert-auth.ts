/**
 * pi-ai 的「惰性」认证平面。
 *
 * 果办路由**只**通过本地 shim 的共享密钥认证（`resolveApiKey` 每次请求给出），
 * 所以 pi-ai 自己的凭据生命周期与环境探测绝不能被允许伪造出一个凭据。
 * 这里每个方法都回答「没存过、没设置」。
 *
 * @module dsh-connect-huaweicloud/llm/inert-auth
 */

import type { AuthContext, CredentialStore } from '@earendil-works/pi-ai';

/** 空的持久凭据库：读不到、列不出、写就抛。 */
const INERT_CREDENTIALS: CredentialStore = {
  async read() {
    return undefined;
  },
  async list() {
    return [];
  },
  async modify() {
    throw new Error('dsh-connect-huaweicloud: 果办路由没有 pi-ai 凭据生命周期');
  },
  async delete() {
    // 没有可删的。
  },
};

/** 空的环境上下文：任何变量都不存在、任何文件都不存在。 */
const INERT_AUTH_CONTEXT: AuthContext = {
  async env() {
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

/** 打包成 `PiAiAdapterOptions.auth`。 */
export const INERT_AUTH = {
  credentials: INERT_CREDENTIALS,
  authContext: INERT_AUTH_CONTEXT,
} as const;
