/**
 * The ui-balance host half: the route as a Connection Fetch registration, the
 * configuration defaults that reach the provider, and the credential planes
 * key resolution reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { apply, Config, inject, name } from '../src/index.ts'
import { ACCOUNT_BALANCE_PATH, type AccountBalanceEnvelope } from '../src/protocol.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A host context carrying a recording Connection fetch registry. */
function hostBench() {
  const routes: ConnectionFetchRoute[] = []
  const ctx = new Context()
  const dispose = vi.fn(async (): Promise<void> => { await Promise.resolve() })
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
    routes.push(route)
    return dispose
  } } } as never)
  return { ctx, routes, dispose }
}

/** The environment snapshot one launcher would provide. */
function environment(values: Readonly<Record<string, string>>) {
  return { get: (key: string) => (values[key] === undefined ? undefined : { value: values[key] }), getFrom: () => undefined }
}

/** One read against the registered route. */
function request(): Request {
  return new Request(`http://dsh.internal${ACCOUNT_BALANCE_PATH}`, { method: 'GET' })
}

describe('ui-balance host apply', () => {
  it('declares the Connection service and its plugin name', () => {
    expect(name).toBe('ui-balance')
    expect(inject).toEqual(['connection'])
  })

  it('declares every tunable with its shipped default', () => {
    expect(Config({})).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      displayCurrency: '',
      fxBaseURL: 'https://api.frankfurter.app',
      timeoutMs: 5000,
    })
  })

  it('registers one buffered GET route and withdraws it with the fiber', async () => {
    const b = hostBench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.routes).toHaveLength(1)
    expect(b.routes[0]?.path).toBe(ACCOUNT_BALANCE_PATH)
    expect(b.routes[0]?.methods).toEqual(['GET'])
    expect(b.routes[0]?.requestBody).toBe('buffered')

    await fiber.dispose()
    expect(b.dispose).toHaveBeenCalledTimes(1)
  })

  it('answers unavailable when the ambient environment holds no key', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({}))
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const response = await b.routes[0]!.fetch(request())
    expect(await response.json() as AccountBalanceEnvelope).toMatchObject({
      ok: false,
      error: { code: 'account/balance-unavailable' },
    })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('reads through the ambient environment key', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({ DEEPSEEK_API_KEY: 'ambient-key' }))
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    vi.mocked(fetch).mockResolvedValue(Response.json({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '5.00', granted_balance: '0', topped_up_balance: '5.00' }],
    }))
    const response = await b.routes[0]!.fetch(request())
    expect(await response.json() as AccountBalanceEnvelope).toMatchObject({ ok: true })
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toHaveProperty('authorization', 'Bearer ambient-key')
  })

  it('prefers the credentials service over the ambient environment', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({ DEEPSEEK_API_KEY: 'ambient-key' }))
    const resolve = vi.fn(async () => ({ value: 'stored-key', source: 'user' }))
    b.ctx.provide('credentials', { resolve } as never)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    vi.mocked(fetch).mockResolvedValue(Response.json({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '5.00' }],
    }))
    await b.routes[0]!.fetch(request())
    expect(resolve).toHaveBeenCalledWith('DEEPSEEK_API_KEY')
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toHaveProperty('authorization', 'Bearer stored-key')
  })

  it('honors the configured credential reference and display currency', async () => {
    const b = hostBench()
    const resolve = vi.fn(async () => ({ value: 'other-key', source: 'user' }))
    b.ctx.provide('credentials', { resolve } as never)
    await b.ctx.plugin({
      inject: [...inject],
      apply: (ctx) => { apply(ctx, { apiKeyEnv: 'MY_DEEPSEEK_KEY', displayCurrency: 'INR', baseURL: 'https://probe.example' }) },
    }).await()
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '2.00' }],
      }))
      .mockResolvedValueOnce(Response.json({ rates: { INR: 80 } }))
    const response = await b.routes[0]!.fetch(request())
    expect(resolve).toHaveBeenCalledWith('MY_DEEPSEEK_KEY')
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://probe.example/user/balance')
    expect(await response.json() as AccountBalanceEnvelope).toMatchObject({
      ok: true,
      report: { fx: { currency: 'INR', converted: '160.00' } },
    })
  })
})
