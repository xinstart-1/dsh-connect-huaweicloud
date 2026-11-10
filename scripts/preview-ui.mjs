/**
 * 浏览器半边的版式预览：把设置页在真浏览器里渲染出来，供人工核对与截图。
 *
 * 为什么需要它：浏览器半边没有类型检查兜底，`check-client.mjs` 只能验语法与文案
 * 完整性 —— 它验不出「行高塌了」「控件换行错位」「窄栏下表格溢出」。这些只有在真
 * 渲染里才看得见，而装进宿主再刷新一次的成本远高于开一个静态预览页。
 *
 * 用法：`node scripts/preview-ui.mjs` 起预览服务，然后用浏览器打开打印出的地址。
 * 加 `--check` 只做装配自检（不常驻），供 gate 使用。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 从 bundle 源码里抽出 CSS 与两份字典。 */
export function extractAssets(source) {
  const cssMatch = /var CSS = \[([\s\S]*?)\]\.join\(''\);/u.exec(source);
  if (cssMatch === null) throw new Error('找不到 CSS 数组');
  // 只读源码求值这一小段，不执行插件本体。
  const css = new Function(`return [${cssMatch[1]}].join('');`)();

  const dictOf = (language) => {
    const marker = new RegExp(`var\\s+${language}\\s*=\\s*\\{`, 'u');
    const found = marker.exec(source);
    if (found === null) throw new Error(`找不到 ${language} 字典`);
    const start = found.index + found[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`${language} 字典括号不配平`);
    return new Function(`return {${source.slice(start + 1, end)}};`)();
  };

  return { css, zh: dictOf('zh'), en: dictOf('en') };
}

/** 造一份演示用的状态快照：覆盖可用/不可用/无网关/无 STS 四种账号。 */
function demoSnapshot(nowMs) {
  return {
    version: '0.0.1',
    accounts: [
      {
        id: 'acc_1a2b3c4d5e6f7a8b',
        label: '示例账号（已登录）',
        userName: 'demo-user-1',
        origin: 'login',
        renewable: true,
        hasGateway: true,
        stsRemainingMs: 42 * 60 * 1000,
        inPool: true,
        usable: true,
        quota: { total: 4600, used: 1200, remaining: 3400, plan: '个人体验版', readAtMs: nowMs },
        syncedAtMs: nowMs - 60_000,
      },
      {
        id: 'acc_2b3c4d5e6f7a8b9c',
        label: '读自客户端的账号',
        userName: 'demo-user-2',
        origin: 'import',
        renewable: false,
        hasGateway: true,
        inPool: true,
        usable: true,
        quota: { remaining: 800, readAtMs: nowMs },
        syncedAtMs: nowMs - 3600_000,
      },
      {
        id: 'acc_3c4d5e6f7a8b9c0d',
        label: '未接入模型的账号',
        userName: 'demo-user-3',
        origin: 'import',
        renewable: false,
        hasGateway: false,
        inPool: false,
        usable: false,
        reason: '没有可用的模型网关凭据',
        syncedAtMs: nowMs - 7200_000,
      },
      {
        id: 'acc_4d5e6f7a8b9c0d1e',
        label: '凭据过期的账号',
        userName: 'demo-user-4',
        origin: 'login',
        renewable: true,
        hasGateway: true,
        stsRemainingMs: -1000,
        inPool: false,
        usable: false,
        reason: '凭据已过期，需要重新登录',
        syncedAtMs: nowMs - 86_400_000,
      },
    ],
    poolEnabled: false,
    selectedId: 'acc_1a2b3c4d5e6f7a8b',
    activeId: 'acc_1a2b3c4d5e6f7a8b',
    login: { phase: 'idle', startedAtMs: nowMs },
    desktopDetected: false,
    desktopReason: 'desktop-missing',
    modelCount: 7,
  };
}

/** 剩余毫秒说成人话；与 `bundle.js` 里的 `remainingText()` 逐字同规则。 */
function remainingText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '0';
  if (ms >= 3600000) return Math.ceil(ms / 3600000) + 'h';
  if (ms >= 60000) return Math.ceil(ms / 60000) + 'm';
  return Math.ceil(ms / 1000) + 's';
}

/** 预览页：不加载 React，直接把版式结构画成等价 HTML，只验版式不验逻辑。 */
function renderPreviewPage({ css, zh, snapshot, initialTheme }) {
  const esc = (value) =>
    String(value)
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/"/gu, '&quot;');

  const row = (label, hint, controlHtml) =>
    `<div class="dshc-row"><div class="dshc-row-text"><span class="dshc-row-label">${esc(label)}</span>` +
    (hint === undefined ? '' : `<span class="dshc-row-hint">${esc(hint)}</span>`) +
    `</div><div class="dshc-row-control">${controlHtml}</div></div>`;

  const group = (text) => `<div class="dshc-group">${esc(text)}</div>`;

  const accountRows = snapshot.accounts
    .map((account) => {
      const badges = [
        `<span class="dshc-badge" data-tone="${account.usable ? 'ok' : 'warn'}">${
          account.usable ? esc(zh.stateUsable) : esc(zh.stateUnusable)
        }</span>`,
        account.hasGateway ? '' : `<span class="dshc-badge" data-tone="warn">${esc(zh.noGateway)}</span>`,
        account.renewable ? '' : `<span class="dshc-badge">${esc(zh.notRenewable)}</span>`,
      ].join('');
      const remaining =
        account.stsRemainingMs === undefined ? '' : `<span>${esc(remainingText(account.stsRemainingMs))}</span>`;
      const quota =
        account.quota === undefined
          ? esc(zh.quotaUnknown)
          : account.quota.total === undefined
            ? esc(zh.quotaOnlyRemaining).replace('{remaining}', String(account.quota.remaining))
            : esc(zh.quotaValue)
                .replace('{remaining}', String(account.quota.remaining))
                .replace('{total}', String(account.quota.total));

      return (
        `<div class="dshc-acct">` +
        `<div class="dshc-acct-top">` +
        `<input type="checkbox" class="dshc-check"${account.inPool ? ' checked' : ''}>` +
        `<div class="dshc-acct-body">` +
        `<span class="dshc-acct-name">${esc(account.label)}</span>` +
        `<div class="dshc-acct-meta">` +
        `<span>${esc(account.origin === 'login' ? zh.sourceLogin : zh.sourceImport)}</span>` +
        remaining +
        badges +
        `</div></div></div>` +
        `<div class="dshc-acct-foot">` +
        `<span class="dshc-acct-quota">${quota}</span>` +
        `<button type="button" class="dshc-btn">${esc(zh.test)}</button>` +
        `<button type="button" class="dshc-btn" data-tone="danger">${esc(zh.remove)}</button>` +
        `</div></div>`
      );
    })
    .join('');

  return `<!doctype html>
<html lang="zh"${initialTheme === 'light' ? ' data-theme="light"' : ''}><head><meta charset="utf-8"><title>果办 OfficeAce 设置页预览</title>
<style>
  :root{
    --dsw-alias-label-primary:#e8e9ed; --dsw-alias-label-secondary:#b8bcc4;
    --dsw-alias-label-tertiary:#8a8f99; --dsw-alias-border-l1:#2a2c31;
    --dsw-alias-border-l2:#3a3d45; --dsw-alias-bg-layer-1:#17181b;
    --dsw-alias-bg-layer-2:#232529; --dsw-alias-bg-layer-3:#2b2d33;
    --dsw-alias-brand-primary:#5686fe;
  }
  html[data-theme="light"]{
    --dsw-alias-label-primary:#1f2328; --dsw-alias-label-secondary:#4a5158;
    --dsw-alias-label-tertiary:#6b7280; --dsw-alias-border-l1:#e5e7eb;
    --dsw-alias-border-l2:#d1d5db; --dsw-alias-bg-layer-1:#fff;
    --dsw-alias-bg-layer-2:#f6f7f9; --dsw-alias-bg-layer-3:#eef0f3;
    --dsw-alias-brand-primary:#2563eb;
  }
  body{margin:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
    font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .frame{max-width:564px;margin:0 auto;padding:20px 22px 40px}
  .bar{display:flex;gap:8px;align-items:center;margin-bottom:14px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
  .bar button{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);
    border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);padding:2px 8px}
${css}
</style></head>
<body>
<div class="frame">
  <div class="bar">
    <span>设置 → 果办 OfficeAce（内容列宽 564px，与宿主一致）</span>
    <button type="button" onclick="document.documentElement.dataset.theme =
      document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'">切换主题</button>
  </div>
  <div class="dshc-root">
    <div class="dshc-head">
      <div class="dshc-head-icon">
        <svg width="24" height="24" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/>
          <circle cx="5.5" cy="8" r="1.4" fill="currentColor"/>
          <path d="M8.5 6.6h4M8.5 9.4h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </div>
      <h3 class="dshc-title">${esc(zh.title)}<span class="dshc-version">v${esc(snapshot.version)}</span></h3>
      <p class="dshc-desc">${esc(zh.desc)}</p>
    </div>

    <p class="dshc-note">${esc(zh.statusLine)
      .replace('{count}', String(snapshot.accounts.length))
      .replace('{models}', String(snapshot.modelCount))}</p>

    ${group(zh.groupDesktop)}
    ${row(zh.desktopLabel, zh.desktopMissing, `<button type="button" class="dshc-btn">${esc(zh.syncBtn)}</button>`)}
    <div class="dshc-row-stack"><p class="dshc-warn">${esc(zh.desktopReasonMissing)}</p></div>

    ${group(zh.groupLogin)}
    ${row(
      zh.loginLabel,
      zh.loginHint,
      `<button type="button" class="dshc-btn" data-tone="primary">${esc(zh.loginAdd)}</button>`,
    )}

    ${group(zh.groupAccounts)}
    <div class="dshc-row-stack">
      <p class="dshc-note">${esc(zh.accountsHint)}</p>
      <div class="dshc-acct-list">${accountRows}</div>
    </div>

    ${group(zh.groupPool)}
    ${row(zh.poolLabel, zh.poolHintOff, `<label class="dshc-switch"><input type="checkbox" class="dshc-check"></label>`)}
    ${row(
      zh.selectLabel,
      zh.selectHint,
      `<select class="dshc-select"><option>${esc(zh.selectNone)}</option>` +
        snapshot.accounts.map((a) => `<option>${esc(a.label)}</option>`).join('') +
        `</select>`,
    )}

    ${group(zh.groupOther)}
    ${row(zh.refreshLabel, zh.refreshHint, `<button type="button" class="dshc-btn">${esc(zh.refresh)}</button>`)}
  </div>
</div>
</body></html>`;
}

/** 直接执行时才起服务；被测试 import 时不跑。 */
const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('preview-ui.mjs');

if (invokedDirectly) {
  const source = await readFile(resolve('src/client/bundle.js'), 'utf8');
  const assets = extractAssets(source);
  const snapshot = demoSnapshot(Date.now());
  /** `?theme=light` 让浅色主题也能被截图核对：没有这条，浅色下不可读的问题只能靠猜。 */
  const initialTheme = process.argv.includes('--light') ? 'light' : 'dark';
  const html = renderPreviewPage({ ...assets, snapshot, initialTheme });

  if (process.argv.includes('--check')) {
    // 装配自检：三样产物都能生成，且关键类名都在 CSS 里。
    const missing = ['dshc-root', 'dshc-head', 'dshc-row', 'dshc-group', 'dshc-acct', 'dshc-switch'].filter(
      (name) => !assets.css.includes('.' + name),
    );
    if (missing.length > 0) {
      console.error(`CSS 缺少关键类名：${missing.join(', ')}`);
      process.exit(1);
    }
    if (html.length < 2000) {
      console.error('预览页内容过少，版式装配可能失败');
      process.exit(1);
    }
    console.log(`ok   preview-ui：CSS ${String(assets.css.length)} 字节，zh ${String(Object.keys(assets.zh).length)} 键，预览页 ${String(html.length)} 字节`);
  } else {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      console.log(`预览地址：http://127.0.0.1:${String(port)}/`);
      console.log('按 Ctrl+C 退出。');
    });
  }
}
