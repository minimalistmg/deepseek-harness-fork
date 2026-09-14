/**
 * The tray icon, embedded as a PNG data URL.
 *
 * The shell ships no image files: `files` in the electron-builder configuration
 * carries compiled JavaScript and the renderer, so an icon read from disk would
 * need a packaging change. `nativeImage.createFromDataURL` decodes this one at
 * runtime, on every platform, with no file to locate.
 *
 * The mark is a 32×32 rounded square with a hollow centre, in the product blue;
 * it is drawn for a tray, where a 16–20 px rendering has room for a silhouette
 * and no room for detail.
 * @module @deepseek-ai/dsh-desktop/tray-icon
 */

/** The tray icon as a PNG data URL. */
export const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAa0lEQVR4nGNgGAWjgAjgm/1vJjmYmhb/JxOT7xAKLcZwyEBaTrojBtQBNLKceEeMOoBYB2DRRz8H4NFLewcQoX/UAcPcAQOeCAdFNqQAjzpgQGvEIdIeoJEjKGoXDkyjFIdD6NssHwUjAgAA2w7qgbrPznEAAAAASUVORK5CYII='
