import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../src/errors.ts'
import { parseManifest } from '../src/manifest.ts'

const examples = join(import.meta.dirname, '../../../spec/draft/examples')

function fixture(kind: string, file: string): string {
  return readFileSync(join(examples, kind, file), 'utf8')
}

function fixtures(kind: string): string[] {
  return readdirSync(join(examples, kind)).filter((f) => f.endsWith('.skill-set.json'))
}

describe('parseManifest — spec fixtures', () => {
  it.each(fixtures('valid'))('accepts valid/%s', (file) => {
    const result = parseManifest(fixture('valid', file), { filename: file })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
  })

  it.each(fixtures('invalid'))('rejects invalid/%s', (file) => {
    expect(parseManifest(fixture('invalid', file)).ok).toBe(false)
  })

  it('rejects invalid-rules/name-mismatch only when the filename is known', () => {
    const text = fixture('invalid-rules', 'name-mismatch.skill-set.json')
    const withFile = parseManifest(text, { filename: 'name-mismatch.skill-set.json' })
    expect(withFile.ok).toBe(false)
    if (!withFile.ok) expect(withFile.error.code).toBe(ErrorCodes.NAME_MISMATCH)
    expect(parseManifest(text).ok).toBe(true)
  })
})

describe('parseManifest — §2 rules', () => {
  const base = { name: 'demo', version: '1.0.0', skills: ['acme/skills@review-code'] }

  it('reports duplicate members with a dedicated code', () => {
    const result = parseManifest(
      JSON.stringify({ ...base, skills: ['a/b@c', 'a/b@c'] }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.DUPLICATE_MEMBER)
  })

  it('rejects duplicate JSON keys (strict JSON, §2.1)', () => {
    const result = parseManifest('{"name":"demo","name":"demo","version":"1.0.0","skills":["a/b@c"]}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_JSON)
  })

  it('does not flag equal keys in different objects', () => {
    const result = parseManifest(
      JSON.stringify({ ...base, author: { name: 'Harry Martin' } }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects unknown schema major versions (§2.5)', () => {
    const result = parseManifest(
      JSON.stringify({ ...base, $schema: 'https://skill-set.md/schema/v9/skill-set.schema.json' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.SCHEMA_VERSION)
  })

  it('accepts the draft schema URL', () => {
    const result = parseManifest(
      JSON.stringify({ ...base, $schema: 'https://skill-set.md/schema/draft/skill-set.schema.json' }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects malformed JSON with INVALID_JSON', () => {
    const result = parseManifest('{ not json')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_JSON)
  })

  it('rejects non-object roots via the schema', () => {
    const result = parseManifest('42')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.INVALID_MANIFEST)
  })

  it('aggregates all schema issues into the message', () => {
    const result = parseManifest('{"name":"Bad_Name","version":"1.0"}')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.INVALID_MANIFEST)
      expect(result.error.message).toContain('name')
      expect(result.error.message).toContain('version')
      expect(result.error.message).toContain('skills')
    }
  })
})
