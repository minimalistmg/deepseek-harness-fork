/**
 * The account-balance provider: one credentialed platform read, its failure
 * outcomes, and the optional currency conversion. The transport is stubbed, so
 * every case states the answers the platform and the rate service gave.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  AccountBalanceProvider, reportedBalance, type AccountBalanceProviderOptions,
} from '../src/balance.ts'

/**
 * Read the conversion out of a result, or undefined when the read reported
 * none. The value is read structurally because a test file's cross-module result
 * type does not resolve for the type-aware linter.
 * @param result - the provider's result.
 * @returns the conversion, when one was applied.
 */
function fxOf(result: unknown): unknown {
  return (result as { readonly report?: { readonly fx?: unknown } }).report?.fx
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** One balance response body as the platform writes it. */
function platformBody(overrides: Record<string, unknown> = {}) {
  return {
    is_available: true,
    balance_infos: [{
      currency: 'USD',
      total_balance: '12.34',
      granted_balance: '2.34',
      topped_up_balance: '10.00',
    }],
    ...overrides,
  }
}

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

/** The request init one recorded call carried. */
function callInit(index = 0): RequestInit {
  /* v8 ignore next -- every case makes the call it then reads. */
  return vi.mocked(fetch).mock.calls[index]?.[1] ?? {}
}

describe('balance read', () => {
  it('reads the first reported balance with its buckets', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(platformBody()))
    const result = await provider().read()
    expect(result).toEqual({
      outcome: 'ok',
      report: { available: true, currency: 'USD', total: '12.34', granted: '2.34', toppedUp: '10.00' },
    })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://platform.example/user/balance')
    expect(callInit().redirect).toBe('error')
    expect(callInit().headers).toHaveProperty('authorization', 'Bearer account-key')
  })

  it('reports no usable row as a failure', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ balance_infos: [] }))
    expect(await provider().read()).toEqual({ outcome: 'failed' })
  })

  it('fills an omitted bucket with zero', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      is_available: false,
      balance_infos: [{ currency: 'CNY', total_balance: '1.00' }],
    }))
    expect(await provider().read()).toEqual({
      outcome: 'ok',
      report: { available: false, currency: 'CNY', total: '1.00', granted: '0', toppedUp: '0' },
    })
  })

  it('reports a refused request as a failure', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 401 }))
    expect(await provider().read()).toEqual({ outcome: 'failed' })
  })

  it('reports a body that is not JSON as a failure', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', { status: 200 }))
    expect(await provider().read()).toEqual({ outcome: 'failed' })
  })

  it('reports a transport fault as a failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('refused'))
    expect(await provider().read()).toEqual({ outcome: 'failed' })
  })

  it('names its own deadline', async () => {
    // A request that outlives its deadline is aborted by the deadline itself,
    // which is the only failure this provider distinguishes by name.
    vi.mocked(fetch).mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const result = await provider({ timeoutMs: 10 }).read()
    expect(result).toEqual({ outcome: 'timeout' })
  })

  it('reports no credential as unavailable without calling the platform', async () => {
    expect(await keylessProvider().read()).toEqual({ outcome: 'unavailable' })
    expect(await provider({ resolveApiKey: async () => '' }).read()).toEqual({ outcome: 'unavailable' })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })
})

describe('display currency', () => {
  it('converts the total when a display currency is configured', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(platformBody()))
      .mockResolvedValueOnce(Response.json({ rates: { INR: 88.5 } }))
    const result = await provider({ displayCurrency: 'INR' }).read()
    expect(fxOf(result)).toEqual({ currency: 'INR', rate: 88.5, converted: '1092.09' })
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe('https://rates.example/latest?from=USD&to=INR')
  })

  it('skips the rate request when the display currency is the account currency', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(platformBody()))
    const result = await provider({ displayCurrency: 'USD' }).read()
    expect(fxOf(result)).toBeUndefined()
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('keeps the balance when the rate service refuses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(platformBody()))
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
    const result = await provider({ displayCurrency: 'INR' }).read()
    expect(result.outcome).toBe('ok')
    expect(fxOf(result)).toBeUndefined()
  })

  it('keeps the balance when the rate service cannot be reached', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(platformBody()))
      .mockRejectedValueOnce(new Error('refused'))
    expect(fxOf(await provider({ displayCurrency: 'INR' }).read())).toBeUndefined()
  })

  it('keeps the balance when the rates are unreadable', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(platformBody()))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
    expect(fxOf(await provider({ displayCurrency: 'INR' }).read())).toBeUndefined()
  })

  it('keeps the balance when the rate is missing or unusable', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(platformBody()))
      .mockResolvedValueOnce(Response.json({ rates: { EUR: 0.9 } }))
    expect(fxOf(await provider({ displayCurrency: 'INR' }).read())).toBeUndefined()

    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json(platformBody()))
      .mockResolvedValueOnce(Response.json({ rates: { INR: 'eighty' } }))
    expect(fxOf(await provider({ displayCurrency: 'INR' }).read())).toBeUndefined()

    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ ...platformBody(), balance_infos: [{ currency: 'USD', total_balance: 'many' }] }))
      .mockResolvedValueOnce(Response.json({ rates: { INR: 88.5 } }))
    expect(fxOf(await provider({ displayCurrency: 'INR' }).read())).toBeUndefined()
  })
})

describe('reportedBalance', () => {
  it('refuses a row without a usable currency or total', () => {
    expect(reportedBalance({ balance_infos: [{ total_balance: '1.00' }] })).toBeUndefined()
    expect(reportedBalance({ balance_infos: [{ currency: '', total_balance: '1.00' }] })).toBeUndefined()
    expect(reportedBalance({ balance_infos: [{ currency: 'USD' }] })).toBeUndefined()
    expect(reportedBalance({})).toBeUndefined()
  })

  it('treats a missing availability flag as unusable', () => {
    expect(reportedBalance({ balance_infos: [{ currency: 'USD', total_balance: '1.00' }] })?.available).toBe(false)
  })
})
