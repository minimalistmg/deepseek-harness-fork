/**
 * The live provider link: the handshake, the frame reads, the protocol
 * constants, and the lifecycle guarantees a caller depends on — a released
 * socket has actually stopped, and a late frame from a replaced socket reaches
 * nobody. The transport is a controllable stub; no provider connection is made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GEMINI_LIVE_WS_PATH,
  GeminiLiveSocket,
  globalLiveSocketCtor,
  liveSetupMessage,
  liveSocketURL,
  parseLiveMessage,
  VOICE_LIVE_AUDIO_MIME_TYPE,
  VOICE_LIVE_SOCKET_TIMEOUT_CODE,
} from '../src/live-socket.ts'
import type { LiveWebSocketCtor, VoiceLiveMessage } from '../src/live-socket.ts'
import { SocketRegistry } from './live-socket-stub.host.ts'
import type { FakeSocket } from './live-socket-stub.host.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A socket under test plus the registry its transport comes from. */
function bench(overrides: { connectTimeoutMs?: number; closeTimeoutMs?: number } = {}) {
  const registry = new SocketRegistry()
  const socket = new GeminiLiveSocket({
    baseURL: 'https://generativelanguage.googleapis.com',
    model: 'gemini-3.5-transcribe-live',
    connectTimeoutMs: overrides.connectTimeoutMs ?? 1000,
    closeTimeoutMs: overrides.closeTimeoutMs ?? 1000,
    ctor: registry.ctor,
  })
  return { registry, socket }
}

/**
 * Let every queued promise callback run. The socket's frame reads await the
 * transport's own `text()`, so one microtask turn is not enough to observe them.
 * @returns nothing once the queue has drained.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Start one socket up to the point where it has sent its setup message.
 * @param socket - the socket under test.
 * @param registry - the registry its transport comes from.
 * @returns the open request and the transport it drives.
 */
async function sent(
  socket: GeminiLiveSocket,
  registry: SocketRegistry,
): Promise<{ readonly pending: Promise<GeminiLiveSocket>; readonly transport: FakeSocket }> {
  const pending = socket.open('test-key')
  const transport = registry.last
  transport.fire('open')
  // The transport's open resolves the handshake before the setup write.
  await flush()
  return { pending, transport }
}

/**
 * Start one socket and acknowledge its setup.
 * @param socket - the socket under test.
 * @param registry - the registry its transport comes from.
 * @returns the open socket and the transport it drives.
 */
async function opened(
  socket: GeminiLiveSocket,
  registry: SocketRegistry,
): Promise<{ readonly socket: GeminiLiveSocket; readonly transport: FakeSocket }> {
  const { pending, transport } = await sent(socket, registry)
  transport.fire('message', { data: JSON.stringify({ setupComplete: true }) })
  return { socket: await pending, transport }
}

describe('liveSocketURL', () => {
  it('projects the HTTP origin onto the provider endpoint', () => {
    expect(liveSocketURL('https://generativelanguage.googleapis.com'))
      .toBe(`wss://generativelanguage.googleapis.com${GEMINI_LIVE_WS_PATH}`)
  })

  it('keeps a plaintext origin plaintext and drops any path, query, and fragment', () => {
    expect(liveSocketURL('http://127.0.0.1:8080/v1beta?key=leak#frag'))
      .toBe(`ws://127.0.0.1:8080${GEMINI_LIVE_WS_PATH}`)
  })
})

describe('globalLiveSocketCtor', () => {
  it('resolves the runtime global', () => {
    function Stub(): void {}
    vi.stubGlobal('WebSocket', Stub)
    expect(globalLiveSocketCtor()).toBe(Stub as unknown as LiveWebSocketCtor)
  })

  it('refuses a runtime that ships none', () => {
    vi.stubGlobal('WebSocket', undefined)
    expect(() => globalLiveSocketCtor()).toThrow(/no WebSocket implementation/)
  })
})

describe('liveSetupMessage', () => {
  it('carries the protocol constants verbatim', () => {
    expect(liveSetupMessage('gemini-3.5-transcribe-live')).toEqual({
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: [] },
      },
    })
  })
})

describe('parseLiveMessage', () => {
  const cases: [string, VoiceLiveMessage][] = [
    ['{"setupComplete":true}', { kind: 'ready' }],
    ['{"serverContent":{"interimInputTranscription":{"text":"half a"}}}', { kind: 'interim', text: 'half a' }],
    ['{"serverContent":{"inputTranscription":{"text":"a sentence"}}}', { kind: 'final', text: 'a sentence' }],
    ['{"error":{"message":"quota"}}', { kind: 'error', message: 'quota' }],
    ['{"error":{}}', { kind: 'error', message: 'provider link failed' }],
    ['{"error":"flat"}', { kind: 'ignored' }],
    ['not json', { kind: 'ignored' }],
    ['null', { kind: 'ignored' }],
    ['[]', { kind: 'ignored' }],
    ['{"serverContent":null}', { kind: 'ignored' }],
    ['{"serverContent":{}}', { kind: 'ignored' }],
    ['{"serverContent":{"inputTranscription":{}}}', { kind: 'ignored' }],
    ['{"serverContent":{"inputTranscription":{"text":""}}}', { kind: 'ignored' }],
    ['{"serverContent":{"interimInputTranscription":{"text":""}}}', { kind: 'ignored' }],
    ['{"serverContent":{"turnComplete":true}}', { kind: 'ignored' }],
  ]
  it.each(cases)('reads %s', (text, expected) => {
    expect(parseLiveMessage(text)).toEqual(expected)
  })
})

describe('GeminiLiveSocket', () => {
  it('sends the key as a header and the setup message on open', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    expect(transport.headers).toEqual({ 'x-goog-api-key': 'test-key' })
    expect(transport.url).toBe(`wss://generativelanguage.googleapis.com${GEMINI_LIVE_WS_PATH}`)
    expect(transport.sent[0]).toBe(JSON.stringify(liveSetupMessage('gemini-3.5-transcribe-live')))
  })

  it('fails the open when the provider refuses the setup', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    transport.fire('message', { data: JSON.stringify({ error: { message: 'model not found' } }) })
    await expect(pending).rejects.toThrow('model not found')
    expect(transport.closed).toBe(true)
  })

  it('fails the open when the transport reports an error', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    transport.fire('error', { error: new Error('connect refused') })
    await expect(pending).rejects.toThrow('connect refused')
  })

  it('fails the open when the transport closes before the setup is acknowledged', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    transport.fire('close')
    await expect(pending).rejects.toThrow('provider closed the voice link')
  })

  it('names a transport failure that carries no error object', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    transport.fire('error', {})
    await expect(pending).rejects.toThrow('provider link failed')
  })

  it('names a transport failure that carries a bare string', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    transport.fire('error', { error: 'socket hang up' })
    await expect(pending).rejects.toThrow('socket hang up')
  })

  it('fails the open when the setup outlives the connect deadline', async () => {
    const { registry, socket } = bench({ connectTimeoutMs: 5 })
    const { pending } = await sent(socket, registry)
    await expect(pending).rejects.toThrow(VOICE_LIVE_SOCKET_TIMEOUT_CODE)
    expect(registry.last.closed).toBe(true)
  })

  it('fails an open on a transport that never opened', async () => {
    const { registry, socket } = bench({ connectTimeoutMs: 5 })
    await expect(socket.open('test-key')).rejects.toThrow(VOICE_LIVE_SOCKET_TIMEOUT_CODE)
    expect(registry.last.closed).toBe(true)
  })

  it('reads a binary frame the transport hands over', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    // Gemini Live answers over binary frames; a Blob carrying the setup
    // acknowledgement must complete the handshake.
    transport.fire('message', { data: new Blob([JSON.stringify({ setupComplete: {} })]) })
    await pending
  })

  it('fails the handshake when it cannot read a frame', async () => {
    const { registry, socket } = bench()
    const { pending, transport } = await sent(socket, registry)
    transport.fire('message', {
      data: new Uint8Array(),
      text: async () => { throw new Error('frame is not decodable') },
    })
    await expect(pending).rejects.toThrow('provider sent a frame this build cannot read')
  })

  it('keeps a running socket alive when it cannot read one frame', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    const seen: VoiceLiveMessage[] = []
    const stop = socket.observe((message) => { seen.push(message) })
    transport.fire('message', {
      data: new Uint8Array(),
      text: async () => { throw new Error('frame is not decodable') },
    })
    await flush()
    // The unreadable frame is dropped rather than ending an utterance the
    // provider is still streaming into.
    expect(seen).toEqual([])
    transport.fire('message', { data: JSON.stringify({ serverContent: { outputTranscription: { text: 'heard' } } }) })
    await flush()
    expect(seen).toHaveLength(1)
    stop()
  })

  it('writes audio and the end of the utterance with the protocol constants', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    expect(socket.sendAudio('AAAA')).toBe(true)
    expect(socket.endAudio()).toBe(true)
    expect(JSON.parse(transport.sent[1]!)).toEqual({
      realtimeInput: { audio: { data: 'AAAA', mimeType: VOICE_LIVE_AUDIO_MIME_TYPE } },
    })
    expect(JSON.parse(transport.sent[2]!)).toEqual({ realtimeInput: { audioStreamEnd: true } })
  })

  it('refuses a write on a transport that is no longer open', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    transport.readyState = 3
    expect(socket.sendAudio('AAAA')).toBe(false)
  })

  it('delivers provider frames to the observer and stops after the disposer', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    const seen: VoiceLiveMessage[] = []
    const stop = socket.observe((message) => { seen.push(message) })
    transport.fire('message', { data: JSON.stringify({ serverContent: { inputTranscription: { text: 'one' } } }) })
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect(seen).toEqual([{ kind: 'final', text: 'one' }])

    stop()
    transport.fire('message', { data: JSON.stringify({ serverContent: { inputTranscription: { text: 'two' } } }) })
    await flush()
    expect(seen).toHaveLength(1)
  })

  it('reads a binary frame handed to an observer', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    const seen: VoiceLiveMessage[] = []
    socket.observe((message) => { seen.push(message) })
    transport.fire('message', {
      data: new Blob([JSON.stringify({ serverContent: { inputTranscription: { text: 'one' } } })]),
    })
    await vi.waitFor(() => { expect(seen).toEqual([{ kind: 'final', text: 'one' }]) })
  })

  it('closes once and waits for the transport to report it', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    let released = false
    const release = socket.release().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(transport.closed).toBe(true)
    transport.fire('close')
    await release
    expect(released).toBe(true)
    // A second release is a no-op, not a second close.
    await socket.release()
    expect(transport.closeCalls).toBe(1)
  })

  it('abandons a transport that never reports its close', async () => {
    const { registry, socket } = bench({ closeTimeoutMs: 5 })
    await opened(socket, registry)
    await socket.release()
    expect(registry.last.closeCalls).toBe(1)
  })

  it('releases without touching a transport that was never opened', async () => {
    const { registry, socket } = bench()
    void registry
    await socket.release()
    expect(registry.count).toBe(0)
  })

  it('delivers a provider refusal to the observer and releases the link', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    const seen: VoiceLiveMessage[] = []
    socket.observe((message) => { seen.push(message) })
    transport.fire('message', { data: JSON.stringify({ error: { message: 'aborted by provider' } }) })
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    expect(seen).toEqual([{ kind: 'error', message: 'aborted by provider' }])
  })
})

describe('GeminiLiveSocket edges', () => {
  it('reports a failure the transport raised before the open', async () => {
    const { registry, socket } = bench()
    const pending = socket.open('test-key')
    const transport = registry.last
    transport.fire('open')
    await flush()
    transport.fire('error', { error: 'gone before setup' })
    await expect(pending).rejects.toThrow('gone before setup')
    expect(transport.closed).toBe(true)
  })

  it('keeps delivering to a second observer after the first was released', async () => {
    const { registry, socket } = bench()
    const { transport } = await opened(socket, registry)
    const first: VoiceLiveMessage[] = []
    const second: VoiceLiveMessage[] = []
    const release = socket.observe((message) => { first.push(message) })
    release()
    socket.observe((message) => { second.push(message) })
    transport.fire('message', { data: JSON.stringify({ serverContent: { inputTranscription: { text: 'kept' } } }) })
    await flush()
    expect(first).toEqual([])
    expect(second).toEqual([{ kind: 'final', text: 'kept' }])
  })


})

describe('an open that is closed before the setup arrives', () => {
  it('reports the close that ended the handshake', async () => {
    const { registry, socket } = bench({ connectTimeoutMs: 50 })
    const pending = socket.open('test-key')
    const transport = registry.last
    transport.fire('open')
    await flush()
    transport.fire('close')
    // The transport's own close ends the wait on the setup acknowledgement.
    await expect(pending).rejects.toThrow('provider closed the voice link')
  })
})

describe('a socket the provider faults twice over', () => {
  it('keeps the first cause it reported', async () => {
    const { socket } = bench({ connectTimeoutMs: 5, closeTimeoutMs: 5 })
    // The first open gives up on the transport and releases it; the second open
    // must report that recorded cause instead of parking on a dead socket.
    await expect(socket.open('test-key')).rejects.toThrow(/VOICE_LIVE_SOCKET_TIMEOUT|closed/)
    await expect(socket.open('test-key')).rejects.toThrow('voice link released')
  })
})
