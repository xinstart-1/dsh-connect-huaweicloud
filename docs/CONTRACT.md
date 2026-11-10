# 模块契约（并行开发的唯一接口真源）

> 任何人改这里的签名 = 改模块间契约，必须同时通知 Lead。
> 类型定义在 `src/types.ts`，常量在 `src/constants.ts`（这两处已由 Lead 定稿，**不要改**）。

依赖方向单向：`index.ts` → `host/` → `auth/` · `credentials/` · `protocol/`；`credentials/` 不依赖 `auth/`，`protocol/` 不依赖 `host/`。

---

## A. `credentials/`（写者：creds）

### `src/credentials/wincred.ts`

```ts
/** Windows 凭据管理器里一条果办账号的定位信息。 */
export interface WinCredTarget {
  /** 凭据管理器里的目标名。 */
  target: string;
  /** `<domainId>%3A<userId>`，即 users/ 下的目录名。 */
  userDir: string;
}

/** 枚举本机果办账号。读不到 users 目录时返回空数组，不抛。 */
export function listTargets(env?: NodeJS.ProcessEnv): Promise<WinCredTarget[]>;

/** 读一条凭据的明文；不存在返回 undefined。分块先拼文本再 base64 解一次。 */
export function readCredential(target: string): Promise<string | undefined>;
```

实现要点（来自 `reference/huawei-connect/lib/wincred.mjs`）：
- 目标名 = `OfficeAce/auth-sessions/huawei-oauth/<userDir>/provider-state`
- 枚举靠 `~/.office-claw/users/` 的目录名，**不是** `cmdkey /list`（它不给 blob 大小）
- 分块路径 = `<target>/chunks/<storageId>/<n>`，块是 **UTF-16LE** 的 base64 文本片段
- **先拼文本、再 base64 解一次**；逐块解码会弄坏 padding
- PowerShell 脚本走 `-EncodedCommand`（base64 的 UTF-16LE），免引号/中文路径问题
- 全程只读；每次约 400 ms，调用方负责缓存
- 必须 `windowsHide: true`（宿主是无控制台的 Electron 进程，否则每次闪黑框）

### `src/credentials/dpapi.ts`

```ts
/** 解密 DPAPI（CurrentUser 作用域）密文。失败返回 undefined。 */
export function unprotect(blobBase64: string): Promise<string | undefined>;

/** 读并解密 `session.cookie`，取出本机控制面的会话值；不存在/坏格式返回 undefined。 */
export function readLocalSession(env?: NodeJS.ProcessEnv): Promise<LocalSession | undefined>;

export interface LocalSession {
  /** cookie 值（形如 `<domainId>%3A<userId>.<sessionId>.<sig>`）。 */
  value: string;
  /** unix 秒。 */
  expiresAtSec: number;
}
```

- 文件两行：`OC-DPAPI-1` + base64 密文（见 `SESSION_COOKIE_MARKER`）
- 明文 JSON = `{"value":"…","expires":<unix 秒>}`
- 只用 `System.Security.Cryptography.ProtectedData`，同样 `-EncodedCommand` + `windowsHide`

### `src/credentials/probe.ts`

```ts
/** 一次桌面端探测的结果。 */
export interface DesktopProbe {
  /** 本机是否装了果办客户端（任一入口命中即 true）。 */
  readonly installed: boolean;
  /** 探测不到时的人话原因；`installed` 为 true 时为空。 */
  readonly reason?: string;
  /** 从凭据管理器读到的账号（可能为空数组）。 */
  readonly accounts: readonly ImportedAccount[];
}

/** 从桌面端读到的一份账号凭据。 */
export interface ImportedAccount {
  readonly userId: string;
  readonly userName: string;
  readonly gateway?: GatewayCredential;
  /** 读到了 STS 但拿不到对应私钥时，这里只有元信息（不能续期）。 */
  readonly sts?: { readonly securityToken: string; readonly expiresAt: string };
  /** 这份凭据是从哪个入口读到的；诊断用。 */
  readonly via: 'wincred' | 'models-json';
}

/** 探测本机桌面端。只读，不刷新、不写回、不抛。 */
export function probeDesktop(env?: NodeJS.ProcessEnv): Promise<DesktopProbe>;
```

两个入口都要试，按可用性合并：
1. `wincred` → `provider-state` JSON → `modelInfo.model_api_url_base` + `model_auth_info.model_app_key/secret`
   （`modelGatewayOf()` 的逻辑照 `reference/huawei-connect/lib/officeace.mjs:60` 抄：主机名要补 `https://` 与 `/v2`）
2. `models-json` → `routing_state/users/<userId>/models.json` → `defaults[]` 里第一条同时带
   `api_base` 与 `Authorization: Basic …` 的配置（见 `reference/huaweicloud-connect/lib/drivers/officeace.js:65`）

**两条都要给 `reason` 分类**：`desktop-missing` / `desktop-unreadable` / `desktop-no-gateway`，界面据此给可执行建议。

---

## B. `auth/`（写者：auth）

### `src/auth/dpop.ts`

```ts
/** 生成新的 P-256 私钥（JWK 形态，便于直接落盘）。 */
export function newDpopKey(): DpopJwk;

/** 生成 DPoP proof JWT。htu 必须是完整 token 端点地址。 */
export function signDpopProof(jwk: DpopJwk, htu: string, htm?: string): string;
```

照抄 `reference/huawei-connect/lib/dpop.mjs`，**低 S 归一化必须保留**（否则约一半请求随机失败）。

### `src/auth/oauth.ts`

```ts
/** 起一次浏览器登录；两条回调路线自动选。 */
export function startLogin(options?: { timeoutMs?: number }): LoginHandle;

export interface LoginHandle {
  /** 授权地址，等本机端口/state 就绪后才可用。 */
  readonly authorizeUrl: Promise<string>;
  /** 用户完成授权后 resolve 成 STS 凭据；失败 reject。 */
  readonly result: Promise<StsCredential>;
  /** 放弃（取消或超时后用）。幂等。 */
  cancel(): void;
}

/** 用 refresh_token 续期。破坏性：旧 refresh 立即失效，调用方必须立刻落盘。 */
export function refreshSts(credential: StsCredential): Promise<StsCredential>;
```

路线优先级（关键决策，不要改）：
- **路线 B（首选）**：`POST {CLAW_BASE}{STATE_PATH}` 登记 state → 浏览器授权 → 轮询
  `GET {CLAW_BASE}{CODE_PATH}?state=` 取 code → 换 token。**不需要本机端口**。
  `redirect_uri` = `CLOUD_REDIRECT_URI`。
- **路线 A（回落）**：state 登记失败时，本机 `127.0.0.1` 随机端口起服务器接 `?code=`，
  `redirect_uri` = `http://127.0.0.1:<port>` + `LOOPBACK_REDIRECT_PATH`。

授权页拼法（两条路线相同）：
`LOGIN_PAGE + '?service=' + encodeURIComponent(AUTH_BASE + AUTHORIZE_PATH + '?' + <params>)`，
params = `client_id, code_challenge, code_challenge_method=SHA-256, state, scope=openid, redirect_uri, response_type=code`。

换 token：`POST STS_TOKEN_URL`，头 `DPoP: <proof>` + `Content-Type: application/x-www-form-urlencoded`，
体 `grant_type=authorization_code&code=…&code_verifier=…&client_id=…&redirect_uri=…`。
响应 `credentials.{access_key_id,secret_access_key,security_token,project_id,expiration}` + `refresh_token`。

### `src/auth/subscription.ts`

```ts
/** 权限校验 + 缺 model_info 时自动补一次；返回网关凭据。 */
export function fetchGateway(credential: StsCredential): Promise<GatewayCredential | undefined>;
```

两步：
1. `GET {CLAW_BASE}{PERMISSION_PATH}`，头 `x-security-token`（+ 有则 `x-project-id`），**SDK-HMAC-SHA256 签名**
   → `subscription.model_info.{model_api_url_base, model_auth_info.{model_app_key,model_app_secret}}`
2. 缺 `model_auth_info` 时补一次 `POST {CLAW_BASE}{SUBSCRIPTION_CLAW_PATH}`：
   头 `x-subscription-type: v2`、`x-security-token`，body `{}`，同样签名
   → `model_info.model_auth_info`。**这是写操作**（开通订阅），只在确实缺时才调。

### `src/auth/sign.ts`

```ts
/** 给请求头补上签名四件套；返回新对象（Authorization 里的 SignedHeaders 必须与实际头完全对应）。 */
export function signHuaweiRequest(options: {
  method: string;
  url: string;
  body?: string;
  credentials: { accessKeyId: string; secretAccessKey: string; securityToken?: string };
  headers?: Record<string, string>;
  now?: Date;
}): Record<string, string>;

/** 模型网关的认证形态：`Basic base64(appKey:appSecret)`。 */
export function huaweiBasicAuth(appKey: string, appSecret: string): string;
```

照抄 `reference/huawei-connect/lib/sign.mjs`（canonical request 必须逐字节一致，改动前先用探针核对）。

---

## C. `protocol/`（写者：wire）

### `src/protocol/errors.ts`

```ts
/** 失败分类；池据此决定要不要换号。 */
export type FailureKind =
  | 'authentication'   // 401/403：凭据坏了，换号
  | 'hard-credit'      // 402/额度耗尽：换号 + 冷却
  | 'server'           // 5xx/网络：换号 + 短冷却
  | 'soft-rate'        // 429：换号 + 15s 冷却
  | 'client'           // 400 请求本身不合法：**不换号**
  | 'model-unavailable'// 403/404 模型级：**不惩罚账号**
  | 'not-found';

export class UpstreamError extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  /** 上游给的 code（有则带上），界面与日志用。 */
  readonly upstreamCode?: string;
}

/** 把 HTTP 状态 + 响应体归一成分类。 */
export function classifyFailure(status: number, text: string): { kind: FailureKind; message: string; upstreamCode?: string };
```

必须处理的两个真实坑：
- 果办限流会在 **HTTP 200 的 SSE 首帧里**回 `{"error":…}`；`ModelArts.81001` 也是流内错误。
- `max_tokens > 131072` 同样是流内错误 → 所以客户端必须**发请求前钳制**（在 `disguise` 逻辑里做）。

### `src/protocol/client.ts`

```ts
export interface GatewayModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly supportsImages: boolean;
}

/** 拉模型目录；失败抛 UpstreamError。 */
export function listModels(gateway: GatewayCredential, signal?: AbortSignal): Promise<GatewayModel[]>;

/** 发一次对话请求；返回已做首帧错误检查的 SSE 字节流。 */
export function chatStream(input: {
  gateway: GatewayCredential;
  body: unknown;
  signal?: AbortSignal;
}): Promise<AsyncIterable<Uint8Array>>;

/** 把请求体钳制到上游硬限以内（max_tokens / developer 角色 / 图片）。 */
export function clampRequestBody(body: unknown, model: GatewayModel): unknown;
```

`clampRequestBody` 规则（每条都有实测依据）：
1. `max_tokens` 钳到 `MAX_OUTPUT_TOKENS`
2. `role: "developer"` 改写成 `system`
3. 发给 `supportsImages === false` 的模型时，图片块换成文字占位 `[图片已省略]`

### `src/shim/server.ts`（写者：wire）

```ts
/** 起回环 shim：把 pi-ai 的请求转给「当前账号」，失败自动换下一个。 */
export function startShim(options: ShimOptions): Promise<ShimHandle>;

export interface ShimOptions {
  /** 按优先级返回候选账号（已由池过滤排序）。 */
  attempts: () => Promise<readonly ShimAttempt[]>;
  /** 用一个账号发流；失败抛 UpstreamError。 */
  chat: (input: { attempt: ShimAttempt; body: unknown; signal?: AbortSignal }) => Promise<AsyncIterable<Uint8Array>>;
  /** 某个账号失败时回调（池记账用）。 */
  onFailure?: (detail: { attemptId: string; kind: FailureKind; message: string }) => void;
  onSuccess?: (attemptId: string) => void;
  onWarn?: (message: string) => void;
}

export interface ShimAttempt {
  readonly attemptId: string;
  readonly gateway: GatewayCredential;
}

export interface ShimHandle {
  /** 形如 `http://127.0.0.1:54321`，不含 `/v1`。 */
  readonly baseUrl: string;
  /** 进程内随机密钥；真实令牌不出宿主进程。 */
  readonly token: string;
  close(): Promise<void>;
}
```

安全边界（三条都要）：
1. 只监听 `127.0.0.1`
2. 校验 `Authorization: Bearer <shim token>`，用 timing-safe 比较
3. 请求体上限 8 MiB

换号规则：`client` / `model-unavailable` **不换号**；流已经发出后断开**不重试**（会拼出两段回答）。

---

## D. `host/`（写者：pool）

### `src/host/pool.ts`（**纯函数，不碰磁盘、不发请求、不读时钟**）

```ts
/** 挑一个服务账号。规则见实现文件头，逐条有理由。 */
export function pickAccount(input: {
  poolEnabled: boolean;
  currentId?: string;
  candidates: readonly PoolCandidate[];
}): PoolChoice;

/** 换号时后续尝试的顺序（不含 firstId 自己）。 */
export function failoverCandidates(input: {
  poolEnabled: boolean;
  currentId?: string;
  candidates: readonly PoolCandidate[];
  firstId: string;
}): readonly string[];
```

排序键（依次比较，必须可复现）：
1. 可用优先
2. **快过期先花**（3 天内到期的优先，先到期先排）—— 过期作废的额度是纯损失
3. 积分高（`undefined` 排在 `0` 之后：读不到不等于没额度）
4. 凭据更晚过期
5. 账号 id（收尾，保证全序）

四条硬规则：
- 池关着 → 永远返回 `currentId`；它不可用也返回（用户手动选是明确意图）
- 池开着 → 只在 `inPool` 的账号里挑
- `inPool` 全为空 → 退回 `currentId`，**绝不**退化成「全选」
- 不可用的不算候选；但「读不到余额」不算不可用

### `src/host/accounts.ts`

```ts
export interface AccountsDeps {
  vault: Vault;
  probe: () => Promise<DesktopProbe>;
  refreshSts: (credential: StsCredential) => Promise<StsCredential>;
  fetchGateway: (credential: StsCredential) => Promise<GatewayCredential | undefined>;
  warn: (message: string) => void;
}

export interface Accounts {
  /** 把本机客户端读到的账号并入仓库（幂等；同一身份覆盖同一条）。 */
  syncDesktop(): Promise<{ imported: number; skipped: number }>;
  /** 保存一次登录结果。 */
  adopt(credential: StsCredential): Promise<StoredAccount>;
  /** 取一个账号的网关凭据；STS 临期时先续期（单飞）。 */
  gatewayOf(id: string): Promise<GatewayCredential | undefined>;
  /** 可用性判定（过期/坏记录/上次硬失败）。 */
  usability(account: StoredAccount): Usability;
  /** 记一次失败（池记账）。 */
  noteFailure(id: string, kind: FailureKind, message: string): void;
  noteSuccess(id: string): void;
  /** 清掉某账号的停用/冷却（重登或同步成功后调）。 */
  enable(id: string): void;
  /** 全部账号的池候选快照。 */
  candidates(): Promise<PoolCandidate[]>;
  dispose(): void;
}
```

续期不变量：**同一账号同一时刻只有一个续期在跑**（`Map<string, Promise>` 单飞），
成功后**立刻** `vault.save()`（旧的 refresh_token 此刻已作废）。
续期失败但 token 还没过期 → 继续用旧的（一次网络抖动不该让本来能成功的请求失败）。

冷却时长（写进 `constants` 之外的模块常量）：
- `authentication` → 停用 1 小时（只能重新登录）
- `hard-credit` → 冷却 30 分钟
- `server` → 冷却 30 秒
- `soft-rate` → 冷却 15 秒
- `client` / `model-unavailable` → **不惩罚**

---

## E. `client/bundle.js`（写者：ui）

**手写经典脚本，绝不进打包器**（进了会打出第二份 React，hooks 立刻崩）。

约束：
- 无 `import` / `export`；用 `window.__ModuleLoader__.load({ id, factory })` 形态
- 只 `require('react')` 与宿主提供的 `@deepseek-ai/*`
- `zh` / `en` 两份字典**同键**；所有 `t('…')` 的键都存在
- `ctx.slots.inject` 回调**晚执行**，`try/catch` 写在回调**内部**
- 样式只用 `--dsw-*` token，禁止字面色值

调用的两条宿主路由（路径必须逐字一致，`scripts/check-client.mjs` 会校验）：
- `GET  /plugins/dsh-connect-huaweicloud/status` → `StatusSnapshot`
- `POST /plugins/dsh-connect-huaweicloud/action`，体 `{ action: HostAction, … }` → `ActionResult`

界面必须有：
1. 顶部一行状态（版本、模型数、是否检测到客户端）
2. 账号表格：勾选框（进池）、账号名、来源、可用性、额度、删除
3. 「登录添加账号」按钮 → 调 `login-start` → 打开 `authorizeUrl` → 轮询 `login-status`
4. 「同步本机客户端」按钮 → `sync-desktop`
5. 账号池总开关 + 手动选号下拉（池关着时才显示）
