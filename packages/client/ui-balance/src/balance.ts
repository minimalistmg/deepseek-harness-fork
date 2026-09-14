/**
 * The DeepSeek platform account balance, read on the host because the API key
 * must not reach the browser.
 *
 * One read is one credentialed request to the platform's balance endpoint,
 * followed by an optional currency conversion. Conversion is best-effort: a
 * deployment that asked for a display currency still gets its balance when the
 * rate service cannot answer, because the balance is the fact the user came for.
 * @module @deepseek-ai/dsh-client-ui-balance/balance
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { AccountBalanceFx, AccountBalanceReport } from './protocol.ts'

/** Default credential reference when configuration names none. */
export const DEFAULT_DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Default DeepSeek platform origin when configuration names none. */
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** Default foreign-exchange origin when configuration names none. */
export const DEFAULT_FX_BASE_URL = 'https://api.frankfurter.app'

/** Default deadline for one balance read, in milliseconds. */
export const DEFAULT_ACCOUNT_BALANCE_TIMEOUT_MS = 5000

/** Timeout code stamped onto this provider's deadline and read back on abort. */
export const ACCOUNT_BALANCE_TIMEOUT_CODE = 'ACCOUNT_BALANCE_TIMEOUT'

/** Path of the platform's balance endpoint, appended to the configured origin. */
const BALANCE_PATH = '/user/balance'

/** Path of the exchange-rate endpoint, appended to the configured origin. */
const FX_PATH = '/latest'

/** Request header carrying the API key, so the secret never reaches the URL. */
const AUTHORIZATION_HEADER = 'authorization'

/** How one balance read settled. */
export type AccountBalanceOutcome =
  /** A balance came back. */
  | 'ok'
  /** No API key resolved, so nothing was sent. */
  | 'unavailable'
  /** The deadline elapsed before an answer arrived. */
  | 'timeout'
  /** Any other refusal, transport fault, or unusable body. */
  | 'failed'

/**
 * What one read produced: the balance it read, or the outcome that replaced it.
 */
export type AccountBalanceResult =
  | {
    /** A balance came back. */
    readonly outcome: 'ok'
    /** The balance as of this read. */
    readonly report: AccountBalanceReport
  }
  | {
    /** How the read failed. */
    readonly outcome: Exclude<AccountBalanceOutcome, 'ok'>
  }

/** Resolved provider options; the plugin wires every field. */
export interface AccountBalanceProviderOptions {
  /** Platform origin; the balance path is appended. */
  readonly baseURL: string
  /** Exchange-rate origin; the latest-rates path is appended. */
  readonly fxBaseURL: string
  /** Currency to convert the total into; empty leaves the account's own currency. */
  readonly displayCurrency: string
  /** Deadline for one read, in milliseconds. */
  readonly timeoutMs: number
  /** Credential reference named by missing-key diagnostics. */
  readonly apiKeyEnv: CredentialRef
  /**
   * Resolve the current API key for one read. Absent when the plugin holds no
   * credential plane at all, which always reads as "unavailable".
   * @returns the resolved key, or `undefined` when no layer supplies one.
   */
  readonly resolveApiKey?: () => Promise<string | undefined>
}

/** One currency row of the platform's balance response. */
interface BalanceInfo {
  readonly currency?: unknown
  readonly total_balance?: unknown
  readonly granted_balance?: unknown
  readonly topped_up_balance?: unknown
}

/** Parsed platform balance response. */
interface BalanceResponse {
  readonly is_available?: unknown
  readonly balance_infos?: readonly BalanceInfo[]
}

/** Parsed exchange-rate response. */
interface FxResponse {
  readonly rates?: Readonly<Record<string, unknown>>
}

/**
 * The platform-backed account balance reader. One instance serves the plugin;
 * each read resolves its own credential and applies its own deadline.
 */
export class AccountBalanceProvider {
  /**
   * @param resolveOptions - the options for the NEXT read, taken once at each
   * read's entry so one request never mixes two configuration reads.
   */
  constructor(private readonly resolveOptions: () => AccountBalanceProviderOptions) {}

  /**
   * Read the account balance.
   * @param signal - caller cancellation fused into this request's deadline.
   * @returns the balance on success, otherwise the outcome that replaced it.
   */
  async read(signal?: AbortSignal): Promise<AccountBalanceResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options)
    if (apiKey === undefined) return { outcome: 'unavailable' }
    using d = deadline(signal, options.timeoutMs, ACCOUNT_BALANCE_TIMEOUT_CODE)
    let response: Response
    try {
      response = await fetch(`${options.baseURL}${BALANCE_PATH}`, {
        method: 'GET',
        // A credentialed provider request must not follow a redirect to another origin.
        redirect: 'error',
        headers: {
          [AUTHORIZATION_HEADER]: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        signal: d.signal,
      })
    } catch {
      return { outcome: outcomeOfFailure(d.signal) }
    }
    if (!response.ok) return { outcome: 'failed' }
    let payload: BalanceResponse
    try {
      payload = await response.json() as BalanceResponse
    } catch {
      return { outcome: outcomeOfFailure(d.signal) }
    }
    const report = reportedBalance(payload)
    if (report === undefined) return { outcome: 'failed' }
    const fx = options.displayCurrency === '' || options.displayCurrency === report.currency
      ? undefined
      : await this.convert(options, report, signal)
    return { outcome: 'ok', report: fx === undefined ? report : { ...report, fx } }
  }

  /**
   * Resolve one read's key without retaining it on the provider.
   * @param options - this read's snapshot, so the key and endpoint come from one read.
   * @returns the resolved key, or `undefined` when no layer supplies one.
   */
  private async apiKey(options: AccountBalanceProviderOptions): Promise<string | undefined> {
    if (options.resolveApiKey === undefined) return undefined
    const resolved = await options.resolveApiKey()
    return resolved !== undefined && resolved.length > 0 ? resolved : undefined
  }

  /**
   * Convert one reported total into the configured display currency.
   * @param options - this read's resolved options.
   * @param report - the balance the platform reported.
   * @param signal - caller cancellation.
   * @returns the conversion, or `undefined` when no usable rate came back.
   */
  private async convert(
    options: AccountBalanceProviderOptions,
    report: AccountBalanceReport,
    signal?: AbortSignal,
  ): Promise<AccountBalanceFx | undefined> {
    const query = new URLSearchParams({ from: report.currency, to: options.displayCurrency })
    using d = deadline(signal, options.timeoutMs, ACCOUNT_BALANCE_TIMEOUT_CODE)
    let response: Response
    try {
      response = await fetch(`${options.fxBaseURL}${FX_PATH}?${query.toString()}`, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: d.signal,
      })
    } catch {
      return undefined
    }
    if (!response.ok) return undefined
    let payload: FxResponse
    try {
      payload = await response.json() as FxResponse
    } catch {
      return undefined
    }
    const rate = payload.rates?.[options.displayCurrency]
    const total = Number(report.total)
    if (typeof rate !== 'number' || !Number.isFinite(rate) || !Number.isFinite(total)) return undefined
    return { currency: options.displayCurrency, rate, converted: (total * rate).toFixed(2) }
  }
}

/**
 * Map a thrown transport or body failure onto an outcome.
 * @param signal - this read's deadline signal.
 * @returns `'timeout'` when this read's own deadline elapsed, otherwise `'failed'`.
 */
function outcomeOfFailure(signal: AbortSignal): Exclude<AccountBalanceOutcome, 'ok' | 'unavailable'> {
  return timeoutOf(signal, ACCOUNT_BALANCE_TIMEOUT_CODE) === undefined ? 'failed' : 'timeout'
}

/**
 * Read the first reported balance row.
 * @param payload - the parsed platform response.
 * @returns the report, or `undefined` when the body carries no usable row.
 */
export function reportedBalance(payload: BalanceResponse): AccountBalanceReport | undefined {
  const info = payload.balance_infos?.[0]
  if (info === undefined) return undefined
  const { currency, total_balance: total } = info
  if (typeof currency !== 'string' || currency === '' || typeof total !== 'string') return undefined
  return {
    available: payload.is_available === true,
    currency,
    total,
    granted: moneyText(info.granted_balance),
    toppedUp: moneyText(info.topped_up_balance),
  }
}

/**
 * Read one optional amount as display text.
 * @param value - the wire value.
 * @returns the amount as written, or `'0'` when the row omits it.
 */
function moneyText(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : '0'
}
