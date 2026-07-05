import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { parseManifest } from '../src/manifest.ts'

const specDir = join(import.meta.dirname, '../../../spec/draft')

type Violation = { keyword: string; instancePath: string }

function loadJson(...segments: string[]): unknown {
  return JSON.parse(readFileSync(join(specDir, ...segments), 'utf8'))
}

function fixtures(dir: string, suffix: string): string[] {
  return readdirSync(join(specDir, dir)).filter((f) => f.endsWith(suffix))
}

const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)

const manifestSchema = loadJson('skill-set.schema.json') as Record<string, unknown>
const lockSchema = loadJson('skill-set.lock.schema.json') as Record<string, unknown>
const validateManifest = ajv.compile(manifestSchema)
const validateLock = ajv.compile(lockSchema)

const MANIFEST_SUFFIX = '.skill-set.json'
const LOCK_SUFFIX = '.skill-set.lock.json'

describe('manifest — valid fixtures', () => {
  it.each(fixtures('examples/valid', MANIFEST_SUFFIX))('%s validates', (file) => {
    const ok = validateManifest(loadJson('examples/valid', file))
    expect(ok, JSON.stringify(validateManifest.errors, null, 2)).toBe(true)
  })

  it.each(fixtures('examples/valid', MANIFEST_SUFFIX))('%s obeys name↔filename', (file) => {
    const doc = loadJson('examples/valid', file) as { name: string }
    expect(doc.name).toBe(file.slice(0, -MANIFEST_SUFFIX.length))
  })
})

describe('manifest — invalid fixtures fail for exactly their stated reason', () => {
  const violations = loadJson('examples/invalid', 'violations.json') as Record<string, Violation>

  it('every invalid fixture has a violations.json entry, and vice versa', () => {
    expect(fixtures('examples/invalid', MANIFEST_SUFFIX).sort()).toEqual(Object.keys(violations).sort())
  })

  it.each(fixtures('examples/invalid', MANIFEST_SUFFIX))('%s', (file) => {
    const ok = validateManifest(loadJson('examples/invalid', file))
    expect(ok).toBe(false)
    expect(validateManifest.errors, JSON.stringify(validateManifest.errors, null, 2)).toHaveLength(1)
    const [err] = validateManifest.errors!
    expect({ keyword: err!.keyword, instancePath: err!.instancePath }).toEqual(violations[file])
  })

  it.each(fixtures('examples/invalid', MANIFEST_SUFFIX))(
    '%s does not accidentally violate name↔filename',
    (file) => {
      const doc = loadJson('examples/invalid', file) as Record<string, unknown>
      if (violations[file]!.instancePath !== '/name' && typeof doc.name === 'string') {
        expect(doc.name).toBe(file.slice(0, -MANIFEST_SUFFIX.length))
      }
    },
  )
})

describe('manifest — rules-only fixtures (schema-valid, §2-invalid)', () => {
  const violations = loadJson('examples/invalid-rules', 'violations.json') as Record<string, { code: string }>

  it('every rules fixture has a violations.json entry, and vice versa', () => {
    expect(fixtures('examples/invalid-rules', MANIFEST_SUFFIX).sort()).toEqual(Object.keys(violations).sort())
  })

  it.each(fixtures('examples/invalid-rules', MANIFEST_SUFFIX))('%s passes the schema', (file) => {
    // Strict-JSON violations (duplicate keys) are invisible to a plain JSON.parse, by design.
    const doc = loadJson('examples/invalid-rules', file)
    expect(validateManifest(doc), JSON.stringify(validateManifest.errors, null, 2)).toBe(true)
  })

  it.each(fixtures('examples/invalid-rules', MANIFEST_SUFFIX))('%s is rejected by the §2 rules with its stated code', (file) => {
    const text = readFileSync(join(specDir, 'examples/invalid-rules', file), 'utf8')
    const result = parseManifest(text, { filename: file })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(violations[file]!.code)
  })
})

describe('manifest — coverage', () => {
  const docs = fixtures('examples/valid', MANIFEST_SUFFIX).map(
    (f) => loadJson('examples/valid', f) as Record<string, unknown>,
  )

  it('every top-level schema property appears in a valid fixture', () => {
    for (const prop of Object.keys(manifestSchema.properties as Record<string, unknown>)) {
      expect(
        docs.some((d) => prop in d),
        `property "${prop}" is not exercised by any valid fixture`,
      ).toBe(true)
    }
  })

  it('every author sub-property appears in a valid fixture', () => {
    const authorSchema = (manifestSchema.properties as Record<string, { properties?: Record<string, unknown> }>)
      .author!
    for (const prop of Object.keys(authorSchema.properties!)) {
      expect(
        docs.some((d) => d.author != null && prop in (d.author as Record<string, unknown>)),
        `author property "${prop}" is not exercised by any valid fixture`,
      ).toBe(true)
    }
  })
})

describe('set-lock fixtures', () => {
  const violations = loadJson('examples/lock/invalid', 'violations.json') as Record<string, Violation>

  it('every invalid lock fixture has a violations.json entry, and vice versa', () => {
    expect(fixtures('examples/lock/invalid', LOCK_SUFFIX).sort()).toEqual(Object.keys(violations).sort())
  })

  it.each(fixtures('examples/lock/valid', LOCK_SUFFIX))('%s validates', (file) => {
    const doc = loadJson('examples/lock/valid', file) as { name: string }
    expect(validateLock(doc), JSON.stringify(validateLock.errors, null, 2)).toBe(true)
    expect(doc.name).toBe(file.slice(0, -LOCK_SUFFIX.length))
  })

  it.each(fixtures('examples/lock/invalid', LOCK_SUFFIX))('%s fails for exactly its stated reason', (file) => {
    expect(validateLock(loadJson('examples/lock/invalid', file))).toBe(false)
    expect(validateLock.errors, JSON.stringify(validateLock.errors, null, 2)).toHaveLength(1)
    const [err] = validateLock.errors!
    expect({ keyword: err!.keyword, instancePath: err!.instancePath }).toEqual(violations[file])
  })

  it.each(fixtures('examples/lock/valid', LOCK_SUFFIX))('%s setHash matches the §5 recipe', (file) => {
    const doc = loadJson('examples/lock/valid', file) as {
      setHash: string
      skills: Record<string, { computedHash: string }>
    }
    const sorted = Object.keys(doc.skills).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    const hash = createHash('sha256')
    for (const locator of sorted) {
      hash.update(`${locator}\n${doc.skills[locator]!.computedHash}\n`, 'utf8')
    }
    expect(doc.setHash).toBe(hash.digest('hex'))
  })

  // Fixture files hold one violation each; the empty-key case lives here because Ajv
  // reports propertyNames failures as two errors (the parent keyword and the key's own).
  it('rejects an empty locator key', () => {
    const doc = loadJson('examples/lock/valid', 'minimal.skill-set.lock.json') as { skills: Record<string, unknown> }
    const [entry] = Object.values(doc.skills)
    expect(validateLock({ ...doc, skills: { '': entry } })).toBe(false)
    expect(validateLock.errors!.map((e) => e.keyword)).toContain('propertyNames')
  })
})

describe('set-lock — coverage', () => {
  const docs = fixtures('examples/lock/valid', LOCK_SUFFIX).map(
    (f) => loadJson('examples/lock/valid', f) as Record<string, unknown>,
  )

  it('every top-level lock property appears in a valid fixture', () => {
    for (const prop of Object.keys(lockSchema.properties as Record<string, unknown>)) {
      expect(
        docs.some((d) => prop in d),
        `property "${prop}" is not exercised by any valid fixture`,
      ).toBe(true)
    }
  })

  it('every member property appears in a valid fixture', () => {
    const memberSchema = (lockSchema.properties as Record<string, { additionalProperties?: { properties?: Record<string, unknown> } }>)
      .skills!
    const entries = docs.flatMap((d) => Object.values(d.skills as Record<string, Record<string, unknown>>))
    for (const prop of Object.keys(memberSchema.additionalProperties!.properties!)) {
      expect(
        entries.some((e) => prop in e),
        `member property "${prop}" is not exercised by any valid fixture`,
      ).toBe(true)
    }
  })
})

describe('spec README examples stay in sync with the schemas', () => {
  const readme = readFileSync(join(specDir, 'README.md'), 'utf8')
  const blocks: Array<{ position: number; doc: unknown; illustrative: boolean }> = []
  for (const match of readme.matchAll(/```json\n([\s\S]*?)```/g)) {
    const before = readme.slice(0, match.index).split('\n').filter((l) => l.trim() !== '')
    blocks.push({
      position: match.index,
      doc: JSON.parse(match[1]!),
      illustrative: /illustrative/i.test(before[before.length - 1] ?? ''),
    })
  }
  const normative = blocks.filter((b) => !b.illustrative)

  it('finds the normative fenced examples', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(normative.length).toBeGreaterThanOrEqual(1)
  })

  it.each(normative.map((b) => [b.position, b] as const))('block at offset %d validates', (_pos, block) => {
    const isLock = typeof block.doc === 'object' && block.doc !== null && 'setHash' in block.doc
    const validate = isLock ? validateLock : validateManifest
    expect(validate(block.doc), JSON.stringify(validate.errors, null, 2)).toBe(true)
  })
})
