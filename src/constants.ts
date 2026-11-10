/**
 * 果办（OfficeAce）侧全部远端地址、路径与时间常量的唯一归属地。
 *
 * 三个域不能混，混了会得到「签名正确但 404」这种最难查的错：
 * CLAW 域（登录/权限校验）、STS 域（换 token）、模型网关（推理，运行时从凭据取）。
 * 本机桌面端还有两条完全不同的凭据入口：Windows 凭据管理器的分块 provider-state、
 * 以及 routing_state 下的 models.json（APIG APP 认证）。两者都能拿到网关凭据，
 * 优先级与字段差异见 `credentials/probe.ts`。
 *
 * @module dsh-connect-huaweicloud/constants
 */

/** provider 路由键；同时是 pi-ai collection 的 key。 */
export const PROVIDER = 'officeace';

/** 插件版本号（卡片与日志显示）。与 `package.json` 的 `version` 一致，由 gate 校验。 */
export const VERSION = '0.0.4';

/** 设置页命名空间。 */
export const SETTINGS_NS = 'officeace';

/** 模型选择器里的分组名。 */
export const DISPLAY_NAME = '果办 OfficeAce';

/** 登录与权限校验域。注意它**不是**推理域，也不是订阅面。 */
export const CLAW_BASE = 'https://agentarts.cn-southwest-2.myhuaweicloud.com';

/** 云端登记登录 state。 */
export const STATE_PATH = '/v1/claw/auth/state';

/** 轮询取授权码。 */
export const CODE_PATH = '/v1/claw/auth/code';

/** 权限校验：下发模型的 appKey/appSecret 与网关主机名。 */
export const PERMISSION_PATH = '/v1/claw/client-permission-validate';

/** 「接入模型」背后的端点：账号缺 model_info 时补一次。 */
export const SUBSCRIPTION_CLAW_PATH = '/v1/claw/client-subscription';

/** 华为云 STS token 交换（登录与续期共用）。 */
export const STS_TOKEN_URL = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';

/** 华为云 IAM 基址。 */
export const AUTH_BASE = 'https://auth.huaweicloud.com';

/** 真正的 OAuth 授权端点；果办的登录页用 `service=` 把这一整条塞进去。 */
export const AUTHORIZE_PATH = '/authui/v1/oauth2/authorize';

/** 果办用的登录页（含 `service` 参数的外层）。 */
export const LOGIN_PAGE = AUTH_BASE + '/authui/login.html';

/** 果办的 PKCE public client（无 secret）。 */
export const CLIENT_ID = 'pdp5_for_agentarts';

/**
 * 云端回调地址（路线 B）。
 *
 * 授权码由云端接住，插件轮询 `CODE_PATH` 取回来 —— 不需要本机端口，
 * 因此不受防火墙与端口占用影响。这是首选路线。
 */
export const CLOUD_REDIRECT_URI = CLAW_BASE + '/v1/claw/auth/callback';

/**
 * 本机回环回调路径（路线 A）。
 *
 * 路线 B 的 state 登记失败时回落到这里：本机起服务器接住 `?code=`。
 * 实测两个 client_id 都接受 `http://127.0.0.1:<port>/...` 形式的 redirect。
 */
export const LOOPBACK_REDIRECT_PATH = '/oauth/callback';

/** 模型网关兜底基址：凭据里没给 `model_api_url_base` 时用它。 */
export const OFFICIAL_MAAS_BASE = 'https://api.modelarts-maas.com';

/** 模型网关的路径前缀：云端下发的主机名不带它，必须补。 */
export const MAAS_PATH_PREFIX = '/v2';

/** 本机控制面（额度/套餐）的已知端口，按顺序试。 */
export const LOCAL_CONTROL_PORTS = [3004, 3003] as const;

/** 桌面端用户目录名（`$HOME` 下）。 */
export const OFFICE_CLAW_DIRNAME = '.office-claw';

/** 本机控制面的会话 cookie 文件。 */
export const SESSION_COOKIE_FILENAME = 'session.cookie';

/** `session.cookie` 的编码标记行；命中才走 DPAPI 解密。 */
export const SESSION_COOKIE_MARKER = 'OC-DPAPI-1';

/** 本机控制面请求时用的 cookie 名。写错（oc_session / oc_pt / auth）一律 401。 */
export const SESSION_COOKIE_NAME = 'oc_sid';

/** Windows 凭据管理器里果办凭据的目标名前缀。 */
export const WINCRED_PREFIX = 'OfficeAce/auth-sessions';

/** 凭据管理器里的 provider 段名。 */
export const WINCRED_PROVIDER = 'huawei-oauth';

/**
 * `models.json` 的相对路径（相对家目录）。
 *
 * 这条是 APIG「APP 认证」形态的凭据，与凭据管理器那条是**两代**不同的实现；
 * 两种都读，谁先读到可用的就用谁。
 */
export const ROUTING_STATE_SEGMENTS = [
  '.office-claw',
  '.jiuwenclaw',
  'config',
  'routing_state',
  'users',
] as const;

/** 自己的凭据仓库目录名（`$DSH_HOME` 下，与 `raccoon-vault` 同级）。 */
export const VAULT_DIRNAME = 'officeace-vault';

/** 插件状态文件名（界面开关，不走 settings）。 */
export const STATE_FILENAME = 'dsh-connect-huaweicloud-state.json';

/** 状态路由；浏览器半侧硬编码同一串，`scripts/check-client.mjs` 会校验。 */
export const STATUS_PATH = '/plugins/dsh-connect-huaweicloud/status';

/** 动作路由；同上。 */
export const ACTION_PATH = '/plugins/dsh-connect-huaweicloud/action';

/** 单次上游请求超时。 */
export const REQUEST_TIMEOUT_MS = 45_000;

/** SSE 空闲超时：这么久没有新帧就认为流断了。 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

/**
 * 果办单次响应的输出上限。
 *
 * 实测硬限：`max_tokens` 超过 131072 会在**流内**回 `ModelArts.81001`——此时 HTTP
 * 已经 200、无法重放，那一轮直接废掉。所以必须在发请求**之前**钳制。
 */
export const MAX_OUTPUT_TOKENS = 131_072;

/** 果办模型的上下文窗口（目录接口不给，统一按 1M 报）。 */
export const CONTEXT_WINDOW = 1_000_000;

/** 提前多久续期 STS（权限约 1 小时，留足余量）。 */
export const REFRESH_LEAD_MS = 10 * 60 * 1000;

/** 登录会话超时。授权码本身 5 分钟有效，留出换 token 与补 model_info 的余量。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** 轮询授权码的间隔。服务端 2 秒粒度，比它还快没有意义。 */
export const CODE_POLL_INTERVAL_MS = 2_000;

/** 模型目录缓存时长。 */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** 额度读数缓存时长（卡片轮询不该每次都打本机控制面）。 */
export const QUOTA_TTL_MS = 2 * 60 * 1000;

/** 图片请求预算，与 `dsh-llm-pi-ai` 的默认值一致。 */
export const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxRequestImages: 8,
  imageOffloadCountQuantum: 4,
} as const;
