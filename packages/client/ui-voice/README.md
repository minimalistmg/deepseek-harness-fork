---
description: "Voice input for the Web GUI composer: the microphone seat that streams speech to Gemini Live, cleans the transcript on the host, and writes it into the draft; for users and maintainers of the composer input row."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice

English | [中文](README.zh.md)

## Summary

This package dictates into the Web GUI composer. A microphone control in the composer's trailing row starts one utterance, streams audio to Gemini Live through this plugin's host route, and shows the transcript in the draft as the provider settles it. The host then cleans the settled transcript with a Gemini model; the API key never leaves it. Cleanup is best-effort, so a refused request or a deadline inserts the raw transcript and the button says why. Push-to-talk, a silence stop, and a spoken "send" can end an utterance and send it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation` and `client-connection`; the microphone then occupies the `conversation.input.right` seat in the composer's trailing control row, the level meter renders under the composer card, and the preferences join General Settings.

### What the control does

| Gesture | Behavior |
|---|---|
| Click the microphone | Start dictating; click again to stop and leave the draft for review. |
| Hold the push-to-talk key (default `Alt+V`) | Dictate while held; releasing ends the utterance and sends the draft. |
| Stop talking | After the configured quiet period the utterance ends itself and sends the draft. |

The transcript streams into the draft as the provider settles it, so recognition latency shows as text arriving rather than as a delay. Every settled update rewrites exactly the range this utterance wrote, so a draft the user already typed survives, and reference chips already in the draft are not discarded. Ending an utterance the link misheard — starting again after an insertion — takes the previous text back before the new attempt writes, rather than appending a second copy of the same words.

### Cleanup

A settled transcript goes through three rewrites before the host polish pass, each of which a deployment can turn off with the `cleanup` preference:

- **Verbal punctuation** — `period`, `comma`, `question mark`, `exclamation mark`, `colon`, `semicolon`, and `new line`.
- **Fillers and repeats** — `um`, `uh`, `like`, `you know`, `basically`, and a stutter such as `the the`.
- **Spoken identifiers** — `user id in camel case` becomes `userId`, with snake, pascal, kebab, and all-caps cues too.

### Configuration

```yaml
- id: ui-voice
  name: '@deepseek-ai/dsh-client-ui-voice'
  config:
    apiKeyEnv: GEMINI_API_KEY
    polishModel: gemini-3.6-flash
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `GEMINI_API_KEY` | Credential reference resolved for each utterance through `ctx.credentials`, or from the launch environment when that service is absent |
| `baseURL` | `https://generativelanguage.googleapis.com` | Generative Language endpoint origin; the versioned method paths are appended |
| `polishModel` | `gemini-3.6-flash` | Model id the cleanup request path carries |
| `liveModel` | `gemini-3.5-transcribe-live` | Live model id the transcription socket requests |
| `polishEnabled` | `true` | Whether a transcript is sent for cleanup at all. `false` keeps the routes and answers the identity outcome, so dictation behaves as in a deployment with no key |
| `webSpeechEnabled` | `false` | Whether the browser's own speech engine may take over when the live link cannot run |
| `polishPrompt` | the shipped cleanup prompt | Instruction sent as the model's system turn |
| `maxOutputTokens` | `2048` | Upper bound on generated tokens. The configured model is a thinking model and its thinking tokens count against this cap, so the default is a floor for the answer rather than a length-derived budget |
| `timeoutMs` | `8000` | Deadline for one cleanup request, in milliseconds |
| `flushWindowMs` | `1000` | How long to keep reading transcript frames after the microphone stops |
| `settleMs` | `220` | Quiet period between the last transcript frame and the cleanup request |
| `idleTimeoutMs` | `480000` | How long a warm provider socket may sit unused before it is dropped |
| `connectTimeoutMs` | `10000` | Deadline for the provider socket's setup handshake |
| `closeTimeoutMs` | `2000` | Deadline for one graceful provider socket close |
| `maxUtteranceBytes` | `8388608` | Cap on decoded audio one utterance may carry |

The microphone, push-to-talk, silence, cleanup, and spoken-send preferences live in the `ui-voice` user-settings section and are edited in General Settings. Each cleanup request resolves the key again, so a key stored after startup reaches the next utterance without reloading the plugin. The route paths, the request field names, the `x-goog-api-key` header, and the `models/<id>` prefix are protocol constants rather than configuration.

### Failures

A microphone the platform withholds, a link that never opened, and an audio graph that stopped all leave the seat in its failed state, which the button's accessible name and tooltip report, and the next click retries. A silent room and a deliberate stop are routine endings, not faults. A cleanup pass that cannot run never fails dictation: the raw transcript reaches the draft and the button names the reason — no key or no route, the provider's per-minute quota, the deadline, or another provider fault. A successful pass clears that state on the next utterance, because the host can restore a key between two utterances.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The control occupies the conversation-declared `conversation.input.right` list seat. `src/client/capture.ts` owns the microphone: an `AudioWorklet` posts render quanta, the main thread resamples them to the provider's 16 kHz and frames them into 100 ms chunks, and each chunk carries the root-mean-square level the silence gate and the meter read. `src/client/live.ts` owns one utterance: it opens the microphone, streams chunks up one streaming `POST` and reads transcript frames back down the same request, and falls back to the browser's own engine when the deployment allows it. The seat addresses the draft through the offsets it read from `useInput` and writes through the public `inputActions` face, so it owns no draft state and never touches the Lexical editor.

The host half registers two routes on the same Connection fetch registry: a streaming one that carries audio up and transcript frames down, and a buffered one for the cleanup pass. `src/live-session.ts` keeps one warm provider socket and reuses it across utterances, `src/live-socket.ts` owns the WebSocket framing and setup handshake, and `src/polish.ts` owns the cleanup `generateContent` call — the key in the `x-goog-api-key` header so no secret reaches a URL, `redirect: 'error'` so a credentialed request never follows a redirect to another origin, and a `deadline` from `@deepseek-ai/dsh-timeout` fused with the caller's signal.

Dictation preferences are a durable settings section the host registers and the browser binds. The level meter is one snapshot store per plugin instance: the seat writes it and the dock renders it, which is what lets the two registrations share one utterance's envelope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the composer seat is not enough. They move from the control to the composer shell and the provider protocol.

- [ui-conversation](../ui-conversation/README.md) — declares the composer's seats and owns the `inputActions` face this control writes through.
- [ui-plan](../ui-plan/README.md) — the sibling composer seat, and the smallest example of a single-slot occupant.
- [client-connection](../connection/README.md) — owns the shared `/api` channel and the exclusive Fetch-route registry this plugin registers on.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — the layer rules this package follows.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as dictated text is ordinary draft text until the user sends it, and the transcription and cleanup calls sit outside `ctx.llm`.

#### KV Cache effect

None. Dictation changes only uncommitted draft text; the request prefix moves when the user sends the message, exactly as typed input does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current voice seat. They are current package constraints, not a comparison of dictation providers or a task backlog.

- **The microphone needs a secure, capable browser** — capture needs `navigator.mediaDevices` and `AudioWorklet`; elsewhere the seat renders disabled.
- **Audio leaves the device** — microphone audio streams to Gemini Live, and the transcript takes a second request for cleanup unless `polishEnabled` is `false`.
- **Cleanup costs one request per settled transcript** — a long unbroken utterance settles several times, and the free tier's per-minute quota can refuse the later ones, which then arrive unpolished.
- **No interim text** — the draft updates only on settled transcripts, so recognition latency shows as text arriving rather than as provisional words.
- **Push-to-talk is a page-level listener** — the chord starts dictation while the window has focus, and a deployment that types `Alt+V` for another purpose changes the binding or clears it.
- **Spoken identifier cues are greedy** — a cue converts every preceding word that can form one, so `make the user id in camel case` yields `makeTheUserId`; say the identifier alone.
- **Transcripts are not history** — a dictation the user never sends leaves no record beyond the draft.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The seat owns no durable state: its only owned relation is that a live recognition session exists exactly while the button reports listening, and both halves of that relation are browser-local state no node-plane companion can observe. The provider socket's lifecycle, the route failure mapping, and the dictation pipeline are asserted by this package's own coverage.
