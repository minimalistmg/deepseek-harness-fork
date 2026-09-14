# Agent Note: Voice dictation seat in the composer

Status: implemented

English | [中文](2026-09-14-voice-dictation-composer-seat.zh.md)

## Problem

The Web composer had no voice input, and the shape of the extension point decided whether it could be a plugin. `conversation.input.right` is a declared list seat ([`contract/slots.ts`](../../../../packages/client/ui-conversation/src/client/contract/slots.ts)), so a dictation control belongs in its own package — `ui-plan` and `ui-model-selection` occupy sibling composer seats the same way. What the seat receives, though, is the public `InputActions` face, whose only text verb was `setDraft(text)`. `SessionInputShell.setDraft` runs the incoming text through `REFERENCE_PLACEHOLDER_RE` and clears the root, so appending a transcript with it would delete every reference chip already in the draft. Caret-accurate insertion exists in the shell as `paste(text)`, but it is reached through the package-private `ComposerKeyboard` face, which by design never crosses a plugin boundary.

The two verbs are not interchangeable, so the choice was between a lossy out-of-package control and a deliberate widening of the public face.

## Decision

Add `insertText(text)` to `InputActions` and occupy `conversation.input.right` from a new browser plugin package, `@deepseek-ai/dsh-client-ui-voice`.

`SessionInputShell.actions.insertText` delegates to `paste`, so the public verb and the paste gesture share one insertion: text lands over the current selection, reference chips already in the draft survive, and detector placeholders inside the incoming text are still stripped, so a caller cannot forge a chip position. A never-focused surface lands the text at the document end.

The control reads the browser's own recognition engine (`SpeechRecognition`, or the `webkit`-prefixed alias) once at mount and runs one continuous session with interim results suppressed, so every reported chunk is settled text it appends without rewriting what it already inserted. Each settled chunk goes to the draft through `insertText`. The control owns no draft state, never touches the Lexical editor, and adds no host service: a settled chunk arriving after the seat unmounts is dropped rather than written into a draft nobody is editing. A browser without a recognition engine renders the seat disabled carrying the reason, rather than hiding it.

## Alternatives considered

**Append the transcript with the existing `setDraft`.** No contract change at all, and correct for an empty draft. Rejected because it is destructive in exactly the case dictation exists to serve: any draft already holding a reference chip loses that chip, silently, on the first recognized word.

**Emit the existing `slash/input-insert-text` scoped event.** Rejected: it is the completion pipeline's own token replacement, span-CAS'd against a trigger span the control never has, and `ui-input-trigger`'s controller is its only producer. It is not a general insertion path.

**Expose the whole `ComposerKeyboard` face to slot occupants.** [Busy send button follows the Enter setting](../bug-fix/2026-09-04-busy-send-button-follows-enter-setting.md) already rejected widening the provide channel with a composer presentation decision, on the grounds that no other consumer needed it and that the package-private keyboard face exists for exactly that purpose. That reasoning still holds for `submit(mode)`: a slot occupant has no keyboard, no arbitration, and no caret. It does not hold for insertion, because dictation is an out-of-package consumer that cannot use the private face. The keyboard face therefore keeps `paste`, `arbitrate`, `space`, and `submit(mode)`, and the provide channel gains one complete edit that needs no trigger, span, or arbitration state.

**Build dictation into `ui-conversation` instead of a package.** Rejected: the seat is declared for independent occupants, and drafting inside the owner would put a removable prototype into the shell every composer rewrite must carry.

**Render nothing when the browser ships no engine.** Rejected: a silently absent control reads as a missing feature rather than a browser capability gap, and a disabled seat states which one it is.

## Consequences

Any session-scope slot occupant can now insert plain text at the caret, and `ui-conversation` owns one more public verb whose semantics must stay paired with `paste`. The `InputActions` doubles in `ui-trajectory`'s specs gained the member.

Dictation is Chromium-only and its recognition runs in that browser's own speech service, so captured audio leaves the device; a deployment that cannot accept that must not compose the seat. The control holds no key binding, so push-to-talk is a click toggle, and the draft shows nothing until a chunk settles.

Coverage pins the recognized-chunk filtering, routine versus fault failures, the toggle lifecycle, the unmount guard, and the seat's registration and teardown.
