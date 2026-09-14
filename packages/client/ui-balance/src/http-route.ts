/** Authenticated account-balance route registered on the Connection fetch registry. */

import {
  ACCOUNT_BALANCE_CODE_FAILED,
  ACCOUNT_BALANCE_CODE_TIMEOUT,
  ACCOUNT_BALANCE_CODE_UNAVAILABLE,
  ACCOUNT_BALANCE_MEDIA_TYPE,
} from './protocol.ts'
import type { AccountBalanceEnvelope } from './protocol.ts'
import type { AccountBalanceOutcome, AccountBalanceProvider } from './balance.ts'

/** One stable code per failure outcome. */
const FAILURE_CODES: Readonly<Record<Exclude<AccountBalanceOutcome, 'ok'>, string>> = {
  'unavailable': ACCOUNT_BALANCE_CODE_UNAVAILABLE,
  'timeout': ACCOUNT_BALANCE_CODE_TIMEOUT,
  'failed': ACCOUNT_BALANCE_CODE_FAILED,
}

/**
 * Handle one authenticated account-balance read.
 * @param provider - Host reader serving the request.
 * @param request - authenticated HTTP request from Connection.
 * @returns the balance envelope, or a status for a method this route does not carry.
 */
export async function handleAccountBalanceHttp(
  provider: AccountBalanceProvider,
  request: Request,
): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } })
  }
  const result = await provider.read(request.signal)
  if (result.outcome !== 'ok') return jsonResponse(failureEnvelope(result.outcome))
  return jsonResponse({ ok: true, report: result.report })
}

/** Build the failure envelope one failed outcome reports. */
function failureEnvelope(outcome: Exclude<AccountBalanceOutcome, 'ok'>): AccountBalanceEnvelope {
  return {
    ok: false,
    error: {
      code: FAILURE_CODES[outcome],
      message: `account balance did not load (${outcome})`,
      details: {},
    },
  }
}

/** Serialize one envelope; a balance reading is never cached by an intermediary. */
function jsonResponse(envelope: AccountBalanceEnvelope): Response {
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: {
      'content-type': `${ACCOUNT_BALANCE_MEDIA_TYPE}; charset=utf-8`,
      'cache-control': 'no-store',
    },
  })
}
