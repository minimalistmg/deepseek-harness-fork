/**
 * Voice control plugin, browser half. It occupies the composer's
 * `conversation.input.right` list seat with a dictation toggle that streams
 * microphone audio to Gemini Live through this plugin's host route, renders the
 * utterance's level under the composer card, and adds the matching rows to
 * General Settings. The whole transcript is cleaned up by the host after the
 * utterance ends and reaches the draft through the public `inputActions` face,
 * so this plugin owns no draft state and never touches the editor directly.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right and composer dock seats).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings scope Context merge and the settings.general.item seat.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { transcribe } from './live.ts'
import { createVoiceMeter, pushLevel, startMeter, stopMeter } from './meter.ts'
import { send } from './polish.ts'
import { VoicePrefsPolicy } from './prefs.ts'
import { VoiceControl } from './VoiceControl.tsx'
import { VoiceWave } from './VoiceWave.tsx'
import { VoiceSettingsRow } from './settings/VoiceSettingsRow.tsx'
import { VOICE_SETTINGS_NAMESPACE, type VoiceSettings } from '../voice-settings.ts'
import { en, zh, type VoiceKey } from './locales.ts'

export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The composer voice control's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice'

/** Required services: the seat's slot registry, the locale registry, and the durable settings scope. */
export const inject = ['slots', 'locale', 'settingsScope']

/** The copy and fallback configuration the seat resolves from the host config. */
export interface VoiceClientConfig {
  /**
   * Whether the browser's own speech engine may take over when the live link
   * cannot run. Reads the host's `webSpeechEnabled`, whose schema default is
   * `false`.
   */
  webSpeech?: boolean
}

/**
 * Client plugin body: register the dictation toggle in the composer's trailing
 * control list, the level meter under the composer card, and the preference rows
 * in General Settings.
 * @param ctx - client root context.
 * @param config - resolved plugin config; the Loader supplies schema defaults,
 * hand-built contexts may pass none.
 */
export function apply(ctx: ClientContext, config?: VoiceClientConfig): void {
  const webSpeech = config?.webSpeech === true
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')
  const prefs = new VoicePrefsPolicy(ctx.settingsScope.bind<VoiceSettings>({ namespace: VOICE_SETTINGS_NAMESPACE }))
  // One meter per plugin instance: the seat writes it and the dock renders it,
  // so both entries read dictation state from a single source.
  const meter = createVoiceMeter()

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'voice',
    order: 100,
    locale: NS,
    inject: () => ({
      live: { transcribe },
      polish: send,
      webSpeech,
      hooks: { prefs: prefs.prefs },
      reportLevel: (level: number) => { meter.set(pushLevel(meter.getSnapshot(), level)) },
      reportListening: (active: boolean) => {
        meter.set(active ? startMeter(meter.getSnapshot()) : stopMeter(meter.getSnapshot()))
      },
    }),
  }, VoiceControl))

  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'voice-wave',
    order: 40,
    locale: NS,
    inject: () => ({ hooks: { meter } }),
  }, VoiceWave))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'voice',
    order: 13,
    locale: NS,
    inject: () => ({
      hooks: { prefs: prefs.prefs },
      setPushToTalk: (spec: string) => { prefs.setPushToTalk(spec) },
      setAutoSend: (on: boolean) => { prefs.setAutoSend(on) },
      setSilenceMs: (ms: number) => { prefs.setSilenceMs(ms) },
      setCleanup: (on: boolean) => { prefs.setCleanup(on) },
      setSpokenSend: (on: boolean) => { prefs.setSpokenSend(on) },
    }),
  }, VoiceSettingsRow))
}
