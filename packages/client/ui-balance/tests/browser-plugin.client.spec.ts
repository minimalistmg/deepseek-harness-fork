/**
 * The ui-balance browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared composer dock with the balance pill, waits for that
 * declaration, and empties the seat on teardown (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { BalancePill } from '../src/client/BalancePill.tsx'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A client context carrying the slot registry and locale. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots }
}

describe('ui-balance browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('waits until conversation declares the composer dock', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.composer.dock')).toHaveLength(0)
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.composer.dock': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.composer.dock')).toHaveLength(1)
  })

  it('registers the pill and withdraws it on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.composer.dock')[0]!
    expect(entry.component).toBe(BalancePill)
    expect(entry.options.id).toBe('account-balance')
    expect(entry.locale).toBe('balance')

    await fiber.dispose()
    expect(b.slots.entries('conversation.composer.dock')).toHaveLength(0)
  })

  it('reads the balance over the shared channel', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const injected = b.slots.entries('conversation.composer.dock')[0]!.inject?.() as unknown as {
      read(signal?: AbortSignal): Promise<{ status: string }>
    }
    const report = { available: true, currency: 'USD', total: '1.00', granted: '0', toppedUp: '1.00' }
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ ok: true, report }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(injected.read()).resolves.toEqual({ status: 'ready', report })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/account/balance')
    vi.unstubAllGlobals()
  })
})
