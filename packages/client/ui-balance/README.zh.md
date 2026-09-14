---
description: "Web GUI 的账户余额胶囊：输入框底部读取 DeepSeek 平台余额，面向输入框底部的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-balance

[English](README.md) | 中文

## 概述

本包在输入框卡片下方、会话统计旁边显示 DeepSeek 平台账户余额。读取发生在 Host 侧，因为需要账户 API 密钥：浏览器请求一个路由，Host 返回它从平台读取到的余额，胶囊负责渲染。点击后可展开明细——赠送金额、充值金额、平台当前是否允许使用——以及指向平台用量页面的链接。没有账户凭据的部署不会渲染任何内容，因此底部绝不会出现一个无法填充的胶囊。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与 `ui-conversation`、`client-connection` 一起挂载；Host 侧注册一个路由，浏览器侧在输入框底部行渲染胶囊。

### 胶囊显示内容

胶囊显示 `<金额> <币种> · 可用`，当平台不允许使用该余额时显示 `· 不可用`。展开后会列出真正构成余额的额度项以及平台的可用性声明。点击平台用量链接会在新标签页打开平台页面。

### 配置

```yaml
- id: ui-balance
  name: '@deepseek-ai/dsh-client-ui-balance'
  config:
    displayCurrency: INR
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 每次读取时通过 `ctx.credentials` 解析的凭据引用；该服务不存在时改从启动环境读取 |
| `baseURL` | `https://api.deepseek.com` | 平台源站；会追加 `/user/balance` |
| `displayCurrency` | （空） | 金额换算目标币种。留空则保留账户自身币种并完全跳过汇率请求 |
| `fxBaseURL` | `https://api.frankfurter.app` | 汇率源站；会追加 `/latest?from=&to=` |
| `timeoutMs` | `5000` | 单次读取的截止时间（毫秒） |

每次读取都会重新解析密钥，因此启动后存入的密钥在下一次读取即可生效，无需重新加载插件。路由路径、平台余额路径与 `Bearer` 授权头都是协议常量，而不是配置项。

### 失败情形

汇率换算是尽力而为：当汇率服务拒绝、无法访问或返回不可用的汇率时，胶囊保留账户自身币种，而不会丢掉余额。平台响应被拒绝或无法解析、传输故障或超时都会让胶囊显示重试入口，下一次点击会重新读取。没有凭据时不渲染任何内容。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 —— 点击展开</summary>

Host 侧把 `ACCOUNT_BALANCE_PATH` 以缓冲 `GET` 形式注册到 Connection fetch 注册表。`src/balance.ts` 负责平台调用：密钥放在 `Authorization` 头中，因此绝不会出现在 URL 里；请求设置 `redirect: 'error'`，因为带凭据的提供方请求不得跟随跳转到其他源；`@deepseek-ai/dsh-timeout` 的一个 `deadline(signal, timeoutMs, …)` 把调用方取消与请求截止时间融合在一起。`timeoutOf` 会把截止时间读回来，因此超出自身截止时间的请求会被报告为超时，而不是传输故障。

报告取自平台返回的第一个余额行：币种、总额、赠送金额、充值金额，以及平台自身的可用性标记。汇率请求是对 `fxBaseURL` 的第二个请求，仅在配置了显示币种且与账户币种不同时发出；它的失败不算余额读取的失败。

浏览器侧只知道路由路径。`src/client/balance.ts` 把一个信封映射为胶囊的状态，`BalancePill.tsx` 渲染胶囊、它的浮层面板与重试。两侧共享 `src/protocol.ts`，该模块不含运行时依赖，因此会内联进浏览器 bundle，而不是请求模块表行。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当胶囊不够用时，可以继续阅读这些页面，从读取走向传输与凭据层。

- [client-connection](../connection/README.zh.md) —— 拥有共享的 `/api` 通道与本插件注册所用的独占 Fetch 路由注册表。
- [credentials](../../credentials/credentials/README.zh.md) —— Host 侧解析平台密钥所依赖的凭据服务。
- [ui-chat](../ui-chat/README.zh.md) —— 与本次读取并排的会话统计胶囊。
- [Web Client 架构](../../../docs/subsystems/web-client.zh.md) —— 本包遵循的分层规则。

-----

<a id="model-experience"></a>
## 模型体验

无，余额是通过平台自身 API 读取的账户元数据；它不注册提示词内容、工具 schema 或会话事件。

#### KV Cache 影响

无。该读取不会改变请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前的胶囊。它们是当前的包约束，而不是计费分析或任务清单。

- **没有缓存** —— 每次挂载与每次重试都会读取平台一次；打开多个标签页的浏览器每个标签页各读一次。
- **单一账户** —— 胶囊读取 Host 解析出的凭据，因此多个用户共用同一 Host 的部署只会显示一个账户。
- **换算仅供参考** —— 换算后的金额是按公布汇率计算的平台余额，并非报价或已结算金额。
- **面向特定平台** —— 胶囊读取 DeepSeek 的余额接口；其他提供方需要自己的读取器与信封。

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变式：** 未发布配套 invariant。胶囊不持有任何持久状态；它唯一拥有的关系是「渲染出的余额对应它所来自的平台读取」，本包的 provider、路由与组件覆盖率各自验证了这一点。
