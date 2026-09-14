/**
 * Voice control plugin, node half. It owns the Gemini credential and the two
 * provider calls the browser half cannot make itself: the composer's mic seat
 * streams microphone audio to this plugin's live route and reads transcript
 * frames back down the same request, then posts the settled transcript to the
 * polish route and inserts the cleaned paragraph.
 *
 * Both routes register on the same Connection fetch registry — one streaming
 * and one buffered — so one transport serves dictation end to end.
 * @module @deepseek-ai/dsh-client-ui-voice
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { VOICE_SETTINGS_NAMESPACE, VoiceSettingsSchema } from './voice-settings.ts'
import { handleVoiceLiveHttp } from './live-route.ts'
import { VoiceLiveSession } from './live-session.ts'
import { VOICE_LIVE_PATH } from './live-protocol.ts'
import { handleVoicePolishHttp } from './http-route.ts'
import {
  DEFAULT_GEMINI_API_KEY_ENV,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_POLISH_MODEL,
  DEFAULT_VOICE_POLISH_MAX_OUTPUT_TOKENS,
  DEFAULT_VOICE_POLISH_TEMPERATURE,
  DEFAULT_VOICE_POLISH_TIMEOUT_MS,
  VOICE_POLISH_PROMPT,
  VoicePolishProvider,
} from './polish.ts'
import type { VoicePolishProviderOptions } from './polish.ts'
import {
  DEFAULT_VOICE_LIVE_CLOSE_TIMEOUT_MS,
  DEFAULT_VOICE_LIVE_CONNECT_TIMEOUT_MS,
  DEFAULT_VOICE_LIVE_FLUSH_WINDOW_MS,
  DEFAULT_VOICE_LIVE_IDLE_TIMEOUT_MS,
  DEFAULT_VOICE_LIVE_MAX_UTTERANCE_BYTES,
  DEFAULT_VOICE_LIVE_MODEL,
  DEFAULT_VOICE_LIVE_SETTLE_MS,
  DEFAULT_VOICE_WEB_SPEECH_ENABLED,
} from './live-config.ts'
import { VOICE_POLISH_PATH } from './protocol.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ui-voice'

/** The transport seam this plugin registers its routes on. */
export const inject = ['connection']

/** Plugin config (every field optional — the schema supplies the defaults). */
export interface Config {
  /** Credential reference resolved for each utterance. Defaults to `GEMINI_API_KEY`. */
  apiKeyEnv?: string
  /** Generative Language endpoint origin; the versioned method paths are appended. */
  baseURL?: string
  /** Gemini model id that polishes a transcript. Defaults to `gemini-3.6-flash`. */
  polishModel?: string
  /** Gemini Live model id that transcribes speech. Defaults to `gemini-3.5-transcribe-live`. */
  liveModel?: string
  /** Whether transcripts are polished at all. Defaults to `true`. */
  polishEnabled?: boolean
  /** Whether the browser may fall back to its own speech engine. Defaults to `false`. */
  webSpeechEnabled?: boolean
  /** Instruction sent as the polish model's system turn. Defaults to the shipped cleanup prompt. */
  polishPrompt?: string
  /**
   * Upper bound on generated tokens for one polish. Defaults to 2048. The
   * configured model is a thinking model and its thinking tokens count against
   * this cap, so the default leaves headroom for them instead of sizing the
   * budget from the transcript length.
   */
  maxOutputTokens?: number
  /** Deadline for one polish request in milliseconds. Defaults to 8000. */
  timeoutMs?: number
  /**
   * How long to keep receiving transcript frames after the microphone stops,
   * in milliseconds. Defaults to 1000. The provider settles its last
   * transcripts after the audio ends, so closing at `audioStreamEnd` loses the
   * speaker's final words.
   */
  flushWindowMs?: number
  /**
   * How long a warm provider socket may sit unused before it is dropped, in
   * milliseconds. Defaults to 480000 (8 minutes). Dropping it releases the
   * provider session instead of holding an idle one open indefinitely.
   */
  idleTimeoutMs?: number
  /**
   * Quiet period between the last transcript frame and the polish request, in
   * milliseconds. Defaults to 220, matching the delay a fast speaker's trailing
   * final needs to arrive.
   */
  settleMs?: number
  /** Deadline for the provider socket's connect and setup handshake, in milliseconds. Defaults to 10000. */
  connectTimeoutMs?: number
  /** Deadline for one graceful provider socket close, in milliseconds. Defaults to 2000. */
  closeTimeoutMs?: number
  /** Cap on decoded audio one utterance may carry, in bytes. Defaults to 8388608 (8 MiB, about 4 minutes at 16 kHz mono). */
  maxUtteranceBytes?: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_GEMINI_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().default(DEFAULT_GEMINI_BASE_URL),
  polishModel: z.string().default(DEFAULT_GEMINI_POLISH_MODEL),
  liveModel: z.string().default(DEFAULT_VOICE_LIVE_MODEL),
  polishEnabled: z.boolean().default(true),
  webSpeechEnabled: z.boolean().default(DEFAULT_VOICE_WEB_SPEECH_ENABLED),
  polishPrompt: z.string().default(VOICE_POLISH_PROMPT),
  maxOutputTokens: z.number().step(1).min(1).default(DEFAULT_VOICE_POLISH_MAX_OUTPUT_TOKENS),
  timeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VOICE_POLISH_TIMEOUT_MS),
  flushWindowMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VOICE_LIVE_FLUSH_WINDOW_MS),
  idleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VOICE_LIVE_IDLE_TIMEOUT_MS),
  settleMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VOICE_LIVE_SETTLE_MS),
  connectTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VOICE_LIVE_CONNECT_TIMEOUT_MS),
  closeTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_VOICE_LIVE_CLOSE_TIMEOUT_MS),
  maxUtteranceBytes: z.number().step(1).min(1).default(DEFAULT_VOICE_LIVE_MAX_UTTERANCE_BYTES),
})

/**
 * Resolve the credential reference and the environment plane one plugin
 * instance reads, so every request resolves the key again rather than caching
 * one: a stored key reaches the next utterance without a reload.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param apiKeyEnv - configured credential reference.
 * @returns the reference and the resolver both provider calls share.
 */
function credentialPlane(
  ctx: Context,
  apiKeyEnv: ReturnType<typeof credentialRef>,
): () => Promise<string | undefined> {
  return async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
    const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/**
 * Project one resolved configuration section into the polish provider's
 * options. Every default lives here rather than in the request path, so one
 * polish reads one fully resolved option set.
 * @param config - the currently authoritative section.
 * @param resolveApiKey - credential resolver for this plugin instance.
 * @returns options for the next polish.
 */
function resolvePolishOptions(
  config: Config,
  resolveApiKey: () => Promise<string | undefined>,
): VoicePolishProviderOptions {
  return {
    baseURL: config.baseURL ?? DEFAULT_GEMINI_BASE_URL,
    model: config.polishModel ?? DEFAULT_GEMINI_POLISH_MODEL,
    prompt: config.polishPrompt ?? VOICE_POLISH_PROMPT,
    maxOutputTokens: config.maxOutputTokens ?? DEFAULT_VOICE_POLISH_MAX_OUTPUT_TOKENS,
    temperature: DEFAULT_VOICE_POLISH_TEMPERATURE,
    timeoutMs: config.timeoutMs ?? DEFAULT_VOICE_POLISH_TIMEOUT_MS,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_GEMINI_API_KEY_ENV),
    resolveApiKey,
  }
}

/**
 * Register the live stream route and the polish route. Disabling polish still
 * registers the polish route: the browser then reads the identity outcome it
 * already handles, instead of losing the dictation seat to a missing route.
 * @param ctx - Host plugin context carrying the Connection service.
 * @param config - resolved plugin config; the Loader supplies schema defaults,
 * hand-built contexts may pass none.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = config ?? {}
  const apiKeyEnv = credentialRef(resolved.apiKeyEnv ?? DEFAULT_GEMINI_API_KEY_ENV)
  const resolveApiKey = credentialPlane(ctx, apiKeyEnv)
  // One live session per plugin instance: it owns the warm provider socket, so
  // two sessions would open two sockets for one composer.
  const session = new VoiceLiveSession({
    baseURL: resolved.baseURL ?? DEFAULT_GEMINI_BASE_URL,
    model: resolved.liveModel ?? DEFAULT_VOICE_LIVE_MODEL,
    flushWindowMs: resolved.flushWindowMs ?? DEFAULT_VOICE_LIVE_FLUSH_WINDOW_MS,
    idleTimeoutMs: resolved.idleTimeoutMs ?? DEFAULT_VOICE_LIVE_IDLE_TIMEOUT_MS,
    connectTimeoutMs: resolved.connectTimeoutMs ?? DEFAULT_VOICE_LIVE_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: resolved.closeTimeoutMs ?? DEFAULT_VOICE_LIVE_CLOSE_TIMEOUT_MS,
    maxUtteranceBytes: resolved.maxUtteranceBytes ?? DEFAULT_VOICE_LIVE_MAX_UTTERANCE_BYTES,
    apiKeyEnv,
    resolveApiKey,
  })
  const provider = new VoicePolishProvider(() => {
    const options = resolvePolishOptions(resolved, resolveApiKey)
    // Disabling polish drops the resolver rather than the route: a deployment
    // without a key and a deployment that turned polish off read the same way.
    if (resolved.polishEnabled === false) {
      const { resolveApiKey: _dropped, ...rest } = options
      return rest
    }
    return options
  })
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: VOICE_LIVE_PATH,
      methods: ['POST'],
      // Streaming keeps the request open while the response is read, which is
      // what lets audio go up and transcripts come down the same request.
      requestBody: 'streaming',
      fetch: request => handleVoiceLiveHttp(session, request),
    }),
    'ui-voice: live route',
  )
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: VOICE_POLISH_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handleVoicePolishHttp(provider, request),
    }),
    'ui-voice: polish route',
  )
  // The session's own effect: disposing the plugin closes the warm provider
  // socket and awaits the close, so no plugin instance leaves one behind.
  ctx.effect(() => () => session.dispose(), 'ui-voice: live session')
  // Register the durable voice preferences when a settings provider exists:
  // the browser half binds the same section, and a deployment without a
  // provider keeps the schema defaults the browser already carries.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(VOICE_SETTINGS_NAMESPACE, VoiceSettingsSchema)
  })
}
