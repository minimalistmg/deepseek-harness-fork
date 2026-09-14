/**
 * General Settings panel for dictation: the push-to-talk binding, the quiet
 * period that ends a hands-free utterance, and the three cleanup switches.
 *
 * The row writes through the same policy the seat reads, so a change takes
 * effect on the next utterance without reloading the plugin. A text field
 * commits on Enter or on blur, because a binding is only meaningful once the
 * user has finished naming it.
 * @module @deepseek-ai/dsh-client-ui-voice/client/settings/VoiceSettingsRow
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-settings SlotMap merge (the settings.general.item seat).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { MAX_SILENCE_MS } from '../../voice-settings.ts'
import type { VoiceKey } from '../locales.ts'
import type { VoicePreferences } from '../prefs.ts'
import css from './VoiceSettingsRow.module.css'

/** Registration-side voice preference face. */
export interface VoiceSettingsRowInjected {
  hooks: {
    /** Live resolved voice preferences. */
    readonly prefs: SnapshotStore<VoicePreferences>
  }
  /**
   * Persist one push-to-talk binding.
   * @param spec - the binding text; empty disables the gesture.
   */
  setPushToTalk(spec: string): void
  /**
   * Persist whether an utterance may send itself.
   * @param on - the new preference.
   */
  setAutoSend(on: boolean): void
  /**
   * Persist the quiet period that ends a hands-free utterance.
   * @param ms - the period in milliseconds; 0 disables it.
   */
  setSilenceMs(ms: number): void
  /**
   * Persist whether transcripts are cleaned up before insertion.
   * @param on - the new preference.
   */
  setCleanup(on: boolean): void
  /**
   * Persist whether a spoken send phrase sends the draft.
   * @param on - the new preference.
   */
  setSpokenSend(on: boolean): void
}

/** Full props of the voice Settings row. */
export type VoiceSettingsRowProps =
  PropsRuntime<'settings.general.item'> & InjectFace<VoiceSettingsRowInjected> & PropsLocale<'voice'>

/** Seconds per millisecond, for the quiet-period field. */
const MS_PER_SECOND = 1000

/** One switch row's copy keys. */
interface SwitchCopy {
  readonly title: VoiceKey
  readonly description: VoiceKey
}

/** Labeled switch row, shared by the three toggles. */
function SwitchRow({ copy, checked, onChange, t }: {
  copy: SwitchCopy
  checked: boolean
  onChange: (next: boolean) => void
  t: VoiceSettingsRowProps['t']
}) {
  const title = t(copy.title)
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{title}</div>
        <div className={css.desc}>{t(copy.description)}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  )
}

/**
 * Render the voice preferences.
 * @param props - composed Settings slot props.
 * @returns the preference group.
 */
export function VoiceSettingsRow({
  usePrefs, setPushToTalk, setAutoSend, setSilenceMs, setCleanup, setSpokenSend, t,
}: VoiceSettingsRowProps) {
  const prefs = usePrefs(value => value)
  const [binding, setBinding] = useState(prefs.pushToTalkSpec)
  const [seconds, setSeconds] = useState(`${prefs.silenceMs / MS_PER_SECOND}`)

  // A settings write can arrive from another surface, so both text fields adopt
  // the accepted value whenever the resolved preference moves under them.
  useEffect(() => { setBinding(prefs.pushToTalkSpec) }, [prefs.pushToTalkSpec])
  useEffect(() => { setSeconds(`${prefs.silenceMs / MS_PER_SECOND}`) }, [prefs.silenceMs])

  const commitBinding = (): void => { setPushToTalk(binding) }
  const commitSeconds = (): void => {
    const parsed = Number(seconds)
    // An emptied or unparsable field is not a choice: the accepted value stands
    // until the user names one.
    if (seconds.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
      setSeconds(`${prefs.silenceMs / MS_PER_SECOND}`)
      return
    }
    setSilenceMs(Math.min(MAX_SILENCE_MS, Math.round(parsed * MS_PER_SECOND)))
  }

  return (
    <div className={css.group}>
      <div className={css.groupTitle}>{t('settings.voice.title')}</div>
      <div className={css.groupDesc}>{t('settings.voice.description')}</div>
      <div className={css.row}>
        <div className={css.rowText}>
          <label className={css.title} htmlFor="voice-push-to-talk">{t('settings.voice.pushToTalk')}</label>
          <div className={css.desc}>{t('settings.voice.pushToTalk.description')}</div>
        </div>
        <span className={css.field}>
          <Input
            id="voice-push-to-talk"
            aria-label={t('settings.voice.pushToTalk')}
            placeholder={t('settings.voice.pushToTalk.placeholder')}
            value={binding}
            onChange={(event) => { setBinding(event.currentTarget.value) }}
            onBlur={commitBinding}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commitBinding()
              event.currentTarget.blur()
            }}
          />
        </span>
      </div>
      <div className={css.row}>
        <div className={css.rowText}>
          <label className={css.title} htmlFor="voice-silence">{t('settings.voice.silence')}</label>
          <div className={css.desc}>{t('settings.voice.silence.description')}</div>
        </div>
        <span className={css.field}>
          <Input
            id="voice-silence"
            type="number"
            min={0}
            max={MAX_SILENCE_MS / MS_PER_SECOND}
            step={0.5}
            aria-label={t('settings.voice.silence')}
            value={seconds}
            onChange={(event) => { setSeconds(event.currentTarget.value) }}
            onBlur={commitSeconds}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              commitSeconds()
              event.currentTarget.blur()
            }}
          />
        </span>
      </div>
      <SwitchRow
        copy={{ title: 'settings.voice.autoSend', description: 'settings.voice.autoSend.description' }}
        checked={prefs.autoSend}
        onChange={setAutoSend}
        t={t}
      />
      <SwitchRow
        copy={{ title: 'settings.voice.cleanup', description: 'settings.voice.cleanup.description' }}
        checked={prefs.cleanup}
        onChange={setCleanup}
        t={t}
      />
      <SwitchRow
        copy={{ title: 'settings.voice.spokenSend', description: 'settings.voice.spokenSend.description' }}
        checked={prefs.spokenSend}
        onChange={setSpokenSend}
        t={t}
      />
    </div>
  )
}
