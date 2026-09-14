// @vitest-environment jsdom
/**
 * The General Settings voice group: the push-to-talk field and quiet-period
 * field commit on Enter or blur, and each switch writes its own preference.
 * Both text fields follow the accepted value when the Host section moves under
 * them and reject what cannot be a value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { VoiceSettingsRow, type VoiceSettingsRowProps } from '../src/client/settings/VoiceSettingsRow.tsx'
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from '../src/client/prefs.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** Mount the row over a preference store the case can move. */
function mount(prefs: Partial<VoicePreferences> = {}) {
  const source = createSnapshotStore<VoicePreferences>({ ...DEFAULT_VOICE_PREFERENCES, ...prefs })
  const writes = {
    setPushToTalk: vi.fn(),
    setAutoSend: vi.fn(),
    setSilenceMs: vi.fn(),
    setCleanup: vi.fn(),
    setSpokenSend: vi.fn(),
  }
  const props = {
    usePrefs: bindSnapshotSelector(source),
    ...writes,
    t: makeTranslate(en),
  } as unknown as VoiceSettingsRowProps
  render(<VoiceSettingsRow {...props} />)
  return { source, writes }
}

/** The row's push-to-talk field. */
const keyField = () => screen.getByLabelText<HTMLInputElement>(en['settings.voice.pushToTalk'])

/** The row's quiet-period field. */
const silenceField = () => screen.getByLabelText<HTMLInputElement>(en['settings.voice.silence'])

/** One labeled switch. */
const toggle = (label: string) => screen.getByRole<HTMLButtonElement>('switch', { name: label })

describe('VoiceSettingsRow', () => {
  it('shows the accepted preferences', () => {
    mount()
    expect(keyField().value).toBe('Alt+V')
    expect(silenceField().value).toBe('1.5')
    expect(toggle(en['settings.voice.autoSend']).getAttribute('aria-checked')).toBe('true')
  })

  it('commits a new binding on Enter', () => {
    const b = mount()
    fireEvent.change(keyField(), { target: { value: 'Ctrl+Shift+M' } })
    fireEvent.keyDown(keyField(), { key: 'Enter' })
    expect(b.writes.setPushToTalk).toHaveBeenCalledWith('Ctrl+Shift+M')
  })

  it('commits a new binding on blur', () => {
    const b = mount()
    fireEvent.change(keyField(), { target: { value: 'Ctrl+M' } })
    fireEvent.blur(keyField())
    expect(b.writes.setPushToTalk).toHaveBeenCalledWith('Ctrl+M')
  })

  it('commits the quiet period in milliseconds', () => {
    const b = mount()
    fireEvent.change(silenceField(), { target: { value: '2.5' } })
    fireEvent.blur(silenceField())
    expect(b.writes.setSilenceMs).toHaveBeenCalledWith(2500)
  })

  it('rejects a quiet period that is not a number', () => {
    const b = mount()
    fireEvent.change(silenceField(), { target: { value: 'soon' } })
    fireEvent.blur(silenceField())
    expect(b.writes.setSilenceMs).not.toHaveBeenCalled()
    expect(silenceField().value).toBe('1.5')
  })

  it('rejects a negative quiet period', () => {
    const b = mount()
    fireEvent.change(silenceField(), { target: { value: '-2' } })
    fireEvent.keyDown(silenceField(), { key: 'Enter' })
    expect(b.writes.setSilenceMs).not.toHaveBeenCalled()
  })

  it('bounds the quiet period at the schema ceiling', () => {
    const b = mount()
    fireEvent.change(silenceField(), { target: { value: '600' } })
    fireEvent.blur(silenceField())
    expect(b.writes.setSilenceMs).toHaveBeenCalledWith(60_000)
  })

  it('follows a section the Host accepts under the open fields', () => {
    const b = mount()
    fireEvent.change(keyField(), { target: { value: 'Ctrl+M' } })
    fireEvent.change(silenceField(), { target: { value: '9' } })
    act(() => {
      b.source.set({ ...DEFAULT_VOICE_PREFERENCES, pushToTalkSpec: 'Alt+P', silenceMs: 2000 })
    })
    expect(keyField().value).toBe('Alt+P')
    expect(silenceField().value).toBe('2')
  })

  it('leaves both fields uncommitted when another key is pressed', () => {
    const b = mount()
    fireEvent.change(keyField(), { target: { value: 'Ctrl+M' } })
    fireEvent.keyDown(keyField(), { key: 'Escape' })
    fireEvent.change(silenceField(), { target: { value: '3' } })
    fireEvent.keyDown(silenceField(), { key: 'Tab' })
    expect(b.writes.setPushToTalk).not.toHaveBeenCalled()
    expect(b.writes.setSilenceMs).not.toHaveBeenCalled()
  })

  it('writes each switch', () => {
    const b = mount()
    for (const label of [
      en['settings.voice.autoSend'], en['settings.voice.cleanup'], en['settings.voice.spokenSend'],
    ]) {
      fireEvent.click(toggle(label))
    }
    expect(b.writes.setAutoSend).toHaveBeenCalledWith(false)
    expect(b.writes.setCleanup).toHaveBeenCalledWith(false)
    expect(b.writes.setSpokenSend).toHaveBeenCalledWith(false)
  })
})
