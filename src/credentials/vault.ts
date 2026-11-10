/**
 * 凭据仓库：一账号一文件，凭据只落这里。
 *
 * 为什么不用 DSH 的 settings：这些是「点一下立即生效」的账号数据，不是配置；
 * 走 settings 意味着每次同步都要过一遍改配置→重载插件。
 *
 * 为什么要落盘副本：读本机客户端要走 PowerShell（约 400 ms/次）与分块拼接，
 * 而卡片会轮询状态。副本让轮询退化成一次文件读，只有「同步」这类显式动作才回上游。
 *
 * 三条不变量：
 * 1. 文件名由**身份**派生，同一账号反复同步只会覆盖同一条，不会长出一堆重复行。
 * 2. 写盘走「临时文件 + rename」；读到坏 JSON 视为不存在（一条坏记录不该带崩插件）。
 * 3. STS 续期必须单飞 —— refresh_token 一次性，两个并发续期会把账号弄坏。见 `auth/refresh.ts`。
 *
 * @module dsh-connect-huaweicloud/credentials/vault
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { huaweicloudHome } from '../paths.ts';
import { VAULT_DIRNAME } from '../constants.ts';
import type { StoredAccount } from '../types.ts';

/** 仓库根目录：`$DSH_HOME/officeace-vault`。 */
export function vaultRoot(home?: string): string {
  const base = home ?? huaweicloudHome();
  return join(base, VAULT_DIRNAME);
}

/**
 * 由账号身份派生稳定 id。
 *
 * @param accountKey - 身份串（优先 userId，其次 userName）。
 * @returns `acc_` 加 SHA-256 前 16 位十六进制；同一身份永远同一结果。
 */
export function accountIdFor(accountKey: string): string {
  return 'acc_' + createHash('sha256').update(accountKey).digest('hex').slice(0, 16);
}

/** 一个账号文件在磁盘上的形状。 */
interface AccountFile {
  schemaVersion: 1;
  account: StoredAccount;
}

/** 账号仓库。 */
export interface Vault {
  /** 列出全部账号，按保存时间升序。坏记录被跳过。 */
  list(): Promise<StoredAccount[]>;
  /** 按 id 取一条；不存在或坏记录返回 `undefined`。 */
  get(id: string): Promise<StoredAccount | undefined>;
  /** 写入（覆盖同 id 的记录）。 */
  save(account: StoredAccount): Promise<void>;
  /** 删除；记录本来就不存在时返回 `false`。 */
  remove(id: string): Promise<boolean>;
  /** 读「手动选定」的账号 id。 */
  readSelected(): Promise<string | undefined>;
  /** 写「手动选定」；传 `undefined` 表示清除。 */
  writeSelected(id: string | undefined): Promise<void>;
}

/** 选中记录的旁路文件名（不是账号，别当账号读）。 */
const SELECTED_FILENAME = '_selected.json';

/** 只接受 `acc_[0-9a-f]{16}`；其它一律拒绝，避免拼出路径穿越。 */
const SAFE_ID = /^acc_[0-9a-f]{16}$/;

/**
 * 创建仓库句柄。
 *
 * @param options.home - 覆盖 `$DSH_HOME`（测试用）。
 * @returns 仓库接口；目录在第一次写入时才创建。
 */
export function createVault(options: { home?: string } = {}): Vault {
  const root = vaultRoot(options.home);
  let ensured: Promise<void> | undefined;

  const ensure = async (): Promise<void> => {
    ensured ??= mkdir(root, { recursive: true, mode: 0o700 }).then(() => undefined);
    await ensured;
  };

  const fileOf = (id: string): string => join(root, id + '.json');

  const readAccount = async (id: string): Promise<StoredAccount | undefined> => {
    if (!SAFE_ID.test(id)) return undefined;
    let text: string;
    try {
      text = await readFile(fileOf(id), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as Partial<AccountFile>;
      const account = parsed.account;
      if (account === undefined || account.id !== id) return undefined;
      return account;
    } catch {
      // 半个 JSON 会让用户以为账号全丢了，所以按「这条不存在」处理，其余照常。
      return undefined;
    }
  };

  return {
    async list() {
      await ensure();
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return [];
      }
      const accounts: StoredAccount[] = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name === SELECTED_FILENAME) continue;
        const account = await readAccount(name.slice(0, -'.json'.length));
        if (account !== undefined) accounts.push(account);
      }
      accounts.sort((left, right) => left.savedAtMs - right.savedAtMs);
      return accounts;
    },

    get: readAccount,

    async save(account) {
      await ensure();
      const document: AccountFile = { schemaVersion: 1, account };
      // 独立临时文件 + rename：并发保存两条不同账号时不会互相截断。
      const temp = join(root, '.tmp-' + randomUUID());
      await writeFile(temp, JSON.stringify(document, null, 2), { mode: 0o600 });
      await rename(temp, fileOf(account.id));
    },

    async remove(id) {
      if (!SAFE_ID.test(id)) return false;
      try {
        await unlink(fileOf(id));
        return true;
      } catch {
        return false;
      }
    },

    async readSelected() {
      await ensure();
      try {
        const parsed = JSON.parse(await readFile(join(root, SELECTED_FILENAME), 'utf8')) as {
          selectedId?: unknown;
        };
        const id = parsed.selectedId;
        return typeof id === 'string' && SAFE_ID.test(id) ? id : undefined;
      } catch {
        return undefined;
      }
    },

    async writeSelected(id) {
      await ensure();
      const target = join(root, SELECTED_FILENAME);
      if (id === undefined) {
        await unlink(target).catch(() => undefined);
        return;
      }
      const temp = join(root, '.tmp-' + randomUUID());
      await writeFile(temp, JSON.stringify({ selectedId: id }), { mode: 0o600 });
      await rename(temp, target);
    },
  };
}
