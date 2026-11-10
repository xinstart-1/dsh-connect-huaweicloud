/**
 * 登录会话管理：一次只允许一个进行中的登录，相位推进对界面可见。
 *
 * 为什么需要单独的模块而不是塞进 runtime：登录是**跨请求**的长事务（用户可能去
 * 浏览器里花两分钟），而 runtime 的动作都是即时的。把「等」放在这里，
 * 界面轮询 `login-status` 就能看到相位，不必挂住一个 HTTP 请求。
 *
 * 不变量：任一时刻最多一个进行中的会话；凭据只进仓库，**永不进状态文档**；
 * `cancel()` 与超时都走同一条收尾路径（否则服务器会漏关）。
 *
 * @module dsh-connect-huaweicloud/host/login
 */

import type { LoginErrorCode, LoginPhase, LoginSessionView, StsCredential } from '../types.ts';

/** 开始一次登录需要的东西。 */
export interface LoginDeps {
  /** 起一次浏览器登录；由 `auth/oauth.ts` 提供。 */
  readonly start: () => {
    readonly authorizeUrl: Promise<string>;
    readonly result: Promise<StsCredential>;
    cancel(): void;
  };
  /** 拿到凭据后落库（`accounts.adopt`）。 */
  readonly adopt: (credential: StsCredential) => Promise<void>;
  /** 打开浏览器；失败不致命（界面会显示链接让用户手动点）。 */
  readonly openBrowser: (url: string) => boolean;
  readonly warn: (message: string) => void;
  /** 时钟；测试注入。 */
  readonly now?: () => number;
}

/** 登录管理器。 */
export interface LoginManager {
  /** 开始一次登录；已有进行中的会话时返回它当前的视图（不重开）。 */
  start(): Promise<LoginSessionView>;
  /** 读当前相位。 */
  status(): LoginSessionView;
  /** 取消；幂等。 */
  cancel(reason?: string): LoginSessionView;
  /** 卸载时收尾。 */
  dispose(): void;
}

/** 空视图：没有会话时的形状。 */
function idleView(nowMs: number): LoginSessionView {
  return { phase: 'idle', startedAtMs: nowMs };
}

/**
 * 建登录管理器。
 *
 * @param deps - 登录实现、落库与浏览器打开。
 * @returns 管理器；所有方法都不会抛。
 */
export function createLoginManager(deps: LoginDeps): LoginManager {
  const now = deps.now ?? ((): number => Date.now());

  let view: LoginSessionView = idleView(now());
  /** 当前会话的取消钩子；没有会话时为 undefined。 */
  let cancelCurrent: (() => void) | undefined;
  let disposed = false;

  const set = (patch: Partial<LoginSessionView>): LoginSessionView => {
    view = { ...view, ...patch };
    return view;
  };

  const finish = (phase: LoginPhase, patch: Partial<LoginSessionView> = {}): LoginSessionView => {
    cancelCurrent = undefined;
    return set({ phase, ...patch });
  };

  return {
    async start() {
      if (disposed) return set({ phase: 'failed', message: '插件已卸载', errorCode: 'cancelled' });
      // 已有会话在跑：不重开，返回当前相位（界面靠它判断要不要继续轮询）。
      if (view.phase === 'preparing' || view.phase === 'awaiting-user' || view.phase === 'exchanging') {
        return view;
      }

      const startedAtMs = now();
      view = { phase: 'preparing', startedAtMs };
      cancelCurrent = undefined;

      let session: ReturnType<LoginDeps['start']>;
      try {
        session = deps.start();
      } catch (error) {
        deps.warn(`启动登录失败：${error instanceof Error ? error.message : String(error)}`);
        return finish('failed', {
          message: error instanceof Error ? error.message : String(error),
          errorCode: 'authorize-failed',
        });
      }

      // 取消钩子立刻挂上：用户可能在拿到授权地址之前就点了取消。
      cancelCurrent = (): void => {
        try {
          session.cancel();
        } catch {
          // cancel 本身失败不该再抛。
        }
      };

      void session.authorizeUrl
        .then((url) => {
          if (view.phase !== 'preparing') return;
          set({ phase: 'awaiting-user', authorizeUrl: url, route: url.includes('127.0.0.1') ? 'loopback' : 'cloud' });
          // 打开浏览器失败不算错：界面会显示链接让用户手动点。
          if (!deps.openBrowser(url)) deps.warn('没能自动打开浏览器，请手动点授权链接');
        })
        .catch((error: unknown) => {
          if (view.phase !== 'preparing') return;
          deps.warn(`登记登录 state 失败：${error instanceof Error ? error.message : String(error)}`);
          finish('failed', {
            message: error instanceof Error ? error.message : String(error),
            errorCode: 'state-register-failed',
          });
        });

      void session.result
        .then(async (credential) => {
          if (view.phase === 'cancelled') return;
          set({ phase: 'exchanging' });
          await deps.adopt(credential);
          finish('done', { authorizeUrl: view.authorizeUrl });
        })
        .catch((error: unknown) => {
          if (view.phase === 'cancelled') return;
          const message = error instanceof Error ? error.message : String(error);
          deps.warn(`登录失败：${message}`);
          finish('failed', { message, errorCode: classify(message) });
        });

      return view;
    },

    status() {
      return view;
    },

    cancel(reason) {
      if (cancelCurrent !== undefined) {
        cancelCurrent();
        cancelCurrent = undefined;
      }
      if (view.phase === 'idle' || view.phase === 'done' || view.phase === 'failed') return view;
      return finish('cancelled', reason === undefined ? {} : { message: reason, errorCode: 'cancelled' });
    },

    dispose() {
      disposed = true;
      if (cancelCurrent !== undefined) {
        cancelCurrent();
        cancelCurrent = undefined;
      }
      view = idleView(now());
    },
  };
}

/**
 * 把失败文案归到闭集原因码。
 *
 * 分类而不是把原始文案丢给界面：文案是实现细节，会随上游变化；分类能让界面给出
 * 「重新登录 / 稍等再试 / 去客户端接入模型」这类可执行建议。
 */
function classify(message: string): LoginErrorCode {
  if (/超时|timeout/iu.test(message)) return 'code-timeout';
  if (/state/iu.test(message)) return 'state-register-failed';
  if (/token|STS|凭据/u.test(message)) return 'token-exchange-failed';
  if (/model|网关|gateway/iu.test(message)) return 'gateway-unavailable';
  if (/授权|authorize/iu.test(message)) return 'authorize-failed';
  return 'unknown';
}
