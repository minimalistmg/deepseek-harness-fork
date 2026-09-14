/**
 * Account balance plugin, node half: it owns the DeepSeek credential and reads
 * the platform balance the browser cannot ask for itself. One Connection Fetch
 * route carries the reading; the API key stays on this side.
 * @module @deepseek-ai/dsh-client-ui-balance
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import {
  AccountBalanceProvider,
  DEFAULT_ACCOUNT_BALANCE_TIMEOUT_MS,
  DEFAULT_DEEPSEEK_API_KEY_ENV,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_FX_BASE_URL,
} from './balance.ts'
import type { AccountBalanceProviderOptions } from './balance.ts'
import { handleAccountBalanceHttp } from './http-route.ts'
import { ACCOUNT_BALANCE_PATH } from './protocol.ts'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-balance'

/** The transport seam this plugin registers its route on. */
export const inject = ['connection']

/** Plugin config (every field optional — the schema supplies the defaults). */
export interface Config {
  /** Credential reference resolved for each read. Defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Platform origin; `/user/balance` is appended. Defaults to the DeepSeek platform. */
  baseURL?: string
  /**
   * Currency the pill converts the total into, such as `INR`. Empty keeps the
   * account's own currency and skips the exchange-rate request entirely.
   */
  displayCurrency?: string
  /** Exchange-rate origin; `/latest` is appended. Defaults to the Frankfurter service. */
  fxBaseURL?: string
  /** Deadline for one read, in milliseconds. Defaults to 5000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_DEEPSEEK_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_DEEPSEEK_BASE_URL),
  displayCurrency: z.string().default(''),
  fxBaseURL: z.string().default(DEFAULT_FX_BASE_URL),
  timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_ACCOUNT_BALANCE_TIMEOUT_MS),
})

/**
 * Resolve the credential reference and the environment plane one plugin
 * instance reads, so every read resolves the key again rather than caching one:
 * a key stored after startup reaches the next read without a reload.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @returns the resolver the provider calls.
 */
function credentialPlane(
  ctx: Context,
  apiKeyEnv: CredentialRef,
): () => Promise<string | undefined> {
  return async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
    const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/**
 * Register the account-balance route. The route is registered whatever the
 * credential state: a deployment with no key answers the browser's own
 * "unavailable" outcome instead of a missing route.
 * @param ctx - Host plugin context carrying the Connection service.
 * @param config - resolved plugin config; the Loader supplies schema defaults,
 * hand-built contexts may pass none.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = config ?? {}
  const apiKeyEnv = credentialRef(resolved.apiKeyEnv ?? DEFAULT_DEEPSEEK_API_KEY_ENV)
  const resolveApiKey = credentialPlane(ctx, apiKeyEnv)
  const provider = new AccountBalanceProvider((): AccountBalanceProviderOptions => ({
    baseURL: resolved.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL,
    fxBaseURL: resolved.fxBaseURL ?? DEFAULT_FX_BASE_URL,
    displayCurrency: resolved.displayCurrency ?? '',
    timeoutMs: resolved.timeoutMs ?? DEFAULT_ACCOUNT_BALANCE_TIMEOUT_MS,
    apiKeyEnv,
    resolveApiKey,
  }))
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ACCOUNT_BALANCE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => handleAccountBalanceHttp(provider, request),
    }),
    'ui-balance: balance route',
  )
}
