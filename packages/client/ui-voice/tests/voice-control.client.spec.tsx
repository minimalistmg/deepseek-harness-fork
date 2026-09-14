// @vitest-environment jsdom
/**
 * The composer voice seat: interim text appears in the draft while the speaker
 * talks, the seat rewrites exactly the range it wrote instead of the whole
 * draft, the whole transcript is cleaned once when the utterance ends, and the
 * next attempt withdraws what the previous one left behind.
 *
 * Push-to-talk, the silence gate, and spoken send are driven the same way: the
 * link is a stub whose frames and levels arrive when the case chooses, so no
 * microphone and no provider are involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  seatLabel, seatTitle, VoiceControl,
  type SeatState, type VoiceControlProps,
} from '../src/client/VoiceControl.tsx'
import type { LiveHandlers, LiveUtterance, VoiceLivePass, VoiceLiveStatus } from '../src/client/live.ts'
import type { PolishPass, PolishStatus } from '../src/client/polish.ts'
import { DEFAULT_VOICE_PREFERENCES, type VoicePreferences } from '../src/client/prefs.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  // Every case asserts on its own calls, so one case's record never carries
  // into the next.
  vi.clearAllMocks()
})

// A settled cleanup pass updates the seat from a promise callback, outside any
// event React wraps in `act`; this flag lets `waitFor` flush those updates.
declare global {
  // React's act environment flag, which Testing Library's waitFor reads.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  // jsdom ships neither of these, and the seat's capability probe reads them
  // once per mount; the specs below drive the link, not the capture.
  vi.stubGlobal('AudioContext', class { readonly sampleRate = 0 })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaDevices')
  vi.useRealTimers()
})

/** The framework-injected t seat, stubbed over this package's zh dictionary. */
const t = makeTranslate(zh, commonZh) as VoiceControlProps['t']

/** One settled transcript's cleaned answer, for a pass that succeeded. */
const polished: PolishPass = { text: 'open file.js', status: 'ok' }

/** One seat state, with the parts a case does not care about left clean. */
function seatState(state: Partial<SeatState>): SeatState {
  return { phase: 'idle', dictation: undefined, polish: undefined, ...state }
}

/** A driven stand-in for the live link. */
class LiveStub {
  /** The handlers the seat installed, available once it started an utterance. */
  handlers: LiveHandlers | undefined
  /**
   * The pass the seat's stop answers with. A real link answers with the
   * transcript it assembled, which is what the frames above delivered, so the
   * stub's default does the same; a case sets it to answer otherwise.
   */
  answer: VoiceLivePass | undefined
  /** Records every stop the seat asked for. */
  readonly stopped = vi.fn()
  private starts = 0
  private settle: ((pass: VoiceLivePass) => void) | undefined
  private transcript = ''

  /** The live face the seat receives. */
  readonly face = {
    transcribe: (request: { handlers: LiveHandlers }): LiveUtterance => {
      this.starts += 1
      this.handlers = request.handlers
      const settled = new Promise<VoiceLivePass>((resolve) => { this.settle = resolve })
      return {
        stop: async () => {
          this.stopped()
          const pass = this.answer ?? { text: this.transcript, status: 'ok' as const }
          this.settle?.(pass)
          return await settled
        },
      }
    },
  }

  /** How many utterances the seat started. */
  get count(): number {
    return this.starts
  }

  /**
   * Deliver one transcript frame.
   * @param text - the whole transcript so far.
   * @param settled - whether the frame settles words rather than guessing.
   */
  frame(text: string, settled = false): void {
    this.transcript = text
    act(() => { this.handlers?.onTranscript(text, settled) })
  }

  /** Report that live audio started flowing. */
  listening(): void {
    act(() => { this.handlers?.onListening() })
  }

  /**
   * Deliver one captured chunk's level.
   * @param level - the chunk's root-mean-square level.
   */
  level(level: number): void {
    act(() => { this.handlers?.onLevel(level) })
  }
}

/** The seat under test: its link stub, its spies, and the draft they wrote. */
interface Bench {
  readonly live: LiveStub
  readonly polish: ReturnType<typeof vi.fn>
  readonly replaceRange: ReturnType<typeof vi.fn>
  readonly submit: ReturnType<typeof vi.fn>
  /** The levels the seat published to the wave dock. */
  readonly levels: number[]
  /** Every listening report the seat published, in order. */
  readonly listeningReports: boolean[]
  /** The draft the seat's own writes left. */
  draft(): string
  /**
   * Append text the way the user typing into the composer would.
   * @param text - the text the user typed.
   */
  type(text: string): void
}

/**
 * Render the seat over a real draft model, a live-link stub, and a
 * controllable polish pass.
 *
 * The draft face edits a plain string — the seat reads its offsets from that
 * same string and writes through these verbs — so a case can see both the calls
 * and the text they produced.
 * @param polish - the cleanup pass to install; the default cleans everything.
 * @param initialDraft - text the user already typed before dictating.
 * @param capture - whether this deployment exposes microphone capture.
 * @param prefs - preference overrides on top of the shipped defaults.
 * @returns the bench the case asserts on.
 */
function setup(
  polish?: ReturnType<typeof vi.fn>,
  initialDraft = '',
  capture = true,
  prefs: Partial<VoicePreferences> = {},
): Bench {
  if (!capture) vi.stubGlobal('AudioContext', undefined)
  const cleanupPass = polish ?? vi.fn(async (_text: string): Promise<PolishPass> => polished)
  const live = new LiveStub()
  const state = { draft: initialDraft }
  const replaceRange = vi.fn((start: number, end: number, text: string): boolean => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > state.draft.length) {
      return false
    }
    state.draft = state.draft.slice(0, start) + text + state.draft.slice(end)
    return true
  })
  const insertText = vi.fn((text: string) => { state.draft += text })
  const submit = vi.fn()
  const levels: number[] = []
  const listeningReports: boolean[] = []
  const resolved = { ...DEFAULT_VOICE_PREFERENCES, ...prefs }
  const prefsStore = createSnapshotStore<VoicePreferences>(resolved)
  const props = {
    inputActions: { replaceRange, insertText, submit },
    useInput: <T,>(select: (snapshot: { draft: string }) => T): T => select({ draft: state.draft }),
    usePrefs: <T,>(select: (value: VoicePreferences) => T): T => select(prefsStore.getSnapshot()),
    live: live.face,
    polish: cleanupPass,
    webSpeech: false,
    reportLevel: (level: number) => { levels.push(level) },
    reportListening: (active: boolean) => { listeningReports.push(active) },
    t,
  } as unknown as VoiceControlProps
  render(<VoiceControl {...props} />)
  return {
    live,
    polish: cleanupPass,
    replaceRange,
    submit,
    levels,
    listeningReports,
    draft: () => state.draft,
    type: (text: string) => { state.draft += text },
  }
}

/** The seat's single button, in the shape the DOM declares it. */
const seat = () => screen.getByRole<HTMLButtonElement>('button')

/** The seat's accessible name. */
const label = () => seat().getAttribute('aria-label')

/** A translate seat that reports the key it was asked for. */
const echoKeys = ((key: string) => key) as unknown as VoiceControlProps['t']

/**
 * Press the push-to-talk chord.
 * @param key - the key the gesture names.
 */
function holdPushToTalk(key = 'v'): void {
  fireEvent.keyDown(document, { key, altKey: true })
}

/**
 * Release the push-to-talk chord.
 * @param key - the key the gesture names.
 */
function releasePushToTalk(key = 'v'): void {
  fireEvent.keyUp(document, { key, altKey: true })
}

describe('seat copy', () => {
  it('names every dictation and polish state', () => {
    expect(seatLabel(seatState({}), t)).toBe(zh['control.idle'])
    expect(seatLabel(seatState({ phase: 'warming' }), t)).toBe(zh['control.transcribing'])
    expect(seatLabel(seatState({ phase: 'listening' }), t)).toBe(zh['control.listening'])
    expect(seatLabel(seatState({ phase: 'polishing' }), t)).toBe(zh['control.polishing'])
    expect(seatLabel(seatState({ dictation: 'dictation' }), t)).toBe(zh['control.failed'])
    expect(seatLabel(seatState({ polish: 'failed' }), t)).toBe(zh['control.failed'])
    // A deployment with no cleanup key still dictates, so it is not a failure.
    expect(seatLabel(seatState({ polish: 'no-polish' }), t)).toBe(zh['control.polish.off'])
    expect(seatLabel(seatState({ polish: 'rate-limited' }), t)).toBe(zh['control.polish.rate-limited'])
    expect(seatLabel(seatState({ polish: 'timeout' }), t)).toBe(zh['control.polish.timeout'])
  })

  it('explains an infrastructure fault in the tooltip only', () => {
    expect(seatTitle(seatState({}), t)).toBe(zh['control.idle.title'])
    expect(seatTitle(seatState({ phase: 'warming' }), t)).toBe(zh['control.transcribing.title'])
    expect(seatTitle(seatState({ phase: 'listening' }), t)).toBe(zh['control.listening.title'])
    expect(seatTitle(seatState({ dictation: 'dictation' }), t)).toBe(zh['control.failed.title'])
    expect(seatTitle(seatState({ polish: 'failed' }), t)).toBe(zh['control.failed.title'])
    expect(seatTitle(seatState({ polish: 'rate-limited' }), t))
      .toBe(`${zh['control.polish.rate-limited']} ${zh['control.polish.rate-limited.title']}`)
    expect(seatTitle(seatState({ polish: 'timeout' }), t))
      .toBe(`${zh['control.polish.timeout']} ${zh['control.polish.timeout.title']}`)
    expect(seatTitle(seatState({ polish: 'no-polish' }), t))
      .toBe(`${zh['control.polish.off']} ${zh['control.polish.off.title']}`)
  })

  it('picks one dictionary key per seat state', () => {
    expect(seatLabel(seatState({}), echoKeys)).toBe('control.idle')
    expect(seatLabel(seatState({ phase: 'polishing' }), echoKeys)).toBe('control.polishing')
    expect(seatLabel(seatState({ phase: 'listening' }), echoKeys)).toBe('control.listening')
    expect(seatLabel(seatState({ polish: 'no-polish' }), echoKeys)).toBe('control.polish.off')
  })

  it('renders a disabled seat when this deployment can dictate through no engine', () => {
    // No microphone capture and no browser-engine fallback: the seat has
    // nothing to dictate through.
    const bench = setup(undefined, '', false)
    expect(seat().disabled).toBe(true)
    expect(label()).toBe(zh['control.unsupported'])
    expect(bench.live.count).toBe(0)
  })

  it('keeps the editor focus on mousedown so the transcript lands in the draft', () => {
    setup()
    expect(fireEvent.mouseDown(seat())).toBe(false)
  })
})

describe('live dictation', () => {
  it('shows interim text in the draft while the speaker talks', () => {
    const bench = setup()
    fireEvent.click(seat())
    expect(label()).toBe(zh['control.transcribing'])
    expect(bench.live.count).toBe(1)

    bench.live.listening()
    expect(label()).toBe(zh['control.listening'])
    expect(seat().getAttribute('aria-pressed')).toBe('true')

    bench.live.frame('open the')
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 0, 'open the'])
    bench.live.frame('open the file')
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 8, 'open the file'])
    bench.live.frame('open the file and fix it')
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 13, 'open the file and fix it'])
    // The seat never rewrites the whole draft, so reference chips survive.
    expect(bench.live.count).toBe(1)
    expect(label()).toBe(zh['control.listening'])
  })

  it('replaces the preview with the polished transcript once the speaker stops', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um open file dot j s')
    bench.replaceRange.mockClear()
    await act(async () => { fireEvent.click(seat()) })
    // The seat's own pipeline drops the filler before the host pass sees it.
    expect(bench.polish).toHaveBeenCalledWith('open file dot j s')
    expect(bench.replaceRange.mock.calls).toEqual([[0, 20, 'open file.js']])
    expect(bench.draft()).toBe('open file.js')
    expect(label()).toBe(zh['control.idle'])
    // A plain stop leaves the draft for review; it does not send itself.
    expect(bench.submit).not.toHaveBeenCalled()
  })

  it('dictates into a draft the user already typed', async () => {
    const answer = vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'in src', status: 'ok' }))
    const bench = setup(answer, 'fix the parser ')
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('in src')
    // The range starts after what the user already typed.
    expect(bench.replaceRange.mock.calls).toEqual([[15, 15, 'in src']])
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledWith('in src') })
    await vi.waitFor(() => { expect(label()).toBe(zh['control.idle']) })
    expect(bench.replaceRange.mock.calls).toEqual([[15, 15, 'in src'], [15, 21, 'in src']])
    expect(bench.draft()).toBe('fix the parser in src')
  })

  it('appends again when the user typed over the range the seat wrote', () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('first words')
    expect(bench.replaceRange.mock.calls).toEqual([[0, 0, 'first words']])
    // The user kept typing at the caret, which sits after the preview, so the
    // words they typed now follow it in the draft.
    bench.type(' and then')
    bench.live.frame('first words and more')
    // The preview still owns its own range; the user's words sit after it.
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 11, 'first words and more'])
    expect(bench.draft()).toBe('first words and more and then')
  })

  it('withdraws what the previous attempt wrote before retrying', async () => {
    const bench = setup(vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'Open file.js.', status: 'ok' })))
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um open file dot j s')
    await act(async () => { fireEvent.click(seat()) })
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 20, 'Open file.js.'])

    // The link misheard: the retry takes the text back rather than appending a
    // second copy of the same words.
    fireEvent.click(seat())
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 13, ''])
    expect(bench.live.count).toBe(2)
    expect(label()).toBe(zh['control.transcribing'])
  })

  it('keeps the raw transcript when the cleanup pass fails, and names why', async () => {
    const failures: readonly (readonly [PolishStatus, string])[] = [
      ['unavailable', zh['control.polish.off']],
      ['rate-limited', zh['control.polish.rate-limited']],
      ['timeout', zh['control.polish.timeout']],
      ['failed', zh['control.failed']],
    ]
    for (const [status, copy] of failures) {
      cleanup()
      const bench = setup(vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'raw words', status })))
      fireEvent.click(seat())
      bench.live.listening()
      bench.live.frame('raw words')
      await act(async () => { fireEvent.click(seat()) })
      expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 9, 'raw words'])
      expect(label()).toBe(copy)
    }
  })

  it('reports a link that produced no transcript, and leaves the draft alone', async () => {
    const failures: readonly (readonly [VoiceLiveStatus, string])[] = [
      ['unavailable', zh['control.polish.off']],
      ['denied', zh['control.failed']],
      ['failed', zh['control.failed']],
    ]
    for (const [status, copy] of failures) {
      cleanup()
      const bench = setup()
      fireEvent.click(seat())
      bench.live.answer = { text: '', status }
      await act(async () => { fireEvent.click(seat()) })
      expect(bench.polish).not.toHaveBeenCalled()
      expect(bench.replaceRange).not.toHaveBeenCalled()
      expect(label()).toBe(copy)
    }
  })

  it('keeps a fault visible while the next attempt runs', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.answer = { text: '', status: 'failed' }
    await act(async () => { fireEvent.click(seat()) })
    await act(async () => { await Promise.resolve() })
    expect(label()).toBe(zh['control.failed'])

    // The retry clears the fault it is retrying.
    await act(async () => { fireEvent.click(seat()) })
    await act(async () => { await Promise.resolve() })
    expect(label()).toBe(zh['control.transcribing'])
    expect(bench.live.count).toBe(2)
  })

  it('stops dictation and reports cleanup while it runs', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('open the file')
    await act(async () => { fireEvent.click(seat()) })
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(label()).toBe(zh['control.idle']) })
    expect(bench.draft()).toBe('open file.js')
  })

  it('drops a cleaned answer that arrives after unmount', async () => {
    const pending: ((pass: PolishPass) => void)[] = []
    const answer = vi.fn(async (_text: string): Promise<PolishPass> =>
      await new Promise<PolishPass>((resolve) => { pending.push(resolve) }))
    const bench = setup(answer)
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('looks designed to break')
    fireEvent.click(seat())
    await vi.waitFor(() => { expect(pending).toHaveLength(1) })
    cleanup()
    await act(async () => { pending[0]?.({ text: 'cleaned', status: 'ok' }) })
    // The seat that would have shown the answer is gone, so the preview stays.
    expect(bench.draft()).toBe('looks designed to break')
  })
})

describe('dictation pipeline', () => {
  it('applies verbal punctuation, fillers, and spoken identifiers before cleanup', async () => {
    const answer = vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'rename userId now.', status: 'ok' }))
    const bench = setup(answer)
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um rename the user id in camel case period')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(answer).toHaveBeenCalled() })
    // The cue converts every word that can precede it, so it reads the whole
    // sentence as one identifier rather than only the words before the cue.
    expect(answer.mock.calls[0]?.[0]).toBe('renameTheUserId.')
  })

  it('converts a cue the speaker says on its own', async () => {
    const answer = vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'userId', status: 'ok' }))
    const bench = setup(answer)
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um user id in camel case')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(answer).toHaveBeenCalled() })
    expect(answer.mock.calls[0]?.[0]).toBe('userId')
  })

  it('sends the transcript as dictated when cleanup is off', async () => {
    const answer = vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'kept', status: 'ok' }))
    const bench = setup(answer, '', true, { cleanup: false })
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um keep this comma please')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledWith('um keep this comma please') })
  })

  it('inserts the dictated text when the cleanup pass is unavailable', async () => {
    const bench = setup(vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'open file dot j s', status: 'unavailable' })))
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um open file dot j s')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(bench.draft()).toBe('open file dot j s') })
    expect(label()).toBe(zh['control.polish.off'])
  })
})

describe('push-to-talk', () => {
  it('starts on the chord and sends the draft when the key comes up', async () => {
    const bench = setup()
    holdPushToTalk()
    expect(bench.live.count).toBe(1)
    bench.live.listening()
    bench.live.frame('open the file')
    await act(async () => { releasePushToTalk() })
    await vi.waitFor(() => { expect(bench.submit).toHaveBeenCalledTimes(1) })
    expect(bench.draft()).toBe('open file.js')
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
  })

  it('ends the utterance when the modifier comes up first', async () => {
    const bench = setup()
    holdPushToTalk()
    bench.live.listening()
    bench.live.frame('open the file')
    await act(async () => { fireEvent.keyUp(document, { key: 'Alt', altKey: false }) })
    await vi.waitFor(() => { expect(bench.submit).toHaveBeenCalledTimes(1) })
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
  })

  it('leaves the draft unsent when auto-send is off', async () => {
    const bench = setup(undefined, '', true, { autoSend: false })
    holdPushToTalk()
    bench.live.listening()
    bench.live.frame('open the file')
    await act(async () => { releasePushToTalk() })
    await vi.waitFor(() => { expect(bench.draft()).toBe('open file.js') })
    expect(bench.submit).not.toHaveBeenCalled()
  })

  it('ignores the chord while a click-started utterance runs, and sends on release', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('open the file')
    holdPushToTalk()
    expect(bench.live.count).toBe(1)
    await act(async () => { releasePushToTalk() })
    await vi.waitFor(() => { expect(bench.submit).toHaveBeenCalledTimes(1) })
  })

  it('does nothing when the gesture is disabled', () => {
    const bench = setup(undefined, '', true, { pushToTalkSpec: '', pushToTalk: undefined })
    holdPushToTalk()
    expect(bench.live.count).toBe(0)
  })

  it('ignores a chord that does not match the binding', () => {
    const bench = setup()
    fireEvent.keyDown(document, { key: 'v' })
    fireEvent.keyDown(document, { key: 'b', altKey: true })
    expect(bench.live.count).toBe(0)
  })

  it('ignores the key repeat a held chord produces', () => {
    const bench = setup()
    fireEvent.keyDown(document, { key: 'v', altKey: true })
    fireEvent.keyDown(document, { key: 'v', altKey: true, repeat: true })
    expect(bench.live.count).toBe(1)
  })

  it('ignores a release that follows no press', async () => {
    const bench = setup()
    releasePushToTalk()
    expect(bench.live.count).toBe(0)
    expect(bench.live.stopped).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
  })

  it('does not stop an utterance the user ended before releasing the chord', async () => {
    const bench = setup()
    holdPushToTalk()
    bench.live.listening()
    bench.live.frame('open the file')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(bench.draft()).toBe('open file.js') })
    fireEvent.keyUp(document, { key: 'v', altKey: true })
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
  })
})

describe('silence stop', () => {
  it('ends a hands-free utterance and sends it after the configured quiet', async () => {
    vi.useFakeTimers()
    const bench = setup(undefined, '', true, { silenceMs: 1500 })
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('open the file')
    bench.live.level(0.2)
    bench.live.level(0)
    await act(async () => { vi.advanceTimersByTime(1500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(bench.submit).toHaveBeenCalledTimes(1) })
    expect(bench.draft()).toBe('open file.js')
  })

  it('keeps listening while the speaker has not started talking', async () => {
    vi.useFakeTimers()
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.level(0)
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(bench.live.stopped).not.toHaveBeenCalled()
    expect(label()).toBe(zh['control.listening'])
  })

  it('keeps listening when the silence window is disabled', async () => {
    vi.useFakeTimers()
    const bench = setup(undefined, '', true, { silenceMs: 0 })
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.level(0.2)
    bench.live.level(0)
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(bench.live.stopped).not.toHaveBeenCalled()
  })

  it('waits for the speaker to finish rather than cutting them off', async () => {
    vi.useFakeTimers()
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.level(0.2)
    await act(async () => { vi.advanceTimersByTime(1000) })
    bench.live.level(0.3)
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(bench.live.stopped).not.toHaveBeenCalled()
    bench.live.level(0)
    await act(async () => { vi.advanceTimersByTime(1500) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
  })
})

describe('spoken send', () => {
  it('strips the trailing phrase and sends the draft', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('open the file send it')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(bench.submit).toHaveBeenCalledTimes(1) })
    expect(bench.draft()).toBe('open file.js')
    expect(bench.polish).toHaveBeenCalledWith('open the file')
  })

  it('keeps the phrase as words when spoken send is off', async () => {
    const answer = vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'open the file send it', status: 'ok' }))
    const bench = setup(answer, '', true, { spokenSend: false })
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('open the file send it')
    await act(async () => { fireEvent.click(seat()) })
    await vi.waitFor(() => { expect(answer).toHaveBeenCalledWith('open the file send it') })
    expect(bench.submit).not.toHaveBeenCalled()
  })

  it('sends nothing when the phrase was the whole utterance', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('send')
    await act(async () => { fireEvent.click(seat()) })
    await act(async () => { await Promise.resolve() })
    expect(bench.polish).not.toHaveBeenCalled()
    expect(bench.submit).not.toHaveBeenCalled()
    expect(bench.draft()).toBe('')
  })
})

describe('level meter', () => {
  it('reports the utterance lifecycle and every captured level', () => {
    const bench = setup()
    fireEvent.click(seat())
    expect(bench.listeningReports).toEqual([true])
    bench.live.level(0.2)
    bench.live.level(0.05)
    expect(bench.levels).toEqual([0.2, 0.05])
    fireEvent.click(seat())
    expect(bench.listeningReports).toEqual([true, false])
  })

  it('stops reporting levels once the seat unmounts', () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.level(0.2)
    cleanup()
    bench.live.level(0.4)
    expect(bench.listeningReports).toEqual([true, false])
    expect(bench.levels).toEqual([0.2])
  })
})

describe('live dictation edges', () => {
  it('shows cleanup with no fault when the link reports nothing to say', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.answer = { text: '', status: 'ok' }
    await act(async () => { fireEvent.click(seat()) })
    await act(async () => { await Promise.resolve() })
    expect(bench.live.stopped).toHaveBeenCalledTimes(1)
    expect(bench.draft()).toBe('')
    expect(label()).toBe(zh['control.idle'])
  })

  it('takes the transcript back on a stop that lands while the link warms', async () => {
    const bench = setup(vi.fn(async (_text: string): Promise<PolishPass> => ({ text: 'Open file.js.', status: 'ok' })))
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('um open file dot j s')
    await act(async () => { fireEvent.click(seat()) })
    await act(async () => { await Promise.resolve() })
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 20, 'Open file.js.'])

    // The retry stops before the link has handed its handle over; the seat
    // still withdraws what the previous attempt wrote.
    fireEvent.click(seat())
    fireEvent.click(seat())
    expect(bench.replaceRange.mock.calls.at(-1)).toEqual([0, 13, ''])
  })

  it('drops a settled utterance that arrives after unmount', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    bench.live.frame('open the file')
    // The stop settles on a microtask, so the seat is gone before the pass it
    // assembled reaches the pipeline.
    fireEvent.click(seat())
    cleanup()
    await act(async () => { await Promise.resolve() })
    expect(bench.polish).not.toHaveBeenCalled()
    expect(bench.submit).not.toHaveBeenCalled()
  })

  it('drops a transcript frame that arrives after unmount', async () => {
    const bench = setup()
    fireEvent.click(seat())
    bench.live.listening()
    cleanup()
    bench.live.frame('nobody is listening')
    expect(bench.replaceRange).not.toHaveBeenCalled()
  })

  it('drops a second listening report that arrives after unmount', async () => {
    const bench = setup()
    fireEvent.click(seat())
    cleanup()
    bench.live.listening()
    expect(bench.replaceRange).not.toHaveBeenCalled()
  })
})
