/**
 * The vendor manifest guard's decision rule: which staged vendored-source
 * changes must be accompanied by a `vendor/README.md` update.
 */
import { describe, expect, it } from 'vitest'
import { unmanifestedVendorSources, VENDOR_MANIFEST_PATH } from './check-vendor-manifest.ts'

describe('unmanifestedVendorSources', () => {
  it('accepts a commit that stages no vendored source', () => {
    expect(unmanifestedVendorSources(['packages/core/session/src/index.ts', 'README.md'])).toEqual([])
  })

  it('accepts vendored source that stages the manifest beside it', () => {
    expect(unmanifestedVendorSources([
      'vendor/cordis/src/index.ts',
      VENDOR_MANIFEST_PATH,
    ])).toEqual([])
  })

  it('reports vendored source staged without the manifest', () => {
    expect(unmanifestedVendorSources([
      'README.md',
      'vendor/cordis/src/index.ts',
      'vendor/loader/bin.js',
    ])).toEqual(['vendor/cordis/src/index.ts', 'vendor/loader/bin.js'])
  })

  it('reports a vendored bundle staged without the manifest', () => {
    expect(unmanifestedVendorSources(['vendor/schemastery/bin.js'])).toEqual(['vendor/schemastery/bin.js'])
  })

  it('ignores a vendored package outside its source and bundle', () => {
    expect(unmanifestedVendorSources([
      'vendor/cordis/package.json',
      'vendor/cordis/README.md',
      'vendor/README.md.bak',
    ])).toEqual([])
  })
})
