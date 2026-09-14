# Agent Note: Host-side Gemini polish for dictated transcripts

Status: implemented

[English](2026-09-14-voice-gemini-polish.md) | 中文

## Problem

[语音听写座位](2026-09-14-voice-dictation-composer-seat.zh.md)插入的是浏览器语音引擎听到的内容。原始听写带有说话人的口头语、识别错误的标识符与口语化痕迹，因此用户发送前还要修改——本功能去掉的就是这一步。

整理需要文本模型，而模型调用需要浏览器不能持有的凭据。该插件此前只有浏览器半部，而同一功能的第二阶段要流式传输音频，因此这里选定的传输方式也决定了第二阶段能复用什么。

## Decision

为 `@deepseek-ai/dsh-client-ui-voice` 增加宿主半部，通过 Gemini 整理一个已结算文本块，并把整理后的文本返回浏览器。

### 传输

宿主按[文件上传](../../../../packages/client/file-upload/src/index.ts)的方式，在 Connection Fetch 注册表上注册精确路由 `/api/voice/polish`：`methods: ['POST']`、`requestBody: 'buffered'`，处理函数返回真正的 `Response`。浏览器 POST `{ text }`，读取一个信封：`{ ok: true, text }` 或 `{ ok: false, error: { code, message, details } }`。

选择 Connection Fetch 路由而不是 Typert Remote 命名空间：第二阶段要在同一条双工 HTTP 载体上流式传输音频，而请求／响应式的 Remote 命名空间在那里是错的工具，且需要另配一套传输。一条路由服务两个阶段，而今天做下的路由决策正是浏览器半部已经需要的那一个。

### 凭据

宿主每次整理都重新解析密钥且从不缓存，因此启动后才存入的密钥无需重载插件即可用于下一段听写。`ctx.get('credentials')` 作为可选服务读取——属性代理对拓扑敏感——该服务缺席时启动环境就是全部凭据平面，与 [`web-search-deepseek`](../../../../packages/web/web-search-deepseek/src/index.ts) 的做法一致。`credentialRef` 在配置边界校验所配置的引用名。

密钥走 `x-goog-api-key` 请求头，绝不用旧的 `?key=` 查询参数：URL 里的机密会进入访问日志、代理日志以及 `Referer` 一类表面。请求设置 `redirect: 'error'`，因为带凭据的提供方请求不得跟随跳转到其他源（[web 包规则](../../../../packages/web/AGENTS.md)）。来自 `@deepseek-ai/dsh-timeout` 的一次 `deadline(signal, timeoutMs, 'VOICE_POLISH_TIMEOUT')` 把调用方取消与请求截止时间融合，超时再由 `timeoutOf` 读回，因此超时不会被报告成传输故障。

### 请求与应答

一次 `POST …/v1beta/models/<model>:generateContent` 把整理提示词作为 `systemInstruction`、把文本作为唯一的 user 轮，并带上 `temperature` 与 `maxOutputTokens`。默认模型是思考模型，其思考 token 计入 `maxOutputTokens`，因此上限是默认 `2048` 的固定配置预算，而不是按长度推算的估计值：只够答案的预算会把答案截断在句中。整理后的文本取第一个候选的全部 `text` 分片并去空白，再剥掉包裹性的引号对或整段代码围栏。被截断的答案按原样采用，而不是退回原始文本——已经回来的词是说话人的。

### 失败策略

整理是尽力而为的，任何失败都返回提交时的文本：没有密钥、没有路由、请求被拒、提供方配额拒绝、超过截止时间、应答无法解析，或传输故障。因此本功能在没有 Gemini 密钥的部署中同样可用，与本次改动之前座位的听写行为完全一致。信封区分配额拒绝、截止时间与不可用，好让座位说明原因；浏览器把未知错误码映射为通用失败而不做猜测。每个文本块只尝试一次——没有重试或退避循环，因为免费额度按分钟计，429 是常态而非边缘情况，重试会消耗后面听写所需的额度，而请求本身已由截止时间界定。

可调项是经过校验的 `Config` 字段（`apiKeyEnv`、`baseURL`、`polishModel`、`polishEnabled`、`polishPrompt`、`maxOutputTokens`、`timeoutMs`）；路由路径、请求字段名、请求头名与 `models/<id>` 前缀都是协议常量。

不追加任何 Session 事件。文本在用户发送之前只是草稿，不是面向模型的输入；整理后的文本只经正常提交路径到达模型，与普通草稿文本相同。

## Alternatives considered

**增加一个 Typert Remote 命名空间。** 拒绝：第二阶段要流式传输音频，而 Remote 命名空间是请求／响应式工具。它还会把 `packages/api/remotes`、`./remote` 导出与拆分 tsconfig 面拖进一个宿主半部只需要一条一元路由的插件。

**在浏览器里解析 API 密钥。** 直接拒绝：浏览器持有的任何密钥都可被页面读取，部署的 `.env` 也不是浏览器该读的东西。

**用旧的 `?key=` 查询参数发送密钥。** 拒绝：那是参考应用采用的形态，它把有效机密放进每一层会记录 URL 的地方。

**沿用按长度推算的 token 上限。** 依据实测拒绝：上限由输入长度推算时，示例文本返回 `finishReason: MAX_TOKENS` 与截断的答案，因为模型的思考在答案开始前就消耗了预算。带余量的固定配置上限是获认可的修法；关闭思考对该模型不是已验证路径。

**对 429 重试或在请求内退避。** 拒绝：每段文本一次尝试既让输入框保持响应，也把额度留给后续文本。

**整理无法执行时让听写失败。** 拒绝：那会让模型提供方成为输入框麦克风的可用性依赖，而用户的话本来就已经在草稿里。

**在 Session 日志中记录一次辅助模型请求。** 拒绝：文本只是瞬时草稿，不是面向模型的输入。[`web-search-deepseek`](../../../../packages/web/web-search-deepseek/src/provider.ts) 记录它的辅助请求，是因为那次请求属于面向模型的搜索；这里没有任何内容到达模型。

## Consequences

听写现在为它的整理步骤依赖一次网络往返；当 `polishEnabled` 为真时文本离开本机——不能把草稿文本送出设备的部署关闭整理，仍可保留不经整理的听写。识别可能在一段话中结算多个文本块，因此每个文本块消耗一次请求，长时间连续听写会耗尽免费额度的每分钟配额；这些文本块以未经整理的形式进入草稿，座位会如实说明。

座位多了一条独立的故障通道：听写故障在下一次尝试时清除，而整理故障会跨越那次尝试，因为它描述的是宿主状态而非该次尝试。已结算文本逐个整理，中途到达的文本块会顶替正在运行的那一趟，因此本身已包含较早词句的较新文本不会被插入两次。

该插件现在有了真正的宿主半部，因此本包带有 Host 与 Client 两套编译面，两半都注册进 Loader。其宿主入口按值导入三个工作区包，依赖策略按标识而非纯粹性归类：`credentialRef` 是无模块状态的纯校验构造函数，因此进入 `safeHostDependencyExports`；`launchEnvironmentOf` 读取模块级注册表，`deadline`／`timeoutOf` 用 `instanceof` 匹配超时，因此这三者属于 `peerRequiredHostExports`，本包以匹配的 peer 依赖携带它们——重复安装的另一份副本会读到自己的空注册表，或认不出自己产生的超时原因。

那次 `safeHostDependencyExports` 新增是经人工审阅的策略变更。按该策略文件头部说明，下一次改动它**必须在 PR 描述中带上专门的显著标题**；本注记记录这一义务，而不是替它履行。`peerRequiredHostExports` 的新增条目同样带有审阅义务，它们在 `scripts/package-dependency-policy.ts` 中的注释写明了为何这两个导出不能被重新归类。

覆盖范围锁定了请求映射、应答清理、包括配额与截止时间在内的每一种失败分支、路由的请求校验与信封、浏览器的恒等回退，以及经由已安装代理策略的出站流量。
