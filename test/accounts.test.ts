/**
 * `host/accounts.ts` 的测试：单飞续期、续期三条不变量、失败冷却与幂等同步。
 *
 * 仓库用内存版替身：这些行为全在运行时内存里（健康度、单飞表），落盘只需验证
 * 「写了什么」，用真文件只会让断言变慢且更脆。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccounts, type Accounts } from '../src/host/accounts.ts';
import { accountIdFor } from '../src/credentials/vault.ts';
import type { Vault } from '../src/credentials/vault.ts';
import type { GatewayCredential, StoredAccount, StsCredential } from '../src/types.ts';

/** 固定的「现在」：冷却时长断言必须靠注入时钟，不能读真实时间。 */
const NOW = 1_800_000_000_000;

const MINUTE = 60 * 1000;

/** 内存仓库：只记「写了什么」，不碰磁盘。 */
class MemoryVault implements Vault {
  readonly records = new Map<string, StoredAccount>();
  /** 每次 `save` 的入参快照，按调用顺序；断言「写了新凭据」用。 */
  readonly saves: StoredAccount[] = [];
  private selectedId: string | undefined;

  async list(): Promise<StoredAccount[]> {
    return [...this.records.values()].sort((left, right) => left.savedAtMs - right.savedAtMs);
  }

  async get(id: string): Promise<StoredAccount | undefined> {
    return this.records.get(id);
  }

  async save(account: StoredAccount): Promise<void> {
    this.saves.push(account);
    this.records.set(account.id, account);
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async readSelected(): Promise<string | undefined> {
    return this.selectedId;
  }

  async writeSelected(id: string | undefined): Promise<void> {
    this.selectedId = id;
  }

  /** 直接塞一条记录（不走 `save`，避免污染 save 计数）。 */
  seed(account: StoredAccount): void {
    this.records.set(account.id, account);
  }
}

/** 造一份 STS；默认 5 分钟后过期（落在续期提前量内）。 */
function sts(overrides: Partial<StsCredential> = {}): StsCredential {
  return {
    accessKeyId: 'AK-1',
    secretAccessKey: 'SK-1',
    securityToken: 'TOKEN-1',
    projectId: 'project-1',
    expiresAt: new Date(NOW + 5 * MINUTE).toISOString(),
    refreshToken: 'refresh-1',
    dpopPrivateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    domainId: 'domain-1',
    ...overrides,
  };
}

const GATEWAY: GatewayCredential = {
  base: 'https://api.modelarts-maas.com/v2',
  appKey: 'app-key',
  appSecret: 'app-secret',
};

const ACCOUNT_KEY = 'domain-1';
const ACCOUNT_ID = accountIdFor(ACCOUNT_KEY);

/** 造一条已落库的账号记录。 */
function stored(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id: ACCOUNT_ID,
    accountKey: ACCOUNT_KEY,
    label: '测试账号',
    userId: 'user-1',
    userName: '测试账号',
    origin: 'login',
    sts: sts(),
    savedAtMs: NOW,
    syncedAtMs: NOW,
    ...overrides,
  };
}

/** 一个可控的运行时夹具：注入时钟，所有依赖都能换。 */
function fixture(overrides: {
  now?: () => number;
  refreshSts?: (credential: StsCredential) => Promise<StsCredential>;
  fetchGateway?: (credential: StsCredential) => Promise<GatewayCredential | undefined>;
  probe?: () => Promise<{
    installed: boolean;
    reason?: string;
    accounts: readonly {
      userId: string;
      userName: string;
      gateway?: GatewayCredential;
      sts?: { securityToken: string; expiresAt: string };
      via: 'wincred' | 'models-json';
    }[];
  }>;
} = {}): {
  vault: MemoryVault;
  accounts: Accounts;
  warnings: string[];
  refreshCalls: StsCredential[];
  fetchCalls: StsCredential[];
} {
  const vault = new MemoryVault();
  const warnings: string[] = [];
  const refreshCalls: StsCredential[] = [];
  const fetchCalls: StsCredential[] = [];
  let nowMs = NOW;

  const accounts = createAccounts(
    {
      vault,
      probe:
        overrides.probe ??
        (async () => ({
          installed: true,
          accounts: [
            {
              userId: 'user-1',
              userName: '测试账号',
              gateway: GATEWAY,
              via: 'wincred',
            },
          ],
        })),
      refreshSts:
        overrides.refreshSts ??
        (async (credential) => {
          refreshCalls.push(credential);
          return sts({ refreshToken: 'refresh-2', securityToken: 'TOKEN-2' });
        }),
      fetchGateway:
        overrides.fetchGateway ?? (async () => GATEWAY),
      warn: (message) => {
        warnings.push(message);
      },
    },
    {
      now: overrides.now ?? (() => nowMs),
      members: async () => [ACCOUNT_ID],
    },
  );

  return { vault, accounts, warnings, refreshCalls, fetchCalls };
}

test('单飞续期：并发两次 gatewayOf → refreshSts 只被调用 1 次', async () => {
  const vault = new MemoryVault();
  const refreshCalls: StsCredential[] = [];
  let nowMs = NOW;
  vault.seed(stored());

  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async (credential) => {
        refreshCalls.push(credential);
        // 拉长一点：让第二次调用确实落在第一次还没完成的窗口里。
        await new Promise((resolve) => setTimeout(resolve, 10));
        return sts({ refreshToken: 'refresh-2' });
      },
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => nowMs, members: async () => [ACCOUNT_ID] },
  );

  const [first, second] = await Promise.all([
    accounts.gatewayOf(ACCOUNT_ID),
    accounts.gatewayOf(ACCOUNT_ID),
  ]);

  assert.equal(refreshCalls.length, 1);
  assert.equal(first, GATEWAY);
  assert.equal(second, GATEWAY);
  nowMs += 1;
});

test('续期成功：立刻 vault.save，且写入的是新 refresh_token', async () => {
  const vault = new MemoryVault();
  vault.seed(stored());
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts({ refreshToken: 'refresh-2', securityToken: 'TOKEN-2' }),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );

  await accounts.gatewayOf(ACCOUNT_ID);

  assert.ok(vault.saves.length >= 1);
  const firstSave = vault.saves[0];
  assert.ok(firstSave !== undefined);
  assert.equal(firstSave.sts?.refreshToken, 'refresh-2');
  assert.equal(firstSave.sts?.securityToken, 'TOKEN-2');
  // 落盘记录也真的被替换，下一次读到的是新凭据。
  assert.equal(vault.records.get(ACCOUNT_ID)?.sts?.refreshToken, 'refresh-2');
});

test('续期失败但未过期：继续用旧凭据，账号仍可用', async () => {
  const vault = new MemoryVault();
  vault.seed(stored());
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => {
        throw new Error('网络抖动');
      },
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );

  const gateway = await accounts.gatewayOf(ACCOUNT_ID);

  assert.equal(gateway, GATEWAY);
  const account = await vault.get(ACCOUNT_ID);
  assert.ok(account !== undefined);
  assert.equal(accounts.usability(account).usable, true);
});

test('续期失败且已过期：账号不可用，gatewayOf 返回 undefined', async () => {
  const vault = new MemoryVault();
  vault.seed(stored({ sts: sts({ expiresAt: new Date(NOW - MINUTE).toISOString() }) }));
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => {
        throw new Error('refresh_token 已被消费');
      },
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );

  const gateway = await accounts.gatewayOf(ACCOUNT_ID);
  assert.equal(gateway, undefined);

  const account = await vault.get(ACCOUNT_ID);
  assert.ok(account !== undefined);
  const verdict = accounts.usability(account);
  assert.equal(verdict.usable, false);
  assert.match(verdict.reason ?? '', /停用/u);
});

test('冷却 authentication：失败后 1 小时内不可用，1 小时后恢复', () => {
  let nowMs = NOW;
  const vault = new MemoryVault();
  vault.seed(stored({ gateway: GATEWAY }));
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => nowMs, members: async () => [ACCOUNT_ID] },
  );
  const account = stored({ gateway: GATEWAY });

  accounts.noteFailure(ACCOUNT_ID, 'authentication', '401 invalid token');
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 59 * MINUTE;
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 2 * MINUTE;
  assert.equal(accounts.usability(account).usable, true);
});

test('冷却 hard-credit：30 分钟内不可用，之后恢复（不永久踢出）', () => {
  let nowMs = NOW;
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => nowMs, members: async () => [ACCOUNT_ID] },
  );
  const account = stored({ gateway: GATEWAY });

  accounts.noteFailure(ACCOUNT_ID, 'hard-credit', '额度耗尽');
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 29 * MINUTE;
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 2 * MINUTE;
  assert.equal(accounts.usability(account).usable, true);
});

test('冷却 server：30 秒内不可用，之后恢复', () => {
  let nowMs = NOW;
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => nowMs, members: async () => [ACCOUNT_ID] },
  );
  const account = stored({ gateway: GATEWAY });

  accounts.noteFailure(ACCOUNT_ID, 'server', '502 bad gateway');
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 29_000;
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 2_000;
  assert.equal(accounts.usability(account).usable, true);
});

test('冷却 soft-rate：15 秒内不可用，之后恢复', () => {
  let nowMs = NOW;
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => nowMs, members: async () => [ACCOUNT_ID] },
  );
  const account = stored({ gateway: GATEWAY });

  accounts.noteFailure(ACCOUNT_ID, 'soft-rate', '429 too many requests');
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 14_000;
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 2_000;
  assert.equal(accounts.usability(account).usable, true);
});

test('不惩罚账号：client / model-unavailable / not-found 三种失败后仍可用', () => {
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );
  const account = stored({ gateway: GATEWAY });

  for (const kind of ['client', 'model-unavailable', 'not-found'] as const) {
    accounts.noteFailure(ACCOUNT_ID, kind, `${kind} 失败`);
    assert.equal(accounts.usability(account).usable, true, `${kind} 不该惩罚账号`);
  }
});

test('noteSuccess：清掉冷却，但不解除认证失败造成的停用', () => {
  let nowMs = NOW;
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => nowMs, members: async () => [ACCOUNT_ID] },
  );
  const account = stored({ gateway: GATEWAY });

  accounts.noteFailure(ACCOUNT_ID, 'soft-rate', '429');
  accounts.noteSuccess(ACCOUNT_ID);
  assert.equal(accounts.usability(account).usable, true);

  accounts.noteFailure(ACCOUNT_ID, 'authentication', '401');
  accounts.noteSuccess(ACCOUNT_ID);
  assert.equal(accounts.usability(account).usable, false);
  nowMs += 1;
});

test('syncDesktop 幂等：同一批账号同步两次 → vault.list() 长度不变', async () => {
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({
        installed: true,
        accounts: [
          { userId: 'user-1', userName: '一号', gateway: GATEWAY, via: 'wincred' },
          { userId: 'user-2', userName: '二号', gateway: GATEWAY, via: 'wincred' },
        ],
      }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [] },
  );

  const first = await accounts.syncDesktop();
  const firstList = await vault.list();
  const second = await accounts.syncDesktop();
  const secondList = await vault.list();

  assert.equal(first.imported, 2);
  assert.equal(first.skipped, 0);
  assert.equal(second.imported, 2);
  assert.equal(firstList.length, 2);
  assert.equal(secondList.length, 2);
  assert.deepEqual(
    secondList.map((account) => account.id).sort(),
    firstList.map((account) => account.id).sort(),
  );
});

test('syncDesktop 单条坏记录：不计入 imported，也不中断整批', async () => {
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({
        installed: true,
        accounts: [
          { userId: '', userName: '', gateway: GATEWAY, via: 'wincred' },
          { userId: 'user-2', userName: '二号', gateway: GATEWAY, via: 'wincred' },
        ],
      }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [] },
  );

  const result = await accounts.syncDesktop();

  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.equal((await vault.list()).length, 1);
});

test('syncDesktop 身份优先 userId：userName 变了也覆盖同一条记录', async () => {
  const vault = new MemoryVault();
  let userName = '旧名字';
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({
        installed: true,
        accounts: [{ userId: 'user-1', userName, gateway: GATEWAY, via: 'wincred' }],
      }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [] },
  );

  await accounts.syncDesktop();
  userName = '新名字';
  await accounts.syncDesktop();

  const list = await vault.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, accountIdFor('user-1'));
  assert.equal(list[0]?.label, '新名字');
});

test('syncDesktop 只有 STS 元信息：origin 为 import、不写 sts、syncError 说明只能用到期', async () => {
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({
        installed: true,
        accounts: [
          {
            userId: 'user-1',
            userName: '一号',
            sts: { securityToken: 'TOKEN-1', expiresAt: new Date(NOW + MINUTE).toISOString() },
            via: 'models-json',
          },
        ],
      }),
      refreshSts: async () => sts(),
      fetchGateway: async () => undefined,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [] },
  );

  await accounts.syncDesktop();

  const account = await vault.get(accountIdFor('user-1'));
  assert.ok(account !== undefined);
  assert.equal(account.origin, 'import');
  assert.equal(account.sts, undefined);
  assert.match(account.syncError ?? '', /只能用到过期/u);
});

test('adopt：写入 sts 与 gateway，并清掉旧的停用状态', async () => {
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );
  const before = stored({ gateway: GATEWAY, userName: '测试账号' });
  vault.seed(before);
  accounts.noteFailure(ACCOUNT_ID, 'authentication', '401');
  assert.equal(accounts.usability(before).usable, false);

  const adopted = await accounts.adopt(sts({ refreshToken: 'refresh-9' }));

  assert.equal(adopted.id, ACCOUNT_ID);
  assert.equal(adopted.origin, 'login');
  assert.equal(adopted.sts?.refreshToken, 'refresh-9');
  assert.equal(adopted.gateway, GATEWAY);
  assert.equal(accounts.usability(adopted).usable, true);
});

test('adopt：网关取不到也照样保存（STS 已能续期）', async () => {
  const vault = new MemoryVault();
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => {
        throw new Error('权限校验 500');
      },
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );

  const adopted = await accounts.adopt(sts());

  assert.equal(adopted.gateway, undefined);
  assert.equal(adopted.sts?.refreshToken, 'refresh-1');
  assert.equal(accounts.usability(adopted).usable, true);
});

test('gatewayOf：有 gateway 直接返回，不触发续期', async () => {
  const vault = new MemoryVault();
  const refreshCalls: StsCredential[] = [];
  vault.seed(stored({ gateway: GATEWAY }));
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async (credential) => {
        refreshCalls.push(credential);
        return sts({ refreshToken: 'refresh-2' });
      },
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );

  assert.equal(await accounts.gatewayOf(ACCOUNT_ID), GATEWAY);
  assert.equal(refreshCalls.length, 0);
});

test('gatewayOf：没有 gateway 也没有 sts → undefined，且告警一次', async () => {
  const vault = new MemoryVault();
  const warnings: string[] = [];
  vault.seed(stored({ sts: undefined }));
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: (message) => {
        warnings.push(message);
      },
    },
    { now: () => NOW, members: async () => [ACCOUNT_ID] },
  );

  assert.equal(await accounts.gatewayOf(ACCOUNT_ID), undefined);
  assert.equal(warnings.length, 1);
});

test('candidates：按勾选名单标 inPool，不可用的带原因', async () => {
  const vault = new MemoryVault();
  const inPoolId = accountIdFor('user-1');
  const otherId = accountIdFor('user-2');
  vault.seed(stored({ id: inPoolId, accountKey: 'user-1' }));
  vault.seed(stored({ id: otherId, accountKey: 'user-2', gateway: undefined, sts: undefined }));
  const accounts = createAccounts(
    {
      vault,
      probe: async () => ({ installed: true, accounts: [] }),
      refreshSts: async () => sts(),
      fetchGateway: async () => GATEWAY,
      warn: () => undefined,
    },
    { now: () => NOW, members: async () => [inPoolId] },
  );

  const candidates = await accounts.candidates();

  assert.equal(candidates.length, 2);
  const inPool = candidates.find((entry) => entry.id === inPoolId);
  const other = candidates.find((entry) => entry.id === otherId);
  assert.ok(inPool !== undefined && other !== undefined);
  assert.equal(inPool.inPool, true);
  assert.equal(inPool.usable, true);
  assert.ok(inPool.expiresAtMs !== undefined);
  assert.equal(other.inPool, false);
  assert.equal(other.usable, false);
  assert.ok(other.reason !== undefined);
});
