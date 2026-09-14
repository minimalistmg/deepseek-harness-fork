/**
 * The live dictation route: request validation, the duplex framing (newline
 * delimited audio in, newline delimited transcript frames out), the sequence and
 * size rules applied to the incoming audio, and the refusal shape for a claim
 * that could not open a link. The request and response are real `Request` and
 * `Response` values; only the session is a stub.
 */
import { describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { handleVoiceLiveHttp } from '../src/live-route.ts'
import {
  voiceLiveOutputFrame,
  VOICE_LIVE_MEDIA_TYPE,
  VOICE_LIVE_PATH,
  VOICE_LIVE_REQUEST_MEDIA_TYPE,
  type VoiceLiveOutputFrame,
} from '../src/live-protocol.ts'
import { VoiceLiveSession } from '../src/live-session.ts'
import type { VoiceLiveUtterance } from '../src/live-session.ts'

/** One controllable utterance a spec drives frame by frame. */
class UtteranceStub implements VoiceLiveUtterance {
  readonly maxAudioBytes = 4096
  readonly audio: string[] = []
  accepted = true
  /** Whether the request's audio ended, as the specs observe it. */
  audioEnded = false
  /** Resolves once this utterance released its socket. */
  readonly finished: Promise<void>
  interrupted: (string | undefined)[] = []
  private readonly queued: VoiceLiveOutputFrame[] = []
  private wake: (() => void) | undefined
  private ended = false
  private settle: () => void = () => {}

  /**
   * @param onFinish - called when the audio stream ended.
   */
  constructor(private readonly onFinish: () => void = () => {}) {
    this.finished = new Promise<void>((resolve) => { this.settle = resolve })
  }

  sendAudio(data: string): boolean {
    if (!this.accepted) return false
    this.audio.push(data)
    return true
  }

  async *frames(): AsyncIterable<VoiceLiveOutputFrame> {
    yield { type: 'ready' }
    while (true) {
      const frame = this.queued.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  finish(): void {
    this.audioEnded = true
    this.onFinish()
  }

  interrupt(reason?: string): void {
    this.interrupted.push(reason)
    // The real utterance reports why it ended before it ends, so the stub does
    // too; a cancel with no reason reports nothing.
    if (reason !== undefined) this.queued.push({ type: 'error', code: 'voice/live-failed', message: reason })
    this.end()
  }

  /** End the frame stream and wake whoever is reading it. */
  /** End the utterance: the frame stream stops and the socket is released. */
  private end(): void {
    this.ended = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
    this.settle()
  }

  /**
   * Queue one transcript frame for the response body.
   * @param frame - the frame to deliver.
   */
  emit(frame: VoiceLiveOutputFrame): void {
    this.queued.push(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/** A session stub that hands out one utterance and records what was asked of it. */
function bench(options: { failure?: unknown } = {}) {
  const utterance = new UtteranceStub()
  const openUtterance = vi.fn(async () => {
    if (options.failure !== undefined) throw options.failure
    return utterance
  })
  return { session: { openUtterance } as unknown as VoiceLiveSession, openUtterance, utterance }
}

/**
 * One live request whose body is the given newline-delimited frames.
 * @param lines - request frames, each without its terminator.
 * @param overrides - method and content type to send instead of the defaults.
 * @returns the request.
 */
function request(
  lines: readonly string[],
  { method = 'POST', contentType = VOICE_LIVE_REQUEST_MEDIA_TYPE } = {},
): Request {
  return new Request(`http://dsh.internal${VOICE_LIVE_PATH}`, {
    method,
    // A GET request may not carry a body; the route refuses it on method alone.
    ...method === 'POST' ? { body: `${lines.join('\n')}\n`, duplex: 'half' } : {},
    ...contentType === '' ? {} : { headers: { 'content-type': contentType } },
  })
}

/**
 * One live request that carries no body at all.
 * @returns the bodyless request.
 */
function bodylessRequest(): Request {
  return new Request(`http://dsh.internal${VOICE_LIVE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': VOICE_LIVE_REQUEST_MEDIA_TYPE },
  })
}

/**
 * Read the transcript response to its end.
 * @param response - the route's answer.
 * @returns the frames it carried.
 */
async function framesOf(response: Response): Promise<VoiceLiveOutputFrame[]> {
  const text = await response.text()
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as VoiceLiveOutputFrame)
}

describe('live route validation', () => {
  it('refuses every method but POST', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request([], { method: 'GET' }))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(b.openUtterance).not.toHaveBeenCalled()
  })

  it('refuses a body that declares another media type', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request(['{}'], { contentType: 'application/json' }))
    expect(response.status).toBe(415)
    expect(await response.text()).toBe(`content type must be ${VOICE_LIVE_REQUEST_MEDIA_TYPE}`)
    expect(b.openUtterance).not.toHaveBeenCalled()
  })

  it('accepts a media type that carries a charset', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(
      b.session,
      request(['{"type":"audio","sequence":0,"data":"AAAA"}'], { contentType: `${VOICE_LIVE_REQUEST_MEDIA_TYPE}; charset=utf-8` }),
    )
    expect(response.status).toBe(200)
    b.utterance.interrupt()
    await framesOf(response)
  })

  it('refuses a request with no body at all', async () => {
    const b = bench()
    const withType = await handleVoiceLiveHttp(b.session, bodylessRequest())
    expect(withType.status).toBe(400)
    expect(await withType.text()).toBe('a live utterance needs a request body')
    const response = await handleVoiceLiveHttp(b.session, request(['{}'], { contentType: '' }))
    expect(response.status).toBe(415)
    expect(b.openUtterance).not.toHaveBeenCalled()
  })
})

describe('live route framing', () => {
  it('streams the provider frames down the response body', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request(['{"type":"audio","sequence":0,"data":"AAAA"}']))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(VOICE_LIVE_MEDIA_TYPE)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-accel-buffering')).toBe('no')

    // The route pulls one frame per read, so the spec drives the utterance
    // between reads the way the provider would.
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const readFrame = async (): Promise<VoiceLiveOutputFrame> => {
      const next = await reader.read()
      expect(next.done).toBe(false)
      return JSON.parse(decoder.decode(next.value).trim()) as VoiceLiveOutputFrame
    }
    expect(await readFrame()).toEqual({ type: 'ready' })
    b.utterance.emit({ type: 'interim', text: 'open the' })
    expect(await readFrame()).toEqual({ type: 'interim', text: 'open the' })
    b.utterance.emit({ type: 'final', text: 'open the file' })
    expect(await readFrame()).toEqual({ type: 'final', text: 'open the file' })
    // The audio ended with the request stream, so the utterance flushed.
    await vi.waitFor(() => { expect(b.utterance.audioEnded).toBe(true) })
    expect(b.utterance.audio).toEqual(['AAAA'])

    b.utterance.interrupt()
    const end = await reader.read()
    expect(end.done).toBe(true)
  })

  it('ends the response only after the utterance closed', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request([]))
    const read = framesOf(response)
    // The request stream ended, so the utterance is flushing; the response
    // stays open because the provider's late finals still have to arrive.
    await vi.waitFor(() => { expect(b.utterance.audioEnded).toBe(true) })
    let settled = false
    void read.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    b.utterance.emit({ type: 'final', text: 'the last word' })
    b.utterance.interrupt()
    expect(await read).toEqual([{ type: 'ready' }, { type: 'final', text: 'the last word' }])
  })

  it('ends the utterance without a flush when the client stops reading', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request([]))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(() => { expect(b.utterance.interrupted).toEqual([undefined]) })
  })

  it('refuses a frame it cannot read and reports why', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request(['not json']))
    expect(await framesOf(response)).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the voice link received a frame it cannot read' },
    ])
    // The refused line ended the utterance before the request stream did, so
    // the audio stream never reported its own end.
    expect(b.utterance.audioEnded).toBe(false)
    expect(b.utterance.interrupted).toHaveLength(1)
  })

  it('ignores a blank line and keeps taking audio after it', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request([
      '',
      '{"type":"audio","sequence":0,"data":"AAAA"}',
    ]))
    const reader = response.body!.getReader()
    const ready = await reader.read()
    expect(JSON.parse(new TextDecoder().decode(ready.value).trim())).toEqual({ type: 'ready' })
    // The request stream ended, so the utterance is flushing with the audio it
    // took after the blank line, and with nothing reported as a fault.
    await vi.waitFor(() => { expect(b.utterance.audioEnded).toBe(true) })
    expect(b.utterance.audio).toEqual(['AAAA'])
    expect(b.utterance.interrupted).toHaveLength(0)
    b.utterance.interrupt()
    await reader.cancel()
  })

  it('refuses a frame shape this build does not declare', async () => {
    const b = bench()
    for (const line of [
      '{"type":"unknown","sequence":0}',
      '{"type":"audio","data":"AAAA"}',
      '{"type":"audio","sequence":-1,"data":"AAAA"}',
      '{"type":"audio","sequence":0,"data":""}',
      'null',
    ]) {
      const response = await handleVoiceLiveHttp(b.session, request([line]))
      expect(await framesOf(response)).toEqual([
        { type: 'ready' },
        { type: 'error', code: 'voice/live-failed', message: 'the voice link received a frame it cannot read' },
      ])
    }
    expect(b.utterance.audio).toEqual([])
  })

  it('refuses a gap in the audio sequence', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request([
      '{"type":"audio","sequence":0,"data":"AAAA"}',
      '{"type":"audio","sequence":2,"data":"AAAA"}',
    ]))
    expect(await framesOf(response)).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the voice link lost audio' },
    ])
  })

  it('refuses audio that would cross the utterance cap', async () => {
    const b = bench()
    // The stub's cap is 4096 bytes, so 6000 base64 characters are 4500 bytes.
    const response = await handleVoiceLiveHttp(b.session, request([
      `{"type":"audio","sequence":0,"data":"${'A'.repeat(6000)}"}`,
    ]))
    expect(await framesOf(response)).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the utterance reached its audio limit' },
    ])
  })

  it('refuses a line longer than the parse buffer', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request([`{"data":"${'A'.repeat(200_000)}"}`]))
    expect(await framesOf(response)).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the voice link received an oversized line' },
    ])
  })

  it('refuses audio the link stopped accepting', async () => {
    const b = bench()
    b.utterance.accepted = false
    const response = await handleVoiceLiveHttp(b.session, request(['{"type":"audio","sequence":0,"data":"AAAA"}']))
    expect(await framesOf(response)).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the voice link stopped accepting audio' },
    ])
  })
})

describe('live route claim failures', () => {
  it('answers a failed claim with one error frame and no stream', async () => {
    const b = bench({ failure: new Error('the voice link is gone') })
    const response = await handleVoiceLiveHttp(b.session, request([]))
    expect(response.status).toBe(200)
    expect(await framesOf(response)).toEqual([
      { type: 'error', code: 'voice/live-failed', message: 'the voice link is gone' },
    ])
  })

  it('names a missing credential as its own code, through the real session', async () => {
    const session = new VoiceLiveSession({
      baseURL: 'https://generativelanguage.googleapis.com',
      model: 'gemini-3.5-transcribe-live',
      flushWindowMs: 20,
      idleTimeoutMs: 50,
      connectTimeoutMs: 20,
      closeTimeoutMs: 20,
      maxUtteranceBytes: 1024,
      apiKeyEnv: credentialRef('GEMINI_API_KEY'),
      resolveApiKey: async () => undefined,
    })
    const response = await handleVoiceLiveHttp(session, request([]))
    expect(await framesOf(response)).toEqual([
      { code: 'voice/live-unavailable', message: 'no GEMINI_API_KEY credential is configured', type: 'error' },
    ])
    await session.dispose()
  })

  it('answers a claim failure that is not an Error', async () => {
    const b = bench({ failure: 'plain refusal' })
    const response = await handleVoiceLiveHttp(b.session, request([]))
    expect(await framesOf(response)).toEqual([
      { type: 'error', code: 'voice/live-failed', message: 'plain refusal' },
    ])
  })
})

describe('voiceLiveOutputFrame', () => {
  it('reads every frame the protocol declares', () => {
    expect(voiceLiveOutputFrame({ type: 'ready' })).toEqual({ type: 'ready' })
    expect(voiceLiveOutputFrame({ type: 'idle' })).toEqual({ type: 'idle' })
    expect(voiceLiveOutputFrame({ type: 'interim', text: 'half' })).toEqual({ type: 'interim', text: 'half' })
    expect(voiceLiveOutputFrame({ type: 'final', text: 'whole' })).toEqual({ type: 'final', text: 'whole' })
  })

  it('keeps an error frame whose message the host left out', () => {
    expect(voiceLiveOutputFrame({ type: 'error', code: 'voice/live-failed' }))
      .toEqual({ type: 'error', code: 'voice/live-failed', message: '' })
  })

  it('answers nothing for a frame this build cannot read', () => {
    for (const value of [
      undefined,
      null,
      'text',
      { type: 'unknown' },
      { type: 'interim' },
      { type: 'final', text: '' },
      { type: 'interim', text: 7 },
      { type: 'error' },
      { type: 'error', code: 7 },
    ]) {
      expect(voiceLiveOutputFrame(value)).toBeUndefined()
    }
  })
})

describe('live route stream edges', () => {
  it('refuses a line the host buffered without a terminator', async () => {
    const b = bench()
    // No trailing newline, so the oversized line is still in the parse buffer
    // when the request stream ends.
    const request = new Request(`http://dsh.internal${VOICE_LIVE_PATH}`, {
      method: 'POST',
      body: 'A'.repeat(200_000),
      headers: { 'content-type': VOICE_LIVE_REQUEST_MEDIA_TYPE },
      duplex: 'half',
    } as RequestInit)
    const response = await handleVoiceLiveHttp(b.session, request)
    expect(await framesOf(response)).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'voice/live-failed', message: 'the voice link received an oversized line' },
    ])
  })

  it('ends the utterance when reading the request fails', async () => {
    const b = bench()
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('the client went away'))
      },
    })
    const request = new Request(`http://dsh.internal${VOICE_LIVE_PATH}`, {
      method: 'POST',
      body,
      headers: { 'content-type': VOICE_LIVE_REQUEST_MEDIA_TYPE },
      duplex: 'half',
    } as RequestInit)
    const response = await handleVoiceLiveHttp(b.session, request)
    expect(await framesOf(response)).toEqual([{ type: 'ready' }])
    expect(b.utterance.interrupted).toEqual([undefined])
  })

  it('keeps the stream open across more reads than the first', async () => {
    const b = bench()
    const response = await handleVoiceLiveHttp(b.session, request(['{"type":"audio","sequence":0,"data":"AAAA"}']))
    const reader = response.body!.getReader()
    // The first read takes the ready frame; the stream then waits for the
    // utterance to end rather than closing on its own.
    await reader.read()
    b.utterance.emit({ type: 'interim', text: 'half' })
    const interim = await reader.read()
    expect(JSON.parse(new TextDecoder().decode(interim.value).trim())).toEqual({ type: 'interim', text: 'half' })
    b.utterance.interrupt()
    expect((await reader.read()).done).toBe(true)
  })
})

describe('live route claim edges', () => {
  it('answers one frame and opens no stream when the claim fails', async () => {
    const refused = bench({ failure: new Error('the voice link is gone') })
    const response = await handleVoiceLiveHttp(refused.session, request([]))
    expect(response.body).not.toBeNull()
    expect(await framesOf(response)).toEqual([
      { type: 'error', code: 'voice/live-failed', message: 'the voice link is gone' },
    ])
  })
})
