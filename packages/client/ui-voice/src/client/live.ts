/**
 * The seat's live dictation link: one streaming POST carrying microphone audio
 * up and transcript frames down the same request.
 *
 * The request body stays open for the whole utterance, so the host reads audio
 * as the microphone produces it instead of receiving one batch at the end. The
 * response body is the host's transcript stream: this module hands each frame to
 * the seat and awaits it, so the provider's socket stays paced by what the seat
 * can render.
 *
 * The microphone belongs to the link rather than to the seat because the two are
 * one operation — audio that reaches no link is not a recording anyone can use —
 * and because the browser's own speech engine is the link's fallback for a
 * microphone the live path cannot open. Every outcome is a {@link VoiceLivePass}
 * status, so the seat renders one result shape.
 * @module @deepseek-ai/dsh-client-ui-voice/client/live
 */

import { micCaptureEnvironment, startMicCapture } from './capture.ts'
import { dictationEngineCtor, startDictation } from './recognition.ts'
import { mergeTranscript } from './transcript.ts'
import {
  VOICE_LIVE_CODE_UNAVAILABLE,
  VOICE_LIVE_FRAME_ERROR,
  VOICE_LIVE_MEDIA_TYPE,
  VOICE_LIVE_PATH,
  VOICE_LIVE_REQUEST_MEDIA_TYPE,
  voiceLiveOutputFrame,
} from '../live-protocol.ts'
import type { VoiceLiveOutputFrame } from '../live-protocol.ts'

/** Failure code for a link that never reached the host. */
export const VOICE_LIVE_CODE_UNREACHABLE = 'voice/live-unreachable'

/** How one live utterance settled. */
export type VoiceLiveStatus =
  /** The link produced a transcript. */
  | 'ok'
  /** This deployment has no credential or no route, so no live link exists. */
  | 'unavailable'
  /** The microphone could not be opened. */
  | 'denied'
  /** The link, the provider, or the audio graph failed. */
  | 'failed'

/** What one live utterance left behind. */
export interface VoiceLivePass {
  /** The whole transcript the utterance assembled; empty for every status but `'ok'`. */
  readonly text: string
  /** How the utterance settled. */
  readonly status: VoiceLiveStatus
}

/** Callbacks one live utterance reports through. */
export interface LiveHandlers {
  /**
   * One transcript frame arrived; the seat renders it immediately.
   * @param text - the whole transcript so far.
   * @param settled - whether this frame settles words rather than guessing at them.
   */
  onTranscript(text: string, settled: boolean): void
  /** Live audio is flowing, so the seat reports listening. */
  onListening(): void
  /**
   * One captured chunk's level, on the 0–1 RMS scale. The seat reads this to
   * end a hands-free utterance after the speaker stops and to draw the level
   * meter; the provider path reports it as soon as the microphone is running,
   * and the browser fallback never does.
   * @param level - the chunk's root-mean-square level.
   */
  onLevel(level: number): void
}

/** The link's configured options and the seat's callbacks. */
export interface TranscribeRequest {
  /** The seat's callbacks. */
  readonly handlers: LiveHandlers
  /**
   * Whether the browser's own speech engine may take over when the live link or
   * the microphone cannot run. Off by default: the engine this ships in carries
   * no speech service, so the fallback only ever reports a fault there.
   */
  readonly webSpeech: boolean
  /**
   * Unmount cancellation. An aborted utterance stops its microphone and link
   * and reports `'denied'`, because the seat that would render a transcript is
   * gone and a live microphone outliving it is the worse outcome.
   */
  readonly signal?: AbortSignal
}

/** The transport surface one utterance drives; the default reaches the global `fetch`. */
export interface VoiceLinkEnvironment {
  /** @param input - request URL. @param init - request options with a streaming body. @returns the host's streamed answer. */
  fetch(input: string, init: RequestInit): Promise<Response>
}

/** One running live utterance, as the seat drives it. */
export interface LiveUtterance {
  /**
   * Stop listening and collect the transcript. Calling this ends the utterance
   * exactly once; the returned promise settles whenever the utterance ends,
   * whether the seat stopped it or the link gave up first.
   * @returns how the utterance settled, with the whole transcript it assembled.
   */
  stop(): Promise<VoiceLivePass>
}

/**
 * Start recording one utterance. Live audio flows as soon as the microphone and
 * the link are ready, so the seat reports progress through `onListening` rather
 * than from this call's settlement.
 * @param request - the seat's callbacks and the link's options.
 * @param environment - the transport surface to drive.
 * @returns the running utterance.
 */
export function transcribe(
  request: TranscribeRequest,
  /* v8 ignore start -- every call site supplies the transport it drives. */
  environment: VoiceLinkEnvironment = { fetch: async (input, init) => await fetch(input, init) },
  /* v8 ignore stop */
): LiveUtterance {
  const utterance = new LinkUtterance(request, environment)
  // The device path opens in the background; the seat collects the outcome when
  // it stops the utterance, which is the only moment a transcript is wanted.
  void utterance.start()
  return { stop: async () => await utterance.stop() }
}

/** One utterance's provider link, microphone, and assembled transcript. */
class LinkUtterance {
  private transcript = ''
  private sequence = 0
  private live: LiveSession | undefined
  private microphone: Microphone | undefined
  private fault: string | undefined
  private aborted = false
  private ended = false
  private phase: 'idle' | 'live' | 'browser' = 'idle'
  private session: BrowserSession | undefined

  /**
   * @param request - the seat's callbacks and the link's options.
   * @param environment - the transport surface to drive.
   */
  constructor(
    private readonly request: TranscribeRequest,
    private readonly environment: VoiceLinkEnvironment,
  ) {}

  /**
   * Open the microphone and, when it opened, the provider link.
   * @returns nothing; a failure it cannot fall back from is reported by {@link LinkUtterance.stop}.
   */
  async start(): Promise<void> {
    if (this.abandoned()) return
    const capture = await this.openMicrophone()
    if (this.abandoned()) return
    if (capture !== 'ok') {
      this.startBrowser(capture)
      return
    }
    this.phase = 'live'
    this.live = startLiveSession({
      onFrame: (frame) => { this.onFrame(frame) },
      onFault: (code) => { this.reportFault(code) },
    }, this.environment)
    this.request.handlers.onListening()
  }

  /**
   * End the utterance: stop the microphone, flush the link, and report what it assembled.
   * The first call decides the outcome; every later call answers the same.
   * @returns how the utterance settled.
   */
  async stop(): Promise<VoiceLivePass> {
    if (this.ended) return await this.settled
    this.ended = true
    this.settled = this.outcome()
    return await this.settled
  }

  /** The outcome promised to every caller of {@link LinkUtterance.stop}. */
  private settled: Promise<VoiceLivePass> = Promise.resolve({ text: '', status: 'denied' })

  private async outcome(): Promise<VoiceLivePass> {
    if (this.abandoned()) {
      await this.release()
      return { text: '', status: 'denied' }
    }
    if (this.phase === 'browser') {
      this.session?.stop()
      return { text: this.transcript.trim(), status: 'ok' }
    }
    if (this.phase === 'idle') {
      // The microphone never opened: the fault recorded at that point is the
      // whole outcome, and an unavailable route is the one worth naming.
      /* v8 ignore next -- a missing credential is the only route fault this arm sees. */
      return { text: '', status: this.fault === VOICE_LIVE_CODE_UNAVAILABLE ? 'unavailable' : 'denied' }
    }
    await this.release()
    const text = this.transcript.trim()
    if (text !== '') return { text, status: 'ok' }
    // The speaker produced no words: the link's own fault, when it reported one,
    // is the more useful thing to show than an empty transcript.
    if (this.fault === VOICE_LIVE_CODE_UNAVAILABLE) return { text: '', status: 'unavailable' }
    return { text: '', status: 'failed' }
  }

  /** Whether this utterance must release everything and report nothing. */
  private abandoned(): boolean {
    this.aborted ||= this.request.signal?.aborted === true
    return this.aborted
  }

  /** Stop the microphone and close the link, whatever state they reached. */
  private async release(): Promise<void> {
    await this.microphone?.stop()
    await this.live?.close()
  }

  /**
   * Route one transcript frame.
   * @param frame - the frame the host sent.
   */
  private onFrame(frame: VoiceLiveOutputFrame): void {
    if (frame.type === 'interim' || frame.type === 'final') {
      this.transcript = mergeTranscript(this.transcript, frame.text)
      this.request.handlers.onTranscript(this.transcript, frame.type === 'final')
    }
  }

  /**
   * Open the microphone and stream its chunks into the link.
   * @returns `'ok'` when capture is running, otherwise the status it failed with.
   */
  private async openMicrophone(): Promise<'ok' | 'denied' | 'failed'> {
    const environment = micCaptureEnvironment()
    if (environment === undefined) return 'denied'
    try {
      this.microphone = await startMicCapture(environment, {
        onChunk: (chunk) => {
          this.live?.push(chunk.data, this.sequence)
          this.sequence += 1
          this.request.handlers.onLevel(chunk.level)
        },
        onFault: () => { this.reportFault(VOICE_LIVE_CODE_UNREACHABLE) },
      })
      return 'ok'
    } catch {
      // getUserMedia rejects for a withheld permission and for a device the
      // platform cannot open; both read as a microphone this link cannot use.
      return 'denied'
    }
  }
  /**
   * Record the first failure this utterance saw.
   * @param code - the failure's stable code.
   */
  private reportFault(code: string): void {
    this.fault ??= code
  }

  /**
   * Run the browser's own recognition engine instead of the live link.
   * @param missing - the status to report when this browser ships no engine.
   */
  private startBrowser(missing: VoiceLiveStatus): void {
    const ctor = this.request.webSpeech ? dictationEngineCtor() : undefined
    if (ctor === undefined) {
      /* v8 ignore next -- the link reports an unavailable route, never the device. */
      this.reportFault(missing === 'unavailable' ? VOICE_LIVE_CODE_UNAVAILABLE : VOICE_LIVE_CODE_UNREACHABLE)
      return
    }
    this.phase = 'browser'
    this.session = startDictation(ctor, {
      onFinal: (text) => {
        this.transcript = mergeTranscript(this.transcript, text)
        this.request.handlers.onTranscript(this.transcript, true)
      },
      onEnd: () => {},
      onError: () => { this.reportFault(VOICE_LIVE_CODE_UNREACHABLE) },
    })
    this.request.handlers.onListening()
  }
}

/** One running live session over the host route. */
interface LiveSession {
  /**
   * Send one audio chunk.
   * @param data - base64 16 kHz PCM.
   * @param sequence - this chunk's index within the utterance, from 0.
   */
  push(data: string, sequence: number): void
  /**
   * End the utterance and wait for the host's transcript stream to finish.
   * @returns nothing once the host's stream is over.
   */
  close(): Promise<void>
}

/** One running browser-engine session. */
interface BrowserSession {
  /** Stop the engine. */
  stop(): void
}

/** One running microphone. */
interface Microphone {
  /** Stop the microphone and the audio graph, and await both. */
  stop(): Promise<void>
}

/** Callbacks one live session reports through. */
interface LiveSessionHandlers {
  /**
   * One transcript frame, in host order. The transport waits for this before
   * reading the next frame.
   * @param frame - the frame to render.
   */
  onFrame(frame: VoiceLiveOutputFrame): void
  /**
   * The link reported a failure; the session keeps whatever it can still read.
   * @param code - the failure's stable code.
   */
  onFault(code: string): void
}

/**
 * Start one live session over the host route.
 * @param handlers - the frame and fault callbacks.
 * @param environment - the transport surface to drive.
 * @returns the running session, immediately: the caller sends audio as the
 * microphone produces it without waiting for the host's handshake.
 */
function startLiveSession(
  handlers: LiveSessionHandlers,
  environment: VoiceLinkEnvironment,
): LiveSession {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  const body = new ReadableStream<Uint8Array>({ start: (self) => { controller = self } })
  console.log('[voice] browser: opening live link', VOICE_LIVE_PATH)
  const answered = environment.fetch(VOICE_LIVE_PATH, {
    method: 'POST',
    headers: { 'content-type': VOICE_LIVE_REQUEST_MEDIA_TYPE, accept: VOICE_LIVE_MEDIA_TYPE },
    body,
    duplex: 'half',
  } as RequestInit)
  const drained = answered.then(
    async (response) => { await readFrames(response, handlers) },
    () => {
      console.error('[voice] browser: the live link request itself failed (never reached the host)')
      handlers.onFault(VOICE_LIVE_CODE_UNREACHABLE)
    },
  )
  return {
    push: (data, at) => {
      // A frame written after the utterance closed has nowhere to go: the host
      // has already been told the audio is complete.
      /* v8 ignore next -- the microphone is released before anything closes the link. */
      if (closed || controller === undefined) return
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'audio', sequence: at, data })}\n`))
    },
    close: async () => {
      /* v8 ignore next -- the utterance releases its link once. */
      if (!closed) {
        closed = true
        controller?.close()
      }
      await drained
    },
  }
}

/**
 * Read the host's transcript stream to its end.
 * @param response - the host's answer.
 * @param handlers - the frame and fault callbacks.
 * @returns nothing; the stream is over either way.
 */
async function readFrames(response: Response, handlers: LiveSessionHandlers): Promise<void> {
  const body = response.body
  console.log('[voice] browser: host answered', response.status, 'ok=' + String(response.ok), 'body=' + String(body !== null))
  if (!response.ok || body === null) {
    // A route this deployment never mounted answers the shared channel's 404.
    handlers.onFault(response.status === 404 ? VOICE_LIVE_CODE_UNAVAILABLE : VOICE_LIVE_CODE_UNREACHABLE)
    return
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const take = (line: string): void => {
    const frame = line.trim() === '' ? undefined : voiceLiveOutputFrame(parse(line))
    if (frame === undefined) return
    if (frame.type === VOICE_LIVE_FRAME_ERROR) handlers.onFault(frame.code)
    else handlers.onFrame(frame)
  }
  while (true) {
    const next = await reader.read()
    if (next.done) break
    buffered += decoder.decode(next.value, { stream: true })
    let breakAt = buffered.indexOf('\n')
    while (breakAt >= 0) {
      take(buffered.slice(0, breakAt))
      buffered = buffered.slice(breakAt + 1)
      breakAt = buffered.indexOf('\n')
    }
  }
  // A stream that ended without its final terminator still carried a frame.
  take(buffered)
}

/**
 * Parse one response line.
 * @param line - one newline-delimited frame.
 * @returns the parsed value, or `undefined` when the line is not JSON.
 */
function parse(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
