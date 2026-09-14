/**
 * Controllable stand-in for the runtime's global `WebSocket`, so the live
 * socket, session, and route specs drive one transport contract without a
 * provider connection.
 */
import type { LiveWebSocket, LiveWebSocketCtor, LiveWebSocketMessageEvent } from '../src/live-socket.ts'

/** Session established but not yet upgraded. */
const CONNECTING = 0

/** Session open for messages. */
const OPEN = 1

/** Session closed. */
const CLOSED = 3

/** One registered transport listener. */
export type StubListener = (event: never) => void

/** One transport under a spec's control, plus the registry that built it. */
export class FakeSocket implements LiveWebSocket {
  readyState = CONNECTING
  /** `wss:` endpoint this transport was asked for. */
  readonly url: string
  /** Request headers the constructor received; the key travels here. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Raw messages this transport sent. */
  readonly sent: string[] = []
  /** Whether a close was requested. */
  closed = false
  /** How many times a close was requested. */
  closeCalls = 0
  private readonly listeners = new Map<string, Set<StubListener>>()

  /**
   * @param url - endpoint the code under test asked for.
   * @param options - connecting options carrying the request headers.
   */
  constructor(
    url: string,
    options?: { readonly headers: Readonly<Record<string, string>> },
  ) {
    this.url = url
    this.headers = options?.headers
  }

  addEventListener(type: string, listener: StubListener): void {
    const set = this.listeners.get(type) ?? new Set<StubListener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: StubListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.closeCalls += 1
    this.readyState = CLOSED
  }

  /**
   * Hand one event to this transport's listeners.
   * @param type - event name.
   * @param event - the frame, whose own `text` drives the read when the case supplies one.
   */
  fire(type: 'message', event: { readonly data: unknown; readonly text?: () => Promise<string> }): void
  /**
   * Hand one event to this transport's listeners.
   * @param type - event name.
   * @param event - the event payload, for the events that carry one.
   */
  fire(type: 'error', event: { readonly error?: unknown }): void
  /**
   * Hand one event to this transport's listeners.
   * @param type - event name.
   */
  fire(type: 'open' | 'close'): void
  /**
   * Hand one event to this transport's listeners.
   * @param type - event name.
   * @param event - the event payload, for the events that carry one.
   */
  fire(type: string, event?: unknown): void {
    if (type === 'open') this.readyState = OPEN
    for (const listener of [...this.listeners.get(type) ?? []]) {
      ;(listener as (payload: unknown) => void)(this.payload(type, event))
    }
  }

  /**
   * The value one listener receives.
   * @param type - event name.
   * @param event - the raw event the spec passed.
   * @returns the transport's own event object.
   */
  private payload(type: string, event: unknown): unknown {
    if (type !== 'message') return event
    // A case that supplies its own event drives the read itself, which is how a
    // frame this build cannot decode reaches the socket under test.
    if (typeof event === 'object' && event !== null && 'text' in event) return event
    const data = (event as { readonly data: unknown }).data
    const text = typeof data === 'string' ? data : (data as Blob).text()
    return { data, text: async () => await text } satisfies LiveWebSocketMessageEvent
  }

  /** The last message this transport sent, parsed. */
  get last(): unknown {
    const raw = this.sent.at(-1)
    return raw === undefined ? undefined : JSON.parse(raw) as unknown
  }
}

/** Builds the transports one spec's socket under test drives. */
export class SocketRegistry {
  /** Transports in construction order. */
  readonly sockets: FakeSocket[] = []

  /** The constructor to hand the code under test. */
  readonly ctor: LiveWebSocketCtor = FakeSocketCtor.bind(undefined, this) as unknown as LiveWebSocketCtor

  /** The most recently built transport. */
  get last(): FakeSocket {
    const socket = this.sockets.at(-1)
    if (socket === undefined) throw new Error('no socket was constructed')
    return socket
  }

  /** Every transport this registry built, released and listening to nobody. */
  get count(): number {
    return this.sockets.length
  }
}

/**
 * The constructor the registry binds itself into: it publishes the transport it
 * built and hands it back, so the code under test drives a recorded socket.
 * @param registry - the registry to publish this transport to.
 * @param url - endpoint the code under test asked for.
 * @param _protocols - unused subprotocol list.
 * @param options - connecting options carrying the request headers.
 * @returns the recorded transport.
 */
function FakeSocketCtor(
  registry: SocketRegistry,
  url: string,
  _protocols?: string | readonly string[],
  options?: { readonly headers: Readonly<Record<string, string>> },
): FakeSocket {
  const socket = new FakeSocket(url, options)
  registry.sockets.push(socket)
  return socket
}
