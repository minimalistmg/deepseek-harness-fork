/**
 * The ui-holds browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared composer control seat and composer dock, waits for both
 * declarations, and empties them on teardown (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { HoldButton } from '../src/client/HoldButton.tsx'
import { HoldsDock } from '../src/client/HoldsDock.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

/** A client context carrying the slot registry and locale. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots }
}

describe('ui-holds browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('waits until conversation declares the composer seats', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(0)
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.left')).toHaveLength(1)
  })

  it('registers the Hold control and the dock, and withdraws both on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const control = b.slots.entries('conversation.input.left')[0]!
    expect(control.component).toBe(HoldButton)
    expect(control.options.id).toBe('holds')
    expect(control.locale).toBe('holds')
    const dock = b.slots.entries('conversation.input.dock')[0]!
    expect(dock.component).toBe(HoldsDock)
    expect(dock.locale).toBe('holds')

    await fiber.dispose()
    expect(b.slots.entries('conversation.input.left')).toHaveLength(0)
    expect(b.slots.entries('conversation.input.dock')).toHaveLength(0)
  })
})
