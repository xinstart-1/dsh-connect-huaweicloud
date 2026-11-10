/**
 * 账号池的挑选与换号顺序。纯函数：不碰磁盘、不发请求、不读时钟。
 *
 * 四条硬规则，每条都对应一个真实会踩到的坑：
 * 1. **池关着 → 永远返回 `currentId`**，哪怕它此刻不可用。手动选号是用户的明确意图，
 *    自动挑不能盖过它；否则用户「这次就用这个号」会变成随机挑号。
 * 2. **池开着 → 只在 `inPool` 的账号里挑**。勾选是资格，不是偏好：没勾的即使余额更多也不碰。
 * 3. **勾选名单为空 → 退回 `currentId`，绝不退化成「全选」**。空名单的语义是「一个都没勾」；
 *    退化成全选会让用户取消全部勾选之后反而把所有账号都放进池子。
 * 4. **不可用的不算候选**，但「读不到余额」（`credits === undefined`）不算不可用：
 *    一次读数失败不该把好账号踢出池子。
 *
 * 五条排序键，依次比较，同一输入永远同一结果：
 * 1. **可用优先**。不可用的账号没有比较价值；选号阶段已经把它们滤掉，这一键保留下来是为了
 *    让排序本身也是全序，不依赖「调用方先滤干净」这个前提。
 * 2. **快过期先花**：3 天内到期的额度先花，都临期时先到期者先排。过期作废的额度是纯损失，
 *    而积分下个周期还能再攒——今天不花它才是真的浪费。
 * 3. **积分高**：都不临期时先花多的，把少的留作缓冲。`undefined` 排在 `0` 之后，因为
 *    读不到余额不等于没额度；当成 0 会让好账号永远垫底。
 * 4. **凭据更晚过期**：前面全平时用新凭据的那个，不容易在请求中途失效。
 * 5. **账号 id 字典序**：收尾键。少了它，前面全平的两个账号谁先谁后取决于输入顺序，
 *    同一份状态两次调用可能挑出不同账号，排查时无法复现。
 *
 * 时间：本模块不读时钟。判断「3 天内到期」需要「现在」，由调用方通过 `nowMs` 注入；
 * 不注入时第 2 键退化为「只要有到期额度就优先、先到期先排」——这个退化只会让更早过期的
 * 额度更早被花掉，不会造成损失，但边界会松一些。
 *
 * @module dsh-connect-huaweicloud/host/pool
 */

import type { PoolCandidate, PoolChoice } from '../types.ts';

/** 「快过期」的时间窗：3 天。额度周期通常按天/月重置，3 天内不花就作废。 */
const EXPIRING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** 未知值排最后的升序比较（用于「到期时间越早越先」）。 */
function compareOptionalAsc(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

/** 未知值排最后的降序比较（用于「积分越多越先」「凭据越新越先」）。 */
function compareOptionalDesc(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

/**
 * 字典序比较。
 *
 * 刻意不用 `localeCompare`：它受 locale 影响，同一份数据在不同机器上可能给出不同序，
 * 而这一键的全部价值就是「可复现」。
 */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 这个候选的额度是否落在「快过期」窗口内。 */
function isExpiringSoon(candidate: PoolCandidate, nowMs: number | undefined): boolean {
  const expiry = candidate.nearestExpiryMs;
  if (expiry === undefined) return false;
  // 没有「现在」可比时，只能认定「有到期额度就先花」。
  if (nowMs === undefined) return true;
  return expiry - nowMs <= EXPIRING_WINDOW_MS;
}

/** 按五条排序键比较两个候选；返回负数表示 `left` 排在前面。 */
function compareCandidates(
  left: PoolCandidate,
  right: PoolCandidate,
  nowMs: number | undefined,
): number {
  if (left.usable !== right.usable) return left.usable ? -1 : 1;

  const leftSoon = isExpiringSoon(left, nowMs);
  const rightSoon = isExpiringSoon(right, nowMs);
  if (leftSoon !== rightSoon) return leftSoon ? -1 : 1;
  if (leftSoon && rightSoon) {
    const delta = compareOptionalAsc(left.nearestExpiryMs, right.nearestExpiryMs);
    if (delta !== 0) return delta;
  }

  const creditDelta = compareOptionalDesc(left.credits, right.credits);
  if (creditDelta !== 0) return creditDelta;

  const expiryDelta = compareOptionalDesc(left.expiresAtMs, right.expiresAtMs);
  if (expiryDelta !== 0) return expiryDelta;

  return compareIds(left.id, right.id);
}

/** 排序副本；不改动输入，调用方可以复用同一份候选快照。 */
function rank(candidates: readonly PoolCandidate[], nowMs: number | undefined): PoolCandidate[] {
  return [...candidates].sort((left, right) => compareCandidates(left, right, nowMs));
}

/** 不可用账号的原因清单，拼进「一个都挑不出来」的 reason 里。 */
function describeUnusable(members: readonly PoolCandidate[]): string {
  const parts = members.map((member) => `${member.id}（${member.reason ?? '不可用'}）`);
  return parts.join('、');
}

/** 挑中之后的理由：说清凭什么赢，日志与卡片直接用这句。 */
function reasonForChoice(best: PoolCandidate, poolSize: number, nowMs: number | undefined): string {
  const facts: string[] = [];
  if (isExpiringSoon(best, nowMs)) facts.push('有 3 天内到期的额度，先花掉');
  if (best.credits === undefined) {
    facts.push('余额读不到，未参与比较');
  } else {
    facts.push(`余额 ${String(best.credits)}`);
  }
  return `池内 ${String(poolSize)} 个可用账号排序第一：${facts.join('；')}`;
}

/**
 * 「用手动选定的账号」这一条路的统一答复。
 *
 * 池关着、以及勾选名单为空，都走这里：两者都要求「原样返回 `currentId`」，差别只在
 * reason 怎么解释。它**不看可用性**——手动选号是明确意图，不可用也照样返回。
 *
 * @param candidates - 池候选快照，只用来补一句现状说明。
 * @param currentId - 手动选定的账号 id。
 * @param context - 为什么走到这条路（中文，直接进 reason）。
 */
function manualChoice(
  candidates: readonly PoolCandidate[],
  currentId: string | undefined,
  context: string,
): PoolChoice {
  if (currentId === undefined) {
    return { id: undefined, reason: `${context}，也没有手动选定的账号` };
  }
  const current = candidates.find((candidate) => candidate.id === currentId);
  if (current === undefined) {
    return {
      id: currentId,
      reason: `${context}：仍按手动选择使用该账号（本机已找不到它的记录）`,
    };
  }
  if (!current.usable) {
    return {
      id: currentId,
      reason: `${context}：仍按手动选择使用该账号，尽管它此刻不可用（${
        current.reason ?? '原因未知'
      }）`,
    };
  }
  return { id: currentId, reason: `${context}：使用手动选定的账号` };
}

/**
 * 从池里挑一个账号。
 *
 * @param input.poolEnabled - 账号池总开关。关着时只认 `currentId`。
 * @param input.currentId - 用户手动选定的账号 id；可能已从本机删除，也可能不可用。
 * @param input.candidates - 全部账号的候选快照（顺序不影响结果）。
 * @param input.nowMs - 注入的「现在」，只用于判断「3 天内到期」；不传则退化为「有到期额度即优先」。
 *   `pool.ts` 不读时钟，所以这个值必须由调用方给。
 * @returns 选中的账号 id（`undefined` 表示一个都挑不出来）与一句中文理由，供日志与界面显示。
 */
export function pickAccount(input: {
  poolEnabled: boolean;
  currentId?: string;
  candidates: readonly PoolCandidate[];
  nowMs?: number;
}): PoolChoice {
  const { candidates, currentId, poolEnabled } = input;

  if (!poolEnabled) return manualChoice(candidates, currentId, '账号池未启用');

  const members = candidates.filter((candidate) => candidate.inPool);
  if (members.length === 0) {
    // 空勾选名单不等于「全选」：这里只退回手动选定，绝不把没勾的账号放进来。
    return manualChoice(candidates, currentId, '账号池已启用，但没有任何账号被勾选进池');
  }

  const usable = members.filter((candidate) => candidate.usable);
  if (usable.length === 0) {
    // 有勾选但都不可用：如实报「没有可用账号」，不拿一个坏号去撞 401。
    return {
      id: undefined,
      reason: `勾选进池的 ${String(members.length)} 个账号此刻都不可用：${describeUnusable(members)}`,
    };
  }

  const best = rank(usable, input.nowMs)[0];
  if (best === undefined) return { id: undefined, reason: '账号池里没有可用账号' };
  return { id: best.id, reason: reasonForChoice(best, usable.length, input.nowMs) };
}

/**
 * 换号重试时的后续尝试顺序。
 *
 * 首个账号由 {@link pickAccount} 决定，这里只回答「第一个不行之后该试谁」；因此用同一套
 * 排序键，并剔除 `firstId` 自己（重试同一个号只会再撞一次同一个错误）。
 *
 * @param input.poolEnabled - 池关着时不存在换号：手动选定的号失败了就该报错给用户。
 * @param input.currentId - 与 {@link pickAccount} 共用同一份池状态；换号本身不用它。
 * @param input.candidates - 全部账号的候选快照。
 * @param input.firstId - 已经试过的首个账号 id。
 * @param input.nowMs - 注入的「现在」，语义同 {@link pickAccount}。
 * @returns 依次尝试的账号 id 列表，不含 `firstId`；池关着或没号时为空数组。
 */
export function failoverCandidates(input: {
  poolEnabled: boolean;
  currentId?: string;
  candidates: readonly PoolCandidate[];
  firstId: string;
  nowMs?: number;
}): readonly string[] {
  if (!input.poolEnabled) return [];
  const usable = input.candidates.filter((candidate) => candidate.inPool && candidate.usable);
  return rank(usable, input.nowMs)
    .map((candidate) => candidate.id)
    .filter((id) => id !== input.firstId);
}
