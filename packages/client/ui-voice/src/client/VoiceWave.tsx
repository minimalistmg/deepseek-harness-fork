/**
 * Composer wave dock: the dictation level meter.
 *
 * The seat holds the microphone and writes levels into the shared meter; this
 * entry renders them under the composer card, so dictation has a visible
 * envelope whether the utterance was started by the button or by push-to-talk.
 * A silent microphone draws a baseline rather than nothing, so the dock itself
 * still reports that the seat is listening.
 * @module @deepseek-ai/dsh-client-ui-voice/client/VoiceWave
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the composer dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { type VoiceMeterState } from './meter.ts'
import css from './VoiceWave.module.css'

/** The dock's injected face: the meter the seat writes. */
export interface VoiceWaveInjected {
  readonly hooks: {
    readonly meter: SnapshotStore<VoiceMeterState>
  }
}

/** Full props of the composer wave dock. */
export type VoiceWaveProps =
  PropsRuntime<'conversation.composer.dock'> & InjectFace<VoiceWaveInjected> & PropsLocale<'voice'>

/**
 * Scale one level into a bar height.
 * @param level - the chunk's root-mean-square level.
 * @returns a height in the 0–1 range, with a floor so silence still draws.
 */
export function barHeight(level: number): number {
  const clamped = Math.max(0, Math.min(1, level))
  // Speech sits low on the RMS scale, so the scale is linear in the square root
  // of the level and floored at the baseline the silent bar keeps.
  return 0.08 + Math.sqrt(clamped) * 0.92
}

/**
 * Render the dictation level meter.
 * @param props - composed dock props.
 * @returns the meter, or nothing while no dictation has run.
 */
export function VoiceWave({ useMeter, t }: VoiceWaveProps) {
  const meter = useMeter(value => value)
  if (!meter.listening && meter.levels.length === 0) return null
  const label = t('wave.label')
  return (
    <div className={css.root} data-voice-wave="" role="img" aria-label={label}>
      {meter.levels.map((level, index) => (
        <span
          // Bars are a fixed-length history addressed by position: the oldest
          // bar's level changes as the history scrolls, so the index is the
          // identity that keeps one bar per position.
          key={index}
          className={css.bar}
          style={{ height: `${Math.round(barHeight(level) * 100)}%` }}
        />
      ))}
      {meter.levels.length === 0 && (
        <span className={css.bar} style={{ height: `${Math.round(barHeight(0) * 100)}%` }} aria-hidden />
      )}
    </div>
  )
}
