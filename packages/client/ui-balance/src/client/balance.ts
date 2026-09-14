/**
 * The browser half's reader for the account-balance route: one GET on the
 * shared `/api` channel, mapped onto the pill's states. The plugin's host half
 * owns the credential, so this module knows only the route path.
 * @module @deepseek-ai/dsh-client-ui-balance/client/balance
 */

import {
  ACCOUNT_BALANCE_CODE_UNAVAILABLE,
  ACCOUNT_BALANCE_MEDIA_TYPE,
  ACCOUNT_BALANCE_PATH,
} from '../protocol.ts'
import type { AccountBalanceEnvelope, AccountBalanceReport } from '../protocol.ts'

/** What the pill renders. */
export type BalanceState =
  /** The read is in flight; the pill renders nothing yet. */
  | { readonly status: 'loading' }
  /** The balance read back. */
  | { readonly status: 'ready'; readonly report: AccountBalanceReport }
  /** This deployment has no balance to read, so the pill stays absent. */
  | { readonly status: 'unavailable' }
  /** The read failed; the pill offers a retry. */
  | { readonly status: 'failed' }

/** The transport surface one read drives; the default reaches the global `fetch`. */
export type BalanceEnvironment = (input: string, init: RequestInit) => Promise<Response>

/**
 * Read the account balance through the plugin's route.
 * @param signal - caller cancellation, which reports no state of its own.
 * @returns the state the pill renders; an aborted read answers `'failed'` to nobody.
 */
export async function readBalance(signal?: AbortSignal): Promise<BalanceState> {
  return await requestBalance(async (input, init) => await fetch(input, init), signal)
}

/**
 * Read the account balance over one transport.
 * @param environment - the transport to drive.
 * @param signal - caller cancellation, which reports no state of its own.
 * @returns the state the pill renders.
 */
export async function requestBalance(
  environment: BalanceEnvironment,
  signal?: AbortSignal,
): Promise<BalanceState> {
  let response: Response
  try {
    response = await environment(ACCOUNT_BALANCE_PATH, {
      method: 'GET',
      headers: { accept: ACCOUNT_BALANCE_MEDIA_TYPE },
      signal: signal ?? null,
    })
  } catch {
    return { status: 'failed' }
  }
  if (!response.ok) return { status: 'failed' }
  let envelope: AccountBalanceEnvelope
  try {
    envelope = await response.json() as AccountBalanceEnvelope
  } catch {
    return { status: 'failed' }
  }
  if (envelope.ok) return { status: 'ready', report: envelope.report }
  return { status: envelope.error.code === ACCOUNT_BALANCE_CODE_UNAVAILABLE ? 'unavailable' : 'failed' }
}
