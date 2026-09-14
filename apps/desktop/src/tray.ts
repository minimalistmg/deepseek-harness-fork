/**
 * Desktop tray construction.
 *
 * The tray is the window's second home: closing the window hides it instead of
 * ending the process, and the tray menu is the only route back to Show, Check
 * for Updates, and Quit. This module owns which entries the menu carries and
 * the order they appear in; the shell owns what each entry does.
 * @module @deepseek-ai/dsh-desktop/tray
 */

import { TRAY_ICON_DATA_URL } from './tray-icon.ts'
import type { DesktopMessages } from './locale.ts'

/** What one tray entry asks the shell to do. */
export type DesktopTrayAction =
  /** Bring the main window back. */
  | 'show'
  /** Run an update check. */
  | 'updates'
  /** End the process. */
  | 'quit'

/** One tray menu entry, already localized and bound to its action. */
export interface DesktopTrayItem {
  /** The action a click performs. */
  readonly id: DesktopTrayAction
  /** Localized menu label. */
  readonly label: string
}

/** The tray icon source the shell decodes into a native image. */
export const DESKTOP_TRAY_ICON = TRAY_ICON_DATA_URL

/**
 * Build the tray menu, in reading order.
 * @param messages - the resolved shell locale.
 * @returns the entries the shell turns into a native menu.
 */
export function desktopTrayItems(messages: DesktopMessages): readonly DesktopTrayItem[] {
  return [
    { id: 'show', label: messages.trayShow },
    { id: 'updates', label: messages.trayUpdates },
    { id: 'quit', label: messages.trayQuit },
  ]
}
