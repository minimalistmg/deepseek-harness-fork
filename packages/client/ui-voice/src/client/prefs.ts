/**
 * Host-backed voice preferences, as the dictation seat consumes them.
 *
 * The durable section stores what the user typed; the seat reads a resolved
 * preference (a parsed key binding, a number that is already a number), so the
 * parsing and defaulting happen once per settings change instead of on every
 * key event. The Host document can arrive after mount, and a deployment without
 * a settings provider never supplies one, so the store starts on the shipped
 * defaults and adopts the section when it appears.
 * @module @deepseek-ai/dsh-client-ui-voice/client/prefs
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  AUTO_SEND_FIELD, CLEANUP_FIELD, DEFAULT_PUSH_TO_TALK, DEFAULT_SILENCE_MS,
  PUSH_TO_TALK_FIELD, SILENCE_MS_FIELD, SPOKEN_SEND_FIELD,
  type VoiceSettings,
} from '../voice-settings.ts'
import { parsePushToTalk, type PushToTalkBinding } from './ptt.ts'

/** The choices the seat reads for one utterance. */
export interface VoicePreferences {
  /** Push-to-talk binding as the user wrote it, for the Settings field. */
  readonly pushToTalkSpec: string
  /** Parsed push-to-talk binding, absent when the gesture is disabled. */
  readonly pushToTalk: PushToTalkBinding | undefined
  /** Whether an utterance ended by push-to-talk release or silence sends itself. */
  readonly autoSend: boolean
  /** Quiet period that ends a hands-free utterance, in milliseconds; 0 disables it. */
  readonly silenceMs: number
  /** Whether dictated transcripts are cleaned up before insertion. */
  readonly cleanup: boolean
  /** Whether a trailing spoken send phrase sends the draft. */
  readonly spokenSend: boolean
}

/** Preferences in force before any Host section arrives. */
export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  pushToTalkSpec: DEFAULT_PUSH_TO_TALK,
  pushToTalk: parsePushToTalk(DEFAULT_PUSH_TO_TALK),
  autoSend: true,
  silenceMs: DEFAULT_SILENCE_MS,
  cleanup: true,
  spokenSend: true,
}

/**
 * Project one durable section into the seat's resolved preferences.
 * @param settings - the accepted Host section, or `undefined` before it arrives.
 * @returns the resolved preferences.
 */
export function resolveVoicePreferences(settings: VoiceSettings | undefined): VoicePreferences {
  if (settings === undefined) return DEFAULT_VOICE_PREFERENCES
  return {
    pushToTalkSpec: settings.pushToTalk,
    pushToTalk: parsePushToTalk(settings.pushToTalk),
    autoSend: settings.autoSend,
    silenceMs: settings.silenceMs,
    cleanup: settings.cleanup,
    spokenSend: settings.spokenSend,
  }
}

/** Live voice preferences consumed by the seat and the Settings row. */
export class VoicePrefsPolicy {
  /** Reactive current preferences, defaulted before Host settings arrive. */
  readonly prefs: SnapshotStore<VoicePreferences> = createSnapshotStore(DEFAULT_VOICE_PREFERENCES)

  /**
   * @param host - durable voice settings scope.
   */
  constructor(private readonly host: SettingsScope<VoiceSettings>) {
    host.subscribe(() => { this.adopt() })
    this.adopt()
  }

  /**
   * Persist one push-to-talk binding.
   * @param spec - the binding text; empty disables the gesture.
   */
  setPushToTalk(spec: string): void {
    void this.host.set(PUSH_TO_TALK_FIELD, spec)
  }

  /**
   * Persist whether an utterance may send itself.
   * @param on - the new preference.
   */
  setAutoSend(on: boolean): void {
    void this.host.set(AUTO_SEND_FIELD, on)
  }

  /**
   * Persist the quiet period that ends a hands-free utterance.
   * @param ms - the period in milliseconds; 0 disables the automatic ending.
   */
  setSilenceMs(ms: number): void {
    void this.host.set(SILENCE_MS_FIELD, ms)
  }

  /**
   * Persist whether transcripts are cleaned up before insertion.
   * @param on - the new preference.
   */
  setCleanup(on: boolean): void {
    void this.host.set(CLEANUP_FIELD, on)
  }

  /**
   * Persist whether a spoken send phrase sends the draft.
   * @param on - the new preference.
   */
  setSpokenSend(on: boolean): void {
    void this.host.set(SPOKEN_SEND_FIELD, on)
  }

  /** Adopt the latest accepted Host section without writing it back. */
  private adopt(): void {
    const section = this.host.getSnapshot().value
    if (section === undefined) return
    const next = resolveVoicePreferences(section)
    const current = this.prefs.getSnapshot()
    if (samePreferences(current, next)) return
    this.prefs.set(next)
  }
}

/**
 * Compare two resolved preference values field by field.
 * @param left - one value.
 * @param right - the other value.
 * @returns whether both carry the same choices.
 */
function samePreferences(left: VoicePreferences, right: VoicePreferences): boolean {
  return left.autoSend === right.autoSend
    && left.silenceMs === right.silenceMs
    && left.cleanup === right.cleanup
    && left.spokenSend === right.spokenSend
    && left.pushToTalkSpec === right.pushToTalkSpec
}
