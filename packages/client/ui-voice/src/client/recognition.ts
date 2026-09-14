/**
 * Web Speech API dictation over the browser's own recognition engine. The DOM
 * library this package compiles against declares neither `SpeechRecognition`
 * nor the `webkit`-prefixed alias, so the shapes this module drives are
 * declared here and the constructor is resolved from `globalThis` at call
 * time. Nothing here touches React: the control owns the session lifecycle.
 */

/** One recognition alternative; the engine ranks them best first. */
export interface DictationAlternative {
  readonly transcript: string
}

/** One recognition result; `isFinal` marks a settled chunk. */
export interface DictationResult {
  readonly isFinal: boolean
  /** Best alternative; the engine indexes alternatives numerically from 0. */
  readonly 0: DictationAlternative
}

/** The array-like result list one result event carries. */
export interface DictationResultList {
  readonly length: number
  readonly [index: number]: DictationResult
}

/** Result event: results at and after `resultIndex` may have changed. */
export interface DictationResultEvent {
  readonly resultIndex: number
  readonly results: DictationResultList
}

/** Failure event naming the engine's own code (`not-allowed`, `network`, …). */
export interface DictationErrorEvent {
  readonly error: string
}

/** The recognition engine surface this module drives. */
export interface DictationEngine {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: DictationResultEvent) => void) | null
  onerror: ((event: DictationErrorEvent) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

/** Constructor of a recognition engine. */
export type DictationEngineCtor = new () => DictationEngine

/**
 * Failure codes that end ordinary dictation instead of reporting a fault: the
 * engine reports a silent room and a user-initiated stop through this channel.
 */
const ROUTINE_ENDINGS: ReadonlySet<string> = new Set(['aborted', 'no-speech'])

/**
 * Resolve the browser's recognition constructor.
 * @returns the constructor, or undefined when this browser ships none.
 */
export function dictationEngineCtor(): DictationEngineCtor | undefined {
  const scope = globalThis as {
    SpeechRecognition?: DictationEngineCtor
    webkitSpeechRecognition?: DictationEngineCtor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition
}

/** Callbacks one dictation session reports through. */
export interface DictationHandlers {
  /**
   * One settled chunk of recognized text, in recognition order.
   * @param text - the chunk to append to the draft.
   */
  onFinal(text: string): void
  /** The engine stopped; no further callback arrives for this session. */
  onEnd(): void
  /**
   * A fault worth showing the user.
   * @param reason - the engine's own failure code.
   */
  onError(reason: string): void
}

/** Handle on one running dictation session. */
export interface DictationSession {
  /** Ask the engine to stop; this session's `onEnd` follows. */
  stop(): void
}

/**
 * The language the engine is asked to recognize.
 * @returns the browser's own UI language, or `en-US` when it names none.
 */
function recognitionLanguage(): string {
  const tag = navigator.language
  return tag === '' ? 'en-US' : tag
}

/**
 * Start one dictation session on a fresh engine. Recognition is continuous
 * with interim results suppressed, so every reported chunk is settled text the
 * caller may append without rewriting what it already inserted.
 * @param ctor - recognition constructor resolved from the browser.
 * @param handlers - callbacks this session reports through.
 * @returns the running session's stop handle.
 */
export function startDictation(
  ctor: DictationEngineCtor,
  handlers: DictationHandlers,
): DictationSession {
  const engine = new ctor()
  engine.lang = recognitionLanguage()
  engine.continuous = true
  engine.interimResults = false
  engine.onresult = (event) => {
    const settled = Array.from(event.results).slice(event.resultIndex)
    for (const result of settled) {
      if (!result.isFinal) continue
      const transcript = result[0].transcript
      if (transcript !== '') handlers.onFinal(transcript)
    }
  }
  engine.onerror = (event) => {
    if (ROUTINE_ENDINGS.has(event.error)) return
    handlers.onError(event.error)
  }
  engine.onend = () => { handlers.onEnd() }
  engine.start()
  return { stop: () => { engine.stop() } }
}
