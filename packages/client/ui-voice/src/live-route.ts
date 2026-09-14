/**
 * The live dictation route: one request carries one utterance in and its
 * transcripts out.
 *
 * The request body is newline-delimited audio frames and the response body is
 * newline-delimited transcript frames, so the browser streams audio up while it
 * reads text down the same request. Node's HTTP bridge streams the response body
 * with backpressure and holds the request open while it does, which is what
 * makes the duplex shape work over one route.
 *
 * The request stream ending is the end of the utterance: the handler sends the
 * provider's `audioStreamEnd`, keeps the response open for the flush window so
 * the provider's last transcripts still arrive, and only then releases the
 * socket. A client that stops reading cancels the response, which ends the
 * utterance without a flush.
 * @module @deepseek-ai/dsh-client-ui-voice/live-route
 */

import { AudioStream } from './live-stream.ts'
import {
  VOICE_LIVE_CODE_FAILED,
  VOICE_LIVE_CODE_UNAVAILABLE,
  VOICE_LIVE_MEDIA_TYPE,
  VOICE_LIVE_REQUEST_MEDIA_TYPE,
  voiceLiveInputFrame,
} from './live-protocol.ts'
import type { VoiceLiveOutputFrame } from './live-protocol.ts'
import { isMissingKey, type VoiceLiveSession, type VoiceLiveUtterance } from './live-session.ts'

/** Cap on one request line's length, so a client cannot grow the parse buffer without bound. */
const MAX_LINE_CHARS = 128 * 1024

/**
 * Handle one live dictation request.
 * @param session - the plugin instance's live session, shared by every request.
 * @param request - authenticated HTTP request from Connection.
 * @returns the streamed transcript response, or a refusal for an unusable request.
 */
export async function handleVoiceLiveHttp(
  session: VoiceLiveSession,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== VOICE_LIVE_REQUEST_MEDIA_TYPE) {
    return new Response(`content type must be ${VOICE_LIVE_REQUEST_MEDIA_TYPE}`, { status: 415 })
  }
  if (request.body === null) {
    return new Response('a live utterance needs a request body', { status: 400 })
  }
  console.log('[voice] host: live request received, opening the utterance')
  let utterance: VoiceLiveUtterance
  try {
    utterance = await session.openUtterance()
  } catch (error) {
    console.error('[voice] host: opening the utterance FAILED', error)
    return failureResponse(error)
  }
  console.log('[voice] host: streaming transcript frames to the browser')
  return new Response(streamFrames(utterance, request), {
    status: 200,
    headers: {
      'content-type': VOICE_LIVE_MEDIA_TYPE,
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * The response body: stream this utterance's transcript frames, then end after
 * its socket is closed. Reading the request starts here rather than before the
 * response exists, because a client that never reads its own response body
 * would otherwise fill the socket's write buffer and park the handler.
 * @param utterance - this request's utterance.
 * @param request - the request whose body carries the audio.
 * @returns the response body stream.
 */
function streamFrames(utterance: VoiceLiveUtterance, request: Request): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const frames = utterance.frames()[Symbol.asyncIterator]()
  let pump: Promise<void> | undefined
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pump ??= pumpAudio(utterance, request)
      const next = await frames.next()
      if (!next.done) {
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`))
        return
      }
      // The frame stream ends only after the socket closed, so the response
      // ending is the client's signal that the utterance is over. Waiting for
      // the audio pump first keeps the refusal it reported inside the body.
      await pump
      await utterance.finished
      controller.close()
    },
    cancel() {
      // The client stopped reading: its audio is no longer wanted and the
      // socket has nowhere to deliver, so the utterance ends without a flush.
      utterance.interrupt()
    },
  })
}

/**
 * Read the request body and write its audio frames into the utterance.
 * @param utterance - the utterance receiving the audio.
 * @param request - the request whose body carries the audio.
 * @returns nothing; a refusal or a gap ends the utterance with an error frame.
 */
async function pumpAudio(utterance: VoiceLiveUtterance, request: Request): Promise<void> {
  const body = request.body
  /* v8 ignore next -- the caller refused a request without a body. */
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const audio = new AudioStream(utterance.maxAudioBytes)
  let buffered = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffered += decoder.decode(next.value, { stream: true })
      let breakAt = buffered.indexOf('\n')
      while (breakAt >= 0) {
        const line = buffered.slice(0, breakAt)
        buffered = buffered.slice(breakAt + 1)
        const refusal = line.length > MAX_LINE_CHARS
          ? 'the voice link received an oversized line'
          : ingest(utterance, audio, line)
        if (refusal !== undefined) {
          utterance.interrupt(refusal)
          return
        }
        breakAt = buffered.indexOf('\n')
      }
      if (buffered.length > MAX_LINE_CHARS) {
        utterance.interrupt('the voice link received an oversized line')
        return
      }
    }
    // The request stream ending is the end of the utterance.
    utterance.finish()
  } catch {
    // The client went away mid-utterance; the response stream's own cancel
    // reports the same fact, and this arm reaches it when the read fails before
    // the response is cancelled.
    utterance.interrupt()
  }
}

/**
 * Ingest one request line.
 * @param utterance - the utterance receiving the audio.
 * @param audio - this utterance's audio accounting.
 * @param line - one newline-delimited request frame, without its terminator.
 * @returns nothing when the frame was accepted, otherwise the reason it was refused.
 */
function ingest(utterance: VoiceLiveUtterance, audio: AudioStream, line: string): string | undefined {
  if (line.trim() === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return 'the voice link received a frame it cannot read'
  }
  const frame = voiceLiveInputFrame(value)
  if (frame === undefined) return 'the voice link received a frame it cannot read'
  const outcome = audio.push(frame)
  if (outcome === 'gap') return 'the voice link lost audio'
  if (outcome === 'overflow') return 'the utterance reached its audio limit'
  return utterance.sendAudio(frame.data) ? undefined : 'the voice link stopped accepting audio'
}

/**
 * The refusal one failed claim reports.
 * @param error - the failure the session's claim threw.
 * @returns a one-frame response naming the failure's own code.
 */
function failureResponse(error: unknown): Response {
  const code = isMissingKey(error) ? VOICE_LIVE_CODE_UNAVAILABLE : VOICE_LIVE_CODE_FAILED
  const message = error instanceof Error ? error.message : String(error)
  const frame: VoiceLiveOutputFrame = { type: 'error', code, message }
  return new Response(`${JSON.stringify(frame)}\n`, {
    status: 200,
    headers: {
      'content-type': VOICE_LIVE_MEDIA_TYPE,
      'cache-control': 'no-store',
    },
  })
}
