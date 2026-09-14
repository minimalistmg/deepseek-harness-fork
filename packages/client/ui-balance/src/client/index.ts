/**
 * Account balance plugin, browser half: it renders the platform balance under
 * the composer card, beside the session statistics, and knows only the route
 * path — the host half holds the DeepSeek credential.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the composer dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { readBalance } from './balance.ts'
import { BalancePill } from './BalancePill.tsx'
import { en, zh, type BalanceKey } from './locales.ts'

export type { BalanceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Account balance copy. */
    balance: BalanceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'balance'

/** Required services: the seat's slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the balance pill under the composer card. The
 * pill renders nothing while this deployment reports no balance.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-balance: dictionaries')

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'account-balance',
    order: 60,
    locale: NS,
    inject: () => ({ read: readBalance }),
  }, BalancePill))
}
