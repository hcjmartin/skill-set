import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setHash } from '../src/hash.ts'
import type { SkillSetLock } from '../src/lock.ts'

const fixturesDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'spec',
  'draft',
  'examples',
  'lock',
  'valid',
)

const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.skill-set.lock.json'))
  .map((f) => ({ file: f, lock: JSON.parse(readFileSync(join(fixturesDir, f), 'utf8')) as SkillSetLock }))

describe('SkillSetLock', () => {
  it('covers every valid lock fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const { lock } of fixtures) {
      expect(lock.version).toBe(1)
      expect(typeof lock.name).toBe('string')
      expect(typeof lock.setVersion).toBe('string')
      expect(lock.setHash).toMatch(/^[a-f0-9]{64}$/)
      for (const member of Object.values(lock.skills)) {
        expect(typeof member.skill).toBe('string')
        expect(member.computedHash).toMatch(/^[a-f0-9]{64}$/)
      }
    }
  })

  it.each(fixtures)('reproduces the recorded setHash of $file', async ({ lock }) => {
    const members = Object.fromEntries(
      Object.entries(lock.skills).map(([locator, member]) => [locator, member.computedHash]),
    )
    expect(await setHash(members)).toBe(lock.setHash)
  })
})
