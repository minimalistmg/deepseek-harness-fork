/**
 * Wire vocabulary of the live dictation transport: the Connection Fetch route
 * the browser streams microphone audio into, the newline-delimited frames
 * travelling in each direction, and the failure codes both halves share.
 *
 * Audio goes up as one JSON object per line; transcript frames come down the
 * same request's response body the same way. The request stream ending IS the
 * end of the utterance — the host sends Gemini's `audioStreamEnd` then — so the
 * upstream direction has no terminator frame and a caller cannot leave one out.
 *
 * The module holds no runtime dependency, so the browser bundle inlines it
 * rather than requesting a module-table row.
 */

/** Exact Fetch route below `/api` carrying one continuous dictation utterance. */
export const VOICE_LIVE_PATH = '/api/voice/live'

/** Request and response media type of the live route. */
export const VOICE_LIVE_MEDIA_TYPE = 'application/x-ndjson'

/** Upstream frame tag carrying one base64 PCM chunk. */
export const VOICE_LIVE_FRAME_AUDIO = 'audio'

/** Downstream frame tag reporting that the provider link accepts audio. */
export const VOICE_LIVE_FRAME_READY = 'ready'

/** Downstream frame tag carrying a provisional transcript. */
export const VOICE_LIVE_FRAME_INTERIM = 'interim'

/** Downstream frame tag carrying a settled transcript. */
export const VOICE_LIVE_FRAME_FINAL = 'final'

/** Downstream frame tag reporting that the utterance is over and no frame follows. */
export const VOICE_LIVE_FRAME_IDLE = 'idle'

/** Downstream frame tag reporting a fault the seat shows the user. */
export const VOICE_LIVE_FRAME_ERROR = 'error'

/** Failure code for a deployment that resolves no Gemini credential. */
export const VOICE_LIVE_CODE_UNAVAILABLE = 'voice/live-unavailable'

/** Failure code for a socket that never completed its setup, or a protocol message this build cannot read. */
export const VOICE_LIVE_CODE_FAILED = 'voice/live-failed'

/** Failure code for a warm socket dropped after sitting unused. */
export const VOICE_LIVE_CODE_IDLE = 'voice/live-idle'

/** Media type a request body must declare to reach the live route. */
export const VOICE_LIVE_REQUEST_MEDIA_TYPE = 'application/x-ndjson'

/** Cap on one decoded audio chunk; 1600 frames of 16-bit mono is 3200 bytes. */
export const VOICE_LIVE_MAX_CHUNK_BYTES = 64 * 1024

/** One base64-encoded 16 kHz PCM chunk on its way to the provider link. */
export interface VoiceLiveAudioFrame {
  /** Frame discriminator. */
  readonly type: typeof VOICE_LIVE_FRAME_AUDIO
  /** Monotonic index of this chunk within its utterance, from 0. */
  readonly sequence: number
  /** Base64 of little-endian signed 16-bit mono samples. */
  readonly data: string
}

/** Every frame the browser may write into the request body. */
export type VoiceLiveInputFrame = VoiceLiveAudioFrame

/** Transcript frames plus the two lifecycle frames the host writes downstream. */
export type VoiceLiveOutputFrame =
  | { readonly type: typeof VOICE_LIVE_FRAME_READY }
  | { readonly type: typeof VOICE_LIVE_FRAME_INTERIM; readonly text: string }
  | { readonly type: typeof VOICE_LIVE_FRAME_FINAL; readonly text: string }
  | { readonly type: typeof VOICE_LIVE_FRAME_IDLE }
  | {
    readonly type: typeof VOICE_LIVE_FRAME_ERROR
    /** Stable discriminator the browser maps to a localized seat state. */
    readonly code: string
    /** Operator-facing detail; never product copy. */
    readonly message: string
  }

/**
 * Read one upstream frame.
 * @param value - parsed JSON from one request-body line.
 * @returns the frame to ingest, or `undefined` for anything else on the wire.
 */
export function voiceLiveInputFrame(value: unknown): VoiceLiveInputFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['type'] !== VOICE_LIVE_FRAME_AUDIO) return undefined
  const sequence = record['sequence']
  const data = record['data']
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) return undefined
  if (typeof data !== 'string' || data === '') return undefined
  return { type: VOICE_LIVE_FRAME_AUDIO, sequence: sequence as number, data }
}

/**
 * Read one downstream frame.
 * @param value - parsed JSON from one response-body line.
 * @returns the frame to report, or `undefined` for anything else on the wire.
 */
export function voiceLiveOutputFrame(value: unknown): VoiceLiveOutputFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const type = record['type']
  if (type === VOICE_LIVE_FRAME_READY) return { type: VOICE_LIVE_FRAME_READY }
  if (type === VOICE_LIVE_FRAME_IDLE) return { type: VOICE_LIVE_FRAME_IDLE }
  if (type === VOICE_LIVE_FRAME_INTERIM || type === VOICE_LIVE_FRAME_FINAL) {
    const text = record['text']
    return typeof text === 'string' && text !== '' ? { type, text } : undefined
  }
  if (type === VOICE_LIVE_FRAME_ERROR) {
    const code = record['code']
    const message = record['message']
    if (typeof code !== 'string') return undefined
    return { type: VOICE_LIVE_FRAME_ERROR, code, message: typeof message === 'string' ? message : '' }
  }
  return undefined
}
