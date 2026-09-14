/**
 * Live dictation meter shared by the composer's voice seat and the wave dock.
 *
 * The seat owns the microphone, so it is the only writer; the dock renders the
 * same source, which keeps the two registrations from growing a second channel
 * between them. Levels are a fixed-length history of the most recent chunks, so
 * the dock renders a scrolling envelope whose cost does not grow with the
 * utterance.
 * @module @deepseek-ai/dsh-client-ui-voice/client/meter
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Bars the wave dock renders. */
export const VOICE_METER_BARS = 96

/** One utterance's live level history. */
export interface VoiceMeterState {
  /** Whether the microphone is recording. */
  readonly listening: boolean
  /** Recent chunk levels, oldest first, each on the 0–1 scale. */
  readonly levels: readonly number[]
}

/** The state a dock renders before any dictation has run. */
export const IDLE_METER: VoiceMeterState = { listening: false, levels: [] }

/**
 * Append one chunk level, dropping the oldest bar once the history is full.
 * @param state - the meter state before this chunk.
 * @param level - the chunk's root-mean-square level.
 * @returns the next state.
 */
export function pushLevel(state: VoiceMeterState, level: number): VoiceMeterState {
  const levels = [...state.levels, level]
  while (levels.length > VOICE_METER_BARS) levels.shift()
  return { listening: state.listening, levels }
}

/**
 * Start a fresh utterance's history.
 * @param state - the meter state before this utterance.
 * @returns the next state, listening with an empty history.
 */
export function startMeter(state: VoiceMeterState): VoiceMeterState {
  return { listening: true, levels: state.levels.length === 0 ? state.levels : [] }
}

/**
 * Stop the meter without discarding the envelope already drawn.
 * @param state - the meter state before this call.
 * @returns the next state, not listening.
 */
export function stopMeter(state: VoiceMeterState): VoiceMeterState {
  return state.listening ? { listening: false, levels: state.levels } : state
}

/**
 * Create the meter source the seat writes and the wave dock reads.
 * @returns a fresh store per plugin instance.
 */
export function createVoiceMeter(): SnapshotStore<VoiceMeterState> {
  return createSnapshotStore<VoiceMeterState>(IDLE_METER)
}
