/**
 * Browser side of the polish pass: one POST to the host's Connection Fetch
 * route and how the pass settled. The polish is best-effort, so every failure
 * returns the submitted transcript unchanged — dictation keeps working with no
 * Gemini key, no network, and no host route at all.
 */

import {
  VOICE_POLISH_CODE_RATE_LIMITED,
  VOICE_POLISH_CODE_TIMEOUT,
  VOICE_POLISH_CODE_UNAVAILABLE,
  VOICE_POLISH_INPUT_FIELD,
  VOICE_POLISH_PATH,
} from '../protocol.ts'
import type { VoicePolishEnvelope } from '../protocol.ts'

/**
 * How one polish pass settled; only `'ok'` means the returned text was cleaned.
 * A pass reports on every attempt rather than once per mount, because the
 * host's key can be revoked or restored between two utterances.
 */
export type PolishStatus =
  /** The host returned cleaned text. */
  | 'ok'
  /** No key resolved, or no route is mounted here — this deployment never polishes. */
  | 'unavailable'
  /** The provider refused the request for quota. */
  | 'rate-limited'
  /** The deadline elapsed before an answer arrived. */
  | 'timeout'
  /** Any other provider or transport fault. */
  | 'failed'

/** Text to insert plus the seat state the button reports. */
export interface PolishPass {
  /** Cleaned transcript when the host cleaned it, otherwise the submitted text. */
  readonly text: string
  /** How the pass settled. */
  readonly status: PolishStatus
}

/**
 * Polish one settled transcript through the host route.
 * @param text - the raw transcript to clean up.
 * @param signal - caller cancellation; an aborted pass resolves to the raw text.
 * @returns the cleaned text when the host cleaned it, otherwise `text` unchanged.
 */
export async function polish(text: string, signal?: AbortSignal): Promise<string> {
  return (await send(text, signal)).text
}

/**
 * Run one polish pass and report how it settled.
 * @param text - the raw transcript to clean up.
 * @param signal - caller cancellation; an aborted pass resolves to the raw text.
 * @returns the text to insert plus the seat state the button reports.
 */
export async function send(text: string, signal?: AbortSignal): Promise<PolishPass> {
  const raw: PolishPass = { text, status: 'failed' }
  try {
    const response = await fetch(VOICE_POLISH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ [VOICE_POLISH_INPUT_FIELD]: text }),
      ...signal === undefined ? {} : { signal },
    })
    // A route this deployment never mounted answers the shared channel's 404.
    if (response.status === 404) return { text, status: 'unavailable' }
    if (!response.ok) return raw
    const envelope = await response.json() as VoicePolishEnvelope
    return envelope.ok ? { text: envelope.text, status: 'ok' } : { text, status: statusOfCode(envelope.error.code) }
  } catch {
    // A transport fault or caller cancellation: the transcript the caller
    // already holds is the answer, and the seat keeps dictation usable.
    return raw
  }
}

/**
 * Map a failure code onto the seat state the button reports.
 * @param code - the envelope's failure code.
 * @returns the matching state, or `'failed'` for any code this build does not know.
 */
function statusOfCode(code: string): PolishStatus {
  if (code === VOICE_POLISH_CODE_UNAVAILABLE) return 'unavailable'
  if (code === VOICE_POLISH_CODE_RATE_LIMITED) return 'rate-limited'
  if (code === VOICE_POLISH_CODE_TIMEOUT) return 'timeout'
  return 'failed'
}
