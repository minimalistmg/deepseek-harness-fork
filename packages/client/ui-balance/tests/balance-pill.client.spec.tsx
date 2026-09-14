// @vitest-environment jsdom
/**
 * The account balance pill: what it shows once a balance arrives, the
 * breakdown its panel carries, the retry a failed read offers, and the absence
 * of the pill when this deployment has no balance to read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  balanceExtras, balanceText, BalancePill, type BalancePillProps,
} from '../src/client/BalancePill.tsx'
import type { BalanceState } from '../src/client/balance.ts'
import type { AccountBalanceReport } from '../src/protocol.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/** The reading every case starts from. */
const report: AccountBalanceReport = {
  available: true, currency: 'USD', total: '12.34', granted: '2.34', toppedUp: '10.00',
}

/**
 * Mount the pill over one reader.
 * @param states - the answers the reader gives, in call order; the last repeats.
 * @returns the reader spy.
 */
function mount(...states: BalanceState[]) {
  const read = vi.fn(async (): Promise<BalanceState> => states.shift() ?? { status: 'failed' })
  const props = { read, t: makeTranslate(en) } as unknown as BalancePillProps
  render(<BalancePill {...props} />)
  return read
}

/** The pill button, once it renders. */
const pill = () => screen.getByRole('button', { name: new RegExp(en['pill.label']) })

describe('balance text', () => {
  it('shows the account total, or the converted one when a rate resolved', () => {
    expect(balanceText(report)).toBe('12.34 USD')
    expect(balanceText({ ...report, fx: { currency: 'INR', rate: 80, converted: '987.20' } })).toBe('987.20 INR')
  })

  it('lists a credit bucket only when it is part of the balance', () => {
    expect(balanceExtras(report)).toEqual(['granted', 'toppedUp'])
    expect(balanceExtras({ ...report, granted: '0' })).toEqual(['toppedUp'])
    expect(balanceExtras({ ...report, granted: '12.34' })).toEqual(['toppedUp'])
    expect(balanceExtras({ ...report, granted: '0', toppedUp: '0' })).toEqual([])
  })
})

describe('BalancePill', () => {
  it('renders nothing before the read settles or when there is no balance', async () => {
    const pending = vi.fn(async (): Promise<BalanceState> => await new Promise(() => {}))
    const props = { read: pending, t: makeTranslate(en) } as unknown as BalancePillProps
    const view = render(<BalancePill {...props} />)
    expect(view.container.textContent).toBe('')
    cleanup()

    mount({ status: 'unavailable' })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the balance and its availability', async () => {
    mount({ status: 'ready', report })
    await act(async () => { await Promise.resolve() })
    expect(pill().getAttribute('aria-label')).toBe(`${en['pill.label']} 12.34 USD · ${en['pill.available']}`)
  })

  it('says when the platform refuses the balance', async () => {
    mount({ status: 'ready', report: { ...report, available: false } })
    await act(async () => { await Promise.resolve() })
    expect(pill().textContent).toContain(en['pill.unavailable'])
  })

  it('opens the breakdown and closes it on Escape', async () => {
    mount({ status: 'ready', report })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(pill())
    const panel = screen.getByRole('dialog', { name: en['popover.title'] })
    expect(panel.textContent).toContain(en['popover.granted'])
    expect(panel.textContent).toContain('2.34 USD')
    expect(panel.textContent).toContain(en['popover.toppedUp'])
    expect(panel.textContent).toContain(en['popover.available.yes'])
    expect(screen.getByRole('link', { name: en['popover.usage'] }).getAttribute('target')).toBe('_blank')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the breakdown on an outside press', async () => {
    mount({ status: 'ready', report })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(pill())
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the breakdown open for a press on the pill and for another key', async () => {
    mount({ status: 'ready', report })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(pill())
    fireEvent.mouseDown(pill())
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('toggles the breakdown closed from the pill', async () => {
    mount({ status: 'ready', report })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(pill())
    fireEvent.click(pill())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says in the panel when the platform refuses the balance', async () => {
    mount({ status: 'ready', report: { ...report, available: false } })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(pill())
    expect(screen.getByRole('dialog').textContent).toContain(en['popover.available.no'])
  })

  it('drops an answer that arrives after unmount', async () => {
    let settle: ((state: BalanceState) => void) | undefined
    const read = vi.fn(async (): Promise<BalanceState> =>
      await new Promise<BalanceState>((resolve) => { settle = resolve }))
    const props = { read, t: makeTranslate(en) } as unknown as BalancePillProps
    const view = render(<BalancePill {...props} />)
    cleanup()
    await act(async () => { settle?.({ status: 'ready', report }) })
    expect(view.container.textContent).toBe('')
  })

  it('notes a converted total with its rate and hides an unusable bucket', async () => {
    mount({
      status: 'ready',
      report: { ...report, granted: '12.34', fx: { currency: 'INR', rate: 80, converted: '987.20' } },
    })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(pill())
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('987.20 INR')
    expect(panel.textContent).not.toContain(en['popover.granted'])
    expect(panel.textContent).toContain(en['pill.fx'].replace('{rate}', '80'))
  })

  it('offers a retry when the read failed', async () => {
    const read = mount({ status: 'failed' }, { status: 'ready', report })
    await act(async () => { await Promise.resolve() })
    const retry = screen.getByRole('button', { name: en['pill.failed'] })
    await act(async () => { fireEvent.click(retry) })
    await act(async () => { await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(2)
    expect(pill().getAttribute('aria-label')).toContain('12.34 USD')
  })
})
