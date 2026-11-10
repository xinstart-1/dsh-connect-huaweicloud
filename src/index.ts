/**
 * Cordis 插件入口：装配仓库、账号、登录、shim、LLM 注册与宿主路由。
 *
 * 装配顺序不是随意的，改之前先看这三条：
 * 1. **adapter 注册不能等网络** —— 目录先用兜底表注册上，登录态可用时再替换。
 *    否则「刚装好还没登录」的用户会看到选择器里一个模型都没有，而那个空选择器
 *    不会自己变好（除非重启）。
 * 2. **shim 必须先于 adapter 起** —— adapter 的 apiKey 与 baseUrl 都来自 shim。
 * 3. **登录态读取放到 apply 之后**（`warm`）—— apply 期间宿主还在装配插件树，
 *    在里面发网络请求会拖慢整个启动。
 *
 * 这里只负责接线：谁先谁后、谁在卸载时释放什么。真正的行为在 `host/`（状态与动作）、
 * `auth/`（登录）、`credentials/`（凭据）、`protocol/`（上游契约）、`shim/`（换号）里。
 *
 * @module dsh-connect-huaweicloud
 */

import { spawn } from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import { Config, type HuaweiCloudConfig } from './config.ts';
import { DISPLAY_NAME, PROVIDER, SETTINGS_NS, VERSION } from './constants.ts';
import { huaweicloudHome } from './paths.ts';
import { readState, writeState, type PluginState } from './state.ts';
import { createVault } from './credentials/vault.ts';
import { probeDesktop } from './credentials/probe.ts';
import { readLocalSession } from './credentials/dpapi.ts';
import { refreshSts, startLogin } from './auth/oauth.ts';
import { fetchGateway } from './auth/subscription.ts';
import { chatStream, clampRequestBody, listModels } from './protocol/client.ts';
import { createAccounts } from './host/accounts.ts';
import { createLoginManager } from './host/login.ts';
import { createQuotaReader } from './host/quota.ts';
import { createRuntime, type Runtime } from './host/runtime.ts';
import { createStatus } from './host/status.ts';
import { registerRoutes } from './host/routes.ts';
import { createHuaweiCloudAdapter, toLlmModelInfos } from './llm/adapter.ts';
import { startShim, type ShimHandle } from './shim/server.ts';

/** 插件名（Cordis 用它做诊断前缀）。 */
export const name = 'dsh-connect-huaweicloud';

/** 依赖的服务：没有 llm 就没有模型路由可注册。 */
export const inject = ['llm'];

/**
 * 配置 schema：Loader 从这里读默认值与 JSON Schema。
 *
 * 必须是 `apply` 同一个模块的命名导出 —— Loader 的 `unwrapExports` 只看顶层导出。
 */
export { Config };

/**
 * 用系统默认浏览器打开一个 URL。
 *
 * Windows 上**不能**走 `cmd /c start`：cmd 会把 URL 里的 `&` 当成命令分隔符，
 * 浏览器只拿到 `?service=` 那一段（缺 redirect 与 state），授权页会直接判为普通
 * 网页登录、不再回调。用两条路径是因为单靠一条会静默失败：`rundll32` 稳定返回 0，
 * `explorer.exe` 有时浏览器仍然弹出来但退出码是 1。
 *
 * @param url - 要打开的地址。
 * @returns 是否至少有一条启动路径被系统接受。
 */
function openBrowser(url: string): boolean {
  if (process.platform !== 'win32') {
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  const launchers: Array<[string, string[]]> = [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['explorer.exe', [url]],
  ];
  let opened = false;
  for (const [file, args] of launchers) {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
      opened = true;
    } catch {
      // 换下一条路径。
    }
  }
  return opened;
}

/**
 * 插件应用函数。
 *
 * @param ctx - Cordis 上下文。
 * @param rawConfig - 用户在设置页填的配置。
 */
export async function apply(ctx: Context, rawConfig: HuaweiCloudConfig): Promise<void> {
  const config = { ...Config({}), ...rawConfig } as HuaweiCloudConfig;
  const warn = (message: string): void => {
    ctx.logger.warn(`[${name}] ${message}`);
  };

  const home = huaweicloudHome();
  const vault = createVault({ home });
  /** 插件状态在内存里有一份，写盘后同步更新（避免每个动作都读一次盘）。 */
  let pluginState: PluginState = await readState({ home });

  const saveState = async (patch: Partial<PluginState>): Promise<void> => {
    pluginState = await writeState(patch, { home });
  };

  const accounts = createAccounts({
    vault,
    probe: () => probeDesktop(),
    refreshSts: (credential) => refreshSts(credential),
    fetchGateway: (credential) => fetchGateway(credential),
    warn,
  });

  const quota = createQuotaReader({ readSession: () => readLocalSession(), warn });

  const login = createLoginManager({
    start: () => startLogin(),
    adopt: async (credential) => {
      const account = await accounts.adopt(credential);
      // 新登录的账号默认勾进池：用户点「登录」的意图就是「我要用它」。
      if (!pluginState.enabledAccounts.includes(account.id)) {
        await saveState({ enabledAccounts: [...pluginState.enabledAccounts, account.id] });
      }
    },
    openBrowser,
    warn,
  });

  let shim: ShimHandle | undefined;
  let runtime: Runtime | undefined;
  let adapter: ReturnType<typeof createHuaweiCloudAdapter> | undefined;
  /** 本轮请求实际在用的账号；由 shim 的成功/换号回调更新。 */
  let activeAccountId: string | undefined;
  let disposed = false;

  const buildStatus = createStatus({
    accounts,
    login,
    listAccounts: () => vault.list(),
    readState: () => pluginState,
    desktop: () => runtime?.desktop() ?? { installed: false, reason: 'desktop-missing' },
    modelCount: () => runtime?.catalog().length ?? 0,
    activeId: () => activeAccountId,
    quotaOf: (id) => runtime?.quotaOf(id),
    showQuota: () => pluginState.showQuota,
  });

  runtime = createRuntime({
    accounts,
    vault,
    login,
    quota,
    listModels: (gateway) => listModels(gateway),
    readState: () => pluginState,
    saveState: async (patch) => {
      await saveState(patch as Partial<PluginState>);
    },
    probeDesktop: () => probeDesktop(),
    buildStatus: (input) => buildStatus(input),
    warn,
    onCatalog: () => {
      adapter?.invalidate();
    },
    onActiveChange: (id) => {
      activeAccountId = id;
    },
  });

  // 1. 起 shim：换号必须发生在请求发出之前，那需要比 pi-ai 更早的一层。
  shim = await startShim({
    attempts: async () => {
      const rows = (await runtime?.candidates()) ?? [];
      return rows
        .slice(0, Math.max(1, config.maxFailoverAttempts))
        .map((row) => ({ attemptId: row.accountId, gateway: row.gateway }));
    },
    chat: async ({ attempt, body, signal }) => {
      const models = runtime?.catalog() ?? [];
      const requested = (body as { model?: unknown }).model;
      const model =
        models.find((entry) => entry.id === requested) ?? (models.length > 0 ? models[0] : undefined);
      // 发请求**之前**钳制：max_tokens 超限与 developer 角色都会在流内报错，此时
      // HTTP 已经 200、无法重放，那一轮直接废掉。
      const clamped = model === undefined ? body : clampRequestBody(body, model);
      return chatStream({
        gateway: attempt.gateway,
        body: clamped,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    onFailure: (detail) => {
      runtime?.noteOutcome(detail.attemptId, 'failure', detail.kind, detail.message);
      warn(`账号 ${detail.attemptId} 请求失败（${detail.kind}），尝试换号`);
    },
    onSuccess: (attemptId) => {
      runtime?.noteOutcome(attemptId, 'success');
      activeAccountId = attemptId;
    },
    onWarn: warn,
  });

  // 2. 装配 adapter 并注册。目录是兜底也能注册 —— 见文件头第 1 条。
  adapter = createHuaweiCloudAdapter({
    catalog: () => runtime?.catalog() ?? [],
    baseUrl: () => shim?.baseUrl ?? 'http://127.0.0.1:1',
    token: () => shim?.token ?? '',
  });

  const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter.adapter);
  const releaseDirectory = ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: DISPLAY_NAME,
      settingsNs: SETTINGS_NS,
      settingsPath: [],
      declared: false,
    },
  ]);
  ctx.llm.registerModelDiscovery(SETTINGS_NS, async (request) => {
    if (request.provider !== undefined && request.provider !== PROVIDER) return [];
    if (!config.enabled) return [];
    return toLlmModelInfos(runtime?.catalog() ?? []);
  });

  // 3. 卡片用的两条宿主路由（令牌不进页面）。
  registerRoutes(ctx as unknown as Parameters<typeof registerRoutes>[0], {
    status: () => runtime?.status() ?? Promise.reject(new Error('运行时尚未就绪')),
    action: (action, body) => runtime?.run(action, body) ?? Promise.resolve({ ok: false }),
  });

  // 4. 生命周期：卸载时释放注册、路由、端口与登录服务器。
  ctx.effect(() => async () => {
    disposed = true;
    login.dispose();
    runtime?.dispose();
    accounts.dispose();
    releaseDirectory();
    releaseAdapter();
    const closing = shim?.close();
    shim = undefined;
    adapter = undefined;
    runtime = undefined;
    if (closing !== undefined) await closing;
  });

  // 5. 启动后预热：把网络请求推到 apply 之外（apply 期间宿主还在装配插件树）。
  if (config.warmOnStart) {
    const timer = setTimeout(() => {
      if (disposed) return;
      void runtime?.warm().catch((error: unknown) => {
        warn(`预热失败（不影响模型路由）：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 0);
    timer.unref?.();
  }

  // 6. 配置变化：重新解析登录态与目录。
  const offUpdate = (
    ctx as unknown as { on(event: string, listener: () => void): (() => void) | void }
  ).on('loader/volatile-update', () => {
    if (disposed) return;
    void runtime?.warm().catch(() => undefined);
  });
  if (typeof offUpdate === 'function') ctx.effect(() => offUpdate);

  ctx.logger.info(`[${name}] v${VERSION} 已启动（shim ${shim.baseUrl}）`);
}
