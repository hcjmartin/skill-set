import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { INDEX_FILENAME } from '../src/generate.ts'
import { parseSetLock } from '../src/lock.ts'
import { SETS_DIR } from '../src/project.ts'
import { SKILLS_DIR, type CommandRunner } from '../src/resolver.ts'
import { run, type RunOverrides } from '../src/run.ts'
import type { Writer } from '../src/ui.ts'

// End-to-end command tests over real tmp projects, hermetic via a stateful fake of the
// pinned upstream CLI: add installs a folder + lock entry, update rewrites content,
// remove deletes both, check exits 0. Every spawn is captured for invocation asserts.

const dirs: string[] = []
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-set-cli-'))
  dirs.push(cwd)
  return cwd
}

interface FakeSkills {
  runner: CommandRunner
  calls: string[][]
  captureFlags: Array<boolean | undefined>
}

function fakeSkills(cwd: string): FakeSkills {
  const calls: string[][] = []
  const captureFlags: Array<boolean | undefined> = []
  const lockPath = join(cwd, 'skills-lock.json')
  const readLock = (): { version: number; skills: Record<string, Record<string, string>> } =>
    existsSync(lockPath)
      ? (JSON.parse(readFileSync(lockPath, 'utf8')) as ReturnType<typeof readLock>)
      : { version: 1, skills: {} }
  const writeLock = (lock: unknown): void => writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  const ok = { ok: true as const, data: { exitCode: 0, stdout: '', stderr: '' } }

  const runner: CommandRunner = async (command, args, opts) => {
    calls.push([command, ...args])
    captureFlags.push(opts?.capture)
    const verb = args[2]
    if (verb === 'add') {
      const sourceArg = args[3]!
      const hashAt = sourceArg.lastIndexOf('#')
      const source = hashAt > 0 ? sourceArg.slice(0, hashAt) : sourceArg
      const ref = hashAt > 0 ? sourceArg.slice(hashAt + 1) : undefined
      const skillFlag = args.indexOf('--skill')
      const skill = skillFlag === -1 ? source.split('/').pop()! : args[skillFlag + 1]!
      const folder = join(cwd, SKILLS_DIR, skill)
      mkdirSync(folder, { recursive: true })
      writeFileSync(
        join(folder, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: "Does ${skill} things. Use when ${skill} work comes up."\n---\n\nBody of ${skill}.\n`,
      )
      const lock = readLock()
      lock.skills[skill] = { source, sourceType: 'github', computedHash: 'f'.repeat(64), ...(ref === undefined ? {} : { ref }) }
      writeLock(lock)
      return ok
    }
    if (verb === 'update') {
      for (const skill of args.slice(3).filter((a) => !a.startsWith('-'))) {
        appendFileSync(join(cwd, SKILLS_DIR, skill, 'SKILL.md'), '\nUpdated content.\n')
      }
      return ok
    }
    if (verb === 'remove') {
      const lock = readLock()
      for (const skill of args.slice(3).filter((a) => !a.startsWith('-'))) {
        rmSync(join(cwd, SKILLS_DIR, skill), { recursive: true, force: true })
        delete lock.skills[skill]
      }
      writeLock(lock)
      return ok
    }
    if (verb === 'check') return ok
    return { ok: true, data: { exitCode: 2, stdout: '', stderr: '' } }
  }
  return { runner, calls, captureFlags }
}

interface CliResult {
  code: number
  out: string
  err: string
}

async function cli(cwd: string, fake: FakeSkills, argv: string[], extra: Partial<RunOverrides> = {}): Promise<CliResult> {
  let out = ''
  let err = ''
  const stdout: Writer = { write: (s: string) => (out += s) }
  const stderr: Writer = { write: (s: string) => (err += s) }
  const code = await run(argv, {
    cwd,
    runner: fake.runner,
    interactive: false,
    ci: false,
    stdout,
    stderr,
    ...extra,
  })
  return { code, out, err }
}

describe('authoring round-trip: init → install → lock → build → verify → drift → update', () => {
  const cwd = project()
  const fake = fakeSkills(cwd)
  const setDir = join(cwd, SETS_DIR, 'my-tools')

  it('init scaffolds the manifest', async () => {
    const { code } = await cli(cwd, fake, ['init', 'my-tools', 'acme/alpha-repo@alpha', 'acme/beta-repo'])
    expect(code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(setDir, 'my-tools.skill-set.json'), 'utf8')) as { skills: string[] }
    expect(manifest.skills).toEqual(['acme/alpha-repo@alpha', 'acme/beta-repo'])
  })

  it('init refuses to overwrite an existing set', async () => {
    const { code, err } = await cli(cwd, fake, ['init', 'my-tools', 'acme/other-repo@other'])
    expect(code).toBe(1)
    expect(err).toContain('already exists')
  })

  it('install resolves every member through the pinned upstream', async () => {
    const { code, out } = await cli(cwd, fake, ['install', 'my-tools'])
    expect(code).toBe(0)
    expect(out).toContain('2 installed, 0 skipped, 0 failed')
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'beta-repo'))).toBe(true)
    // Named member forwards --skill; both spawns are the pinned invocation.
    expect(fake.calls[0]).toEqual(['npx', '-y', 'skills@1.5', 'add', 'acme/alpha-repo', '--skill', 'alpha', '--yes'])
    expect(fake.calls[1]).toEqual(['npx', '-y', 'skills@1.5', 'add', 'acme/beta-repo', '--yes'])
  })

  it('lock records the installed content', async () => {
    const { code } = await cli(cwd, fake, ['lock', 'my-tools'])
    expect(code).toBe(0)
    const lock = parseSetLock(readFileSync(join(setDir, 'my-tools.skill-set.lock.json'), 'utf8'))
    expect(lock.ok).toBe(true)
    if (lock.ok) expect(Object.keys(lock.data.skills)).toHaveLength(2)
  })

  it('a second install skips every lock-satisfied member without spawning', async () => {
    const spawnsBefore = fake.calls.length
    const { code, out } = await cli(cwd, fake, ['install', 'my-tools'])
    expect(code).toBe(0)
    expect(out).toContain('0 installed, 2 skipped, 0 failed')
    expect(fake.calls.length).toBe(spawnsBefore)
  })

  it('build writes the discovery page and the index, reusing member descriptions', async () => {
    const { code } = await cli(cwd, fake, ['build'])
    expect(code).toBe(0)
    const page = readFileSync(join(setDir, 'SKILL-SET.md'), 'utf8')
    expect(page).toContain('| `alpha` | Does alpha things. Use when alpha work comes up. |')
    expect(page).toContain('Locked at set version 0.1.0.')
    const index = JSON.parse(readFileSync(join(cwd, SETS_DIR, INDEX_FILENAME), 'utf8')) as { sets: Record<string, unknown> }
    expect(Object.keys(index.sets)).toEqual(['my-tools'])
  })

  it('verify passes in both modes while content matches the lock', async () => {
    expect((await cli(cwd, fake, ['verify', 'my-tools'])).code).toBe(0)
    expect((await cli(cwd, fake, ['verify', 'my-tools', '--frozen'])).code).toBe(0)
  })

  it('frozen verify names every drifted member and exits 3', async () => {
    appendFileSync(join(cwd, SKILLS_DIR, 'alpha', 'SKILL.md'), 'tampered\n')
    const { code, err } = await cli(cwd, fake, ['verify', 'my-tools', '--frozen'])
    expect(code).toBe(3)
    expect(err).toContain('acme/alpha-repo@alpha')
    expect(err).toContain('content drifted — expected')
    // Default mode does not recompute content, so it stays green and says so.
    const soft = await cli(cwd, fake, ['verify', 'my-tools'])
    expect(soft.code).toBe(0)
    expect(soft.out).toContain('Content hashes were not recomputed')
  })

  it('in CI, verify defaults to frozen when a lock exists', async () => {
    const { code } = await cli(cwd, fake, ['verify', 'my-tools'], { ci: true })
    expect(code).toBe(3)
    expect((await cli(cwd, fake, ['verify', 'my-tools', '--no-frozen'], { ci: true })).code).toBe(0)
  })

  it('update delegates to the pinned upstream and re-locks', async () => {
    const before = parseSetLock(readFileSync(join(setDir, 'my-tools.skill-set.lock.json'), 'utf8'))
    const { code } = await cli(cwd, fake, ['update', 'my-tools'])
    expect(code).toBe(0)
    expect(fake.calls.at(-1)).toEqual(['npx', '-y', 'skills@1.5', 'update', 'alpha', 'beta-repo', '-p', '--yes'])
    const after = parseSetLock(readFileSync(join(setDir, 'my-tools.skill-set.lock.json'), 'utf8'))
    expect(before.ok && after.ok && before.data.setHash !== after.data.setHash).toBe(true)
    // The re-lock accepted the updated bytes, so frozen verify is green again.
    expect((await cli(cwd, fake, ['verify', 'my-tools', '--frozen'])).code).toBe(0)
  })

  it('passthrough args after -- reach the upstream spawn verbatim', async () => {
    const other = project()
    const otherFake = fakeSkills(other)
    await cli(other, otherFake, ['init', 'p', 'acme/x-repo@x'])
    await cli(other, otherFake, ['install', 'p', '--', '--verbose'])
    expect(otherFake.calls[0]).toEqual(['npx', '-y', 'skills@1.5', 'add', 'acme/x-repo', '--skill', 'x', '--yes', '--verbose'])
  })
})

describe('cross-set conflicts', () => {
  it('two sets pinning one source differently abort install with exit 4', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'acme/shared-repo@tool#v1'])
    await cli(cwd, fake, ['init', 'two', 'acme/shared-repo@tool#v2'])
    const { code, err } = await cli(cwd, fake, ['install', 'one'])
    expect(code).toBe(4)
    expect(err).toContain('pinned differently across sets')
    expect(err).toContain('"one" pins v1')
    expect(err).toContain('"two" pins v2')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('remove', () => {
  it('needs confirmation, honours --yes, and reference-counts shared skills', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'acme/alpha-repo@alpha', 'acme/beta-repo@beta'])
    await cli(cwd, fake, ['init', 'two', 'acme/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'one'])
    await cli(cwd, fake, ['install', 'two'])

    // Non-interactive without --yes: refuse rather than hang or guess (precondition → exit 2).
    const refused = await cli(cwd, fake, ['remove', 'one'])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('--yes')
    expect(existsSync(join(cwd, SETS_DIR, 'one'))).toBe(true)

    const removed = await cli(cwd, fake, ['remove', 'one', '--skills', '--yes'])
    expect(removed.code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'one'))).toBe(false)
    // alpha is shared with set "two" and survives; beta was exclusive and is gone.
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'beta'))).toBe(false)
    expect(removed.out).toContain('kept alpha: shared with another set')
    const index = JSON.parse(readFileSync(join(cwd, SETS_DIR, INDEX_FILENAME), 'utf8')) as { sets: Record<string, unknown> }
    expect(Object.keys(index.sets)).toEqual(['two'])
  })

  it('keeps a skill whose sibling member is unlocatable but names the same source', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'acme/alpha-repo@alpha'])
    // Set "two" pins the same source to a ref that never installed, so locateMember fails
    // for it — the source-level fallback must still count the skill as shared.
    await cli(cwd, fake, ['init', 'two', 'acme/alpha-repo#v9'])
    await cli(cwd, fake, ['install', 'one'])
    const { code, out } = await cli(cwd, fake, ['remove', 'one', '--skills', '--yes'])
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(out).toContain('kept alpha: shared with another set (same source)')
  })
})

describe('add', () => {
  const manifestText = `${JSON.stringify(
    { name: 'fetched-set', version: '1.0.0', description: 'A shared set.', skills: ['acme/gamma-repo@gamma'] },
    null,
    2,
  )}\n`
  const fetcher = async (url: string) =>
    url === 'https://example.test/fetched-set.skill-set.json'
      ? { ok: true as const, data: manifestText }
      : { ok: false as const, error: new Error('unexpected url') as never }

  it('fetches, summarises, requires confirmation, then installs', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)

    const refused = await cli(cwd, fake, ['add', 'https://example.test/fetched-set.skill-set.json'], { fetcher })
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('--yes')
    expect(existsSync(join(cwd, SETS_DIR, 'fetched-set'))).toBe(false)

    const added = await cli(cwd, fake, ['add', 'https://example.test/fetched-set.skill-set.json', '--yes'], { fetcher })
    expect(added.code).toBe(0)
    expect(added.out).toContain('Set "fetched-set" v1.0.0 — A shared set.')
    // Written verbatim: the fetched bytes are exactly what lands on disk.
    expect(readFileSync(join(cwd, SETS_DIR, 'fetched-set', 'fetched-set.skill-set.json'), 'utf8')).toBe(manifestText)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(true)

    const repeat = await cli(cwd, fake, ['add', 'https://example.test/fetched-set.skill-set.json', '--yes'], { fetcher })
    expect(repeat.code).toBe(1)
    expect(repeat.err).toContain('already exists')
  })

  it('rejects plain http sources', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['add', 'http://example.test/set.skill-set.json'])
    expect(code).toBe(1)
    expect(err).toContain('HTTPS only')
  })
})

describe('--json mode', () => {
  it('emits exactly one JSON object on stdout, even mid-flow, and captures spawn output', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'j', 'acme/alpha-repo@alpha'])
    expect(fake.captureFlags).toHaveLength(0)
    const { code, out } = await cli(cwd, fake, ['install', 'j', '--json'])
    expect(code).toBe(0)
    const lines = out.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0]!) as { ok: boolean; command: string; data: { installed: unknown[] } }
    expect(envelope).toMatchObject({ ok: true, command: 'install' })
    expect(envelope.data.installed).toHaveLength(1)
    // Every upstream spawn under --json runs captured, so child output cannot corrupt stdout.
    expect(fake.captureFlags).toEqual([true])
    const human = await cli(cwd, fake, ['verify', 'j'])
    expect(human.code).toBe(0)
    expect(fake.captureFlags.at(-1)).not.toBe(true)
  })

  it('maps a drift error to the envelope and exit 3', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'j', 'acme/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'j'])
    await cli(cwd, fake, ['lock', 'j'])
    appendFileSync(join(cwd, SKILLS_DIR, 'alpha', 'SKILL.md'), 'drift\n')
    const { code, out } = await cli(cwd, fake, ['verify', 'j', '--frozen', '--json'])
    expect(code).toBe(3)
    const envelope = JSON.parse(out) as { ok: boolean; error: { code: string; data: { drifted: unknown[] } } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_DRIFT')
    expect(envelope.error.data.drifted).toHaveLength(1)
  })
})

describe('usage errors', () => {
  it.each([
    [['install']],
    [['lock']],
    [['verify']],
    [['update']],
    [['remove']],
    [['add']],
    [['init']],
    [['build', 'a', 'b']],
    [['install', 'x', '--banana']],
  ])('%j exits 2', async (argv) => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code } = await cli(cwd, fake, argv as string[])
    expect(code).toBe(2)
  })

  it('lock before install aggregates every unresolvable member', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'x', 'acme/a-repo@a', 'acme/b-repo@b'])
    const { code, err } = await cli(cwd, fake, ['lock', 'x'])
    expect(code).toBe(1)
    expect(err).toContain('2 of 2 members are not resolvable')
    expect(err).toContain('acme/a-repo@a')
    expect(err).toContain('acme/b-repo@b')
  })

  it('verify --frozen without a lock explains how to create one (precondition → exit 2)', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'x', 'acme/a-repo@a'])
    await cli(cwd, fake, ['install', 'x'])
    const { code, err } = await cli(cwd, fake, ['verify', 'x', '--frozen'])
    expect(code).toBe(2)
    expect(err).toContain('skill-set lock x')
  })

  it('init without a member locator is a usage error — an empty set would violate the schema', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['init', 'empty-set'])
    expect(code).toBe(2)
    expect(err).toContain('at least one member locator')
    expect(existsSync(join(cwd, SETS_DIR, 'empty-set'))).toBe(false)
  })
})

describe('build --lock and delegated-spawn provenance', () => {
  it('build --lock writes the page, the lock, and the index in one pass', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'b', 'acme/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'b'])
    const { code } = await cli(cwd, fake, ['build', 'b', '--lock'])
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'b', 'SKILL-SET.md'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, 'b', 'b.skill-set.lock.json'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, INDEX_FILENAME))).toBe(true)
  })

  it('verify labels the delegated check and warns on its non-zero exit without failing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'w', 'acme/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'w'])
    const grumpyCheck: typeof fake = {
      ...fake,
      runner: async (command, args, opts) =>
        args[2] === 'check'
          ? { ok: true, data: { exitCode: 3, stdout: '', stderr: '' } }
          : fake.runner(command, args, opts),
    }
    const { code, out, err } = await cli(cwd, grumpyCheck, ['verify', 'w'])
    expect(code).toBe(0)
    expect(out).toContain('running: npx -y skills@1.5 check')
    expect(err).toContain('upstream "skills check" exited with code 3')
  })
})

describe('--dry-run', () => {
  it('install prints the resolved upstream commands and changes nothing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'd', 'acme/alpha-repo@alpha'])
    const { code, out } = await cli(cwd, fake, ['install', 'd', '--dry-run'])
    expect(code).toBe(0)
    expect(out).toContain('would run: npx -y skills@1.5 add acme/alpha-repo --skill alpha --yes')
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(false)
  })

  it('init/lock/remove dry runs write and delete nothing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    expect((await cli(cwd, fake, ['init', 'd', 'acme/alpha-repo@alpha', '--dry-run'])).code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'd'))).toBe(false)

    await cli(cwd, fake, ['init', 'd', 'acme/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'd'])
    const lockPath = join(cwd, SETS_DIR, 'd', 'd.skill-set.lock.json')
    const dryLock = await cli(cwd, fake, ['lock', 'd', '--dry-run'])
    expect(dryLock.code).toBe(0)
    expect(dryLock.out).toContain('would write:')
    expect(existsSync(lockPath)).toBe(false)

    const dryRemove = await cli(cwd, fake, ['remove', 'd', '--skills', '--dry-run'])
    expect(dryRemove.code).toBe(0)
    expect(dryRemove.out).toContain('would remove: set "d"')
    expect(existsSync(join(cwd, SETS_DIR, 'd'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
  })

  it('update dry run prints the resolved invocation without spawning or re-locking', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'd', 'acme/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'd'])
    await cli(cwd, fake, ['lock', 'd'])
    const spawnsBefore = fake.calls.length
    const { code, out } = await cli(cwd, fake, ['update', 'd', '--dry-run'])
    expect(code).toBe(0)
    expect(out).toContain('would run: npx -y skills@1.5 update alpha -p --yes')
    expect(fake.calls.length).toBe(spawnsBefore)
  })
})
