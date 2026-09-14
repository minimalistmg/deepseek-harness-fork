// @vitest-environment jsdom
/**
 * The browser half of the polish pass: one POST to the host's Connection Fetch
 * route, the envelope mapping, and the identity fallback every failure shares.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { polish, send } from '../src/client/polish.ts'
import { VOICE_POLISH_CODE_RATE_LIMITED, VOICE_POLISH_PATH } from '../src/protocol.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Install one canned response for the next route call. */
function answer(response: Response): void {
  vi.mocked(fetch).mockResolvedValue(response)
}

/** One route response carrying the given envelope. */
function envelope(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

describe('polish request', () => {
  it('posts the transcript to the host route as JSON', async () => {
    answer(envelope({ ok: true, text: 'open file.js' }))
    expect(await send('um open the file dot j s')).toEqual({ text: 'open file.js', status: 'ok' })

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe(VOICE_POLISH_PATH)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json' })
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'um open the file dot j s' })
  })

  it('forwards the caller signal and omits an absent one', async () => {
    answer(envelope({ ok: true, text: 'clean' }))
    const controller = new AbortController()
    await send('raw', controller.signal)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal)

    vi.mocked(fetch).mockClear()
    answer(envelope({ ok: true, text: 'clean' }))
    await send('raw')
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).not.toHaveProperty('signal')
  })

  it('returns the submitted text when the pass resolves', async () => {
    answer(envelope({ ok: true, text: 'clean' }))
    expect(await polish('raw')).toBe('clean')
  })
})

describe('polish failures', () => {
  it('reads each failure code as its own seat state', async () => {
    const cases = [
      ['voice/polish-unavailable', 'unavailable'],
      [VOICE_POLISH_CODE_RATE_LIMITED, 'rate-limited'],
      ['voice/polish-timeout', 'timeout'],
      ['voice/polish-failed', 'failed'],
      ['voice/something-new', 'failed'],
    ] as const
    for (const [code, status] of cases) {
      answer(envelope({ ok: false, error: { code, message: 'no', details: {} } }))
      expect(await send('raw')).toEqual({ text: 'raw', status })
    }
  })

  it('reads an unmounted route as an unavailable polish', async () => {
    answer(new Response('not found', { status: 404 }))
    expect(await send('raw')).toEqual({ text: 'raw', status: 'unavailable' })
  })

  it('reads a refused request as a failure', async () => {
    answer(new Response('content type must be application/json', { status: 415 }))
    expect(await send('raw')).toEqual({ text: 'raw', status: 'failed' })
  })

  it('reads an unreadable envelope as a failure', async () => {
    answer(new Response('not json', { status: 200 }))
    expect(await send('raw')).toEqual({ text: 'raw', status: 'failed' })
  })

  it('reads a transport fault as a failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await send('raw')).toEqual({ text: 'raw', status: 'failed' })
  })

  it('reads caller cancellation as a failure and keeps the transcript', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('aborted', 'AbortError'))
    expect(await polish('raw')).toBe('raw')
  })
})
