/**
 * Controllable stand-in for the browser's speech recognition engine, shared by
 * the recognition and control specs so both drive one engine contract.
 */
import type {
  DictationEngine, DictationEngineCtor, DictationErrorEvent, DictationResultEvent, DictationResultList,
} from '../src/client/recognition.ts'

/** One recognized entry the specs seed a result event with. */
export interface StubEntry {
  readonly transcript: string
  readonly isFinal: boolean
}

/** Records the lifecycle calls each session makes on it. */
export class StubEngine implements DictationEngine {
  static created: StubEngine[] = []

  lang = ''
  continuous = false
  interimResults = true
  onresult: ((event: DictationResultEvent) => void) | null = null
  onerror: ((event: DictationErrorEvent) => void) | null = null
  onend: (() => void) | null = null
  starts = 0
  stops = 0

  constructor() {
    StubEngine.created.push(this)
  }

  start(): void {
    this.starts += 1
  }

  stop(): void {
    this.stops += 1
  }
}

/** The stub in the shape the plugin resolves from `globalThis`. */
export const stubCtor: DictationEngineCtor = StubEngine

/** Drop every engine built so far, so a spec reads only its own. */
export function resetEngines(): void {
  StubEngine.created = []
}

/**
 * The engine the last construction built.
 * @returns the most recently constructed stub.
 */
export function latestEngine(): StubEngine {
  const built = StubEngine.created.at(-1)
  if (built === undefined) throw new Error('no engine was constructed')
  return built
}

/**
 * One result event over the given entries.
 * @param resultIndex - first index the engine considers changed.
 * @param entries - recognized entries from index 0.
 * @returns the event the engine hands to `onresult`.
 */
export function resultEvent(resultIndex: number, ...entries: readonly StubEntry[]): DictationResultEvent {
  const results: DictationResultList = entries.map(entry => ({
    isFinal: entry.isFinal,
    0: { transcript: entry.transcript },
  }))
  return { resultIndex, results }
}
