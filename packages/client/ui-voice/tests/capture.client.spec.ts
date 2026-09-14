// @vitest-environment jsdom
/**
 * Microphone capture: which browser surfaces it needs, how a granted stream
 * becomes encoded chunks, and how every way of failing to start reads.
 *
 * The audio graph is a stub, so the specs drive the block queue directly; the
 * encoding itself is covered by the PCM cases.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  micCaptureEnvironment, MicCaptureFaultError, startMicCapture,
} from '../src/client/capture.ts'
import type { MicCaptureEnvironment, MicCaptureFault } from '../src/client/capture.ts'
import type { CaptureBlock, CaptureGraph } from '../src/client/capture.ts'
import { VOICE_LIVE_CHUNK_FRAMES, VOICE_LIVE_SAMPLE_RATE } from '../src/client/pcm.ts'

// The capture module constructs an AudioWorkletNode, which jsdom does not
// provide. The stub returns whatever node the case under test installed, so the
// spec keeps a handle on the object the production graph actually drives.
let workletNode: unknown
globalThis.AudioWorkletNode = function AudioWorkletNodeStub(): object {
  return workletNode as object
} as unknown as typeof AudioWorkletNode

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
})

/** A capture environment whose audio graph is a block queue the spec drives. */
function bench() {
  const blocks: CaptureBlock[] = []
  const wake: (() => void)[] = []
  const stopped = vi.fn(() => {})
  const stream = { getTracks: () => [] } as unknown as MediaStream
  let ended = false
  let started: () => void = () => {}
  const reading = new Promise<void>((resolve) => { started = resolve })
  const environment: MicCaptureEnvironment = {
    mediaStream: async () => stream,
    graph: async () => {
      const graph: CaptureGraph = {
        rate: VOICE_LIVE_SAMPLE_RATE,
        next: async () => {
          started()
          while (true) {
            const block = blocks.shift()
            if (block !== undefined) return block
            if (ended) return { samples: new Float32Array(0), rate: VOICE_LIVE_SAMPLE_RATE, done: true }
            await new Promise<void>((resolve) => { wake.push(resolve) })
          }
        },
        stop: async () => {
          stopped()
          ended = true
          for (const resolve of wake.splice(0)) resolve()
        },
      }
      return graph
    },
  }
  return {
    environment,
    blocks,
    stopped,
    reading,
    /** Let the capture loop see the blocks a case just queued. */
    wake: () => { for (const resolve of wake.splice(0)) resolve() },
  }
}

/** One block of `frames` samples at the given rate. */
function block(frames: number, rate = VOICE_LIVE_SAMPLE_RATE): CaptureBlock {
  return { samples: new Float32Array(frames).fill(0.5), rate, done: false }
}

/** Let the capture loop consume the blocks it has. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

describe('micCaptureEnvironment', () => {
  it('resolves the browser surfaces when both are present', async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }))
    vi.stubGlobal('AudioContext', class { readonly sampleRate = 0 })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
    const environment = micCaptureEnvironment()
    expect(environment).toBeDefined()
    await environment?.mediaStream()
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  })

  it('answers nothing when the browser exposes no microphone capture', () => {
    vi.stubGlobal('AudioContext', class { readonly sampleRate = 0 })
    expect(micCaptureEnvironment()).toBeUndefined()
  })

  it('answers nothing when the browser exposes no audio graph', () => {
    vi.stubGlobal('AudioContext', undefined)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
    expect(micCaptureEnvironment()).toBeUndefined()
  })
})

describe('startMicCapture', () => {
  it('emits one encoded chunk per provider-sized frame', async () => {
    const b = bench()
    const chunks: { readonly bytes: number; readonly level: number }[] = []
    const capture = await startMicCapture(b.environment, {
      onChunk: (chunk) => { chunks.push(chunk) },
      onFault: () => {},
    })
    await b.reading
    b.blocks.push(block(VOICE_LIVE_CHUNK_FRAMES * 2 + 10))
    b.wake()
    await settle()
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.bytes).toBe(VOICE_LIVE_CHUNK_FRAMES * 2)
    // Every chunk carries the loudness the seat's silence gate reads.
    expect(chunks[0]?.level).toBeCloseTo(0.5)
    await capture.stop()
    expect(b.stopped).toHaveBeenCalledTimes(1)
  })

  it('resamples a device that refuses the requested rate', async () => {
    const b = bench()
    const chunks: { readonly bytes: number }[] = []
    const capture = await startMicCapture(b.environment, {
      onChunk: (chunk) => { chunks.push(chunk) },
      onFault: () => {},
    })
    await b.reading
    // A 32 kHz graph delivers twice the samples for the same 100 ms of audio.
    b.blocks.push(block(VOICE_LIVE_CHUNK_FRAMES * 2, 32_000))
    b.wake()
    await settle()
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.bytes).toBe(VOICE_LIVE_CHUNK_FRAMES * 2)
    await capture.stop()
  })

  it('reports a withheld microphone as a denied fault', async () => {
    const denied: MicCaptureEnvironment = {
      mediaStream: async () => { throw new Error('NotAllowedError') },
      graph: async () => { throw new Error('never reached') },
    }
    const failure = await startMicCapture(denied, { onChunk: () => {}, onFault: () => {} })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MicCaptureFaultError)
    expect((failure as MicCaptureFaultError).reason).toBe('denied')
  })

  it('reports an audio graph that will not start, and releases the stream', async () => {
    const track = { stop: vi.fn() }
    const broken: MicCaptureEnvironment = {
      mediaStream: async () => ({ getTracks: () => [track] } as unknown as MediaStream),
      graph: async () => { throw new Error('no worklet') },
    }
    const failure = await startMicCapture(broken, { onChunk: () => {}, onFault: () => {} })
      .catch((error: unknown) => error)
    expect((failure as MicCaptureFaultError).reason).toBe('audio')
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the graph once and stops encoding', async () => {
    const b = bench()
    const chunks: unknown[] = []
    const capture = await startMicCapture(b.environment, {
      onChunk: (chunk) => { chunks.push(chunk) },
      onFault: () => {},
    })
    await b.reading
    await capture.stop()
    await capture.stop()
    expect(b.stopped).toHaveBeenCalledTimes(1)
    // A block arriving after the stop is not encoded.
    b.blocks.push(block(VOICE_LIVE_CHUNK_FRAMES))
    b.wake()
    await settle()
    expect(chunks).toHaveLength(0)
  })

  it('hands the graph the caller\u2019s fault reporter', async () => {
    const faults: MicCaptureFault[] = []
    let report: ((reason: MicCaptureFault) => void) | undefined
    const environment: MicCaptureEnvironment = {
      mediaStream: async () => ({ getTracks: () => [] } as unknown as MediaStream),
      graph: async (_stream, onFault) => {
        report = onFault
        return {
          rate: VOICE_LIVE_SAMPLE_RATE,
          next: async () => ({ samples: new Float32Array(0), rate: VOICE_LIVE_SAMPLE_RATE, done: true }),
          stop: async () => {},
        }
      },
    }
    const capture = await startMicCapture(environment, {
      onChunk: () => {},
      onFault: (reason) => { faults.push(reason) },
    })
    report?.('audio')
    expect(faults).toEqual(['audio'])
    await capture.stop()
  })
})

describe('MicCaptureFaultError', () => {
  it('names the fault it carries', () => {
    const error = new MicCaptureFaultError('unsupported')
    expect(error.name).toBe('MicCaptureFaultError')
    expect(error.message).toContain('unsupported')
  })
})

describe('the browser audio graph', () => {
  it('loads the processor, reads its blocks, and releases everything on stop', async () => {
    const revoke = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:capture')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: revoke })
    const context = new RealAudioContext()
    workletNode = context.node
    vi.stubGlobal('AudioContext', function Ctor() { return context })
    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    })
    const environment = micCaptureEnvironment()!
    const chunks: unknown[] = []
    const faults: MicCaptureFault[] = []
    const capture = await startMicCapture(environment, {
      onChunk: (chunk) => { chunks.push(chunk) },
      onFault: (reason) => { faults.push(reason) },
    })
    // The processor module is loaded from an object URL before the graph runs.
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(context.addModule).toHaveBeenCalledWith('blob:capture')
    expect(context.sourceConnects).toBe(1)

    // One worklet message carries a provider-sized frame.
    context.node.port.onmessage?.({ data: new Float32Array(VOICE_LIVE_CHUNK_FRAMES) })
    await settle()
    expect(chunks).toHaveLength(1)

    // A context that stops running is a fault the seat has to show.
    context.state = 'suspended'
    context.onstatechange?.()
    expect(faults).toEqual(['audio'])

    await capture.stop()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:capture')
    expect(context.closed).toBe(true)
    expect(context.node.disconnects).toBe(1)
    expect(context.sourceDisconnects).toBe(1)
  })

  it('releases the stream and the module when the processor will not load', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:capture', revokeObjectURL: revoke })
    const context = new RealAudioContext()
    workletNode = context.node
    context.addModule.mockRejectedValue(new Error('no worklet support'))
    vi.stubGlobal('AudioContext', function Ctor() { return context })
    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    })
    await expect(startMicCapture(micCaptureEnvironment()!, { onChunk: () => {}, onFault: () => {} }))
      .rejects.toMatchObject({ reason: 'audio' })
    expect(revoke).toHaveBeenCalledWith('blob:capture')
    // The capture module releases the stream its graph would have used, and the
    // start path releases it again for the graph that never came up.
    expect(track.stop).toHaveBeenCalled()
    expect(context.closed).toBe(true)
  })
})

/** The browser audio graph as the capture module drives it, with no audio behind it. */
class RealAudioContext {
  readonly sampleRate = VOICE_LIVE_SAMPLE_RATE
  state = 'running'
  onstatechange: (() => void) | null = null
  readonly addModule = vi.fn(async () => {})
  readonly audioWorklet = { addModule: this.addModule }
  readonly node = new RealWorkletNode()
  sourceConnects = 0
  sourceDisconnects = 0
  closed = false

  /** @returns the source node the capture connects to its processor. */
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return {
      connect: () => { this.sourceConnects += 1 },
      disconnect: () => { this.sourceDisconnects += 1 },
    }
  }

  /** @returns nothing; this graph produces no output. */
  async close(): Promise<void> {
    this.closed = true
  }
}

/** The worklet node the capture reads blocks from. */
class RealWorkletNode {
  readonly port: { onmessage: ((event: { readonly data: Float32Array }) => void) | null } = { onmessage: null }
  disconnects = 0

  /** @returns nothing. */
  connect(): void {}

  /** @returns nothing. */
  disconnect(): void {
    this.disconnects += 1
  }
}

describe('the browser audio graph', () => {
  it('leaves a running context alone when its state is re-reported', async () => {
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:capture', revokeObjectURL: revoke })
    const context = new RealAudioContext()
    workletNode = context.node
    vi.stubGlobal('AudioContext', function Ctor() { return context })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [] }) },
    })
    const faults: MicCaptureFault[] = []
    const capture = await startMicCapture(micCaptureEnvironment()!, {
      onChunk: () => {},
      onFault: (reason) => { faults.push(reason) },
    })
    // A context that is still running is not a fault.
    context.onstatechange?.()
    expect(faults).toEqual([])
    await capture.stop()
  })
})
