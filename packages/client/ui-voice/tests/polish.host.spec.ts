/**
 * The host polish provider: the Gemini request it sends, the response mapping,
 * and the identity fallback every failure arm shares. The deadline arms drive
 * the real `deadline` signal rather than a stubbed timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  candidateText, cleanPolishedText, DEFAULT_GEMINI_POLISH_MODEL, fenceBody,
  VoicePolishProvider, type VoicePolishProviderOptions,
} from '../src/polish.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const raw = 'um so like open the the file dot j s'

/** One request body the provider sends for `raw`. */
interface SentBody {
  readonly systemInstruction: { readonly parts: readonly [{ readonly text: string }] }
  readonly contents: readonly [{ readonly role: string; readonly parts: readonly [{ readonly text: string }] }]
  readonly generationConfig: { readonly temperature: number; readonly maxOutputTokens: number }
}

/** Provider options with a resolvable key unless the case overrides it. */
function options(overrides: Partial<VoicePolishProviderOptions> = {}): VoicePolishProviderOptions {
  return {
    baseURL: 'https://gemini.invalid',
    model: DEFAULT_GEMINI_POLISH_MODEL,
    prompt: 'clean it up',
    maxOutputTokens: 2048,
    temperature: 0.2,
    timeoutMs: 5000,
    apiKeyEnv: credentialRef('GEMINI_API_KEY'),
    resolveApiKey: async () => 'probe-key',
    ...overrides,
  }
}

/** A provider over fixed options. */
const provider = (overrides: Partial<VoicePolishProviderOptions> = {}) =>
  new VoicePolishProvider(() => options(overrides))

/**
 * A provider in a deployment with no credential plane, where the options carry
 * no resolver at all.
 * @returns the provider.
 */
function keylessProvider(): VoicePolishProvider {
  const { resolveApiKey: _absent, ...rest } = options()
  return new VoicePolishProvider(() => rest)
}

/** One `generateContent` response carrying the given candidates. */
function answer(candidates: unknown, status = 200): Response {
  return Response.json({ candidates }, { status })
}

/** The body the provider last sent. */
function sentBody(): SentBody {
  return JSON.parse(vi.mocked(fetch).mock.calls[0]?.[1]?.body as string) as SentBody
}

describe('polish request', () => {
  it('posts the prompt, the transcript, and the generation bounds to the model endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(answer([{ content: { parts: [{ text: 'Open file.js.' }] } }]))
    expect(await provider().polish(raw)).toEqual({ outcome: 'ok', text: 'Open file.js.' })

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe(`https://gemini.invalid/v1beta/models/${DEFAULT_GEMINI_POLISH_MODEL}:generateContent`)
    expect(init?.method).toBe('POST')
    // The key rides a header, so it never reaches a URL or a log line.
    expect(init?.headers).toEqual({
      'x-goog-api-key': 'probe-key',
      'content-type': 'application/json',
      accept: 'application/json',
    })
    expect(init?.redirect).toBe('error')
    expect(url).not.toContain('probe-key')
    expect(sentBody()).toEqual({
      systemInstruction: { parts: [{ text: 'clean it up' }] },
      contents: [{ role: 'user', parts: [{ text: raw }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    })
  })

  it('reads one transcript per call without caching the credential', async () => {
    const resolveApiKey = vi.fn(async () => 'first')
    const one = provider({ resolveApiKey })
    vi.mocked(fetch).mockResolvedValue(answer([{ content: { parts: [{ text: 'clean' }] } }]))
    await one.polish(raw)
    resolveApiKey.mockResolvedValue('second')
    await one.polish(raw)
    expect(resolveApiKey).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls[1]?.[1]?.headers).toHaveProperty('x-goog-api-key', 'second')
  })
})

describe('polish response mapping', () => {
  it('joins every part of the first candidate and trims the result', async () => {
    vi.mocked(fetch).mockResolvedValue(answer([
      { content: { parts: [{ text: '  Fix ' }, { text: 'getUserId.  ' }] } },
      { content: { parts: [{ text: 'ignored' }] } },
    ]))
    expect(await provider().polish(raw)).toEqual({ outcome: 'ok', text: 'Fix getUserId.' })
  })

  it('keeps a thinking model answer that stopped at the token cap', async () => {
    // `finishReason: MAX_TOKENS` is a short answer, not an empty one: the
    // thinking tokens consumed the rest of the budget, and the words that did
    // arrive are the speaker's.
    vi.mocked(fetch).mockResolvedValue(Response.json({
      candidates: [{ content: { parts: [{ text: 'Open file.js and fix the bug' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { candidatesTokenCount: 8, thoughtsTokenCount: 186 },
    }))
    expect(await provider().polish(raw)).toEqual({
      outcome: 'ok',
      text: 'Open file.js and fix the bug',
    })
  })

  it('unwraps quotes, backticks, and one fenced block', async () => {
    const cases = [
      ['"Open file.js."', 'Open file.js.'],
      ['`Open file.js.`', 'Open file.js.'],
      ['```\nOpen file.js.\n```', 'Open file.js.'],
      ['```js\nconst x = 1\n```', 'const x = 1'],
      ['```js\n```', ''],
      ['keep "quoted" words', 'keep "quoted" words'],
      ['```js\nprose\n``` and more', '```js\nprose\n``` and more'],
      ['```js const x = 1```', '```js const x = 1```'],
      ['```not a tag\nprose\n```', '```not a tag\nprose\n```'],
      ['"', '"'],
    ] as const
    for (const [text, expected] of cases) {
      vi.mocked(fetch).mockResolvedValue(answer([{ content: { parts: [{ text }] } }]))
      expect(await provider().polish(raw)).toEqual({ outcome: 'ok', text: expected })
    }
  })
})

describe('polish failure arms', () => {
  it('returns the transcript unchanged when no key resolves', async () => {
    expect(await provider({ resolveApiKey: async () => undefined }).polish(raw))
      .toEqual({ outcome: 'unavailable', text: raw })
    expect(await provider({ resolveApiKey: async () => '' }).polish(raw))
      .toEqual({ outcome: 'unavailable', text: raw })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('returns the transcript unchanged when no credential plane exists', async () => {
    expect(await keylessProvider().polish(raw))
      .toEqual({ outcome: 'unavailable', text: raw })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('names the provider quota refusal and does not retry', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }],
      },
    }, { status: 429 }))
    expect(await provider().polish(raw)).toEqual({ outcome: 'rate-limited', text: raw })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
  })

  it('returns the transcript unchanged on any other refusal', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('bad key', { status: 400 }))
    expect(await provider().polish(raw)).toEqual({ outcome: 'failed', text: raw })
  })

  it('returns the transcript unchanged on a transport fault', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))
    expect(await provider().polish(raw)).toEqual({ outcome: 'failed', text: raw })
  })

  it('returns the transcript unchanged on an unreadable body', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', { status: 200 }))
    expect(await provider().polish(raw)).toEqual({ outcome: 'failed', text: raw })
  })

  it('returns the transcript unchanged when the deadline elapses', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'))
      })
    }))
    expect(await provider({ timeoutMs: 5 }).polish(raw)).toEqual({ outcome: 'timeout', text: raw })
  })

  it('returns the transcript unchanged on caller cancellation', async () => {
    const controller = new AbortController()
    vi.mocked(fetch).mockImplementation(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    expect(await provider().polish(raw, controller.signal)).toEqual({ outcome: 'failed', text: raw })
  })

  it('returns the transcript unchanged when the answer carries no text', async () => {
    const cases = [
      {},
      { candidates: [] },
      { candidates: [{}] },
      { candidates: [{ content: { parts: [{ text: '   ' }] } }] },
      { candidates: [{ content: { parts: [{ thought: true }] } }] },
    ]
    for (const body of cases) {
      vi.mocked(fetch).mockResolvedValue(Response.json(body))
      expect(await provider().polish(raw)).toEqual({ outcome: 'failed', text: raw })
    }
  })
})

describe('response helpers', () => {
  it('returns undefined for a body with no candidate text', () => {
    expect(candidateText({})).toBeUndefined()
    expect(cleanPolishedText({ candidates: [] })).toBeUndefined()
  })

  it('returns undefined for text that is not one fenced block', () => {
    expect(fenceBody('```')).toBeUndefined()
    expect(fenceBody('not fenced at all')).toBeUndefined()
  })
})
