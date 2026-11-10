/**
 * 装配自检：用真 Cordis Context 装载一次插件。
 *
 * 单测逐层覆盖，但没有一处证明「`apply()` 真的把它们接起来了」。假 ctx 也验不出
 * 「Cordis 接不接受这套装配」—— 真 Context 会暴露服务缺失、effect 泄漏、注册顺序
 * 这类问题，而它们只在宿主启动时才炸。
 *
 * 用法：`node scripts/smoke-apply.mjs`（失败非 0 退出）
 */

import { Context } from '@deepseek-ai/cordis';

/** 记录注册结果。 */
const registered = {
  adapters: [],
  providers: [],
  discovery: [],
  routes: [],
};

const ctx = new Context();

// 最小的 llm 服务替身：只要签名对得上，就能证明 apply 的调用形状是对的。
ctx.provide('llm', {
  registerAdapter(keys, adapter) {
    registered.adapters.push({ keys, hasAdapter: typeof adapter === 'object' });
    return () => {};
  },
  registerConfigurableProviders(entries) {
    registered.providers.push(...entries);
    return () => {};
  },
  registerModelDiscovery(namespace, fn) {
    registered.discovery.push({ namespace, type: typeof fn });
    return () => {};
  },
});

ctx.provide('webServer', {
  register(entry) {
    registered.routes.push(entry.path);
    return () => {};
  },
});

/** effect 收集的 disposer；卸载时必须非空，否则注册了却没人清理。 */
const disposers = [];
ctx.effect = (fn) => {
  const disposer = typeof fn === 'function' ? fn() : undefined;
  if (typeof disposer === 'function') disposers.push(disposer);
  return disposer;
};

Object.defineProperty(ctx, 'logger', {
  value: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  configurable: true,
});

const mod = await import('../lib/index.js');
await mod.apply(ctx, {
  enabled: true,
  reuseDesktop: false,
  writeBackDesktop: false,
  // 关掉预热：它会去读凭据与拉目录，自检不该依赖本机环境。
  warmOnStart: false,
  maxFailoverAttempts: 3,
});

const problems = [];
if (registered.adapters.length !== 1) problems.push(`应注册 1 个 adapter，实际 ${String(registered.adapters.length)}`);
if (registered.providers.length !== 1) problems.push(`应注册 1 个 provider，实际 ${String(registered.providers.length)}`);
if (registered.discovery.length !== 1) problems.push(`应注册 1 个模型发现，实际 ${String(registered.discovery.length)}`);
if (registered.routes.length !== 2) problems.push(`应注册 2 条路由，实际 ${String(registered.routes.length)}`);
if (disposers.length === 0) problems.push('没有收集到任何 disposer：注册了却没人清理');

if (problems.length > 0) {
  console.error('装配自检失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// 卸载一次：disposer 必须不抛。
for (const dispose of disposers) {
  try {
    await dispose();
  } catch (error) {
    console.error(`disposer 抛错：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

console.log(
  `ok   apply 装配成功：adapter ${String(registered.adapters.length)} / provider ${String(registered.providers.length)} / ` +
    `发现 ${String(registered.discovery.length)} / 路由 ${String(registered.routes.length)} / disposer ${String(disposers.length)}`,
);
