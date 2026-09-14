# Agent Note: Voice dictation seat in the composer

Status: implemented

[English](2026-09-14-voice-dictation-composer-seat.md) | 中文

## Problem

Web 输入框此前没有语音输入，而扩展点的形状决定了它能否做成插件。`conversation.input.right` 是一个已声明的 list 座位（[`contract/slots.ts`](../../../../packages/client/ui-conversation/src/client/contract/slots.ts)），因此听写控件理应属于它自己的包——`ui-plan` 与 `ui-model-selection` 正是以同样方式占据同级的输入框座位。然而该座位拿到的是公开的 `InputActions` 面，其唯一的文本动词是 `setDraft(text)`。`SessionInputShell.setDraft` 会先把传入文本过一遍 `REFERENCE_PLACEHOLDER_RE` 再清空 root，因此用它追加听写文本会删掉草稿中已有的每一个引用 chip。光标处的精确插入在 shell 中以 `paste(text)` 存在，但它经由包内私有的 `ComposerKeyboard` 面抵达，而该面按设计从不跨越插件边界。

这两个动词不可互换，因此选择只有两个：要么做出一个会丢数据的包外控件，要么有意拓宽公开面。

## Decision

为 `InputActions` 增加 `insertText(text)`，并由新的浏览器插件包 `@deepseek-ai/dsh-client-ui-voice` 占据 `conversation.input.right`。

`SessionInputShell.actions.insertText` 委托给 `paste`，因此公开动词与粘贴手势共用同一次插入：文本落在当前选区之上，草稿中已有的引用 chip 得以保留，而传入文本中的检测占位符仍会被剥离，调用方因此无法伪造 chip 位置。从未获得焦点的表面会把文本落到文档末尾。

控件在挂载时读取浏览器自带的识别引擎（`SpeechRecognition`，或带 `webkit` 前缀的别名）并运行一次 continuous 会话且关闭 interim 结果，因此每个上报的文本块都是已结算文本，控件直接追加而不重写已插入的内容。每个结算文本块经由 `insertText` 进入草稿。控件不持有草稿状态、从不接触 Lexical 编辑器，也不新增宿主服务：座位卸载后才结算的文本块会被丢弃，而不会写进无人编辑的草稿。没有识别引擎的浏览器会把该座位渲染为携带原因的禁用状态，而不是隐藏它。

## Alternatives considered

**用现有的 `setDraft` 追加听写文本。** 完全不需要改契约，且对空草稿是正确的。予以否决，因为它在听写最该服务的场景下具有破坏性：草稿中只要已有一个引用 chip，第一个识别出的词就会把它静默删除。

**发出已有的 `slash/input-insert-text` scoped 事件。** 予以否决：那是补全流水线自己的 token 替换，以控件从未持有的 trigger span 做 span-CAS，且 `ui-input-trigger` 的 controller 是其唯一生产者。它不是通用的插入路径。

**把整个 `ComposerKeyboard` 面暴露给 slot 填充者。** [Busy send button follows the Enter setting](../bug-fix/2026-09-04-busy-send-button-follows-enter-setting.zh.md) 已经否决过用 composer 呈现决策去拓宽 provide 通道，理由是当时没有其他消费者需要它，而包内私有的键盘面正是为此存在。该推理对 `submit(mode)` 依然成立：slot 填充者没有键盘、没有仲裁、也没有光标。但它对插入不成立，因为听写是一个无法使用私有面的包外消费者。因此键盘面保留 `paste`、`arbitrate`、`space` 与 `submit(mode)`，而 provide 通道只增加一个不需要 trigger、span 或仲裁状态的完整编辑。

**把听写做进 `ui-conversation` 而不是独立包。** 予以否决：该座位正是为独立填充者声明的，而把原型做进拥有方会让每次 composer 重写都必须携带它。

**浏览器没有引擎时不渲染任何内容。** 予以否决：静默消失的控件会被读成功能缺失，而不是浏览器能力缺失；禁用座位能说明是哪一种。

## Consequences

任何 session 作用域的 slot 填充者现在都能在光标处插入纯文本，而 `ui-conversation` 多了一个公开动词，其语义必须与 `paste` 保持配对。`ui-trajectory` 规格中的 `InputActions` 替身已补上该成员。

听写仅 Chromium 支持，且其识别在该浏览器自有的语音服务中运行，因此采集的音频会离开设备；无法接受这一点的部署不应组合该座位。控件不绑定按键，因此按住说话实为点击切换，并且在文本块结算前草稿不显示任何内容。

覆盖锁定识别文本块过滤、正常结束与故障的区分、切换生命周期、卸载守卫，以及座位的注册与拆除。
