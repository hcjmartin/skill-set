import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { SUPPORTED_SCHEMA_VERSIONS } from '../src/manifest.ts'
import { SKILLS_PIN } from '../src/resolver.ts'
import { VERSION } from '../src/run.ts'
import { runCommand } from '../src/spawn.ts'

// The published surface is the bin alone — no exports/main/types ships, so there is no
// typed consumer to compile. This suite is the bin-first counterpart of a dist-types
// smoke test: pin the surface shape, then execute the built bin end to end.

const pkgDir = join(import.meta.dirname, '..')
const binPath = join(pkgDir, 'bin', 'cli.mjs')

describe('package surface pins', () => {
  it('ships a single skill-set bin and only built files', () => {
    expect(pkg.bin).toEqual({ 'skill-set': 'bin/cli.mjs' })
    expect(pkg.files).toEqual(['bin', 'dist', 'schema'])
    expect(pkg.type).toBe('module')
    expect(pkg.publishConfig).toEqual({ access: 'public' })
    expect(pkg.name).toBe('@skill-set/cli')
    // Every pack/publish refreshes schema/ from spec/ so releases carry their exact schemas.
    expect(pkg.scripts.prepack).toBe('node scripts/sync-schemas.mjs')
  })

  it('ships exactly the supported schema versions, byte-identically', async () => {
    const sync = await runCommand(process.execPath, [join(pkgDir, 'scripts', 'sync-schemas.mjs')], { capture: true })
    expect(sync.ok && sync.data.exitCode === 0).toBe(true)
    // The rebuilt schema/ tree carries one directory per supported version — no strays.
    expect(readdirSync(join(pkgDir, 'schema')).sort()).toEqual([...SUPPORTED_SCHEMA_VERSIONS].sort())
    const specDraft = join(pkgDir, '..', '..', 'spec', 'draft')
    for (const file of ['skill-set.schema.json', 'skill-set.lock.schema.json']) {
      expect(readFileSync(join(pkgDir, 'schema', 'draft', file), 'utf8')).toBe(
        readFileSync(join(specDraft, file), 'utf8'),
      )
    }
  })

  it('exposes no programmatic entry points', () => {
    const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(raw.exports).toBeUndefined()
    expect(raw.main).toBeUndefined()
    expect(raw.types).toBeUndefined()
    expect(raw.private).toBeUndefined()
  })
})

describe('built bin wiring', () => {
  it('the shim is a node shebang delegating to dist', () => {
    const shim = readFileSync(binPath, 'utf8')
    expect(shim.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(shim).toContain("import('../dist/cli.mjs')")
  })

  it('the built bin runs and reports both versions', async () => {
    // Requires a prior build (`check` and CI both build before testing).
    expect(existsSync(join(pkgDir, 'dist', 'cli.mjs'))).toBe(true)
    const result = await runCommand(process.execPath, [binPath, '--version'], { capture: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.exitCode).toBe(0)
      expect(result.data.stdout).toContain(`skill-set/${VERSION}`)
      expect(result.data.stdout).toContain(`skills@${SKILLS_PIN}`)
    }
  })

  it('the built bin intercepts a verb --help without dispatching', async () => {
    const result = await runCommand(process.execPath, [binPath, 'update', '--help'], { capture: true })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.exitCode).toBe(0)
      expect(result.data.stdout).toContain('Usage: skill-set <command>')
      expect(result.data.stderr).toBe('')
    }
  })
})
