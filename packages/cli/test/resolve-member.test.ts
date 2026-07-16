import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../src/errors.ts'
import { specFolderHash } from '../src/hash.ts'
import { locateMember, resolveMember, SKILLS_DIR, type CommandRunner } from '../src/resolver.ts'

// Hermetic table over resolveMember's discovery branches: the runner stands in for the
// upstream CLI, so every lock-diff path is reachable without a network or a real spawn.

interface LockEntry {
  source: string
  sourceType: string
  computedHash: string
  ref?: string
}

const HASH = 'a'.repeat(64)

function entry(source: string, ref?: string): LockEntry {
  return { source, sourceType: 'github', computedHash: HASH, ...(ref === undefined ? {} : { ref }) }
}

const dirs: string[] = []
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function project(seed?: Record<string, LockEntry>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'skill-set-resolve-'))
  dirs.push(cwd)
  if (seed !== undefined) {
    writeLock(cwd, seed)
    for (const skill of Object.keys(seed)) addFolder(cwd, skill)
  }
  return cwd
}

function writeLock(cwd: string, skills: Record<string, LockEntry>): void {
  writeFileSync(join(cwd, 'skills-lock.json'), `${JSON.stringify({ version: 1, skills }, null, 2)}\n`)
}

function addFolder(cwd: string, skill: string): void {
  const folder = join(cwd, SKILLS_DIR, skill)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${skill}\n---\n\nBody.\n`)
}

/** A runner that simulates the install by writing the given after-state, then exits 0. */
function installs(
  cwd: string,
  after: Record<string, LockEntry>,
  opts?: { skipFolders?: boolean },
): CommandRunner {
  return async (_command, args) => {
    if (args.includes('--list')) {
      return {
        ok: true,
        data: { exitCode: 0, stdout: `\u001b[?25h◇ Found \u001b[32m${Object.keys(after).length}\u001b[0m skills\n`, stderr: '' },
      }
    }
    writeLock(cwd, after)
    if (opts?.skipFolders !== true) for (const skill of Object.keys(after)) addFolder(cwd, skill)
    return { ok: true, data: { exitCode: 0, stdout: '', stderr: '' } }
  }
}

/** A runner that touches nothing — upstream's in-place update of an already-present skill. */
function noopInstall(): CommandRunner {
  return async (_command, args) => ({
    ok: true,
    data: { exitCode: 0, stdout: args.includes('--list') ? '◇ Found 1 skill\n' : '', stderr: '' },
  })
}

describe('resolveMember discovery', () => {
  it('tier 1: a fresh unnamed install resolves via the new lock key', async () => {
    const cwd = project()
    const runner = installs(cwd, { 'find-skills': entry('vercel-labs/agent-skills') })
    const result = await resolveMember('vercel-labs/agent-skills', { cwd, runner })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (!result.ok) return
    expect(result.data.skill).toBe('find-skills')
    expect(result.data.computedHash).toBe(specFolderHash(join(cwd, SKILLS_DIR, 'find-skills')))
    expect(result.data.sourceType).toBe('github')
  })

  it('a named locator resolves without any lock diff', async () => {
    const cwd = project({ 'find-skills': entry('vercel-labs/agent-skills') })
    const result = await resolveMember('vercel-labs/skills@find-skills', { cwd, runner: noopInstall() })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.skill).toBe('find-skills')
  })

  it('tier 2: an unnamed reinstall resolves via a unique source match', async () => {
    const cwd = project({
      'find-skills': entry('vercel-labs/agent-skills'),
      unrelated: entry('someone/else'),
    })
    const result = await resolveMember('vercel-labs/agent-skills', { cwd, runner: noopInstall() })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (result.ok) expect(result.data.skill).toBe('find-skills')
  })

  it('tier 2: a pinned ref narrows same-source entries to one', async () => {
    const cwd = project({
      stable: entry('owner/repo', 'v1'),
      next: entry('owner/repo', 'v2'),
    })
    const result = await resolveMember('owner/repo#v2', { cwd, runner: noopInstall() })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (!result.ok) return
    expect(result.data.skill).toBe('next')
    expect(result.data.ref).toBe('v2')
  })

  it('tier 3: several same-source matches fail with the candidates listed', async () => {
    const cwd = project({ alpha: entry('owner/repo'), beta: entry('owner/repo') })
    const result = await resolveMember('owner/repo', { cwd, runner: noopInstall() })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.RESOLVE_AMBIGUOUS)
    expect(result.error.message).toContain('alpha, beta')
    expect(result.error.hint).toContain('"owner/repo@alpha"')
  })

  it('tier 3: zero matches fail with the factual message and a naming suggestion', async () => {
    const cwd = project({ unrelated: entry('someone/else') })
    const result = await resolveMember('owner/repo', { cwd, runner: noopInstall() })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.RESOLVE_UNMATCHED)
    expect(result.error.message).toBe(
      'Member "owner/repo" was installed, but could not be matched to a skill in skills-lock.json.',
    )
    expect(result.error.hint).toContain('"owner/repo@<skill-name>"')
  })

  it('a fresh install of several skills fails the one-skill rule before writing anything', async () => {
    const cwd = project()
    const runner = installs(cwd, { one: entry('owner/repo'), two: entry('owner/repo') })
    const result = await resolveMember('owner/repo', { cwd, runner })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.RESOLVE_AMBIGUOUS)
    expect(result.error.message).toContain('matches 2 available skills')
    expect(result.error.message).toContain('Nothing was installed')
    expect(result.error.data).toMatchObject({ count: 2 })
    expect(existsSync(join(cwd, 'skills-lock.json'))).toBe(false)
    expect(existsSync(join(cwd, SKILLS_DIR, 'one'))).toBe(false)
    expect(existsSync(join(cwd, SKILLS_DIR, 'two'))).toBe(false)
  })

  it('fails closed when successful --list output has no dependable count', async () => {
    const cwd = project()
    let calls = 0
    const runner: CommandRunner = async () => {
      calls++
      return { ok: true, data: { exitCode: 0, stdout: 'Available Skills\n', stderr: '' } }
    }
    const result = await resolveMember('owner/repo', { cwd, runner })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.RESOLVE_FAILED)
    expect(result.error.message).toContain('did not report how many skills are available')
    expect(calls).toBe(1)
    expect(existsSync(join(cwd, 'skills-lock.json'))).toBe(false)
  })

  it('a named skill absent from the lock fails with RESOLVE_NO_LOCK_ENTRY', async () => {
    const cwd = project()
    const runner = installs(cwd, { other: entry('owner/repo') })
    const result = await resolveMember('owner/repo@missing', { cwd, runner })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.RESOLVE_NO_LOCK_ENTRY)
  })

  it('a locked skill whose folder is missing fails with RESOLVE_FOLDER_MISSING', async () => {
    const cwd = project()
    const runner = installs(cwd, { ghost: entry('owner/repo') }, { skipFolders: true })
    const result = await resolveMember('owner/repo', { cwd, runner })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.RESOLVE_FOLDER_MISSING)
  })

  it('a non-zero upstream exit fails with RESOLVE_FAILED and the exit code', async () => {
    const cwd = project()
    const runner: CommandRunner = async () => ({
      ok: true,
      data: { exitCode: 7, stdout: '', stderr: '' },
    })
    const result = await resolveMember('owner/repo', { cwd, runner })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.RESOLVE_FAILED)
    expect(result.error.data).toMatchObject({ exitCode: 7 })
  })

  it('an empty locator fails fast without spawning', async () => {
    const cwd = project()
    let spawned = false
    const runner: CommandRunner = async () => {
      spawned = true
      return { ok: true, data: { exitCode: 0, stdout: '', stderr: '' } }
    }
    const result = await resolveMember('  ', { cwd, runner })
    expect(result.ok).toBe(false)
    expect(spawned).toBe(false)
  })
})

describe('locateMember (finds already-installed skills)', () => {
  it('resolves a named locator to its installed folder and spec hash', () => {
    const cwd = project({ 'find-skills': entry('vercel-labs/agent-skills') })
    const result = locateMember('vercel-labs/skills@find-skills', { cwd })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (!result.ok) return
    expect(result.data.skill).toBe('find-skills')
    expect(result.data.computedHash).toBe(specFolderHash(join(cwd, SKILLS_DIR, 'find-skills')))
    expect(result.data.sourceType).toBe('github')
  })

  it('resolves an unnamed locator via a unique source match', () => {
    const cwd = project({
      'find-skills': entry('vercel-labs/agent-skills'),
      unrelated: entry('someone/else'),
    })
    const result = locateMember('vercel-labs/agent-skills', { cwd })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (result.ok) expect(result.data.skill).toBe('find-skills')
  })

  it('narrows same-source entries by pinned ref', () => {
    const cwd = project({ stable: entry('owner/repo', 'v1'), next: entry('owner/repo', 'v2') })
    const result = locateMember('owner/repo#v2', { cwd })
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
    if (!result.ok) return
    expect(result.data.skill).toBe('next')
    expect(result.data.ref).toBe('v2')
  })

  it('rejects an unnamed locator matching several skills with the candidates listed', () => {
    const cwd = project({ alpha: entry('owner/repo'), beta: entry('owner/repo') })
    const result = locateMember('owner/repo', { cwd })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.RESOLVE_AMBIGUOUS)
    expect(result.error.message).toContain('alpha, beta')
    expect(result.error.data).toMatchObject({ candidates: ['alpha', 'beta'] })
  })

  it('fails an unnamed locator with zero source matches as MEMBER_NOT_INSTALLED', () => {
    const cwd = project({ unrelated: entry('someone/else') })
    const result = locateMember('owner/repo', { cwd })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.MEMBER_NOT_INSTALLED)
  })

  it('fails when the locked skill has no folder on disk', () => {
    const cwd = project()
    writeLock(cwd, { ghost: entry('owner/repo') }) // lock entry, but no folder
    const result = locateMember('owner/repo', { cwd })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.MEMBER_NOT_INSTALLED)
  })

  it('rejects an empty locator', () => {
    const result = locateMember('   ', { cwd: project() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.RESOLVE_FAILED)
  })
})
