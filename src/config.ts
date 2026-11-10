/**
 * 插件运行时配置。
 *
 * 默认值只写在 schema 里，`apply` 内不再兜底。未知字段一律拒绝：拼错的键静默失效
 * 比报错更难查。
 *
 * @module dsh-connect-huaweicloud/config
 */

import z from '@deepseek-ai/schemastery';

/** 运行时配置。 */
export const Config = z.object({
  /** 总开关；关掉后不注册任何模型，设置页仍可访问（它是登录入口）。 */
  enabled: z.boolean().default(true),

  /**
   * 是否自动读取本机果办客户端的登录态。
   *
   * 默认开：这正是「有客户端就不用登录」的那条路。关掉用于「我只想用自己登录的号」。
   */
  reuseDesktop: z.boolean().default(true),

  /**
   * 是否把自己刷新得到的凭据写回客户端。
   *
   * 默认**关**。写回能让客户端不掉登录，但一旦写坏就是把用户的客户端弄坏；
   * 只在明确需要时打开。
   */
  writeBackDesktop: z.boolean().default(false),

  /** 启动后预热一次（读凭据 + 拉目录）。关掉用于排查启动问题。 */
  warmOnStart: z.boolean().default(true),

  /**
   * 单次请求最多尝试几个账号。
   *
   * 换成第 3 个还失败就不再试：继续试只是让用户多等几轮看到同一个错误。
   */
  maxFailoverAttempts: z.number().min(1).max(5).default(3),
});

/** 已解析的配置类型。 */
export interface HuaweiCloudConfig {
  enabled: boolean;
  reuseDesktop: boolean;
  writeBackDesktop: boolean;
  warmOnStart: boolean;
  maxFailoverAttempts: number;
}

/** 缺省值：直接跑 schema 得到，不手写第二份。 */
export const DEFAULT_CONFIG: HuaweiCloudConfig = Config({}) as HuaweiCloudConfig;
