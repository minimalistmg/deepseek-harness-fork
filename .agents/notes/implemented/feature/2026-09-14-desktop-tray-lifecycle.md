# Agent Note: A tray that outlives the desktop window

Status: implemented

English | [中文](2026-09-14-desktop-tray-lifecycle.zh.md)

## Problem

The desktop shell ended the run when its last window closed, so a user who wanted to keep the dsh Host up — a running turn, a long tool call, a plugin install — had to leave the window on screen. The window is the shell's only surface, and every route back to the Host went through it.

Hiding instead of closing needs somewhere to hide *to*, because the process would otherwise keep running with no way to show it again, no way to quit it, and no evidence it is still there.

## Decision

Install one tray icon and let it own the run's lifetime: closing the main window hides it, `window-all-closed` leaves the application running while the tray stands, and the tray's menu is the route back — Show, Check for Updates…, and Quit, in that order.

### Where the menu comes from

`src/tray.ts` owns which entries the menu carries and the order they appear in; the shell owns what each entry does, mapping the entry ids to `focusPrimaryWindow`, the existing update check, and a quit that sets the flag the `before-quit` handler reads. Both halves of that split are covered: the module by its own spec, the mapping by the shell's startup spec.

### The icon

The icon is a PNG data URL compiled into the shell, not a file read from disk. The packaged `files` list carries compiled JavaScript and the renderer only, so an image on disk would need a packaging entry per platform, a path that resolves in both the packaged and the development layout, and a signature story for the file. Decoding bytes already inside the bundle has none of those problems: `nativeImage.createFromDataURL` works on every platform with no file to locate.

### Close versus quit

The window's own `close` event is what distinguishes the two. Closing hides the window unless the process is already quitting, so an explicit Quit, an accepted update install, and a fatal startup path all pass through. A `window-all-closed` handler that consults the tray keeps macOS's own convention intact rather than inventing a second platform rule.

## Alternatives considered

**A menu-bar-only mode.** Rejected for this change: the tray supplements the window, it does not replace it, and a shell whose only surface is a tray menu cannot compose a message.

**Quit when the window closes, and start hidden.** Rejected: a process with no visible surface that the user did not ask to keep is indistinguishable from one that failed to exit.

**A tray icon file under `apps/desktop/assets/`.** Rejected: it needs a `files` entry, a path constant that resolves in packaged and development layouts, and a per-target icon format. The tray is 16–20 px; nothing about it needs a designer's asset pipeline.

**React to the tray through the plugin window.** Rejected: the plugin window is a management surface for installed plugins and closes with the main window; the tray outlives both.

**Register a process-wide push-to-talk chord while the tray exists.** Rejected for this change: dictation's push-to-talk is a page-level chord the Web GUI owns, and the desktop shell adding a second one would create two owners of the same gesture.

## Consequences

The shell now has two surfaces whose lifetimes differ: the window can be hidden while the tray remains, so any future feature that assumes a visible window must say which state it means. Quit is no longer the only way to reach the Host without a window, and the tray becomes the place a background feature would surface.

On a desktop environment that offers no tray — some Linux sessions — the icon may not appear, and the application would then run with no visible surface. Desktop releases do not target Linux, and the window's close handler is registered regardless, so the behaviour there is the platform's rather than the shell's.

Coverage pins the menu's entries and their order, the tray's creation with the resolved tooltip and menu, the hide-instead-of-quit close, the tray click restoring the window, the menu's Quit, and the run surviving an empty window set.
