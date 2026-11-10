/**
 * 浏览器半侧：果办 OfficeAce 的设置页。
 *
 * 职责：经宿主的两条路由读状态、发白名单动作，把账号池、登录相位与桌面端探测结果
 * 画出来；本文件不直接访问华为云，也不接触任何令牌。
 * 依赖：`ctx.slots`（回调晚执行）、`ctx.locale`（文案注册与绑定）、宿主提供的 `react`。
 * 不变量：只请求 STATUS_PATH 与 ACTION_PATH；轮询与登录探测都可取消；字段名以
 * `src/types.ts` 的 `StatusSnapshot` 为准，写错不会报错、只会静默显示空白。
 *
 * 版式跟随 DSH 设置面板的既有语言（参考 dsh-connect-workbuddy 的 settings.section
 * 实现）：顶部一块自报家门（图标 + 标题 + 一句简介），下面按「分组标题 + 设置行」
 * 排；每行左侧是标题与说明、右侧是控件，行间用 1px 细线分隔。**不用卡片包起来**——
 * 这一页本身就是面板内容，再套一层边框会让它看起来像别人列表里的一行。
 */

(function bootstrapHuaweicloudClient() {
  var BUNDLE_NAME = 'dsh-connect-huaweicloud';
  var PROVIDER_ID = 'officeace';
  var STATUS_PATH = '/plugins/dsh-connect-huaweicloud/status';
  var ACTION_PATH = '/plugins/dsh-connect-huaweicloud/action';
  /** 设置页与图标的公共 id：两者必须相等，宿主才会把图标放进这一节。 */
  var SECTION_ID = BUNDLE_NAME;
  /** 登录进行中的探测间隔；登录流程本身是秒级的。 */
  var LOGIN_POLL_MS = 1500;

  /**
   * 版式规格照抄 dsh-connect-workbuddy 的设置页（`settings.section`）：
   *
   * - 整页竖排 18px；一组设置内部 14px；组与组之间就是这 18px。
   * - **没有分隔线**。WorkBuddy 明确不用 divider，间距本身就是分隔；加了线反而
   *   会把它切成一张张卡片，偏离面板本身的样式。
   * - **勾选框在左、文字紧跟**，不是「标签左、控件右」的两端对齐。这个方向是
   *   WorkBuddy 的硬规则：控件推到最右边，用户看不出它是勾给谁的。
   * - 主标签 `--dsw-alias-label-primary` + 500 字重；说明文字 12/17 且 tertiary。
   * - 主标签与说明之间 3px；勾选框与文字之间 10px。
   */
  var CSS = [
    '.dshc-root{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}',
    '.dshc-root *{box-sizing:border-box}',

    /* 页头：28px 图标与标题同排，简介独占一行，自带一层底色。
       不做 20px 大标题——宿主设置面板已经有一层标题栏，这里再放大标题会重复。 */
    '.dshc-head{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:10px;row-gap:2px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
    '.dshc-head-icon{grid-row:1;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;color:var(--dsw-alias-label-secondary)}',
    '.dshc-title{margin:0;font-size:15px;line-height:22px;font-weight:600;grid-row:1;min-width:0;display:flex;align-items:center;gap:8px}',
    '.dshc-version{font-size:11px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-desc{grid-column:1/-1;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

    /* 一组设置：内部 14px 竖排。
       组标题的规格取自 WorkBuddy 自己的标题类（`.dsm-workbuddy-models-title`：
       14px / 20px / 600），不是自创字号。WorkBuddy 的设置页是一张平铺的偏好
       列表，没有分组；这一页有五类互不相干的内容（客户端/登录/账号/池/其它），
       平铺会糊成一片，所以借它自己的标题语汇分层。 */
    '.dshc-group{display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.dshc-group+.dshc-group{margin-top:6px}',
    '.dshc-group-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',

    /* 带勾选框的设置行：勾选框在左，文字块紧跟。整行是 <label>，点文字也能勾。 */
    '.dshc-pref{display:flex;align-items:flex-start;gap:10px;min-width:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
    '.dshc-pref>input.dshc-check{flex:none;width:15px;height:15px;margin:1px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
    '.dshc-pref-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}',
    '.dshc-pref-label{font-weight:500;color:var(--dsw-alias-label-primary)}',
    '.dshc-pref-hint{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
    /* 控件紧跟标签，不推到最右：WorkBuddy 用 pref-lead 承载「标签 + 下拉/按钮」。 */
    '.dshc-pref-lead{display:flex;align-items:center;justify-content:flex-start;gap:10px;min-width:0;flex-wrap:wrap}',
    '.dshc-pref-lead>.dshc-pref-label{flex:none}',

    /* 没有勾选框的设置行：左缩进 25px = 15px 勾选框 + 10px 间距，
       让文字起点与上面带勾选框的行对齐，而不是落在勾选框下面。 */
    '.dshc-field{display:flex;flex-direction:column;gap:3px;padding-left:25px;min-width:0}',
    /* 需要占满整行、不缩进的内容（账号列表、登录相位）。 */
    '.dshc-block{display:flex;flex-direction:column;gap:8px;min-width:0}',

    /* 提示文字：不使用边框卡片，保持与 WorkBuddy 一致的纯文字样式。
       需要强调时给左侧一道 2px 竖线；这是唯一用线的地方。 */
    '.dshc-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-warn{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-brand-primary);padding:1px 0 1px 9px}',
    '.dshc-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding:1px 0 1px 9px}',
    '.dshc-link{color:var(--dsw-alias-brand-primary);word-break:break-all;font-size:12px}',
    '.dshc-empty{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',

    /* 控件：尺寸照 WorkBuddy 的 .dsm-btn / 紧凑下拉。 */
    '.dshc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}',
    '.dshc-btn{appearance:none;font:inherit;font-size:13px;line-height:20px;min-height:32px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-weight:500;padding:5px 14px;white-space:nowrap}',
    '.dshc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
    '.dshc-btn:disabled{opacity:.4;cursor:default}',
    '.dshc-btn[data-tone="danger"]{border-color:transparent;font-weight:400}',
    '.dshc-btn[data-tone="primary"]{border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
    '.dshc-select{flex:none;font:inherit;font-size:12px;line-height:16px;padding:3px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);cursor:pointer;max-width:20em}',
    '.dshc-btn:focus-visible,.dshc-check:focus-visible,.dshc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',

    /* 账号：WorkBuddy 的设置页里没有这类列表，沿用它的行骨架——
       勾选框在左 + 名称/状态文字块，操作按钮缩进到文字起点下方。 */
    '.dshc-acct-list{display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.dshc-acct{display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.dshc-acct-name{font-size:13px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dshc-acct-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);min-width:0}',
    '.dshc-acct-foot{display:flex;align-items:center;gap:8px;padding-left:25px;min-width:0}',
    '.dshc-acct-quota{flex:none;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);min-width:0}',
    '.dshc-badge{display:inline-block;font-size:11px;line-height:17px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
    '.dshc-badge[data-tone="ok"]{color:var(--dsw-alias-label-primary)}',
    '.dshc-badge[data-tone="warn"]{border:1px solid var(--dsw-alias-border-l2)}'
  ].join('');

  var zh = {
    navLabel: '果办 OfficeAce',
    title: '果办 OfficeAce',
    desc: '有客户端就自动读它的登录态；没有就在浏览器里登录一次。多个账号进一张池，可勾选、可切换、失败自动换号。',
    statusLine: '共 {count} 个账号 · 目录 {models} 个模型',

    groupDesktop: '本机客户端',
    desktopLabel: '客户端状态',
    desktopDetected: '已检测到并读到登录态',
    desktopMissing: '未检测到',
    desktopReasonMissing: '没找到果办客户端的数据目录。可以点下面的「登录添加账号」用浏览器登录，不需要装客户端。',
    desktopReasonUnreadable: '检测到果办客户端，但读不到它的登录态。请在客户端里登录一次，或改用浏览器登录。',
    desktopReasonNoGateway: '果办客户端已登录，但还没接入模型。打开客户端点「模型 → 接入模型」，再回来点「同步本机客户端」。',
    syncLabel: '从客户端读账号',
    syncHint: '只读，不改客户端里的任何登录状态。',
    syncBtn: '同步本机客户端',

    groupLogin: '登录',
    loginLabel: '浏览器登录',
    loginHint: '打开华为云授权页，登录完成后自动记录这个账号。不装客户端也能用。',
    loginAdd: '登录添加账号',
    loginSync: '同步本机客户端',
    loginCancel: '取消登录',
    loginPreparing: '正在准备登录…',
    loginAwaiting: '请在浏览器里完成华为云登录。没有自动打开？点下面的链接。',
    loginExchanging: '已拿到授权，正在换取凭据…',
    loginDone: '登录成功。',
    loginFailed: '登录失败：{message}',
    loginCancelled: '已取消登录。',
    loginOpenLink: '打开授权页',

    groupAccounts: '账号',
    accountsLabel: '账号列表',
    accountsHint: '勾选表示同意花这个账号的额度。没勾的账号不会被自动选中。',
    colPool: '进池',
    colAccount: '账号',
    colSource: '来源',
    colState: '状态',
    colQuota: '额度',
    colActions: '操作',
    sourceLogin: '浏览器登录',
    sourceImport: '读自客户端',
    sourceImportOauth: '客户端 + 接管续期',
    stateUsable: '可用',
    stateUnusable: '不可用',
    notRenewable: '过期需重登',
    hasGateway: '已接入模型',
    noGateway: '未接入模型',
    test: '测试',
    remove: '删除',
    removeConfirm: '删除这条账号记录？果办客户端里的登录不会受影响。',
    empty: '还没有账号。装过果办客户端就点「同步本机客户端」；没装就点「登录添加账号」。',

    groupPool: '账号池',
    poolToggle: '启用账号池',
    poolLabel: '启用账号池（失败自动换号）',
    poolHintOff: '关着时只用下面手动选定的那个账号，失败如实报错。',
    poolHintOn: '开着时由排序决定用哪个账号：可用优先 → 快过期先花 → 积分高。',
    poolActiveLabel: '当前使用',
    poolActiveUnknown: '（还没发出请求）',
    poolEmptyMembers: '池里一个账号都没勾。勾选才是「可以花它的额度」的同意。',
    selectLabel: '手动使用哪个账号',
    selectHint: '池关着时生效。',
    selectNone: '（未选定）',

    groupOther: '其它',
    quotaLabel: '显示额度读数',
    quotaHint: '额度来自本机客户端控制面；没有客户端时不显示。',
    refreshLabel: '重新读取状态',
    refreshHint: '重新读客户端登录态与模型目录。',
    refresh: '刷新',
    working: '处理中…',

    quotaUnknown: '—',
    quotaValue: '{remaining} / {total}',
    quotaOnlyRemaining: '剩 {remaining}'
  };

  var en = {
    navLabel: 'OfficeAce',
    title: 'OfficeAce (果办)',
    desc: 'Uses the local desktop client when it is signed in; otherwise sign in once in the browser. Multiple accounts share one pool: selectable, switchable, automatic failover.',
    statusLine: '{count} account(s) · {models} model(s) in catalog',

    groupDesktop: 'Local client',
    desktopLabel: 'Client status',
    desktopDetected: 'Detected, session read',
    desktopMissing: 'Not detected',
    desktopReasonMissing: 'No OfficeAce data directory found. Use "Sign in" below to add an account in the browser — no client needed.',
    desktopReasonUnreadable: 'OfficeAce client found, but its session could not be read. Sign in inside the client once, or use browser sign-in.',
    desktopReasonNoGateway: 'The client is signed in but has no model gateway yet. Open the client, choose Models → Connect model, then click "Sync client".',
    syncLabel: 'Read accounts from client',
    syncHint: 'Read-only. Nothing in the client is modified.',
    syncBtn: 'Sync client',

    groupLogin: 'Sign in',
    loginLabel: 'Browser sign-in',
    loginHint: 'Opens the Huawei Cloud authorization page and records the account once you finish. Works without the client.',
    loginAdd: 'Sign in to add account',
    loginSync: 'Sync client',
    loginCancel: 'Cancel sign-in',
    loginPreparing: 'Preparing sign-in…',
    loginAwaiting: 'Finish signing in to Huawei Cloud in the browser. Not opened automatically? Use the link below.',
    loginExchanging: 'Authorization received, exchanging for credentials…',
    loginDone: 'Signed in.',
    loginFailed: 'Sign-in failed: {message}',
    loginCancelled: 'Sign-in cancelled.',
    loginOpenLink: 'Open authorization page',

    groupAccounts: 'Accounts',
    accountsLabel: 'Account list',
    accountsHint: 'Checking an account is the consent to spend its quota. Unchecked accounts are never picked automatically.',
    colPool: 'In pool',
    colAccount: 'Account',
    colSource: 'Source',
    colState: 'State',
    colQuota: 'Quota',
    colActions: 'Actions',
    sourceLogin: 'Browser sign-in',
    sourceImport: 'Read from client',
    sourceImportOauth: 'Client + adopted refresh',
    stateUsable: 'Usable',
    stateUnusable: 'Unusable',
    notRenewable: 'Re-sign-in required',
    hasGateway: 'Model gateway ready',
    noGateway: 'No model gateway',
    test: 'Test',
    remove: 'Remove',
    removeConfirm: 'Remove this account record? The sign-in inside the OfficeAce client is not affected.',
    empty: 'No accounts yet. If the OfficeAce client is installed, click "Sync client"; otherwise click "Sign in".',

    groupPool: 'Account pool',
    poolToggle: 'Enable pool',
    poolLabel: 'Enable pool (automatic failover)',
    poolHintOff: 'While off, only the manually selected account below is used; failures are reported as-is.',
    poolHintOn: 'While on, ranking decides: usable first → expiring soon first → higher quota.',
    poolActiveLabel: 'Currently used',
    poolActiveUnknown: '(no request yet)',
    poolEmptyMembers: 'No account is checked. Checking is the consent to spend its quota.',
    selectLabel: 'Account to use',
    selectHint: 'Takes effect while the pool is off.',
    selectNone: '(none selected)',

    groupOther: 'Other',
    quotaLabel: 'Show quota',
    quotaHint: 'Quota comes from the local client control plane; hidden when no client is running.',
    refreshLabel: 'Reload status',
    refreshHint: 'Re-read the client session and the model catalog.',
    refresh: 'Refresh',
    working: 'Working…',

    quotaUnknown: '—',
    quotaValue: '{remaining} / {total}',
    quotaOnlyRemaining: 'remaining {remaining}'
  };

  var loader = globalThis.__ModuleLoader__;
  if (loader === undefined) return;

  loader.load({
    id: BUNDLE_NAME,
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;

      /**
       * 注入一次样式表。
       *
       * 用 `data-plugin-css` 做幂等键而不是 `id`：宿主热重载会重跑 `apply`，
       * 有键就能就地替换文本，不会在 `<head>` 里叠出第二份声明。
       */
      function injectStyleOnce(key, css) {
        if (typeof document === 'undefined') return;
        var existing = document.querySelector('style[data-plugin-css="' + key + '"]');
        if (existing !== null) {
          existing.textContent = css;
          return;
        }
        var tag = document.createElement('style');
        tag.dataset.pluginCss = key;
        tag.textContent = css;
        document.head.appendChild(tag);
      }

      /** 数字读数：拿不到就给破折号，绝不把 `NaN` 印到界面上。 */
      function numberText(value) {
        if (value === undefined || value === null || typeof value !== 'number' || !isFinite(value)) return '—';
        return value.toLocaleString();
      }

      /** 剩余毫秒说成人话；`undefined` 表示没有 STS（只有网关凭据）。 */
      function remainingText(ms) {
        if (typeof ms !== 'number' || !isFinite(ms)) return '—';
        if (ms <= 0) return '0';
        if (ms >= 3600000) return Math.ceil(ms / 3600000) + 'h';
        if (ms >= 60000) return Math.ceil(ms / 60000) + 'm';
        return Math.ceil(ms / 1000) + 's';
      }

      /** 取状态里的账号数组；任何形状问题都退成空数组，不让整页白屏。 */
      function accountsOf(snapshot) {
        if (snapshot === undefined || snapshot === null) return [];
        return Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
      }

      var snapshot = undefined;
      var inflight;
      var inflightController;
      var ticker;

      /** 读一次状态；并发的两次请求共享同一个 promise。 */
      function loadStatus() {
        if (inflight !== undefined) return inflight;
        var controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        var options = { headers: { accept: 'application/json' } };
        if (controller !== undefined) options.signal = controller.signal;
        inflightController = controller;
        var promise = fetch(STATUS_PATH, options)
          .then(function (response) {
            if (!response.ok) return undefined;
            return response.json();
          })
          .then(function (document) {
            if (document !== undefined && document !== null) snapshot = document;
            return document;
          })
          .catch(function (error) {
            // 一次轮询失败不值得把界面清空：保留上一次的值，等下一轮自愈。
            if (error !== undefined && error !== null && error.name === 'AbortError') return undefined;
            return undefined;
          })
          .then(function (document) {
            inflight = undefined;
            inflightController = undefined;
            return document;
          });
        inflight = promise;
        return promise;
      }

      function abortInflight() {
        if (inflightController !== undefined) {
          try {
            inflightController.abort();
          } catch (error) {
            // 已经结束的请求 abort 会抛，忽略。
          }
          inflightController = undefined;
        }
        inflight = undefined;
      }

      /** 发一个白名单动作；返回值里的 `status` 就地铺进快照，界面立刻反映结果。 */
      function act(action, body, options) {
        var payload = { action: action };
        if (body !== undefined && body !== null && typeof body === 'object') {
          Object.keys(body).forEach(function (key) {
            payload[key] = body[key];
          });
        }
        var init = {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload)
        };
        if (options !== undefined && options !== null && options.signal !== undefined) init.signal = options.signal;
        return fetch(ACTION_PATH, init)
          .then(function (response) {
            return response.json().then(
              function (result) {
                if (result !== null && typeof result === 'object') return result;
                return { ok: response.ok };
              },
              function () {
                return { ok: false, message: 'HTTP ' + response.status };
              }
            );
          })
          .then(function (result) {
            if (result !== undefined && result !== null && result.status !== undefined) {
              snapshot = result.status;
            }
            return result;
          })
          .catch(function (error) {
            return { ok: false, message: String((error && error.message) || error) };
          });
      }

      /** 按状态里的刷新间隔轮询；登录进行中时用更短的间隔。 */
      function startTicker(onTick) {
        stopTicker();
        var delay = 30000;
        if (snapshot !== undefined && typeof snapshot.pollIntervalMs === 'number') delay = snapshot.pollIntervalMs;
        if (snapshot !== undefined && snapshot.login !== undefined && isLoginActive(snapshot.login)) {
          delay = LOGIN_POLL_MS;
        }
        ticker = setTimeout(function () {
          ticker = undefined;
          onTick();
        }, delay);
      }

      function stopTicker() {
        if (ticker !== undefined) {
          clearTimeout(ticker);
          ticker = undefined;
        }
      }

      function isLoginActive(view) {
        if (view === undefined || view === null) return false;
        return view.phase === 'preparing' || view.phase === 'awaiting-user' || view.phase === 'exchanging';
      }

      /** 占位符替换：`{count}` → 值；缺值给破折号，不把 `undefined` 印出来。 */
      function format(text, values) {
        if (typeof text !== 'string') return '';
        if (values === undefined || values === null) return text;
        return text.replace(/\{(\w+)\}/g, function (match, key) {
          var value = values[key];
          if (value === undefined || value === null) return '—';
          return String(value);
        });
      }

      /** 额度读数：读不到就是不显示，绝不显示 0（会被读成「额度用完」）。 */
      function quotaText(quota, t) {
        if (quota === undefined || quota === null) return t('quotaUnknown');
        if (typeof quota.remaining === 'number' && typeof quota.total === 'number') {
          return format(t('quotaValue'), { remaining: numberText(quota.remaining), total: numberText(quota.total) });
        }
        if (typeof quota.remaining === 'number') {
          return format(t('quotaOnlyRemaining'), { remaining: numberText(quota.remaining) });
        }
        return t('quotaUnknown');
      }

      /** 账号名：优先展示名，其次 userName，最后 id 尾部。 */
      function accountName(account) {
        if (typeof account.label === 'string' && account.label !== '') return account.label;
        if (typeof account.userName === 'string' && account.userName !== '') return account.userName;
        return String(account.id || '').slice(-8);
      }

      function sourceText(account, t) {
        if (account.origin === 'login') return t('sourceLogin');
        if (account.origin === 'import+oauth') return t('sourceImportOauth');
        return t('sourceImport');
      }

      /**
       * 带勾选框的设置行：勾选框在左，文字块（主标签 + 说明 + 可选控件）紧跟。
       *
       * 为什么是 <label> 而不是 <div>：整行可点，点文字也能勾选，命中区域比 15px
       * 的小方块大得多。WorkBuddy 的设置行同样是 <label>。
       *
       * 控件放在 `.dshc-pref-lead` 里紧跟标签，**不推到行尾**：推到最后一行之外，
       * 用户看不出这个勾是设给谁的。
       */
      function PrefRow(props) {
        return h('label', { className: 'dshc-pref', title: props.title },
          h('input', {
            type: 'checkbox',
            className: 'dshc-check',
            checked: props.checked === true,
            disabled: props.disabled === true,
            'aria-label': props.label,
            onChange: props.onChange
          }),
          h('span', { className: 'dshc-pref-copy' },
            props.control !== undefined
              ? h('span', { className: 'dshc-pref-lead' },
                  h('span', { className: 'dshc-pref-label' }, props.label),
                  props.control
                )
              : h('span', { className: 'dshc-pref-label' }, props.label),
            props.hint !== undefined && props.hint !== null
              ? h('span', { className: 'dshc-pref-hint' }, props.hint)
              : null
          )
        );
      }

      /**
       * 没有勾选框的设置行：主标签 + 说明 + 控件。
       *
       * 左缩进 25px 与 `PrefRow` 的文字起点对齐（15px 勾选框 + 10px 间距），否则
       * 两类行混排时文字会左右跳。
       */
      function FieldRow(props) {
        return h('div', { className: 'dshc-field' },
          props.control !== undefined
            ? h('span', { className: 'dshc-pref-lead' },
                h('span', { className: 'dshc-pref-label' }, props.label),
                props.control
              )
            : h('span', { className: 'dshc-pref-label' }, props.label),
          props.hint !== undefined && props.hint !== null
            ? h('span', { className: 'dshc-pref-hint' }, props.hint)
            : null
        );
      }

      /** 一组设置：可选的组标题 + 组内 14px 竖排的行。 */
      function Group(props) {
        return h('div', { className: 'dshc-group' },
          props.title !== undefined ? h('h4', { className: 'dshc-group-title' }, props.title) : null,
          props.children
        );
      }

      /**
       * 一条账号。
       *
       * 三行：勾选+名称、来源/有效期/额度、操作。不用表格——宿主内容列固定约 564px，
       * 六列必然塌成纵向堆叠，反而比这个专用版式更长更难读。
       */
      function AccountRow(props) {
        var account = props.account;
        var t = props.t;
        var busy = props.busy;

        var badges = [];
        badges.push(h('span', {
          key: 'state',
          className: 'dshc-badge',
          'data-tone': account.usable === true ? 'ok' : 'warn',
          title: account.reason || ''
        }, account.usable === true ? t('stateUsable') : t('stateUnusable')));
        if (account.hasGateway !== true) {
          badges.push(h('span', { key: 'gw', className: 'dshc-badge', 'data-tone': 'warn' }, t('noGateway')));
        }
        if (account.renewable !== true) {
          badges.push(h('span', { key: 'rn', className: 'dshc-badge' }, t('notRenewable')));
        }

        // 只有上半部分包在 <label> 里：按钮不能放进 label，否则点「删除」会连带勾选。
        return h('div', { className: 'dshc-acct' },
          h('label', { className: 'dshc-pref' },
            h('input', {
              type: 'checkbox',
              className: 'dshc-check',
              checked: account.inPool === true,
              disabled: busy,
              'aria-label': t('colPool') + '：' + accountName(account),
              onChange: function (event) { props.onToggleMember(account.id, event.target.checked); }
            }),
            h('span', { className: 'dshc-pref-copy' },
              h('span', { className: 'dshc-acct-name', title: account.id }, accountName(account)),
              h('span', { className: 'dshc-acct-meta' },
                h('span', null, sourceText(account, t)),
                account.stsRemainingMs !== undefined
                  ? h('span', null, remainingText(account.stsRemainingMs))
                  : null,
                badges
              )
            )
          ),
          h('div', { className: 'dshc-acct-foot' },
            h('span', { className: 'dshc-acct-quota' }, quotaText(account.quota, t)),
            h('button', {
              type: 'button',
              className: 'dshc-btn',
              disabled: busy,
              onClick: function () { props.onTest(account.id); }
            }, t('test')),
            h('button', {
              type: 'button',
              className: 'dshc-btn',
              'data-tone': 'danger',
              disabled: busy,
              onClick: function () { props.onRemove(account.id); }
            }, t('remove'))
          )
        );
      }

      /** 登录相位提示：只在有会话时显示。 */
      function LoginStatus(props) {
        var view = props.view;
        var t = props.t;
        if (view === undefined || view === null || view.phase === 'idle') return null;

        var active = isLoginActive(view);
        var text;
        if (view.phase === 'preparing') text = t('loginPreparing');
        else if (view.phase === 'awaiting-user') text = t('loginAwaiting');
        else if (view.phase === 'exchanging') text = t('loginExchanging');
        else if (view.phase === 'done') text = t('loginDone');
        else if (view.phase === 'cancelled') text = t('loginCancelled');
        else text = format(t('loginFailed'), { message: view.message || '—' });

        return h('div', { className: 'dshc-block' },
          h('p', { className: 'dshc-note', 'aria-live': 'polite' }, text),
          view.authorizeUrl !== undefined && active
            ? h('a', {
                className: 'dshc-link',
                href: view.authorizeUrl,
                target: '_blank',
                rel: 'noreferrer noopener'
              }, t('loginOpenLink'))
            : null,
          active
            ? h('div', { className: 'dshc-toolbar' },
                h('button', {
                  type: 'button',
                  className: 'dshc-btn',
                  disabled: props.busy,
                  onClick: props.onCancel
                }, t('loginCancel'))
              )
            : null
        );
      }

      /** 页头：图标 + 标题 + 版本 + 一句简介。 */
      function PageHead(props) {
        var t = props.t;
        return h('div', { className: 'dshc-head' },
          h('span', { className: 'dshc-head-icon' }, h(SectionIcon, { size: 24 })),
          h('span', { className: 'dshc-title' },
            t('title'),
            props.version !== undefined ? h('span', { className: 'dshc-version' }, 'v' + props.version) : null
          ),
          h('span', { className: 'dshc-desc' }, t('desc'))
        );
      }

      /** 设置页整页。 */
      function SettingsSection(props) {
        var t = props.t;
        var [busy, setBusy] = React.useState(false);
        var [notice, setNotice] = React.useState(undefined);
        var [current, setCurrent] = React.useState(snapshot);
        var [, forceRender] = React.useState(0);

        React.useEffect(function () {
          var cancelled = false;
          function tick() {
            if (cancelled) return;
            void loadStatus().then(function () {
              if (cancelled) return;
              setCurrent(snapshot);
              startTicker(tick);
            });
          }
          tick();
          return function () {
            cancelled = true;
            stopTicker();
          };
        }, []);

        React.useEffect(function () {
          setCurrent(snapshot);
        });

        var view = current === undefined || current === null ? undefined : current;
        var accounts = accountsOf(view);
        var login = view === undefined ? undefined : view.login;
        var poolEnabled = view !== undefined && view.poolEnabled === true;
        var selectedId = view === undefined ? undefined : view.selectedId;
        var activeId = view === undefined ? undefined : view.activeId;

        /** 统一处理动作：置忙、发请求、落提示、刷新。 */
        function run(action, body, successText) {
          setBusy(true);
          setNotice(undefined);
          return act(action, body)
            .then(function (result) {
              setCurrent(snapshot);
              forceRender(function (value) { return value + 1; });
              if (result !== undefined && result !== null && result.message !== undefined) {
                setNotice({ ok: result.ok === true, text: result.message });
              } else if (successText !== undefined) {
                setNotice({ ok: true, text: successText });
              }
              return result;
            })
            .then(function (result) {
              setBusy(false);
              return result;
            }, function (error) {
              setBusy(false);
              setNotice({ ok: false, text: String((error && error.message) || error) });
              return undefined;
            });
        }

        function toggleMember(id, checked) {
          var next = [];
          accounts.forEach(function (account) {
            if (account.id === id ? checked : account.inPool === true) next.push(account.id);
          });
          void run('members', { accountIds: next });
        }

        function removeAccount(id) {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm(t('removeConfirm'))) return;
          }
          void run('remove-account', { accountId: id });
        }

        function testAccount(id) {
          void run('test-account', { accountId: id });
        }

        var detected = view !== undefined && view.desktopDetected === true;

        var reasonHint;
        if (view !== undefined && view.desktopDetected !== true && view.desktopReason !== undefined) {
          if (view.desktopReason === 'desktop-missing') reasonHint = t('desktopReasonMissing');
          else if (view.desktopReason === 'desktop-unreadable') reasonHint = t('desktopReasonUnreadable');
          else if (view.desktopReason === 'desktop-no-gateway') reasonHint = t('desktopReasonNoGateway');
        }

        var activeName = '—';
        if (activeId !== undefined) {
          accounts.forEach(function (account) {
            if (account.id === activeId) activeName = accountName(account);
          });
        }

        var poolEmpty = poolEnabled && accounts.length > 0 && accounts.every(function (a) { return a.inPool !== true; });

        return h('div', { className: 'dshc-root' },
          h(PageHead, {
            t: t,
            version: view !== undefined ? view.version : undefined
          }),

          h('p', { className: 'dshc-note' },
            format(t('statusLine'), {
              count: accounts.length,
              models: view !== undefined && typeof view.modelCount === 'number' ? view.modelCount : 0
            })
          ),

          h(Group, { title: t('groupDesktop') },
            h(FieldRow, {
              label: t('desktopLabel'),
              hint: detected ? t('desktopDetected') : t('desktopMissing'),
              control: h('button', {
                type: 'button',
                className: 'dshc-btn',
                disabled: busy,
                onClick: function () { void run('sync-desktop', {}); }
              }, t('syncBtn'))
            }),
            reasonHint !== undefined ? h('p', { className: 'dshc-warn' }, reasonHint) : null
          ),

          h(Group, { title: t('groupLogin') },
            h(FieldRow, {
              label: t('loginLabel'),
              hint: t('loginHint'),
              control: h('button', {
                type: 'button',
                className: 'dshc-btn',
                'data-tone': 'primary',
                disabled: busy || isLoginActive(login),
                onClick: function () { void run('login-start', {}); }
              }, busy ? t('working') : t('loginAdd'))
            }),
            h(LoginStatus, { view: login, t: t, busy: busy, onCancel: function () { void run('login-cancel', {}); } }),
            notice !== undefined
              ? h('p', {
                  className: notice.ok === true ? 'dshc-note' : 'dshc-error',
                  'aria-live': 'polite'
                }, notice.text)
              : null
          ),

          h(Group, { title: t('groupAccounts') },
            h('p', { className: 'dshc-note' }, t('accountsHint')),
            accounts.length === 0
              ? h('p', { className: 'dshc-empty' }, t('empty'))
              : h('div', { className: 'dshc-acct-list' }, accounts.map(function (account) {
                  return h(AccountRow, {
                    key: account.id,
                    account: account,
                    t: t,
                    busy: busy,
                    onToggleMember: toggleMember,
                    onTest: testAccount,
                    onRemove: removeAccount
                  });
                }))
          ),

          h(Group, { title: t('groupPool') },
            h(PrefRow, {
              label: t('poolLabel'),
              hint: poolEnabled ? t('poolHintOn') : t('poolHintOff'),
              checked: poolEnabled,
              disabled: busy,
              onChange: function (event) { void run('settings', { poolEnabled: event.target.checked }); }
            }),
            poolEnabled
              ? h(FieldRow, {
                  label: t('poolActiveLabel'),
                  hint: activeId !== undefined ? activeName : t('poolActiveUnknown')
                })
              : null,
            poolEmpty ? h('p', { className: 'dshc-warn' }, t('poolEmptyMembers')) : null,
            poolEnabled
              ? null
              : h(FieldRow, {
                  label: t('selectLabel'),
                  hint: t('selectHint'),
                  control: h('select', {
                    className: 'dshc-select',
                    value: selectedId === undefined ? '' : selectedId,
                    disabled: busy,
                    'aria-label': t('selectLabel'),
                    onChange: function (event) {
                      var value = event.target.value;
                      if (value === '') return;
                      void run('switch-account', { accountId: value });
                    }
                  },
                    h('option', { value: '' }, t('selectNone')),
                    accounts.map(function (account) {
                      return h('option', { key: account.id, value: account.id }, accountName(account));
                    })
                  )
                })
          ),

          h(Group, { title: t('groupOther') },
            h(FieldRow, {
              label: t('refreshLabel'),
              hint: t('refreshHint'),
              control: h('button', {
                type: 'button',
                className: 'dshc-btn',
                disabled: busy,
                onClick: function () { void run('refresh', {}); }
              }, t('refresh'))
            })
          )
        );
      }

      /** 侧栏图标：一个极简的方框 + 圆点，跟随主题文字色。 */
      function SectionIcon(props) {
        var size = props !== undefined && typeof props.size === 'number' ? props.size : 16;
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        },
          h('rect', {
            x: 1.5, y: 2.5, width: 13, height: 11, rx: 2,
            stroke: 'currentColor', strokeWidth: 1.3
          }),
          h('circle', { cx: 5.5, cy: 8, r: 1.4, fill: 'currentColor' }),
          h('path', {
            d: 'M8.5 6.6h4M8.5 9.4h3',
            stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round'
          })
        );
      }

      /**
       * 插件模块本体：`inject` 声明依赖的服务，`apply` 在服务就绪时注册槽位。
       *
       * `t` 在 apply 里绑定后逐层以 props 传下去，而不是让每个组件自己去 `ctx.locale`：
       * 组件是纯函数，拿不到 ctx，自己找全局会退化成隐式依赖。
       */
      function apply(ctx) {
        var namespace = BUNDLE_NAME;
        injectStyleOnce(BUNDLE_NAME + '/client.css', CSS);
        ctx.effect(function () {
          return ctx.locale.register(namespace, { zh: zh, en: en });
        }, BUNDLE_NAME + ': locale');
        var t = ctx.locale.bind(namespace);

        /**
         * 注册一个槽位。
         *
         * 内层 try/catch 不可省：`ctx.slots.inject(name, cb)` 的回调是**晚执行**的
         * （等宿主声明那个槽位），抛出的异常会被重新抛到渲染器之外，外层 try 抓不到，
         * 结果就是整页空白而控制台只有一条与本插件无关的堆栈。
         */
        function injectSlot(name, register) {
          try {
            return ctx.slots.inject(name, function () {
              try {
                return register();
              } catch (error) {
                console.error('[dsh-connect-huaweicloud] 槽位注册失败（' + name + '，不影响模型路由）：', error);
                return undefined;
              }
            });
          } catch (error) {
            console.error('[dsh-connect-huaweicloud] 槽位注入失败（' + name + '，不影响模型路由）：', error);
            return undefined;
          }
        }

        injectSlot('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 60,
              label: function () {
                return t('navLabel');
              },
              locale: namespace,
              inject: function () {
                return { t: t };
              }
            },
            SettingsSection
          );
        });

        injectSlot('settings.section.icon', function () {
          return ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: SECTION_ID,
              locale: namespace
            },
            SectionIcon
          );
        });

        // 插件卸载/停用时不留下定时器与在途请求；快照也丢掉，换插件后不要看到旧读数。
        ctx.effect(function () {
          return function () {
            stopTicker();
            abortInflight();
            snapshot = undefined;
          };
        }, BUNDLE_NAME + ': store');
      }

      return {
        name: BUNDLE_NAME,
        inject: ['slots', 'locale'],
        apply: apply
      };
    }
  });
})();
