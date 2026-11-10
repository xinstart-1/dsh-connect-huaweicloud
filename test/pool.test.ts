/**
 * `host/pool.ts` 的纯函数测试：五条排序键与四条硬规则各一条用例。
 *
 * 每条排序键都要有一个「只靠它才能决出胜负」的场景，否则它被后面的键悄悄兜住，
 * 排序逻辑坏掉也测不出来。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { failoverCandidates, pickAccount } from '../src/host/pool.ts';
import type { PoolCandidate } from '../src/types.ts';

/** 固定的「现在」：本模块不读时钟，边界全由调用方注入。 */
const NOW = 1_800_000_000_000;

const DAY = 24 * 60 * 60 * 1000;

/**
 * 造一个候选，默认值是「可用、在池、无到期额度、余额 100、凭据 1 天后过期」。
 *
 * @param id - 账号 id，也是排序键五的决胜负值。
 * @param overrides - 需要改动的字段。
 */
function candidate(id: string, overrides: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    id,
    inPool: true,
    usable: true,
    credits: 100,
    expiresAtMs: NOW + DAY,
    ...overrides,
  };
}

test('排序键一（可用优先）：不可用账号余额更高 → 仍挑可用的那个', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { usable: false, reason: '冷却中', credits: 9_999 }),
      candidate('acc_0000000000000002', { credits: 1 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('排序键二（快过期先花）：余额少的临期账号 → 排在余额多的长命账号之前', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { credits: 9_000, nearestExpiryMs: NOW + 60 * DAY }),
      candidate('acc_0000000000000002', { credits: 10, nearestExpiryMs: NOW + DAY }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('排序键二（快过期先花）：都临期 → 先到期者先排，即使余额更少', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { credits: 9_000, nearestExpiryMs: NOW + 2 * DAY }),
      candidate('acc_0000000000000002', { credits: 1, nearestExpiryMs: NOW + DAY }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('排序键二边界：到期时间在 3 天窗外 → 不参与临期比较，改按余额', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { credits: 9_000, nearestExpiryMs: NOW + 4 * DAY }),
      candidate('acc_0000000000000002', { credits: 1, nearestExpiryMs: NOW + 3 * DAY + 1 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000001');
});

test('排序键三（积分高）：都不临期、凭据相同 → 余额大的先排', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { credits: 100 }),
      candidate('acc_0000000000000002', { credits: 500 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('排序键三边界：余额读不到（undefined）→ 排在余额 0 之后', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { credits: undefined }),
      candidate('acc_0000000000000002', { credits: 0 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('排序键四（凭据更晚过期）：余额相同 → 凭据新的先排', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { expiresAtMs: NOW + DAY }),
      candidate('acc_0000000000000002', { expiresAtMs: NOW + 10 * DAY }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('排序键五（id 字典序）：其余全平 → 字典序小的先排', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [candidate('acc_0000000000000002'), candidate('acc_0000000000000001')],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000001');
});

test('硬规则一：池关着 → 返回 currentId，即使它不可用', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'acc_0000000000000009',
    candidates: [
      candidate('acc_0000000000000001', { credits: 9_999 }),
      candidate('acc_0000000000000009', { usable: false, reason: 'STS 已过期' }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000009');
  assert.match(choice.reason, /不可用/u);
});

test('硬规则一：池关着且 currentId 已不在本机 → 仍原样返回它', () => {
  const choice = pickAccount({
    poolEnabled: false,
    currentId: 'acc_00000000000000ff',
    candidates: [candidate('acc_0000000000000001')],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_00000000000000ff');
});

test('硬规则一：池关着且没有 currentId → 不挑任何账号', () => {
  const choice = pickAccount({
    poolEnabled: false,
    candidates: [candidate('acc_0000000000000001', { credits: 9_999 })],
    nowMs: NOW,
  });
  assert.equal(choice.id, undefined);
});

test('硬规则二：池开着 → 没勾进池的账号余额再高也不挑', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { inPool: false, credits: 9_999 }),
      candidate('acc_0000000000000002', { inPool: true, credits: 1 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000002');
});

test('硬规则三：inPool 全为 false → 退回 currentId，不退化成全选', () => {
  const choice = pickAccount({
    poolEnabled: true,
    currentId: 'acc_0000000000000001',
    candidates: [
      candidate('acc_0000000000000001', { inPool: false, credits: 9_999 }),
      candidate('acc_0000000000000002', { inPool: false, credits: 100 }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000001');
  assert.match(choice.reason, /勾选/u);
});

test('硬规则三：inPool 全为 false 且没有 currentId → 挑不出账号', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [candidate('acc_0000000000000001', { inPool: false })],
    nowMs: NOW,
  });
  assert.equal(choice.id, undefined);
});

test('硬规则四：勾选的都不可用 → 不挑账号，理由列出各自原因', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { usable: false, reason: '冷却中' }),
      candidate('acc_0000000000000002', { usable: false, reason: '已停用' }),
    ],
    nowMs: NOW,
  });
  assert.equal(choice.id, undefined);
  assert.match(choice.reason, /冷却中/u);
  assert.match(choice.reason, /已停用/u);
});

test('硬规则四：余额读不到 ≠ 不可用 → 唯一候选照样被挑中', () => {
  const choice = pickAccount({
    poolEnabled: true,
    candidates: [candidate('acc_0000000000000001', { credits: undefined, usable: true })],
    nowMs: NOW,
  });
  assert.equal(choice.id, 'acc_0000000000000001');
  assert.match(choice.reason, /余额读不到/u);
});

test('结果稳定：同一输入跑 10 次 → 结果与理由完全一致', () => {
  const candidates = [
    candidate('acc_0000000000000006', { credits: 100 }),
    candidate('acc_0000000000000003', { credits: 100 }),
    candidate('acc_0000000000000001', { credits: undefined }),
    candidate('acc_0000000000000009', { credits: 100 }),
  ];
  const first = pickAccount({ poolEnabled: true, candidates, nowMs: NOW });
  for (let run = 0; run < 10; run += 1) {
    // 每次轮转输入顺序：排序键必须自己给出全序，不能靠数组原序。
    const pivot = run % candidates.length;
    const shuffled: PoolCandidate[] = [
      ...candidates.slice(pivot),
      ...candidates.slice(0, pivot),
    ];
    const next = pickAccount({ poolEnabled: true, candidates: shuffled, nowMs: NOW });
    assert.equal(next.id, first.id);
    assert.equal(next.reason, first.reason);
  }
  assert.equal(first.id, 'acc_0000000000000003');
});

test('failoverCandidates：池关着 → 不换号', () => {
  assert.deepEqual(
    failoverCandidates({
      poolEnabled: false,
      currentId: 'acc_0000000000000001',
      candidates: [candidate('acc_0000000000000001'), candidate('acc_0000000000000002')],
      firstId: 'acc_0000000000000001',
      nowMs: NOW,
    }),
    [],
  );
});

test('failoverCandidates：排除首个与不可用账号 → 按同一套排序给出后续顺序', () => {
  const order = failoverCandidates({
    poolEnabled: true,
    candidates: [
      candidate('acc_0000000000000001', { credits: 900 }),
      candidate('acc_0000000000000002', { credits: 100 }),
      candidate('acc_0000000000000003', { credits: 500 }),
      candidate('acc_0000000000000004', { credits: 9_999, usable: false, reason: '冷却中' }),
      candidate('acc_0000000000000005', { credits: 9_999, inPool: false }),
    ],
    firstId: 'acc_0000000000000001',
    nowMs: NOW,
  });
  assert.deepEqual(order, ['acc_0000000000000003', 'acc_0000000000000002']);
});

test('failoverCandidates：只剩首个时 → 返回空数组', () => {
  const order = failoverCandidates({
    poolEnabled: true,
    candidates: [candidate('acc_0000000000000001')],
    firstId: 'acc_0000000000000001',
    nowMs: NOW,
  });
  assert.deepEqual(order, []);
});
