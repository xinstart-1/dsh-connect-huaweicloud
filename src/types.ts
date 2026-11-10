/**
 * 全插件共享类型的唯一归属地。
 *
 * 并行开发时每个模块都依赖这里的形状：凭据（`StoredAccount`）、池候选
 * （`PoolCandidate`）、状态快照（`StatusSnapshot`）。改这里的字段等于改模块间契约，
 * 必须同时改 `test/contract.test.ts` 里钉住的形状。
 *
 * @module dsh-connect-huaweicloud/types
 */

/**
 * 一条账号凭据。
 *
 * 两种来源共用一个形状：`origin` 说明它是**读来的**还是**登来的**，二者能续期与否
 * 完全不同——`import` 的 STS 用的是客户端自己那把 DPoP 私钥，本插件拿不到，
 * 所以过期后只能让用户重新同步或重新登录。
 */
export interface StoredAccount {
  /** 稳定 id：`acc_<sha256(身份) 前 16 位>`，见 `credentials/vault.ts`。 */
  readonly id: string;
  /** 账号身份串（优先 userId，其次 userName）；同一身份永远算出同一个 id。 */
  readonly accountKey: string;
  /** 展示名。 */
  readonly label: string;
  /** 上游 userId；读不到时为空串。 */
  readonly userId: string;
  /** 上游 userName；读不到时为空串。 */
  readonly userName: string;

  /** 这份凭据从哪来。 */
  readonly origin: 'login' | 'import' | 'import+oauth';
  /** STS 凭据：登录得到的那份。缺它就只能用 `gateway` 直接推理。 */
  readonly sts?: StsCredential;
  /** 模型网关凭据：Basic(appKey:appSecret)，不随 STS 过期。 */
  readonly gateway?: GatewayCredential;

  readonly savedAtMs: number;
  /** 上一次成功同步/登录的时间；卡片显示用。 */
  readonly syncedAtMs: number;
  /** 上一次同步失败的分类原因；非空表示这条记录可能是坏的。 */
  readonly syncError?: string;
}

/** 华为云 STS 凭据；`dpopPrivateJwk` 丢失等于 refresh_token 作废。 */
export interface StsCredential {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly securityToken: string;
  readonly projectId: string;
  /** ISO 8601；解析不出来时为空串。 */
  readonly expiresAt: string;
  /** 一次性：每续一次上游就换一个新的，必须立刻落盘。 */
  readonly refreshToken: string;
  /** 与 refresh_token 绑定的 DPoP 私钥（JWK）。 */
  readonly dpopPrivateJwk: DpopJwk;
  readonly domainId: string;
}

/** P-256 私钥的 JWK 形态；只落自己的仓库，不进日志。 */
export interface DpopJwk {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

/** 模型网关凭据。`base` 已带 scheme 与 `/v2` 后缀。 */
export interface GatewayCredential {
  readonly base: string;
  readonly appKey: string;
  readonly appSecret: string;
  /** 云端另发的 MaaS key；有则一并带上，没有也不影响。 */
  readonly maasApiKey?: string;
}

/**
 * 池挑选用的一个候选。
 *
 * 纯数据：`host/pool.ts` 只读它、不读磁盘、不发请求，因此可以脱离 IO 单测。
 */
export interface PoolCandidate {
  readonly id: string;
  /** 用户是否把它勾进池。空勾选名单合法的含义是「一个都没勾」，不是「全勾」。 */
  readonly inPool: boolean;
  /** 此刻能不能拿它发请求（令牌未过期、不在冷却、上次探测不是硬失败）。 */
  readonly usable: boolean;
  /** 不可用的分类原因，直接给界面显示。 */
  readonly reason?: string;
  /** 剩余积分；`undefined` 表示**读不到**，不是 0。 */
  readonly credits?: number;
  /** 最近到期的那份额度；`undefined` 表示没有到期额度。 */
  readonly nearestExpiryMs?: number;
  /** 凭据自身的到期时间，用于「凭据新」这一排序键。 */
  readonly expiresAtMs?: number;
}

/** 一次池挑选的结果。`id` 为 `undefined` 表示池里一个可用账号都没有。 */
export interface PoolChoice {
  readonly id?: string;
  /** 为什么没挑到/只挑到它；给日志与界面用。 */
  readonly reason: string;
}

/** 账号的可用性判定。 */
export interface Usability {
  readonly usable: boolean;
  readonly reason?: string;
}

/** 账号额度读数（只读，不写上游）。 */
export interface QuotaReading {
  /** 总积分；读不到时 `undefined`。 */
  readonly total?: number;
  readonly used?: number;
  readonly remaining?: number;
  /** 套餐名。 */
  readonly plan?: string;
  readonly readAtMs: number;
  /** 读取失败的原因；非空表示这次读数无效。 */
  readonly error?: string;
}

/** 卡片里一行账号的展示数据。**不含任何令牌**。 */
export interface AccountView {
  readonly id: string;
  readonly label: string;
  readonly userName: string;
  readonly origin: StoredAccount['origin'];
  /** 有 STS 就能续期；`import` 来的没有这把私钥。 */
  readonly renewable: boolean;
  readonly hasGateway: boolean;
  /** STS 还剩多少毫秒过期；没有 STS 时为 `undefined`。 */
  readonly stsRemainingMs?: number;
  readonly inPool: boolean;
  readonly usable: boolean;
  readonly reason?: string;
  readonly quota?: QuotaReading;
  readonly syncedAtMs: number;
  readonly syncError?: string;
}

/** 登录会话的相位。`done` 之后不再变化。 */
export type LoginPhase =
  | 'idle'
  | 'preparing'
  | 'awaiting-user'
  | 'exchanging'
  | 'fetching-gateway'
  | 'done'
  | 'failed'
  | 'cancelled';

/** 一次进行中的登录。 */
export interface LoginSessionView {
  readonly phase: LoginPhase;
  /** 浏览器要打开的地址；`preparing` 阶段还没有。 */
  readonly authorizeUrl?: string;
  /** 走的是哪条回调路线：云端取码还是本机回环。 */
  readonly route?: 'cloud' | 'loopback';
  /** 失败时的人话原因。 */
  readonly message?: string;
  /** 失败分类码，界面据此给建议。 */
  readonly errorCode?: LoginErrorCode;
  readonly startedAtMs: number;
}

/** 登录失败的闭集原因码；文案由界面决定，不靠字符串匹配。 */
export type LoginErrorCode =
  | 'state-register-failed'
  | 'authorize-failed'
  | 'code-timeout'
  | 'token-exchange-failed'
  | 'gateway-unavailable'
  | 'cancelled'
  | 'unknown';

/** 宿主返回给浏览器半侧的状态快照。 */
export interface StatusSnapshot {
  readonly version: string;
  readonly accounts: readonly AccountView[];
  /** 池总开关；关着时永远用手动选定的账号。 */
  readonly poolEnabled: boolean;
  /** 手动选定的账号 id；池开着时它只是「没有可用账号时的兜底」。 */
  readonly selectedId?: string;
  /** 本轮请求实际在用的账号 id（池开着时可能与 `selectedId` 不同）。 */
  readonly activeId?: string;
  readonly login?: LoginSessionView;
  /** 本机是否检测到果办客户端；决定卡片显示「自动读账号」还是「登录添加」。 */
  readonly desktopDetected: boolean;
  /** 桌面端探测不到时的人话原因。 */
  readonly desktopReason?: string;
  /** 目录里的模型数量；空目录意味着没有任何可用凭据。 */
  readonly modelCount: number;
}

/** 动作入口的白名单联合；路由层据此拒绝任意调用。 */
export type HostAction =
  | 'refresh'
  | 'sync-desktop'
  | 'login-start'
  | 'login-status'
  | 'login-cancel'
  | 'switch-account'
  | 'remove-account'
  | 'members'
  | 'settings'
  | 'test-account';

/** 动作的统一返回形状。 */
export interface ActionResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly status?: StatusSnapshot;
}
