/**
 * Silence detection for one dictation utterance.
 *
 * The seat ends a hands-free utterance when the speaker stops talking, which is
 * a level question rather than a transcript question: a provider reports words
 * only after it heard them, so the quiet that follows the last word is visible
 * in the microphone level and nowhere else. A gate only reports silence after
 * it has heard speech, so an open microphone in a silent room keeps listening
 * instead of ending the utterance before the speaker began.
 *
 * The clock and the timer are constructor seams so the gate's timing is
 * testable without waiting.
 * @module @deepseek-ai/dsh-client-ui-voice/client/silence
 */

/** Level at or above which a chunk counts as speech, on the 0–1 RMS scale. */
export const DEFAULT_SPEECH_LEVEL = 0.015

/** Quiet period that ends an utterance, in milliseconds. */
export const DEFAULT_SILENCE_MS = 1500

/** One gate's thresholds and the seam it reports through. */
export interface SilenceGateOptions {
  /** Level at or above which a chunk counts as speech. */
  readonly level: number
  /** Quiet period that ends the utterance, in milliseconds. */
  readonly quietMs: number
  /** Report that the utterance has gone quiet after speech. Called at most once per utterance. */
  readonly onSilence: () => void
  /** Clock, defaulting to `Date.now`. */
  readonly now?: () => number
  /** Timer scheduler, defaulting to `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => number
  /** Timer canceller, defaulting to `clearTimeout`. */
  readonly cancel?: (handle: number) => void
}

/**
 * Track one utterance's levels and report when speech has stopped.
 *
 * `observe` is called once per captured chunk; the gate schedules its own
 * check, so a caller never needs a timer of its own.
 */
export class SilenceGate {
  private spoke = false
  private fired = false
  private lastSpeechAt = 0
  private timer: number | undefined
  private readonly now: () => number
  private readonly schedule: (run: () => void, ms: number) => number
  private readonly cancel: (handle: number) => void

  /**
   * @param options - thresholds, the silence report, and the timing seams.
   */
  constructor(private readonly options: SilenceGateOptions) {
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms))
    this.cancel = options.cancel ?? ((handle) => { clearTimeout(handle) })
  }

  /** Whether this utterance has heard speech yet. */
  get heardSpeech(): boolean {
    return this.spoke
  }

  /**
   * Feed one captured chunk's level.
   * @param level - the chunk's RMS level on the 0–1 scale.
   */
  observe(level: number): void {
    if (level >= this.options.level) {
      this.spoke = true
      this.lastSpeechAt = this.now()
      this.arm(this.options.quietMs)
      return
    }
    if (this.spoke) this.arm(this.options.quietMs)
  }

  /** Stop the utterance's timing without reporting silence. */
  reset(): void {
    if (this.timer !== undefined) this.cancel(this.timer)
    this.timer = undefined
    this.spoke = false
    this.fired = false
  }

  /**
   * Schedule the check that ends this utterance.
   * @param ms - delay from now, in milliseconds.
   */
  private arm(ms: number): void {
    if (this.fired) return
    if (this.timer !== undefined) this.cancel(this.timer)
    this.timer = this.schedule(() => { this.check() }, ms)
  }

  /** End the utterance when the quiet has lasted, and wait again when it has not. */
  private check(): void {
    this.timer = undefined
    const quiet = this.now() - this.lastSpeechAt
    if (quiet < this.options.quietMs) {
      this.arm(this.options.quietMs - quiet)
      return
    }
    this.fired = true
    this.options.onSilence()
  }
}
