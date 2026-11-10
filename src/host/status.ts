/**
 * 状态快照：把仓库、账号、池、目录与登录相位汇成一份「界面能读、且不含令牌」的文档。
 *
 * 为什么单独一层：状态是浏览器半侧**唯一**的数据来源，字段名写错不会报错、
 * 只会静默显示空白。把它集中在这里，字段与 `src/types.ts` 的 `StatusSnapshot`
 * 一处对齐，而不是散在 runtime 的各个动作里。
 *
 * 不变量：任何字段都不得携带 access token / refresh token / appSecret / DPoP 私钥。
 *
 * @module dsh-connect-huaweicloud/host/status
 */

import { VERSION } from '../constants.ts';
import type { AccountView, QuotaReading, StatusSnapshot, StoredAccount } from '../types.ts';
import type { Accounts } from './accounts.ts';
import type { LoginManager } from './login.ts';

/** 构建状态所需的依赖。 */
export interface StatusDeps {
  readonly accounts: Accounts;
  readonly login: LoginManager;
  /** 读出全部账号记录（由 `vault.list` 提供）。 */
  readonly listAccounts: () => Promise<readonly StoredAccount[]>;
  readonly readState: () => {
    readonly accountPoolEnabled: boolean;
    readonly enabledAccounts: readonly string[];
    readonly selectedId?: string;
  };
  /** 桌面端探测结果；由 runtime 缓存后传进来。 */
  readonly desktop: () => { readonly installed: boolean; readonly reason?: string };
  /** 当前目录里的模型数；空目录意味着没有任何可用凭据。 */
  readonly modelCount: () => number;
  /** 本轮请求实际在用的账号 id。 */
  readonly activeId: () => string | undefined;
  /** 额度读数；`showQuota` 为 false 时不该被调用。 */
  readonly quotaOf: (id: string) => QuotaReading | undefined;
  readonly showQuota: () => boolean;
}

/** `createStatus` 的输入：仓库记录与缓存的探测结果由调用方传入。 */
export interface StatusInput {
  readonly accounts: readonly StoredAccount[];
  readonly activeId?: string;
  readonly desktop: { readonly installed: boolean; readonly reason?: string };
  readonly modelCount: number;
}

/**
 * 把一条存储记录变成界面行。
 *
 * @param account - 仓库里的记录。
 * @param deps - 需要可用性与额度。
 * @param nowMs - 当前时间（算 STS 余量）。
 */
function toView(account: StoredAccount, deps: StatusDeps, nowMs: number): AccountView {
  const usability = deps.accounts.usability(account);
  const raw = account.sts?.expiresAt;
  const remaining = raw === undefined || raw === '' ? undefined : Date.parse(raw) - nowMs;
  const quota = deps.showQuota() ? deps.quotaOf(account.id) : undefined;
  return {
    id: account.id,
    label: account.label,
    userName: account.userName,
    origin: account.origin,
    // import 来的没有 DPoP 私钥，续期不了；只有 login 得到的能续。
    renewable: account.sts !== undefined && account.origin !== 'import',
    hasGateway: account.gateway !== undefined,
    ...(remaining === undefined || !Number.isFinite(remaining) ? {} : { stsRemainingMs: remaining }),
    inPool: false,
    usable: usability.usable,
    ...(usability.reason === undefined ? {} : { reason: usability.reason }),
    ...(quota === undefined ? {} : { quota }),
    syncedAtMs: account.syncedAtMs,
    ...(account.syncError === undefined ? {} : { syncError: account.syncError }),
  };
}

/**
 * 建状态快照。
 *
 * @param deps - 账号、登录与状态来源。
 * @returns 快照函数；调用方传入已缓存的仓库记录与探测结果，因此不会自己发上游请求。
 */
export function createStatus(deps: StatusDeps): (input: StatusInput) => Promise<StatusSnapshot> {
  return async (input) => {
    const nowMs = Date.now();
    const state = deps.readState();
    const enabled = new Set(state.enabledAccounts);

    const accounts: AccountView[] = input.accounts.map((account) => ({
      ...toView(account, deps, nowMs),
      inPool: enabled.has(account.id),
    }));

    return {
      version: VERSION,
      accounts,
      poolEnabled: state.accountPoolEnabled,
      ...(state.selectedId === undefined ? {} : { selectedId: state.selectedId }),
      ...(input.activeId === undefined ? {} : { activeId: input.activeId }),
      login: deps.login.status(),
      desktopDetected: input.desktop.installed,
      ...(input.desktop.reason === undefined ? {} : { desktopReason: input.desktop.reason }),
      modelCount: input.modelCount,
    };
  };
}
