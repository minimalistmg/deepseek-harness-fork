/**
 * Google Gemini text-model polish for dictated transcripts. The provider owns
 * its own HTTP call and credential resolution; every failure — a missing key, a
 * refused request, a rate limit, a deadline, a malformed body — returns the
 * submitted text unchanged so dictation never loses the speaker's words.
 * @module @deepseek-ai/dsh-client-ui-voice/polish
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Default credential reference when configuration names none. */
export const DEFAULT_GEMINI_API_KEY_ENV = 'GEMINI_API_KEY'

/** Default Google Generative Language endpoint origin when configuration names none. */
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

/** Default Gemini model that polishes a transcript when configuration names none. */
export const DEFAULT_GEMINI_POLISH_MODEL = 'gemini-3.6-flash'

/**
 * Default upper bound on generated tokens. `gemini-3.6-flash` is a thinking
 * model and its thinking tokens count against this cap, so a length-derived
 * budget sized for the answer alone truncates the answer; configuration raises
 * this when a deployment needs more room.
 */
export const DEFAULT_VOICE_POLISH_MAX_OUTPUT_TOKENS = 2048

/** Default deadline for one polish request, in milliseconds. */
export const DEFAULT_VOICE_POLISH_TIMEOUT_MS = 8000

/** Default sampling temperature: low enough to preserve the speaker's wording. */
export const DEFAULT_VOICE_POLISH_TEMPERATURE = 0.2

/** Timeout code stamped onto this provider's deadline and read back on abort. */
export const VOICE_POLISH_TIMEOUT_CODE = 'VOICE_POLISH_TIMEOUT'

/** Versioned path segment naming one model's `generateContent` method. */
const GENERATE_CONTENT_PATH = ':generateContent'

/** Path segment prefixing the configured model id. */
const MODEL_PATH_PREFIX = '/v1beta/models/'

/** Request header carrying the API key, so the secret never reaches the URL. */
const API_KEY_HEADER = 'x-goog-api-key'

/** Credit meter that refills over time; the common failure for a dictating user. */
const RATE_LIMITED_STATUS = 429

/** Instruction sent as the model's system turn, verbatim. */
export const VOICE_POLISH_PROMPT = 'You clean short voice transcripts that will be sent to a coding AI agent. '
  + 'Goals, in order: 1) Fix spelling, capitalization, and light grammar. 2) Light coding cleanup: keep identifiers, '
  + 'paths, commands, and JSON/code fragments intact; fix obvious spoken artifacts (e.g. "dot j s" → ".js", "slash" '
  + 'in paths) only when clear. 3) Tighten into a clear actionable request when the speaker was rambling, without '
  + 'adding new requirements, files, libraries, or steps they did not say. 4) If something critical is ambiguous, '
  + 'keep their words and append a short note like "(unclear: …)" — do not invent details. Rules: same language as '
  + 'input; no markdown fences unless the user dictated code; no preamble, labels, or quotes around the whole '
  + 'answer; return only the final draft. If the text needs no changes, return it unchanged.'

/** One candidate text part in a `generateContent` response. */
interface GeminiPart {
  readonly text?: unknown
}

/** One generated candidate; the first carries the answer. */
interface GeminiCandidate {
  readonly content?: { readonly parts?: readonly GeminiPart[] } | null
}

/** Parsed `generateContent` response body. */
interface GeminiGenerateContentResponse {
  readonly candidates?: readonly GeminiCandidate[]
}

/** The system instruction block the request carries. */
interface GeminiSystemInstruction {
  readonly parts: readonly [{ readonly text: string }]
}

/** The single user turn the request carries. */
interface GeminiContent {
  readonly role: 'user'
  readonly parts: readonly [{ readonly text: string }]
}

/** Generation bounds the request carries. */
interface GeminiGenerationConfig {
  readonly temperature: number
  readonly maxOutputTokens: number
}

/** Exact request body sent to `generateContent`. */
interface GeminiGenerateContentRequest {
  readonly systemInstruction: GeminiSystemInstruction
  readonly contents: readonly [GeminiContent]
  readonly generationConfig: GeminiGenerationConfig
}

/**
 * Resolved provider options. The plugin wires every field, so the provider
 * never applies a second default of its own.
 */
export interface VoicePolishProviderOptions {
  /** Endpoint origin; the versioned `generateContent` path is appended. */
  readonly baseURL: string
  /** Gemini model id; the request path carries it after `models/`. */
  readonly model: string
  /** Instruction sent as the model's system turn. */
  readonly prompt: string
  /** Upper bound on generated tokens, thinking tokens included. */
  readonly maxOutputTokens: number
  /** Sampling temperature the request carries. */
  readonly temperature: number
  /** Deadline for one request, in milliseconds. */
  readonly timeoutMs: number
  /** Credential reference named by missing-key diagnostics. */
  readonly apiKeyEnv: CredentialRef
  /**
   * Resolve the current API key for one polish. Absent when the plugin holds no
   * credential plane at all, which always reads as "unavailable".
   * @returns the resolved key, or `undefined` when no layer supplies one.
   */
  readonly resolveApiKey?: () => Promise<string | undefined>
}

/**
 * How one polish attempt settled. Every non-`'ok'` member keeps the submitted
 * text; they differ only in what the composer seat tells the user.
 */
export type VoicePolishOutcome =
  /** Cleaned text came back. */
  | 'ok'
  /** No API key resolved, so nothing was sent. */
  | 'unavailable'
  /** The provider refused the request for quota. */
  | 'rate-limited'
  /** The deadline elapsed before an answer arrived. */
  | 'timeout'
  /** Any other refusal, transport fault, or unusable body. */
  | 'failed'

/** What one attempt produced: an outcome, plus text only on `'ok'`. */
export interface VoicePolishResult {
  /** How the attempt settled. */
  readonly outcome: VoicePolishOutcome
  /** Cleaned text on `'ok'`; the submitted input unchanged otherwise. */
  readonly text: string
}

/**
 * The Gemini-backed transcript polisher. One instance serves the plugin; each
 * call resolves its own credential and applies its own deadline.
 */
export class VoicePolishProvider {
  /**
   * @param resolveOptions - the options for the NEXT attempt, read once at each
   * attempt's entry so one request never mixes two configuration reads.
   */
  constructor(private readonly resolveOptions: () => VoicePolishProviderOptions) {}

  /**
   * Clean one dictated transcript.
   * @param input - the raw transcript to polish.
   * @param signal - caller cancellation fused into this request's deadline.
   * @returns the cleaned text on success, otherwise the input unchanged.
   */
  async polish(input: string, signal?: AbortSignal): Promise<VoicePolishResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options)
    if (apiKey === undefined) return { outcome: 'unavailable', text: input }
    return await this.request(options, apiKey, input, signal)
  }

  /**
   * Resolve one attempt's key without retaining it on the provider.
   * @param options - this attempt's snapshot, so the key and endpoint come from one read.
   * @returns the resolved key, or `undefined` when no layer supplies one.
   */
  private async apiKey(options: VoicePolishProviderOptions): Promise<string | undefined> {
    if (options.resolveApiKey === undefined) return undefined
    const resolved = await options.resolveApiKey()
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined
  }

  private async request(
    options: VoicePolishProviderOptions,
    apiKey: string,
    input: string,
    signal?: AbortSignal,
  ): Promise<VoicePolishResult> {
    const endpoint = `${options.baseURL}${MODEL_PATH_PREFIX}${options.model}${GENERATE_CONTENT_PATH}`
    const body: GeminiGenerateContentRequest = {
      systemInstruction: { parts: [{ text: options.prompt }] },
      contents: [{ role: 'user', parts: [{ text: input }] }],
      generationConfig: {
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
      },
    }
    using d = deadline(signal, options.timeoutMs, VOICE_POLISH_TIMEOUT_CODE)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        // A credentialed provider request must not follow a redirect to another origin.
        redirect: 'error',
        headers: {
          [API_KEY_HEADER]: apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: d.signal,
      })
    } catch {
      return { outcome: outcomeOfFailure(d.signal), text: input }
    }
    if (!response.ok) {
      return { outcome: outcomeOfStatus(response.status), text: input }
    }
    let payload: GeminiGenerateContentResponse
    try {
      payload = await response.json() as GeminiGenerateContentResponse
    } catch {
      return { outcome: outcomeOfFailure(d.signal), text: input }
    }
    const polished = cleanPolishedText(payload)
    return polished === undefined
      ? { outcome: 'failed', text: input }
      : { outcome: 'ok', text: polished }
  }
}

/**
 * Map a thrown transport or body failure onto an outcome. The deadline signal
 * decides the only distinction that changes what the seat reports: our own
 * {@link TimeoutReason} means the deadline elapsed, while every other throw —
 * caller cancellation, a refused connection, an unreadable body — is one
 * transport-class failure, and all of them keep the raw transcript.
 * @param signal - this request's fused deadline signal.
 * @returns `'timeout'` when this request's own deadline elapsed, otherwise `'failed'`.
 */
function outcomeOfFailure(signal: AbortSignal): VoicePolishOutcome {
  return timeoutOf(signal, VOICE_POLISH_TIMEOUT_CODE) === undefined ? 'failed' : 'timeout'
}

/**
 * Map a response status onto an outcome.
 * @param status - the HTTP status the provider answered with.
 * @returns `'rate-limited'` for the quota status, otherwise `'failed'`.
 */
function outcomeOfStatus(status: number): VoicePolishOutcome {
  return status === RATE_LIMITED_STATUS ? 'rate-limited' : 'failed'
}

/**
 * Join every candidate text part of the first candidate.
 * @param payload - the parsed `generateContent` body.
 * @returns the joined text, or `undefined` when no part carries any.
 */
export function candidateText(payload: GeminiGenerateContentResponse): string | undefined {
  const parts = payload.candidates?.[0]?.content?.parts
  if (parts === undefined) return undefined
  const joined = parts
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
  return joined === '' ? undefined : joined
}

/**
 * Read the polished text out of one response body.
 * @param payload - the parsed `generateContent` body.
 * @returns the cleaned draft, or `undefined` when the response carried none.
 */
export function cleanPolishedText(payload: GeminiGenerateContentResponse): string | undefined {
  const text = candidateText(payload)
  if (text === undefined) return undefined
  const stripped = fenceBody(text) ?? matchedPair(text, '"', '"') ?? matchedPair(text, '`', '`') ?? text
  return fenceBody(stripped) ?? stripped
}

/**
 * The body of a whole-answer fenced block.
 * @param text - the trimmed candidate text.
 * @returns the block's body, or `undefined` when the text is not one fenced block.
 */
export function fenceBody(text: string): string | undefined {
  if (!text.startsWith('```') || !text.endsWith('```') || text.length < 6) return undefined
  const firstBreak = text.indexOf('\n')
  if (firstBreak < 0) return undefined
  // Only a bare fence or one language tag counts: a fence wrapping prose is not
  // a whole-answer block, and guessing where it ends would eat real words.
  const opening = text.slice(3, firstBreak).trim()
  if (opening !== '' && !/^[A-Za-z0-9+#._-]+$/.test(opening)) return undefined
  return text.slice(firstBreak + 1, -3).trim()
}

/**
 * The body of one matching quote or backtick pair.
 * @param text - the trimmed candidate text.
 * @param open - the leading character.
 * @param close - the trailing character.
 * @returns the inner text, or `undefined` when the pair does not wrap the whole text.
 */
function matchedPair(text: string, open: string, close: string): string | undefined {
  if (text.length < 2 || !text.startsWith(open) || !text.endsWith(close)) return undefined
  const inner = text.slice(1, -1).trim()
  // A pair whose body carries the same delimiter is not a wrapping pair: a
  // fenced code answer starts and ends with backticks that belong to the fence.
  if (inner.includes(open)) return undefined
  return inner
}
