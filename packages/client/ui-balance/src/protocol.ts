/**
 * Wire vocabulary shared by both halves of the balance plugin: the Connection
 * Fetch route the browser reads, and the JSON envelope that route answers with.
 * The module holds no runtime dependency, so the browser bundle inlines it
 * rather than requesting a module-table row.
 */

/** Exact Fetch route below `/api` where the browser reads the account balance. */
export const ACCOUNT_BALANCE_PATH = '/api/account/balance'

/** The platform's own usage page, opened from the pill. */
export const ACCOUNT_BALANCE_USAGE_URL = 'https://platform.deepseek.com/usage'

/** Response media type for the balance route. */
export const ACCOUNT_BALANCE_MEDIA_TYPE = 'application/json'

/** Failure code for a deployment with no credential plane or no route. */
export const ACCOUNT_BALANCE_CODE_UNAVAILABLE = 'account/balance-unavailable'

/** Failure code for a read that outlived its deadline. */
export const ACCOUNT_BALANCE_CODE_TIMEOUT = 'account/balance-timeout'

/** Failure code for every other provider or transport fault. */
export const ACCOUNT_BALANCE_CODE_FAILED = 'account/balance-failed'

/** Currency conversion applied to a reported balance. */
export interface AccountBalanceFx {
  /** Currency the total was converted into. */
  readonly currency: string
  /** Units of `currency` per unit of the account's own currency. */
  readonly rate: number
  /** The account total in `currency`, formatted by the host. */
  readonly converted: string
}

/** One reading of the account balance, as the account reports it. */
export interface AccountBalanceReport {
  /** The platform's own availability flag for spending this balance. */
  readonly available: boolean
  /** Currency the account reports its balance in. */
  readonly currency: string
  /** Total balance including granted credit. */
  readonly total: string
  /** Credit the platform granted rather than the user paying in. */
  readonly granted: string
  /** Credit the user paid in. */
  readonly toppedUp: string
  /** Conversion into the configured display currency, when one was requested and resolved. */
  readonly fx?: AccountBalanceFx
}

/** Successful read: the balance as of this request. */
export interface AccountBalanceOk {
  readonly ok: true
  readonly report: AccountBalanceReport
}

/** Unsuccessful read: the browser shows the reason and retries on the next open. */
export interface AccountBalanceFailure {
  readonly ok: false
  /** Why no balance came back. */
  readonly error: {
    /** Stable discriminator the browser maps to a localized pill state. */
    readonly code: string
    /** Operator-facing detail; never product copy. */
    readonly message: string
    /** Structured detail carried alongside the message. */
    readonly details: object
  }
}

/** Body of one balance response. */
export type AccountBalanceEnvelope = AccountBalanceOk | AccountBalanceFailure
