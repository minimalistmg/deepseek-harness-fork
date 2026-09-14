/**
 * The holds dock: the parked drafts for this Session, above the composer card.
 *
 * DeepSeek's own queue remains the send line; a hold is a draft that was never
 * sent. Send moves a hold back through the composer and submits it, so the
 * message travels the ordinary path and the dock never speaks to the Session
 * itself.
 *
 * Reordering is one operation with two gestures: a pointer drag, and the up and
 * down arrows on the focused handle, because a drag-only control is unusable
 * without a pointer.
 * @module @deepseek-ai/dsh-client-ui-holds/client/HoldsDock
 */

import { useEffect, useId, useState } from 'react'
import { IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconEditOutline16, IconQueueOutline14, IconSendOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createHoldsStore, Hold } from './stores.ts'
import css from './HoldsDock.module.css'

/** Full props of the holds dock. */
export type HoldsDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsStore<ReturnType<typeof createHoldsStore>>
  & PropsLocale<'holds'>

/** One row's owner values, so the row stays a plain presentation component. */
interface HoldRowProps {
  readonly hold: Hold
  readonly index: number
  readonly count: number
  readonly editing: boolean
  readonly dragging: boolean
  readonly t: HoldsDockProps['t']
  readonly onSend: (hold: Hold) => void
  readonly onEdit: (hold: Hold) => void
  readonly onDelete: (hold: Hold) => void
  readonly onReorder: (hold: Hold, to: number) => void
  /** Drop a dragged row at this row's position. */
  readonly onDropAt: (to: number) => void
  readonly onDragStart: (hold: Hold) => void
  readonly onDragEnd: () => void
}

/** One parked draft, with its send, edit, delete, and reorder controls. */
function HoldRow({
  hold, index, count, editing, dragging, t, onSend, onEdit, onDelete, onReorder, onDropAt, onDragStart, onDragEnd,
}: HoldRowProps) {
  const label = t('dock.reorder')
  return (
    <li
      className={dragging ? `${css.row} ${css.dragging}` : css.row}
      data-hold-row={hold.id}
      onDragOver={(event) => { event.preventDefault() }}
      onDrop={(event) => {
        event.preventDefault()
        onDropAt(index)
      }}
    >
      <button
        type="button"
        className={css.handle}
        draggable
        aria-label={label}
        title={label}
        onDragStart={() => { onDragStart(hold) }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            onReorder(hold, index - 1)
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            onReorder(hold, index + 1)
          }
        }}
      >
        <span className={css.grip} aria-hidden>⠿</span>
      </button>
      <span className={css.preview} title={hold.text}>{hold.text}</span>
      {editing && <span className={css.status} role="status">{t('dock.editing')}</span>}
      <div className={css.actions}>
        <Tooltip label={t('dock.send')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.action}
            aria-label={`${t('dock.send')} ${index + 1}`}
            onClick={() => { onSend(hold) }}
          >
            <IconSendOutline14 />
          </button>
        </Tooltip>
        <Tooltip label={t('dock.edit')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.action}
            aria-label={`${t('dock.edit')} ${index + 1}`}
            onClick={() => { onEdit(hold) }}
          >
            <IconEditOutline16 size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('dock.delete')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.action}
            aria-label={`${t('dock.delete')} ${index + 1}`}
            disabled={count === 0}
            onClick={() => { onDelete(hold) }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </Tooltip>
      </div>
    </li>
  )
}

/**
 * Render the parked drafts for the current Session.
 * @param props - composed composer-dock props.
 * @returns the dock, or nothing while this Session holds no drafts.
 */
export function HoldsDock({ useStore, actions, inputActions, t }: HoldsDockProps) {
  const items = useStore(state => state.items)
  const editing = useStore(state => state.editing)
  // One row renders directly, so it needs no header; several default to the
  // collapsed count header, the way the send queue's strip behaves.
  const [collapsed, setCollapsed] = useState(true)
  const [dragged, setDragged] = useState<Hold | null>(null)
  const listId = useId()

  useEffect(() => {
    if (items.length <= 1 && !collapsed) setCollapsed(true)
  }, [collapsed, items.length])

  if (items.length === 0) return null

  const expanded = items.length === 1 || !collapsed
  // A hold leaves the list the moment it is sent: the dock owns no in-flight
  // state, and a failed submission surfaces through the composer's own notices.
  const send = (hold: Hold): void => {
    inputActions.setDraft(hold.text)
    actions.remove(hold.id)
    inputActions.submit()
  }
  const edit = (hold: Hold): void => {
    inputActions.setDraft(hold.text)
    actions.edit(hold.id)
  }
  const reorder = (hold: Hold, to: number): void => {
    actions.move(hold.id, to)
    setDragged(null)
  }
  return (
    <div className={css.dock} data-holds-dock="">
      <div className={css.panel}>
        {items.length > 1 && (
          <button
            type="button"
            className={css.header}
            aria-controls={listId}
            aria-expanded={expanded}
            onClick={() => { setCollapsed(value => !value) }}
          >
            <span className={css.lead} aria-hidden><IconQueueOutline14 /></span>
            <span className={css.count}>{t('dock.count', { n: items.length })}</span>
            <span className={css.chevron} aria-hidden>
              {expanded ? <IconChevronDownOutline14 /> : <IconChevronUpOutline14 />}
            </span>
          </button>
        )}
        <ul id={listId} className={css.list} hidden={!expanded}>
          {expanded && items.map((hold, index) => (
            <HoldRow
              key={hold.id}
              hold={hold}
              index={index}
              count={items.length}
              editing={editing === hold.id}
              dragging={dragged?.id === hold.id}
              t={t}
              onSend={send}
              onEdit={edit}
              onDelete={(target) => { actions.remove(target.id) }}
              onReorder={reorder}
              onDropAt={(to) => {
                if (dragged !== null) reorder(dragged, to)
              }}
              onDragStart={(target) => { setDragged(target) }}
              onDragEnd={() => { setDragged(null) }}
            />
          ))}
        </ul>
      </div>
    </div>
  )
}
