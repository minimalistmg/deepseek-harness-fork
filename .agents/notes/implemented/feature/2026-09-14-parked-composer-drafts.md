# Agent Note: Parked composer drafts as a composition of stores and seats

Status: implemented

English | [中文](2026-09-14-parked-composer-drafts.zh.md)

## Problem

A user composing a message often has a second thought mid-draft: the message in the box is not what they want to send next, and the only ways to clear the composer are to send it or to discard it. The product rules out the third option — keeping several drafts alive at once — because the Web GUI's draft is a single per-Session value the composer mirrors, and the send queue holds messages that are going to be sent, not messages that are not.

The blocked question was where a parked draft lives. The composer's draft is browser state (`ConversationStoreState.draft`), the send queue is durable Host state, and neither can hold "a draft the user set aside".

## Decision

Add `@deepseek-ai/dsh-client-ui-holds`, whose drafts live in one per-Session `defineStore` instance, rendered by a control in `conversation.input.left` and a dock in `conversation.input.dock`.

A hold is browser state, not a session event, because it is not model-visible input: it reaches the model only when the user sends it, through the same submission a typed message takes. The store persists through the shared snapshot engine, whose per-Scope key is the store's own name plus the Session id, so one Session's holds survive a reload with no plugin-owned file and no Host route.

One handle is passed to both registrations. The framework materializes one instance per handle and scope, which is what makes the control and the dock the same drafts; sharing a handle across registrations inside `apply` is the sanctioned way to share state between entries.

### Which seats

The control occupies `conversation.input.left` rather than the trailing row the voice seat and the model seat share, because parking is a left-side action a user reaches before composing, and the trailing row is where sending lives.

### What Send does

Send writes the held text into the composer through `inputActions.setDraft` and then submits through `inputActions.submit`, dropping the row. The dock therefore speaks to no Session service: a command claim, a busy Session, and an optimistic send all resolve inside the input machine, and a refused submission surfaces through the composer's own notices exactly as a typed message does. This is also why the row leaves the list immediately: the dock keeps no in-flight state to reconcile, because the submission plane already owns that state.

### Refusing a draft that cannot be parked

The parked value is text. Holding a draft that carries attachments would clear the composer and drop browser-owned file objects with nothing to restore them from, so the control refuses while `attachmentIds` is non-empty and its tooltip states why. The same reasoning makes the control refuse an empty draft, which would park a row with nothing in it.

### Reordering

Reordering is one operation with two gestures: a pointer drag between rows, and the up and down arrows on the focused handle. A drag-only control is unusable from the keyboard, and the row is a list position rather than a value, so a keyboard user must be able to change it.

## Alternatives considered

**A Host-side draft store with a Typert remote.** Rejected: a parked draft is not durable product data and does not need to cross the wire. The browser already owns the composer draft; parking is the same class of state.

**Put the Hold control in the trailing control row.** Rejected: that row is the send side of the composer, and parking is the opposite intent. It also shares the row with the voice seat's microphone, and two unrelated controls competing for the same narrow space is a layout decision the composer should not carry.

**Park attachments too.** Rejected for now: an image draft is a browser `File` and a file draft is a Host receipt, and neither survives a reload in a form a slot occupant can restore through the public input actions. Refusing the hold keeps the promise that a parked row is what the user will get back.

**Keep the hold on the send queue.** Rejected: the queue's rows are messages the Session will deliver, and a session event records each one. A draft that may never be sent must not enter the log.

**Reorder by a drag handle only.** Rejected: it would make one dock operation pointer-only, and the row order is otherwise plain data.

## Consequences

The composer now has two ways to leave a message unsent — parked in the dock, or queued for delivery — and users must choose between them; the README states the difference. A hold's reference chips flatten to their clipboard text, because that is what the input state projects and what `setDraft` restores.

Holds are browser-local: another browser, another machine, or cleared site data shows none of them, and the same Session opened in two browsers keeps two independent lists. Coverage pins the store's five actions, per-Session isolation and reload, the control's refusals and writes, the dock's send, edit, delete, collapse, and both reorder gestures, and each registration's teardown.
