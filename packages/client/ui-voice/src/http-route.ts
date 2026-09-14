/** Authenticated polish route registered on the Connection fetch registry. */

import {
  VOICE_POLISH_CODE_FAILED,
  VOICE_POLISH_CODE_RATE_LIMITED,
  VOICE_POLISH_CODE_TIMEOUT,
  VOICE_POLISH_CODE_UNAVAILABLE,
  VOICE_POLISH_INPUT_FIELD,
  VOICE_POLISH_MEDIA_TYPE,
} from './protocol.ts'
import type { VoicePolishEnvelope } from './protocol.ts'
import type { VoicePolishOutcome, VoicePolishProvider } from './polish.ts'

/** One localized-state discriminator per non-success outcome. */
const FAILURE_CODES: Readonly<Record<Exclude<VoicePolishOutcome, 'ok'>, string>> = {
  'unavailable': VOICE_POLISH_CODE_UNAVAILABLE,
  'rate-limited': VOICE_POLISH_CODE_RATE_LIMITED,
  'timeout': VOICE_POLISH_CODE_TIMEOUT,
  'failed': VOICE_POLISH_CODE_FAILED,
}

/**
 * Handle one authenticated transcript polish.
 * @param provider - Host polisher serving the request.
 * @param request - authenticated HTTP request from Connection.
 * @returns the polish envelope using HTTP status 200 after request validation.
 */
export async function handleVoicePolishHttp(
  provider: VoicePolishProvider,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== VOICE_POLISH_MEDIA_TYPE) {
    return new Response(`content type must be ${VOICE_POLISH_MEDIA_TYPE}`, { status: 415 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const input = (body as Record<string, unknown> | null)?.[VOICE_POLISH_INPUT_FIELD]
  if (typeof input !== 'string' || input === '') {
    return new Response(`${VOICE_POLISH_INPUT_FIELD} must be a non-empty string`, { status: 400 })
  }
  const result = await provider.polish(input, request.signal)
  return jsonResponse(result.outcome === 'ok'
    ? { ok: true, text: result.text }
    : failureEnvelope(result.outcome))
}

/** Build the failure envelope one non-success outcome reports. */
function failureEnvelope(outcome: Exclude<VoicePolishOutcome, 'ok'>): VoicePolishEnvelope {
  return {
    ok: false,
    error: {
      code: FAILURE_CODES[outcome],
      message: `voice polish did not run (${outcome})`,
      details: {},
    },
  }
}

/** Serialize one envelope; no store or intermediary may cache a transcript. */
function jsonResponse(envelope: VoicePolishEnvelope): Response {
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
