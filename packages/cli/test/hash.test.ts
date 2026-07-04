import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compatFolderHash, setHash, specFolderHash } from '../src/hash.ts'

// Expected digests computed independently with `printf | shasum -a 256`, not with this code.
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const BASIC_SPEC = '838c47b6f4afe59206c87063181e49cf43f8f3a7d89f276dd208e5074bba8c22'
const BASIC_COMPAT = '32e73fd019f14b155a134f4d484c9e567c431712d800d7465c0f9047a91ebacc'
const CASE_SPEC = '51a197dc7e4e1b029ce47153ab466c36998f5807cc79473406c1a337ab8ee52d'
const CASE_COMPAT = 'cf0a7152a5896cae10d7d09a4fcbd58e06ffed775d0a4e2179edf3bf37048b90'
const SET_HASH = 'eec2eccf9a66a06dda6bd61db3414acca5d66d8edb0de8fe1dc63d2ff808f521'

const dirs: string[] = []

function tmpFolder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-set-hash-'))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('specFolderHash', () => {
  it('matches the independent vector for a nested folder', () => {
    const dir = tmpFolder({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'sub/c.txt': 'gamma\n' })
    expect(specFolderHash(dir)).toBe(BASIC_SPEC)
  })

  it('hashes an empty folder to SHA-256 of empty input (spec §6.5)', () => {
    expect(specFolderHash(tmpFolder({}))).toBe(EMPTY)
  })

  it('sorts by UTF-8 byte order, not locale order', () => {
    // Byte order puts B.txt (0x42) before a.txt (0x61); locale order is the reverse.
    const dir = tmpFolder({ 'a.txt': 'small\n', 'B.txt': 'big\n' })
    expect(specFolderHash(dir)).toBe(CASE_SPEC)
  })

  it('skips .git and node_modules directories and symlinks', () => {
    const dir = tmpFolder({
      'a.txt': 'alpha\n',
      'b.txt': 'beta\n',
      'sub/c.txt': 'gamma\n',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'node_modules/x/package.json': '{}\n',
      'sub/node_modules/y.txt': 'nested\n',
    })
    symlinkSync(join(dir, 'a.txt'), join(dir, 'link.txt'))
    expect(specFolderHash(dir)).toBe(BASIC_SPEC)
  })

  it('includes metadata.json (unlike the upstream installer copy)', () => {
    const withMeta = tmpFolder({ 'SKILL.md': 'x\n', 'metadata.json': '{}\n' })
    const without = tmpFolder({ 'SKILL.md': 'x\n' })
    expect(specFolderHash(withMeta)).not.toBe(specFolderHash(without))
  })

  it('framing distinguishes path/content boundaries', () => {
    const a = tmpFolder({ ab: 'c' })
    const b = tmpFolder({ a: 'bc' })
    expect(specFolderHash(a)).not.toBe(specFolderHash(b))
  })

  it('is stable across repeated runs', () => {
    const dir = tmpFolder({ 'a.txt': 'alpha\n', 'sub/c.txt': 'gamma\n' })
    expect(specFolderHash(dir)).toBe(specFolderHash(dir))
  })

  it('sorts by UTF-8 bytes, not UTF-16 code units (astral vs BMP filenames)', () => {
    // U+FFFD (ef bf bd) precedes U+1F600 (f0 9f 98 80) in UTF-8 bytes, but JS default
    // sort compares UTF-16 code units, where the surrogate pair (d83d…) comes first.
    const grin = '\u{1F600}.txt'
    const replacement = '�.txt'
    expect([grin, replacement].sort()).toEqual([grin, replacement])
    const dir = tmpFolder({ [grin]: 'g\n', [replacement]: 'r\n' })
    const expected = createHash('sha256')
    for (const [name, content] of [
      [replacement, 'r\n'],
      [grin, 'g\n'],
    ] as const) {
      expected.update(name, 'utf8')
      expected.update(Buffer.from([0]))
      expected.update(content, 'utf8')
      expected.update(Buffer.from([0]))
    }
    expect(specFolderHash(dir)).toBe(expected.digest('hex'))
  })
})

describe('compatFolderHash', () => {
  it('matches the independent vector (localeCompare order, no framing)', () => {
    const dir = tmpFolder({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n', 'sub/c.txt': 'gamma\n' })
    expect(compatFolderHash(dir)).toBe(BASIC_COMPAT)
  })

  it('orders by locale, diverging from the spec hash order', () => {
    const dir = tmpFolder({ 'a.txt': 'small\n', 'B.txt': 'big\n' })
    // Guard the environment assumption the vector was computed under.
    expect(['B.txt', 'a.txt'].sort((a, b) => a.localeCompare(b))).toEqual(['a.txt', 'B.txt'])
    expect(compatFolderHash(dir)).toBe(CASE_COMPAT)
  })
})

describe('setHash', () => {
  it('matches the independent vector, sorting locators by UTF-8 bytes', () => {
    expect(
      setHash({
        beta: 'b'.repeat(64),
        alpha: 'a'.repeat(64),
      }),
    ).toBe(SET_HASH)
  })

  it('is insertion-order independent', () => {
    const a = setHash({ x: '1'.repeat(64), y: '2'.repeat(64) })
    const b = setHash({ y: '2'.repeat(64), x: '1'.repeat(64) })
    expect(a).toBe(b)
  })
})
