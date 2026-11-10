# 生态调研：果办 OfficeAce 方向的现成插件 + 可借鉴资产

> 调研时间：2026-11-10 11:24–11:40（+08:00）
> 取证方式：npm registry 元数据 + 各包 tarball 解包阅读源码；本机实测客户端足迹。
> 纪律：能力一律以**读到的源码**为准；本机无法验证的写「待验证」并注明原因。

---

## 0. 三句话结论

1. **有 3 个现成实现**，其中 `dsh-huawei-connect@1.3.4` 已经同时具备你要的两件事：
   **有客户端自动收号 + 没有客户端用浏览器 IAM 登录**，而且**两个来源进同一张池**。
2. 另外两个各缺一半：`dsh-huaweicloud-connect` **只能复用客户端**（单账号）；`officeace-auth`
   **登录与池都完整但它是 magpie 插件，不是 DSH 插件**。
3. 要自研的话，最省事的组合是：**池语义抄 workbuddy、池代码抄本机 raccoon、
   华为云 OAuth/DPoP/WinCred/DPAPI 四段抄 huawei-connect、登录即得模型 key 抄 officeace-auth**。

---

## 1. 三个现成实现（逐个档案）

### 1.1 `dsh-huawei-connect@1.3.4` —— 最贴近本需求

- 仓库 <https://github.com/wang111928/dsh-huawei-connect> · npm 2026-10-30 · 近 30 天下载 **566**
- 发布物：`lib/` 18 个 `.mjs` 单文件模块（`index/pool/store/shim/oauth/dpop/wincred/session/disguise/gate/sign`）+ `lib/client/index.js` 设置卡
- 内核：`engines.dsh >=0.1.7-rc.1 <0.3.0-0`

| 你的需求 | 它的实现 | 取证位置 |
| --- | --- | --- |
| 有客户端自动获取账户 | 启动即 `void sync()`；码道读 `$DSH_HOME/.codearts-accounts.json`，果办读 **Windows 凭据管理器** `OfficeAce/auth-sessions/huawei-oauth/<domainId>%3A<userId>/provider-state`，账号枚举靠 `~/.office-claw/users/` 目录名 | `index.mjs:846`、`store.mjs:270-316` |
| 多个客户端账号 | ✅ 枚举 `users/` 下每个目录 → 每个 `provider-state` 一条 | `store.mjs:270-292` |
| 没有客户端网页登录 | ✅ 自带浏览器登录：PKCE + **DPoP** + 本机回环回调，果办 `client_id = pdp5_for_agentarts`，授权页套 `authui/login.html?service=<oauth2/authorize>?…` | `oauth.mjs:38-112`、`index.mjs:932-999` |
| 账户池 | ✅ 每平台一个 `AccountPool`：停用/冷却分级、按「最少使用」轮转、单飞续期、失败换号（最多试 3 个） | `pool.mjs:57-232`、`shim.mjs:294-350` |
| 池默认状态 | **默认关**（单账号），按钮显式打开；关了仍有「同步登录态/测试」 | `index.mjs:287`、`CHANGELOG:96-106` |
| 登录完能直接对话 | ✅ 登录后调 `POST /v1/claw/client-subscription` 补 `model_info`，拿 `model_app_key/secret` | `index.mjs:463-488` |

**它的短板**：CodeArts 侧要 CLI 授权（AK/SK）才好用；果办侧 `provider-state` 的分块解密要起 PowerShell（约 400 ms/次，靠 `accounts.json` 副本吸收）。
**本机未验证**：本机没装果办客户端（见 §3），凭据路径与块拼接**只读到代码，没有实跑**。

### 1.2 `dsh-huaweicloud-connect@0.8.5` —— 只能复用客户端，单账号

- 仓库 <https://github.com/Alanine-gH/dsh-huaweicloud-connect> · npm 2026-11-06 · 近 30 天下载 **2056**
- 结构：`lib/{credentials,shim,apig-sign,drivers/{officeace,codearts}}.js`

**果办凭据入口和上面那个完全不同**：读
`~/.office-claw/.jiuwenclaw/config/routing_state/users/<userId>/models.json`，
取 `defaults[]` 里第一条同时带 `api_base` 与 `Authorization: Basic base64(app_key:app_secret)` 的配置
（`drivers/officeace.js:28-70`）。这是 **APIG APP 认证**，不是 OAuth。

- 支持多目录枚举，但 `locate()` 命中第一个可读的就返回 → **实际单账号**（`credentials.js:200-216`）
- **没有网页登录**，README 明确「复用客户端登录态，不做额外 OAuth」
- 值得抄的是：`CredentialErrorCode` 闭集错误码 + 「存在但读不了**不许**静默回落旧副本」这条不变量

### 1.3 `officeace-auth@0.2.5` —— 登录最完整，但不是 DSH 插件

- 仓库 <https://github.com/MYCF711/magpie-officeace> · npm 2026-10-31 · 近 30 天下载 **7870**（三个里最高）
- 是 **magpie** 的 provider 插件，`src/` 22 个 `.mjs` + `tests/` 一整套

| 资产 | 为什么值得抄 | 位置 |
| --- | --- | --- |
| **纯 HTTP 驱动的浏览器登录**（不装客户端） | `POST {CLAW}/v1/claw/auth/state` 登记 → 开授权页 → `GET {CLAW}/v1/claw/auth/code?state=` 轮询拿码 → 换 STS | `src/login.mjs:1-40` |
| **登录即得模型 key** | 调 `client-subscription`（V11 签名，正是客户端「接入模型」按钮背后的那一步）补 `modelAppKey`；真机实测 3 个账号都拿到 | `src/maas.mjs:87-150` |
| **客户端登录态复用** | `~/.office-claw/session.cookie`（`OC-DPAPI-1` + DPAPI 密文 → `oc_sid` cookie）打本机控制面 `GET /api/islogin` 认账号 | `src/officeace-client.mjs` |
| **自动领体验版 / 每日签到** | 幂等判断 + 每账号每进程只试一次 | `src/auto-maintenance.mjs` |

**它的短板**：magpie 不是 DSH；登录态存在 magpie 的 `plugin-auth.json`，语义与 DSH 插件不通用。

---

## 2. 对照表：谁的哪一格是空的

| 能力 | huawei-connect | huaweicloud-connect | officeace-auth | **你的需求** |
| --- | --- | --- | --- | --- |
| 有客户端 → 自动收号 | ✅ | ✅（唯一路径） | ✅ | **必需** |
| 无客户端 → 网页/浏览器登录 | ✅ 华为云 IAM OAuth | ❌ | ✅ CLAW auth/state | **必需** |
| 两类来源进**同一张**池 | ✅ | —（单账号） | 部分（magpie 侧） | **必需** |
| 账号池（勾选/冷却/换号） | ✅ 默认关 | ❌ | 部分 | **必需** |
| DSH 原生插件 | ✅ | ✅ | ❌ | 必需 |
| 多账号并存 | ✅ | ❌ | ✅ | 必需 |

**结论：`dsh-huawei-connect` 已经是这个需求的成品**，不缺格。要自研的理由只可能是：
想要 workbuddy 那套更完整的池契约（显式勾选、快过期先花、按账号导出导入、测试回池），
或者不想要它 1.1k 行单文件 `index.mjs` 的耦合。

---

## 3. 本机实测（2026-11-10 11:36）

```
~/.office-claw/                                  MISSING
~/.office-claw/session.cookie                    MISSING
~/.office-claw/users/                            MISSING
~/.office-claw/.jiuwenclaw/config/routing_state/users/  MISSING
Get-Process | ? ProcessName -match 'office|claw|ace'   空
cmdkey /list | ? OfficeAce                      0 条
```

**推论**：本机**没装果办客户端**。所以「有客户端自动取号」这条路在本机**无法端到端验证**——
只能照源码抄，装客户端后必须自己复跑一次。上面 §1.1/§1.2 的路径结论标注为**待验证**。

---

## 4. 借鉴清单（自研时按这个顺序抄）

### 4.1 骨架：抄本机 `dsh-connect-raccoon`

同一套需求（有客户端读客户端 / 没有就网页登录 / 多账号进池）已经在本机写成 TS，
按目录拆得最干净，直接当目录模板：

| 层 | raccoon 位置 | 说明 |
| --- | --- | --- |
| 凭据探测 | `src/credentials/desktop.ts` | `DesktopProbe` 带 `multiAccount` / `reason` 闭集，探不到能给出可执行建议 |
| 凭据仓库 | `src/credentials/vault.ts` | 一账号一文件、`accountKey`→`acc_<hash16>` 派生文件名、坏记录当不存在 |
| 单飞续期 | `src/credentials/refresh.ts` + `host/accounts.ts` | refresh 一次性，必须按账号加锁 |
| 登录状态机 | `src/host/login.ts` | 六相位、`state` 逐字比对、只收一次回调 |
| 池挑选 | `src/host/pool.ts` | 纯函数，排序键「可用→快过期先花→积分高→凭据新」 |
| 路由 | `src/host/routes.ts` | 回环 Host 校验 + 动作白名单 + 64 KiB 上限 |

### 4.2 华为云专有四段：抄 `dsh-huawei-connect`

| 要抄的 | 文件 | 关键事实 |
| --- | --- | --- |
| OAuth + PKCE + DPoP | `lib/oauth.mjs`、`lib/dpop.mjs` | 果办 `client_id=pdp5_for_agentarts`；DPoP 私钥**必须与 refresh_token 一起存**，丢了只能重登 |
| WinCred 分块读 | `lib/wincred.mjs` | `office-claw` 把 `provider-state` 拆成 `…/chunks/<storageId>/<n>`，**先拼文本再 base64 解一次**；PowerShell 走 `-EncodedCommand` 免引号问题 |
| DPAPI 会话 cookie | `lib/session.mjs` | `OC-DPAPI-1` 标记 + `CryptUnprotectData`；请求本机 API 时 cookie 名是 **`oc_sid`**（写错一律 401） |
| 池实现 | `lib/pool.mjs` | 分级处置：认证失败停 1 h / 积分耗尽冷 30 min / 并发撞墙**不惩罚** / 模型不存在不惩罚 |

### 4.3 池的语义规格：抄 workbuddy 的 README

`dsh-connect-workbuddy` README「账号池」一节把 10 条契约写成了可直接判定的规则
（显式勾选默认空、开关只控制「插件替你决定」、400 不换号、流中断不重试、
排序不写回用户选择、失败记账含上游重置时间……）。这些是行为规格，不是代码，照抄不侵权。

### 4.4 登录即得模型 key：抄 `officeace-auth/src/maas.mjs`

果办登录完只给 STS，**不给模型网关凭据**。必须补一次
`POST {CLAW}/v1/claw/client-subscription`（`x-subscription-type: v2` + V11 签名）才能拿到
`model_app_key/model_app_secret`。这是「不打开客户端 UI 也能直接对话」的唯一路径。

### 4.5 明确**不要**抄的

`dsh-huawei-connect` README §4.1–4.2 有实测：workbuddy 那套「提示词里插零宽空格 / 换中性头」
是为**那个上游的具体缺陷**写的补丁，华为两个平台**不做渠道指纹拦截**——照搬只会无声篡改用户提示词。

---

## 5. 建议的下一步

1. **先花 5 分钟验证现成方案**（成本最低）：
   `dsh plugin --profile desktop add dsh-huawei-connect@1.3.4` → 重启 → 设置里「使用华为云账号登录」。
   能跑通就不用自己写。
2. **跑不通再自研**：在 `dsh-connect-huaweicloud/` 起包，目录按 §4.1 建，
   凭据四段按 §4.2 抄，第一天就能让「网页登录 → 一个账号 → 能对话」闭环。
3. **装一次果办客户端**再验证 §3 的四条路径——那是目前唯一的取证缺口。
