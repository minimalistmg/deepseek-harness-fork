// @vitest-environment jsdom
/**
 * The parked-draft store: what each action writes, and that two Sessions keep
 * their own holds through the shared persistence key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHoldsStore, type HoldsState } from '../src/client/stores.ts'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

/** One live store instance for a Session. */
function bench(scope = 's1') {
  return createHoldsStore().create(scope)
}

describe('parked drafts', () => {
  it('parks a trimmed draft with its own identity and time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = bench()
    store.actions.hold('  fix the parser  ')
    expect(store.getSnapshot().items).toEqual([{ id: 'hold-1', text: 'fix the parser', at: 1000 }])
    store.actions.hold('and the lexer')
    expect(store.getSnapshot().items.map(item => item.id)).toEqual(['hold-1', 'hold-2'])
  })

  it('refuses a draft that holds no text', () => {
    const store = bench()
    store.actions.hold('   ')
    expect(store.getSnapshot().items).toEqual([])
  })

  it('rewrites one hold and refuses an empty or unknown one', () => {
    const store = bench()
    store.actions.hold('first')
    store.actions.update('hold-1', 'second')
    expect(store.getSnapshot().items[0]?.text).toBe('second')
    store.actions.update('hold-1', '  ')
    store.actions.update('hold-9', 'third')
    expect(store.getSnapshot().items[0]?.text).toBe('second')
  })

  it('drops a hold and clears the editing marker it owned', () => {
    const store = bench()
    store.actions.hold('first')
    store.actions.edit('hold-1')
    store.actions.remove('hold-1')
    expect(store.getSnapshot()).toEqual({ items: [], editing: null, next: 2 })
  })

  it('keeps an editing marker for a hold that remains', () => {
    const store = bench()
    store.actions.hold('first')
    store.actions.hold('second')
    store.actions.edit('hold-1')
    store.actions.remove('hold-2')
    expect(store.getSnapshot().editing).toBe('hold-1')
  })

  it('moves a hold to another position and clamps the target', () => {
    const store = bench()
    for (const text of ['one', 'two', 'three']) store.actions.hold(text)
    store.actions.move('hold-3', 0)
    expect(store.getSnapshot().items.map(item => item.text)).toEqual(['three', 'one', 'two'])
    // A drop below the last row and one onto the same row both leave the order.
    store.actions.move('hold-1', 99)
    expect(store.getSnapshot().items.map(item => item.text)).toEqual(['three', 'two', 'one'])
    store.actions.move('hold-1', 2)
    expect(store.getSnapshot().items.map(item => item.text)).toEqual(['three', 'two', 'one'])
  })

  it('ignores a move or an edit that names nothing', () => {
    const store = bench()
    store.actions.move('hold-7', 0)
    expect(store.getSnapshot().items).toEqual([])
    store.actions.edit('hold-3')
    expect(store.getSnapshot().editing).toBe('hold-3')
    store.actions.edit(null)
    expect(store.getSnapshot().editing).toBeNull()
  })
})

describe('per-Session isolation', () => {
  it('keeps each Session on its own persisted list', () => {
    const first = bench('session-a')
    const second = bench('session-b')
    first.actions.hold('for a')
    second.actions.hold('for b')
    expect(first.getSnapshot().items.map(item => item.text)).toEqual(['for a'])
    expect(second.getSnapshot().items.map(item => item.text)).toEqual(['for b'])
  })

  it('reloads the list a Session already holds', () => {
    bench('session-c').actions.hold('kept across a reload')
    expect(bench('session-c').getSnapshot().items.map(item => item.text)).toEqual(['kept across a reload'])
  })

  it('starts a Session the browser has never held from an empty list', () => {
    const state: HoldsState = bench('session-d').getSnapshot()
    expect(state).toEqual({ items: [], editing: null, next: 1 })
  })
})
