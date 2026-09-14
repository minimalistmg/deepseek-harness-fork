/**
 * Holds plugin, browser half: parked composer drafts for the current Session.
 *
 * The composer's Hold control and the dock share one per-Session store, so a
 * draft parked by the control is the row the dock renders and the row Edit
 * loads back into the composer. DeepSeek's queue stays the send line: Send
 * writes the held text into the composer and submits through the public input
 * actions, so the message travels the ordinary path and this plugin owns no
 * delivery state.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left and input.dock seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { HoldButton } from './HoldButton.tsx'
import { HoldsDock } from './HoldsDock.tsx'
import { createHoldsStore } from './stores.ts'
import { en, zh, type HoldsKey } from './locales.ts'

export type { HoldsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Parked-draft copy. */
    holds: HoldsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'holds'

/** Required services: the seat's slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the Hold control in the composer's leading
 * control list and the parked drafts above the composer card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-holds: dictionaries')
  // One handle for both registrations: the framework materializes one
  // per-Session instance per handle, which is what lets the control and the
  // dock read the same drafts.
  const holds = createHoldsStore()

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'holds',
    order: 20,
    locale: NS,
    store: holds,
  }, HoldButton))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'holds',
    order: 30,
    locale: NS,
    store: holds,
  }, HoldsDock))
}
