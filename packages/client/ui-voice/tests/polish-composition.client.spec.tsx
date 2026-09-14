// @vitest-environment jsdom
/**
 * The voice plugin's own composition: its real browser apply on a real
 * SlotRegistry inside the production renderer, so the seat's injected polish
 * face is the one production assemblies get — a POST to the plugin's route on
 * the shared `/api` channel, driven here with a stubbed carrier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { VOICE_POLISH_PATH } from '../src/protocol.ts'
import { settingsScopeStub } from './settings-scope-stub.client.ts'

usePinnedBrowserLanguages('en-US')

beforeEach(() => {
  vi.stubGlobal('SpeechRecognition', undefined)
  vi.stubGlobal('webkitSpeechRecognition', undefined)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, text: 'Open file.js.' })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The seat's injected props inside one assembled runtime. */
type SeatEntry = {
  inject?: () => {
    polish(text: string, signal?: AbortSignal): Promise<{ text: string; status: string }>
  }
}

/** A real runtime with this plugin mounted over its own locale dictionary. */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('settingsScope', settingsScopeStub().service as never)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'conversation.input.right': { kind: 'list', scope: 'session' } })
  const feature = await runtime.mount({ inject: [...inject], apply })
  return { runtime, feature }
}

describe('voice plugin composition', () => {
  it('injects its own route as the seat polish pass', async () => {
    const b = await bench()
    const entry = b.runtime.slots.entries('conversation.input.right')[0] as SeatEntry | undefined
    await expect(entry?.inject?.().polish('um so like open the file dot j s')).resolves.toEqual({
      text: 'Open file.js.',
      status: 'ok',
    })

    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1)
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe(VOICE_POLISH_PATH)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'um so like open the file dot j s' })
    await b.runtime.dispose()
  })

  it('reads the host outcome the deployed key state produces', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({
      ok: false,
      error: { code: 'voice/polish-unavailable', message: 'no key', details: {} },
    }))
    const b = await bench()
    const entry = b.runtime.slots.entries('conversation.input.right')[0] as SeatEntry | undefined
    expect(await entry?.inject?.().polish('raw words')).toEqual({ text: 'raw words', status: 'unavailable' })
    await b.runtime.dispose()
  })

  it('withdraws the seat with the plugin fiber', async () => {
    const b = await bench()
    expect(b.runtime.slots.entries('conversation.input.right')).toHaveLength(1)
    await b.feature.dispose()
    expect(b.runtime.slots.entries('conversation.input.right')).toHaveLength(0)
    await b.runtime.dispose()
  })
})
