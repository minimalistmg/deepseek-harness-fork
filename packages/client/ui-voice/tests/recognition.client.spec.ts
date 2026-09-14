// @vitest-environment jsdom
/**
 * The recognition engine wrapper: constructor resolution across the standard
 * and `webkit`-prefixed globals, the configuration one session applies, which
 * results reach `onFinal`, and which failure codes count as faults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dictationEngineCtor, startDictation, type DictationEngineCtor } from '../src/client/recognition.ts'
import { latestEngine, resetEngines, resultEvent, stubCtor } from './engine-stub.client.ts'

beforeEach(() => {
  resetEngines()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dictationEngineCtor', () => {
  it('prefers the standard constructor', () => {
    const standard = function StandardEngine(): void {} as unknown as DictationEngineCtor
    vi.stubGlobal('SpeechRecognition', standard)
    vi.stubGlobal('webkitSpeechRecognition', stubCtor)
    expect(dictationEngineCtor()).toBe(standard)
  })

  it('falls back to the webkit-prefixed constructor', () => {
    vi.stubGlobal('SpeechRecognition', undefined)
    vi.stubGlobal('webkitSpeechRecognition', stubCtor)
    expect(dictationEngineCtor()).toBe(stubCtor)
  })

  it('reports no engine when the browser ships neither', () => {
    vi.stubGlobal('SpeechRecognition', undefined)
    vi.stubGlobal('webkitSpeechRecognition', undefined)
    expect(dictationEngineCtor()).toBeUndefined()
  })
})

describe('startDictation', () => {
  it('configures settled-text recognition in the browser language and starts it', () => {
    vi.stubGlobal('navigator', { language: 'de-DE' })
    startDictation(stubCtor, { onFinal: () => {}, onEnd: () => {}, onError: () => {} })
    expect(latestEngine().lang).toBe('de-DE')
    expect(latestEngine().continuous).toBe(true)
    expect(latestEngine().interimResults).toBe(false)
    expect(latestEngine().starts).toBe(1)
  })

  it('asks for en-US when the browser names no language', () => {
    vi.stubGlobal('navigator', { language: '' })
    startDictation(stubCtor, { onFinal: () => {}, onEnd: () => {}, onError: () => {} })
    expect(latestEngine().lang).toBe('en-US')
  })

  it('forwards settled chunks and skips interim and empty ones', () => {
    const onFinal = vi.fn()
    startDictation(stubCtor, { onFinal, onEnd: () => {}, onError: () => {} })
    latestEngine().onresult?.(resultEvent(0,
      { transcript: 'unsettled', isFinal: false },
      { transcript: '', isFinal: true },
      { transcript: 'settled', isFinal: true }))
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('settled')
  })

  it('re-reads only the results at and after the event index', () => {
    const onFinal = vi.fn()
    startDictation(stubCtor, { onFinal, onEnd: () => {}, onError: () => {} })
    latestEngine().onresult?.(resultEvent(1,
      { transcript: 'already delivered', isFinal: true },
      { transcript: 'fresh', isFinal: true }))
    expect(onFinal).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('fresh')
  })

  it('treats a silent room and a user stop as routine endings, other codes as faults', () => {
    const onError = vi.fn()
    startDictation(stubCtor, { onFinal: () => {}, onEnd: () => {}, onError })
    latestEngine().onerror?.({ error: 'no-speech' })
    latestEngine().onerror?.({ error: 'aborted' })
    expect(onError).not.toHaveBeenCalled()
    latestEngine().onerror?.({ error: 'not-allowed' })
    expect(onError).toHaveBeenCalledWith('not-allowed')
  })

  it('reports the engine ending and stops it on request', () => {
    const onEnd = vi.fn()
    const session = startDictation(stubCtor, { onFinal: () => {}, onEnd, onError: () => {} })
    latestEngine().onend?.()
    expect(onEnd).toHaveBeenCalledTimes(1)
    session.stop()
    expect(latestEngine().stops).toBe(1)
  })
})
