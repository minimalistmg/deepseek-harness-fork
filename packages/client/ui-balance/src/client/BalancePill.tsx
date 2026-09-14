/**
 * The account balance pill: one footer reading beside the session statistics,
 * with the breakdown on demand.
 *
 * A deployment whose host reports no balance renders nothing at all — a pill
 * that can never fill is noise in every composer. A read that failed stays
 * visible with a retry, because that is a state the user can act on.
 * @module @deepseek-ai/dsh-client-ui-balance/client/BalancePill
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the composer dock seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BalanceState } from './balance.ts'
import { ACCOUNT_BALANCE_USAGE_URL, type AccountBalanceReport } from '../protocol.ts'
import css from './BalancePill.module.css'

/** The pill's injected face: one read of the account balance. */
export interface BalancePillInjected {
  /**
   * Read the account balance.
   * @param signal - caller cancellation.
   * @returns the state the pill renders.
   */
  readonly read: (signal?: AbortSignal) => Promise<BalanceState>
}

/** Full props of the balance pill. */
export type BalancePillProps =
  PropsRuntime<'conversation.composer.dock'> & BalancePillInjected & PropsLocale<'balance'>

/** Distance between the pill and its panel, in pixels. */
const PANEL_GAP = 8

/**
 * The pill's glyph. The design system ships no balance icon, so the pill draws
 * its own wallet, matching the inline glyphs the composer's controls use.
 */
function WalletGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        d="M2.75 4.5A1.75 1.75 0 0 1 4.5 2.75h6.25a.75.75 0 0 1 0 1.5H4.5a.25.25 0 0 0-.25.25v.75h7.5A2.25 2.25 0 0 1 13.75 7.5v3.75A2.25 2.25 0 0 1 11.5 13.5h-7a2.25 2.25 0 0 1-2.25-2.25V4.5Zm9.5 4.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** The balance as the pill shows it: the converted total when one was resolved. */
export function balanceText(report: AccountBalanceReport): string {
  return report.fx === undefined ? `${report.total} ${report.currency}` : `${report.fx.converted} ${report.fx.currency}`
}

/**
 * The extras worth a row beyond the total: a credit bucket only when it is a
 * real part of the balance rather than the whole of it.
 * @param report - the balance read back.
 * @returns the rows to render, in reading order.
 */
export function balanceExtras(report: AccountBalanceReport): readonly ('granted' | 'toppedUp')[] {
  const rows: ('granted' | 'toppedUp')[] = []
  if (Number(report.granted) !== 0 && report.granted !== report.total) rows.push('granted')
  if (Number(report.toppedUp) !== 0 && report.toppedUp !== report.total) rows.push('toppedUp')
  return rows
}

/** One labeled amount row inside the panel. */
function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className={css.term}>{label}</dt>
      <dd className={css.detail}>{value}</dd>
    </>
  )
}

/**
 * Render the account balance pill.
 * @param props - composed composer-dock props with the injected reader.
 * @returns the pill, or nothing while there is no balance to show.
 */
export function BalancePill({ read, t }: BalancePillProps) {
  const [state, setState] = useState<BalanceState>({ status: 'loading' })
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<{ left: number; bottom: number } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const cancel = new AbortController()
    void read(cancel.signal).then((next) => {
      if (cancel.signal.aborted) return
      setState(next)
    })
    return () => { cancel.abort() }
  }, [read])

  // A panel opened near the window's bottom edge grows upward from the pill, so
  // its placement is read from the anchor once per open rather than guessed.
  useLayoutEffect(() => {
    if (!open) return
    const rect = anchorRef.current?.getBoundingClientRect()
    /* v8 ignore next -- the anchor is mounted for as long as its panel can open. */
    if (rect === undefined) return
    setPanel({ left: rect.left, bottom: window.innerHeight - rect.top + PANEL_GAP })
  }, [open, state])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (anchorRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  // Nothing to read and nothing to retry: the footer stays as it was.
  if (state.status === 'unavailable' || state.status === 'loading') return null

  if (state.status === 'failed') {
    const failed = t('pill.failed')
    return (
      <div className={css.root} data-account-balance="">
        <button
          type="button"
          className={css.pill}
          aria-label={failed}
          title={failed}
          onClick={() => {
            setState({ status: 'loading' })
            void read().then(setState)
          }}
        >
          <WalletGlyph />
          <span className={css.label}>{t('pill.label')}</span>
        </button>
      </div>
    )
  }

  const report = state.report
  const status = report.available ? t('pill.available') : t('pill.unavailable')
  const text = balanceText(report)
  const label = `${t('pill.label')} ${text} · ${status}`
  const extras = balanceExtras(report)
  return (
    <div className={css.root} data-account-balance="">
      <span ref={anchorRef} className={css.anchor}>
        <button
          type="button"
          className={css.pill}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          onClick={() => { setOpen(value => !value) }}
        >
          <WalletGlyph />
          <span className={css.label}>{text}</span>
          <span className={css.sep} aria-hidden>·</span>
          <span className={css.status}>{status}</span>
        </button>
      </span>
      {open && panel !== null && createPortal(
        <div
          className={css.panel}
          role="dialog"
          aria-label={t('popover.title')}
          style={{ left: panel.left, bottom: panel.bottom }}
        >
          <div className={css.panelHeader}>
            <span className={css.panelTitle}>{t('popover.title')}</span>
            <span className={css.panelTotal}>{text}</span>
          </div>
          <dl className={css.details}>
            {extras.map(extra => (
              <PanelRow
                key={extra}
                label={extra === 'granted' ? t('popover.granted') : t('popover.toppedUp')}
                value={extra === 'granted' ? `${report.granted} ${report.currency}` : `${report.toppedUp} ${report.currency}`}
              />
            ))}
            <PanelRow label={t('popover.available')} value={report.available ? t('popover.available.yes') : t('popover.available.no')} />
            {report.fx !== undefined && (
              <PanelRow
                label={`${report.total} ${report.currency}`}
                value={t('pill.fx', { rate: report.fx.rate })}
              />
            )}
          </dl>
          <Tooltip label={t('popover.usage')} side="top" delayMs={500}>
            <a
              className={css.usage}
              href={ACCOUNT_BALANCE_USAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('popover.usage')}
            </a>
          </Tooltip>
        </div>,
        document.body,
      )}
    </div>
  )
}
