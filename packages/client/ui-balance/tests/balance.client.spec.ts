/**
 * The browser half's reader: how one route response maps onto the pill's states.
 */
import { describe, expect, it, vi } from 'vitest'
import { requestBalance, type BalanceEnvironment } from '../src/client/balance.ts'
import {
  ACCOUNT_BALANCE_CODE_FAILED,
  ACCOUNT_BALANCE_CODE_TIMEOUT,
  ACCOUNT_BALANCE_CODE_UNAVAILABLE,
  ACCOUNT_BALANCE_PATH,
} from '../src/protocol.ts'

/** A transport answering with one prepared response. */
function transport(answer: Response | Error): BalanceEnvironment {
  return vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
}

/** The report one successful envelope carries. */
const report = { available: true, currency: 'USD', total: '12.34', granted: '0', toppedUp: '12.34' }

describe('requestBalance', () => {
  it('reads the balance off the plugin route', async () => {
    const environment = transport(Response.json({ ok: true, report }))
    expect(await requestBalance(environment)).toEqual({ status: 'ready', report })
    expect(vi.mocked(environment).mock.calls[0]?.[0]).toBe(ACCOUNT_BALANCE_PATH)
  })

  it('reports a deployment with nothing to read as unavailable', async () => {
    const environment = transport(Response.json({
      ok: false,
      error: { code: ACCOUNT_BALANCE_CODE_UNAVAILABLE, message: 'no key', details: {} },
    }))
    expect(await requestBalance(environment)).toEqual({ status: 'unavailable' })
  })

  it('reports every other failure code as a failure', async () => {
    for (const code of [ACCOUNT_BALANCE_CODE_TIMEOUT, ACCOUNT_BALANCE_CODE_FAILED]) {
      const environment = transport(Response.json({ ok: false, error: { code, message: 'x', details: {} } }))
      expect(await requestBalance(environment)).toEqual({ status: 'failed' })
    }
  })

  it('reports a refused, unreadable, or unreachable route as a failure', async () => {
    expect(await requestBalance(transport(new Response('nope', { status: 404 })))).toEqual({ status: 'failed' })
    expect(await requestBalance(transport(new Response('not json', { status: 200 })))).toEqual({ status: 'failed' })
    expect(await requestBalance(transport(new Error('refused')))).toEqual({ status: 'failed' })
  })
})
