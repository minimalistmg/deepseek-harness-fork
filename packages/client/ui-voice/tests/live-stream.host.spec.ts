/**
 * One utterance's incoming audio accounting: the sequence rule that makes a
 * transport gap visible, and the cap that bounds what a single utterance can
 * grow the host's memory by.
 */
import { describe, expect, it } from 'vitest'
import { AudioStream } from '../src/live-stream.ts'
import { VOICE_LIVE_FRAME_AUDIO } from '../src/live-protocol.ts'
import type { VoiceLiveInputFrame } from '../src/live-protocol.ts'

/**
 * One audio frame.
 * @param sequence - this frame's index within the utterance.
 * @param characters - base64 characters the frame carries, four per three bytes.
 * @returns the frame to ingest.
 */
function frame(sequence: number, characters = 4): VoiceLiveInputFrame {
  return { type: VOICE_LIVE_FRAME_AUDIO, sequence, data: 'A'.repeat(characters) }
}

describe('AudioStream', () => {
  it('accepts frames in order and reports the next index', () => {
    const stream = new AudioStream(1000)
    expect(stream.expectedSequence).toBe(0)
    expect(stream.push(frame(0))).toBe('accepted')
    expect(stream.push(frame(1))).toBe('accepted')
    expect(stream.expectedSequence).toBe(2)
  })

  it('refuses a frame that skips one, so a lost chunk cannot read as silence', () => {
    const stream = new AudioStream(1000)
    expect(stream.push(frame(0))).toBe('accepted')
    expect(stream.push(frame(2))).toBe('gap')
    // The refused frame did not advance the utterance.
    expect(stream.expectedSequence).toBe(1)
    expect(stream.push(frame(1))).toBe('accepted')
  })

  it('refuses a replayed frame', () => {
    const stream = new AudioStream(1000)
    expect(stream.push(frame(0))).toBe('accepted')
    expect(stream.push(frame(0))).toBe('gap')
  })

  it('accepts a frame that lands exactly on the cap', () => {
    // Four base64 characters carry three bytes, so 3000 characters is 2250 bytes.
    const stream = new AudioStream(2250)
    expect(stream.push(frame(0, 3000))).toBe('accepted')
  })

  it('refuses the frame that would cross the cap', () => {
    const stream = new AudioStream(2250)
    expect(stream.push(frame(0, 3000))).toBe('accepted')
    expect(stream.push(frame(1, 4))).toBe('overflow')
    // The refused frame consumed its index but not the cap.
    expect(stream.expectedSequence).toBe(2)
    expect(stream.push(frame(2, 4))).toBe('overflow')
  })
})
