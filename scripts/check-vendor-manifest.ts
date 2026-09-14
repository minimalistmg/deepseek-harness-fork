/**
 * Vendoring discipline, mechanized: a staged change under `vendor/*\/src` or a
 * vendored `bin.js` must come with a `vendor/README.md` change in the same
 * commit, because the manifest's local-modification log is the contract (see
 * `vendor/README.md`).
 *
 * The rule reads the Git index, so it sees exactly what the commit will carry.
 * It is TypeScript rather than a shell script because the pre-commit hook runs
 * on every platform the repository is developed on, and a `#!/usr/bin/env bash`
 * shebang is unreadable wherever Git's shell is absent from `PATH`.
 * @module scripts/check-vendor-manifest
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** The one manifest whose update accompanies a vendored-source change. */
export const VENDOR_MANIFEST_PATH = 'vendor/README.md'

/** Staged paths matching a vendored source or its vendored bundle. */
const VENDOR_SOURCE = /^vendor\/[^/]+\/(?:src\/|bin\.js)/

/**
 * The staged vendored-source changes that arrived without the manifest.
 * @param stagedPaths - repository-relative paths staged for this commit.
 * @returns the offending paths in the order Git reported them.
 */
export function unmanifestedVendorSources(stagedPaths: readonly string[]): string[] {
  if (stagedPaths.includes(VENDOR_MANIFEST_PATH)) return []
  return stagedPaths.filter(path => VENDOR_SOURCE.test(path))
}

/**
 * Read the repository's staged paths.
 * @param root - repository root.
 * @returns the staged paths, or `undefined` when Git could not be read.
 */
function stagedPaths(root: string): string[] | undefined {
  const result = spawnSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? `git exited with status ${String(result.status)}`
    console.error(`vendor manifest guard: could not read the staged paths (${reason})`)
    return undefined
  }
  return result.stdout.split('\n').filter(line => line !== '')
}

const root = resolve(import.meta.dirname, '..')
const staged = stagedPaths(root)
if (staged === undefined) {
  process.exitCode = 1
} else {
  const offenders = unmanifestedVendorSources(staged)
  if (offenders.length > 0) {
    console.error('vendor manifest guard: vendored SOURCE changed without updating vendor/README.md:')
    for (const path of offenders) console.error(`  ${path}`)
    console.error('Log the modification in vendor/README.md ("Local modifications") and stage it.')
    process.exitCode = 1
  }
}
