/** `holds` namespace dictionaries (parked drafts, their control, and their dock). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'hold.label': '暂存',
  'hold.title': '暂存当前草稿，不发送',
  'hold.title.empty': '先输入内容再暂存',
  'hold.title.attachments': '带附件的草稿暂不支持暂存，请先发送或移除附件',
  'hold.title.update': '更新正在编辑的暂存草稿',
  'dock.count': '{n} 条暂存',
  'dock.expand': '展开暂存草稿',
  'dock.collapse': '收起暂存草稿',
  'dock.reorder': '拖动或按上下方向键调整顺序',
  'dock.send': '发送',
  'dock.edit': '编辑',
  'dock.delete': '删除',
  'dock.editing': '编辑中',
} satisfies Record<string, string>

/** The holds namespace key union. */
export type HoldsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'hold.label': 'Hold',
  'hold.title': 'Park this draft without sending it',
  'hold.title.empty': 'Type something before holding it',
  'hold.title.attachments': 'A draft with attachments cannot be held yet; send it or remove the attachments',
  'hold.title.update': 'Update the draft being edited',
  'dock.count': '{n} on Hold',
  'dock.expand': 'Show the held drafts',
  'dock.collapse': 'Hide the held drafts',
  'dock.reorder': 'Drag, or press the up and down arrows, to reorder',
  'dock.send': 'Send',
  'dock.edit': 'Edit',
  'dock.delete': 'Delete',
  'dock.editing': 'Editing',
} satisfies Record<HoldsKey, string>
