/**
 * Microphone capture for the live dictation seat: a `MediaStream` in, provider
 * sized 16 kHz PCM chunks out.
 *
 * The audio graph is created at the provider's rate when the browser can honor
 * it and resampled here when it cannot, because a device that refuses 16 kHz
 * still reports the rate it actually used. Frames are buffered until a chunk is
 * full, so the seat sends the 100 ms pieces the provider expects rather than
 * the audio graph's own block size.
 *
 * Every browser interface this module drives is reached through the injected
 * environment, so the module has no ambient dependency on a DOM.
 * @module @deepseek-ai/dsh-client-ui-voice/client/capture
 */

import {
  encodePcm16, resample, rmsLevel, takePcmChunks, toBase64, VOICE_LIVE_SAMPLE_RATE,
} from './pcm.ts'

/** One captured 16 kHz chunk, encoded for the wire. */
export interface CapturedChunk {
  /** Base64 of the chunk's little-endian signed 16-bit PCM. */
  readonly data: string
  /** Decoded size of `data`, in bytes. */
  readonly bytes: number
  /**
   * The chunk's root-mean-square level on the 0–1 scale. Silence detection and
   * the level meter read this; the provider never sees it.
   */
  readonly level: number
}

/** Callbacks one capture reports through once it is running. */
export interface MicCaptureHandlers {
  /**
   * One completed chunk of microphone audio.
   * @param chunk - the encoded chunk.
   */
  onChunk(chunk: CapturedChunk): void
  /**
   * Capture stopped without the caller asking.
   * @param reason - the fault to report.
   */
  onFault(reason: MicCaptureFault): void
}

/** Why capture could not continue. */
export type MicCaptureFault =
  /** The user or the platform withheld the microphone. */
  | 'denied'
  /** The browser exposes no microphone capture at all. */
  | 'unsupported'
  /** The audio graph refused to start or stopped on its own. */
  | 'audio'

/** A capture that could not start. */
export class MicCaptureFaultError extends Error {
  /**
   * @param reason - the fault the seat reports.
   */
  constructor(readonly reason: MicCaptureFault) {
    super(`microphone capture did not start (${reason})`)
    this.name = 'MicCaptureFaultError'
  }
}

/** One chunk of float samples as the audio graph delivered it. */
export interface CaptureBlock {
  readonly samples: Float32Array
  readonly rate: number
  readonly done: boolean
}

/** A running capture's audio graph. */
export interface CaptureGraph {
  /** The rate the graph actually runs at, which a device may pin above the requested one. */
  readonly rate: number
  /**
   * Take the next block of samples.
   * @returns the block, with `done` set once the graph is stopped.
   */
  next(): Promise<CaptureBlock>
  /** Release the graph and the microphone. */
  stop(): Promise<void>
}

/** The browser surfaces one capture needs. */
export interface MicCaptureEnvironment {
  /**
   * Ask for the microphone.
   * @returns the capture constraints to request.
   */
  mediaStream(): Promise<MediaStream>
  /**
   * Start the audio graph the capture reads from.
   * @param stream - the granted microphone stream.
   * @param onFault - reports a graph failure the seat must show.
   * @returns the running graph.
   */
  graph(stream: MediaStream, onFault: (reason: MicCaptureFault) => void): Promise<CaptureGraph>
}

/**
 * Resolve the browser's microphone capture surfaces.
 * @returns the environment, or `undefined` when this browser captures no audio.
 */
export function micCaptureEnvironment(): MicCaptureEnvironment | undefined {
  const scope = globalThis as {
    navigator?: { mediaDevices?: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> } }
    AudioContext?: new (options: { sampleRate: number }) => AudioContext
  }
  const devices = scope.navigator?.mediaDevices
  const Ctor = scope.AudioContext
  if (devices?.getUserMedia === undefined || Ctor === undefined) return undefined
  const capture = devices as { getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> }
  return {
    // Called through the devices object rather than a detached reference, so
    // the browser method keeps the receiver it was defined on.
    mediaStream: async () => await capture.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }),
    graph: async (stream, onFault) => await audioGraph(new Ctor({ sampleRate: VOICE_LIVE_SAMPLE_RATE }), stream, onFault),
  }
}

/** One running capture. */
export interface MicCapture {
  /** Stop the microphone and the audio graph, and await both. */
  stop(): Promise<void>
}

/**
 * Start capturing microphone audio.
 * @param environment - the browser surfaces to drive.
 * @param handlers - the chunk and fault callbacks.
 * @returns the running capture.
 * @throws a {@link MicCaptureFaultError} naming why capture could not start.
 */
export async function startMicCapture(
  environment: MicCaptureEnvironment,
  handlers: MicCaptureHandlers,
): Promise<MicCapture> {
  let stream: MediaStream
  try {
    stream = await environment.mediaStream()
  } catch {
    // getUserMedia rejects for a withheld permission and for a device the
    // platform cannot open; the seat reports both the same way.
    throw new MicCaptureFaultError('denied')
  }
  let graph: CaptureGraph
  try {
    graph = await environment.graph(stream, (reason) => { handlers.onFault(reason) })
  } catch {
    for (const track of stream.getTracks()) track.stop()
    throw new MicCaptureFaultError('audio')
  }
  let carry: Float32Array = new Float32Array(0)
  let stopped = false
  const run = async (): Promise<void> => {
    while (!stopped) {
      const block = await graph.next()
      if (block.done) break
      const samples = resample(block.samples, block.rate, VOICE_LIVE_SAMPLE_RATE)
      const { chunks, rest } = takePcmChunks(carry, samples)
      carry = rest
      for (const chunk of chunks) {
        const bytes = encodePcm16(chunk)
        handlers.onChunk({ data: toBase64(bytes), bytes: bytes.byteLength, level: rmsLevel(chunk) })
      }
    }
  }
  const running = run()
  let stopping: Promise<void> | undefined
  return {
    stop: () => {
      stopping ??= (async () => {
        stopped = true
        await graph.stop()
        // The capture loop ends on the graph's own final block; awaiting it here
        // keeps `stop` a quiescent teardown instead of a request to stop.
        /* v8 ignore next -- the capture loop never rejects: it ends on its graph's own final block. */
        await running.catch(() => {})
      })()
      return stopping
    },
  }
}

/**
 * Wire one `AudioContext` to a block queue.
 * @param context - the browser's audio context, created at the requested rate.
 * @param stream - the granted microphone stream.
 * @param onFault - reports a graph failure.
 * @returns the running graph.
 */
async function audioGraph(
  context: AudioContext,
  stream: MediaStream,
  onFault: (reason: MicCaptureFault) => void,
): Promise<CaptureGraph> {
  const source = context.createMediaStreamSource(stream)
  const processor = await captureProcessor(context, stream)
  // The node draws for as long as it is connected to the graph; the capture
  // reads its messages, so the node needs no output connection of its own.
  source.connect(processor.node)
  const queue: Float32Array[] = []
  let wake: (() => void) | undefined
  let ended = false
  processor.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    queue.push(event.data)
    const resolve = wake
    wake = undefined
    resolve?.()
  }
  context.onstatechange = () => {
    if (context.state !== 'running') onFault('audio')
  }
  const stop = async (): Promise<void> => {
    /* v8 ignore next -- startMicCapture is what calls this, once per capture. */
    if (ended) return
    ended = true
    const resolve = wake
    wake = undefined
    resolve?.()
    processor.node.port.onmessage = null
    source.disconnect()
    processor.node.disconnect()
    for (const track of stream.getTracks()) track.stop()
    processor.release()
    await context.close()
  }
  return {
    rate: context.sampleRate,
    next: async () => {
      while (true) {
        const samples = queue.shift()
        if (samples !== undefined) return { samples, rate: context.sampleRate, done: false }
        if (ended) return { samples: new Float32Array(0), rate: context.sampleRate, done: true }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    stop,
  }
}

/** The audio worklet node and the module URL its processor was loaded from. */
interface CaptureProcessor {
  readonly node: AudioWorkletNode
  /** Release the processor's module URL. */
  release(): void
}

/**
 * Load the capture processor into the context.
 * @param context - the target audio context.
 * @param stream - the granted microphone stream, released when the load fails.
 * @returns the node and its module URL's disposer.
 */
async function captureProcessor(context: AudioContext, stream: MediaStream): Promise<CaptureProcessor> {
  const url = URL.createObjectURL(new Blob([CAPTURE_PROCESSOR], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(url)
    const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME)
    return {
      node,
      release: () => { URL.revokeObjectURL(url) },
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    for (const track of stream.getTracks()) track.stop()
    await context.close()
    throw error
  }
}

/** Name the capture worklet registers under. */
const CAPTURE_PROCESSOR_NAME = 'dsh-voice-capture'

/**
 * The capture worklet: post each render quantum as a transferable buffer. It
 * carries no state and applies no processing — resampling and framing stay on
 * the main thread, where they are ordinary testable functions.
 */
const CAPTURE_PROCESSOR = `
class DshVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel && channel.length > 0) this.port.postMessage(channel.slice())
    return true
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, DshVoiceCapture)
`
