import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseTrustSource } from '../src/commands/trust.ts'
import { run } from '../src/run.ts'
import {
  CONFIG_DIR_ENV,
  findTrustedSource,
  isTrustedSource,
  loadTrustStore,
  saveTrustStore,
  TRUST_STORE_FILENAME,
  trustStorePath,
  type TrustStore,
} from '../src/trust.ts'
import type { Writer } from '../src/ui.ts'

// The user-level trust store and the `trust` command, over a temp SKILL_SET_CONFIG_DIR.

const dirs: string[] = []
const previous = process.env[CONFIG_DIR_ENV]
let configDir: string
let storePath: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'skill-set-trust-'))
  dirs.push(configDir)
  process.env[CONFIG_DIR_ENV] = configDir
  storePath = join(configDir, TRUST_STORE_FILENAME)
})
afterEach(() => {
  if (previous === undefined) delete process.env[CONFIG_DIR_ENV]
  else process.env[CONFIG_DIR_ENV] = previous
})
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const AT = '2026-11-11T00:00:00.000Z'
const storeOf = (...sources: Array<{ host: string; owner?: string }>): TrustStore => ({
  version: 1,
  sources: sources.map((source) => ({ ...source, addedAt: AT })),
})

describe('trust store location', () => {
  it('prefers SKILL_SET_CONFIG_DIR, then XDG_CONFIG_HOME/skill-set, then ~/.config/skill-set', () => {
    expect(trustStorePath({ SKILL_SET_CONFIG_DIR: '/cfg', XDG_CONFIG_HOME: '/xdg' })).toBe(join('/cfg', TRUST_STORE_FILENAME))
    expect(trustStorePath({ XDG_CONFIG_HOME: '/xdg' })).toBe(join('/xdg', 'skill-set', TRUST_STORE_FILENAME))
    expect(trustStorePath({})).toBe(join(homedir(), '.config', 'skill-set', TRUST_STORE_FILENAME))
    expect(trustStorePath({ SKILL_SET_CONFIG_DIR: '', XDG_CONFIG_HOME: '' })).toBe(join(homedir(), '.config', 'skill-set', TRUST_STORE_FILENAME))
  })

  it('is undefined when there is no override and no home directory, and does not look up the home otherwise', () => {
    const noHome = (): string => {
      throw new Error('no home')
    }
    expect(trustStorePath({}, noHome)).toBeUndefined()
    expect(trustStorePath({ XDG_CONFIG_HOME: '/xdg' }, noHome)).toBe(join('/xdg', 'skill-set', TRUST_STORE_FILENAME))
    expect(trustStorePath({ SKILL_SET_CONFIG_DIR: '/cfg' }, noHome)).toBe(join('/cfg', TRUST_STORE_FILENAME))
  })
})

describe('trust store load and save', () => {
  it('treats a missing file as an empty store', () => {
    expect(loadTrustStore()).toEqual({ ok: true, data: { version: 1, sources: [] } })
    expect(existsSync(storePath)).toBe(false)
  })

  it('round-trips through an atomic write, creating the directory and leaving no temp file', () => {
    const nested = join(configDir, 'deeper')
    process.env[CONFIG_DIR_ENV] = nested
    const store = storeOf({ host: 'sets.example.test' }, { host: 'github.com', owner: 'hcjmartin' })
    const saved = saveTrustStore(store)
    expect(saved).toEqual({ ok: true, data: join(nested, TRUST_STORE_FILENAME) })
    expect(readdirSync(nested)).toEqual([TRUST_STORE_FILENAME])
    expect(loadTrustStore()).toEqual({ ok: true, data: store })
    expect(readFileSync(join(nested, TRUST_STORE_FILENAME), 'utf8').endsWith('}\n')).toBe(true)
  })

  it.each([
    ['not JSON', '{ nope'],
    ['an unknown version', '{"version":2,"sources":[]}'],
    ['a wrong shape', '{"version":1,"sources":[{"host":"a.test"}]}'],
    ['an unknown key', '{"version":1,"sources":[],"extra":true}'],
    ['a non-object', '[]'],
  ])('fails clearly on %s and leaves the file untouched', (_label, text) => {
    writeFileSync(storePath, text)
    const loaded = loadTrustStore()
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('ERR_SKILLSET_INVALID_TRUST_STORE')
      expect(loaded.error.message).toContain(storePath)
      expect(loaded.error.data).toMatchObject({ path: storePath })
    }
    expect(readFileSync(storePath, 'utf8')).toBe(text)
  })
})

describe('isTrustedSource', () => {
  it('matches a host entry exactly and case-insensitively', () => {
    const store = storeOf({ host: 'sets.example.test' })
    expect(isTrustedSource('https://sets.example.test/a.skill-set.json', store)).toBe(true)
    expect(isTrustedSource('https://SETS.Example.Test/a.skill-set.json', store)).toBe(true)
    expect(isTrustedSource('https://sets.example.test.evil.test/a.skill-set.json', store)).toBe(false)
    expect(isTrustedSource('https://sub.sets.example.test/a.skill-set.json', store)).toBe(false)
    // A hand-edited upper-case entry still matches.
    expect(isTrustedSource('https://sets.example.test/a', storeOf({ host: 'Sets.Example.Test' }))).toBe(true)
  })

  it('treats the port as part of the host', () => {
    const store = storeOf({ host: 'sets.example.test:8443' })
    expect(isTrustedSource('https://sets.example.test:8443/a', store)).toBe(true)
    expect(isTrustedSource('https://sets.example.test/a', store)).toBe(false)
    expect(isTrustedSource('https://sets.example.test:8443/a', storeOf({ host: 'sets.example.test' }))).toBe(false)
  })

  it('matches host + owner on a GitHub host only for that owner, case-insensitively', () => {
    const store = storeOf({ host: 'raw.githubusercontent.com', owner: 'hcjmartin' })
    expect(isTrustedSource('https://raw.githubusercontent.com/hcjmartin/sets/main/a.skill-set.json', store)).toBe(true)
    expect(isTrustedSource('https://raw.githubusercontent.com/HCJMartin/sets/main/a.skill-set.json', store)).toBe(true)
    expect(isTrustedSource('https://raw.githubusercontent.com/someone-else/sets/main/a.skill-set.json', store)).toBe(false)
    expect(isTrustedSource('https://raw.githubusercontent.com/hcjmartin-evil/sets/a.skill-set.json', store)).toBe(false)
    expect(isTrustedSource('https://raw.githubusercontent.com/', store)).toBe(false)
    // The entry is per host: the same owner on another GitHub host is not covered.
    expect(isTrustedSource('https://github.com/hcjmartin/sets/a.skill-set.json', store)).toBe(false)
  })

  it('a host-only entry on a GitHub host trusts every owner there', () => {
    const store = storeOf({ host: 'github.com' })
    expect(isTrustedSource('https://github.com/anyone/sets/a.skill-set.json', store)).toBe(true)
    expect(findTrustedSource('https://github.com/anyone/sets/a.skill-set.json', store)).toMatchObject({ host: 'github.com' })
  })

  it('ignores an owner entry on a non-GitHub host', () => {
    const store = storeOf({ host: 'sets.example.test', owner: 'team' })
    expect(isTrustedSource('https://sets.example.test/team/a.skill-set.json', store)).toBe(false)
    expect(isTrustedSource('https://sets.example.test/a.skill-set.json', store)).toBe(false)
  })

  it('never trusts a non-https or unparseable source', () => {
    const store = storeOf({ host: 'sets.example.test' })
    expect(isTrustedSource('http://sets.example.test/a', store)).toBe(false)
    expect(isTrustedSource('sets.example.test/a', store)).toBe(false)
    expect(isTrustedSource('./a.skill-set.json', store)).toBe(false)
  })
})

describe('parseTrustSource', () => {
  it('derives the scope from a manifest URL, a bare host, or host/owner', () => {
    expect(parseTrustSource('https://Sets.Example.Test/team/a.skill-set.json')).toEqual({ ok: true, data: { host: 'sets.example.test' } })
    expect(parseTrustSource('https://raw.githubusercontent.com/hcjmartin/sets/main/a.skill-set.json')).toEqual({
      ok: true,
      data: { host: 'raw.githubusercontent.com', owner: 'hcjmartin' },
    })
    expect(parseTrustSource('sets.example.test:8443')).toEqual({ ok: true, data: { host: 'sets.example.test:8443' } })
    expect(parseTrustSource('GitHub.com/hcjmartin')).toEqual({ ok: true, data: { host: 'github.com', owner: 'hcjmartin' } })
    expect(parseTrustSource('github.com')).toEqual({ ok: true, data: { host: 'github.com' } })
  })

  it.each(['sets.example.test/team', 'github.com/hcjmartin/sets', 'http://sets.example.test/a', 'ftp://sets.example.test', 'https://', 'a b', 'github.com/hcjmartin?x=1'])(
    'rejects %s as a usage error',
    (raw) => {
      const parsed = parseTrustSource(raw)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error.code).toBe('ERR_SKILLSET_USAGE')
    },
  )
})

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const stdout: Writer = { write: (s: string) => (out += s) }
  const stderr: Writer = { write: (s: string) => (err += s) }
  const code = await run(argv, { interactive: false, ci: false, stdout, stderr })
  return { code, out, err }
}

function stored(): TrustStore {
  return JSON.parse(readFileSync(storePath, 'utf8')) as TrustStore
}

describe('skill-set trust', () => {
  it('adds a host, reports a duplicate, and never writes it twice', async () => {
    const added = await cli(['trust', 'Sets.Example.Test'])
    expect(added.code).toBe(0)
    expect(added.out).toContain('Trusting "sets.example.test"')
    expect(stored().sources).toHaveLength(1)
    expect(stored().sources[0]).toMatchObject({ host: 'sets.example.test' })
    expect(Number.isNaN(Date.parse(stored().sources[0]!.addedAt))).toBe(false)

    const again = await cli(['trust', 'https://sets.example.test/a.skill-set.json'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('already a trusted source')
    expect(stored().sources).toHaveLength(1)
  })

  it('adds host/owner from a GitHub manifest URL, and warns when a whole GitHub host is trusted', async () => {
    const owner = await cli(['trust', 'https://raw.githubusercontent.com/hcjmartin/sets/main/a.skill-set.json'])
    expect(owner.code).toBe(0)
    expect(owner.out).toContain('Trusting "raw.githubusercontent.com/hcjmartin"')
    expect(owner.err).toBe('')
    expect(stored().sources[0]).toMatchObject({ host: 'raw.githubusercontent.com', owner: 'hcjmartin' })

    const whole = await cli(['trust', 'github.com'])
    expect(whole.code).toBe(0)
    expect(whole.err).toContain('every account')
    expect(stored().sources).toHaveLength(2)
  })

  it('--json returns the added entry, then the existing one', async () => {
    const added = await cli(['trust', 'github.com/hcjmartin', '--json'])
    const first = JSON.parse(added.out) as { ok: boolean; command: string; data: { added: { host: string; owner: string; addedAt: string }; path: string } }
    expect(first).toMatchObject({ ok: true, command: 'trust', data: { added: { host: 'github.com', owner: 'hcjmartin' }, path: storePath } })

    const again = JSON.parse((await cli(['trust', 'github.com/HCJMartin', '--json'])).out) as { data: unknown }
    expect(again.data).toEqual({ added: null, existing: first.data.added, path: storePath })
  })

  it('treats a built-in provider as already trusted and refuses to remove it', async () => {
    const added = JSON.parse((await cli(['trust', 'skill-sets.md', '--json'])).out) as { data: unknown }
    expect(added.data).toEqual({ added: null, existing: { host: 'skill-sets.md', builtIn: true }, path: storePath })
    expect(existsSync(storePath)).toBe(false)
    expect((await cli(['trust', '--remove', 'skill-sets.md'])).code).toBe(2)
  })

  it('--list prints built-in providers and stored entries', async () => {
    await cli(['trust', 'sets.example.test'])
    await cli(['trust', 'github.com/hcjmartin'])
    const human = await cli(['trust', '--list'])
    expect(human.code).toBe(0)
    expect(human.out).toContain('skill-set.md (built-in)')
    expect(human.out).toContain('skill-sets.md (built-in)')
    expect(human.out).toContain('sets.example.test (added ')
    expect(human.out).toContain('github.com/hcjmartin (added ')
    expect(human.out).toContain(`2 trusted sources in ${storePath}`)

    const listed = JSON.parse((await cli(['trust', '--list', '--json'])).out) as { data: { sources: Array<Record<string, unknown>>; path: string } }
    expect(listed.data.path).toBe(storePath)
    expect(listed.data.sources).toEqual([
      { host: 'skill-set.md', builtIn: true },
      { host: 'skill-sets.md', builtIn: true },
      { host: 'sets.example.test', addedAt: expect.any(String) as string },
      { host: 'github.com', owner: 'hcjmartin', addedAt: expect.any(String) as string },
    ])
  })

  it('--remove removes exactly the named entry; removing an absent one changes nothing', async () => {
    await cli(['trust', 'github.com/hcjmartin'])
    await cli(['trust', 'github.com'])

    const removed = JSON.parse((await cli(['trust', '--remove', 'github.com/HCJMartin', '--json'])).out) as { data: { removed: unknown } }
    expect(removed.data.removed).toMatchObject({ host: 'github.com', owner: 'hcjmartin' })
    expect(stored().sources).toEqual([expect.objectContaining({ host: 'github.com' })])
    expect('owner' in stored().sources[0]!).toBe(false)

    const absent = await cli(['trust', '--remove=sets.example.test'])
    expect(absent.code).toBe(0)
    expect(absent.out).toContain('not a trusted source')
    expect(stored().sources).toHaveLength(1)

    expect((await cli(['trust', '--remove', 'github.com'])).out).toContain('No longer trusting "github.com"')
    expect(stored().sources).toEqual([])
  })

  it('--dry-run writes nothing', async () => {
    const added = await cli(['trust', 'sets.example.test', '--dry-run'])
    expect(added.code).toBe(0)
    expect(added.out).toContain('would trust: "sets.example.test"')
    expect(existsSync(storePath)).toBe(false)

    await cli(['trust', 'sets.example.test'])
    expect((await cli(['trust', '--remove', 'sets.example.test', '--dry-run'])).out).toContain('would remove')
    expect(stored().sources).toHaveLength(1)
  })

  it.each([
    [['trust']],
    [['trust', 'a.test', 'b.test']],
    [['trust', '--list', 'a.test']],
    [['trust', '--remove']],
    [['trust', '--remove', 'a.test', 'b.test']],
    [['trust', '--nope']],
    [['trust', 'sets.example.test/team']],
    [['trust', 'http://sets.example.test/a.skill-set.json']],
  ])('usage error (exit 2) for %j', async (argv) => {
    const { code, err } = await cli(argv)
    expect(code).toBe(2)
    expect(err).toContain('Usage: skill-set trust')
    expect(existsSync(storePath)).toBe(false)
  })

  it('fails on a malformed store without rewriting it', async () => {
    writeFileSync(storePath, '{"version":1}')
    const { code, out } = await cli(['trust', 'sets.example.test', '--json'])
    expect(code).toBe(1)
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('ERR_SKILLSET_INVALID_TRUST_STORE')
    expect(readFileSync(storePath, 'utf8')).toBe('{"version":1}')
  })

  it('is listed in --help', async () => {
    expect((await cli(['--help'])).out).toContain('trust <source>')
  })
})
