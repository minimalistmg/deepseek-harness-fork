import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PolishPass, PolishStatus } from './polish.ts'
import { micCaptureEnvironment } from './capture.ts'
import { cleanupDictation, takeSendCommand } from './dictation.ts'
import type { LiveUtterance, TranscribeRequest, VoiceLivePass, VoiceLiveStatus } from './live.ts'
import type { VoicePreferences } from './prefs.ts'
import { matchesPushToTalk, releasesPushToTalk } from './ptt.ts'
import { DEFAULT_SPEECH_LEVEL, SilenceGate } from './silence.ts'
import css from './VoiceControl.module.css'

/** The live dictation face the plugin injects into the seat. */
export interface VoiceLiveFace {
  /**
   * Start recording one utterance, streaming audio to the provider and
   * reporting each transcript frame as it arrives.
   * @param request - the seat's callbacks and the link's options.
   * @returns the running utterance.
   */
  transcribe(request: TranscribeRequest): LiveUtterance
}

/** The polish pass the plugin injects into the seat. */
export interface PolishFace {
  /**
   * Clean up one settled transcript on the host.
   * @param text - the whole transcript the live link assembled.
   * @param signal - caller cancellation; an aborted pass returns the raw text.
   * @returns the text to insert plus how the pass settled.
   */
  polish(text: string, signal?: AbortSignal): Promise<PolishPass>
}

/** The seat's business face: the live link, the polish pass, and the level meter writes. */
export interface VoiceSeatInjected {
  /** The live provider link; see {@link VoiceLiveFace}. */
  readonly live: VoiceLiveFace
  /**
   * Clean up one settled transcript on the host.
   * @param text - the whole transcript the live link assembled.
   * @param signal - caller cancellation; an aborted pass returns the raw text.
   * @returns the text to insert plus how the pass settled.
   */
  readonly polish: (text: string, signal?: AbortSignal) => Promise<PolishPass>
  /**
   * Whether the browser's own speech engine may take over when the live link
   * cannot run. Off by default: the engine this ships in carries no speech
   * service, so the fallback only ever reports a fault there.
   */
  readonly webSpeech: boolean
  /** Live push-to-talk, silence, and cleanup preferences. */
  readonly hooks: {
    readonly prefs: SnapshotStore<VoicePreferences>
  }
  /**
   * Publish one captured chunk's level to the composer's wave dock.
   * @param level - the chunk's root-mean-square level.
   */
  reportLevel(level: number): void
  /**
   * Publish that an utterance started recording.
   * @param active - whether the microphone is recording.
   */
  reportListening(active: boolean): void
}

/**
 * The composer voice seat's props: the runtime share (standard kit, including
 * the public `inputActions` face and the `useInput` snapshot, whose offsets the
 * transcript addresses its own draft range with), the injected business face,
 * and the locale seat.
 */
export type VoiceControlProps = PropsRuntime<'conversation.input.right'> & InjectFace<VoiceSeatInjected> & PropsLocale<'voice'>

/** The seat's idle or working state; a fault is carried by its own field. */
type SeatPhase = 'idle' | 'warming' | 'listening' | 'polishing'

/** A dictation fault; cleared by the retry that causes it. */
type DictationFault = 'dictation' | undefined

/** A polish fault; outlives a retry, because it describes the host's state. */
type PolishFault = 'no-polish' | 'rate-limited' | 'timeout' | 'failed' | undefined

/** Why an utterance ended, which decides whether it sends itself. */
type StopReason = 'click' | 'ptt' | 'silence' | 'unmount'

/** What the seat renders. */
export interface SeatState {
  /** Dictation and polish progress. */
  readonly phase: SeatPhase
  /** The fault dictation itself reported; wins over the polish fault on screen. */
  readonly dictation: DictationFault
  /** The fault the last polish pass reported. */
  readonly polish: PolishFault
}

/** The seat before anything has happened. */
const IDLE: SeatState = { phase: 'idle', dictation: undefined, polish: undefined }

/** What the seat left in the draft, so the next attempt rewrites exactly that. */
interface DraftRange {
  /** Offset the range starts at, in `InputState.draft` offsets. */
  readonly start: number
  /** Number of characters the range covers. */
  readonly length: number
}

/**
 * The fault a live-link failure leaves on the seat. A missing credential or a
 * missing route is the deployment's state rather than a dictation fault, so it
 * reads as "no cleanup"; every other status is a fault the user should retry.
 * @param status - how the utterance settled.
 * @returns the fault to report, or `undefined` when the link reported none.
 */
function liveFault(status: VoiceLiveStatus): PolishFault {
  if (status === 'ok') return undefined
  return status === 'unavailable' ? 'no-polish' : 'failed'
}

/**
 * The fault a polish pass puts on the seat. A clean pass clears it, because the
 * host can restore a key between two utterances.
 * @param status - how the pass settled.
 * @returns the fault to report, or `undefined` when the pass was clean.
 */
function polishFault(status: PolishStatus): PolishFault {
  if (status === 'ok') return undefined
  if (status === 'unavailable') return 'no-polish'
  if (status === 'rate-limited') return 'rate-limited'
  if (status === 'timeout') return 'timeout'
  return 'failed'
}

/**
 * The button's visible text for one seat state.
 * @param state - the seat's phase and faults.
 * @param t - this package's namespace translator.
 * @returns the localized label.
 */
export function seatLabel(state: SeatState, t: TranslateNS<'voice'>): string {
  // Progress first: an attempt the user just started is not the fault the
  // previous one left, so the button never reports a failure while it works.
  if (state.phase === 'warming') return t('control.transcribing')
  if (state.phase === 'listening') return t('control.listening')
  if (state.phase === 'polishing') return t('control.polishing')
  if (state.dictation === 'dictation' || state.polish === 'failed') return t('control.failed')
  if (state.polish === 'no-polish') return t('control.polish.off')
  if (state.polish === 'rate-limited') return t('control.polish.rate-limited')
  if (state.polish === 'timeout') return t('control.polish.timeout')
  return t('control.idle')
}

/**
 * The button's tooltip for one seat state: the visible text, plus the detail
 * sentence that explains an infrastructure fault the visible text cannot.
 * @param state - the seat's phase and faults.
 * @param t - this package's namespace translator.
 * @returns the localized tooltip.
 */
export function seatTitle(state: SeatState, t: TranslateNS<'voice'>): string {
  if (state.phase === 'warming') return t('control.transcribing.title')
  if (state.phase === 'listening') return t('control.listening.title')
  if (state.phase === 'polishing') return t('control.polishing')
  if (state.dictation === 'dictation') return t('control.failed.title')
  if (state.polish === 'rate-limited') return `${seatLabel(state, t)} ${t('control.polish.rate-limited.title')}`
  if (state.polish === 'timeout') return `${seatLabel(state, t)} ${t('control.polish.timeout.title')}`
  if (state.polish === 'no-polish') return `${seatLabel(state, t)} ${t('control.polish.off.title')}`
  if (state.polish === 'failed') return t('control.failed.title')
  return t('control.idle.title')
}

/**
 * The mic glyph. The design system ships no microphone icon, so the seat draws
 * its own, matching the inline glyphs the composer's stop and send buttons use.
 */
function MicGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        d="M8 1.25a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4a2.5 2.5 0 0 1 2.5-2.5Zm-4.25 6a.75.75 0 0 1 1.5 0 2.75 2.75 0 0 0 5.5 0 .75.75 0 0 1 1.5 0 4.25 4.25 0 0 1-3.5 4.177V13h1.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5h1.5v-1.573A4.25 4.25 0 0 1 3.75 7.25Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** Props of the seat button, shared by the interactive and disabled seats. */
interface SeatButtonProps {
  /** The state the button renders. */
  readonly state: SeatState
  /** Localized accessible name. */
  readonly label: string
  /** Localized tooltip. */
  readonly title: string
  /** Absent for the disabled seat, which has no action. */
  readonly onToggle?: () => void
  /** The button's glyph. */
  readonly children: ReactNode
}

/** The seat button: one control, interactive while dictation is available. */
function SeatButton({ state, label, title, onToggle, children }: SeatButtonProps) {
  const classes = state.phase === 'listening' ? `${css.voice} ${css.listening}` : css.voice
  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={state.phase === 'listening'}
      title={title}
      disabled={onToggle === undefined}
      // The transcript lands at the editor selection, so the click must not
      // move focus (or the caret) out of the composer.
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={onToggle}
    >
      {children}
    </button>
  )
}

/** What one utterance needs from the seat when it ends. */
interface UtterancePlan {
  /** The preferences in force when the utterance started. */
  readonly prefs: VoicePreferences
}

/** The push-to-talk entry points the key listener calls, republished per render. */
interface GestureEntry {
  /** Start an utterance, or leave the running one alone. */
  start(): void
  /**
   * End the running utterance.
   * @param reason - the gesture that ended it.
   */
  stop(reason: StopReason): void
}

/**
 * Dictation over one live utterance at a time.
 *
 * The seat addresses the draft through the offsets it read from `useInput`, so
 * every preview update rewrites exactly the range this attempt wrote: a
 * whole-draft write would clear the root and discard the reference chips already
 * in the draft. `replaceRange` refuses an offset the user's own typing moved or
 * that no longer exists, and the seat then appends at the caret, so a preview
 * never deletes text the speaker never dictated and never loses words either.
 *
 * An utterance ends from one of four gestures — the button, the push-to-talk
 * release, the silence gate, or unmount — and the gesture decides whether the
 * settled draft sends itself.
 */
function DictationToggle({
  inputActions, useInput, usePrefs, live, polish, webSpeech, reportLevel, reportListening, t,
}: VoiceControlProps) {
  const [seat, setSeat] = useState<SeatState>(IDLE)
  const prefs = usePrefs(value => value)
  // Read, never subscribed: the draft length is the append offset, and reading
  // it at the moment of the write keeps this seat out of the render path for
  // every keystroke the user types while dictating.
  const draftLength = useInput(state => state.draft.length)
  const draftLengthRef = useRef(draftLength)
  draftLengthRef.current = draftLength
  const aliveRef = useRef(true)
  const rangeRef = useRef<DraftRange | undefined>(undefined)
  const pendingRef = useRef<DraftRange | undefined>(undefined)
  const runningRef = useRef(0)
  const utteranceRef = useRef<LiveUtterance | null>(null)
  const gateRef = useRef<SilenceGate | undefined>(undefined)
  const planRef = useRef<UtterancePlan | undefined>(undefined)
  const cancelRef = useRef<AbortController | undefined>(undefined)
  const pttRef = useRef(false)
  // The key listener binds once per binding and calls through this ref, so a
  // render mid-utterance never re-registers a capture listener. It is absent
  // until the first render publishes the current closures.
  const gestureRef = useRef<GestureEntry | undefined>(undefined)
  // The injected meter callbacks are re-read per render; the capture listeners
  // and the unmount teardown keep no dependency on their identity.
  const reportRef = useRef({ reportLevel, reportListening })

  useEffect(() => {
    aliveRef.current = true
    return () => {
      // A seat replaced or navigated away from has nowhere to put the text and
      // nobody to report to; cancelling the utterance is what stops its
      // microphone, so an unmounted seat never leaves one recording.
      aliveRef.current = false
      utteranceRef.current = null
      rangeRef.current = undefined
      pendingRef.current = undefined
      gateRef.current?.reset()
      gateRef.current = undefined
      reportRef.current.reportListening(false)
      cancelRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    const binding = prefs.pushToTalk
    if (binding === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || !matchesPushToTalk(event, binding)) return
      event.preventDefault()
      pttRef.current = true
      if (utteranceRef.current === null) gestureRef.current?.start()
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!pttRef.current || !releasesPushToTalk(event, binding)) return
      event.preventDefault()
      pttRef.current = false
      if (utteranceRef.current !== null) gestureRef.current?.stop('ptt')
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('keyup', onKeyUp, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
    }
  }, [prefs.pushToTalk])

  /**
   * Show one transcript update, rewriting the range this attempt wrote.
   * @param text - the whole transcript so far.
   */
  const show = (text: string): void => {
    const range = rangeRef.current
    if (range !== undefined && inputActions.replaceRange(range.start, range.start + range.length, text)) {
      rangeRef.current = { start: range.start, length: text.length }
      return
    }
    // The first update of an utterance, or one whose range the user's own
    // editing moved: append at the end of the draft, which is where a
    // transcript belongs and the one offset this seat can address exactly.
    const start = draftLengthRef.current
    inputActions.replaceRange(start, start, text)
    rangeRef.current = { start, length: text.length }
  }

  /** Take back the range the previous attempt wrote. */
  const withdraw = (): void => {
    const pending = pendingRef.current
    pendingRef.current = undefined
    rangeRef.current = undefined
    if (pending === undefined) return
    inputActions.replaceRange(pending.start, pending.start + pending.length, '')
  }

  /**
   * Take back the preview this attempt wrote when nothing of it survives — a
   * transcript that was nothing but a send instruction, or one the pipeline
   * emptied. The range is refused, not adjusted, when the user's own editing
   * moved it, so text the speaker never dictated is never deleted.
   */
  const clearPreview = (): void => {
    const range = rangeRef.current
    rangeRef.current = undefined
    pendingRef.current = undefined
    if (range === undefined) return
    inputActions.replaceRange(range.start, range.start + range.length, '')
  }

  /**
   * One finished utterance: apply the dictation pipeline, clean the whole
   * transcript on the host, then leave exactly the cleaned paragraph in the
   * draft and send it when the gesture asked for that.
   * @param pass - the transcript the utterance assembled and how it settled.
   * @param reason - the gesture that ended the utterance.
   * @param plan - the preferences the utterance started under.
   */
  const finish = (pass: VoiceLivePass, reason: StopReason, plan: UtterancePlan): void => {
    const fault = liveFault(pass.status)
    const instruction = plan.prefs.spokenSend ? takeSendCommand(pass.text) : { text: pass.text, send: false }
    const dictated = plan.prefs.cleanup ? cleanupDictation(instruction.text) : instruction.text.trim()
    const body = dictated.trim()
    if (body === '') {
      // Nothing of this utterance survives the pipeline (a bare "send", or a
      // transcript that was only fillers): the preview goes with it, so the
      // draft reads as it did before the attempt.
      clearPreview()
      setSeat(current => ({ ...current, phase: 'idle', polish: fault ?? current.polish }))
      return
    }
    const auto = instruction.send || (plan.prefs.autoSend && (reason === 'ptt' || reason === 'silence'))
    runningRef.current += 1
    setSeat(current => ({ ...current, phase: 'polishing' }))
    void polish(body).then((cleaned) => {
      runningRef.current -= 1
      if (!aliveRef.current) return
      show(cleaned.text)
      pendingRef.current = rangeRef.current
      rangeRef.current = undefined
      /* v8 ignore next 4 -- finish() is the only pass adding to this count. */
      setSeat(current => ({
        ...current,
        phase: runningRef.current > 0 ? 'polishing' : 'idle',
        polish: fault ?? polishFault(cleaned.status),
      }))
      // The draft carries the transcript by now: `show` writes synchronously,
      // and the submit machine reads the editor when it enters submission.
      if (auto) inputActions.submit()
    })
  }

  /**
   * Stop the running utterance and settle what it heard.
   * @param reason - the gesture that ended it.
   */
  const stop = (reason: StopReason): void => {
    const utterance = utteranceRef.current
    const plan = planRef.current
    // Every caller stops an utterance start() created, and start() is the only
    // writer of both refs, so this arm guards against a stop that arrives with
    // nothing running rather than a state the seat can reach.
    /* v8 ignore next -- no caller stops an utterance it did not start. */
    if (utterance === null || plan === undefined) return
    utteranceRef.current = null
    planRef.current = undefined
    gateRef.current?.reset()
    gateRef.current = undefined
    pttRef.current = reason === 'ptt' ? false : pttRef.current
    reportRef.current.reportListening(false)
    setSeat(current => ({ ...current, phase: 'polishing' }))
    void utterance.stop().then((pass) => {
      if (!aliveRef.current) return
      finish(pass, reason, plan)
    })
  }

  /** Start one utterance on the live link. */
  const start = (): void => {
    // The previous attempt inserted text the link misheard: withdraw it and
    // retry, rather than appending a second copy of the same words.
    withdraw()
    const plan: UtterancePlan = { prefs }
    planRef.current = plan
    const cancel = new AbortController()
    cancelRef.current = cancel
    reportRef.current.reportListening(true)
    setSeat(current => ({ ...current, phase: 'warming', dictation: undefined }))
    utteranceRef.current = live.transcribe({
      handlers: {
        onTranscript: (text, settled) => {
          void settled
          if (!aliveRef.current) return
          show(text)
        },
        onListening: () => {
          if (!aliveRef.current) return
          /* v8 ignore next -- the seat reports listening only from the warming phase. */
          setSeat(current => (current.phase === 'warming' ? { ...current, phase: 'listening' } : current))
        },
        onLevel: (level) => {
          if (!aliveRef.current) return
          reportRef.current.reportLevel(level)
          gateRef.current?.observe(level)
        },
      },
      webSpeech,
      signal: cancel.signal,
    })
    // A hands-free utterance ends itself once the speaker has been quiet long
    // enough after speaking; the gate only reports that state.
    if (prefs.silenceMs > 0) {
      gateRef.current = new SilenceGate({
        level: DEFAULT_SPEECH_LEVEL,
        quietMs: prefs.silenceMs,
        onSilence: () => { stop('silence') },
      })
    }
  }

  // The gesture entry points and the meter callbacks are re-published per
  // render, so the key listener added once always calls the current closures.
  useEffect(() => {
    reportRef.current = { reportLevel, reportListening }
    gestureRef.current = {
      start: () => { start() },
      stop: (reason: StopReason) => { stop(reason) },
    }
  })

  const toggle = (): void => {
    if (utteranceRef.current !== null) {
      stop('click')
      return
    }
    start()
  }

  return (
    <SeatButton
      state={seat}
      label={seatLabel(seat, t)}
      title={seatTitle(seat, t)}
      onToggle={toggle}
    >
      <MicGlyph />
    </SeatButton>
  )
}

/**
 * The composer's voice seat: a disabled microphone when this deployment can
 * dictate through no engine at all, otherwise the toggle. Placement is the
 * owner's — this package only fills `conversation.input.right`.
 */
export function VoiceControl(props: VoiceControlProps) {
  // Lazy initializer: the capture capability is read once per mount, not per render.
  const [supported] = useState(() => props.webSpeech || micCaptureEnvironment() !== undefined)
  if (!supported) {
    const unsupported = props.t('control.unsupported')
    return (
      <SeatButton state={IDLE} label={unsupported} title={unsupported}>
        <MicGlyph />
      </SeatButton>
    )
  }
  return <DictationToggle {...props} />
}
