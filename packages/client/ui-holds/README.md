---
description: "Parked drafts for the Web GUI composer: the Hold control and the per-Session dock that keep unsent drafts, for users and maintainers of the composer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-holds

English | [中文](README.zh.md)

## Summary

This package parks composer drafts a user is not ready to send. A **Hold** control stores the current draft for this Session and clears the composer; a dock above the composer card lists what is parked, and each row can be sent, edited, deleted, or reordered. DeepSeek's own queue remains the send line — a hold is a draft that was never sent, and Send moves it back through the composer, so delivery stays on the ordinary path. Holds are browser state keyed by Session: nothing here is model-visible until a draft is resumed and sent.

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

Mount this plugin alongside `ui-conversation`; the Hold control then joins the composer's leading tool row, and the dock renders above the composer card, under the send queue.

### What the control does

| Control | Behavior |
|---|---|
| **Hold** | Parks the draft for this Session and clears the composer. While a held draft is being edited, Hold writes the composer back into that draft instead of adding another. |
| **Send** | Writes the held text into the composer and submits it through the ordinary path, then drops the row. |
| **Edit** | Writes the held text into the composer and marks the row as being edited. |
| **Delete** | Drops the row. |
| Reorder | Drag a row onto another, or focus its handle and press the up and down arrows. |

Holding is refused while the draft carries attachments, and while the draft is empty; the control's tooltip states which. A Session shows only its own drafts, and a Session this browser has never held starts empty.

### Failures

A refused Hold leaves the composer untouched. A submission that the Host refuses surfaces through the composer's own notices, exactly as a typed message would; the row is already gone, because the dock keeps no in-flight state of its own.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers two seats that share one per-Session store declared with `defineStore`: `conversation.input.left` carries the Hold control, and `conversation.input.dock` carries the dock. One handle passed to both registrations is what makes them the same drafts; the framework materializes one instance per handle and scope, so the persistence key is the store's own plus the Session id and a Session's holds survive a reload without any plugin-owned file or Host route.

The control reads the draft through the session-standard `useInput` hook and writes through the public `inputActions` face: parking calls the declared `hold` or `update` action and then `setDraft('')`. It reads `attachmentIds` to refuse a draft whose browser-owned files could not be parked, because the parked value is text and clearing the composer would otherwise drop those files with nothing to restore them from. Reference chips park as their clipboard text, which is what `InputState.draft` projects.

The dock writes through `inputActions.setDraft` and `inputActions.submit` only, so it never speaks to the Session: Send is a draft write followed by the same submission the composer's own Send performs, and a claim or a busy Session resolves inside the input machine. Reordering is one operation with two gestures — a pointer drag, and arrow keys on the focused handle — because a drag-only control is unusable without a pointer.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the dock is not enough. They move from the parked draft to the composer shell and the send line.

- [ui-conversation](../ui-conversation/README.md) — declares the composer seats, the `inputActions` face, and the send queue this dock sits under.
- [client/store](../store/README.md) — the snapshot engine and per-Scope persistence behind the shared handle.
- [Web Client architecture](../../../docs/subsystems/web-client.md) — the layer rules this package follows.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as a parked draft is uncommitted browser text that reaches the model only when the user sends it through the ordinary composer submission.

#### KV Cache effect

None. Holding, editing, or deleting a draft changes no request prefix; the prefix moves when a held message is sent, exactly as a typed message moves it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current holds dock. They are current package constraints, not a queue comparison or a task backlog.

- **Text only** — a draft carrying attachments cannot be held, so a user who wants to park a message with files must send it or remove the files first.
- **Reference chips flatten** — a parked draft keeps a reference's clipboard text, not the chip; restoring it writes that text back as plain text.
- **Browser-local** — holds live in this browser's storage for one Session. Another browser, another machine, or cleared site data shows none of them.
- **Editing one draft at a time** — the editing marker is per Session, and starting a new hold from the composer clears it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The seat owns no durable Host state and no relationship an independent observation could diverge on: the store's persistence and the registration lifecycle are exercised by this package's own coverage.
