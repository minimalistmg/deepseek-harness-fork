/**
 * The polish route through the real handler: request validation, the success
 * envelope, and one failure envelope per provider outcome. Requests and
 * responses are real `Request`/`Response` values; only the provider is a stub.
 */
import { describe, expect, it, vi } from 'vitest'
import { handleVoicePolishHttp } from '../src/http-route.ts'
import { VOICE_POLISH_PATH, type VoicePolishEnvelope } from '../src/protocol.ts'
import type { VoicePolishProvider, VoicePolishResult } from '../src/polish.ts'

/** A provider stub that answers every polish with one fixed result. */
function stub(result: VoicePolishResult) {
  const polish = vi.fn(async (): Promise<VoicePolishResult> => result)
  return { provider: { polish } as unknown as VoicePolishProvider, polish }
}

/** One request to the route path. */
function request(
  body: BodyInit | null,
  { method = 'POST', contentType = 'application/json' } = {},
): Request {
  return new Request(`http://dsh.internal${VOICE_POLISH_PATH}`, {
    method,
    ...body === null ? {} : { body },
    ...contentType === '' ? {} : { headers: { 'content-type': contentType } },
  })
}

/** The parsed envelope one response carries. */
async function envelopeOf(response: Response): Promise<VoicePolishEnvelope> {
  return await response.json() as VoicePolishEnvelope
}

describe('voice polish route', () => {
  it('answers with the polished text', async () => {
    const { provider, polish } = stub({ outcome: 'ok', text: 'Open file.js.' })
    const response = await handleVoicePolishHttp(provider, request(JSON.stringify({ text: 'um open file dot j s' })))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await envelopeOf(response)).toEqual({ ok: true, text: 'Open file.js.' })
    expect(polish).toHaveBeenCalledWith('um open file dot j s', expect.any(AbortSignal))
  })

  it('answers with the raw text and the outcome the browser reports', async () => {
    const cases = [
      ['unavailable', 'voice/polish-unavailable'],
      ['rate-limited', 'voice/polish-rate-limited'],
      ['timeout', 'voice/polish-timeout'],
      ['failed', 'voice/polish-failed'],
    ] as const
    for (const [outcome, code] of cases) {
      const { provider } = stub({ outcome, text: 'raw words' })
      const response = await handleVoicePolishHttp(provider, request(JSON.stringify({ text: 'raw words' })))
      expect(response.status).toBe(200)
      expect(await envelopeOf(response)).toEqual({
        ok: false,
        error: { code, message: `voice polish did not run (${outcome})`, details: {} },
      })
    }
  })

  it('refuses every method but POST', async () => {
    const { provider, polish } = stub({ outcome: 'ok', text: 'clean' })
    const response = await handleVoicePolishHttp(provider, request(null, { method: 'GET' }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(polish).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON at all', async () => {
    const { provider, polish } = stub({ outcome: 'ok', text: 'clean' })
    const response = await handleVoicePolishHttp(provider, request('raw words', { contentType: 'text/plain' }))
    expect(response.status).toBe(415)
    expect(await response.text()).toBe('content type must be application/json')
    expect(polish).not.toHaveBeenCalled()
  })

  it('refuses a JSON body it cannot read', async () => {
    const { provider } = stub({ outcome: 'ok', text: 'clean' })
    const response = await handleVoicePolishHttp(provider, request('{'))
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('body is not JSON')
  })

  it('refuses a body with no transcript', async () => {
    const { provider, polish } = stub({ outcome: 'ok', text: 'clean' })
    for (const body of ['{}', '{"text":""}', '{"text":7}', 'null']) {
      const response = await handleVoicePolishHttp(provider, request(body))
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('text must be a non-empty string')
    }
    expect(polish).not.toHaveBeenCalled()
  })
})
