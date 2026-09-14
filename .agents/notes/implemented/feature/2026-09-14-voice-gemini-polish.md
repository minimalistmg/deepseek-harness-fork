# Agent Note: Host-side Gemini polish for dictated transcripts

Status: implemented

English | [中文](2026-09-14-voice-gemini-polish.zh.md)

## Problem

The [voice dictation seat](2026-09-14-voice-dictation-composer-seat.md) inserts what the browser's speech engine heard. Raw dictation carries the speaker's disfluencies, misrecognized identifiers, and spoken artifacts, so the user edits before sending — the step this feature removes.

Cleanup needs a text model, and a model call needs a credential the browser must not hold. The plugin already had a browser half only, and Stage 2 of the same feature will stream audio, so the transport chosen here also decides what Stage 2 can reuse.

## Decision

Add a host half to `@deepseek-ai/dsh-client-ui-voice` that polishes one settled transcript through Gemini and returns cleaned text to the browser.

### Transport

The host registers an exact Connection Fetch route at `/api/voice/polish`, the way [file upload](../../../../packages/client/file-upload/src/index.ts) does: `methods: ['POST']` with `requestBody: 'buffered'`, and a handler returning a real `Response`. The browser posts `{ text }` and reads one envelope, `{ ok: true, text }` or `{ ok: false, error: { code, message, details } }`.

A Connection Fetch route rather than a Typert Remote namespace: Stage 2 streams audio over the same duplex HTTP carrier, where a request/response Remote namespace is the wrong instrument and would need a second transport beside it. One route serves both stages, and the routing decision today is the one the browser half already needs.

### Credentials

The host resolves the key per polish, never caching it, so a key stored after startup reaches the next utterance without reloading the plugin. `ctx.get('credentials')` is read as an optional service — the property proxy is topology-sensitive — and when that service is absent the launch environment is the whole credential plane, exactly as [`web-search-deepseek`](../../../../packages/web/web-search-deepseek/src/index.ts) does it. `credentialRef` validates the configured reference name at the config boundary.

The key travels in the `x-goog-api-key` header, never as the legacy `?key=` query parameter: a secret in a URL reaches access logs, proxy logs, and `Referer`-adjacent surfaces. The request sets `redirect: 'error'`, because a credentialed provider request must not follow a redirect to another origin ([web packages rule](../../../../packages/web/AGENTS.md)). One `deadline(signal, timeoutMs, 'VOICE_POLISH_TIMEOUT')` from `@deepseek-ai/dsh-timeout` fuses caller cancellation with the request deadline, and `timeoutOf` reads the deadline back so a timeout is not reported as a transport fault.

### Request and response

One `POST …/v1beta/models/<model>:generateContent` carries the cleanup prompt as `systemInstruction`, the transcript as the single user turn, and `temperature` plus `maxOutputTokens`. The default model is a thinking model, and its thinking tokens count against `maxOutputTokens`, so the cap is a fixed configured budget defaulting to `2048` rather than a length-derived estimate: a budget sized for the answer alone truncates the answer mid-sentence. The polished text is every `text` part of the first candidate, trimmed, with a wrapping quote pair or one whole-answer fenced block removed. A truncated answer is used as it stands instead of falling back to the raw transcript — the words that did arrive are the speaker's.

### Failure policy

Polish is best-effort, and every failure returns the submitted text unchanged: no key, no route, a refused request, the provider's quota refusal, the deadline, an unreadable body, or a transport fault. The whole feature therefore works in a deployment with no Gemini key, which is the same dictation behavior the seat had before this pass. The envelope distinguishes quota refusal, deadline, and unavailability so the seat can name the reason; the browser maps an unknown code to a generic failure rather than guessing. Each transcript is one attempt — no retry or backoff loop, because the free tier's per-minute quota makes 429 a routine condition rather than an edge case, a retry would burn the budget that later utterances need, and the request is already bounded by its deadline.

Tunables are validated `Config` fields (`apiKeyEnv`, `baseURL`, `polishModel`, `polishEnabled`, `polishPrompt`, `maxOutputTokens`, `timeoutMs`); the route path, the request field names, the header name, and the `models/<id>` prefix are protocol constants.

No session event is appended. The transcript is draft text until the user sends it, so it is not model-visible input; the polished text reaches the model only through the normal submit path, as ordinary draft text does.

## Alternatives considered

**Add a Typert Remote namespace.** Rejected: Stage 2 streams audio, and a Remote namespace is a request/response instrument. It would also drag `packages/api/remotes`, a `./remote` export, and a split tsconfig face into a plugin whose host half needs one unary route.

**Resolve the API key in the browser.** Rejected outright: any key the browser holds is readable by the page, and the deployment's `.env` is not the browser's to read.

**Send the key as the legacy `?key=` query parameter.** Rejected: it is the shape the reference application used, and it puts a live secret into every layer that logs a URL.

**Keep the legacy length-derived token cap.** Rejected on measurement: with the cap derived from the input length the sample transcript came back at `finishReason: MAX_TOKENS` with a truncated answer, because the model's thinking consumed the budget before the answer began. A fixed configured cap with headroom is the sanctioned fix; disabling thinking is not a verified path for this model.

**Retry a 429 or back off inside the request.** Rejected: one attempt per utterance keeps the composer responsive and leaves the quota for the utterances that follow.

**Fail the dictation when polish cannot run.** Rejected: it would make a model provider an availability dependency of the composer's microphone, and the user's words already exist.

**Record an auxiliary model request in the session log.** Rejected: the transcript is transient draft text, not model-visible input. [`web-search-deepseek`](../../../../packages/web/web-search-deepseek/src/provider.ts) records its auxiliary request because that request is part of a model-facing search; nothing here reaches the model.

## Consequences

Dictation now depends on a network round trip for its cleaning step, and the transcript leaves the device when `polishEnabled` is true — a deployment that cannot send draft text off-device disables polish and keeps unpolished dictation. Recognition may settle several chunks per utterance, so each chunk costs one request and long unbroken dictation can exhaust the free tier's per-minute quota; those chunks arrive unpolished and the seat says so.

The seat gained a second, independent fault channel: a dictation fault clears on the next attempt, while a polish fault outlives it, because it describes the host's state rather than that attempt. Settled transcripts are polished one at a time, and a chunk arriving mid-flight supersedes the pass already running, so a newer transcript that already contains the older words cannot be inserted twice.

The plugin now has a real host half, so the package carries Host and Client compiler faces and both halves are registered with the Loader. Its host entry value-imports three workspace packages, which the dependency policy classifies by identity rather than purity: `credentialRef` is a pure validating constructor with no module state, so it joined `safeHostDependencyExports`; `launchEnvironmentOf` reads a module-level registry and `deadline`/`timeoutOf` match a timeout by `instanceof`, so those three are `peerRequiredHostExports` and the package carries them as matching peers, because a duplicate copy would read its own empty registry or fail to recognize its own timeout reason.

That `safeHostDependencyExports` addition is a human-reviewed policy change. Per the policy file's header, the next change touching it **must carry a dedicated, prominent heading in the pull request description**; this note records the obligation rather than discharging it. The `peerRequiredHostExports` entries carry the same review obligation, and their comment in `scripts/package-dependency-policy.ts` states why those two exports cannot be reclassified.

Coverage pins the request mapping, the response cleanup, every failure arm including quota and deadline, the route's request validation and envelopes, the browser's identity fallback, and outbound egress through the installed proxy policy.
