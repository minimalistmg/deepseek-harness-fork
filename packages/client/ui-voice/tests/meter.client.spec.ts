/**
 * The dictation meter the seat writes and the wave dock reads: a fixed-length
 * level history plus the recording flag.
 */
import { describe, expect, it } from 'vitest'
import {
  createVoiceMeter, IDLE_METER, pushLevel, startMeter, stopMeter, VOICE_METER_BARS,
} from '../src/client/meter.ts'

describe('meter state', () => {
  it('appends a level and keeps the recording flag', () => {
    expect(pushLevel({ listening: true, levels: [0.1] }, 0.2)).toEqual({ listening: true, levels: [0.1, 0.2] })
  })

  it('drops the oldest bar once the history is full', () => {
    const full = { listening: true, levels: Array.from({ length: VOICE_METER_BARS }, () => 0.1) }
    const next = pushLevel(full, 0.9)
    expect(next.levels).toHaveLength(VOICE_METER_BARS)
    expect(next.levels.at(-1)).toBe(0.9)
    expect(next.levels[0]).toBe(0.1)
  })

  it('clears a stale envelope when an utterance starts', () => {
    expect(startMeter({ listening: false, levels: [0.1] })).toEqual({ listening: true, levels: [] })
    // An already-empty history is kept by reference, so a restart does not
    // publish a new array for a dock that renders the same thing.
    const empty = { listening: false, levels: [] as number[] }
    expect(startMeter(empty).levels).toBe(empty.levels)
  })

  it('stops recording while keeping the envelope, and is stable when already stopped', () => {
    const listening = { listening: true, levels: [0.1] }
    expect(stopMeter(listening)).toEqual({ listening: false, levels: [0.1] })
    const stopped = { listening: false, levels: [0.1] }
    expect(stopMeter(stopped)).toBe(stopped)
  })

  it('starts idle', () => {
    expect(createVoiceMeter().getSnapshot()).toEqual(IDLE_METER)
  })
})
