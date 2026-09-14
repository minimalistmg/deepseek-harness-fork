/**
 * The voice preference policy: how a durable Host section becomes the resolved
 * choices the seat reads, and which writes the Settings row routes back.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_VOICE_PREFERENCES, resolveVoicePreferences, VoicePrefsPolicy,
} from '../src/client/prefs.ts'
import type { VoiceSettings } from '../src/voice-settings.ts'

/** A Host section as the durable document stores it. */
const section: VoiceSettings = {
  pushToTalk: 'Ctrl+Shift+M',
  autoSend: false,
  silenceMs: 2500,
  cleanup: false,
  spokenSend: false,
}

/** One in-memory settings scope the case publishes sections into. */
function bench() {
  const store = createSnapshotStore<SettingsScopeSnapshot<VoiceSettings>>({
    status: 'loading',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'memory',
  })
  const set = vi.fn(async (field: string, value: unknown) => {
    const current = store.getSnapshot().value ?? section
    store.set({
      ...store.getSnapshot(),
      status: 'ready',
      value: { ...current, [field]: value },
    })
  })
  const scope = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => store.subscribe(listener),
    mutate: async () => {},
    set,
    unset: async () => {},
  } as unknown as SettingsScope<VoiceSettings>
  return { scope, store, set }
}

describe('resolveVoicePreferences', () => {
  it('answers the shipped defaults before a section arrives', () => {
    expect(resolveVoicePreferences(undefined)).toBe(DEFAULT_VOICE_PREFERENCES)
  })

  it('parses the binding and carries every field', () => {
    const resolved = resolveVoicePreferences(section)
    expect(resolved.pushToTalkSpec).toBe('Ctrl+Shift+M')
    expect(resolved.pushToTalk).toEqual({ key: 'm', alt: false, ctrl: true, shift: true, meta: false })
    expect(resolved.autoSend).toBe(false)
    expect(resolved.silenceMs).toBe(2500)
    expect(resolved.cleanup).toBe(false)
    expect(resolved.spokenSend).toBe(false)
  })

  it('answers no binding for a cleared spec', () => {
    expect(resolveVoicePreferences({ ...section, pushToTalk: '' }).pushToTalk).toBeUndefined()
  })
})

describe('VoicePrefsPolicy', () => {
  it('starts on the shipped defaults and adopts the accepted section', () => {
    const b = bench()
    const policy = new VoicePrefsPolicy(b.scope)
    expect(policy.prefs.getSnapshot()).toEqual(DEFAULT_VOICE_PREFERENCES)

    b.store.set({ ...b.store.getSnapshot(), status: 'ready', value: section })
    expect(policy.prefs.getSnapshot().pushToTalkSpec).toBe('Ctrl+Shift+M')
  })

  it('ignores a published section identical to the one already read', () => {
    const b = bench()
    const policy = new VoicePrefsPolicy(b.scope)
    b.store.set({ ...b.store.getSnapshot(), status: 'ready', value: section })
    const adopted = policy.prefs.getSnapshot()
    b.store.set({ ...b.store.getSnapshot(), status: 'ready', value: { ...section } })
    expect(policy.prefs.getSnapshot()).toBe(adopted)
  })

  it('persists each preference the Settings row offers', async () => {
    const b = bench()
    const policy = new VoicePrefsPolicy(b.scope)
    policy.setPushToTalk('Alt+P')
    policy.setAutoSend(false)
    policy.setSilenceMs(3000)
    policy.setCleanup(false)
    policy.setSpokenSend(false)
    await Promise.resolve()
    expect(b.set.mock.calls).toEqual([
      ['pushToTalk', 'Alt+P'],
      ['autoSend', false],
      ['silenceMs', 3000],
      ['cleanup', false],
      ['spokenSend', false],
    ])
    const resolved = policy.prefs.getSnapshot()
    expect(resolved.pushToTalk).toEqual({ key: 'p', alt: true, ctrl: false, shift: false, meta: false })
    expect(resolved.silenceMs).toBe(3000)
    expect(resolved.cleanup).toBe(false)
    expect(resolved.spokenSend).toBe(false)
  })
})
