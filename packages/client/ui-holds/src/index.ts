/**
 * Holds plugin, node half. Pure UI plugin: the empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration. Parked drafts live in the browser, because a hold is an unsent
 * draft rather than model-visible input.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
