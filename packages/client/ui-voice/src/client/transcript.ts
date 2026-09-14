/**
 * Transcript assembly for the live dictation seat.
 *
 * The provider reports each update as a transcript of everything it has heard
 * so far, not as a delta, and it revises its own guesses as more audio arrives.
 * Both helpers keep a later, shorter report from retracting words the speaker
 * already saw on screen, which is the one way a live preview can look like it
 * is losing the user's speech.
 * @module @deepseek-ai/dsh-client-ui-voice/client/transcript
 */

/**
 * Keep finished pieces. Never let a shorter later guess wipe a longer transcript.
 * @param prev - the transcript shown so far, possibly empty.
 * @param next - the transcript the provider just reported.
 * @returns the transcript to show.
 */
export function mergeTranscript(prev: string, next: string): string {
  const a = prev.replace(/\s+/g, ' ').trim()
  const b = next.replace(/\s+/g, ' ').trim()
  if (!b) return a
  if (!a) return b
  if (b === a || a.endsWith(b)) return a
  if (b.startsWith(a)) return b
  if (a.startsWith(b)) return a
  const max = Math.min(a.length, b.length, 48)
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  for (let n = max; n >= 4; n--) {
    if (al.slice(-n) === bl.slice(0, n)) {
      return `${a}${b.slice(n)}`.replace(/\s+/g, ' ').trim()
    }
  }
  return `${a} ${b}`.replace(/\s+/g, ' ').trim()
}

/**
 * Don't let a tiny later guess replace a sentence we already showed.
 * @param shown - the draft currently on screen.
 * @param next - the draft the provider just reported.
 * @returns the draft to show.
 */
export function chooseDraft(shown: string, next: string): string {
  const prev = shown.replace(/\s+/g, ' ').trim()
  const draft = next.replace(/\s+/g, ' ').trim()
  if (!draft) return prev
  if (!prev) return draft
  if (draft.length < prev.length * 0.6 && !prev.startsWith(draft)) return prev
  return draft
}
