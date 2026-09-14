/**
 * One outbound Gemini Live socket: the provider handshake, the audio and
 * `audioStreamEnd` writes, and the provider messages the session binds per
 * utterance. A socket serves exactly one utterance and is then replaced, so
 * every listener lives in a registry whose disposer clears it: releasing the
 * socket silences it before the close is requested, and a late message, error,
 * or close from a replaced socket reaches nobody.
 *
 * The transport is the runtime's global `WebSocket`, addressed with the key in
 * the `x-goog-api-key` header so the secret never reaches a URL.
 * @module @deepseek-ai/dsh-client-ui-voice/live-socket
 */

import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Timeout code stamped onto the setup and close deadlines of one socket. */
export const VOICE_LIVE_SOCKET_TIMEOUT_CODE = 'VOICE_LIVE_SOCKET_TIMEOUT'

/** Audio encoding and sample rate the browser captures and the provider requires. */
export const VOICE_LIVE_AUDIO_MIME_TYPE = 'audio/pcm;rate=16000'

/** Versioned WebSocket endpoint of the provider's bidirectional generate-content method. */
export const GEMINI_LIVE_WS_PATH =
  '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

/** Path segment prefixing the configured model id, as the setup message carries it. */
const MODEL_PATH_PREFIX = 'models/'

/** Request header carrying the API key, so the secret never reaches the URL. */
const API_KEY_HEADER = 'x-goog-api-key'

/** The only modality this deployment asks for; it renders no spoken audio. */
const RESPONSE_MODALITIES = ['TEXT'] as const

/** WebSocket session open for messages. */
const OPEN = 1

/** One provider message this build can use. */
export type VoiceLiveMessage =
  /** The setup message was accepted; audio may follow. */
  | { readonly kind: 'ready' }
  /** Provisional transcript of the audio received so far. */
  | { readonly kind: 'interim'; readonly text: string }
  /** Settled transcript of the audio received so far. */
  | { readonly kind: 'final'; readonly text: string }
  /** The provider refused or aborted the session. */
  | { readonly kind: 'error'; readonly message: string }
  /** A well-formed message this build has no use for (turn completions, usage metadata). */
  | { readonly kind: 'ignored' }

/** One provider message frame, as the global WebSocket hands it over. */
export interface LiveWebSocketMessageEvent {
  /** The frame's payload: text for the messages this protocol carries. */
  readonly data?: unknown
  /** @returns the frame's text, or a rejected promise when the frame was not text. */
  text(): Promise<string>
}

/** One provider socket fault. */
export interface LiveWebSocketErrorEvent {
  /** The transport's own failure. */
  readonly error?: unknown
}

/** The slice of the global WebSocket this module drives. */
export interface LiveWebSocket {
  readonly readyState: number
  /** Frame listener; {@link GeminiLiveSocket.observe} and {@link GeminiLiveSocket.release} own its lifetime. */
  addEventListener(type: 'message', listener: (event: LiveWebSocketMessageEvent) => void): void
  /** Transport-fault listener. */
  addEventListener(type: 'error', listener: (event: LiveWebSocketErrorEvent) => void): void
  /** Lifecycle listener for both handshakes: open is awaited on connect, close on release. */
  addEventListener(type: 'open' | 'close', listener: () => void): void
  removeEventListener(type: 'message', listener: (event: LiveWebSocketMessageEvent) => void): void
  removeEventListener(type: 'error', listener: (event: LiveWebSocketErrorEvent) => void): void
  removeEventListener(type: 'open' | 'close', listener: () => void): void
  /** @param data - the already-serialized message. */
  send(data: string): void
  /** Close the transport with the protocol's normal-closure status. */
  close(): void
}

/**
 * Constructor of a provider socket.
 * @param url - absolute `wss:` endpoint.
 * @param protocols - unused subprotocol list; the key travels as a header.
 * @param options - connecting options, carrying only the request headers.
 */
export type LiveWebSocketCtor = new (
  url: string,
  protocols?: string | readonly string[],
  options?: { readonly headers: Readonly<Record<string, string>> },
) => LiveWebSocket

/**
 * Project the configured HTTP origin onto the provider's WebSocket endpoint.
 * @param baseURL - configured endpoint origin, `http:` or `https:`.
 * @returns the absolute `wss:`/`ws:` endpoint the key is sent to.
 */
export function liveSocketURL(baseURL: string): string {
  const url = new URL(baseURL)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = GEMINI_LIVE_WS_PATH
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Resolve the transport constructor this runtime provides.
 * @returns the global WebSocket constructor.
 * @throws when the runtime ships none.
 */
export function globalLiveSocketCtor(): LiveWebSocketCtor {
  const ctor = (globalThis as { WebSocket?: LiveWebSocketCtor }).WebSocket
  if (ctor === undefined) {
    throw new Error('this runtime provides no WebSocket implementation for the voice link')
  }
  return ctor
}

/**
 * The provider's setup message.
 * @param model - configured model id.
 * @returns the setup message body.
 */
export function liveSetupMessage(model: string): object {
  return {
    setup: {
      model: `${MODEL_PATH_PREFIX}${model}`,
      generationConfig: { responseModalities: [...RESPONSE_MODALITIES] },
      inputAudioTranscription: { languageCodes: [] },
    },
  }
}

/**
 * Parse one provider message.
 * @param text - the frame's text.
 * @returns what this build can use from the message.
 */
export function parseLiveMessage(text: string): VoiceLiveMessage {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'ignored' }
  }
  if (typeof value !== 'object' || value === null) return { kind: 'ignored' }
  const record = value as Record<string, unknown>
  if (record['setupComplete'] !== undefined) return { kind: 'ready' }
  const error = record['error']
  if (typeof error === 'object' && error !== null) {
    return { kind: 'error', message: failureDetail((error as Record<string, unknown>)['message']) }
  }
  const content = record['serverContent']
  if (typeof content !== 'object' || content === null) return { kind: 'ignored' }
  const server = content as Record<string, unknown>
  const settled = transcriptText(server['inputTranscription'])
  if (settled !== undefined) return { kind: 'final', text: settled }
  const interim = transcriptText(server['interimInputTranscription'])
  if (interim !== undefined) return { kind: 'interim', text: interim }
  return { kind: 'ignored' }
}

/** Everything one socket needs, resolved once at its construction. */
export interface GeminiLiveSocketOptions {
  /** Configured endpoint origin the socket URL is projected from. */
  readonly baseURL: string
  /** Configured model id the setup message names. */
  readonly model: string
  /** Deadline for the connect, setup, and close handshakes, in milliseconds. */
  readonly connectTimeoutMs: number
  /** Deadline for one graceful close before the transport is abandoned, in milliseconds. */
  readonly closeTimeoutMs: number
  /** The socket constructor to drive; configuration supplies the runtime's global one. */
  readonly ctor: LiveWebSocketCtor
}

/**
 * One provider link. Construction reports nothing: the caller awaits
 * {@link GeminiLiveSocket.open}, which resolves only after the provider
 * acknowledged the setup, so a socket in hand is a socket that takes audio.
 *
 * The key is a parameter of {@link GeminiLiveSocket.open} rather than of the
 * constructor, so a warm socket is built from configuration alone and only an
 * open connection ever holds a credential.
 */
export class GeminiLiveSocket {
  private readonly options: GeminiLiveSocketOptions
  private readonly disposers: (() => void)[] = []
  private setup: Promise<void> | undefined
  private settleSetup: { resolve: () => void; reject: (reason: Error) => void } | undefined
  private failure: Error | undefined
  private closeInFlight: Promise<void> | undefined
  private released = false
  private setupDone = false
  /** The current utterance's message listener; undefined between utterances. */
  private utterance: ((message: VoiceLiveMessage) => void) | undefined

  /**
   * @param options - resolved options for this socket.
   */
  constructor(options: GeminiLiveSocketOptions) {
    this.options = options
  }

  /**
   * Wait for the provider to acknowledge the setup, so the returned socket
   * accepts audio.
   * @param apiKey - the resolved credential; it reaches only the request header.
   * @returns this socket.
   * @throws when the link fails, or the handshake outlives the connect deadline.
   */
  async open(apiKey: string): Promise<GeminiLiveSocket> {
    const socket = this.transport(apiKey)
    // A transport that already failed before this call reports its cause at
    // once instead of parking the wait until the deadline.
    if (this.failure !== undefined) {
      await this.release()
      throw this.failure
    }
    using d = deadline(undefined, this.options.connectTimeoutMs, VOICE_LIVE_SOCKET_TIMEOUT_CODE)
    this.setup = new Promise<void>((resolve, reject) => { this.settleSetup = { resolve, reject } })
    // The setup promise rejects on a link no caller is awaiting before open()
    // itself settles; open() reports the failure.
    this.setup.catch(() => {})
    try {
      await this.settle(this.opened(), d.signal)
      console.log('[voice] host: sending setup for', this.options.model)
      socket.send(JSON.stringify(liveSetupMessage(this.options.model)))
      await this.settle(this.setup, d.signal)
    } catch (error) {
      await this.release()
      throw error
    }
    return this
  }

  /**
   * Install the message listener for the next utterance. A socket carries one
   * utterance, so the session installs each listener after the previous
   * utterance released it; {@link GeminiLiveSocket.release} clears whatever is
   * still installed.
   * @param listener - receives every post-setup provider message until released.
   * @returns the disposer clearing that listener.
   */
  observe(listener: (message: VoiceLiveMessage) => void): () => void {
    this.utterance = listener
    return () => {
      /* v8 ignore next -- a session clears the observer it installed. */
      if (this.utterance === listener) this.utterance = undefined
    }
  }
  /**
   * Write one audio chunk.
   * @param data - base64 PCM the captured audio was encoded to.
   * @returns whether the socket accepted the write.
   */
  sendAudio(data: string): boolean {
    return this.write(JSON.stringify({
      realtimeInput: { audio: { data, mimeType: VOICE_LIVE_AUDIO_MIME_TYPE } },
    }))
  }

  /**
   * Tell the provider the utterance's audio is complete, so it settles the
   * transcripts it still holds.
   * @returns whether the socket accepted the write.
   */
  endAudio(): boolean {
    return this.write(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
  }

  /**
   * Drop every listener, then close the transport and await the close, so a
   * caller that awaited this holds a socket that has actually stopped.
   * @returns nothing; the wait is bounded by the configured close deadline.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.fail('voice link released')
    for (const dispose of this.disposers.splice(0)) dispose()
    const socket = this.socket
    if (socket === undefined) return
    socket.close()
    using d = deadline(undefined, this.options.closeTimeoutMs, VOICE_LIVE_SOCKET_TIMEOUT_CODE)
    await this.settle(this.closed(), d.signal).catch(() => {
      // A transport that never reports its close is abandoned; every listener
      // is already gone, so nothing it does later reaches this plugin.
    })
  }

  /** The open connection; undefined until {@link GeminiLiveSocket.open}. */
  private socket: LiveWebSocket | undefined

  /**
   * Build the transport for one open and install this socket's own listeners on
   * it. The frame listener is permanent because one transport serves the setup
   * handshake and then the utterance it was opened for; {@link GeminiLiveSocket.release}
   * is what removes it.
   * @param apiKey - the resolved credential for the request header.
   * @returns the connecting transport.
   */
  private transport(apiKey: string): LiveWebSocket {
    const socket = new this.options.ctor(liveSocketURL(this.options.baseURL), undefined, {
      headers: { [API_KEY_HEADER]: apiKey },
    })
    this.socket = socket
    this.listen('message', (event) => { void this.deliver(event) })
    this.listen('error', (event) => { console.error('[voice] host: socket error', failureDetail(event.error)); this.fail(failureDetail(event.error)) })
    this.listen('close', () => { console.error('[voice] host: socket closed by the provider'); this.fail('provider closed the voice link') })
    return socket
  }

  /**
   * Race one handshake promise against this socket's own deadline.
   * @param pending - the handshake promise.
   * @param signal - the fused deadline signal.
   * @returns the handshake's settlement.
   */
  private async settle(pending: Promise<void>, signal: AbortSignal): Promise<void> {
    await expireWith(pending, signal)
  }

  /** Awaits the transport's open event; a transport already open resolves at once. */
  private async opened(): Promise<void> {
    const socket = this.socket
    /* v8 ignore next -- open() is what builds the transport this waits on. */
    if (socket === undefined || socket.readyState === OPEN) return
    await this.event(socket, 'open', 'close')
    console.log('[voice] host: Gemini Live socket is open')
  }

  /** Awaits the transport's close event, idempotent across repeat releases. */
  private closed(): Promise<void> {
    this.closeInFlight ??= this.closedOnce()
    return this.closeInFlight
  }

  private async closedOnce(): Promise<void> {
    const socket = this.socket
    /* v8 ignore next -- release() returns before awaiting a close with no transport. */
    if (socket === undefined) return
    await this.event(socket, 'close')
  }

  /**
   * Await one transport event.
   * @param socket - the transport to watch.
   * @param type - the awaited event.
   * @param also - an event that settles the same wait, when the transport can end instead of advancing.
   * @returns a promise resolving when either event arrives; both listeners are removed either way.
   */
  private event(socket: LiveWebSocket, type: 'open' | 'close', also?: 'close'): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        removeListener(socket, type, settle)
        if (also !== undefined) removeListener(socket, also, settle)
        resolve()
      }
      addListener(socket, type, settle)
      if (also !== undefined) addListener(socket, also, settle)
    })
  }

  /**
   * Route one message frame: the setup acknowledgement settles this socket's
   * own handshake, and every later message belongs to the utterance that
   * installed its observer.
   * @param event - the transport's message event.
   */
  private async deliver(event: LiveWebSocketMessageEvent): Promise<void> {
    let text: string
    try {
      // Gemini Live answers over binary frames, so the frame's own payload is a
      // Blob or an ArrayBuffer rather than a string; `text()` decodes every form.
      text = await event.text()
    } catch {
      if (!this.setupDone) this.fail('provider sent a frame this build cannot read')
      return
    }
    const message = parseLiveMessage(text)
    console.log('[voice] host: provider frame ->', message.kind, text.slice(0, 200))
    if (message.kind === 'ready') {
      this.setupDone = true
      this.settleSetup?.resolve()
      return
    }
    if (message.kind === 'error' && !this.setupDone) {
      this.fail(message.message)
      return
    }
    this.utterance?.(message)
  }

  /**
   * Write one message.
   * @param data - serialized message.
   * @returns whether an open socket accepted it.
   */
  private write(data: string): boolean {
    const socket = this.socket
    if (this.released || socket === undefined || socket.readyState !== OPEN) return false
    socket.send(data)
    return true
  }

  /**
   * Record the first failure and settle a pending setup wait with it. Later
   * failures are ignored, so a socket reports the cause that actually ended it.
   * @param message - operator-facing reason.
   */
  private fail(message: string): void {
    this.failure ??= new Error(message)
    this.settleSetup?.reject(this.failure)
  }

  /**
   * Install one listener into this socket's registry.
   * @param type - event name.
   * @param listener - the listener to add.
   * @returns the disposer that removes it.
   */
  private listen<T extends keyof LiveSocketListenerMap>(
    type: T,
    listener: LiveSocketListenerMap[T],
  ): () => void {
    const socket = this.socket
    /* v8 ignore next 3 -- only a release between two of this socket's own calls can land here. */
    if (socket === undefined) {
      throw new Error('the voice link must be opened before its listeners are installed')
    }
    addListener(socket, type, listener)
    const dispose = (): void => { removeListener(socket, type, listener) }
    this.disposers.push(dispose)
    return dispose
  }
}

/** How each transport event's listener is typed. */
interface LiveSocketListenerMap {
  /** Frame listener. */
  message: (event: LiveWebSocketMessageEvent) => void
  /** Transport-fault listener. */
  error: (event: LiveWebSocketErrorEvent) => void
  /** Lifecycle listener. */
  open: () => void
  /** Lifecycle listener. */
  close: () => void
}

/**
 * Add one transport listener, in the transport's own union.
 * @param socket - the transport.
 * @param type - event name.
 * @param listener - the listener to add.
 */
function addListener<T extends keyof LiveSocketListenerMap>(
  socket: LiveWebSocket,
  type: T,
  listener: LiveSocketListenerMap[T],
): void {
  ;(socket.addEventListener as (type: T, listener: LiveSocketListenerMap[T]) => void)(type, listener)
}

/**
 * Remove one transport listener, in the transport's own union.
 * @param socket - the transport.
 * @param type - event name.
 * @param listener - the listener to remove.
 */
function removeListener<T extends keyof LiveSocketListenerMap>(
  socket: LiveWebSocket,
  type: T,
  listener: LiveSocketListenerMap[T],
): void {
  ;(socket.removeEventListener as (type: T, listener: LiveSocketListenerMap[T]) => void)(type, listener)
}

/**
 * A message for one caught transport or provider value.
 * @param error - whatever the transport failed with.
 * @returns the error's own message, or its string form.
 */
function failureDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' && error !== '' ? error : 'provider link failed'
}

/**
 * Await one handshake, giving up when the deadline signal aborts. The
 * handshake itself is not cancelled: the caller's next step is releasing the
 * socket, which is what actually stops it.
 * @param pending - the handshake promise.
 * @param signal - the socket's fused deadline signal.
 * @returns the handshake's settlement.
 */
async function expireWith(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  const expiry = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort)
      // A rejection reports an Error; this deadline's own reason carries the
      // code a caller matches on.
      /* v8 ignore next -- this deadline only ever aborts with its own reason. */
      const reason: unknown = timeoutOf(signal, VOICE_LIVE_SOCKET_TIMEOUT_CODE) ?? signal.reason
      reject(new Error(String(reason)))
    }
    /* v8 ignore next -- this deadline is fresh, so it cannot already have elapsed. */
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort)
  })
  // A deadline that fires after the handshake settled has no awaiter left, and
  // its rejection is not a fault anyone can act on.
  expiry.catch(() => {})
  await Promise.race([pending, expiry])
}

/**
 * The text one transcription block carries.
 * @param block - the provider's `inputTranscription` or `interimInputTranscription` value.
 * @returns the block's text, or `undefined` when it carries none.
 */
function transcriptText(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const text = (block as Record<string, unknown>)['text']
  return typeof text === 'string' && text !== '' ? text : undefined
}
