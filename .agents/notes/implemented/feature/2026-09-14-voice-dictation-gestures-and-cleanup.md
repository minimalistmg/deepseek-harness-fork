# Agent Note: Dictation gestures and the spoken-text pipeline

Status: implemented

English | [中文](2026-09-14-voice-dictation-gestures-and-cleanup.zh.md)

## Problem

The [voice dictation seat](2026-09-14-voice-dictation-composer-seat.md) dictated only while the microphone button was clicked, and it inserted whatever the provider settled. Three gaps followed. A user with both hands on the keyboard had no way to start or stop without reaching for the pointer. An utterance ended only when the user ended it, so a hands-free dictation stayed open in a silent room. And a transcript reached the draft as the provider heard it — unpunctuated, carrying the speaker's disfluencies, and spelling identifiers the way they sound rather than the way they are written — so the user edited before sending, which is the work dictation exists to remove.

The seat also had no preference surface. `conversation.input.right` occupants receive the public `inputActions` face, a `useInput` snapshot, and their inject face; nothing in that kit carries a durable user choice, and the host config reaches the plugin, not the browser half's behavior.

## Decision

Add push-to-talk, a silence gate, four-way utterance ending, a dictation text pipeline, and a durable `ui-voice` settings section, and render the utterance's level under the composer card.

### Gestures and ending

The control binds one key chord (default `Alt+V`, configurable, empty disables it) with capture-phase `keydown` and `keyup` listeners on `document`. The listeners are registered once per binding and call the current closures through a ref, so no render mid-utterance re-registers them. A held chord's key repeat is ignored, and a release ends the utterance whether the letter or the modifier comes up first, because a user who lets go of `Alt` before `V` has finished the gesture.

An utterance now ends four ways — the button, the push-to-talk release, the silence gate, or unmount — and the ending carries a reason. Push-to-talk release and silence end it with `'ptt'` and `'silence'`, which are the two gestures that send the settled draft themselves; a click leaves the draft for review, because a click is how a user stops to look at what was heard.

The silence gate reads the microphone level, not the transcript: a provider reports words only after it heard them, so the quiet after the last word is visible nowhere else. Each captured chunk carries its root-mean-square level, and the gate reports silence at most once per utterance and only after it has heard speech, so an open microphone in a silent room keeps listening instead of ending before the speaker began.

### The pipeline

Each settled transcript passes through, in order: the spoken send instruction, three text rewrites, and the host cleanup pass. The send instruction is taken off before the rewrites so a dictated "send it" cannot survive as words, and the rewrites run before the host pass so a deployment with no cleanup credential still gets a punctuated, filler-free draft. The rewrites are verbal punctuation, fillers and stutter repeats, and spoken case cues (`user id in camel case` → `userId`).

### Preferences

A `ui-voice` section in the Host settings document carries the push-to-talk binding, the auto-send switch, the quiet period, and the cleanup and spoken-send switches. The host half registers the schema, the browser half binds the same section, and a deployment without a settings provider keeps the schema defaults the policy already carries. The resolved preferences are computed once per settings change rather than per key event.

### Level meter

One snapshot store per plugin instance holds the recording flag and the recent levels. The seat writes it; a second registration in `conversation.composer.dock` renders it under the composer card. The two entries share the handle passed to both registers, which is the sanctioned way for two entries to read one fact.

## Alternatives considered

**A global shortcut registered by the desktop shell.** Rejected for this change: the Web GUI is the product surface, and a chord the browser half owns works in every deployment, including the ones with no Electron shell. The desktop shell can add a process-wide chord later without changing this contract.

**A composer keyboard face for the chord.** Rejected: the seat receives no keyboard face by design, and the [earlier seat decision](2026-09-14-voice-dictation-composer-seat.md) already settled that widening the provide channel for a composer presentation concern needs a consumer that cannot use the private face. A page-level listener is that consumer's own mechanism.

**Send on every ending.** Rejected: a user who clicks to stop is inspecting what was heard, and sending then would take the draft away mid-read. Release and silence are the gestures that mean "done".

**Detect silence from transcript timestamps.** Rejected: waiting for the provider to report a quiet interval needs the provider to report one, and the level is already on the wire for the meter.

**Clean up on the host only.** Rejected: cleanup is best-effort by design, and the rewrites a deployment can always run must not depend on a model call. The host pass still runs, because it fixes what a deterministic rewrite cannot — grammar, clearer phrasing, spoken file names.

**Cache the resolved preferences in a module-level variable.** Rejected: the value belongs to the Host document, which can change under a live plugin, and a module-level hint would outlive the plugin instance that owns it.

## Consequences

Dictation now has a keyboard gesture, so `Alt+V` is taken in every page that composes the seat; a deployment that needs that chord changes the binding or clears it. Auto-send can send a message the user did not read, which is why it defaults on only for the two gestures that mean the utterance is finished and stays a preference.

The pipeline is deterministic text rewriting over one transcript, which is why the spoken identifier cues are greedy: a cue converts every preceding word that can form an identifier, and `make the user id in camel case` becomes `makeTheUserId`. The limitation is stated in the package README rather than solved with a heuristic that would silently drop words the speaker said.

The settings section stores a binding string rather than a parsed chord, so an unparsable value disables the gesture instead of failing the plugin. Coverage pins the pipeline's rewrites, the binding parser, the gate's timing, the seat's four endings, the meter's store, the dock's rendering, and the settings row's commits and rejections.
