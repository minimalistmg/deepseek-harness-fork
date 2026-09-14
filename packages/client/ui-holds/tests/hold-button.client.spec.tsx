// @vitest-environment jsdom
/**
 * The composer's Hold control: it parks the draft only when the draft can be
 * parked, states why when it cannot, and writes back into the hold the dock is
 * editing rather than adding a second copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HoldButton, type HoldButtonProps } from '../src/client/HoldButton.tsx'
import { createHoldsStore } from '../src/client/stores.ts'
import { en } from '../src/client/locales.ts'

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

/**
 * Mount the control over one draft.
 * @param draft - the composer's current text.
 * @param attachments - how many draft attachments the composer holds.
 * @param editing - a hold the composer is currently editing.
 * @returns the store and the composer's own spies.
 */
function mount(draft = '', attachments = 0, editing: string | null = null) {
  const instance = createHoldsStore().create('s1')
  if (editing !== null) {
    instance.actions.hold('a held draft')
    instance.actions.edit(editing)
  }
  const setDraft = vi.fn()
  const props = {
    useInput: <T,>(select: (state: { draft: string; attachmentIds: readonly string[] }) => T): T =>
      select({ draft, attachmentIds: Array.from({ length: attachments }, (_, index) => `a${index}`) }),
    inputActions: { setDraft },
    useStore: bindSnapshotSelector(instance.store),
    actions: instance.actions,
    t: makeTranslate(en),
  } as unknown as HoldButtonProps
  render(<HoldButton {...props} />)
  return { instance, setDraft }
}

/** The control itself. */
const control = () => screen.getByRole<HTMLButtonElement>('button', { name: en['hold.label'] })

describe('HoldButton', () => {
  it('refuses an empty draft and says why', () => {
    const bench = mount('   ')
    expect(control().disabled).toBe(true)
    expect(control().getAttribute('title')).toBe(en['hold.title.empty'])
    expect(bench.setDraft).not.toHaveBeenCalled()
  })

  it('refuses a draft carrying attachments and says why', () => {
    const bench = mount('send the file', 1)
    expect(control().disabled).toBe(true)
    expect(control().getAttribute('title')).toBe(en['hold.title.attachments'])
    expect(bench.setDraft).not.toHaveBeenCalled()
  })

  it('parks the draft and clears the composer', () => {
    const bench = mount('fix the parser')
    expect(control().disabled).toBe(false)
    fireEvent.click(control())
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['fix the parser'])
    expect(bench.setDraft).toHaveBeenCalledWith('')
  })

  it('updates the hold being edited instead of adding another', () => {
    const bench = mount('fix the parser too', 0, 'hold-1')
    expect(control().getAttribute('title')).toBe(en['hold.title.update'])
    fireEvent.click(control())
    expect(bench.instance.getSnapshot().items).toHaveLength(1)
    expect(bench.instance.getSnapshot().items[0]?.text).toBe('fix the parser too')
    expect(bench.instance.getSnapshot().editing).toBeNull()
    expect(bench.setDraft).toHaveBeenCalledWith('')
  })

  it('keeps the composer caret on mousedown', () => {
    mount('fix the parser')
    expect(fireEvent.mouseDown(control())).toBe(false)
  })
})
