import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }

// The published surface is a single typed ESM entry with no runtime dependencies —
// that zero-dep, runtime-agnostic shape is the package's contract; pin it.

describe('package surface pins', () => {
  it('ships a single typed ESM export and only built files', () => {
    expect(pkg.name).toBe('@skill-set/core')
    expect(pkg.type).toBe('module')
    expect(pkg.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    })
    expect(pkg.files).toEqual(['dist'])
    expect(pkg.sideEffects).toBe(false)
    expect(pkg.publishConfig).toEqual({ access: 'public' })
  })

  it('declares no runtime dependencies', () => {
    expect('dependencies' in pkg).toBe(false)
    expect('peerDependencies' in pkg).toBe(false)
  })
})
