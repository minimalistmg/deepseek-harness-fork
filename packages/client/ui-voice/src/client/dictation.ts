/**
 * What the speaker said, as the composer should carry it.
 *
 * A speech provider reports words, not punctuation or identifier spelling, so a
 * dictated draft otherwise reaches the model as one unpunctuated run of
 * disfluencies. The helpers here are pure string rewrites over one settled
 * transcript: verbal punctuation becomes real punctuation, spoken fillers are
 * dropped, "user id in camel case" becomes `userId`, and a trailing "send" is
 * reported to the seat instead of being inserted.
 *
 * Every rewrite is a whole-transcript operation, and the seat applies them
 * before the host polish pass, so a deployment with no polish credential still
 * gets a usable draft.
 * @module @deepseek-ai/dsh-client-ui-voice/client/dictation
 */

/**
 * Trailing phrases that ask for the transcript to be sent. Longest first, so
 * `send when done` is not read as `send` followed by leftover words.
 */
export const SEND_COMMAND_RE =
  /(?:^|\s+)(?:send\s+when\s+(?:you(?:\s+are|'re|re)\s+)?done|send\s+it|send)\s*[.!]?\s*$/i

/** One transcript with its trailing send instruction taken off. */
export interface SendCommand {
  /** The transcript without the instruction, trimmed. */
  readonly text: string
  /** Whether the speaker asked for the draft to be sent. */
  readonly send: boolean
}

/**
 * Split one spoken phrase into its identifier words, treating a written
 * separator as a word break.
 * @param phrase - the words the speaker dictated.
 * @returns the words, with empty pieces removed.
 */
export function splitWords(phrase: string): string[] {
  return phrase
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Join words as a lower camel-case identifier.
 * @param phrase - the dictated words.
 * @returns the identifier, or the trimmed phrase when it holds no word.
 */
export function toCamelCase(phrase: string): string {
  const parts = splitWords(phrase)
  if (parts.length === 0) return phrase.trim()
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase()
      if (index === 0) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/**
 * Join words as a snake-case identifier.
 * @param phrase - the dictated words.
 * @returns the identifier.
 */
export function toSnakeCase(phrase: string): string {
  return splitWords(phrase).map(part => part.toLowerCase()).join('_')
}

/**
 * Join words as a Pascal-case identifier.
 * @param phrase - the dictated words.
 * @returns the identifier.
 */
export function toPascalCase(phrase: string): string {
  return splitWords(phrase)
    .map((part) => {
      const lower = part.toLowerCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/**
 * Join words as a kebab-case identifier.
 * @param phrase - the dictated words.
 * @returns the identifier.
 */
export function toKebabCase(phrase: string): string {
  return splitWords(phrase).map(part => part.toLowerCase()).join('-')
}

/**
 * Join words as an upper-case phrase.
 * @param phrase - the dictated words.
 * @returns the phrase in capitals.
 */
export function toAllCaps(phrase: string): string {
  return splitWords(phrase).map(part => part.toUpperCase()).join(' ')
}

/** One spoken cue and the rewrite it applies to the words before it. */
interface IdentifierRule {
  readonly re: RegExp
  readonly convert: (phrase: string) => string
}

/**
 * Cue order fixes both the accepted spellings and the precedence when one
 * transcript carries several cues; each rule rewrites the words it matched and
 * leaves the rest of the sentence to the rules that follow.
 */
const IDENTIFIER_RULES: readonly IdentifierRule[] = [
  { re: /\b([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+in\s+camel\s*case\b/gi, convert: toCamelCase },
  { re: /\bin\s+camel\s*case\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\b/gi, convert: toCamelCase },
  { re: /\b([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+in\s+snake\s*case\b/gi, convert: toSnakeCase },
  { re: /\bin\s+snake\s*case\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\b/gi, convert: toSnakeCase },
  { re: /\b([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+in\s+pascal\s*case\b/gi, convert: toPascalCase },
  { re: /\bin\s+pascal\s*case\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\b/gi, convert: toPascalCase },
  { re: /\b([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+in\s+kebab\s*case\b/gi, convert: toKebabCase },
  { re: /\bin\s+kebab\s*case\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\b/gi, convert: toKebabCase },
  { re: /\b([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+in\s+all\s+caps\b/gi, convert: toAllCaps },
  { re: /\ball\s+caps\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\b/gi, convert: toAllCaps },
]

/**
 * Rewrite spoken case cues into the identifiers they name. The cue converts
 * every word that can precede it, so a cue is meant for a phrase the speaker
 * names on its own.
 * @param text - one transcript, or a fragment of one.
 * @returns the text with each cue replaced by its identifier.
 */
export function applySpokenIdentifiers(text: string): string {
  let out = text
  for (const rule of IDENTIFIER_RULES) out = out.replace(rule.re, (_match, phrase: string) => rule.convert(phrase))
  return out.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Turn dictated punctuation names into their marks, with the spacing a removal
 * from the middle of a sentence leaves behind tidied away.
 * @param text - one transcript, or a fragment of one.
 * @returns the text with verbal punctuation replaced.
 */
export function applySpokenPunctuation(text: string): string {
  const marked = text
    .replace(/\bnew\s+line\b/gi, '\n')
    .replace(/\bperiod\b/gi, '.')
    .replace(/\bfull\s+stop\b/gi, '.')
    .replace(/\bcomma\b/gi, ',')
    .replace(/\bquestion\s+mark\b/gi, '?')
    .replace(/\bexclamation\s+(?:mark|point)\b/gi, '!')
    .replace(/\bcolon\b/gi, ':')
    .replace(/\bsemicolon\b/gi, ';')
  return tidy(marked)
}

/**
 * Drop spoken fillers, hedges, and word repeats, then tidy the spacing the
 * removals leave behind.
 * @param text - one transcript, or a fragment of one.
 * @returns the text without its disfluencies.
 */
export function stripFillers(text: string): string {
  let out = text
  out = out.replace(
    /\b(?:um+|uh+|erm+|ah+|hmm+|huh|like|you know|sort of|kind of|basically|actually|literally|i mean|right|okay so|ok so)\b/gi,
    ' ',
  )
  // Stutter repeats: "the the", "to to".
  out = out.replace(/(\w+)(\s+\1\b)+/gi, '$1')
  return tidy(out)
}

/**
 * Collapse the whitespace and punctuation spacing a removal can leave behind.
 * @param text - one transcript, or a fragment of one.
 * @returns the tidied text.
 */
function tidy(text: string): string {
  return text
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.,!?;:])([^\s])/g, '$1 $2')
    // Spaces a removal left around a line break would otherwise reach the
    // draft as trailing whitespace on the line above.
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Apply the whole dictation pipeline to one settled transcript: verbal
 * punctuation, fillers, then spoken identifiers.
 * @param text - the transcript the provider settled.
 * @returns the draft text to insert.
 */
export function cleanupDictation(text: string): string {
  return applySpokenIdentifiers(tidy(stripFillers(applySpokenPunctuation(text))))
}

/**
 * Take a trailing send instruction off one transcript.
 * @param text - the transcript the provider settled.
 * @returns the remaining text and whether the speaker asked to send it.
 */
export function takeSendCommand(text: string): SendCommand {
  const raw = text.trim()
  if (raw === '') return { text: '', send: false }
  if (!SEND_COMMAND_RE.test(raw)) return { text: raw, send: false }
  return { text: raw.replace(SEND_COMMAND_RE, '').trim(), send: true }
}
