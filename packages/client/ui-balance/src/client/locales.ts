/** `balance` namespace dictionaries (the account balance pill and its popover). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'pill.label': '余额',
  'pill.available': '可用',
  'pill.unavailable': '不可用',
  'pill.loading': '余额读取中',
  'pill.failed': '余额读取失败，点击重试',
  'pill.fx': '按 {rate} 折算',
  'popover.title': '账户余额',
  'popover.granted': '赠送金额',
  'popover.toppedUp': '充值金额',
  'popover.available': '账户可用',
  'popover.available.yes': '平台当前允许使用该余额',
  'popover.available.no': '平台当前不允许使用该余额',
  'popover.usage': '查看平台用量',
} satisfies Record<string, string>

/** The balance namespace key union. */
export type BalanceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'pill.label': 'Balance',
  'pill.available': 'Available',
  'pill.unavailable': 'Unavailable',
  'pill.loading': 'Reading the balance',
  'pill.failed': 'Balance unavailable, click to retry',
  'pill.fx': 'at {rate}',
  'popover.title': 'Account balance',
  'popover.granted': 'Granted',
  'popover.toppedUp': 'Topped up',
  'popover.available': 'Account usable',
  'popover.available.yes': 'The platform currently allows spending this balance',
  'popover.available.no': 'The platform currently does not allow spending this balance',
  'popover.usage': 'Open platform usage',
} satisfies Record<BalanceKey, string>
