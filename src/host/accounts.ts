/**
 * 账号生命周期：从本机客户端收号、按需续期、判可用性、记冷却。
 *
 * 三条续期不变量，每条都对应一次会永久损坏账号的事故：
 * 1. **同一账号同一时刻只有一个续期在跑**（`Map<string, Promise<StsCredential>>` 单飞）。
 *    refresh_token 一次性，两个并发续期会让后到的那个被上游拒绝，账号直接废掉。
 *    键用**账号 id** 而不是参考实现里的 refreshToken：本仓库的 vault 保证一个 id 只有
 *    一份凭据（文件名由身份派生、同 id 覆盖），所以 id 与「这份凭据」一一对应；
 *    换句话说在这里「键凭据身份」与「键账号 id」等价，而 id 更稳 —— 续期成功后
 *    refreshToken 就换了，用旧 token 当键会让同一份凭据的两个调用拿到两把锁。
 * 2. **续期成功后立刻 `vault.save()`**，不等网关凭据、不等任何后续步骤。旧的 refresh_token
 *    在续期成功的瞬间已作废，不落盘就永久丢失，账号只能重新登录。
 * 3. **续期失败但令牌还没过期 → 继续用旧的**。一次网络抖动不该让本来能成功的请求失败；
 *    只有「续期失败且确实已过期」才标记不可用，让下一次选号跳过它。
 *
 * 冷却时长按失败分类给：认证失败只能重新登录，重试无意义，停用 1 小时；额度耗尽与上游 5xx
 * 是暂时状态，冷却 30 分钟 / 30 秒；限流按分钟窗口重置，冷却 15 秒；请求本身、模型层面与
 * 转发层的问题与账号无关，一律不惩罚账号 —— 否则一个坏模型名就能把好账号踢出池子。
 *
 * @module dsh-connect-huaweicloud/host/accounts
 */

import { REFRESH_LEAD_MS } from '../constants.ts';
import { accountIdFor, type Vault } from '../credentials/vault.ts';
import { readState } from '../state.ts';
import type {
  GatewayCredential,
  PoolCandidate,
  StoredAccount,
  StsCredential,
  Usability,
} from '../types.ts';

/**
 * 失败分类（局部声明，与 `protocol/errors.ts` 的 `FailureKind` 逐字相同）。
 *
 * 并行开发期间那个文件还不存在；Lead 之后会把它换成真 import，取值与含义按契约钉死。
 */
type FailureKind =
  | 'authentication'
  | 'hard-credit'
  | 'server'
  | 'soft-rate'
  | 'client'
  | 'model-unavailable'
  | 'not-found';

/**
 * 一次桌面端探测的结果（局部声明，与 `credentials/probe.ts` 的 `DesktopProbe` 同形）。
 *
 * 同样是为了不因并行文件缺席而阻塞；形状按 `docs/CONTRACT.md` 的 `credentials/probe.ts` 段抄。
 */
interface DesktopProbe {
  readonly installed: boolean;
  readonly reason?: string;
  readonly accounts: readonly ImportedAccount[];
}

/** 从桌面端读到的一份账号凭据（局部声明，与 `ImportedAccount` 同形）。 */
interface ImportedAccount {
  readonly userId: string;
  readonly userName: string;
  readonly gateway?: GatewayCredential;
  /** 读到了 STS 但拿不到对应私钥时，这里只有元信息（不能续期）。 */
  readonly sts?: { readonly securityToken: string; readonly expiresAt: string };
  /** 这份凭据是从哪个入口读到的；诊断用。 */
  readonly via: 'wincred' | 'models-json';
}

/** 账号运行时的依赖。 */
export interface AccountsDeps {
  vault: Vault;
  probe: () => Promise<DesktopProbe>;
  refreshSts: (credential: StsCredential) => Promise<StsCredential>;
  fetchGateway: (credential: StsCredential) => Promise<GatewayCredential | undefined>;
  warn: (message: string) => void;
}

/** 账号运行时。 */
export interface Accounts {
  /** 把本机客户端读到的账号并入仓库（幂等；同一身份覆盖同一条）。 */
  syncDesktop(): Promise<{ imported: number; skipped: number }>;
  /** 保存一次登录结果。 */
  adopt(credential: StsCredential): Promise<StoredAccount>;
  /** 取一个账号的网关凭据；STS 临期时先续期（单飞）。 */
  gatewayOf(id: string): Promise<GatewayCredential | undefined>;
  /** 可用性判定（过期/无凭据/冷却/停用）。 */
  usability(account: StoredAccount): Usability;
  /** 记一次失败（池记账）。 */
  noteFailure(id: string, kind: FailureKind, message: string): void;
  /** 记一次成功：清掉冷却与上次错误。 */
  noteSuccess(id: string): void;
  /** 清掉某账号的停用/冷却（重登或同步成功后调）。 */
  enable(id: string): void;
  /** 全部账号的池候选快照。 */
  candidates(): Promise<PoolCandidate[]>;
  dispose(): void;
}

/** 工厂选项：只放测试需要的注入点，业务依赖一律在 {@link AccountsDeps} 里。 */
export interface AccountsOptions {
  /** 注入的时钟，冷却时长断言需要它，默认 `Date.now`。 */
  now?: () => number;
  /** 池成员名单（状态文件里的勾选结果）；默认读插件状态文件。 */
  members?: () => Promise<readonly string[]>;
}

/** 认证失败后停用多久：只能重新登录，这期间重试没有任何意义。 */
const AUTH_DISABLED_MS = 60 * 60 * 1000;

/** 额度耗尽后冷却多久：额度周期会重置，所以只短暂跳过，不永久踢出。 */
const HARD_CREDIT_COOLDOWN_MS = 30 * 60 * 1000;

/** 上游 5xx / 网络故障后的短冷却。 */
const SERVER_COOLDOWN_MS = 30 * 1000;

/** 限流后的冷却：窗口通常按分钟重置，比它还长的冷却只是白等。 */
const SOFT_RATE_COOLDOWN_MS = 15 * 1000;

/** 一个账号的健康度账本，只在内存里：重启后由实际请求重新判定。 */
interface Health {
  /** 停用到此刻为止；`0` 表示没停用。 */
  disabledUntilMs: number;
  /** 冷却到此刻为止；`0` 表示没在冷却。 */
  coolUntilMs: number;
  /** 最近一次失败的人话原因，给界面与日志。 */
  lastError?: string;
}

/** 解不出的到期时间统一按「未知」处理，而不是「已过期」。 */
function expiresAtMsOf(expiresAt: string | undefined): number | undefined {
  if (expiresAt === undefined || expiresAt === '') return undefined;
  const parsed = Date.parse(expiresAt);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** STS 是否已经过期；解不出到期时间时按「可能还有效」交给上游判。 */
function isExpired(credential: StsCredential, nowMs: number): boolean {
  const expiresAtMs = expiresAtMsOf(credential.expiresAt);
  return expiresAtMs !== undefined && expiresAtMs <= nowMs;
}

/** 这份 STS 是否还具备续期能力（refresh_token 与 DPoP 私钥都缺一不可）。 */
function renewable(credential: StsCredential): boolean {
  return credential.refreshToken !== '' && credential.dpopPrivateJwk.d !== '';
}

/** 把剩余毫秒说成人话，冷却原因要能直接上界面。 */
function describeRemaining(remainingMs: number): string {
  if (remainingMs >= 60_000) return `还剩约 ${String(Math.ceil(remainingMs / 60_000))} 分钟`;
  return `还剩约 ${String(Math.ceil(remainingMs / 1000))} 秒`;
}

/**
 * 池成员名单的默认实现：读插件状态文件里的勾选结果。
 *
 * 空数组是合法的「一个都没勾」，不从账号列表反推，否则取消全部勾选会变成全选。
 */
async function stateMembers(): Promise<readonly string[]> {
  const state = await readState();
  return state.enabledAccounts;
}

/** 一次续期判定的结果：可用凭据 + 它是不是刚换来的（决定还要不要补网关）。 */
interface Freshness {
  readonly credential: StsCredential;
  readonly renewed: boolean;
}

/**
 * 建账号运行时。
 *
 * @param deps - 仓库、探测、续期、取网关与告警注入。
 * @param options - 可选的时钟与池成员来源（测试用）；不传时钟时用 `Date.now`。
 * @returns 账号运行时句柄。
 */
export function createAccounts(deps: AccountsDeps, options: AccountsOptions = {}): Accounts {
  const now = options.now ?? ((): number => Date.now());
  const members = options.members ?? stateMembers;

  /** 账号健康度：停用与冷却都是「此刻」的事实，落盘反而会让重启后误判。 */
  const health = new Map<string, Health>();
  /** 续期单飞表：键是账号 id（见文件头第 1 条不变量）。 */
  const refreshes = new Map<string, Promise<StsCredential>>();

  const healthOf = (id: string): Health => {
    const existing = health.get(id);
    if (existing !== undefined) return existing;
    const fresh: Health = { disabledUntilMs: 0, coolUntilMs: 0 };
    health.set(id, fresh);
    return fresh;
  };

  const disable = (id: string, reason: string): void => {
    const entry = healthOf(id);
    entry.disabledUntilMs = now() + AUTH_DISABLED_MS;
    entry.lastError = reason;
  };

  const cooldown = (id: string, durationMs: number, reason: string): void => {
    const entry = healthOf(id);
    entry.coolUntilMs = now() + durationMs;
    entry.lastError = reason;
  };

  const enable = (id: string): void => {
    const entry = healthOf(id);
    entry.disabledUntilMs = 0;
    entry.coolUntilMs = 0;
    delete entry.lastError;
  };

  /** 可用性判定；`candidates()` 与对外接口共用这一份，避免两处判定漂移。 */
  const usabilityOf = (account: StoredAccount): Usability => {
    const entry = healthOf(account.id);
    const nowMs = now();
    if (entry.disabledUntilMs > nowMs) {
      return {
        usable: false,
        reason: `已停用（${entry.lastError ?? '需要重新登录'}），${describeRemaining(
          entry.disabledUntilMs - nowMs,
        )}`,
      };
    }
    if (entry.coolUntilMs > nowMs) {
      return {
        usable: false,
        reason: `冷却中（${entry.lastError ?? '最近一次失败'}），${describeRemaining(
          entry.coolUntilMs - nowMs,
        )}`,
      };
    }
    if (account.gateway !== undefined) return { usable: true };
    if (account.sts === undefined) {
      // 既没有网关也不能续期：这条记录只能靠重新同步或登录。
      return { usable: false, reason: account.syncError ?? '没有可用凭据，请重新同步或登录' };
    }
    if (isExpired(account.sts, nowMs) && !renewable(account.sts)) {
      // 过期且没有 refresh_token / 私钥（`import` 来的那种），续期无从谈起。
      return { usable: false, reason: 'STS 已过期且无法续期，请重新同步或登录' };
    }
    // 过期但仍可续期时不算不可用：`gatewayOf` 会先续期再取网关。
    return { usable: true };
  };

  /**
   * 确保某个账号的 STS 新鲜；临期才续期，且同一账号并发只真正续一次。
   *
   * @param account - 当前记录；没有 `sts` 时无从续期。
   * @returns 可用凭据与「是否刚换过」；第 3 条不变量判定为不可用时返回 `undefined`。
   */
  const ensureFresh = async (account: StoredAccount): Promise<Freshness | undefined> => {
    const sts = account.sts;
    if (sts === undefined) return undefined;

    const expiresAtMs = expiresAtMsOf(sts.expiresAt);
    const needsRefresh = expiresAtMs === undefined || expiresAtMs - now() <= REFRESH_LEAD_MS;
    if (!needsRefresh) return { credential: sts, renewed: false };

    const inflight = refreshes.get(account.id);
    const shared = inflight ?? startRefresh(account, sts);
    const result = await shared;
    // 续期一定轮转 refresh_token，所以「换过没有」可以按它判断；不用对象身份，
    // 因为续期实现把同一个对象原样传回来时也该被认成「没换」。
    const renewed = result.refreshToken !== sts.refreshToken;
    if (isExpired(result, now())) return undefined;
    return { credential: result, renewed };
  };

  /**
   * 启动一次续期并登记进单飞表。
   *
   * @param account - 触发续期的账号快照。
   * @param sts - 那快照里的 STS，续期失败时原样返回它。
   * @returns 与 `refreshSts` 结果同源的 Promise，所有并发调用者共享同一个。
   */
  function startRefresh(account: StoredAccount, sts: StsCredential): Promise<StsCredential> {
    const task = (async (): Promise<StsCredential> => {
      try {
        const next = await deps.refreshSts(sts);
        // 第 2 条不变量：此刻旧 refresh_token 已作废，任何后续步骤都不能排到这行之前。
        await deps.vault.save({ ...account, sts: next, savedAtMs: now(), syncedAtMs: now() });
        // 续期成功证明凭据可用，之前因失败攒下的停用/冷却不该再拦它。
        enable(account.id);
        return next;
      } catch (error) {
        deps.warn(
          `续期账号 ${account.id} 失败：${error instanceof Error ? error.message : String(error)}`,
        );
        // 第 3 条不变量：还没过期就继续用旧的，一次抖动不该毁掉可用账号。
        if (isExpired(sts, now())) {
          disable(account.id, 'STS 已过期且续期失败，需要重新登录');
          deps.warn(`账号 ${account.id} 的 STS 已过期且续期失败，已停用 1 小时`);
        }
        return sts;
      }
    })().finally(() => {
      refreshes.delete(account.id);
    });
    refreshes.set(account.id, task);
    return task;
  }

  /** 单条探测结果的落库；抛错由调用方计入 `skipped`。 */
  const importOne = async (imported: ImportedAccount): Promise<void> => {
    const userId = imported.userId.trim();
    const userName = imported.userName.trim();
    // 身份优先 userId：userName 可能被用户改名，改了就变成另一个账号。
    const accountKey = userId !== '' ? userId : userName;
    if (accountKey === '') throw new Error('缺少 userId 与 userName，无法算出账号身份');

    const id = accountIdFor(accountKey);
    const existing = await deps.vault.get(id);
    // 已有可续期的 STS（来自登录）时不被一次「只有元信息」的同步覆盖掉续期能力。
    const keepSts = imported.sts === undefined ? existing?.sts : undefined;
    const stsNote =
      imported.sts === undefined || keepSts !== undefined
        ? undefined
        : `本机客户端只给了 STS 元信息（到期 ${
            imported.sts.expiresAt === '' ? '未知' : imported.sts.expiresAt
          }），拿不到配套私钥，这份凭据只能用到过期；过期后请重新登录或重新同步`;
    const hasCredential = imported.gateway !== undefined || keepSts !== undefined;

    const account: StoredAccount = {
      id,
      accountKey,
      label: userName !== '' ? userName : userId,
      userId,
      userName,
      // 有网关或 STS 都可能是「读来的」；保留既有 STS 时来源仍是登录。
      origin: keepSts !== undefined ? 'login' : 'import',
      ...(keepSts !== undefined ? { sts: keepSts } : {}),
      ...(imported.gateway !== undefined ? { gateway: imported.gateway } : {}),
      savedAtMs: now(),
      syncedAtMs: now(),
      ...(stsNote !== undefined
        ? { syncError: stsNote }
        : hasCredential
          ? {}
          : { syncError: '没读到网关凭据与 STS，暂时无法对话' }),
    };
    await deps.vault.save(account);
    // 同步成功等于这条记录此刻可用，旧的停用/冷却不该继续拦它。
    enable(id);
  };

  return {
    async syncDesktop() {
      const probe = await deps.probe();
      let imported = 0;
      let skipped = 0;
      for (const account of probe.accounts) {
        try {
          await importOne(account);
          imported += 1;
        } catch (error) {
          // 一条坏记录不该中断整批：其余账号照样能同步进来。
          skipped += 1;
          deps.warn(
            `同步本机账号失败（${account.userId || account.userName || '未知身份'}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return { imported, skipped };
    },

    async adopt(credential) {
      // `StsCredential` 里没有 userId 字段，`domainId` 是响应中唯一稳定的账号身份串：
      // 同一账号重新登录会得到同一个值，因此用它派生 id（契约里的「userId」在登录
      // 响应里的对应字段就是它）。
      const accountKey = credential.domainId.trim();
      if (accountKey === '') throw new Error('登录结果里缺少 domainId，无法确定账号身份');
      const id = accountIdFor(accountKey);
      const existing = await deps.vault.get(id);

      // 网关拿不到也照样存：STS 已能续期，补网关是下一次 `gatewayOf` 的事。
      let gateway: GatewayCredential | undefined;
      try {
        gateway = await deps.fetchGateway(credential);
      } catch (error) {
        deps.warn(
          `登录后取网关凭据失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const account: StoredAccount = {
        id,
        accountKey,
        label: existing?.label ?? accountKey,
        userId: existing?.userId ?? '',
        userName: existing?.userName ?? '',
        origin: 'login',
        sts: credential,
        ...(gateway !== undefined ? { gateway } : {}),
        savedAtMs: now(),
        syncedAtMs: now(),
      };
      await deps.vault.save(account);
      // 重登换了新凭据，旧的停用/冷却不能再拦它。
      enable(id);
      return account;
    },

    async gatewayOf(id) {
      const account = await deps.vault.get(id);
      if (account === undefined) {
        deps.warn(`取网关凭据失败：账号 ${id} 不在本机`);
        return undefined;
      }
      if (account.gateway !== undefined) return account.gateway;
      if (account.sts === undefined) {
        deps.warn(`账号 ${id} 既没有网关凭据也没有可续期的 STS，无法对话`);
        return undefined;
      }

      const fresh = await ensureFresh(account);
      if (fresh === undefined) return undefined;

      let gateway: GatewayCredential | undefined;
      try {
        gateway = await deps.fetchGateway(fresh.credential);
      } catch (error) {
        deps.warn(
          `为账号 ${id} 取网关凭据失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
      if (gateway === undefined) return undefined;
      // 续期后的 STS 已在 `ensureFresh` 里落盘，这里只补网关。
      await deps.vault.save({
        ...account,
        sts: fresh.credential,
        gateway,
        savedAtMs: now(),
        syncedAtMs: now(),
      });
      return gateway;
    },

    usability: usabilityOf,

    enable(id) {
      enable(id);
    },

    noteFailure(id, kind, message) {
      healthOf(id).lastError = message;
      switch (kind) {
        case 'authentication':
          // 只能重新登录：重试一万次也是 401，停用 1 小时并等用户介入。
          disable(id, message);
          return;
        case 'hard-credit':
          cooldown(id, HARD_CREDIT_COOLDOWN_MS, message);
          return;
        case 'server':
          cooldown(id, SERVER_COOLDOWN_MS, message);
          return;
        case 'soft-rate':
          cooldown(id, SOFT_RATE_COOLDOWN_MS, message);
          return;
        case 'client':
        case 'model-unavailable':
        case 'not-found':
          // 请求本身 / 模型层面 / 转发层的问题与账号无关：记录错误，不动健康度。
          return;
      }
    },

    noteSuccess(id) {
      const entry = healthOf(id);
      entry.coolUntilMs = 0;
      delete entry.lastError;
      // 刻意不顺手清停用：停用是「需要重新登录」的判断，只能由 `enable`（重登/同步）撤销，
      // 否则一次侥幸成功就会让一个该重登的账号继续被反复选中。
    },

    async candidates() {
      const accounts = await deps.vault.list();
      const inPool = new Set(await members());
      return accounts.map((account) => {
        const verdict = usabilityOf(account);
        const expiresAtMs = expiresAtMsOf(account.sts?.expiresAt);
        return {
          id: account.id,
          inPool: inPool.has(account.id),
          usable: verdict.usable,
          ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
          // 余额与额度到期时间由额度模块另行读取，这里不编造读数。
          ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
        };
      });
    },

    dispose() {
      // 进行中的续期不主动取消：网络请求已经发出，掐断反而可能让 refresh_token 被上游
      // 消费却拿不到新凭据。清掉两张表即可，落盘由各自的任务自己完成。
      refreshes.clear();
      health.clear();
    },
  };
}
