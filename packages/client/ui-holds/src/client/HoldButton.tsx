/**
 * The composer's Hold control: it parks the current draft for this Session
 * without sending it, and clears the composer.
 *
 * A draft carrying attachments is refused rather than parked, because the
 * parked value is text: clearing the composer would drop browser-owned
 * attachment objects with nothing to restore them from. The control states that
 * reason instead of clearing silently.
 * @module @deepseek-ai/dsh-client-ui-holds/client/HoldButton
 */

import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createHoldsStore } from './stores.ts'
import css from './HoldButton.module.css'

/** Full props of the composer Hold control. */
export type HoldButtonProps =
  PropsRuntime<'conversation.input.left'>
  & PropsStore<ReturnType<typeof createHoldsStore>>
  & PropsLocale<'holds'>

/**
 * Render the Hold control for the resident composer.
 * @param props - composed composer-slot props.
 * @returns the control, or nothing while there is no draft to park.
 */
export function HoldButton({ useInput, inputActions, useStore, actions, t }: HoldButtonProps) {
  const draft = useInput(state => state.draft)
  const attachments = useInput(state => state.attachmentIds.length)
  const editing = useStore(state => state.editing)
  const empty = draft.trim() === ''
  const blocked = attachments > 0
  const title = blocked
    ? t('hold.title.attachments')
    : empty ? t('hold.title.empty') : editing !== null ? t('hold.title.update') : t('hold.title')
  const park = (): void => {
    if (editing !== null) {
      actions.update(editing, draft)
      actions.edit(null)
    } else {
      actions.hold(draft)
    }
    inputActions.setDraft('')
  }
  return (
    <Tooltip label={title} side="top" delayMs={500}>
      <button
        type="button"
        className={css.hold}
        aria-label={t('hold.label')}
        title={title}
        disabled={empty || blocked}
        // The composer keeps the caret: parking must not move focus out of the
        // editor the user typed in.
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={park}
      >
        {t('hold.label')}
      </button>
    </Tooltip>
  )
}
