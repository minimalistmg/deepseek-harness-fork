/**
 * The ui-voice browser half on a real SlotRegistry: the plugin occupies the
 * conversation-declared `conversation.input.right` list seat with the dictation
 * control, adds the wave dock to the composer dock and the preference group to
 * General Settings, waits for each declaration, and empties every seat on
 * teardown (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { VoiceControl } from '../src/client/VoiceControl.tsx'
import { VoiceWave } from '../src/client/VoiceWave.tsx'
import { VoiceSettingsRow } from '../src/client/settings/VoiceSettingsRow.tsx'
import { apply, inject } from '../src/client/index.ts'
import { settingsScopeStub } from './settings-scope-stub.client.ts'

/** A client context carrying the slot registry, locale, and settings scope. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.composer.dock': { kind: 'list', scope: 'session' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('settingsScope', settingsScopeStub().service as never)
  return { ctx, slots }
}

describe('ui-voice browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })

  it('waits until conversation declares the right seat', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('settingsScope', settingsScopeStub().service as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.input.right')).toHaveLength(0)
    ctx.slots.register({
      name: 'root',
      children: { 'conversation.input.right': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.right')).toHaveLength(1)
  })

  it('registers the dictation seat, the wave dock, and the settings group', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const seat = b.slots.entries('conversation.input.right')[0]!
    expect(seat.component).toBe(VoiceControl)
    expect(seat.options.id).toBe('voice')
    expect(seat.locale).toBe('voice')
    expect(b.slots.entries('conversation.composer.dock')[0]!.component).toBe(VoiceWave)
    expect(b.slots.entries('settings.general.item')[0]!.component).toBe(VoiceSettingsRow)
  })

  it('withdraws every registration on teardown', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.right')).toHaveLength(0)
    expect(b.slots.entries('conversation.composer.dock')).toHaveLength(0)
    expect(b.slots.entries('settings.general.item')).toHaveLength(0)
  })

  it('publishes the seat level to the dock meter', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const seatInject = b.slots.entries('conversation.input.right')[0]!.inject?.() as unknown as {
      reportListening(active: boolean): void
      reportLevel(level: number): void
    }
    const dockInject = b.slots.entries('conversation.composer.dock')[0]!.inject?.() as unknown as {
      hooks: { meter: { getSnapshot(): { listening: boolean; levels: readonly number[] } } }
    }
    expect(dockInject.hooks.meter.getSnapshot()).toEqual({ listening: false, levels: [] })
    seatInject.reportListening(true)
    seatInject.reportLevel(0.25)
    expect(dockInject.hooks.meter.getSnapshot()).toEqual({ listening: true, levels: [0.25] })
    seatInject.reportListening(false)
    expect(dockInject.hooks.meter.getSnapshot()).toEqual({ listening: false, levels: [0.25] })
  })

  it('routes every preference write through the settings scope', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const settingsInject = b.slots.entries('settings.general.item')[0]!.inject?.() as unknown as {
      setPushToTalk(spec: string): void
      setAutoSend(on: boolean): void
      setSilenceMs(ms: number): void
      setCleanup(on: boolean): void
      setSpokenSend(on: boolean): void
    }
    expect(() => {
      settingsInject.setPushToTalk('Ctrl+M')
      settingsInject.setAutoSend(false)
      settingsInject.setSilenceMs(2000)
      settingsInject.setCleanup(false)
      settingsInject.setSpokenSend(false)
    }).not.toThrow()
  })
})
