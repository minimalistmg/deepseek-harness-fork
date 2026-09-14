/**
 * Per-Session parked drafts.
 *
 * A hold is a draft the user stopped working on but did not send, so it is
 * browser state keyed by Session and never a Session event: nothing here is
 * model-visible until the draft is resumed and sent. The store persists through
 * the shared snapshot engine, whose per-Session key makes each Session's holds
 * its own; a Session the browser has never held starts empty.
 * @module @deepseek-ai/dsh-client-ui-holds/client/stores
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Browser storage key prefix; the engine appends the Session id. */
const HOLDS_STORE_KEY = 'dsh.holds'

/** One parked draft. */
export interface Hold {
  /** Stable identity within the Session, assigned by {@link HoldsActions.hold}. */
  readonly id: string
  /** Draft text as the composer projected it, reference chips flattened to their text. */
  readonly text: string
  /** Creation time in milliseconds, for the row's age reading. */
  readonly at: number
}

/**
 * Parked-draft state for one Session. The actions mutate this draft in place,
 * so its members are writable; consumers read the published snapshot, whose
 * values are replaced rather than edited.
 */
export interface HoldsState {
  /** Parked drafts, newest last. */
  items: Hold[]
  /** The hold the composer is editing, absent while the composer starts a new one. */
  editing: string | null
  /** Next identity to assign, monotonic per Session. */
  next: number
}

/** Declared write set for the holds dock and its composer control. */
export type HoldsActions = {
  /**
   * Park one draft at the end of the list.
   * @param draft - the state being mutated.
   * @param text - the composer's text.
   */
  hold: (draft: HoldsState, text: string) => void
  /**
   * Replace one hold's text.
   * @param draft - the state being mutated.
   * @param id - the hold to rewrite.
   * @param text - the composer's text.
   */
  update: (draft: HoldsState, id: string, text: string) => void
  /**
   * Drop one hold.
   * @param draft - the state being mutated.
   * @param id - the hold to drop.
   */
  remove: (draft: HoldsState, id: string) => void
  /**
   * Move one hold to a new position.
   * @param draft - the state being mutated.
   * @param id - the hold to move.
   * @param to - the index it should occupy.
   */
  move: (draft: HoldsState, id: string, to: number) => void
  /**
   * Mark which hold the composer's Hold control updates.
   * @param draft - the state being mutated.
   * @param id - the hold being edited, or null to start a new one.
   */
  edit: (draft: HoldsState, id: string | null) => void
}

/**
 * Declare per-Session parked drafts.
 * @returns the store handle shared by the composer control and the dock.
 */
export function createHoldsStore(): EngineStoreHandle<HoldsState, HoldsActions> {
  return defineStore({
    init: (): HoldsState => ({ items: [], editing: null, next: 1 }),
    persist: HOLDS_STORE_KEY,
    actions: {
      hold: (d, text: string) => {
        const trimmed = text.trim()
        if (trimmed === '') return
        d.items.push({ id: `hold-${d.next}`, text: trimmed, at: Date.now() })
        d.next += 1
      },
      update: (d, id: string, text: string) => {
        const trimmed = text.trim()
        if (trimmed === '') return
        d.items = d.items.map(item => (item.id === id ? { ...item, text: trimmed } : item))
      },
      remove: (d, id: string) => {
        d.items = d.items.filter(item => item.id !== id)
        if (d.editing === id) d.editing = null
      },
      move: (d, id: string, to: number) => {
        const from = d.items.findIndex(item => item.id === id)
        /* v8 ignore next -- the dock only moves a row it renders, so the id is present. */
        if (from < 0) return
        const target = Math.max(0, Math.min(d.items.length - 1, to))
        if (target === from) return
        const items = [...d.items]
        const [moved] = items.splice(from, 1)
        /* v8 ignore next -- `from` is a valid index, so splice removed exactly one item. */
        if (moved === undefined) return
        items.splice(target, 0, moved)
        d.items = items
      },
      edit: (d, id: string | null) => {
        d.editing = id
      },
    },
  })
}
