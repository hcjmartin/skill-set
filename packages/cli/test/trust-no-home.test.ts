import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run, type RunOverrides } from '../src/run.ts'
import { CONFIG_DIR_ENV } from '../src/trust.ts'
import type { Writer } from '../src/ui.ts'

// A user with no HOME and no passwd entry (a container with an arbitrary uid): Node's home
// lookup throws. `add` must flag that and behave exactly as it did before the store existed.

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return {
    ...os,
    homedir: () => {
      throw new Error('ENOENT: no such file or directory, uv_os_homedir')
    },
  }
})

const SETS_DIR = '.skill-sets'
const saved = { config: process.env[CONFIG_DIR_ENV], xdg: process.env.XDG_CONFIG_HOME }
const dirs: string[] = []

beforeEach(() => {
  delete process.env[CONFIG_DIR_ENV]
  delete process.env.XDG_CONFIG_HOME
})
afterEach(() => {
  if (saved.config === undefined) delete process.env[CONFIG_DIR_ENV]
  else process.env[CONFIG_DIR_ENV] = saved.config
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = saved.xdg
})
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skill-set-no-home-'))
  dirs.push(dir)
  return dir
}

async function cli(cwd: string, argv: string[], extra: Partial<RunOverrides> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const stdout: Writer = { write: (s: string) => (out += s) }
  const stderr: Writer = { write: (s: string) => (err += s) }
  const code = await run(argv, { cwd, interactive: false, ci: false, stdout, stderr, ...extra })
  return { code, out, err }
}

const manifest = JSON.stringify({ name: 'bare', version: '1.0.0', description: 'A set.', skills: ['hcjmartin/gamma-repo@gamma'] })
const warning = `warning: no home directory, so the trusted sources file cannot be located; set ${CONFIG_DIR_ENV} to use one. Continuing without it.`

describe('add without a resolvable trust store', () => {
  it('flags it and proceeds from a built-in provider', async () => {
    const cwd = project()
    const url = 'https://skill-sets.md/sets/bare/bare.skill-set.json'
    const fetched: string[] = []
    const fetcher: RunOverrides['fetcher'] = async (at: string) => {
      fetched.push(at)
      return { ok: true as const, data: manifest }
    }
    const { code, out, err } = await cli(cwd, ['add', url, '--dry-run', '--json'], { fetcher })
    expect(code).toBe(0)
    expect(fetched).toEqual([url])
    expect((JSON.parse(out) as { data: { trust: unknown } }).data.trust).toEqual({ state: 'allowlisted', host: 'skill-sets.md' })
    expect(err).toContain(warning)
    expect(existsSync(join(cwd, SETS_DIR))).toBe(false)
  })

  it('flags it and still refuses an unrecognised host before any fetch', async () => {
    const cwd = project()
    const fetched: string[] = []
    const fetcher: RunOverrides['fetcher'] = async (at: string) => {
      fetched.push(at)
      return { ok: true as const, data: manifest }
    }
    const { code, out, err } = await cli(cwd, ['add', 'https://unknown-origin.invalid/bare.skill-set.json', '--dry-run', '--json'], { fetcher })
    expect(code).toBe(2)
    expect(fetched).toEqual([])
    expect((JSON.parse(out) as { error: { code: string; data: { host: string } } }).error).toMatchObject({
      code: 'ERR_SKILLSET_CONFIRM_REQUIRED',
      data: { host: 'unknown-origin.invalid' },
    })
    expect(err).toContain(warning)
  })

  it('does not look for the store on a local path', async () => {
    const cwd = project()
    const { err } = await cli(cwd, ['add', join(cwd, 'missing.skill-set.json'), '--dry-run', '--json'])
    expect(err).not.toContain('trusted sources')
  })
})

describe('trust without a resolvable store', () => {
  it('fails clearly, naming the override', async () => {
    const { code, out } = await cli(project(), ['trust', '--list', '--json'])
    expect(code).toBe(1)
    const envelope = JSON.parse(out) as { error: { code: string; hint: string } }
    expect(envelope.error.code).toBe('ERR_SKILLSET_UNEXPECTED')
    expect(envelope.error.hint).toContain(CONFIG_DIR_ENV)
  })
})
