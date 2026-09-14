/**
 * Wire vocabulary shared by both halves of the voice plugin: the Connection
 * Fetch route the browser posts a transcript to, and the JSON envelope that
 * route answers with. The module holds no runtime dependency, so the browser
 * bundle inlines it rather than requesting a module-table row.
 */

/** Exact Fetch route below `/api` where the browser submits one transcript for polishing. */
export const VOICE_POLISH_PATH = '/api/voice/polish'

/** Request and response media type for the polish route. */
export const VOICE_POLISH_MEDIA_TYPE = 'application/json'

/** Request field carrying the raw transcript to clean up. */
export const VOICE_POLISH_INPUT_FIELD = 'text'

/** Failure code for a plugin that holds no credential plane at all. */
export const VOICE_POLISH_CODE_UNAVAILABLE = 'voice/polish-unavailable'

/** Failure code for the provider's own quota refusal. */
export const VOICE_POLISH_CODE_RATE_LIMITED = 'voice/polish-rate-limited'

/** Failure code for a request that outlived its deadline. */
export const VOICE_POLISH_CODE_TIMEOUT = 'voice/polish-timeout'

/** Failure code for every other provider or transport fault. */
export const VOICE_POLISH_CODE_FAILED = 'voice/polish-failed'

/** Successful polish: the text the browser inserts instead of the raw transcript. */
export interface VoicePolishOk {
  readonly ok: true
  /** The cleaned transcript, or the submitted input when the step degraded to identity. */
  readonly text: string
}

/** Unsuccessful polish: the browser inserts the raw transcript it already holds. */
export interface VoicePolishFailure {
  readonly ok: false
  /** Why no cleaned text came back; the browser keeps dictation working either way. */
  readonly error: {
    /** Stable discriminator the browser maps to a localized seat state. */
    readonly code: string
    /** Operator-facing detail; never product copy. */
    readonly message: string
    /** Structured detail carried alongside the message. */
    readonly details: object
  }
}

/** Body of one polish response. */
export type VoicePolishEnvelope = VoicePolishOk | VoicePolishFailure
