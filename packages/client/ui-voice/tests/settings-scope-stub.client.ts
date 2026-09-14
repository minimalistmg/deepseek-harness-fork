/**
 * An in-memory settings scope for the voice specs: the plugin's declared
 * `settingsScope` injection is a real client service in production, and these
 * cases exercise the seat, the dock, and the preferences rather than the
 * settings transport, so the scope is a stub the way the carrier is.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { VoiceSettings } from '../src/voice-settings.ts'

/** The scope service plus the store a case publishes accepted sections into. */
export interface SettingsScopeStub {
  readonly store: ReturnType<typeof createSnapshotStore<SettingsScopeSnapshot<VoiceSettings>>>
  /** The `ctx.settingsScope` service value. */
  readonly service: { bind(spec: { namespace: string }): SettingsScope<VoiceSettings> }
}

/**
 * Build one process-local settings scope, in the state a deployment with no
 * Host document reports.
 * @returns the stub, with the store a case can move.
 */
export function settingsScopeStub(): SettingsScopeStub {
  const store = createSnapshotStore<SettingsScopeSnapshot<VoiceSettings>>({
    status: 'unavailable',
    value: undefined,
    base: undefined,
    user: undefined,
    revision: undefined,
    writable: false,
    mode: 'memory',
  })
  const scope = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => store.subscribe(listener),
    mutate: async () => {},
    set: async () => {},
    unset: async () => {},
  } satisfies SettingsScope<VoiceSettings>
  return { store, service: { bind: () => scope } }
}
