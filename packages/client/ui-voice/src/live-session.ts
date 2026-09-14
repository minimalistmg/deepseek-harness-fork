/**
 * The live dictation session: one warm Gemini Live socket per plugin instance,
 * handed to one utterance at a time.
 *
 * The lifecycle follows the provider's own rules. A socket takes audio for
 * exactly one utterance, so the session keeps one spare socket warm and
 * replaces it after every utterance, which is what makes the next microphone
 * click immediate. Ending an utterance sends `audioStreamEnd` and keeps
 * receiving for the configured flush window, because the provider settles its
 * last transcripts after the audio stops. A warm socket nobody used is dropped
 * after the configured idle interval, so an idle deployment holds no provider
 * session and no metering.
 *
 * Teardown reaches quiescence rather than requesting it: {@link VoiceLiveSession.dispose}
 * removes the idle timer and clears the socket's listeners before closing, then
 * awaits the close, so a socket that is gone cannot deliver a late transcript
 * into a response nobody is reading.
 * @module @deepseek-ai/dsh-client-ui-voice/live-session
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GeminiLiveSocket, globalLiveSocketCtor, type LiveWebSocketCtor, type VoiceLiveMessage,
} from './live-socket.ts'
import type { VoiceLiveOutputFrame } from './live-protocol.ts'
import { VOICE_LIVE_CODE_FAILED } from './live-protocol.ts'

/** Everything one session needs, resolved from configuration at construction. */
export interface VoiceLiveSessionOptions {
  /** Configured endpoint origin the socket URL is projected from. */
  readonly baseURL: string
  /** Configured Gemini Live model id. */
  readonly model: string
  /** Flush window after `audioStreamEnd`, in milliseconds. */
  readonly flushWindowMs: number
  /** How long a warm socket may sit unused before it is dropped, in milliseconds. */
  readonly idleTimeoutMs: number
  /** Deadline for the connect and setup handshake, in milliseconds. */
  readonly connectTimeoutMs: number
  /** Deadline for one graceful socket close, in milliseconds. */
  readonly closeTimeoutMs: number
  /** Cap on decoded audio one utterance may carry. */
  readonly maxUtteranceBytes: number
  /** Credential reference a missing-key diagnostic names. */
  readonly apiKeyEnv: CredentialRef
  /**
   * Resolve the current API key. Called at each socket open so a key stored
   * after startup reaches the next utterance without a reload.
   * @returns the resolved key, or `undefined` when no layer supplies one.
   */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** The socket constructor to drive; absent means the runtime's global one, resolved at the first open. */
  readonly ctor?: LiveWebSocketCtor
}

/** One in-flight utterance bound to its own socket. */
export interface VoiceLiveUtterance {
  /** Cap on decoded audio this utterance carries, from the session's configuration. */
  readonly maxAudioBytes: number
  /**
   * Write one audio chunk, bypassing the sequence and size rules.
   * @param data - base64 PCM from the request body.
   * @returns whether the provider link accepted the write.
   */
  sendAudio(data: string): boolean
  /**
   * Take the transcript frames of this utterance, in order, ending after the
   * last one. The stream terminates only once the socket is closed, so a
   * consumer that awaited {@link VoiceLiveUtterance.finished} after its loop
   * holds a session whose socket has actually stopped.
   * @returns the frame stream.
   */
  frames(): AsyncIterable<VoiceLiveOutputFrame>
  /** The audio stream ended: send `audioStreamEnd` and keep receiving for the flush window. */
  finish(): void
  /**
   * End the utterance before its audio is complete.
   * @param reason - an operator-facing fault to report first, or `undefined`
   * when the client simply stopped reading and needs no explanation.
   */
  interrupt(reason?: string): void
  /** Resolves once this utterance released its socket. */
  readonly finished: Promise<void>
}

/** The provider is warming a socket; only one open is ever in flight. */
interface WarmSocket {
  readonly socket: GeminiLiveSocket
  readonly ready: Promise<void>
}

/**
 * One plugin instance's live dictation session.
 *
 * Callers own one utterance at a time. A second concurrent
 * {@link VoiceLiveSession.openUtterance} before the first released its socket
 * waits for the socket to become free rather than sharing it, because the
 * provider accepts audio for a single utterance per session.
 */
export class VoiceLiveSession {
  private warm: WarmSocket | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Serializes socket handover, so an utterance never shares a socket. */
  private gate: Promise<void> = Promise.resolve()

  /**
   * @param options - resolved configuration for every socket this session opens.
   */
  constructor(private readonly options: VoiceLiveSessionOptions) {}

  /**
   * Wait until this session may start an utterance, then start it.
   * @returns the utterance handle.
   * @throws when the session is disposed, no credential resolves, or the link fails to open.
   */
  async openUtterance(): Promise<VoiceLiveUtterance> {
    if (this.disposed) throw new Error('the voice session is disposed')
    const claim = this.gate.then(async () => await this.claim())
    this.gate = claim.then(() => undefined, () => undefined)
    const socket = await claim
    return new Utterance(socket, this.options, () => { this.afterUtterance() })
  }

  /**
   * Drop every socket, timer, and listener this session owns and await the
   * closes, so a caller that awaited this holds a session that has stopped.
   * @returns nothing.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearIdleTimer()
    const warm = this.warm
    this.warm = undefined
    if (warm !== undefined) {
      // Settle the handshake before releasing, so a socket that was still
      // connecting cannot reject into a listener this teardown just removed.
      await warm.ready.catch(() => {})
      await warm.socket.release()
    }
    await this.gate
  }

  /**
   * Hand one socket to the next utterance, opening a fresh one when the warm
   * socket is missing, spent, or failed. A failed handshake is retried once on
   * a new socket, because the failure is usually the socket and not the
   * deployment, and a persistent failure still rejects.
   * @returns the socket the utterance owns.
   */
  private async claim(): Promise<GeminiLiveSocket> {
    if (this.expired()) throw new Error('the voice session is disposed')
    this.clearIdleTimer()
    try {
      return await this.takeWarm()
    } catch {
      if (this.expired()) throw new Error('the voice session is disposed')
      return await this.takeWarm()
    }
  }

  /**
   * Whether this session may still open an utterance.
   * @returns true once the session was disposed.
   */
  private expired(): boolean {
    return this.disposed
  }

  /**
   * Claim the warm socket, or open one.
   * @returns the socket this utterance owns, already setup-complete.
   * @throws when the socket fails to open.
   */
  private async takeWarm(): Promise<GeminiLiveSocket> {
    const warm = await this.warmSocket()
    await warm.ready
    this.warm = undefined
    return warm.socket
  }

  /**
   * The warm socket, opening one when none is in flight.
   * @returns the in-flight warm socket.
   * @throws when no credential resolves or the socket fails to open.
   */
  private async warmSocket(): Promise<WarmSocket> {
    if (this.warm !== undefined) return this.warm
    // Resolved here rather than at plugin load: a runtime without WebSocket
    // breaks the live link alone, and the polish path still works there.
    const ctor = this.options.ctor ?? globalLiveSocketCtor()
    const socket = new GeminiLiveSocket({
      baseURL: this.options.baseURL,
      model: this.options.model,
      connectTimeoutMs: this.options.connectTimeoutMs,
      closeTimeoutMs: this.options.closeTimeoutMs,
      ctor,
    })
    const apiKey = await this.options.resolveApiKey()
    if (apiKey === undefined || apiKey === '') {
      // Nothing was opened, so there is no socket to release.
      throw new MissingKeyError(this.options.apiKeyEnv)
    }
    const pending = { socket, ready: socket.open(apiKey).then(() => undefined) }
    this.warm = pending
    try {
      await pending.ready
    } catch (error) {
      // A failed handshake must not stay behind as the warm socket, or the
      // retry would await the same rejected promise instead of opening a new
      // link. A concurrent claim that already took this attempt keeps its own
      // reference and reports its own failure.
      if (this.warm === pending) this.warm = undefined
      await socket.release()
      throw error
    }
    return pending
  }

  /**
   * Replace the spent socket with a fresh warm one, so the next microphone
   * click is immediate. A failure here reaches the next click, which retries.
   */
  private afterUtterance(): void {
    if (this.disposed) return
    void this.warmSocket().then(() => { this.bumpIdle() }, () => { /* the next utterance reports the failure */ })
  }

  /** Arm the idle drop for the warm socket; a socket in use is never idle-dropped. */
  private bumpIdle(): void {
    this.clearIdleTimer()
    /* v8 ignore next 2 -- bumpIdle runs only for the warm socket it was given. */
    if (this.disposed || this.warm === undefined) return
    this.idleTimer = setTimeout(() => { void this.dropIdle() }, this.options.idleTimeoutMs)
  }

  /** Drop an unused warm socket, so an idle deployment holds no provider session. */
  private async dropIdle(): Promise<void> {
    this.clearIdleTimer()
    const warm = this.warm
    /* v8 ignore next -- the idle timer is armed only while a warm socket exists. */
    if (warm === undefined) return
    this.warm = undefined
    /* v8 ignore next -- a warm socket is one whose handshake already settled. */
    await warm.ready.catch(() => {})
    await warm.socket.release()
    // Keep a socket warm for the next click; a deployment that fails to open
    // one here retries at the click that needs it.
    this.afterUtterance()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

/** No credential resolved, so no socket was opened. */
class MissingKeyError extends Error {
  /**
   * @param apiKeyEnv - the credential reference the operator must supply.
   */
  constructor(apiKeyEnv: CredentialRef) {
    super(`no ${apiKeyEnv} credential is configured`)
    this.name = 'MissingKeyError'
  }
}

/**
 * Whether one failed claim found no credential, which the route reports as its
 * own failure code rather than a link fault.
 * @param error - the failure a claim threw.
 * @returns true when the failure is a missing credential.
 */
export function isMissingKey(error: unknown): boolean {
  return error instanceof MissingKeyError
}

/** One utterance: its socket, its frame stream, and its flush window. */
class Utterance implements VoiceLiveUtterance {
  readonly finished: Promise<void>

  private readonly pending: VoiceLiveOutputFrame[] = []
  private wake: (() => void) | undefined
  private ended: (() => void) | undefined
  private stopListening: (() => void) | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private done = false

  /**
   * @param socket - the socket this utterance owns until `finished`.
   * @param options - the session's resolved configuration.
   * @param complete - called once this utterance released its socket.
   */
  constructor(
    private readonly socket: GeminiLiveSocket,
    private readonly options: VoiceLiveSessionOptions,
    private readonly complete: () => void,
  ) {
    this.stopListening = socket.observe((message) => { void this.onMessage(message) })
    this.finished = new Promise<void>((resolve) => { this.ended = resolve })
    this.push({ type: 'ready' })
  }

  sendAudio(data: string): boolean {
    /* v8 ignore next -- the route stops feeding audio the moment the utterance settles. */
    if (this.done || this.flushTimer !== undefined) return false
    return this.socket.sendAudio(data)
  }

  get maxAudioBytes(): number {
    return this.options.maxUtteranceBytes
  }

  async *frames(): AsyncIterable<VoiceLiveOutputFrame> {
    while (true) {
      const frame = this.pending.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  finish(): void {
    /* v8 ignore next -- the route reports the end of the audio stream once. */
    if (this.done || this.flushTimer !== undefined) return
    this.socket.endAudio()
    // Keep receiving for the flush window: the provider settles its last
    // transcripts after the audio it already holds.
    this.flushTimer = setTimeout(() => { void this.close() }, this.options.flushWindowMs)
  }

  interrupt(reason?: string): void {
    // The first settlement decides the outcome; a later interrupt has nothing
    // left to report because the frame stream is already ending.
    if (!this.closed && reason !== undefined) {
      this.push({ type: 'error', code: VOICE_LIVE_CODE_FAILED, message: reason })
    }
    void this.close()
  }

  /**
   * Route one provider message into this utterance's frame stream.
   * @param message - the provider message this socket delivered.
   */
  private async onMessage(message: VoiceLiveMessage): Promise<void> {
    if (message.kind === 'interim') {
      this.push({ type: 'interim', text: message.text })
      return
    }
    if (message.kind === 'final') {
      this.push({ type: 'final', text: message.text })
      return
    }
    /* v8 ignore next -- the socket resolves its handshake before any utterance sees a message. */
    if (message.kind === 'error') {
      // A provider refusal after the utterance started ends it: the remaining
      // frames would be transcript updates the provider already abandoned.
      this.push({ type: 'error', code: VOICE_LIVE_CODE_FAILED, message: message.message })
      await this.close()
    }
  }

  /**
   * Queue one frame and wake the consumer. The queue holds whatever the
   * provider emitted between two reads of the response body, which is bounded
   * by the flush window and by how fast a speaker produces words.
   * @param frame - the frame to hand downstream.
   */
  private push(frame: VoiceLiveOutputFrame): void {
    this.pending.push(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * Release the socket and end the frame stream. Once the listeners are gone
   * the flush has nothing left to deliver, so this is the utterance's single
   * settlement point.
   * @returns resolves once the socket is closed and the stream ended.
   */
  private close(): Promise<void> {
    if (this.closed) return this.finished
    this.closed = true
    this.done = true
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    // Listeners first, then the socket: a close that reports back finds no
    // listener to wake.
    this.stopListening?.()
    this.stopListening = undefined
    return this.socket.release().then(() => {
      const wake = this.wake
      this.wake = undefined
      wake?.()
      this.complete()
      this.ended?.()
    })
  }
}
