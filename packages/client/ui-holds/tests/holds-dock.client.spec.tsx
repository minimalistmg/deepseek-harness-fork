// @vitest-environment jsdom
/**
 * The holds dock: rows for the Session's parked drafts, the collapse header a
 * longer list carries, and the four row operations — send through the composer,
 * edit, delete, and reorder by drag or arrow key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { HoldsDock, type HoldsDockProps } from '../src/client/HoldsDock.tsx'
import { createHoldsStore } from '../src/client/stores.ts'
import { en } from '../src/client/locales.ts'

beforeEach(() => {
  localStorage.clear()
})

afterEach(cleanup)

/** Mount the dock over a list of parked drafts. */
function mount(holds: readonly string[] = [], editing: string | null = null) {
  const instance = createHoldsStore().create('s1')
  for (const text of holds) instance.actions.hold(text)
  if (editing !== null) instance.actions.edit(editing)
  const setDraft = vi.fn()
  const submit = vi.fn()
  const props = {
    useStore: bindSnapshotSelector(instance.store),
    actions: instance.actions,
    inputActions: { setDraft, submit },
    t: makeTranslate(en),
  } as unknown as HoldsDockProps
  const view = render(<HoldsDock {...props} />)
  return { instance, setDraft, submit, view }
}

/** The rows the dock currently renders, in document order. */
const rows = () => [...document.querySelectorAll('[data-hold-row]')]

/** The text of each rendered row, in document order. */
const rowTexts = () => rows().map(row => row.querySelector('span[title]')?.textContent)

/** One row control by its accessible name. */
const action = (name: string) => screen.getByRole('button', { name })

describe('HoldsDock', () => {
  it('renders nothing while the Session holds no drafts', () => {
    const bench = mount([])
    expect(bench.view.container.innerHTML).toBe('')
  })

  it('renders a single hold without a count header', () => {
    mount(['fix the parser'])
    expect(rowTexts()).toEqual(['fix the parser'])
    expect(screen.queryByRole('button', { name: /on Hold/ })).toBeNull()
  })

  it('collapses a longer list behind its count and expands on click', () => {
    mount(['one', 'two'])
    expect(rowTexts()).toEqual([])
    const header = screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(header)
    expect(rowTexts()).toEqual(['one', 'two'])
    expect(header.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(header)
    expect(rowTexts()).toEqual([])
  })

  it('sends a hold through the composer and drops it from the list', () => {
    const bench = mount(['fix the parser'])
    fireEvent.click(action(`${en['dock.send']} 1`))
    expect(bench.setDraft).toHaveBeenCalledWith('fix the parser')
    expect(bench.submit).toHaveBeenCalledTimes(1)
    expect(bench.instance.getSnapshot().items).toEqual([])
  })

  it('loads a hold into the composer and marks it as edited', () => {
    const bench = mount(['fix the parser'])
    fireEvent.click(action(`${en['dock.edit']} 1`))
    expect(bench.setDraft).toHaveBeenCalledWith('fix the parser')
    expect(bench.submit).not.toHaveBeenCalled()
    expect(bench.instance.getSnapshot().editing).toBe('hold-1')
    expect(screen.getByRole('status').textContent).toBe(en['dock.editing'])
  })

  it('deletes a hold without touching the composer', () => {
    const bench = mount(['one', 'two'])
    fireEvent.click(screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') }))
    fireEvent.click(action(`${en['dock.delete']} 1`))
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['two'])
    expect(bench.setDraft).not.toHaveBeenCalled()
  })

  it('empties the dock when the last hold is deleted', () => {
    const bench = mount(['only'])
    fireEvent.click(action(`${en['dock.delete']} 1`))
    expect(bench.view.container.innerHTML).toBe('')
  })

  it('reorders with the arrow keys on the focused handle', () => {
    const bench = mount(['one', 'two'])
    fireEvent.click(screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') }))
    // Re-read the handles between moves: a move reorders the rows React renders
    // under the same node keys, so a handle captured before it names another row.
    fireEvent.keyDown(screen.getAllByRole('button', { name: en['dock.reorder'] })[1]!, { key: 'ArrowUp' })
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['two', 'one'])
    fireEvent.keyDown(screen.getAllByRole('button', { name: en['dock.reorder'] })[0]!, { key: 'ArrowDown' })
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['one', 'two'])
  })

  it('leaves the order alone for another key', () => {
    const bench = mount(['one', 'two'])
    fireEvent.click(screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') }))
    fireEvent.keyDown(screen.getAllByRole('button', { name: en['dock.reorder'] })[0]!, { key: 'Enter' })
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['one', 'two'])
  })

  it('reorders by dragging one row onto another', () => {
    const bench = mount(['one', 'two'])
    fireEvent.click(screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') }))
    const handles = screen.getAllByRole('button', { name: en['dock.reorder'] })
    fireEvent.dragStart(handles[0]!)
    fireEvent.dragOver(rows()[1]!)
    fireEvent.drop(rows()[1]!)
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['two', 'one'])
  })

  it('leaves the order alone when something is dropped without a drag', () => {
    const bench = mount(['one', 'two'])
    fireEvent.click(screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') }))
    fireEvent.drop(rows()[1]!)
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['one', 'two'])
  })

  it('clears the drag state when the gesture ends without a drop', () => {
    const bench = mount(['one', 'two'])
    fireEvent.click(screen.getByRole('button', { name: en['dock.count'].replace('{n}', '2') }))
    const handle = screen.getAllByRole('button', { name: en['dock.reorder'] })[0]!
    fireEvent.dragStart(handle)
    expect(rows()[0]?.className).toContain('dragging')
    fireEvent.dragEnd(handle)
    expect(rows()[0]?.className).not.toContain('dragging')
    expect(bench.instance.getSnapshot().items.map(item => item.text)).toEqual(['one', 'two'])
  })
})
