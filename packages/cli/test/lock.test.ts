import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCodes, SkillSetError } from '../src/errors.ts'
import { setHash } from '../src/hash.ts'
import { createSetLock, parseSetLock, parseSkillsLock, serializeSetLock } from '../src/lock.ts'

// The spec lock fixtures deliberately use inert, non-owned names (e.g. "acme-skills") as pure
// name-pattern strings. Never copy them into tests that resolve or fetch — anything resolvable
// must use an owned namespace (hcjmartin/*, skill-set.md, flocker.md).
const lockFixturePath = join(
  import.meta.dirname,
  '../../../spec/draft/examples/lock/valid/minimal.skill-set.lock.json',
)
const lockFixture = readFileSync(lockFixturePath, 'utf8')

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('parseSetLock', () => {
  it('accepts the spec fixture, including its filename', () => {
    const result = parseSetLock(lockFixture, { filename: 'minimal.skill-set.lock.json' })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
  })

  it('fails loudly on an unknown lock version, before shape validation', () => {
    const result = parseSetLock(JSON.stringify({ version: 2, whatever: true }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.LOCK_VERSION)
      expect(result.error.hint).toContain('left untouched')
    }
  })

  it('rejects a lock whose setHash contradicts its own members', () => {
    const lock = createSetLock('demo', '1.0.0', {
      'a/b@c': { skill: 'c', computedHash: HASH_A },
    })
    const tampered = serializeSetLock({ ...lock, setHash: HASH_B })
    const result = parseSetLock(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_LOCK)
  })

  it('reports a non-object root as a shape error, not a version error', () => {
    const result = parseSetLock('[]')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_LOCK)
  })

  it('enforces name↔filename with the lock suffix', () => {
    const result = parseSetLock(lockFixture, { filename: 'other.skill-set.lock.json' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_LOCK)
  })
})

describe('serializeSetLock — determinism (spec §5/§7)', () => {
  it('round-trips the spec fixture byte-for-byte', () => {
    const parsed = parseSetLock(lockFixture)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(serializeSetLock(parsed.data)).toBe(lockFixture)
  })

  it('serializes twice to identical bytes', () => {
    const lock = createSetLock('demo', '1.0.0', {
      'x/y@z': { skill: 'z', computedHash: HASH_A, sourceType: 'github', ref: 'v1' },
    })
    expect(serializeSetLock(lock)).toBe(serializeSetLock(lock))
  })

  it('sorts member keys by UTF-8 byte order regardless of insertion order', () => {
    const forward = createSetLock('demo', '1.0.0', {
      'a/first@one': { skill: 'one', computedHash: HASH_A },
      'b/second@two': { skill: 'two', computedHash: HASH_B },
    })
    const reversed = createSetLock('demo', '1.0.0', {
      'b/second@two': { skill: 'two', computedHash: HASH_B },
      'a/first@one': { skill: 'one', computedHash: HASH_A },
    })
    expect(serializeSetLock(forward)).toBe(serializeSetLock(reversed))
  })

  it('createSetLock rejects an empty member map (a zero-member lock is schema-invalid)', () => {
    expect(() => createSetLock('demo', '1.0.0', {})).toThrow(SkillSetError)
  })

  it('createSetLock computes the setHash from its members', () => {
    const lock = createSetLock('demo', '1.0.0', {
      'a/b@c': { skill: 'c', computedHash: HASH_A },
    })
    expect(lock.setHash).toBe(setHash({ 'a/b@c': HASH_A }))
    expect(parseSetLock(serializeSetLock(lock)).ok).toBe(true)
  })
})

describe('parseSkillsLock — upstream adapter', () => {
  const upstream = {
    version: 1,
    skills: {
      'find-skills': {
        source: 'vercel-labs/agent-skills',
        ref: 'main',
        sourceType: 'github',
        skillPath: 'skills/find-skills/SKILL.md',
        computedHash: '781bd6d3f9b19f8c9af6b53d8d0e4876d0183841b565db34ca7092ffa412d111',
        futureField: 'tolerated',
      },
    },
    futureTopLevel: true,
  }

  it('reads a v1 lock, tolerating unknown fields', () => {
    const result = parseSkillsLock(JSON.stringify(upstream))
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (result.ok) {
      expect(result.data.skills['find-skills']!.computedHash).toMatch(/^781bd6d3/)
    }
  })

  it('rejects a v1 entry missing required fields with a shape error, not a wipe', () => {
    const result = parseSkillsLock(JSON.stringify({ version: 1, skills: { x: { source: 'a' } } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_LOCK)
  })

  it('fails loudly on an unknown upstream version — never wipes', () => {
    const result = parseSkillsLock(JSON.stringify({ ...upstream, version: 3 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.LOCK_VERSION)
      expect(result.error.hint).toContain('left untouched')
    }
  })
})
