# DSH Connect 果办 OfficeAce

把**华为云果办 OfficeAce** 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：
**有客户端就自动读它的登录态**，**没有就在浏览器里登录一次**；多个账号进一张**账号池**，
可勾选、可切换、失败自动换号。

> 非官方插件，与华为云、果办 OfficeAce 无任何关联。只复用**你自己账号**的登录态，
> 不提供账号、不共享凭据、不绕过计费；每次调用消耗的是你自己的额度。

---

## 为什么再做一次

生态里已有三个果办方向的实现，各缺一半（取证见 [`docs/ECOSYSTEM.md`](docs/ECOSYSTEM.md)）：

| 能力 | `dsh-huawei-connect` | `dsh-huaweicloud-connect` | `officeace-auth` | **本插件** |
| --- | --- | --- | --- | --- |
| 有客户端 → 自动收号 | ✅ | ✅（唯一路径） | ✅ | ✅ |
| 无客户端 → 浏览器登录 | ✅ | ❌ | ✅ | ✅ |
| 两类来源进**同一张**池 | ✅ | —（单账号） | 部分 | ✅ |
| 池显式勾选 / 失败换号 | ✅ 默认关 | ❌ | 部分 | ✅ 默认关 |
| DSH 原生（双面插件） | ✅ | ✅ | ❌ magpie | ✅ |

本插件补齐的那一格是：**「读客户端」与「浏览器登录」作为账号池里的两类成员并存**，
同一个仓库、同一套排序、同一个换号路径。

---

## 安装

```sh
# npm
dsh plugin --profile desktop add dsh-connect-huaweicloud

# 本地目录（开发用）
dsh plugin --profile desktop add link:X:/Agent/deepseek插件/dsh-connect-huaweicloud
```

装完**完全退出 DSH（含托盘）再启动**，然后进「设置 → 果办 OfficeAce」。

---

## 使用

### 有客户端：自动收号

1. 在果办客户端里登录一次。
2. 设置页点「**同步本机客户端**」。
3. 账号出现在表格里，默认已勾进池。

插件从两个入口读，谁先读到可用的就用谁：

| 入口 | 位置 | 认证形态 |
| --- | --- | --- |
| Windows 凭据管理器 | `OfficeAce/auth-sessions/huawei-oauth/<userDir>/provider-state`（分块存储） | OAuth + 模型网关 appKey/appSecret |
| 路由状态文件 | `~/.office-claw/.jiuwenclaw/config/routing_state/users/<userId>/models.json` | APIG「APP 认证」`Basic base64(appKey:appSecret)` |

**全程只读**：不写、不删、不改客户端的任何文件与凭据。

### 没有客户端：浏览器登录

点「**登录添加账号**」→ 浏览器打开华为云授权页 → 登录完成 → 自动落库。

登录走两条回调路线，自动选：

1. **云端取码（首选）**：`POST /v1/claw/auth/state` 登记 → 浏览器授权 → 轮询 `/v1/claw/auth/code` 取回授权码。**不需要本机端口**，不受防火墙影响。
2. **本机回环（回落）**：state 登记失败时，在 `127.0.0.1` 随机端口接住 `?code=`。

两条都是 PKCE + **DPoP**（RFC 9449）。**DPoP 私钥与 refresh_token 一起保存**——
refresh_token 签发时就和那把公钥绑定，私钥丢了只能重新登录。

登录完成后插件会自动补一次「接入模型」（`POST /v1/claw/client-subscription`），
所以**不需要打开客户端点「接入模型」**也能直接对话。

### 账号池

- **默认关**。关着时只用你手动选定的那个账号，失败如实报错。
- 打开后**每次请求**发给池里排序最靠前的可用账号；失败**依次**换下一个，全失败才报错。
- **勾选才是同意**：没勾的账号即使额度更多也不会被使用。空勾选名单的语义是「一个都没勾」，
  不会退化成「全选」。

排序键（依次比较，可复现）：

1. 可用优先
2. **快过期先花**（3 天内到期的先花——过期作废的额度是纯损失）
3. 积分高（读不到余额排在 0 之后：读不到 ≠ 没额度）
4. 凭据更晚过期
5. 账号 id（收尾，保证全序）

失败分级处置：

| 失败 | 处置 | 理由 |
| --- | --- | --- |
| 认证失败 401/403 | 停用 1 小时 | 只能重新登录，重试无意义 |
| 额度耗尽 402 | 冷却 30 分钟 | 额度周期会重置，不该永久踢出 |
| 上游 5xx / 网络 | 冷却 30 秒 | 通常是暂时的 |
| 限流 429 | 冷却 15 秒 | 按分钟窗口重置 |
| 请求本身不合法 400 | **不换号** | 换谁都一样 400 |
| 模型不存在 / 无权限 | **不惩罚账号** | 一个坏模型名不该把好号踢出池 |

**流已经开始后断开绝不重试**——字节已发出，重放会让客户端看到两段拼接的回答。

---

## 请求体钳制（发请求之前，不是之后）

果办网关的这几类拒绝发生在**流内**（HTTP 已经 200），此时无法重放，那一轮直接废掉。
所以必须在发送**之前**治好：

| 触发条件 | 上游反应 | 处理 |
| --- | --- | --- |
| `max_tokens` > 131072 | 流内 `ModelArts.81001` | 钳到 131072 |
| 消息里出现 `role: "developer"` | `InferHub.001001044.400` | 改写成 `system` |
| 把图片发给纯文本模型 | `81001 unsupported content type` | 换成文字占位 |

**不做的伪装**：不改写你的提示词。workbuddy 那套「插零宽空格 / 换中性头」是针对
**那个上游的具体缺陷**的补丁，果办不做渠道指纹拦截——照搬只会无声篡改你的提示词。

---

## 数据落在哪

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 账号凭据 | `$DSH_HOME/officeace-vault/<accountId>.json` | 一账号一文件，0600 |
| 手动选定 | `$DSH_HOME/officeace-vault/_selected.json` | 池关着时用它 |
| 界面开关 | `$DSH_HOME/.huaweicloud-connect/dsh-connect-huaweicloud-state.json` | 不走 settings，点了立即生效 |

**不写客户端**（除非显式打开 `writeBackDesktop`）。卸载插件不会影响客户端登录。

---

## 配置

设置页「插件」里的配置项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册模型（设置页仍可访问，它是登录入口） |
| `reuseDesktop` | `true` | 是否自动读本机客户端 |
| `writeBackDesktop` | **`false`** | 是否把刷新后的凭据写回客户端。写坏就是把用户的客户端弄坏 |
| `warmOnStart` | `true` | 启动后预热一次（读凭据 + 拉目录） |
| `maxFailoverAttempts` | `3` | 单次请求最多试几个账号 |

---

## 已知限制

- **Windows 专属能力**：读客户端登录态依赖 Windows 凭据管理器与 DPAPI。其它平台只能走浏览器登录。
- **额度读数需要客户端在跑**：积分是客户端本机控制面（`:3004` / `:3003`，自签证书）的事实；
  没有客户端时界面**不显示**额度（不是显示 0）。
- **`import` 来的账号不能续期**：本插件拿不到客户端那把 DPoP 私钥。过期后需要重新同步或改用浏览器登录。
- **本机未验证**：开发机上没装果办客户端，所以「读客户端」这条路径的代码结论来自
  参考实现与文档，**没有端到端跑过**。装客户端后请先点一次「同步本机客户端」验证。

---

## 开发

```sh
node scripts/gate.mjs      # 一条命令跑完全部校验
```

门禁包含：版本一致性 → typecheck → 构建 → 拷浏览器半边 → 浏览器半边自检 →
宿主装载自检 → 打包清单检查 → 全部测试。

### 源码地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：装配顺序、生命周期、LLM 注册 |
| `src/constants.ts` | 全部远端地址、路径与时间常量的**唯一**定义处 |
| `src/types.ts` | 全插件共享类型的唯一归属地（改它 = 改模块间契约） |
| `src/paths.ts` | `$DSH_HOME` 与果办客户端目录的判定 |
| `src/config.ts` | 配置 schema 与默认值 |
| `src/state.ts` | 界面开关与池成员（不走 settings） |
| `src/credentials/wincred.ts` | Windows 凭据管理器分块读取 |
| `src/credentials/dpapi.ts` | DPAPI 解密本机会话 cookie |
| `src/credentials/probe.ts` | 桌面端探测（两个入口合并） |
| `src/credentials/vault.ts` | 账号仓库（一账号一文件） |
| `src/auth/dpop.ts` | DPoP proof（含低 S 归一化） |
| `src/auth/sign.ts` | 华为云 SDK-HMAC-SHA256 签名 |
| `src/auth/oauth.ts` | 浏览器登录双路线 + STS 续期 |
| `src/auth/subscription.ts` | 权限校验 + 补「接入模型」 |
| `src/protocol/client.ts` | 模型网关 client + 请求体钳制 |
| `src/protocol/errors.ts` | 失败分类（池据此决定换不换号） |
| `src/shim/server.ts` | 回环 shim：换号发生在第一个字节之前 |
| `src/llm/adapter.ts` | 把 shim 包成 pi-ai provider |
| `src/host/pool.ts` | 池挑选纯函数（四条硬规则 + 五条排序键） |
| `src/host/accounts.ts` | 账号生命周期（单飞续期、冷却、同步） |
| `src/host/login.ts` | 登录相位状态机 |
| `src/host/quota.ts` | 本机控制面额度读数 |
| `src/host/runtime.ts` | 状态与动作的编排层 |
| `src/host/status.ts` | 状态快照（不含令牌） |
| `src/host/routes.ts` | 两条宿主路由（回环校验 + 动作白名单） |
| `src/client/bundle.js` | 浏览器半边（手写经典脚本，**不进打包器**） |

模块契约见 [`docs/CONTRACT.md`](docs/CONTRACT.md)，生态取证见 [`docs/ECOSYSTEM.md`](docs/ECOSYSTEM.md)。

`reference/` 是调研用的第三方源码副本，**不进发布包**（`scripts/check-pack.mjs` 会拦住）。
