/**
 * The desktop tray's menu: which entries it carries, in which order, and the
 * icon source the shell decodes. The entries are the only route to Show, Check
 * for Updates, and Quit once the window is hidden, so the set and its labels are
 * the contract this module owns.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { DESKTOP_TRAY_ICON, desktopTrayItems } from '../src/tray.ts'

describe('desktopTrayItems', () => {
  it('offers show, updates, and quit in reading order', () => {
    expect(desktopTrayItems(en)).toEqual([
      { id: 'show', label: 'Show DeepSeek Harness' },
      { id: 'updates', label: 'Check for Updates…' },
      { id: 'quit', label: 'Quit DeepSeek Harness' },
    ])
  })

  it('carries the resolved locale', () => {
    expect(desktopTrayItems(zh).map(item => item.label)).toEqual([
      '显示 DeepSeek Harness', '检查更新…', '退出 DeepSeek Harness',
    ])
  })
})

describe('tray icon', () => {
  it('is a PNG data URL, so no packaged image file is needed', () => {
    expect(DESKTOP_TRAY_ICON.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(DESKTOP_TRAY_ICON.split(',')[1]!, 'base64').subarray(0, 8))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })
})
