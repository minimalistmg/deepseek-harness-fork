/**
 * The balance route: method validation, and one envelope per provider outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountBalanceProvider, type AccountBalanceProviderOptions } from '../src/balance.ts'
import { handleAccountBalanceHttp } from '../src/http-route.ts'
import {
  ACCOUNT_BALANCE_CODE_FAILED,
  ACCOUNT_BALANCE_CODE_TIMEOUT,
  ACCOUNT_BALANCE_CODE_UNAVAILABLE,
  ACCOUNT_BALANCE_MEDIA_TYPE,
  ACCOUNT_BALANCE_PATH,
  type AccountBalanceEnvelope,
} from '../src/protocol.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** One resolved option set, with a resolvable key unless the case overrides it. */
function options(overrides: Partial<AccountBalanceProviderOptions> = {}): AccountBalanceProviderOptions {
  return {
    baseURL: 'https://platform.example',
    fxBaseURL: 'https://rates.example',
    displayCurrency: '',
    timeoutMs: 5000,
    apiKeyEnv: credentialRef('DEEPSEEK_API_KEY'),
    resolveApiKey: async () => 'account-key',
    ...overrides,
  }
}

/** A provider over one resolved option set. */
function provider(overrides: Partial<AccountBalanceProviderOptions> = {}) {
  const resolved = options(overrides)
  return new AccountBalanceProvider(() => resolved)
}

/**
 * A provider in a deployment with no credential plane, where the options carry
 * no resolver at all.
 * @returns the provider.
 */
function keylessProvider(): AccountBalanceProvider {
  const { resolveApiKey: _absent, ...rest } = options()
  return new AccountBalanceProvider(() => rest)
}

/** One GET against the route. */
function request(method = 'GET'): Request {
  return new Request(`http://dsh.internal${ACCOUNT_BALANCE_PATH}`, { method })
}

describe('handleAccountBalanceHttp', () => {
  it('refuses a method this route does not carry', async () => {
    const response = await handleAccountBalanceHttp(provider(), request('POST'))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })

  it('answers the balance with no-store', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
    }))
    const response = await handleAccountBalanceHttp(provider(), request())
    expect(response.headers.get('content-type')).toBe(`${ACCOUNT_BALANCE_MEDIA_TYPE}; charset=utf-8`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json() as AccountBalanceEnvelope).toEqual({
      ok: true,
      report: { available: true, currency: 'USD', total: '12.34', granted: '0', toppedUp: '12.34' },
    })
  })

  it('names each failure outcome', async () => {
    const unavailable = await handleAccountBalanceHttp(keylessProvider(), request())
    const refusal = await unavailable.json() as AccountBalanceEnvelope
    if (refusal.ok) throw new Error('expected a refusal envelope')
    expect(refusal.error.code).toBe(ACCOUNT_BALANCE_CODE_UNAVAILABLE)
    expect(refusal.error.message).toContain('unavailable')
    expect(refusal.error.details).toEqual({})

    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 500 }))
    const failed = await handleAccountBalanceHttp(provider(), request())
    expect((await failed.json() as AccountBalanceEnvelope)).toMatchObject({
      ok: false,
      error: { code: ACCOUNT_BALANCE_CODE_FAILED },
    })

    vi.mocked(fetch).mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const timedOut = await handleAccountBalanceHttp(provider({ timeoutMs: 5 }), request())
    expect((await timedOut.json() as AccountBalanceEnvelope)).toMatchObject({
      ok: false,
      error: { code: ACCOUNT_BALANCE_CODE_TIMEOUT },
    })
  })
})
