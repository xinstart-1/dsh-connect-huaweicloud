/**
 * 插件自己的状态文件：界面开关与池成员，不写 settings。
 *
 * 为什么不用 DSH 的 settings：这些是「点一下立即生效、不经过保存」的开关。写进
 * settings 意味着每次改都要过一遍「改配置 → 重载插件」。所以它们落在一个自己的
 * JSON 文件里，读写都只碰它。
 *
 * 位置：`$DSH_HOME/.huaweicloud-connect/dsh-connect-huaweicloud-state.json`；
 * 写盘走「临时文件 + rename」；读到坏 JSON 会被当成默认值。
 *
 * @module dsh-connect-huaweicloud/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_FILENAME } from './constants.ts';
import { huaweicloudHome } from './paths.ts';

/** 状态刷新间隔的五档（1 / 5 / 10 / 30 / 60 分钟）。 */
export const POLL_INTERVAL_CHOICES: readonly number[] = Object.freeze([
  60_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
]);

/** 插件状态。 */
export interface PluginState {
  schemaVersion: 1;
  /**
   * 账号池总开关：开着时由池挑账号并在失败时换号。**默认关**（会改变哪份额度被消耗）。
   */
  accountPoolEnabled: boolean;
  /**
   * 参与池的账号 id。
   *
   * 与 `accountPoolEnabled` 分工明确：那个开关管「要不要自动挑」，这张名单管
   * 「哪些账号有资格被挑中」。空数组合法的含义是「一个都没勾」，不是「全都勾」——
   * 后者会让用户取消全部之后反而全被启用。
   */
  enabledAccounts: string[];
  /**
   * 手动选定的账号 id。
   *
   * 池关着时它决定「用谁」；池开着时它只是「没有可用账号时的兜底」，不参与排序。
   */
  selectedId?: string;
  /** 状态刷新间隔；只能是 {@link POLL_INTERVAL_CHOICES} 之一。 */
  pollIntervalMs: number;
  /** 卡片是否显示额度读数。 */
  showQuota: boolean;
}

/** 缺省状态。 */
export const DEFAULT_STATE: PluginState = Object.freeze({
  schemaVersion: 1,
  accountPoolEnabled: false,
  enabledAccounts: [],
  pollIntervalMs: 300_000,
  showQuota: true,
});

/** 状态文件路径。 */
export function statePath(home?: string): string {
  return join(home ?? huaweicloudHome(), STATE_FILENAME);
}

/** 把任意值收敛成合法状态；未知字段被丢弃。 */
function normalize(raw: unknown): PluginState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_STATE };
  const record = raw as Record<string, unknown>;
  const members = Array.isArray(record['enabledAccounts'])
    ? record['enabledAccounts'].filter((id): id is string => typeof id === 'string')
    : [];
  const poll = record['pollIntervalMs'];
  const selectedId = record['selectedId'];
  return {
    schemaVersion: 1,
    accountPoolEnabled: record['accountPoolEnabled'] === true,
    enabledAccounts: [...new Set(members)],
    ...(typeof selectedId === 'string' && selectedId !== '' ? { selectedId } : {}),
    pollIntervalMs:
      typeof poll === 'number' && POLL_INTERVAL_CHOICES.includes(poll) ? poll : DEFAULT_STATE.pollIntervalMs,
    showQuota: record['showQuota'] !== false,
  };
}

/**
 * 读状态；文件不存在或坏 JSON 都返回默认值。
 *
 * @param options.home - 覆盖插件目录（测试用）。
 */
export async function readState(options: { home?: string } = {}): Promise<PluginState> {
  try {
    return normalize(JSON.parse(await readFile(statePath(options.home), 'utf8')));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * 写状态：与现状态合并后落盘，返回合并结果。
 *
 * @param patch - 要改的字段；只写这些，其余保持当前值。
 * @param options.home - 覆盖插件目录（测试用）。
 */
export async function writeState(
  patch: Partial<PluginState>,
  options: { home?: string } = {},
): Promise<PluginState> {
  const current = await readState(options);
  const next = normalize({ ...current, ...patch });
  const home = options.home ?? huaweicloudHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  const target = statePath(home);
  const temp = target + '.tmp';
  await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(temp, target);
  return next;
}
