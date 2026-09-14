/**
 * The live dictation link: the streaming request it opens, the transcript
 * frames it hands the seat, and every way an utterance settles — a transcript,
 * a route the host never mounted, a transport that never answered, a
 * microphone it could not open, and the browser engine it falls back to.
 *
 * Both the transport and the browser surfaces are stubs, so no provider and no
 * real microphone are involved.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribe } from '../src/client/live.ts'
import type { LiveHandlers, TranscribeRequest, VoiceLinkEnvironment } from '../src/client/live.ts'
import type { DictationEngine, DictationResultEvent } from '../src/client/recognition.ts'
import { VOICE_LIVE_MEDIA_TYPE, VOICE_LIVE_PATH, VOICE_LIVE_REQUEST_MEDIA_TYPE } from '../src/live-protocol.ts'

// The capture module builds an AudioWorkletNode, which jsdom does not provide;
// this stub keeps that construction total without any audio behind it.
let workletNode: unknown
globalThis.AudioWorkletNode = function AudioWorkletNodeStub(): object {
  return workletNode as object
} as unknown as typeof AudioWorkletNode

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

/** One request the transport received. */
interface Sent {
  readonly url: string
  readonly init: RequestInit
}

/** A host answer that streams the given frames. */
function streamed(frames: readonly unknown[]): Response {
  const body = frames.map(frame => `${JSON.stringify(frame)}\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': VOICE_LIVE_MEDIA_TYPE } })
}

/**
 * A transport whose answer a spec supplies.
 * @param answer - the response to send, or the failure to throw.
 * @returns the environment and the requests it received.
 */
function transport(answer: Response | Error) {
  const sent: Sent[] = []
  const environment: VoiceLinkEnvironment = {
    fetch: async (input, init) => {
      sent.push({ url: input, init })
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { environment, sent }
}

/** Install a browser that captures audio, so the live link opens. */
function microphone(): void {
  workletNode = new WorkletNode()
  vi.stubGlobal('AudioContext', function Ctor() { return new StubAudioContext(workletNode as WorkletNode) })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  })
}

/** The browser audio surface the capture module drives, with no audio behind it. */
class StubAudioContext {
  readonly sampleRate = 16_000
  state = 'running'
  onstatechange: (() => void) | null = null
  audioWorklet: { addModule: () => Promise<void> } = { addModule: async () => {} }

  /**
   * @param node - the worklet node the capture reads.
   */
  constructor(readonly node: WorkletNode) {}

  /** @returns the source node the capture connects to its processor. */
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => {}, disconnect: () => {} }
  }

  /** @returns nothing; this graph produces no output. */
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * A request whose seat callbacks are recorded.
 * @param webSpeech - whether the browser engine may take over.
 * @param signal - the seat's cancellation, when the case supplies one.
 * @returns the request plus the recorded callbacks.
 */
function seat(webSpeech = false, signal?: AbortSignal) {
  const frames: { readonly text: string; readonly settled: boolean }[] = []
  const listening = vi.fn()
  const levels: number[] = []
  const onLevel = vi.fn((level: number) => { levels.push(level) })
  const handlers: LiveHandlers = {
    onTranscript: (text, settled) => { frames.push({ text, settled }) },
    onListening: listening,
    onLevel,
  }
  const request: TranscribeRequest = signal === undefined
    ? { handlers, webSpeech }
    : { handlers, webSpeech, signal }
  return { request, frames, listening, levels }
}

describe('transcribe without a microphone', () => {
  it('reports a withheld microphone as denied, without opening the link', async () => {
    const t = transport(streamed([]))
    const utterance = transcribe(seat().request, t.environment)
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'denied' })
    expect(t.sent).toHaveLength(0)
  })

  it('reports a withheld microphone as denied when no engine may take over', async () => {
    vi.stubGlobal('webkitSpeechRecognition', undefined)
    const t = transport(streamed([]))
    const utterance = transcribe(seat(true).request, t.environment)
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'denied' })
    expect(t.sent).toHaveLength(0)
  })

  it('runs the browser engine when one is configured', async () => {
    StubEngine.created = []
    vi.stubGlobal('webkitSpeechRecognition', StubEngine)
    const t = transport(streamed([]))
    const s = seat(true)
    const utterance = transcribe(s.request, t.environment)
    await vi.waitFor(() => { expect(StubEngine.created[0]?.starts).toBe(1) })
    const engine = StubEngine.created[0]!
    expect(s.listening).toHaveBeenCalledTimes(1)
    engine.settle({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'from the engine' } }] })
    expect(s.frames).toEqual([{ text: 'from the engine', settled: true }])

    await expect(utterance.stop()).resolves.toEqual({ text: 'from the engine', status: 'ok' })
    expect(engine.stops).toBe(1)
  })

  it('reports an engine that settles nothing', async () => {
    StubEngine.created = []
    vi.stubGlobal('webkitSpeechRecognition', StubEngine)
    const t = transport(streamed([]))
    const utterance = transcribe(seat(true).request, t.environment)
    await vi.waitFor(() => { expect(StubEngine.created[0]?.starts).toBe(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'ok' })
  })
})

describe('transcribe over the live link', () => {
  it('opens one streaming POST on the live path', async () => {
    microphone()
    const t = transport(streamed([{ type: 'ready' }]))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    expect(t.sent[0]?.url).toBe(VOICE_LIVE_PATH)
    expect(t.sent[0]?.init.method).toBe('POST')
    expect((t.sent[0]?.init.headers as Record<string, string>)['content-type'])
      .toBe(VOICE_LIVE_REQUEST_MEDIA_TYPE)
    await utterance.stop()
  })

  it('reports every transcript frame in host order', async () => {
    microphone()
    const t = transport(streamed([
      { type: 'ready' },
      { type: 'interim', text: 'open the' },
      { type: 'final', text: 'open the file' },
    ]))
    const s = seat()
    const utterance = transcribe(s.request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: 'open the file', status: 'ok' })
    expect(s.frames).toEqual([
      { text: 'open the', settled: false },
      { text: 'open the file', settled: true },
    ])
    expect(s.listening).toHaveBeenCalledTimes(1)
  })

  it('merges a revised transcript instead of losing the words already shown', async () => {
    microphone()
    const t = transport(streamed([
      { type: 'interim', text: 'please open' },
      { type: 'final', text: 'open the file' },
    ]))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: 'please open the file', status: 'ok' })
  })

  it('reports a route this deployment never mounted', async () => {
    microphone()
    const t = transport(new Response('', { status: 404 }))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'unavailable' })
  })

  it('reports a refused request', async () => {
    microphone()
    const t = transport(new Response('nope', { status: 500 }))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'failed' })
  })

  it('reports a transport that never answered', async () => {
    microphone()
    const t = transport(new Error('connection refused'))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'failed' })
  })

  it('reports the fault frame the host sent', async () => {
    microphone()
    const t = transport(streamed([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'provider refused' },
    ]))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'failed' })
  })

  it('reports an unavailable credential as its own status', async () => {
    microphone()
    const t = transport(streamed([{ type: 'error', code: 'voice/live-unavailable', message: 'no key' }]))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'unavailable' })
  })

  it('ignores a line the protocol does not declare', async () => {
    microphone()
    const t = transport(new Response(
      'not json\n{"type":"unknown"}\n{"type":"final","text":"kept"}\n',
      { status: 200 },
    ))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: 'kept', status: 'ok' })
  })

  it('settles once for repeated stops', async () => {
    microphone()
    const t = transport(streamed([{ type: 'final', text: 'once' }]))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    const [first, second] = await Promise.all([utterance.stop(), utterance.stop()])
    expect(first).toEqual({ text: 'once', status: 'ok' })
    expect(second).toEqual(first)
  })
})

/** A recognition engine a spec settles by hand. */
class StubEngine implements DictationEngine {
  /** Every engine this constructor built, so a spec can drive the one in use. */
  static created: StubEngine[] = []

  lang = ''
  continuous = false
  interimResults = false
  onresult: ((event: DictationResultEvent) => void) | null = null
  onerror: ((event: { readonly error: string }) => void) | null = null
  onend: (() => void) | null = null
  starts = 0
  stops = 0

  constructor() {
    StubEngine.created.push(this)
  }

  start(): void {
    this.starts += 1
  }

  stop(): void {
    this.stops += 1
    this.onend?.()
  }

  /**
   * Deliver one result event.
   * @param event - the event the engine reports.
   */
  settle(event: DictationResultEvent): void {
    this.onresult?.(event)
  }

  /**
   * Report an engine fault.
   * @param reason - the engine's own failure code.
   */
  fail(reason: string): void {
    this.onerror?.({ error: reason })
  }
}

describe('transcribe lifecycle edges', () => {
  it('drops the whole utterance when the seat cancels it first', async () => {
    const controller = new AbortController()
    controller.abort()
    const t = transport(streamed([]))
    const utterance = transcribe(seat(true, controller.signal).request, t.environment)
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'denied' })
    expect(t.sent).toHaveLength(0)
  })

  it('drops the utterance when the seat cancels it while the microphone opens', async () => {
    microphone()
    const controller = new AbortController()
    const t = transport(streamed([]))
    const utterance = transcribe(seat(true, controller.signal).request, t.environment)
    controller.abort()
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'denied' })
    expect(t.sent).toHaveLength(0)
  })

  it('reports an unavailable route when the engine may not take over', async () => {
    vi.stubGlobal('webkitSpeechRecognition', undefined)
    const t = transport(streamed([]))
    const utterance = transcribe(seat(true).request, t.environment)
    // No microphone and no engine: the link never opened, so nothing named a
    // route either, and the outcome is the microphone that could not start.
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'denied' })
  })

  it('reports an engine that fails mid-utterance', async () => {
    StubEngine.created = []
    vi.stubGlobal('webkitSpeechRecognition', StubEngine)
    const t = transport(streamed([]))
    const utterance = transcribe(seat(true).request, t.environment)
    await vi.waitFor(() => { expect(StubEngine.created[0]?.starts).toBe(1) })
    StubEngine.created[0]?.fail('network')
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'ok' })
  })

  it('carries captured audio into the request body', async () => {
    const seen: Uint8Array[] = []
    const context = new CaptureAudioContext()
    workletNode = context.node
    vi.stubGlobal('AudioContext', function Ctor() { return context })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
    const environment: VoiceLinkEnvironment = {
      fetch: async (_input, init) => {
        const reader = (init.body as ReadableStream<Uint8Array>).getReader()
        while (true) {
          const next = await reader.read()
          if (next.done) break
          seen.push(next.value)
        }
        return streamed([{ type: 'final', text: 'heard' }])
      },
    }
    const utterance = transcribe(seat().request, environment)
    // The capture loop reads blocks only once the microphone is running.
    await vi.waitFor(() => { expect(context.node.port.onmessage).not.toBeNull() })
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    // One worklet block is more than a provider frame, so a chunk goes out.
    context.node.port.onmessage?.({ data: new Float32Array(2000) })
    await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(0) })
    const text = new TextDecoder().decode(seen[0])
    const frame: unknown = JSON.parse(text.trim())
    expect(frame).toMatchObject({ type: 'audio', sequence: 0 })
    expect((frame as { data: string }).data).toEqual(expect.any(String))
    await expect(utterance.stop()).resolves.toEqual({ text: 'heard', status: 'ok' })
  })
})

/** The browser audio graph the capture module drives, with a driven block queue. */
class CaptureAudioContext {
  readonly sampleRate = 16_000
  state = 'running'
  onstatechange: (() => void) | null = null
  audioWorklet: { addModule: () => Promise<void> } | undefined = { addModule: async () => {} }
  readonly node = new WorkletNode()

  /** @returns the source node the capture connects to its processor. */
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => {}, disconnect: () => {} }
  }

  /** @returns nothing. */
  async close(): Promise<void> {}
}

/** The worklet node a spec pushes blocks through. */
class WorkletNode {
  readonly port: { onmessage: ((event: { readonly data: Float32Array }) => void) | null } = { onmessage: null }

  /** @returns nothing. */
  connect(): void {}

  /** @returns nothing. */
  disconnect(): void {}
}

describe('live link fault edges', () => {
  it('reports a microphone that fails mid-utterance', async () => {
    const context = new CaptureAudioContext()
    workletNode = context.node
    vi.stubGlobal('AudioContext', function Ctor() { return context })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
    const t = transport(streamed([]))
    const utterance = transcribe(seat().request, t.environment)
    // The audio graph stops on its own, which the link must carry into an
    // utterance the seat shows as a fault rather than as silence.
    await vi.waitFor(() => { expect(context.node.port.onmessage).not.toBeNull() })
    context.state = 'suspended'
    context.onstatechange?.()
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'failed' })
  })

  it('carries the session fault into an utterance that heard nothing', async () => {
    microphone()
    const t = transport(streamed([{ type: 'error', code: 'voice/live-failed', message: 'provider refused' }]))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'failed' })
  })

  it('ignores a blank line the host streamed', async () => {
    microphone()
    const t = transport(new Response('\n{"type":"final","text":"kept"}\n', { status: 200 }))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: 'kept', status: 'ok' })
  })

  it('builds its own transport when the caller supplies none', async () => {
    // No microphone and the ambient fetch: the utterance reports the device it
    // could not open without ever reaching the network.
    const utterance = transcribe(seat().request)
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'denied' })
  })
})

describe('a capture whose graph fails before the utterance reaches it', () => {
  it('falls back to the browser engine when one is configured', async () => {
    StubEngine.created = []
    vi.stubGlobal('webkitSpeechRecognition', StubEngine)
    // The graph refuses to start, so the link never opens and the engine runs.
    const context = new CaptureAudioContext()
    workletNode = context.node
    context.audioWorklet = undefined
    vi.stubGlobal('AudioContext', function Ctor() { return context })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
    const t = transport(streamed([]))
    const s = seat(true)
    const utterance = transcribe(s.request, t.environment)
    await vi.waitFor(() => { expect(StubEngine.created[0]?.starts).toBe(1) })
    expect(s.listening).toHaveBeenCalledTimes(1)
    await expect(utterance.stop()).resolves.toEqual({ text: '', status: 'ok' })
    expect(t.sent).toHaveLength(0)
  })
})

describe('live link stream edges', () => {
  it('reads a frame the host left without a final newline', async () => {
    microphone()
    // The stream ended after one complete frame, with no trailing terminator.
    const t = transport(new Response('{"type":"final","text":"kept"}', { status: 200 }))
    const utterance = transcribe(seat().request, t.environment)
    await vi.waitFor(() => { expect(t.sent).toHaveLength(1) })
    await expect(utterance.stop()).resolves.toEqual({ text: 'kept', status: 'ok' })
  })
})
