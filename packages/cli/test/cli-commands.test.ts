import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { INDEX_FILENAME } from '../src/generate.ts'
import { setHash } from '../src/hash.ts'
import { createSetLock, parseSetLock, serializeSetLock } from '../src/lock.ts'
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
  const ok = { ok: true as const, data: { exitCode: 0, stdout: '', stderr: '' } }

  const runner: CommandRunner = async (command, args, opts) => {
    calls.push([command, ...args])
    captureFlags.push(opts?.capture)
    const runCwd = opts?.cwd ?? cwd
    const runLockPath = join(runCwd, 'skills-lock.json')
    const readRunLock = (): { version: number; skills: Record<string, Record<string, string>> } =>
      existsSync(runLockPath)
        ? (JSON.parse(readFileSync(runLockPath, 'utf8')) as ReturnType<typeof readRunLock>)
        : { version: 1, skills: {} }
    const writeRunLock = (lock: unknown): void => writeFileSync(runLockPath, `${JSON.stringify(lock, null, 2)}\n`)
    const verb = args[2]
    if (verb === 'add') {
      const sourceArg = args[3]!
      const hashAt = sourceArg.lastIndexOf('#')
      const source = hashAt > 0 ? sourceArg.slice(0, hashAt) : sourceArg
      const ref = hashAt > 0 ? sourceArg.slice(hashAt + 1) : undefined
      const skillFlag = args.indexOf('--skill')
      const skill = skillFlag === -1 ? source.split('/').pop()! : args[skillFlag + 1]!
      const folder = join(runCwd, SKILLS_DIR, skill)
      // Like the real upstream: the skill folder is owned wholesale and overwritten on install.
      rmSync(folder, { recursive: true, force: true })
      mkdirSync(folder, { recursive: true })
      writeFileSync(
        join(folder, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: "Does ${skill} things. Use when ${skill} work comes up."\n---\n\nBody of ${skill}.\n`,
      )
      const lock = readRunLock()
      lock.skills[skill] = { source, sourceType: 'github', computedHash: 'f'.repeat(64), ...(ref === undefined ? {} : { ref }) }
      writeRunLock(lock)
      return ok
    }
    if (verb === 'update') {
      for (const skill of args.slice(3).filter((a) => !a.startsWith('-'))) {
        appendFileSync(join(runCwd, SKILLS_DIR, skill, 'SKILL.md'), '\nUpdated content.\n')
      }
      return ok
    }
    if (verb === 'remove') {
      const lock = readRunLock()
      for (const skill of args.slice(3).filter((a) => !a.startsWith('-'))) {
        rmSync(join(runCwd, SKILLS_DIR, skill), { recursive: true, force: true })
        delete lock.skills[skill]
      }
      writeRunLock(lock)
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
    const { code, out } = await cli(cwd, fake, ['init', 'my-tools', 'hcjmartin/alpha-repo@alpha', 'hcjmartin/beta-repo'])
    expect(code).toBe(0)
    expect(out).toContain('Creating skill-set "my-tools"')
    expect(out).toContain(`install the set's skills with "skill-set install my-tools"`)
    const manifest = JSON.parse(readFileSync(join(setDir, 'my-tools.skill-set.json'), 'utf8')) as { skills: string[] }
    expect(manifest.skills).toEqual(['hcjmartin/alpha-repo@alpha', 'hcjmartin/beta-repo'])
  })

  it('init alone generates nothing beyond the manifest — the install offer was declined', () => {
    expect(existsSync(join(setDir, 'SKILL-SET.md'))).toBe(false)
    expect(existsSync(join(cwd, SETS_DIR, INDEX_FILENAME))).toBe(false)
  })

  it('init --yes installs the skills and generates the set files in one pass', async () => {
    const other = project()
    const otherFake = fakeSkills(other)
    const { code, out } = await cli(other, otherFake, ['init', 'quick', 'hcjmartin/alpha-repo@alpha', '--yes'])
    expect(code).toBe(0)
    expect(out).toContain('1 installed, 0 skipped, 0 failed')
    const page = readFileSync(join(other, SETS_DIR, 'quick', 'SKILL-SET.md'), 'utf8')
    expect(page).toContain('Does alpha things. Use when alpha work comes up.')
    expect(existsSync(join(other, SETS_DIR, INDEX_FILENAME))).toBe(true)
  })

  it('init refuses to overwrite an existing set', async () => {
    const { code, err } = await cli(cwd, fake, ['init', 'my-tools', 'hcjmartin/other-repo@other'])
    expect(code).toBe(1)
    expect(err).toContain('already exists')
  })

  it('install resolves every member through the pinned upstream', async () => {
    const { code, out } = await cli(cwd, fake, ['install', 'my-tools'])
    expect(code).toBe(0)
    expect(out).toContain('Installing local skill-set "my-tools"')
    expect(out).toContain('2 skills in set "my-tools":')
    expect(out).toContain('2 installed, 0 skipped, 0 failed')
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'beta-repo'))).toBe(true)
    // Named member forwards --skill; both spawns are the pinned invocation.
    expect(fake.calls[0]).toEqual(['npx', '-y', 'skills@1.5.14', 'add', 'hcjmartin/alpha-repo', '--skill', 'alpha', '--yes'])
    expect(fake.calls[1]).toEqual(['npx', '-y', 'skills@1.5.14', 'add', 'hcjmartin/beta-repo', '--yes'])
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
    expect(out).toContain('installed content verified against the lock — skipping')
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
    expect(err).toContain('hcjmartin/alpha-repo@alpha')
    expect(err).toContain('content drifted — expected')
    // Default mode does not recompute content, so it stays green and says so.
    const soft = await cli(cwd, fake, ['verify', 'my-tools'])
    expect(soft.code).toBe(0)
    expect(soft.out).toContain('Checks run:')
    expect(soft.out).toContain('- skill members (2/2 found)')
    expect(soft.out).toContain('all set skills present (2/2)')
    expect(soft.out).toContain('WARNING: skill content was not checked — use --frozen')
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
    expect(fake.calls.at(-1)).toEqual(['npx', '-y', 'skills@1.5.14', 'update', 'alpha', 'beta-repo', '-p', '--yes'])
    const after = parseSetLock(readFileSync(join(setDir, 'my-tools.skill-set.lock.json'), 'utf8'))
    expect(before.ok && after.ok && before.data.setHash !== after.data.setHash).toBe(true)
    // The re-lock accepted the updated bytes, so frozen verify is green again.
    expect((await cli(cwd, fake, ['verify', 'my-tools', '--frozen'])).code).toBe(0)
  })

  it('passthrough args after -- reach the upstream spawn verbatim', async () => {
    const other = project()
    const otherFake = fakeSkills(other)
    await cli(other, otherFake, ['init', 'p', 'hcjmartin/x-repo@x'])
    await cli(other, otherFake, ['install', 'p', '--', '--verbose'])
    expect(otherFake.calls[0]).toEqual(['npx', '-y', 'skills@1.5.14', 'add', 'hcjmartin/x-repo', '--skill', 'x', '--yes', '--verbose'])
  })

  it('our own flags after -- forward to upstream instead of switching our modes', async () => {
    const other = project()
    const otherFake = fakeSkills(other)
    await cli(other, otherFake, ['init', 'q', 'hcjmartin/y-repo@y'])
    const { code, out } = await cli(other, otherFake, ['install', 'q', '--', '--json', '--help'])
    expect(code).toBe(0)
    // Human install output: no help screen, no JSON envelope — the flags belong to the child.
    expect(out).toContain('Installing local skill-set "q"')
    expect(out).not.toContain('Usage: skill-set')
    expect(out.trimStart().startsWith('{')).toBe(false)
    expect(otherFake.calls[0]).toEqual([
      'npx', '-y', 'skills@1.5.14', 'add', 'hcjmartin/y-repo', '--skill', 'y', '--yes', '--json', '--help',
    ])
  })
})

describe('cross-set conflicts', () => {
  it('two sets pinning one source differently abort install with exit 4', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'hcjmartin/shared-repo@tool#v1'])
    await cli(cwd, fake, ['init', 'two', 'hcjmartin/shared-repo@tool#v2'])
    const { code, err } = await cli(cwd, fake, ['install', 'one'])
    expect(code).toBe(4)
    expect(err).toContain('pinned differently across sets')
    expect(err).toContain('"one" pins v1')
    expect(err).toContain('"two" pins v2')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('remove', () => {
  const url = 'https://skill-set.md/kit.skill-set.json'
  const kitManifest = `${JSON.stringify(
    { name: 'kit', version: '1.0.0', description: 'A kit.', skills: ['hcjmartin/gamma-repo@gamma'] },
    null,
    2,
  )}\n`
  const fetcher = async (u: string) =>
    u === url ? { ok: true as const, data: kitManifest } : { ok: false as const, error: new Error('unexpected url') as never }

  it('needs confirmation, honours --yes end to end, and reference-counts shared skills', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'hcjmartin/alpha-repo@alpha', 'hcjmartin/beta-repo@beta'])
    await cli(cwd, fake, ['init', 'two', 'hcjmartin/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'one'])
    await cli(cwd, fake, ['install', 'two'])

    // Non-interactive without --yes: the required first prompt refuses rather than hang (exit 2).
    const refused = await cli(cwd, fake, ['remove', 'one'])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('--yes')
    expect(existsSync(join(cwd, SETS_DIR, 'one'))).toBe(true)

    const spawnsBefore = fake.calls.length
    const removed = await cli(cwd, fake, ['remove', 'one', '--yes'])
    expect(removed.code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'one'))).toBe(false)
    // A locally authored set has no recorded source, so the success line names its manifest path.
    expect(removed.out).toContain(
      'Skill-set "one" (from .agents/skills/skill-sets/one/one.skill-set.json) was successfully removed',
    )
    // alpha is shared with set "two" and survives; beta was exclusive and delegated upstream.
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'beta'))).toBe(false)
    expect(removed.out).toContain('kept alpha: shared with another set')
    // --yes answered the second prompt too: only the unshared skill went to the upstream remove.
    const removeCall = fake.calls.slice(spawnsBefore).find((c) => c[3] === 'remove')
    expect(removeCall).toEqual(['npx', '-y', 'skills@1.5.14', 'remove', 'beta', '--yes'])
    const index = JSON.parse(readFileSync(join(cwd, SETS_DIR, INDEX_FILENAME), 'utf8')) as { sets: Record<string, unknown> }
    expect(Object.keys(index.sets)).toEqual(['two'])
  })

  it('scripted yes/yes removes the set with its source, then delegates its unshared skill', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['add', url, '--yes'], { fetcher })
    const spawnsBefore = fake.calls.length
    const { code, out } = await cli(cwd, fake, ['remove', 'kit'], { confirmAnswers: [true, true] })
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
    expect(out).toContain(`Skill-set "kit" (from ${url}) was successfully removed`)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(false)
    const removeCall = fake.calls.slice(spawnsBefore).find((c) => c[3] === 'remove')
    expect(removeCall).toEqual(['npx', '-y', 'skills@1.5.14', 'remove', 'gamma', '--yes'])
  })

  it('scripted yes/no removes the set but leaves its skills untouched', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['add', url, '--yes'], { fetcher })
    const spawnsBefore = fake.calls.length
    const { code, out } = await cli(cwd, fake, ['remove', 'kit'], { confirmAnswers: [true, false] })
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
    expect(out).toContain(`Skill-set "kit" (from ${url}) was successfully removed`)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(true)
    expect(fake.calls.slice(spawnsBefore).some((c) => c[3] === 'remove')).toBe(false)
  })

  it('declining the first prompt leaves the set and its skills in place', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'hcjmartin/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'one'])
    const spawnsBefore = fake.calls.length
    const { code, out } = await cli(cwd, fake, ['remove', 'one'], { confirmAnswers: [false] })
    expect(code).toBe(0)
    expect(out).toContain('Aborted — nothing removed.')
    expect(existsSync(join(cwd, SETS_DIR, 'one'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(fake.calls.slice(spawnsBefore)).toHaveLength(0)
  })

  it('keeps a skill whose sibling member is unlocatable but names the same source', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'one', 'hcjmartin/alpha-repo@alpha'])
    // Set "two" pins the same source to a ref that never installed, so locateMember fails
    // for it — the source-level fallback must still count the skill as shared.
    await cli(cwd, fake, ['init', 'two', 'hcjmartin/alpha-repo#v9'])
    await cli(cwd, fake, ['install', 'one'])
    const { code, out } = await cli(cwd, fake, ['remove', 'one', '--yes'])
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
    expect(out).toContain('kept alpha: shared with another set (same source)')
  })
})

describe('add', () => {
  const manifestText = `${JSON.stringify(
    { name: 'fetched-set', version: '1.0.0', description: 'A shared set.', skills: ['hcjmartin/gamma-repo@gamma'] },
    null,
    2,
  )}\n`
  const fetcher = async (url: string) =>
    url === 'https://skill-set.md/fetched-set.skill-set.json'
      ? { ok: true as const, data: manifestText }
      : { ok: false as const, error: new Error('unexpected url') as never }

  it('fetches, summarises, requires confirmation, then installs', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)

    const refused = await cli(cwd, fake, ['add', 'https://skill-set.md/fetched-set.skill-set.json'], { fetcher })
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('--yes')
    expect(existsSync(join(cwd, SETS_DIR, 'fetched-set'))).toBe(false)

    const added = await cli(cwd, fake, ['add', 'https://skill-set.md/fetched-set.skill-set.json', '--yes'], { fetcher })
    expect(added.code).toBe(0)
    expect(added.out).toContain('Set "fetched-set" v1.0.0 — "A shared set."')
    // Written verbatim: the fetched bytes are exactly what lands on disk.
    expect(readFileSync(join(cwd, SETS_DIR, 'fetched-set', 'fetched-set.skill-set.json'), 'utf8')).toBe(manifestText)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(true)

    const repeat = await cli(cwd, fake, ['add', 'https://skill-set.md/fetched-set.skill-set.json', '--yes'], { fetcher })
    expect(repeat.code).toBe(1)
    // The fetched summary still prints, so the user sees what the refused manifest contained.
    expect(repeat.out).toContain('Set "fetched-set" v1.0.0')
    expect(repeat.err).toContain('already exists')
    expect(repeat.err).toContain('skill-set remove fetched-set')
    expect(repeat.err).toContain('skill-set install fetched-set')
  })

  it('records the fetched URL as the set source, preserved across regeneration', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const url = 'https://skill-set.md/fetched-set.skill-set.json'
    await cli(cwd, fake, ['add', url, '--yes'], { fetcher })
    // A locally authored set never gains a source.
    await cli(cwd, fake, ['init', 'local-set', 'hcjmartin/alpha-repo@alpha', '--yes'])

    const indexPath = join(cwd, SETS_DIR, INDEX_FILENAME)
    type Index = { sets: Record<string, { source?: string }> }
    const added = JSON.parse(readFileSync(indexPath, 'utf8')) as Index
    expect(added.sets['fetched-set']!.source).toBe(url)
    expect('source' in added.sets['local-set']!).toBe(false)

    // A later full regeneration over every set must carry the source forward untouched.
    await cli(cwd, fake, ['build'])
    const rebuilt = JSON.parse(readFileSync(indexPath, 'utf8')) as Index
    expect(rebuilt.sets['fetched-set']!.source).toBe(url)
    expect('source' in rebuilt.sets['local-set']!).toBe(false)
  })

  it('regenerates without sources when the existing index is unparseable', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'here', 'hcjmartin/alpha-repo@alpha', '--yes'])
    const indexPath = join(cwd, SETS_DIR, INDEX_FILENAME)
    writeFileSync(indexPath, '{ not valid json')
    const { code } = await cli(cwd, fake, ['build'])
    expect(code).toBe(0)
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { sets: Record<string, { source?: string }> }
    expect('source' in index.sets['here']!).toBe(false)
  })

  it('rejects plain http sources', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['add', 'http://example.test/set.skill-set.json'])
    expect(code).toBe(1)
    expect(err).toContain('HTTPS only')
  })
})

describe('add — trusted-host allowlist', () => {
  const body = (name: string) =>
    `${JSON.stringify({ name, version: '1.0.0', description: 'A set.', skills: ['hcjmartin/gamma-repo@gamma'] }, null, 2)}\n`
  const allowUrl = 'https://skill-set.md/allow-set.skill-set.json'
  const unknownUrl = 'https://unknown-origin.invalid/unknown-set.skill-set.json'

  // Records whether the fetcher was reached, so an aborted confirmation can be shown to fetch nothing.
  function tracked(map: Record<string, string>): { fetcher: RunOverrides['fetcher']; fetched: string[] } {
    const fetched: string[] = []
    const fetcher: RunOverrides['fetcher'] = async (url: string) => {
      fetched.push(url)
      return url in map
        ? { ok: true as const, data: map[url]! }
        : { ok: false as const, error: new Error('unexpected url') as never }
    }
    return { fetcher, fetched }
  }

  it('fetches from an allowlisted host without a host prompt', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { fetcher } = tracked({ [allowUrl]: body('allow-set') })
    // A single scripted answer covers the install confirm; if a host prompt had also fired it
    // would have consumed this answer, leaving the install confirm to refuse (exit 2).
    const { code } = await cli(cwd, fake, ['add', allowUrl], { fetcher, confirmAnswers: [true] })
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'allow-set'))).toBe(true)
  })

  it('confirms an unknown host before fetching, then installs on yes', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { fetcher, fetched } = tracked({ [unknownUrl]: body('unknown-set') })
    // First answer accepts the host, second accepts the install. The author-lock probe rides
    // on the already-accepted host, so it needs no third answer.
    const { code } = await cli(cwd, fake, ['add', unknownUrl], { fetcher, confirmAnswers: [true, true] })
    expect(code).toBe(0)
    expect(fetched).toEqual([unknownUrl, 'https://unknown-origin.invalid/unknown-set.skill-set.lock.json'])
    expect(existsSync(join(cwd, SETS_DIR, 'unknown-set'))).toBe(true)
  })

  it('aborts an unknown host on no, fetching nothing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { fetcher, fetched } = tracked({ [unknownUrl]: body('unknown-set') })
    const { code, out } = await cli(cwd, fake, ['add', unknownUrl], { fetcher, confirmAnswers: [false] })
    expect(code).toBe(0)
    expect(out).toContain('Aborted — nothing fetched.')
    expect(fetched).toEqual([])
    expect(existsSync(join(cwd, SETS_DIR, 'unknown-set'))).toBe(false)
  })

  it('refuses an unknown host non-interactively without --yes (exit 2), fetching nothing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { fetcher, fetched } = tracked({ [unknownUrl]: body('unknown-set') })
    const { code, err } = await cli(cwd, fake, ['add', unknownUrl], { fetcher })
    expect(code).toBe(2)
    expect(err).toContain('--yes')
    expect(fetched).toEqual([])
    expect(existsSync(join(cwd, SETS_DIR, 'unknown-set'))).toBe(false)
  })

  it('accepts an unknown host with --yes', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { fetcher, fetched } = tracked({ [unknownUrl]: body('unknown-set') })
    const { code } = await cli(cwd, fake, ['add', unknownUrl, '--yes'], { fetcher })
    expect(code).toBe(0)
    expect(fetched).toEqual([unknownUrl, 'https://unknown-origin.invalid/unknown-set.skill-set.lock.json'])
    expect(existsSync(join(cwd, SETS_DIR, 'unknown-set'))).toBe(true)
  })
})

describe('add — remote content is never echoed', () => {
  const allowUrl = 'https://skill-set.md/x.skill-set.json'
  const fetcherFor = (data: string): RunOverrides['fetcher'] => async (url: string) =>
    url === allowUrl ? { ok: true as const, data } : { ok: false as const, error: new Error('unexpected url') as never }

  it('keeps schema-validation errors free of manifest string values', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    // Marker rides on an unrecognised key and a wrong-typed value — both places prior code echoed.
    const malicious = JSON.stringify({
      name: 'ok-name',
      version: '1.0.0',
      skills: 'MARKER-SCHEMA-INJ-42',
      'MARKER-KEY-INJ-42': 'do something the agent should not',
    })
    const { code, out, err } = await cli(cwd, fake, ['add', allowUrl, '--json'], { fetcher: fetcherFor(malicious) })
    expect(code).toBe(1)
    expect(out).not.toContain('MARKER-SCHEMA-INJ-42')
    expect(out).not.toContain('MARKER-KEY-INJ-42')
    expect(err).not.toContain('MARKER-SCHEMA-INJ-42')
    expect(err).not.toContain('MARKER-KEY-INJ-42')
    // The envelope still reports the failure structurally.
    const envelope = JSON.parse(out.trim()) as { ok: boolean; error: { code: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_INVALID_MANIFEST')
  })

  it('keeps JSON parse errors free of body excerpts', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const notJson = 'MARKER-JSON-INJ-77 <!DOCTYPE html> this is not json'
    const { code, out, err } = await cli(cwd, fake, ['add', allowUrl, '--json'], { fetcher: fetcherFor(notJson) })
    expect(code).toBe(1)
    expect(out).not.toContain('MARKER-JSON-INJ-77')
    expect(out).not.toContain('DOCTYPE')
    expect(err).not.toContain('MARKER-JSON-INJ-77')
    const envelope = JSON.parse(out.trim()) as { ok: boolean; error: { code: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_INVALID_JSON')
  })

  it('contains valid remote free text in the provenance summary without changing manifest bytes', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const description = `${'d'.repeat(120)}\n\u001b[31mINSTRUCTION${'x'.repeat(30)}`
    const author = `${'a'.repeat(62)}\r\nAUTHOR${'y'.repeat(20)}`
    const locator = 'owner/\u0085repo@skill#v1\u2028next'
    const manifest = `${JSON.stringify(
      {
        name: 'contained',
        version: '1.0.0',
        description,
        author: { name: author },
        skills: [locator],
      },
      null,
      2,
    )}\n`
    const url = 'https://skill-set.md/contained.skill-set.json'
    const fetcher: RunOverrides['fetcher'] = async (requested) =>
      requested === url
        ? { ok: true as const, data: manifest }
        : { ok: false as const, error: new Error('no sidecar') as never }

    const { code, out } = await cli(cwd, fake, ['add', url, '--yes'], { fetcher })

    expect(code).toBe(0)
    const summary = out.split('\n').filter((line) => line.startsWith('Set ') || line.startsWith('author:') || line.startsWith('  "'))
    expect(summary).toHaveLength(3)
    expect(
      summary.every((line) =>
        [...line].every((character) => {
          const codePoint = character.codePointAt(0)!
          return !(
            codePoint <= 0x1f ||
            (codePoint >= 0x7f && codePoint <= 0x9f) ||
            codePoint === 0x2028 ||
            codePoint === 0x2029
          )
        }),
      ),
    ).toBe(true)
    expect(summary[0]).toBe(`Set "contained" v1.0.0 — "${'d'.repeat(120)}[31mINS…"`)
    expect([...(JSON.parse(summary[0]!.split(' — ')[1]!) as string)]).toHaveLength(128)
    expect(summary[1]).toBe(`author: "${'a'.repeat(62)}A…"`)
    expect([...(JSON.parse(summary[1]!.slice('author: '.length)) as string)]).toHaveLength(64)
    expect(summary[2]).toContain('"owner/repo@skill#v1next"')
    expect(summary[2]).toContain('(source "owner/repo", pinned "v1next")')
    expect(readFileSync(join(cwd, SETS_DIR, 'contained', 'contained.skill-set.json'), 'utf8')).toBe(manifest)
  })
})

// Mirrors the fake's SKILL.md body, so author locks can be written before anything installs.
function installedSkillHash(skill: string): string {
  const body = `---\nname: ${skill}\ndescription: "Does ${skill} things. Use when ${skill} work comes up."\n---\n\nBody of ${skill}.\n`
  return createHash('sha256')
    .update('SKILL.md', 'utf8')
    .update(Buffer.from([0]))
    .update(body, 'utf8')
    .update(Buffer.from([0]))
    .digest('hex')
}

describe('share', () => {
  it('exports only a manifest and lock, hashing staged remote content instead of mutated local folders', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'portable', 'hcjmartin/alpha-repo@alpha', '--yes'])
    appendFileSync(join(cwd, SKILLS_DIR, 'alpha', 'SKILL.md'), '\nlocal mutation that should not enter the share lock\n')

    const { code, out } = await cli(cwd, fake, ['share', 'portable', '--yes'])
    expect(code).toBe(0)
    expect(out).toContain('Created shareable skill-set at .agents/skills/skill-sets/_share/portable')
    expect(out).toContain('The lock was generated from the live skills, not your local files.')
    expect(out).toContain('share a validating install command: npx @skill-set/cli add https://<skill-set-url>#sha256=')
    expect(out).toContain('Notice: 1 installed local skill differs from the fetched remote content used for this share lock')
    expect(out).toContain('hcjmartin/alpha-repo@alpha (skill alpha)')

    const shareDir = join(cwd, SETS_DIR, '_share', 'portable')
    expect(existsSync(join(shareDir, 'portable.skill-set.json'))).toBe(true)
    expect(existsSync(join(shareDir, 'portable.skill-set.lock.json'))).toBe(true)
    expect(existsSync(join(shareDir, 'SKILL-SET.md'))).toBe(false)
    expect(existsSync(join(cwd, SETS_DIR, 'portable', 'portable.skill-set.lock.json'))).toBe(false)

    const lock = parseSetLock(readFileSync(join(shareDir, 'portable.skill-set.lock.json'), 'utf8'))
    expect(lock.ok).toBe(true)
    if (lock.ok) {
      expect(lock.data.skills['hcjmartin/alpha-repo@alpha']!.computedHash).toBe(installedSkillHash('alpha'))
    }
    expect(readFileSync(join(cwd, SKILLS_DIR, 'alpha', 'SKILL.md'), 'utf8')).toContain('local mutation')
  })

  it('--json surfaces the local-vs-remote drift the human notice reports', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'portable', 'hcjmartin/alpha-repo@alpha', '--yes'])
    appendFileSync(join(cwd, SKILLS_DIR, 'alpha', 'SKILL.md'), '\nlocal mutation that should not enter the share lock\n')

    const { code, out } = await cli(cwd, fake, ['share', 'portable', '--yes', '--json'])
    expect(code).toBe(0)
    const envelope = JSON.parse(out) as {
      data: { localMismatches?: Array<{ locator: string; skill: string }> }
    }
    expect(envelope.data.localMismatches).toEqual([{ locator: 'hcjmartin/alpha-repo@alpha', skill: 'alpha' }])
  })

  it('accepts a hand-written manifest path, output path, and optional metadata prompts', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    mkdirSync(join(cwd, 'custom'), { recursive: true })
    writeFileSync(
      join(cwd, 'custom', 'custom.skill-set.json'),
      `${JSON.stringify({ name: 'custom', version: '1.2.3', skills: ['hcjmartin/beta-repo@beta'] }, null, 2)}\n`,
    )

    const { code } = await cli(
      cwd,
      fake,
      ['share', '--manifest', 'custom/custom.skill-set.json', '--output', 'exports/custom'],
      { promptAnswers: ['Custom share description.', 'Harry Martin', 'https://example.com/harry', 'https://example.com/custom'] },
    )
    expect(code).toBe(0)

    const manifest = JSON.parse(readFileSync(join(cwd, 'exports', 'custom', 'custom.skill-set.json'), 'utf8')) as {
      description?: string
      author?: { name?: string; url?: string }
      homepage?: string
    }
    expect(manifest.description).toBe('Custom share description.')
    expect(manifest.author).toEqual({ name: 'Harry Martin', url: 'https://example.com/harry' })
    expect(manifest.homepage).toBe('https://example.com/custom')
    expect(existsSync(join(cwd, 'exports', 'custom', 'custom.skill-set.lock.json'))).toBe(true)
  })

  it('can prompt for the input when no set name or manifest path is provided', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'prompted', 'hcjmartin/gamma-repo@gamma'])

    const { code, out } = await cli(cwd, fake, ['share'], { promptAnswers: ['prompted'], confirmAnswers: [true] })
    expect(code).toBe(0)
    expect(out).toContain('Created shareable skill-set at .agents/skills/skill-sets/_share/prompted')
  })

  it('keeps the export namespace separate from a real set named share', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'share', 'hcjmartin/delta-repo@delta'])

    const { code } = await cli(cwd, fake, ['share', 'share', '--yes'])
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'share', 'share.skill-set.json'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, '_share', 'share', 'share.skill-set.json'))).toBe(true)
  })

  it('lets an interactive user keep staged content for review', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'reviewable', 'hcjmartin/epsilon-repo@epsilon'])

    const { code, out } = await cli(cwd, fake, ['share', 'reviewable', '--output', 'exports/reviewable'], {
      interactive: true,
      promptAnswers: ['', '', ''],
      confirmAnswers: [false],
    })
    expect(code).toBe(0)
    expect(out).toContain('Staged skill contents used for this share lock are at:')
    const kept = /Staged files kept at (.+)/.exec(out)?.[1]
    expect(kept).toBeDefined()
    expect(existsSync(kept!)).toBe(true)
    rmSync(kept!, { recursive: true, force: true })
  })

  it('rejects local-only members before staging anything', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    mkdirSync(join(cwd, SETS_DIR, 'local'), { recursive: true })
    writeFileSync(
      join(cwd, SETS_DIR, 'local', 'local.skill-set.json'),
      `${JSON.stringify({ name: 'local', version: '0.1.0', skills: ['./skills/draft-skill'] }, null, 2)}\n`,
    )

    const { code, err } = await cli(cwd, fake, ['share', 'local', '--output', 'share/local'])
    expect(code).toBe(1)
    expect(err).toContain('Cannot share "local"')
    expect(err).toContain('source is local to this machine')
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, 'share', 'local'))).toBe(false)
  })
})

describe('add — shared-set verification', () => {
  const manifestUrl = 'https://skill-set.md/kit.skill-set.json'
  const sidecarUrl = 'https://skill-set.md/kit.skill-set.lock.json'
  const kitManifest = `${JSON.stringify(
    { name: 'kit', version: '1.0.0', description: 'A kit.', skills: ['hcjmartin/gamma-repo@gamma'] },
    null,
    2,
  )}\n`
  const gammaHash = installedSkillHash('gamma')
  const kitSetHash = setHash({ 'hcjmartin/gamma-repo@gamma': gammaHash })
  const authorLock = serializeSetLock(
    createSetLock('kit', '1.0.0', { 'hcjmartin/gamma-repo@gamma': { skill: 'gamma', computedHash: gammaHash } }),
  )
  const wrongLock = serializeSetLock(
    createSetLock('kit', '1.0.0', { 'hcjmartin/gamma-repo@gamma': { skill: 'gamma', computedHash: 'a'.repeat(64) } }),
  )
  const mapFetcher = (map: Record<string, string>): RunOverrides['fetcher'] => async (url: string) =>
    url in map ? { ok: true as const, data: map[url]! } : { ok: false as const, error: new Error('unexpected url') as never }

  it('adopts a matching author lock verbatim and reports the verification', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, out } = await cli(cwd, fake, ['add', manifestUrl, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: authorLock }),
    })
    expect(code).toBe(0)
    expect(out).toContain('author lock found — remote content will be verified against it')
    expect(out).toContain('Verified 1/1 member skills against the author lock')
    expect(fake.calls).toHaveLength(1)
    // Adopted byte-for-byte, like the manifest: the bytes that verified are what land.
    expect(readFileSync(join(cwd, SETS_DIR, 'kit', 'kit.skill-set.lock.json'), 'utf8')).toBe(authorLock)
    expect(readFileSync(join(cwd, SETS_DIR, 'kit', 'SKILL-SET.md'), 'utf8')).toContain('Locked at set version 1.0.0.')
  })

  it('verifies pre-existing drifted skills from staged remote content, leaving local edits untouched', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'base', 'hcjmartin/gamma-repo@gamma', '--yes'])
    appendFileSync(join(cwd, SKILLS_DIR, 'gamma', 'SKILL.md'), '\nlocal drift before adding a shared set\n')

    const pairUrl = 'https://skill-set.md/pair.skill-set.json'
    const pairManifest = `${JSON.stringify(
      { name: 'pair', version: '1.0.0', skills: ['hcjmartin/gamma-repo@gamma', 'hcjmartin/delta-repo@delta'] },
      null,
      2,
    )}\n`
    const pairLock = serializeSetLock(
      createSetLock('pair', '1.0.0', {
        'hcjmartin/gamma-repo@gamma': { skill: 'gamma', computedHash: gammaHash },
        'hcjmartin/delta-repo@delta': { skill: 'delta', computedHash: installedSkillHash('delta') },
      }),
    )
    const runner: CommandRunner = async (command, args, opts) => {
      const runCwd = opts?.cwd ?? cwd
      if (runCwd === cwd && args[2] === 'add') {
        const skillFlag = args.indexOf('--skill')
        const skill = skillFlag === -1 ? args[3]!.split('/').pop()! : args[skillFlag + 1]!
        if (existsSync(join(cwd, SKILLS_DIR, skill))) return { ok: true, data: { exitCode: 0, stdout: '', stderr: '' } }
      }
      return fake.runner(command, args, opts)
    }

    const { code, out } = await cli(cwd, { ...fake, runner }, ['add', pairUrl, '--yes'], {
      fetcher: mapFetcher({ [pairUrl]: pairManifest, 'https://skill-set.md/pair.skill-set.lock.json': pairLock }),
    })
    expect(code).toBe(0)
    expect(out).toContain('Verified 2/2 member skills against the author lock')
    expect(out).toContain('1 member skill already installed; fetching published content to verify this set without changing your installed copies.')
    expect(out).toContain('Notice: 1 installed local skill differs from the verified remote content for this set')
    expect(out).toContain('hcjmartin/gamma-repo@gamma (skill gamma)')
    expect(readFileSync(join(cwd, SKILLS_DIR, 'gamma', 'SKILL.md'), 'utf8')).toContain('local drift')
    expect(existsSync(join(cwd, SKILLS_DIR, 'delta'))).toBe(true)
    expect(readFileSync(join(cwd, SETS_DIR, 'pair', 'pair.skill-set.lock.json'), 'utf8')).toBe(pairLock)
  })

  it('with no author lock published, --hash verifies the rollup and writes the computed lock', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, out } = await cli(cwd, fake, ['add', manifestUrl, '--hash', `sha256:${kitSetHash}`, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest }),
    })
    expect(code).toBe(0)
    expect(out).toContain('no author lock published for this set')
    expect(out).toContain('Verified: set hash matches the pinned sha256')
    const lock = parseSetLock(readFileSync(join(cwd, SETS_DIR, 'kit', 'kit.skill-set.lock.json'), 'utf8'))
    expect(lock.ok).toBe(true)
    if (lock.ok) expect(lock.data.setHash).toBe(kitSetHash)
  })

  it('--json reports verified: "both" when the author lock and the pinned hash agree', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, out } = await cli(cwd, fake, ['add', manifestUrl, '--hash', `sha256:${kitSetHash}`, '--yes', '--json'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: authorLock }),
    })
    expect(code).toBe(0)
    const envelope = JSON.parse(out.trim()) as {
      ok: boolean
      data: {
        verified: string
        added: boolean
        detail: { verification: { stagedFallback: boolean; stagedMembers: string[]; localMismatches: unknown[] } }
      }
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.data.added).toBe(true)
    expect(envelope.data.verified).toBe('both')
    expect(envelope.data.detail.verification).toEqual({ stagedFallback: false, stagedMembers: [], localMismatches: [] })
  })

  it('--json groups fallback verification details under detail', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'base', 'hcjmartin/gamma-repo@gamma', '--yes'])
    appendFileSync(join(cwd, SKILLS_DIR, 'gamma', 'SKILL.md'), '\nlocal drift before adding a shared set\n')
    const runner: CommandRunner = async (command, args, opts) => {
      const runCwd = opts?.cwd ?? cwd
      if (runCwd === cwd && args[2] === 'add') {
        const skillFlag = args.indexOf('--skill')
        const skill = skillFlag === -1 ? args[3]!.split('/').pop()! : args[skillFlag + 1]!
        if (existsSync(join(cwd, SKILLS_DIR, skill))) return { ok: true, data: { exitCode: 0, stdout: '', stderr: '' } }
      }
      return fake.runner(command, args, opts)
    }

    const { code, out } = await cli(cwd, { ...fake, runner }, ['add', manifestUrl, '--yes', '--json'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: authorLock }),
    })
    expect(code).toBe(0)
    const envelope = JSON.parse(out.trim()) as {
      ok: boolean
      data: { detail: { verification: { stagedFallback: boolean; stagedMembers: string[]; localMismatches: Array<{ locator: string; skill: string }> } } }
    }
    expect(envelope.ok).toBe(true)
    expect(envelope.data.detail.verification.stagedFallback).toBe(true)
    expect(envelope.data.detail.verification.stagedMembers).toEqual(['hcjmartin/gamma-repo@gamma'])
    expect(envelope.data.detail.verification.localMismatches).toEqual([{ locator: 'hcjmartin/gamma-repo@gamma', skill: 'gamma' }])
  })

  it('a mismatched member is named with both hashes, and nothing is kept', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['add', manifestUrl, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: wrongLock }),
    })
    expect(code).toBe(3)
    expect(err).toContain('The skill set did not match the published lock.')
    expect(err).toContain(`hcjmartin/gamma-repo@gamma (skill gamma): expected ${'a'.repeat(64)}, computed ${gammaHash}`)
    expect(err).toContain('Nothing was kept: the set files were removed.')
    // Rollback: the installed skill, its upstream lock entry, and the set's own files are gone.
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(false)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
    const upstream = JSON.parse(readFileSync(join(cwd, 'skills-lock.json'), 'utf8')) as { skills: Record<string, unknown> }
    expect('gamma' in upstream.skills).toBe(false)
  })

  it('--json reports the verification mismatch structurally with its own error code', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, out } = await cli(cwd, fake, ['add', manifestUrl, '--yes', '--json'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: wrongLock }),
    })
    expect(code).toBe(3)
    const envelope = JSON.parse(out.trim()) as {
      ok: boolean
      error: { code: string; data: { verifiedAgainst: string; mismatches: unknown[]; removedSkills: string[] } }
    }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_RECEIPT_MISMATCH')
    expect(envelope.error.data.verifiedAgainst).toBe('sidecar')
    expect(envelope.error.data.mismatches).toHaveLength(1)
    expect(envelope.error.data.removedSkills).toEqual(['gamma'])
  })

  it('a pinned hash that does not match the computed rollup rolls everything back', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['add', manifestUrl, '--hash', `sha256:${'b'.repeat(64)}`, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest }),
    })
    expect(code).toBe(3)
    expect(err).toContain('The skill set did not match the verification hash.')
    expect(err).toContain(`set hash: expected ${'b'.repeat(64)}, computed ${kitSetHash}`)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(false)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
  })

  it('an author lock that disagrees with the pinned hash fails before anything installs', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['add', manifestUrl, '--hash', `sha256:${'c'.repeat(64)}`, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: authorLock }),
    })
    expect(code).toBe(3)
    expect(err).toContain('does not match the provided hash')
    expect(err).toContain('no files changed')
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(false)
  })

  it('rolls back the add when verification needs fallback staging but remote content cannot be fetched', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'base', 'hcjmartin/gamma-repo@gamma', '--yes'])
    appendFileSync(join(cwd, SKILLS_DIR, 'gamma', 'SKILL.md'), '\nlocal drift before adding a shared set\n')
    const runner: CommandRunner = async (command, args, opts) => {
      const runCwd = opts?.cwd ?? cwd
      if (runCwd === cwd && args[2] === 'add') {
        const skillFlag = args.indexOf('--skill')
        const skill = skillFlag === -1 ? args[3]!.split('/').pop()! : args[skillFlag + 1]!
        if (existsSync(join(cwd, SKILLS_DIR, skill))) return { ok: true, data: { exitCode: 0, stdout: '', stderr: '' } }
      }
      if (runCwd !== cwd && args[2] === 'add') return { ok: true, data: { exitCode: 2, stdout: '', stderr: 'stage failed' } }
      return fake.runner(command, args, opts)
    }
    const { code, err } = await cli(cwd, { ...fake, runner }, ['add', manifestUrl, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: authorLock }),
    })
    expect(code).toBe(3)
    expect(err).toContain('The skill set "kit" could not be verified — remote skill content could not be fetched for checking.')
    expect(err).toContain('Nothing was kept: the set files were removed.')
    expect(readFileSync(join(cwd, SKILLS_DIR, 'gamma', 'SKILL.md'), 'utf8')).toContain('local drift')
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
  })

  it('a #sha256= fragment pins like --hash and is stripped from the fetch and the recorded source', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const fetched: string[] = []
    const fetcher: RunOverrides['fetcher'] = async (url: string) => {
      fetched.push(url)
      return url === manifestUrl
        ? { ok: true as const, data: kitManifest }
        : { ok: false as const, error: new Error('unexpected url') as never }
    }
    const { code, out } = await cli(cwd, fake, ['add', `${manifestUrl}#sha256=${kitSetHash}`, '--yes'], { fetcher })
    expect(code).toBe(0)
    expect(out).toContain('Verified: set hash matches the pinned sha256')
    expect(fetched[0]).toBe(manifestUrl)
    const index = JSON.parse(readFileSync(join(cwd, SETS_DIR, INDEX_FILENAME), 'utf8')) as {
      sets: Record<string, { source?: string }>
    }
    expect(index.sets['kit']!.source).toBe(manifestUrl)
  })

  it('flag and fragment must agree; agreement is accepted', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const fetcher = mapFetcher({ [manifestUrl]: kitManifest })
    const disagree = await cli(
      cwd,
      fake,
      ['add', `${manifestUrl}#sha256=${'d'.repeat(64)}`, '--hash', `sha256:${kitSetHash}`, '--yes'],
      { fetcher },
    )
    expect(disagree.code).toBe(2)
    expect(disagree.err).toContain("the provided --hash value and the URL's embedded hash do not match")
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
    const agree = await cli(
      cwd,
      fake,
      ['add', `${manifestUrl}#sha256=${kitSetHash}`, '--hash', `sha256:${kitSetHash}`, '--yes'],
      { fetcher },
    )
    expect(agree.code).toBe(0)
  })

  it.each([
    [`md5:${'a'.repeat(64)}`],
    ['a'.repeat(64)],
    ['sha256:nothex'],
    [`sha256:${'A'.repeat(64)}`],
  ])('rejects --hash %s as a usage error (exit 2)', async (value) => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code } = await cli(cwd, fake, ['add', manifestUrl, '--hash', value])
    expect(code).toBe(2)
  })

  it('rejects an unknown fragment algorithm (exit 2)', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code } = await cli(cwd, fake, ['add', `${manifestUrl}#md5=${'a'.repeat(64)}`])
    expect(code).toBe(2)
  })

  it('without a pin or a published author lock, add keeps trust-on-first-use behaviour', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, out } = await cli(cwd, fake, ['add', manifestUrl, '--yes'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest }),
    })
    expect(code).toBe(0)
    expect(out).toContain('no author lock published for this set')
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, 'kit', 'kit.skill-set.lock.json'))).toBe(false)
  })

  it('keeps author-lock validation errors free of lock content', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const malicious = JSON.stringify({
      version: 1,
      name: 'kit',
      setVersion: '1.0.0',
      setHash: 'MARKER-HASH-INJ-13',
      skills: { 'MARKER-KEY-INJ-13': { skill: 'gamma', computedHash: 'MARKER-MEMBER-INJ-13' } },
    })
    const { code, out, err } = await cli(cwd, fake, ['add', manifestUrl, '--yes', '--json'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: malicious }),
    })
    expect(code).toBe(1)
    expect(out).not.toContain('MARKER-')
    expect(err).not.toContain('MARKER-')
    const envelope = JSON.parse(out.trim()) as { ok: boolean; error: { code: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_INVALID_LOCK')
    // The invalid lock aborted the add before anything installed or landed on disk.
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
  })

  it('keeps the version-gate error free of a non-numeric sidecar version', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    // The version gate runs before shape validation, so its message is a distinct echo path.
    const malicious = JSON.stringify({ version: 'MARKER-VERSION-INJ-29' })
    const { code, out, err } = await cli(cwd, fake, ['add', manifestUrl, '--yes', '--json'], {
      fetcher: mapFetcher({ [manifestUrl]: kitManifest, [sidecarUrl]: malicious }),
    })
    expect(code).toBe(1)
    expect(out).not.toContain('MARKER-')
    expect(err).not.toContain('MARKER-')
    const envelope = JSON.parse(out.trim()) as { ok: boolean; error: { code: string; data?: Record<string, unknown> } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_LOCK_VERSION')
    expect(envelope.error.data?.found).toBeUndefined()
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
  })

  it('rollback never touches a pre-existing shared skill folder', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'base', 'hcjmartin/gamma-repo@gamma', '--yes'])
    const pairUrl = 'https://skill-set.md/pair.skill-set.json'
    const pairManifest = `${JSON.stringify(
      { name: 'pair', version: '1.0.0', skills: ['hcjmartin/gamma-repo@gamma', 'hcjmartin/delta-repo@delta'] },
      null,
      2,
    )}\n`
    const pairLock = serializeSetLock(
      createSetLock('pair', '1.0.0', {
        'hcjmartin/gamma-repo@gamma': { skill: 'gamma', computedHash: gammaHash },
        'hcjmartin/delta-repo@delta': { skill: 'delta', computedHash: 'a'.repeat(64) },
      }),
    )
    const { code, err } = await cli(cwd, fake, ['add', pairUrl, '--yes'], {
      fetcher: mapFetcher({ [pairUrl]: pairManifest, 'https://skill-set.md/pair.skill-set.lock.json': pairLock }),
    })
    expect(code).toBe(3)
    expect(err).toContain('hcjmartin/delta-repo@delta')
    // The shared skill pre-existed this add, so the rollback leaves it (and its lock entry) alone.
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'delta'))).toBe(false)
    expect(existsSync(join(cwd, SETS_DIR, 'pair'))).toBe(false)
    const upstream = JSON.parse(readFileSync(join(cwd, 'skills-lock.json'), 'utf8')) as { skills: Record<string, unknown> }
    expect('gamma' in upstream.skills).toBe(true)
    expect('delta' in upstream.skills).toBe(false)
    const index = JSON.parse(readFileSync(join(cwd, SETS_DIR, INDEX_FILENAME), 'utf8')) as { sets: Record<string, unknown> }
    expect(Object.keys(index.sets)).toEqual(['base'])
  })

  it('dry run previews verification and fetches no author lock', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const fetched: string[] = []
    const fetcher: RunOverrides['fetcher'] = async (url: string) => {
      fetched.push(url)
      return url === manifestUrl
        ? { ok: true as const, data: kitManifest }
        : { ok: false as const, error: new Error('unexpected url') as never }
    }
    const { code, out } = await cli(cwd, fake, ['add', manifestUrl, '--hash', `sha256:${kitSetHash}`, '--dry-run'], { fetcher })
    expect(code).toBe(0)
    expect(out).toContain(`would verify: set hash against sha256:${kitSetHash}`)
    expect(out).toContain(`would verify: remote content against the author lock at ${sidecarUrl}, if published`)
    expect(fetched).toEqual([manifestUrl])
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SETS_DIR, 'kit'))).toBe(false)
  })

  it('a local manifest path discovers its sibling lock file', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const shareDir = join(cwd, 'share')
    mkdirSync(shareDir, { recursive: true })
    writeFileSync(join(shareDir, 'kit.skill-set.json'), kitManifest)
    writeFileSync(join(shareDir, 'kit.skill-set.lock.json'), authorLock)
    const { code, out } = await cli(cwd, fake, ['add', join(shareDir, 'kit.skill-set.json'), '--yes'])
    expect(code).toBe(0)
    expect(out).toContain('Verified 1/1 member skills against the author lock')
    expect(readFileSync(join(cwd, SETS_DIR, 'kit', 'kit.skill-set.lock.json'), 'utf8')).toBe(authorLock)
  })
})

describe('--json mode', () => {
  it('emits exactly one JSON object on stdout, even mid-flow, and captures spawn output', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'j', 'hcjmartin/alpha-repo@alpha'])
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
    await cli(cwd, fake, ['init', 'j', 'hcjmartin/alpha-repo@alpha'])
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
    await cli(cwd, fake, ['init', 'x', 'hcjmartin/a-repo@a', 'hcjmartin/b-repo@b'])
    const { code, err } = await cli(cwd, fake, ['lock', 'x'])
    expect(code).toBe(1)
    expect(err).toContain('2 of 2 skills could not be found')
    expect(err).toContain('hcjmartin/a-repo@a')
    expect(err).toContain('hcjmartin/b-repo@b')
  })

  it('verify --frozen without a lock explains how to create one (precondition → exit 2)', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'x', 'hcjmartin/a-repo@a'])
    await cli(cwd, fake, ['install', 'x'])
    const { code, err } = await cli(cwd, fake, ['verify', 'x', '--frozen'])
    expect(code).toBe(2)
    expect(err).toContain('x.skill-set.lock.json')
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
    await cli(cwd, fake, ['init', 'b', 'hcjmartin/alpha-repo@alpha'])
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
    await cli(cwd, fake, ['init', 'w', 'hcjmartin/alpha-repo@alpha'])
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
    expect(out).toContain('running: npx -y skills@1.5.14 check')
    expect(err).toContain('upstream "skills check" exited with code 3')
  })
})

describe('--dry-run', () => {
  it('install prints the resolved upstream commands and changes nothing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'd', 'hcjmartin/alpha-repo@alpha'])
    const { code, out } = await cli(cwd, fake, ['install', 'd', '--dry-run'])
    expect(code).toBe(0)
    expect(out).toContain('would run: npx -y skills@1.5.14 add hcjmartin/alpha-repo --skill alpha --yes')
    expect(out).toContain('dry run — no files changed, no skills installed')
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(false)
  })

  it('init/lock/remove dry runs write and delete nothing', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    expect((await cli(cwd, fake, ['init', 'd', 'hcjmartin/alpha-repo@alpha', '--dry-run'])).code).toBe(0)
    expect(existsSync(join(cwd, SETS_DIR, 'd'))).toBe(false)

    await cli(cwd, fake, ['init', 'd', 'hcjmartin/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'd'])
    const lockPath = join(cwd, SETS_DIR, 'd', 'd.skill-set.lock.json')
    const dryLock = await cli(cwd, fake, ['lock', 'd', '--dry-run'])
    expect(dryLock.code).toBe(0)
    expect(dryLock.out).toContain('would write:')
    expect(existsSync(lockPath)).toBe(false)

    const dryRemove = await cli(cwd, fake, ['remove', 'd', '--dry-run'])
    expect(dryRemove.code).toBe(0)
    // The preview mirrors the real flow: origin in the removal line, skill removal as an offer.
    expect(dryRemove.out).toContain('would remove: set "d" (from .agents/skills/skill-sets/d/d.skill-set.json)')
    expect(dryRemove.out).toContain('would offer to also remove its skills (alpha)')
    expect(existsSync(join(cwd, SETS_DIR, 'd'))).toBe(true)
    expect(existsSync(join(cwd, SKILLS_DIR, 'alpha'))).toBe(true)
  })

  it('update dry run prints the resolved invocation without spawning or re-locking', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'd', 'hcjmartin/alpha-repo@alpha'])
    await cli(cwd, fake, ['install', 'd'])
    await cli(cwd, fake, ['lock', 'd'])
    const spawnsBefore = fake.calls.length
    const { code, out } = await cli(cwd, fake, ['update', 'd', '--dry-run'])
    expect(code).toBe(0)
    expect(out).toContain('would run: npx -y skills@1.5.14 update alpha -p --yes')
    expect(fake.calls.length).toBe(spawnsBefore)
  })
})

describe('reserved skill name — the set-definitions directory is never a skill', () => {
  const mapFetcher = (map: Record<string, string>): RunOverrides['fetcher'] => async (url: string) =>
    url in map ? { ok: true as const, data: map[url]! } : { ok: false as const, error: new Error('unexpected url') as never }

  it('add refuses a manifest that names the reserved skill, before installing or writing anything', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const url = 'https://skill-set.md/trap.skill-set.json'
    const manifest = `${JSON.stringify({ name: 'trap', version: '1.0.0', skills: ['hcjmartin/evil-repo@skill-sets'] }, null, 2)}\n`
    const { code, err } = await cli(cwd, fake, ['add', url, '--yes'], { fetcher: mapFetcher({ [url]: manifest }) })
    expect(code).toBe(1)
    expect(err).toContain('reserved for the set-definitions directory')
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SETS_DIR))).toBe(false)
  })

  it('init refuses a member that names the reserved skill', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code, err } = await cli(cwd, fake, ['init', 'trap', 'hcjmartin/evil-repo@skill-sets'])
    expect(code).toBe(1)
    expect(err).toContain('reserved for the set-definitions directory')
    expect(fake.calls).toHaveLength(0)
    expect(existsSync(join(cwd, SETS_DIR, 'trap'))).toBe(false)
  })

  it('install refuses a hand-edited manifest that names the reserved skill, before any spawn', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    mkdirSync(join(cwd, SETS_DIR, 'trap'), { recursive: true })
    writeFileSync(
      join(cwd, SETS_DIR, 'trap', 'trap.skill-set.json'),
      `${JSON.stringify({ name: 'trap', version: '1.0.0', skills: ['hcjmartin/evil-repo@skill-sets'] }, null, 2)}\n`,
    )
    const { code, err } = await cli(cwd, fake, ['install', 'trap'])
    expect(code).toBe(1)
    expect(err).toContain('reserved for the set-definitions directory')
    expect(fake.calls).toHaveLength(0)
  })

  it('a member resolving to the reserved skill is refused post-spawn and the set definitions survive', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'base', 'hcjmartin/alpha-repo@alpha', '--yes'])
    const baseManifest = readFileSync(join(cwd, SETS_DIR, 'base', 'base.skill-set.json'), 'utf8')

    // An unnamed locator whose source resolves to a skill named "skill-sets" — the upstream
    // install lands on the sets directory itself and (fake, like real) overwrites it wholesale.
    mkdirSync(join(cwd, SETS_DIR, 'trap'), { recursive: true })
    writeFileSync(
      join(cwd, SETS_DIR, 'trap', 'trap.skill-set.json'),
      `${JSON.stringify({ name: 'trap', version: '1.0.0', skills: ['hcjmartin/skill-sets'] }, null, 2)}\n`,
    )
    const { code, out, err } = await cli(cwd, fake, ['install', 'trap'])
    expect(code).toBe(1)
    expect(err).toContain('resolved to the skill "skill-sets"')
    expect(err).toContain('the set definitions were restored')
    expect(out).toContain('its contents were restored')
    // Byte-exact survival of every set file, and no stray skill content in the sets dir.
    expect(readFileSync(join(cwd, SETS_DIR, 'base', 'base.skill-set.json'), 'utf8')).toBe(baseManifest)
    expect(existsSync(join(cwd, SETS_DIR, 'trap', 'trap.skill-set.json'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, INDEX_FILENAME))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, 'SKILL.md'))).toBe(false)
    const upstream = JSON.parse(readFileSync(join(cwd, 'skills-lock.json'), 'utf8')) as { skills: Record<string, unknown> }
    expect('skill-sets' in upstream.skills).toBe(false)
  })

  it('adding a shared set with a hostile unnamed member fails structurally — no crash, no set data lost', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const url = 'https://skill-set.md/authoring.skill-set.json'
    const manifest = `${JSON.stringify(
      { name: 'authoring', version: '1.0.0', skills: ['hcjmartin/gamma-repo@gamma', 'hcjmartin/skill-sets'] },
      null,
      2,
    )}\n`
    const { code, err } = await cli(cwd, fake, ['add', url, '--yes'], { fetcher: mapFetcher({ [url]: manifest }) })
    expect(code).toBe(1)
    // The regression: this sequence used to die in the generic wrapper with a raw ENOENT.
    expect(err).not.toContain('Unexpected failure')
    expect(err).not.toContain('ENOENT')
    expect(err).toContain('resolved to the skill "skill-sets"')
    expect(existsSync(join(cwd, SETS_DIR, 'authoring', 'authoring.skill-set.json'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, 'SKILL.md'))).toBe(false)
    expect(existsSync(join(cwd, SKILLS_DIR, 'gamma'))).toBe(true)
  })

  it('set files a spawn tampers with are restored byte-exact, with a notice', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'base', 'hcjmartin/alpha-repo@alpha', '--yes'])
    const baseManifest = readFileSync(join(cwd, SETS_DIR, 'base', 'base.skill-set.json'), 'utf8')

    await cli(cwd, fake, ['init', 'more', 'hcjmartin/beta-repo'])
    const runner: CommandRunner = async (command, args, opts) => {
      const result = await fake.runner(command, args, opts)
      // A hostile side effect alongside an otherwise ordinary install.
      rmSync(join(cwd, SETS_DIR, 'base', 'base.skill-set.json'), { force: true })
      return result
    }
    const { code, out } = await cli(cwd, { ...fake, runner }, ['install', 'more'])
    expect(code).toBe(0)
    expect(out).toContain('its contents were restored')
    expect(readFileSync(join(cwd, SETS_DIR, 'base', 'base.skill-set.json'), 'utf8')).toBe(baseManifest)
  })

  it('update restores set files the upstream spawn modified', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    await cli(cwd, fake, ['init', 'd', 'hcjmartin/alpha-repo@alpha', '--yes'])
    await cli(cwd, fake, ['lock', 'd'])
    const manifestPath = join(cwd, SETS_DIR, 'd', 'd.skill-set.json')
    const manifestBytes = readFileSync(manifestPath, 'utf8')
    const runner: CommandRunner = async (command, args, opts) => {
      const result = await fake.runner(command, args, opts)
      if (args[2] === 'update') rmSync(manifestPath, { force: true })
      return result
    }
    const { code, out } = await cli(cwd, { ...fake, runner }, ['update', 'd'])
    expect(code).toBe(0)
    expect(out).toContain('its contents were restored')
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBytes)
  })

  it('the renamed skill-set skill installs as an ordinary member beside the sets directory', async () => {
    const cwd = project()
    const fake = fakeSkills(cwd)
    const { code } = await cli(cwd, fake, ['init', 'tooling', 'hcjmartin/skill-set@skill-set', '--yes'])
    expect(code).toBe(0)
    expect(existsSync(join(cwd, SKILLS_DIR, 'skill-set', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(cwd, SETS_DIR, 'tooling', 'tooling.skill-set.json'))).toBe(true)
  })
})
