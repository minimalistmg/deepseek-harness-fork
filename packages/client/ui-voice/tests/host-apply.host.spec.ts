// @vitest-environment jsdom
/**
 * The ui-voice host half: the polish route as a Connection Fetch registration,
 * the credential and environment planes key resolution reads, and the
 * configuration defaults that reach the provider. The browser half's own
 * composition is this package's `browser-plugin.client.spec.ts`, which the
 * client program compiles; a host program must not reach into it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { apply, Config, inject, name } from '../src/index.ts'
import { VOICE_LIVE_PATH } from '../src/live-protocol.ts'
import { VOICE_POLISH_PATH, type VoicePolishEnvelope } from '../src/protocol.ts'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A host context carrying a recording Connection fetch registry and settings service. */
function hostBench() {
  const routes: ConnectionFetchRoute[] = []
  const register = vi.fn()
  const ctx = new Context()
  const dispose = vi.fn(async (): Promise<void> => { await Promise.resolve() })
  ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
    routes.push(route)
    return dispose
  } } } as never)
  ctx.provide('settings', { register } as never)
  return { ctx, routes, dispose, register }
}

/** One polish request against the registered route. */
function request(text: string): Request {
  return new Request(`http://dsh.internal${VOICE_POLISH_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

/** One live request with no audio in it, which the route answers at once. */
function liveRequest(): Request {
  return new Request(`http://dsh.internal${VOICE_LIVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: '',
    duplex: 'half',
  } as RequestInit)
}

/** The environment snapshot one launcher would provide. */
function environment(values: Readonly<Record<string, string>>) {
  return { get: (key: string) => (values[key] === undefined ? undefined : { value: values[key] }), getFrom: () => undefined }
}

describe('ui-voice host apply', () => {
  it('declares the Connection service and its plugin name', () => {
    expect(name).toBe('ui-voice')
    expect(inject).toEqual(['connection'])
  })

  it('declares every tunable with its shipped default', () => {
    const resolved = Config({})
    expect(resolved.polishPrompt).toContain('You clean short voice transcripts')
    expect(resolved).toEqual({
      apiKeyEnv: 'GEMINI_API_KEY',
      baseURL: 'https://generativelanguage.googleapis.com',
      polishModel: 'gemini-3.6-flash',
      liveModel: 'gemini-3.5-transcribe-live',
      polishEnabled: true,
      webSpeechEnabled: false,
      polishPrompt: resolved.polishPrompt,
      maxOutputTokens: 2048,
      timeoutMs: 8000,
      flushWindowMs: 1000,
      idleTimeoutMs: 480_000,
      settleMs: 220,
      connectTimeoutMs: 10_000,
      closeTimeoutMs: 2000,
      maxUtteranceBytes: 8 * 1024 * 1024,
    })
  })

  it('registers the live route as a streaming POST and the polish route as a buffered one', async () => {
    const b = hostBench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.routes).toHaveLength(2)
    const live = b.routes.find(route => route.path === VOICE_LIVE_PATH)!
    expect(live.methods).toEqual(['POST'])
    expect(live.requestBody).toBe('streaming')
    expect(typeof live.fetch).toBe('function')
    const polish = b.routes.find(route => route.path === VOICE_POLISH_PATH)!
    expect(polish.requestBody).toBe('buffered')

    await fiber.dispose()
    expect(b.dispose).toHaveBeenCalledTimes(2)
  })

  it('answers the live route with one error frame when no credential resolves', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({}))
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const live = b.routes.find(route => route.path === VOICE_LIVE_PATH)!
    const response = await live.fetch(liveRequest())
    expect(await response.text()).toBe(
      '{"type":"error","code":"voice/live-unavailable","message":"no GEMINI_API_KEY credential is configured"}\n',
    )
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('answers with the raw transcript when the ambient environment holds no key', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({}))
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const response = await b.routes.find(route => route.path === VOICE_POLISH_PATH)!.fetch(request('raw words'))
    expect(await response.json() as VoicePolishEnvelope).toEqual({
      ok: false,
      error: { code: 'voice/polish-unavailable', message: 'voice polish did not run (unavailable)', details: {} },
    })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('polishes through the ambient environment key when no credentials service exists', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({ GEMINI_API_KEY: 'ambient-key' }))
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    vi.mocked(fetch).mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: 'Open file.js.' }] } }] }))

    const response = await b.routes.find(route => route.path === VOICE_POLISH_PATH)!.fetch(request('um open the file'))
    expect(await response.json() as VoicePolishEnvelope).toEqual({ ok: true, text: 'Open file.js.' })
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toHaveProperty('x-goog-api-key', 'ambient-key')
  })

  it('prefers the credentials service over the ambient environment', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({ GEMINI_API_KEY: 'ambient-key' }))
    const resolve = vi.fn(async () => ({ value: 'stored-key', source: 'user' }))
    b.ctx.provide('credentials', { resolve } as never)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    vi.mocked(fetch).mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: 'Open file.js.' }] } }] }))

    await b.routes.find(route => route.path === VOICE_POLISH_PATH)!.fetch(request('um open the file'))
    expect(resolve).toHaveBeenCalledWith('GEMINI_API_KEY')
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toHaveProperty('x-goog-api-key', 'stored-key')
  })

  it('honors a configured credential reference', async () => {
    const b = hostBench()
    const resolve = vi.fn(async () => ({ value: 'other-key', source: 'user' }))
    b.ctx.provide('credentials', { resolve } as never)
    await b.ctx.plugin({
      inject: [...inject],
      apply: (ctx) => { apply(ctx, { apiKeyEnv: 'MY_GEMINI_KEY' }) },
    }).await()
    vi.mocked(fetch).mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: 'clean' }] } }] }))
    await b.routes.find(route => route.path === VOICE_POLISH_PATH)!.fetch(request('raw'))
    expect(resolve).toHaveBeenCalledWith('MY_GEMINI_KEY')
  })

  it('returns the raw transcript unchanged when polish is disabled', async () => {
    const b = hostBench()
    b.ctx.provide('launchEnvironment', environment({ GEMINI_API_KEY: 'ambient-key' }))
    await b.ctx.plugin({
      inject: [...inject],
      apply: (ctx) => { apply(ctx, { polishEnabled: false }) },
    }).await()
    const response = await b.routes.find(route => route.path === VOICE_POLISH_PATH)!.fetch(request('raw words'))
    expect(await response.json() as VoicePolishEnvelope).toEqual({
      ok: false,
      error: { code: 'voice/polish-unavailable', message: 'voice polish did not run (unavailable)', details: {} },
    })
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('disposes the live session with the fiber', async () => {
    const b = hostBench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // The session's own effect is the third registration the plugin leaves.
    await fiber.dispose()
    expect(b.dispose).toHaveBeenCalledTimes(2)
  })

  it('registers the durable voice preferences when a settings provider exists', async () => {
    const b = hostBench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const [namespace, schema] = b.register.mock.calls[0] as [string, (value: unknown) => unknown]
    expect(namespace).toBe('ui-voice')
    // The registered schema supplies the shipped defaults the browser half reads.
    expect(schema({})).toEqual({
      pushToTalk: 'Alt+V',
      autoSend: true,
      silenceMs: 1500,
      cleanup: true,
      spokenSend: true,
    })
  })
})
