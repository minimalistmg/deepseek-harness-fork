/**
 * The live dictation session's lifecycle: one utterance per socket, the
 * replacement that keeps the next click immediate, the flush window that lets
 * late finals arrive, the idle drop, and a teardown that reaches quiescence —
 * a disposed session holds no open socket and delivers nothing afterwards.
 * The provider transport is a controllable stub; every timer is real but short.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { isMissingKey, VoiceLiveSession } from '../src/live-session.ts'
import type { VoiceLiveSessionOptions, VoiceLiveUtterance } from '../src/live-session.ts'
import type { VoiceLiveOutputFrame } from '../src/live-protocol.ts'
import { SocketRegistry } from './live-socket-stub.host.ts'
import type { FakeSocket } from './live-socket-stub.host.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A session under test plus the registry its provider sockets come from. */
function bench(overrides: Partial<VoiceLiveSessionOptions> = {}) {
  const registry = new SocketRegistry()
  const resolveApiKey = vi.fn(async () => 'test-key')
  const session = new VoiceLiveSession({
    baseURL: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.5-transcribe-live',
    flushWindowMs: 20,
    idleTimeoutMs: 40,
    connectTimeoutMs: 200,
    closeTimeoutMs: 200,
    maxUtteranceBytes: 1024 * 1024,
    apiKeyEnv: credentialRef('GEMINI_API_KEY'),
    resolveApiKey,
    ctor: registry.ctor,
    ...overrides,
  })
  return { registry, session, resolveApiKey }
}

/**
 * Open one utterance and hand back the transport it claimed.
 * @param session - the session under test.
 * @param registry - the registry its provider sockets come from.
 * @returns the listening handle and the transport that utterance owns.
 */
async function open(
  session: VoiceLiveSession,
  registry: SocketRegistry,
): Promise<{ readonly listening: Listening; readonly transport: FakeSocket }> {
  const listening = listen(session)
  await vi.waitFor(() => { expect(registry.count).toBeGreaterThan(0) })
  const transport = await ready(registry)
  await listening.opened
  return { listening, transport }
}

/**
 * Let every queued promise callback and short timer run.
 * @param ms - how long to wait, in milliseconds.
 * @returns nothing once the queues have drained.
 */
async function flush(ms = 10): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Acknowledge the newest transport's setup, the way the provider does.
 * @param registry - the registry whose newest transport to open.
 * @returns nothing once the setup was acknowledged.
 */
async function ready(registry: SocketRegistry): Promise<FakeSocket> {
  const transport = registry.last
  transport.fire('open')
  await flush()
  transport.fire('message', { data: JSON.stringify({ setupComplete: true }) })
  await flush()
  return transport
}

/** One utterance whose frames a spec collects in the background. */
interface Listening {
  /** The open utterance, available once {@link Listening.opened} resolved. */
  utterance: VoiceLiveUtterance
  /** The frames the utterance produced, in order, once its stream ended. */
  readonly frames: VoiceLiveOutputFrame[]
  /** Resolves when the utterance is open, so a spec can drive its transport. */
  readonly opened: Promise<void>
  /** Resolves when the utterance's frame stream ended. */
  readonly ended: Promise<void>
}

/**
 * Start one utterance and collect its frames.
 * @param session - the session under test.
 * @returns the handle a spec drives.
 */
function listen(session: VoiceLiveSession): Listening {
  const frames: VoiceLiveOutputFrame[] = []
  let opened: (utterance: VoiceLiveUtterance) => void = () => {}
  let ended: () => void = () => {}
  const handle: Listening = {
    utterance: undefined as unknown as VoiceLiveUtterance,
    frames,
    opened: new Promise<void>((resolve) => {
      opened = (utterance) => {
        handle.utterance = utterance
        resolve()
      }
    }),
    ended: new Promise<void>((resolve) => { ended = resolve }),
  }
  void (async () => {
    const utterance = await session.openUtterance()
    opened(utterance)
    for await (const frame of utterance.frames()) frames.push(frame)
    ended()
  })()
  return handle
}

describe('VoiceLiveSession warm reuse', () => {
  it('reuses the warm socket for one utterance and replaces it afterwards', async () => {
    const { registry, session } = bench()
    const { listening: first, transport } = await open(session, registry)
    expect(registry.count).toBe(1)

    first.utterance.finish()
    await first.ended
    // The replacement warm socket is opened for the next click.
    await vi.waitFor(() => { expect(registry.count).toBe(2) })
    await ready(registry)

    const second = listen(session)
    await second.opened
    expect(registry.last).not.toBe(transport)
    second.utterance.finish()
    await second.ended
    await session.dispose()
  })

  it('opens a fresh socket when the warm one failed', async () => {
    const { registry, session } = bench()
    const first = listen(session)
    await vi.waitFor(() => { expect(registry.count).toBe(1) })
    const failed = registry.last
    failed.fire('open')
    await flush()
    failed.fire('error', { error: new Error('link refused') })
    // The claim retried on a new socket; acknowledge that one.
    await vi.waitFor(() => { expect(registry.count).toBe(2) })
    await ready(registry)
    await first.opened
    expect(first.frames.filter(frame => frame.type === 'error')).toEqual([])
    first.utterance.finish()
    await first.ended
    await session.dispose()
  })
})

describe('VoiceLiveSession transcript frames', () => {
  it('reports readiness, then each interim and final the provider sends', async () => {
    const { registry, session } = bench()
    const { listening, transport } = await open(session, registry)
    transport.fire('message', {
      data: JSON.stringify({ serverContent: { interimInputTranscription: { text: 'open the' } } }),
    })
    transport.fire('message', {
      data: JSON.stringify({ serverContent: { inputTranscription: { text: 'open the file' } } }),
    })
    await flush()
    listening.utterance.finish()
    await listening.ended
    expect(listening.frames).toEqual([
      { type: 'ready' },
      { type: 'interim', text: 'open the' },
      { type: 'final', text: 'open the file' },
    ])
    await session.dispose()
  })

  it('keeps receiving late finals for the flush window after the audio ends', async () => {
    const { registry, session } = bench({ flushWindowMs: 80 })
    const { listening, transport } = await open(session, registry)
    listening.utterance.finish()
    expect(transport.sent.at(-1)).toBe(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
    // The provider settles one more transcript after audioStreamEnd.
    await flush()
    transport.fire('message', {
      data: JSON.stringify({ serverContent: { inputTranscription: { text: 'the last word' } } }),
    })
    await listening.ended
    expect(listening.frames).toEqual([{ type: 'ready' }, { type: 'final', text: 'the last word' }])
    await session.dispose()
  })

  it('refuses audio once the utterance is flushing', async () => {
    const { registry, session } = bench({ flushWindowMs: 80 })
    const { listening } = await open(session, registry)
    expect(listening.utterance.sendAudio('AAAA')).toBe(true)
    listening.utterance.finish()
    expect(listening.utterance.sendAudio('AAAA')).toBe(false)
    await listening.ended
    await session.dispose()
  })

  it('reports a provider refusal and ends the utterance', async () => {
    const { registry, session } = bench()
    const { listening, transport } = await open(session, registry)
    transport.fire('message', { data: JSON.stringify({ error: { message: 'quota exhausted' } }) })
    await listening.ended
    expect(listening.frames).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'quota exhausted' },
    ])
    await session.dispose()
  })

  it('ends the utterance when the client interrupts it, without an error frame', async () => {
    const { registry, session } = bench()
    const { listening } = await open(session, registry)
    listening.utterance.interrupt()
    await listening.ended
    expect(listening.frames).toEqual([{ type: 'ready' }])
    await session.dispose()
  })

  it('reports why an interrupt ended the utterance', async () => {
    const { registry, session } = bench()
    const { listening } = await open(session, registry)
    listening.utterance.interrupt('the voice link lost audio')
    await listening.ended
    expect(listening.frames).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the voice link lost audio' },
    ])
    await session.dispose()
  })

  it('ends a repeated interrupt only once', async () => {
    const { registry, session } = bench()
    const { listening } = await open(session, registry)
    listening.utterance.interrupt()
    listening.utterance.interrupt('second reason')
    await listening.ended
    expect(listening.frames).toEqual([{ type: 'ready' }])
    await session.dispose()
  })

  it('exposes the configured audio cap to the route', async () => {
    const { registry, session } = bench({ maxUtteranceBytes: 4096 })
    const { listening } = await open(session, registry)
    expect(listening.utterance.maxAudioBytes).toBe(4096)
    listening.utterance.finish()
    await listening.ended
    await session.dispose()
  })
})

describe('VoiceLiveSession failures', () => {
  it('reports a missing credential as its own failure, without opening a socket', async () => {
    const { registry, session } = bench({ resolveApiKey: async () => undefined })
    const failure = await session.openUtterance().catch((error: unknown) => error)
    expect(isMissingKey(failure)).toBe(true)
    expect((failure as Error).message).toContain('GEMINI_API_KEY')
    expect(registry.count).toBe(0)
    await session.dispose()
  })

  it('reports an empty credential the same way', async () => {
    const { registry, session } = bench({ resolveApiKey: async () => '' })
    const failure = await session.openUtterance().catch((error: unknown) => error)
    expect(isMissingKey(failure)).toBe(true)
    expect(registry.count).toBe(0)
    await session.dispose()
  })

  it('reports a link failure that survives the retry', async () => {
    const { registry, session } = bench({ connectTimeoutMs: 10, closeTimeoutMs: 10 })
    const failure = await session.openUtterance().catch((error: unknown) => error)
    expect(isMissingKey(failure)).toBe(false)
    expect((failure as Error).message).toContain('VOICE_LIVE_SOCKET_TIMEOUT')
    // Both the first and the retried socket were given up.
    expect(registry.count).toBe(2)
    await session.dispose()
  })

  it('refuses an utterance on a disposed session', async () => {
    const { session } = bench()
    await session.dispose()
    await expect(session.openUtterance()).rejects.toThrow('disposed')
  })

  it('refuses an utterance that waited on the gate of a disposed session', async () => {
    const { registry, session } = bench()
    const { listening: first } = await open(session, registry)
    // A second click while the first utterance runs waits for its socket.
    const queued = session.openUtterance()
    await session.dispose()
    await expect(queued).rejects.toThrow('disposed')
    first.utterance.interrupt()
    await first.ended
  })
})

describe('VoiceLiveSession idle teardown', () => {
  it('drops a warm socket nobody used and keeps one warm for the next click', async () => {
    const { registry, session } = bench({ flushWindowMs: 5, idleTimeoutMs: 30 })
    const { listening } = await open(session, registry)
    listening.utterance.finish()
    await listening.ended
    await vi.waitFor(() => { expect(registry.count).toBe(2) })
    await ready(registry)
    const replacement = registry.last

    await vi.waitFor(() => { expect(replacement.closed).toBe(true) })
    // The idle drop replaces the socket it released.
    await vi.waitFor(() => { expect(registry.count).toBe(3) })
    await session.dispose()
  })
})

describe('VoiceLiveSession dispose', () => {
  it('closes the warm socket and awaits the close', async () => {
    const { registry, session } = bench({ flushWindowMs: 5 })
    const { listening } = await open(session, registry)
    listening.utterance.finish()
    await listening.ended
    await vi.waitFor(() => { expect(registry.count).toBe(2) })
    await ready(registry)
    const warm = registry.last
    expect(warm.closed).toBe(false)

    const disposing = session.dispose()
    await flush()
    expect(warm.closed).toBe(true)
    warm.fire('close')
    await disposing
    expect(warm.closeCalls).toBe(1)
  })

  it('is idempotent', async () => {
    const { session } = bench()
    await session.dispose()
    await session.dispose()
  })

  it('delivers nothing after disposal', async () => {
    const { registry, session } = bench()
    const { listening, transport } = await open(session, registry)
    await session.dispose()
    transport.fire('message', {
      data: JSON.stringify({ serverContent: { inputTranscription: { text: 'ghost' } } }),
    })
    listening.utterance.interrupt()
    await listening.ended
    expect(listening.frames.filter(frame => frame.type === 'final')).toEqual([])
  })

  it('waits out the handshake before releasing a socket that is still connecting', async () => {
    const { registry, session } = bench({ connectTimeoutMs: 200 })
    const listening = listen(session)
    await vi.waitFor(() => { expect(registry.count).toBe(1) })
    const transport = registry.last
    // The transport has not opened yet; disposal must still settle and leave a
    // closed socket behind rather than a connecting one.
    const disposing = session.dispose()
    transport.fire('open')
    await flush()
    transport.fire('message', { data: JSON.stringify({ setupComplete: true }) })
    await disposing
    expect(transport.closed).toBe(true)
    await listening.opened
    listening.utterance.interrupt()
    await listening.ended
  })
})

describe('VoiceLiveSession with no runtime WebSocket', () => {
  it('resolves the global constructor at the first open', async () => {
    vi.stubGlobal('WebSocket', undefined)
    const session = new VoiceLiveSession({
      baseURL: 'https://generativelanguage.googleapis.com',
      model: 'gemini-3.5-transcribe-live',
      flushWindowMs: 20,
      idleTimeoutMs: 50,
      connectTimeoutMs: 20,
      closeTimeoutMs: 20,
      maxUtteranceBytes: 1024,
      apiKeyEnv: credentialRef('GEMINI_API_KEY'),
      resolveApiKey: async () => 'test-key',
    })
    const failure = await session.openUtterance().catch((error: unknown) => error)
    expect((failure as Error).message).toContain('no WebSocket implementation')
    await session.dispose()
  })
})

describe('VoiceLiveSession teardown edges', () => {
  it('refuses a queued utterance when the session is disposed under it', async () => {
    const { registry, session } = bench()
    const { listening: first } = await open(session, registry)
    // A second click waits on the gate for the first utterance's socket.
    const queued = session.openUtterance().catch((error: unknown) => error)
    await session.dispose()
    const failure = await queued
    expect((failure as Error).message).toContain('disposed')
    first.utterance.interrupt()
    await first.ended
  })

  it('opens the replacement warm socket even when none was in flight', async () => {
    const { registry, session } = bench({ flushWindowMs: 5 })
    const { listening } = await open(session, registry)
    // The utterance settles before the replacement warm socket exists.
    listening.utterance.interrupt()
    await listening.ended
    await vi.waitFor(() => { expect(registry.count).toBe(2) })
    await ready(registry)
    await session.dispose()
  })

  it('reports a provider fault that arrives after the utterance settled', async () => {
    const { registry, session } = bench({ flushWindowMs: 5 })
    const { listening, transport } = await open(session, registry)
    listening.utterance.finish()
    await listening.ended
    transport.fire('message', { data: JSON.stringify({ error: { message: 'too late' } }) })
    await flush()
    expect(listening.frames.at(-1)).toEqual({ type: 'ready' })
    await session.dispose()
  })
})

describe('a claim the credential resolves after', () => {
  it('refuses the retry when the session is disposed while the first socket fails', async () => {
    const registry = new SocketRegistry()
    let releaseKey: (value: string) => void = () => {}
    const key = new Promise<string>((resolve) => { releaseKey = resolve })
    const session = new VoiceLiveSession({
      baseURL: 'https://generativelanguage.googleapis.com',
      model: 'gemini-3.5-transcribe-live',
      flushWindowMs: 20,
      idleTimeoutMs: 40,
      connectTimeoutMs: 50,
      closeTimeoutMs: 50,
      maxUtteranceBytes: 1024,
      apiKeyEnv: credentialRef('GEMINI_API_KEY'),
      // The credential resolves only once the case lets it, so the disposal
      // lands between the first failure and the retry.
      resolveApiKey: async () => await key,
      ctor: registry.ctor,
    })
    const opening = session.openUtterance().catch((error: unknown) => error)
    releaseKey('test-key')
    await vi.waitFor(() => { expect(registry.sockets).toHaveLength(1) })
    registry.last.fire('open')
    await flush()
    registry.last.fire('error', { error: new Error('the link is gone') })
    const disposing = session.dispose()
    await disposing
    expect((await opening as Error).message).toContain('disposed')
  })
})
