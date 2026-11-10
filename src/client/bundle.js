/**
 * 浏览器半侧：果办 OfficeAce 的设置页。
 *
 * 职责：经宿主的两条路由读状态、发白名单动作，把账号池、登录相位与桌面端探测结果
 * 画出来；本文件不直接访问华为云，也不接触任何令牌。
 * 依赖：`ctx.slots`（回调晚执行）、`ctx.locale`（文案注册与绑定）、宿主提供的 `react`。
 * 不变量：只请求 STATUS_PATH 与 ACTION_PATH；轮询与登录探测都可取消；字段名以
 * `src/types.ts` 的 `StatusSnapshot` 为准，写错不会报错、只会静默显示空白。
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

  var CSS = [
    '.dshc-root{display:flex;flex-direction:column;gap:14px;min-width:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
    '.dshc-head{display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.dshc-heading{display:flex;align-items:center;flex-wrap:wrap;gap:9px;min-width:0}',
    '.dshc-title{margin:0;font-size:17px;font-weight:600;line-height:1.4}',
    '.dshc-version{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-card{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:12px 14px;display:flex;flex-direction:column;gap:8px}',
    '.dshc-card-title{margin:0;font-size:13px;font-weight:600;line-height:1.4}',
    '.dshc-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-warn{margin:0;font-size:12px;line-height:1.6;border-left:3px solid var(--dsw-alias-brand-primary);padding:6px 10px;background:var(--dsw-alias-bg-layer-3);border-radius:0 6px 6px 0;color:var(--dsw-alias-label-secondary)}',
    '.dshc-error{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:3px solid var(--dsw-alias-border-l2);padding:6px 10px}',
    '.dshc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
    '.dshc-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 10px;white-space:nowrap}',
    '.dshc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}',
    '.dshc-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.dshc-btn[data-tone="danger"]{color:var(--dsw-alias-label-secondary)}',
    '.dshc-btn[data-tone="primary"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
    '.dshc-btn:focus-visible,.dshc-check:focus-visible,.dshc-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
    '.dshc-table{width:100%;border-collapse:collapse;font-size:12px}',
    '.dshc-table th{text-align:left;font-weight:600;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}',
    '.dshc-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
    '.dshc-name{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.dshc-name-main{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22em}',
    '.dshc-name-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-badge{display:inline-block;font-size:11px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
    '.dshc-badge[data-tone="ok"]{color:var(--dsw-alias-label-primary)}',
    '.dshc-badge[data-tone="warn"]{border:1px solid var(--dsw-alias-border-l2)}',
    '.dshc-check{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
    '.dshc-select{font:inherit;font-size:12px;padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);max-width:24em}',
    '.dshc-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}',
    '.dshc-grow{flex:1 1 auto;min-width:0}',
    '.dshc-empty{padding:14px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
    '.dshc-link{color:var(--dsw-alias-brand-primary);word-break:break-all;font-size:12px}',
    '@media (max-width:700px){.dshc-table thead{display:none}.dshc-table tr{display:block;border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0}.dshc-table td{display:block;border:0;padding:2px 0}}'
  ].join('');

  var zh = {
    navLabel: '果办 OfficeAce',
    title: '果办 OfficeAce',
    desc: '有客户端就自动读它的登录态；没有就在浏览器里登录一次。多个账号进一张池，可勾选、可切换、失败自动换号。',
    statusLine: '共 {count} 个账号 · 目录 {models} 个模型',
    desktopDetected: '已检测到本机果办客户端',
    desktopMissing: '没检测到本机果办客户端',
    desktopReasonMissing: '没找到果办客户端的数据目录。可以点「登录添加账号」用浏览器登录，不需要装客户端。',
    desktopReasonUnreadable: '检测到果办客户端，但读不到它的登录态。请在客户端里登录一次，或改用浏览器登录。',
    desktopReasonNoGateway: '果办客户端已登录，但还没接入模型。打开客户端点「模型 → 接入模型」，再回来点「同步本机客户端」。',
    accountsTitle: '账号',
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
    renewable: '可续期',
    notRenewable: '过期需重登',
    hasGateway: '已接入模型',
    noGateway: '未接入模型',
    test: '测试',
    remove: '删除',
    removeConfirm: '删除这条账号记录？果办客户端里的登录不会受影响。',
    empty: '还没有账号。装过果办客户端就点「同步本机客户端」；没装就点「登录添加账号」。',
    poolTitle: '账号池',
    poolToggle: '启用账号池（失败自动换号）',
    poolOffHint: '关着时只用下面手动选定的那个账号。',
    poolOnHint: '开着时由排序决定用哪个账号：可用优先 → 快过期先花 → 积分高。当前使用：{name}',
    poolActiveUnknown: '（还没发出请求）',
    poolEmptyMembers: '池里一个账号都没勾。勾选才是「可以花它的额度」的同意。',
    selectAccount: '手动使用哪个账号',
    selectNone: '（未选定）',
    loginTitle: '登录',
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
    refresh: '刷新',
    working: '处理中…',
    quotaUnknown: '—',
    quotaValue: '{remaining} / {total}',
    quotaOnlyRemaining: '剩 {remaining}',
    testOk: '可用（{models} 个模型）',
    testFailed: '不可用：{message}'
  };

  var en = {
    navLabel: 'OfficeAce',
    title: 'OfficeAce (果办)',
    desc: 'Uses the local desktop client when it is signed in; otherwise sign in once in the browser. Multiple accounts share one pool: selectable, switchable, automatic failover.',
    statusLine: '{count} account(s) · {models} model(s) in catalog',
    desktopDetected: 'Local OfficeAce client detected',
    desktopMissing: 'No local OfficeAce client detected',
    desktopReasonMissing: 'No OfficeAce data directory found. Use "Sign in" to add an account in the browser — no client needed.',
    desktopReasonUnreadable: 'OfficeAce client found, but its session could not be read. Sign in inside the client once, or use browser sign-in.',
    desktopReasonNoGateway: 'The client is signed in but has no model gateway yet. Open the client, choose Models → Connect model, then click "Sync client".',
    accountsTitle: 'Accounts',
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
    renewable: 'Renewable',
    notRenewable: 'Re-sign-in required',
    hasGateway: 'Model gateway ready',
    noGateway: 'No model gateway',
    test: 'Test',
    remove: 'Remove',
    removeConfirm: 'Remove this account record? The sign-in inside the OfficeAce client is not affected.',
    empty: 'No accounts yet. If the OfficeAce client is installed, click "Sync client"; otherwise click "Sign in".',
    poolTitle: 'Account pool',
    poolToggle: 'Enable pool (automatic failover)',
    poolOffHint: 'While off, only the manually selected account is used.',
    poolOnHint: 'While on, ranking decides: usable first → expiring soon first → higher quota. Currently used: {name}',
    poolActiveUnknown: '(no request yet)',
    poolEmptyMembers: 'No account is checked. Checking is the consent to spend its quota.',
    selectAccount: 'Account to use',
    selectNone: '(none selected)',
    loginTitle: 'Sign in',
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
    refresh: 'Refresh',
    working: 'Working…',
    quotaUnknown: '—',
    quotaValue: '{remaining} / {total}',
    quotaOnlyRemaining: 'remaining {remaining}',
    testOk: 'Usable ({models} models)',
    testFailed: 'Unusable: {message}'
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

      /** 一次状态快照的共享 store：设置页里的两处视图共用一个轮询。 */
      var snapshot = undefined;
      var inflight;
      var inflightController;
      var ticker;

      function emit() {
        // 设置页只有一个订阅者（整页重渲染），这里不做广播：状态变化直接触发 re-render。
      }

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

      /** 一行账号。抽成独立组件是为了让整页组件保持在 150 行以内。 */
      function AccountRow(props) {
        var account = props.account;
        var t = props.t;
        var busy = props.busy;

        function onToggle(event) {
          props.onToggleMember(account.id, event.target.checked);
        }

        return h(
          'tr',
          null,
          h('td', null, h('input', {
            type: 'checkbox',
            className: 'dshc-check',
            checked: account.inPool === true,
            disabled: busy,
            'aria-label': t('colPool') + '：' + accountName(account),
            onChange: onToggle
          })),
          h('td', null, h('div', { className: 'dshc-name' },
            h('span', { className: 'dshc-name-main', title: account.id }, accountName(account)),
            h('span', { className: 'dshc-name-sub' }, account.id)
          )),
          h('td', null, h('span', { className: 'dshc-badge' }, sourceText(account, t))),
          h('td', null,
            h('span', {
              className: 'dshc-badge',
              'data-tone': account.usable === true ? 'ok' : 'warn',
              title: account.reason || ''
            }, account.usable === true ? t('stateUsable') : t('stateUnusable')),
            account.hasGateway === true ? null : h('span', { className: 'dshc-badge', 'data-tone': 'warn' }, t('noGateway')),
            account.renewable === true ? null : h('span', { className: 'dshc-badge' }, t('notRenewable')),
            account.stsRemainingMs !== undefined
              ? h('span', { className: 'dshc-name-sub' }, remainingText(account.stsRemainingMs))
              : null
          ),
          h('td', null, quotaText(account.quota, t)),
          h('td', null, h('div', { className: 'dshc-row' },
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
          ))
        );
      }

      /** 登录相位提示：只在有会话时显示。 */
      function LoginPanel(props) {
        var view = props.view;
        var t = props.t;
        var busy = props.busy;
        if (view === undefined || view === null || view.phase === 'idle') return null;

        var active = isLoginActive(view);
        var text;
        if (view.phase === 'preparing') text = t('loginPreparing');
        else if (view.phase === 'awaiting-user') text = t('loginAwaiting');
        else if (view.phase === 'exchanging') text = t('loginExchanging');
        else if (view.phase === 'done') text = t('loginDone');
        else if (view.phase === 'cancelled') text = t('loginCancelled');
        else text = format(t('loginFailed'), { message: view.message || '—' });

        return h('div', { className: 'dshc-card' },
          h('h4', { className: 'dshc-card-title' }, t('loginTitle')),
          h('p', { className: 'dshc-hint', 'aria-live': 'polite' }, text),
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
                  disabled: busy,
                  onClick: props.onCancel
                }, t('loginCancel'))
              )
            : null
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

        var desktopLine;
        if (view === undefined) {
          desktopLine = t('desktopMissing');
        } else if (view.desktopDetected === true) {
          desktopLine = t('desktopDetected');
        } else {
          desktopLine = t('desktopMissing');
        }

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

        return h('div', { className: 'dshc-root' },
          h('div', { className: 'dshc-head' },
            h('div', { className: 'dshc-heading' },
              h('h3', { className: 'dshc-title' }, t('title')),
              h('span', { className: 'dshc-version' }, view !== undefined && view.version !== undefined ? 'v' + view.version : '')
            ),
            h('p', { className: 'dshc-desc' }, t('desc')),
            h('p', { className: 'dshc-hint' },
              format(t('statusLine'), {
                count: accounts.length,
                models: view !== undefined && typeof view.modelCount === 'number' ? view.modelCount : 0
              })
            )
          ),

          h('div', { className: 'dshc-card' },
            h('p', { className: 'dshc-hint' }, desktopLine),
            reasonHint !== undefined ? h('p', { className: 'dshc-warn' }, reasonHint) : null,
            h('div', { className: 'dshc-toolbar' },
              h('button', {
                type: 'button',
                className: 'dshc-btn',
                'data-tone': 'primary',
                disabled: busy || isLoginActive(login),
                onClick: function () { void run('login-start', {}); }
              }, busy ? t('working') : t('loginAdd')),
              h('button', {
                type: 'button',
                className: 'dshc-btn',
                disabled: busy,
                onClick: function () { void run('sync-desktop', {}); }
              }, t('loginSync')),
              h('button', {
                type: 'button',
                className: 'dshc-btn',
                disabled: busy,
                onClick: function () { void run('refresh', {}); }
              }, t('refresh'))
            ),
            notice !== undefined
              ? h('p', { className: notice.ok === true ? 'dshc-hint' : 'dshc-error', 'aria-live': 'polite' }, notice.text)
              : null
          ),

          h(LoginPanel, { view: login, t: t, busy: busy, onCancel: function () { void run('login-cancel', {}); } }),

          h('div', { className: 'dshc-card' },
            h('h4', { className: 'dshc-card-title' }, t('accountsTitle')),
            accounts.length === 0
              ? h('p', { className: 'dshc-empty' }, t('empty'))
              : h('table', { className: 'dshc-table' },
                  h('thead', null, h('tr', null,
                    h('th', { scope: 'col' }, t('colPool')),
                    h('th', { scope: 'col' }, t('colAccount')),
                    h('th', { scope: 'col' }, t('colSource')),
                    h('th', { scope: 'col' }, t('colState')),
                    h('th', { scope: 'col' }, t('colQuota')),
                    h('th', { scope: 'col' }, t('colActions'))
                  )),
                  h('tbody', null, accounts.map(function (account) {
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
                )
          ),

          h('div', { className: 'dshc-card' },
            h('h4', { className: 'dshc-card-title' }, t('poolTitle')),
            h('div', { className: 'dshc-row' },
              h('label', { className: 'dshc-row' },
                h('input', {
                  type: 'checkbox',
                  className: 'dshc-check',
                  checked: poolEnabled,
                  disabled: busy,
                  'aria-label': t('poolToggle'),
                  onChange: function (event) { void run('settings', { poolEnabled: event.target.checked }); }
                }),
                h('span', null, t('poolToggle'))
              )
            ),
            h('p', { className: 'dshc-hint' }, poolEnabled ? t('poolOffHint') : t('poolOffHint')),
            poolEnabled
              ? h('p', { className: 'dshc-hint' },
                  format(t('poolOnHint'), { name: activeId !== undefined ? activeName : t('poolActiveUnknown') }))
              : null,
            poolEnabled && accounts.length > 0 && accounts.every(function (a) { return a.inPool !== true; })
              ? h('p', { className: 'dshc-warn' }, t('poolEmptyMembers'))
              : null,
            poolEnabled
              ? null
              : h('div', { className: 'dshc-row' },
                  h('span', { className: 'dshc-hint' }, t('selectAccount')),
                  h('select', {
                    className: 'dshc-select',
                    value: selectedId === undefined ? '' : selectedId,
                    disabled: busy,
                    'aria-label': t('selectAccount'),
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
                )
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
