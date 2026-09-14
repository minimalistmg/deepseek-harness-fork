/**
 * The silence gate: when a hands-free utterance ends, when it must keep
 * listening, and that it reports silence at most once per utterance. The clock
 * and the timer are injected, so the cases advance time instead of waiting.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SILENCE_MS, DEFAULT_SPEECH_LEVEL, SilenceGate } from '../src/client/silence.ts'

/** A gate over a manual clock and a timer queue the case drains. */
function bench(level = DEFAULT_SPEECH_LEVEL, quietMs = DEFAULT_SILENCE_MS) {
  let now = 0
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>()
  let nextHandle = 1
  const cancel = vi.fn((handle: number) => { timers.delete(handle) })
  const onSilence = vi.fn()
  const gate = new SilenceGate({
    level,
    quietMs,
    onSilence,
    now: () => now,
    schedule: (run, ms) => {
      const handle = nextHandle++
      timers.set(handle, { at: now + ms, run })
      return handle
    },
    cancel,
  })
  return {
    gate,
    onSilence,
    cancel,
    /** Move the clock and run whatever the queue has come due. */
    advance(ms: number): void {
      now += ms
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(handle)
        timer.run()
      }
    },
    /** Run the next scheduled check without moving the clock, as an early wake would. */
    fire(): void {
      const next = [...timers.entries()][0]
      if (next === undefined) return
      timers.delete(next[0])
      next[1].run()
    },
    get pending(): number {
      return timers.size
    },
  }
}

describe('SilenceGate', () => {
  it('reports silence once the quiet outlasts the window after speech', () => {
    const b = bench()
    expect(b.gate.heardSpeech).toBe(false)
    b.gate.observe(0.2)
    expect(b.gate.heardSpeech).toBe(true)
    b.gate.observe(0)
    b.advance(DEFAULT_SILENCE_MS)
    expect(b.onSilence).toHaveBeenCalledTimes(1)
  })

  it('keeps listening while nothing has been said', () => {
    const b = bench()
    b.gate.observe(0)
    b.advance(DEFAULT_SILENCE_MS * 4)
    expect(b.onSilence).not.toHaveBeenCalled()
    expect(b.pending).toBe(0)
  })

  it('waits for the speaker to finish a longer utterance', () => {
    const b = bench()
    b.gate.observe(0.2)
    b.advance(DEFAULT_SILENCE_MS - 100)
    b.gate.observe(0.3)
    b.advance(200)
    expect(b.onSilence).not.toHaveBeenCalled()
    b.advance(DEFAULT_SILENCE_MS)
    expect(b.onSilence).toHaveBeenCalledTimes(1)
  })

  it('re-arms when its own check comes due early', () => {
    const b = bench()
    b.gate.observe(0.2)
    // A check that runs without the clock having moved finds the window open
    // and waits out the remainder.
    b.fire()
    expect(b.onSilence).not.toHaveBeenCalled()
    expect(b.pending).toBe(1)
    b.advance(DEFAULT_SILENCE_MS)
    expect(b.onSilence).toHaveBeenCalledTimes(1)
  })

  it('reports silence at most once per utterance', () => {
    const b = bench()
    b.gate.observe(0.2)
    b.gate.observe(0)
    b.advance(DEFAULT_SILENCE_MS)
    b.gate.observe(0)
    b.advance(DEFAULT_SILENCE_MS * 2)
    expect(b.onSilence).toHaveBeenCalledTimes(1)
  })

  it('cancels its timing and forgets the utterance on reset', () => {
    const b = bench()
    b.gate.observe(0.2)
    expect(b.pending).toBe(1)
    b.gate.reset()
    expect(b.cancel).toHaveBeenCalledTimes(1)
    expect(b.pending).toBe(0)
    expect(b.gate.heardSpeech).toBe(false)
    // The next utterance is judged on its own audio.
    b.gate.observe(0)
    b.advance(DEFAULT_SILENCE_MS * 2)
    expect(b.onSilence).not.toHaveBeenCalled()
  })

  it('treats a level at the threshold as speech', () => {
    const b = bench(0.05)
    b.gate.observe(0.05)
    b.gate.observe(0.049)
    b.advance(1500)
    expect(b.onSilence).toHaveBeenCalledTimes(1)
  })

  it('runs on the real clock and timers when no seam is supplied', () => {
    vi.useFakeTimers()
    const onSilence = vi.fn()
    const gate = new SilenceGate({ level: DEFAULT_SPEECH_LEVEL, quietMs: 100, onSilence })
    gate.observe(0.2)
    gate.observe(0)
    vi.advanceTimersByTime(100)
    expect(onSilence).toHaveBeenCalledTimes(1)
    // A reset before the window closes cancels the real timer.
    gate.observe(0.2)
    gate.observe(0)
    gate.reset()
    vi.advanceTimersByTime(1000)
    expect(onSilence).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
