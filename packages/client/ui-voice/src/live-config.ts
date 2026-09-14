/**
 * Shipped defaults for the live dictation link. Each value is the default its
 * `Config` field declares; the schema is the configuration surface, so these
 * constants exist for the schema and for hand-built contexts only, never as a
 * second place a request path applies a default.
 * @module @deepseek-ai/dsh-client-ui-voice/live-config
 */

/**
 * Default Gemini Live model that transcribes speech. A Live transcription model
 * reports interim and settled transcripts of the audio it receives; a general
 * Live model would instead answer the speaker.
 */
export const DEFAULT_VOICE_LIVE_MODEL = 'gemini-3.5-transcribe-live'

/**
 * Default flush window after `audioStreamEnd`, in milliseconds. The provider
 * settles its last transcripts after the audio stops, so the response stays
 * open this long before the socket is released.
 */
export const DEFAULT_VOICE_LIVE_FLUSH_WINDOW_MS = 1000

/**
 * Default idle interval before an unused warm socket is dropped, in
 * milliseconds (8 minutes). Long enough that a dictating user never waits for a
 * handshake between two utterances, short enough that an abandoned composer
 * does not hold a provider session open.
 */
export const DEFAULT_VOICE_LIVE_IDLE_TIMEOUT_MS = 8 * 60 * 1000

/**
 * Default quiet period between the last transcript frame and the polish
 * request, in milliseconds. Trailing finals arrive a little after the audio
 * stops, and polishing before they land would clean an incomplete sentence.
 */
export const DEFAULT_VOICE_LIVE_SETTLE_MS = 220

/** Default deadline for one provider socket's connect and setup handshake, in milliseconds. */
export const DEFAULT_VOICE_LIVE_CONNECT_TIMEOUT_MS = 10_000

/** Default deadline for one graceful provider socket close, in milliseconds. */
export const DEFAULT_VOICE_LIVE_CLOSE_TIMEOUT_MS = 2000

/** Default cap on decoded audio one utterance may carry: 8 MiB, about 4 minutes of continuous speech. */
export const DEFAULT_VOICE_LIVE_MAX_UTTERANCE_BYTES = 8 * 1024 * 1024

/**
 * Whether the browser may fall back to its own speech engine when the live link
 * is unavailable. Off by default: the engine this ships in (Electron) has no
 * speech service, so the fallback would only ever report a fault there.
 */
export const DEFAULT_VOICE_WEB_SPEECH_ENABLED = false
