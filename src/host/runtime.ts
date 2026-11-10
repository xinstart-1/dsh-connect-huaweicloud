/**
 * 运行时：把仓库、账号、目录、登录与上游编成一份「界面能读的状态 + 能执行的动作」。
 *
 * 这一层是**唯一**持有可变状态的地方（目录缓存、桌面端探测结果、当前服务账号）。
 * 它不做渲染（浏览器半边）、不做协议解析（`protocol/`）、不决定令牌怎么续（`accounts`）。
 *
 * 三条不变量：
 * 1. 任何动作的返回值都不含令牌 —— 页面能拿到的只有归一好的展示数据。
 * 2. 目录永远有值（最差是兜底表）。空目录会让模型选择器整组消失，而那个空选择器
 *    不会自己恢复（除非重启），所以「拉目录失败」只能保留旧值，不能清空。
 * 3. 额度只在有新鲜读数时参与展示；读不到就是不显示，绝不显示 0（会被读成「额度用完」）。
 *
 * @module dsh-connect-huaweicloud/host/runtime
 */

import type { DesktopProbe } from '../credentials/probe.ts';
import type { Vault } from '../credentials/vault.ts';
import type { GatewayModel } from '../protocol/client.ts';
import type {
  ActionResult,
  GatewayCredential,
  HostAction,
  QuotaReading,
  StatusSnapshot,
  StoredAccount,
} from '../types.ts';
import type { Accounts } from './accounts.ts';
import type { LoginManager } from './login.ts';
import { pickAccount } from './pool.ts';
import type { QuotaReader } from './quota.ts';

/** 兜底目录：没有任何可用凭据时也让分组可见（选中会报错，但比空分组好提示）。 */
export const FALLBACK_MODELS: readonly GatewayModel[] = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'kimi-k3',
].map((id) => ({
  id,
  name: id,
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  // 果办目录里没有对多模态的可靠标记，一律按纯文本处理：把图发给纯文本模型是硬拒绝。
  supportsImages: false,
}));

/** 桌面端探测结果的缓存时长：每次探测要起 PowerShell，约 400 ms。 */
const DESKTOP_PROBE_TTL_MS = 10 * 60 * 1000;

/** 运行时依赖。 */
export interface RuntimeOptions {
  readonly accounts: Accounts;
  readonly vault: Vault;
  readonly login: LoginManager;
  readonly quota: QuotaReader;
  /** 拉一次模型目录；失败抛错。 */
  readonly listModels: (gateway: GatewayCredential) => Promise<GatewayModel[]>;
  /** 读管理状态。 */
  readonly readState: () => {
    readonly accountPoolEnabled: boolean;
    readonly enabledAccounts: readonly string[];
    readonly selectedId?: string;
    readonly showQuota: boolean;
  };
  readonly saveState: (patch: {
    accountPoolEnabled?: boolean;
    enabledAccounts?: string[];
    selectedId?: string;
  }) => Promise<void>;
  /** 探测本机桌面端。 */
  readonly probeDesktop: () => Promise<DesktopProbe>;
  /** 构建状态快照。 */
  readonly buildStatus: (input: {
    accounts: readonly StoredAccount[];
    activeId?: string;
    desktop: DesktopProbe;
    modelCount: number;
  }) => Promise<StatusSnapshot>;
  readonly warn: (message: string) => void;
  /** 目录变化后通知 adapter 重建 profiles。 */
  readonly onCatalog?: (models: readonly GatewayModel[]) => void;
  /** 当前服务账号变化时通知入口（状态里要显示「当前使用」）。 */
  readonly onActiveChange?: (id: string | undefined) => void;
  readonly now?: () => number;
}

/** 运行时。 */
export interface Runtime {
  /** 构建状态文档（按需刷新缓存，但不主动发上游请求）。 */
  status(): Promise<StatusSnapshot>;
  /** 执行一个白名单动作。 */
  run(action: HostAction, body: Record<string, unknown>): Promise<ActionResult>;
  /** 当前可见目录（adapter 与模型发现都读它）。 */
  catalog(): readonly GatewayModel[];
  /** 上一次桌面端探测结果（状态快照读它）。 */
  desktop(): DesktopProbe;
  /** 某账号的额度读数（状态快照读它）。 */
  quotaOf(id: string): QuotaReading | undefined;
  /** 启动后预热：同步桌面端、拉目录。 */
  warm(): Promise<void>;
  /** 池候选（shim 换号用，已按优先级排序）。 */
  candidates(): Promise<readonly { accountId: string; gateway: GatewayCredential }[]>;
  /** 一次请求结束后回报结果，让健康度跟着真实结果走。 */
  noteOutcome(accountId: string, kind: 'success' | 'failure', failureKind?: string, message?: string): void;
  dispose(): void;
}

/** 从动作体里取非空字符串。 */
function textOf(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 从动作体里取字符串数组。 */
function stringsOf(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** 从动作体里取布尔字段。 */
function boolOf(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 建运行时。
 *
 * @param options - 账号、登录、额度、目录与状态读写。
 * @returns 运行时。
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const now = options.now ?? ((): number => Date.now());

  let catalog: readonly GatewayModel[] = FALLBACK_MODELS;
  let desktop: DesktopProbe = { installed: false, reason: 'desktop-missing', accounts: [] };
  let desktopProbedAtMs = 0;
  let activeId: string | undefined;
  const quotaByAccount = new Map<string, QuotaReading>();
  let disposed = false;

  /** 目录写入口：唯一一处更新缓存 + 通知 adapter。空结果不覆盖旧目录。 */
  const setCatalog = (next: readonly GatewayModel[]): void => {
    if (next.length === 0) return;
    catalog = next;
    options.onCatalog?.(catalog);
  };

  /**
   * 按优先级列出可尝试的账号 id。
   *
   * 池挑不出人（勾选为空 / 全不可用）时仍然要能读目录与发请求，所以退回「任意有凭据的账号」：
   * 让上游给出真实错误，比本地直接 503 更容易定位。
   */
  const attemptOrder = async (): Promise<string[]> => {
    const rows = await options.accounts.candidates();
    const state = options.readState();
    const choice = pickAccount({
      poolEnabled: state.accountPoolEnabled,
      ...(state.selectedId === undefined ? {} : { currentId: state.selectedId }),
      candidates: rows,
    });
    const order: string[] = [];
    if (choice.id !== undefined) order.push(choice.id);
    for (const row of rows) {
      if (!order.includes(row.id)) order.push(row.id);
    }
    if (order.length === 0 && state.selectedId !== undefined) order.push(state.selectedId);
    return order;
  };

  /** 拉一次目录；失败保留旧目录（目录是能活过重启的事实，一次失败不该让它消失）。 */
  const refreshCatalog = async (): Promise<string | undefined> => {
    for (const id of await attemptOrder()) {
      const gateway = await options.accounts.gatewayOf(id).catch(() => undefined);
      if (gateway === undefined) continue;
      try {
        setCatalog(await options.listModels(gateway));
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.warn(`刷新模型目录失败（继续使用现有目录）：${message}`);
        return message;
      }
    }
    options.warn('没有可用账号，模型目录保持兜底表');
    return '没有可用账号';
  };

  /** 探测桌面端；TTL 内复用结果。 */
  const probe = async (force: boolean): Promise<DesktopProbe> => {
    if (!force && desktopProbedAtMs !== 0 && now() - desktopProbedAtMs < DESKTOP_PROBE_TTL_MS) return desktop;
    try {
      desktop = await options.probeDesktop();
    } catch (error) {
      desktop = { installed: false, reason: 'desktop-unreadable', accounts: [] };
      options.warn(`探测本机果办客户端失败：${error instanceof Error ? error.message : String(error)}`);
    }
    desktopProbedAtMs = now();
    return desktop;
  };

  /** 读一个账号的额度并记进展示缓存。 */
  const readQuota = async (account: StoredAccount): Promise<void> => {
    const reading = await options.quota.read(account.id, account.userId);
    if (reading !== undefined) quotaByAccount.set(account.id, reading);
  };

  const statusOf = async (): Promise<StatusSnapshot> => {
    const stored = await options.vault.list();
    const probed = await probe(false);
    return options.buildStatus({
      accounts: stored,
      ...(activeId === undefined ? {} : { activeId }),
      desktop: probed,
      modelCount: catalog.length,
    });
  };

  const setActive = (id: string | undefined): void => {
    if (activeId === id) return;
    activeId = id;
    options.onActiveChange?.(id);
  };

  return {
    async status() {
      // 顺带刷新额度：卡片轮询是唯一会来读状态的地方。
      const stored = await options.vault.list();
      if (options.readState().showQuota) {
        await Promise.all(stored.map((account) => readQuota(account).catch(() => undefined)));
      }
      return statusOf();
    },

    async run(action, body) {
      switch (action) {
        case 'refresh': {
          const error = await refreshCatalog();
          await probe(true);
          options.quota.clear();
          return {
            ok: error === undefined,
            ...(error === undefined ? { message: '已刷新' } : { message: error }),
            status: await statusOf(),
          };
        }

        case 'sync-desktop': {
          const probed = await probe(true);
          if (!probed.installed) {
            return {
              ok: false,
              message: '没检测到果办客户端：' + (probed.reason ?? '未知原因'),
              status: await statusOf(),
            };
          }
          const result = await options.accounts.syncDesktop();
          await refreshCatalog();
          options.quota.clear();
          return {
            ok: true,
            message:
              `已同步 ${String(result.imported)} 个账号` +
              (result.skipped > 0 ? `，跳过 ${String(result.skipped)} 条` : ''),
            status: await statusOf(),
          };
        }

        case 'login-start': {
          const view = await options.login.start();
          await refreshCatalog();
          return {
            ok: view.phase !== 'failed',
            ...(view.message === undefined ? {} : { message: view.message }),
            status: await statusOf(),
          };
        }

        case 'login-status':
          return { ok: true, status: await statusOf() };

        case 'login-cancel':
          options.login.cancel();
          return { ok: true, message: '已取消登录', status: await statusOf() };

        case 'switch-account': {
          const id = textOf(body, 'accountId');
          if (id === undefined) return { ok: false, message: '缺少 accountId' };
          await options.saveState({ selectedId: id });
          // 换号证明用户想用这个账号：清掉它可能残留的停用/冷却。
          options.accounts.enable(id);
          setActive(id);
          return { ok: true, status: await statusOf() };
        }

        case 'remove-account': {
          const id = textOf(body, 'accountId');
          if (id === undefined) return { ok: false, message: '缺少 accountId' };
          const removed = await options.vault.remove(id);
          const state = options.readState();
          if (state.enabledAccounts.includes(id)) {
            await options.saveState({ enabledAccounts: state.enabledAccounts.filter((entry) => entry !== id) });
          }
          if (state.selectedId === id) await options.saveState({ selectedId: '' });
          if (activeId === id) setActive(undefined);
          await refreshCatalog();
          return {
            ok: removed,
            message: removed ? '已删除（客户端的登录不受影响）' : '这条记录不存在',
            status: await statusOf(),
          };
        }

        case 'members': {
          const ids = stringsOf(body, 'accountIds');
          if (ids === undefined) return { ok: false, message: '缺少 accountIds' };
          await options.saveState({ enabledAccounts: ids });
          return { ok: true, status: await statusOf() };
        }

        case 'settings': {
          const poolEnabled = boolOf(body, 'poolEnabled');
          if (poolEnabled === undefined) return { ok: false, message: '没有要改的设置' };
          await options.saveState({ accountPoolEnabled: poolEnabled });
          return { ok: true, status: await statusOf() };
        }

        case 'test-account': {
          const id = textOf(body, 'accountId');
          if (id === undefined) return { ok: false, message: '缺少 accountId' };
          const gateway = await options.accounts.gatewayOf(id);
          if (gateway === undefined) {
            return { ok: false, message: '这个账号没有可用的模型网关凭据', status: await statusOf() };
          }
          try {
            const models = await options.listModels(gateway);
            // 测试成功证明凭据可用：清掉之前因失败累积的停用/冷却。
            options.accounts.enable(id);
            options.accounts.noteSuccess(id);
            return {
              ok: true,
              message: `凭据可用，目录 ${String(models.length)} 个模型`,
              status: await statusOf(),
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, message: `测试失败：${message}`, status: await statusOf() };
          }
        }

        default: {
          // 穷尽性检查：新增 HostAction 时这里会编译报错，而不是静默走进 default。
          const unreachable: never = action;
          return { ok: false, message: `未知动作：${String(unreachable)}` };
        }
      }
    },

    catalog() {
      return catalog;
    },

    desktop() {
      return desktop;
    },

    quotaOf(id) {
      return quotaByAccount.get(id);
    },

    async warm() {
      if (disposed) return;
      await probe(false);
      if (options.readState().enabledAccounts.length === 0) {
        // 首次启动且池成员为空：把已有账号默认勾进池。
        // 空名单的语义是「一个都没勾」，所以这里必须显式写一次，不能靠它自动生效。
        const stored = await options.vault.list();
        if (stored.length > 0) {
          await options.saveState({ enabledAccounts: stored.map((account) => account.id) });
        }
      }
      await refreshCatalog();
    },

    async candidates() {
      const out: { accountId: string; gateway: GatewayCredential }[] = [];
      for (const id of await attemptOrder()) {
        const gateway = await options.accounts.gatewayOf(id).catch(() => undefined);
        if (gateway !== undefined) out.push({ accountId: id, gateway });
      }
      return out;
    },

    noteOutcome(accountId, kind, failureKind, message) {
      if (kind === 'success') {
        options.accounts.noteSuccess(accountId);
        setActive(accountId);
        return;
      }
      options.accounts.noteFailure(
        accountId,
        (failureKind ?? 'server') as Parameters<Accounts['noteFailure']>[1],
        message ?? '',
      );
    },

    dispose() {
      disposed = true;
      setActive(undefined);
      quotaByAccount.clear();
    },
  };
}
