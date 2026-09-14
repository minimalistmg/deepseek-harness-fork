---
description: "Web GUI 输入框的语音输入：把语音流式发送到 Gemini Live、在宿主侧整理转写文本并写入草稿的麦克风座位；面向输入框输入行的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice

[English](README.md) | 中文

## Summary

本包为 Web GUI 输入框提供听写。输入框右侧控件行中的麦克风控件开始一次口述，把音频经本插件的宿主路由流式发送到 Gemini Live，并在服务方确认后把转写文本显示在草稿中。宿主随后用 Gemini 模型整理已确认的转写；API 密钥从不离开宿主。整理是尽力而为的：请求被拒绝或超时都会按原样插入原始转写，并由按钮说明原因。按住说话、静默结束与口述的「send」都可以结束一次口述并发送它。

## Table of Contents

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与 `ui-conversation`、`client-connection` 一起挂载；麦克风会占据输入框右侧控件行的 `conversation.input.right` 座位，音量条显示在输入框卡片下方，偏好设置进入「通用」设置。

### 控件行为

| 手势 | 行为 |
|---|---|
| 点击麦克风 | 开始听写；再次点击结束，草稿留在输入框中供检查。 |
| 按住说话按键（默认 `Alt+V`） | 按住期间听写；松开即结束该次口述并发送草稿。 |
| 停止说话 | 达到配置的静默时长后，该次口述自动结束并发送草稿。 |

转写文本在服务方确认后流入草稿，因此识别延迟表现为文字陆续出现，而不是等待。每次确认更新只改写本次口述写入的范围，用户已经输入的草稿内容不会被覆盖，草稿中已有的引用 chip 也不会被丢弃。若链接听错了内容，下一次开始时会先撤回上一次写入的文本，而不是再追加一份相同的字词。

### 整理

已确认的转写文本在进入宿主整理之前会经过三步改写，部署可以通过 `cleanup` 偏好逐项关闭：

- **口述标点** —— `period`、`comma`、`question mark`、`exclamation mark`、`colon`、`semicolon` 与 `new line`。
- **口头语与重复** —— `um`、`uh`、`like`、`you know`、`basically`，以及 `the the` 这类结巴重复。
- **口述标识符** —— `user id in camel case` 转换为 `userId`，同样支持 snake、pascal、kebab 与全大写。

### 配置

```yaml
- id: ui-voice
  name: '@deepseek-ai/dsh-client-ui-voice'
  config:
    apiKeyEnv: GEMINI_API_KEY
    polishModel: gemini-3.6-flash
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `GEMINI_API_KEY` | 每次口述通过 `ctx.credentials` 解析的凭据引用；该服务不存在时改从启动环境读取 |
| `baseURL` | `https://generativelanguage.googleapis.com` | Generative Language 源站；会追加带版本的方法路径 |
| `polishModel` | `gemini-3.6-flash` | 整理请求路径携带的模型 id |
| `liveModel` | `gemini-3.5-transcribe-live` | 转写 socket 请求的 Live 模型 id |
| `polishEnabled` | `true` | 是否发送整理请求。`false` 仍注册路由并返回恒等结果，行为等同于没有密钥的部署 |
| `webSpeechEnabled` | `false` | Live 链接不可用时是否允许浏览器自带语音引擎接管 |
| `polishPrompt` | 内置整理提示词 | 作为模型 system 轮发送的指令 |
| `maxOutputTokens` | `2048` | 生成 token 上限。所配置的模型是思考模型，其思考 token 也计入该上限，因此默认值是为答案留出的下限，而不是按长度估算的预算 |
| `timeoutMs` | `8000` | 单次整理请求的截止时间（毫秒） |
| `flushWindowMs` | `1000` | 麦克风停止后继续读取转写帧的时长 |
| `settleMs` | `220` | 最后一个转写帧与整理请求之间的静默时长 |
| `idleTimeoutMs` | `480000` | 预热的服务方连接在空闲多久后被丢弃 |
| `connectTimeoutMs` | `10000` | 服务方连接握手阶段的截止时间 |
| `closeTimeoutMs` | `2000` | 优雅关闭服务方连接的截止时间 |
| `maxUtteranceBytes` | `8388608` | 单次口述允许携带的解码音频上限 |

麦克风、按住说话、静默、整理与口述发送等偏好保存在 `ui-voice` 用户设置分区中，并在「通用」设置里编辑。每次整理请求都会重新解析密钥，因此启动后存入的密钥在下一次口述即可生效，无需重新加载插件。路由路径、请求字段名、`x-goog-api-key` 头以及 `models/<id>` 前缀都是协议常量，而不是配置项。

### 失败情形

平台拒绝授予麦克风、链接始终无法打开、音频图停止，都会让座位进入失败状态，由按钮的无障碍名称与提示说明，下一次点击即可重试。安静的房间与用户主动停止属于正常结束，不算故障。整理无法执行时绝不会导致听写失败：原始转写直接进入草稿，按钮会说明原因——没有密钥或没有路由、服务方每分钟配额、超时，或其他服务方故障。整理成功后该状态会在下一次口述时清除，因为宿主可以在两次口述之间恢复密钥。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 —— 点击展开</summary>

控件占据对话声明的 `conversation.input.right` 列表座位。`src/client/capture.ts` 负责麦克风：`AudioWorklet` 投递渲染量子，主线程将其重采样为服务方要求的 16 kHz 并切分为 100 ms 分片，每个分片都携带均方根电平供静默门限与音量条读取。`src/client/live.ts` 负责一次口述：打开麦克风、把分片经一个流式 `POST` 上行并在同一请求中读回转写帧，在部署允许时回退到浏览器自带引擎。座位通过从 `useInput` 读取的偏移量定位草稿，并通过公开的 `inputActions` 面写入，因此它不持有草稿状态，也从不直接触碰 Lexical 编辑器。

宿主半部在同一 Connection fetch 注册表上注册两个路由：一个流式路由承载上行音频与下行转写帧，一个缓冲路由承载整理请求。`src/live-session.ts` 维护一个预热的服务方连接并在多次口述间复用，`src/live-socket.ts` 负责 WebSocket 分帧与握手，`src/polish.ts` 负责整理的 `generateContent` 调用——密钥放在 `x-goog-api-key` 头中以免出现在 URL 里，`redirect: 'error'` 保证带凭据的请求不会跟随跳转，`@deepseek-ai/dsh-timeout` 的 `deadline` 与调用方信号融合。

听写偏好是宿主注册、浏览器绑定的持久设置分区。音量条是每个插件实例一个快照 store：座位写入、音量条读取，这正是两处注册能共享同一次口述包络的原因。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

当输入框座位不够用时，可以继续阅读这些页面，从控件走向输入框外壳与服务方协议。

- [ui-conversation](../ui-conversation/README.zh.md) —— 声明输入框座位，并拥有本控件写入所用的 `inputActions` 面。
- [ui-plan](../ui-plan/README.zh.md) —— 相邻的输入框座位，也是单座位占用者的最小示例。
- [client-connection](../connection/README.zh.md) —— 拥有共享的 `/api` 通道与本插件注册所用的独占 Fetch 路由注册表。
- [Web Client 架构](../../../docs/subsystems/web-client.zh.md) —— 本包遵循的分层规则。
- [客户端包地图](../README.zh.md) —— 相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无，听写文本在用户发送之前只是普通草稿文本，转写与整理调用都位于 `ctx.llm` 之外。

#### KV Cache 影响

无。听写只改变尚未提交的草稿文本；请求前缀在用户发送消息时移动，与手动输入完全一样。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前的语音座位。它们是当前的包约束，而不是听写服务对比或任务清单。

- **麦克风需要安全且具备能力的浏览器** —— 采集依赖 `navigator.mediaDevices` 与 `AudioWorklet`；不具备时座位渲染为禁用。
- **音频会离开设备** —— 麦克风音频流式发送到 Gemini Live，转写文本还会再发一次整理请求，除非把 `polishEnabled` 设为 `false`。
- **每段确认转写消耗一次请求** —— 长时间不间断的口述会多次确认，免费层每分钟配额可能拒绝靠后的请求，那些片段将以未整理状态到达。
- **没有中间文本** —— 草稿只在转写确认后更新，因此识别延迟表现为文字陆续出现，而不是临时词。
- **按住说话是页面级监听** —— 该组合键在窗口获得焦点时开始听写；如果部署把 `Alt+V` 用于其他用途，请改绑或清空它。
- **口述标识符提示是贪婪匹配** —— 提示会转换其前面所有可组成标识符的词，因此 `make the user id in camel case` 会得到 `makeTheUserId`；请单独说出标识符。
- **转写不是历史记录** —— 用户未发送的听写除了草稿之外不会留下任何记录。

<a id="dev-note"></a>
### 开发者说明

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>

**运行时不变式：** 未发布配套 invariant。该座位不持有任何持久状态：它唯一拥有的关系是「按钮报告正在聆听时恰有一个识别会话存在」，而该关系的两端都是 Node 侧配套无法观察的浏览器本地状态。服务方连接的生命周期、路由失败映射与听写管线都由本包自身的覆盖率验证。
