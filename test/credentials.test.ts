/**
 * 凭据层测试：分块拼接、网关抽取、两个入口合并、三个 reason 分类。
 *
 * 不碰真实凭据管理器：`runPowerShell` 全部注入替身。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDesktop } from '../src/credentials/probe.ts';
import { userIdOfSessionValue, toQuotaReading } from '../src/host/quota.ts';

/** 建一个临时 HOME，用完删。 */
async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dshc-cred-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe('桌面端探测', () => {
  test('三个目录都不存在 → desktop-missing', async () => {
    // 不能用 mkdtemp：那样根目录是**真实存在**的，分类器会判成「装了但没登录」。
    // 要测「根本没装客户端」，根目录必须也不存在。
    const home = join(tmpdir(), 'dshc-absent-' + String(Date.now()) + '-' + String(Math.random()).slice(2));
    const probe = await probeDesktop({ OFFICE_CLAW_HOME: home });
    assert.equal(probe.installed, false);
    assert.equal(probe.reason, 'desktop-missing');
    assert.deepEqual(probe.accounts, []);
  });

  test('根目录在但 users/ 空 → desktop-no-gateway（装了没登录）', async () => {
    await withTempHome(async (home) => {
      // mkdtemp 建出来的根目录是存在的；`users/` 也建上但里面是空的。
      await mkdir(join(home, 'users'), { recursive: true });
      const probe = await probeDesktop({ OFFICE_CLAW_HOME: home });
      assert.equal(probe.installed, false);
      assert.equal(probe.reason, 'desktop-no-gateway');
    });
  });

  test('routing_state 的 models.json → 解出 Basic 认证的网关凭据', async () => {
    await withTempHome(async (home) => {
      const userDir = join(home, '.jiuwenclaw', 'config', 'routing_state', 'users', 'user-1');
      await mkdir(userDir, { recursive: true });
      const appKey = 'APPKEY123';
      const appSecret = 'APPSECRET456';
      const basic = Buffer.from(appKey + ':' + appSecret, 'utf8').toString('base64');
      await writeFile(
        join(userDir, 'models.json'),
        JSON.stringify({
          defaults: [
            {
              model_name: 'glm-5.3',
              model_client_config: {
                api_base: 'https://gw.example.com/v2',
                api_key: 'huawei-maas-session',
                custom_headers: { Authorization: 'Basic ' + basic },
              },
            },
          ],
        }),
      );

      const probe = await probeDesktop({ OFFICE_CLAW_HOME: home });
      assert.equal(probe.installed, true, `应判定为读到可用账号，实际 reason=${String(probe.reason)}`);
      assert.equal(probe.accounts.length, 1);
      const account = probe.accounts[0];
      assert.ok(account !== undefined);
      assert.equal(account.via, 'models-json');
      assert.equal(account.gateway?.appKey, appKey);
      assert.equal(account.gateway?.appSecret, appSecret);
      assert.ok(account.gateway?.base.startsWith('https://gw.example.com'), `base 实际 ${String(account.gateway?.base)}`);
    });
  });

  test('models.json 是坏 JSON → 不抛，判为无网关', async () => {
    await withTempHome(async (home) => {
      const userDir = join(home, '.jiuwenclaw', 'config', 'routing_state', 'users', 'user-1');
      await mkdir(userDir, { recursive: true });
      await writeFile(join(userDir, 'models.json'), '{ this is not json');
      const probe = await probeDesktop({ OFFICE_CLAW_HOME: home });
      assert.equal(probe.accounts.length, 0);
      assert.equal(probe.installed, false);
      // 根目录存在（mkdtemp 建的），所以是「装了但没读到可用凭据」。
      assert.equal(probe.reason, 'desktop-no-gateway');
    });
  });

  test('多个用户目录 → 全部枚举出来', async () => {
    await withTempHome(async (home) => {
      const root = join(home, '.jiuwenclaw', 'config', 'routing_state', 'users');
      for (const userId of ['user-a', 'user-b']) {
        const userDir = join(root, userId);
        await mkdir(userDir, { recursive: true });
        const basic = Buffer.from('K-' + userId + ':S-' + userId, 'utf8').toString('base64');
        await writeFile(
          join(userDir, 'models.json'),
          JSON.stringify({
            defaults: [
              {
                model_client_config: {
                  api_base: 'https://gw.example.com/v2',
                  custom_headers: { Authorization: 'Basic ' + basic },
                },
              },
            ],
          }),
        );
      }
      const probe = await probeDesktop({ OFFICE_CLAW_HOME: home });
      assert.equal(probe.accounts.length, 2, `应枚举出两个账号，实际 ${String(probe.accounts.length)}`);
    });
  });
});

describe('会话 cookie', () => {
  test('从 session value 里取出 userId', () => {
    assert.equal(userIdOfSessionValue('domain%3Auser-123.abc.def'), 'user-123');
  });

  test('形状不符 → undefined（不猜）', () => {
    assert.equal(userIdOfSessionValue('nodots'), undefined);
    assert.equal(userIdOfSessionValue('nodomain.abc'), undefined);
    assert.equal(userIdOfSessionValue('domain%3A.abc'), undefined);
  });
});

describe('额度读数', () => {
  test('顶层字段 → 归一', () => {
    const reading = toQuotaReading({ total: 4600, used: 1200, remaining: 3400, plan: '个人体验版' }, 1000);
    assert.equal(reading.total, 4600);
    assert.equal(reading.used, 1200);
    assert.equal(reading.remaining, 3400);
    assert.equal(reading.plan, '个人体验版');
    assert.equal(reading.readAtMs, 1000);
  });

  test('嵌套在 data 里 → 归一', () => {
    const reading = toQuotaReading({ data: { total: 100, used: 30 } }, 2000);
    assert.equal(reading.total, 100);
    // 没给 remaining 时用 total - used 算出来，而不是留空。
    assert.equal(reading.remaining, 70);
  });

  test('形状不认识 → 只有 readAtMs，绝不编造 0', () => {
    const reading = toQuotaReading('not an object', 3000);
    assert.deepEqual(reading, { readAtMs: 3000 });
  });
});
