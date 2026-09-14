/**
 * Voice dictation preferences stored in the Host user-settings document.
 *
 * These are the choices a deployment or a user varies; the recognition and
 * cleanup semantics themselves are fixed. The schema is the wire envelope the
 * browser scope validates against, so the Host half and the browser half read
 * one definition.
 * @module @deepseek-ai/dsh-client-ui-voice/voice-settings
 */

import z from '@deepseek-ai/schemastery'

/** Default push-to-talk binding. */
export const DEFAULT_PUSH_TO_TALK = 'Alt+V'

/** Settings namespace owned by the voice plugin. */
export const VOICE_SETTINGS_NAMESPACE = 'ui-voice'

/** Field carrying the push-to-talk binding. */
export const PUSH_TO_TALK_FIELD = 'pushToTalk'

/** Field carrying whether a dictated utterance may send itself. */
export const AUTO_SEND_FIELD = 'autoSend'

/** Field carrying the quiet period that ends a hands-free utterance. */
export const SILENCE_MS_FIELD = 'silenceMs'

/** Field carrying whether dictated transcripts are cleaned up before insertion. */
export const CLEANUP_FIELD = 'cleanup'

/** Field carrying whether a spoken send phrase sends the draft. */
export const SPOKEN_SEND_FIELD = 'spokenSend'

/**
 * Largest accepted silence window. A longer one stops being a dictation
 * gesture and starts holding the microphone open between unrelated thoughts.
 */
export const MAX_SILENCE_MS = 60_000

/** Default quiet period before a hands-free utterance ends. */
export const DEFAULT_SILENCE_MS = 1500

/** Durable voice section shared by the Host schema and browser scope. */
export interface VoiceSettings {
  /**
   * Push-to-talk binding such as `Alt+V`; an empty value disables the gesture
   * and leaves the microphone button as the only control.
   */
  pushToTalk: string
  /** Whether an utterance ended by push-to-talk release or by silence sends itself. */
  autoSend: boolean
  /** Quiet period that ends a hands-free utterance, in milliseconds; 0 disables it. */
  silenceMs: number
  /** Whether verbal punctuation, fillers, and spoken identifiers are applied. */
  cleanup: boolean
  /** Whether a trailing spoken send phrase sends the draft. */
  spokenSend: boolean
}

/** Durable voice schema; also the wire envelope the browser scope validates against. */
export const VoiceSettingsSchema: z<VoiceSettings> = z.object({
  [PUSH_TO_TALK_FIELD]: z.string().default(DEFAULT_PUSH_TO_TALK),
  [AUTO_SEND_FIELD]: z.boolean().default(true),
  [SILENCE_MS_FIELD]: z.number().step(1).min(0).max(MAX_SILENCE_MS).default(DEFAULT_SILENCE_MS),
  [CLEANUP_FIELD]: z.boolean().default(true),
  [SPOKEN_SEND_FIELD]: z.boolean().default(true),
})
