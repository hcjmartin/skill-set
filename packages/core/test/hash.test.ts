import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FOLDER_HASH_ALGORITHM,
  SET_HASH_ALGORITHM,
  compatFolderHash,
  folderHashInput,
  setHash,
  setHashInput,
  skillMarkdownFolderHash,
  specFolderHash,
  type SkillFile,
} from '../src/hash.ts'

// The spec's golden vectors are the acceptance criteria (spec §8); this suite is
// primarily vector-driven so core stays the reference implementation of them.
const vectorsDir = join(import.meta.dirname, '..', '..', '..', 'spec', 'draft', 'examples', 'hash')

interface FolderVector {
  name: string
  files: { path: string; contentUtf8?: string; contentBase64?: string }[]
  expected: string
}
interface SetVector {
  name: string
  members: Record<string, string>
  expected: string
}

function readVectors<T>(file: string): { algorithm: string; vectors: T[] } {
  return JSON.parse(readFileSync(join(vectorsDir, file), 'utf8'))
}

function toSkillFiles(files: FolderVector['files']): SkillFile[] {
  return files.map((f) => ({
    path: f.path,
    bytes:
      f.contentBase64 !== undefined
        ? new Uint8Array(Buffer.from(f.contentBase64, 'base64'))
        : new TextEncoder().encode(f.contentUtf8),
  }))
}

const folderSuite = readVectors<FolderVector>('folder-hash-vectors.json')
const setSuite = readVectors<SetVector>('set-hash-vectors.json')

describe('spec golden vectors', () => {
  it('names the algorithms the vectors are recorded under', () => {
    expect(folderSuite.algorithm).toBe(FOLDER_HASH_ALGORITHM)
    expect(setSuite.algorithm).toBe(SET_HASH_ALGORITHM)
    expect(FOLDER_HASH_ALGORITHM).toBe('skill-set/folder-v1')
    expect(SET_HASH_ALGORITHM).toBe('skill-set/set-v1')
  })

  it.each(folderSuite.vectors)('folder: $name', async ({ files, expected }) => {
    expect(await specFolderHash(toSkillFiles(files))).toBe(expected)
    // Input order must not matter — only the sorted canonical order does.
    expect(await specFolderHash(toSkillFiles(files).reverse())).toBe(expected)
  })

  it.each(setSuite.vectors)('set: $name', async ({ members, expected }) => {
    expect(await setHash(members)).toBe(expected)
  })
})

describe('specFolderHash', () => {
  it('does not mutate the caller’s file array', async () => {
    const files = toSkillFiles([
      { path: 'b.txt', contentUtf8: 'beta\n' },
      { path: 'a.txt', contentUtf8: 'alpha\n' },
    ])
    await specFolderHash(files)
    expect(files.map((f) => f.path)).toEqual(['b.txt', 'a.txt'])
  })

  it('normalizes NFD and NFC path spellings to the same digest', async () => {
    const bytes = new TextEncoder().encode('x\n')
    const nfc = await specFolderHash([{ path: '\u00e9.txt', bytes }])
    const nfd = await specFolderHash([{ path: 'e\u0301.txt', bytes }])
    expect(nfd).toBe(nfc)
  })

  it('rewrites backslashes to "/", matching the reference adapters', async () => {
    const bytes = new TextEncoder().encode('x\n')
    expect(await specFolderHash([{ path: 'weird\\name.txt', bytes }])).toBe(
      await specFolderHash([{ path: 'weird/name.txt', bytes }]),
    )
  })
})

describe('skillMarkdownFolderHash', () => {
  it('equals the folder hash of a lone SKILL.md (the single-skill-md vector)', async () => {
    const vector = folderSuite.vectors.find((v) => v.name === 'single-skill-md')!
    expect(await skillMarkdownFolderHash(vector.files[0]!.contentUtf8!)).toBe(vector.expected)
  })
})

describe('input framings', () => {
  it('folderHashInput yields the exact §6 byte sequence (digestable synchronously)', async () => {
    const files = toSkillFiles([
      { path: 'a.txt', contentUtf8: 'alpha\n' },
      { path: 'sub/c.txt', contentUtf8: 'gamma\n' },
    ])
    const sync = createHash('sha256')
    for (const chunk of folderHashInput(files)) sync.update(chunk)
    expect(sync.digest('hex')).toBe(await specFolderHash(files))
  })

  it('setHashInput yields the exact §5 byte sequence', async () => {
    const members = { beta: 'b'.repeat(64), alpha: 'a'.repeat(64) }
    const sync = createHash('sha256')
    for (const chunk of setHashInput(members)) sync.update(chunk)
    expect(sync.digest('hex')).toBe(await setHash(members))
  })
})

describe('compatFolderHash (interop, not a spec algorithm)', () => {
  it('matches an independently framed digest: locale sort, no NFC, no framing', async () => {
    const files: SkillFile[] = [
      { path: 'B.txt', bytes: new TextEncoder().encode('big\n') },
      { path: 'a.txt', bytes: new TextEncoder().encode('small\n') },
    ]
    // Guard the collation assumption the expectation is framed under.
    expect(['B.txt', 'a.txt'].sort((a, b) => a.localeCompare(b))).toEqual(['a.txt', 'B.txt'])
    const expected = createHash('sha256')
    expected.update('a.txt', 'utf8')
    expected.update('small\n', 'utf8')
    expected.update('B.txt', 'utf8')
    expected.update('big\n', 'utf8')
    expect(await compatFolderHash(files)).toBe(expected.digest('hex'))
  })

  it('diverges from the spec hash where locale and byte order disagree', async () => {
    const files: SkillFile[] = [
      { path: 'B.txt', bytes: new TextEncoder().encode('big\n') },
      { path: 'a.txt', bytes: new TextEncoder().encode('small\n') },
    ]
    expect(await compatFolderHash(files)).not.toBe(await specFolderHash(files))
  })
})
