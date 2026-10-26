import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildIssueUrl,
  buildReport,
  MAX_BODY_BYTES,
  MAX_URL_LENGTH,
  REPORT_FIELDS,
  REPORT_TEMPLATE,
  SECURITY_ADVISORY_URL,
  versionLine,
} from '../src/commands/report.ts'
import { cacheDir, flagNames, LAST_ERROR_FILE, readLastError, type LastError } from '../src/last-error.ts'
import { SKILLS_PIN, type CommandRunner } from '../src/resolver.ts'
import { run, VERSION, type RunOverrides } from '../src/run.ts'

const dirs: string[] = []
afterAll(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function cli(argv: string[], overrides: RunOverrides = {}): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await run(argv, {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    interactive: false,
    ci: false,
    ...overrides,
  })
  return { code, out, err }
}

const repoFile = (path: string): string => readFileSync(join(import.meta.dirname, '../../..', path), 'utf8')

const sample: LastError = {
  command: 'install',
  flags: ['--yes'],
  code: 'ERR_SKILLSET_SPAWN_FAILED',
  message: 'Failed to run npx: spawn npx ENOENT',
  hint: 'Is Node on PATH?',
  exitCode: 1,
  cli: `skill-set/${VERSION}`,
  at: '2026-10-26T12:00:00.000Z',
}

// A runner that crashes, so any member install fails with an error code that gets the report hint.
const crashingRunner: CommandRunner = () => Promise.reject(new Error('boom at /opt/secret/place token=abc123'))

async function failingInstall(cache: string, extra: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const cwd = tmp('skill-set-report-proj-')
  const init = await cli(['init', 'demo', 'acme/alpha-repo@alpha'], { cwd, cacheDir: cache })
  expect(init.code).toBe(0)
  return cli(['install', 'demo', ...extra], { cwd, cacheDir: cache, runner: crashingRunner })
}

describe('issue template contract', () => {
  it('field ids match .github/ISSUE_TEMPLATE/bug_report.yml', () => {
    const yml = repoFile('.github/ISSUE_TEMPLATE/bug_report.yml')
    for (const id of Object.values(REPORT_FIELDS)) expect(yml).toContain(`id: ${id}\n`)
    expect(REPORT_TEMPLATE).toBe('bug_report.yml')
  })

  it('the security link matches .github/ISSUE_TEMPLATE/config.yml', () => {
    expect(repoFile('.github/ISSUE_TEMPLATE/config.yml')).toContain(`url: ${SECURITY_ADVISORY_URL}\n`)
  })
})

describe('buildReport', () => {
  it('names the version line: CLI, Node major, platform, and the skills pin', () => {
    const line = versionLine('9.9.9')
    expect(line).toBe(
      `skill-set/9.9.9, Node ${process.versions.node.split('.')[0]}, ${process.platform}-${process.arch}, skills@${SKILLS_PIN}`,
    )
  })

  it('builds a template URL with the what and versions fields, leaving expected for the reporter', () => {
    const report = buildReport({ last: sample, cwd: '/w' })
    const url = new URL(report.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/hcjmartin/skill-set/issues/new')
    expect(url.searchParams.get('template')).toBe('bug_report.yml')
    expect(url.searchParams.get('title')).toBe('skill-set install fails with ERR_SKILLSET_SPAWN_FAILED')
    expect(url.searchParams.get('what')).toContain('Command: `skill-set install --yes`')
    expect(url.searchParams.get('what')).toContain('spawn npx ENOENT')
    expect(url.searchParams.has('expected')).toBe(false)
    expect(url.searchParams.get('versions')).toBe(versionLine())
    expect(report).toMatchObject({ repo: 'hcjmartin/skill-set', template: 'bug_report.yml', consentRequired: true })
  })

  it('the body mirrors the issue form sections', () => {
    const { body } = buildReport({ last: sample, cwd: '/w' })
    expect(body).toMatch(/^### What happened\n[\s\S]*### What you expected\n[\s\S]*### Versions\n\nskill-set\//)
  })

  it('notes when the failure came from a different CLI version', () => {
    const { body } = buildReport({ last: { ...sample, cli: 'skill-set/0.0.1' }, cwd: '/w' })
    expect(body).toContain('Recorded by: skill-set/0.0.1')
  })

  it('without a recorded failure, asks the reporter to describe it', () => {
    const report = buildReport({ cwd: '/w' })
    expect(report.title).toBe('skill-set: <short summary>')
    expect(report.body).toContain('Describe the command you ran')
  })

  it('redacts a custom title', () => {
    expect(buildReport({ title: 'leak ghp_abcdef123456 at /etc/x', cwd: '/w' }).title).toBe('leak ghp_*** at <path>')
  })

  it('caps the body at 4 KB and the encoded URL under the safe length', () => {
    const huge = { ...sample, message: '€"<>&'.repeat(4000) }
    const report = buildReport({ last: huge, cwd: '/w' })
    expect(Buffer.byteLength(report.body)).toBeLessThanOrEqual(MAX_BODY_BYTES)
    expect(report.body).toContain('[truncated]')
    expect(report.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
    expect(new URL(report.url).searchParams.get('what')).toContain('[truncated]')
  })

  it('percent-encodes every value (no raw spaces or ampersands)', () => {
    const url = buildIssueUrl({ title: 'a & b', what: 'x y', expected: '', versions: 'v' })
    expect(url).toBe('https://github.com/hcjmartin/skill-set/issues/new?template=bug_report.yml&title=a%20%26%20b&what=x%20y&versions=v')
  })
})

describe('last-error cache', () => {
  it('uses $XDG_CACHE_HOME/skill-set, falling back to ~/.cache/skill-set', () => {
    expect(cacheDir({ XDG_CACHE_HOME: '/x/cache' })).toBe(join('/x/cache', 'skill-set'))
    expect(cacheDir({})).toMatch(/[/\\]\.cache[/\\]skill-set$/)
    expect(cacheDir({ XDG_CACHE_HOME: 'relative' })).toMatch(/[/\\]\.cache[/\\]skill-set$/)
  })

  it('keeps only our flag names, never their values', () => {
    expect(flagNames(['add', 'x', '--hash=sha256:abc', '-y', '--json', '--ghp_secret', '--yes'])).toEqual([
      '--hash',
      '--yes',
      '--json',
      '<flag>',
    ])
  })

  it('a failing run records a redacted envelope; the human hint line points at report', async () => {
    const cache = tmp('skill-set-cache-')
    const res = await failingInstall(cache, ['--yes', '--', '--agent', 'my-private-agent'])
    expect(res.code).toBe(1)
    expect(res.err).toContain('To report this: skill-set report --last')

    const raw = readFileSync(join(cache, LAST_ERROR_FILE), 'utf8')
    expect(raw).not.toContain('/opt/secret')
    expect(raw).not.toContain('abc123')
    expect(raw).not.toContain('my-private-agent')
    const last = readLastError(cache)!
    expect(last).toMatchObject({ command: 'install', flags: ['--yes'], exitCode: 1, cli: `skill-set/${VERSION}` })
    expect(['ERR_SKILLSET_UNEXPECTED', 'ERR_SKILLSET_SPAWN_FAILED', 'ERR_SKILLSET_INSTALL_FAILED']).toContain(last.code)
  })

  it('--json output carries no hint line and an unchanged envelope', async () => {
    const cache = tmp('skill-set-cache-')
    const res = await failingInstall(cache, ['--json', '--yes'])
    expect(res.err).not.toContain('skill-set report')
    const envelope = JSON.parse(res.out) as Record<string, unknown>
    expect(Object.keys(envelope)).toEqual(['ok', 'command', 'error'])
    expect(existsSync(join(cache, LAST_ERROR_FILE))).toBe(true)
  })

  it('user-input errors get no report hint', async () => {
    const res = await cli(['install', 'missing'], { cwd: tmp('skill-set-report-proj-'), cacheDir: tmp('skill-set-cache-') })
    expect(res.code).not.toBe(0)
    expect(res.err).not.toContain('skill-set report')
  })

  it('successful runs write nothing', async () => {
    const cache = tmp('skill-set-cache-')
    const res = await cli(['init', 'demo', 'acme/alpha-repo@alpha'], { cwd: tmp('skill-set-report-proj-'), cacheDir: cache })
    expect(res.code).toBe(0)
    expect(existsSync(join(cache, LAST_ERROR_FILE))).toBe(false)
  })

  it('an unwritable cache never changes the outcome', async () => {
    const parent = tmp('skill-set-cache-')
    const blocked = join(parent, 'file')
    writeFileSync(blocked, '')
    const res = await failingInstall(join(blocked, 'skill-set'))
    expect(res.code).toBe(1)
    if (process.platform !== 'win32') {
      const ro = join(parent, 'ro')
      mkdirSync(ro)
      chmodSync(ro, 0o500)
      expect((await failingInstall(ro)).code).toBe(1)
    }
  })

  it('a failing report does not overwrite the recorded failure', async () => {
    const cache = tmp('skill-set-cache-')
    await failingInstall(cache)
    const before = readFileSync(join(cache, LAST_ERROR_FILE), 'utf8')
    expect((await cli(['report', '--bogus'], { cacheDir: cache })).code).toBe(2)
    expect(readFileSync(join(cache, LAST_ERROR_FILE), 'utf8')).toBe(before)
  })

  it('a corrupt cache file reads as no failure', () => {
    const cache = tmp('skill-set-cache-')
    writeFileSync(join(cache, LAST_ERROR_FILE), '{not json')
    expect(readLastError(cache)).toBeUndefined()
  })
})

describe('skill-set report', () => {
  function cacheWith(last: LastError): string {
    const cache = tmp('skill-set-cache-')
    writeFileSync(join(cache, LAST_ERROR_FILE), JSON.stringify(last))
    return cache
  }

  it('--json returns the report in the envelope and opens nothing', async () => {
    const opened: string[] = []
    const res = await cli(['report', '--last', '--json'], {
      cacheDir: cacheWith(sample),
      interactive: true,
      opener: async (url) => (opened.push(url), true),
    })
    expect(res.code).toBe(0)
    const envelope = JSON.parse(res.out) as { ok: boolean; command: string; data: Record<string, unknown> }
    expect(envelope).toMatchObject({ ok: true, command: 'report' })
    expect(Object.keys(envelope.data).sort()).toEqual(['body', 'consentRequired', 'repo', 'template', 'title', 'url'])
    expect(envelope.data.consentRequired).toBe(true)
    expect(opened).toEqual([])
  })

  it('interactive: prints the body, asks, then opens the browser on yes', async () => {
    const opened: string[] = []
    const res = await cli(['report', '--last'], {
      cacheDir: cacheWith(sample),
      interactive: true,
      confirmAnswers: [true],
      opener: async (url) => (opened.push(url), true),
    })
    expect(res.code).toBe(0)
    expect(res.out).toContain('nothing has been sent')
    expect(res.out).toContain('### What happened')
    expect(res.out).toContain('Opened the issue form')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\/github\.com\/hcjmartin\/skill-set\/issues\/new\?template=bug_report\.yml/)
  })

  it('interactive: declining prints the URL instead', async () => {
    const opened: string[] = []
    const res = await cli(['report'], { interactive: true, confirmAnswers: [false], opener: async (u) => (opened.push(u), true) })
    expect(opened).toEqual([])
    expect(res.out).toContain('To file it, open:\nhttps://github.com/hcjmartin/skill-set/issues/new?')
  })

  it('falls back to printing the URL when no opener starts', async () => {
    const res = await cli(['report'], { interactive: true, confirmAnswers: [true], opener: async () => false })
    expect(res.err).toContain('Could not open a browser')
    expect(res.out).toContain('To file it, open:')
  })

  it.each([
    ['CI', { interactive: true, ci: true, yes: true }],
    ['non-TTY', { interactive: false, yes: true }],
  ])('never opens in %s, even with --yes', async (_name, mode) => {
    const opened: string[] = []
    const res = await cli(['report', ...(mode.yes ? ['--yes'] : [])], {
      interactive: mode.interactive,
      ci: 'ci' in mode ? mode.ci : false,
      opener: async (u) => (opened.push(u), true),
    })
    expect(res.code).toBe(0)
    expect(opened).toEqual([])
    expect(res.out).toContain('To file it, open:')
  })

  it('--title overrides the default title', async () => {
    const res = await cli(['report', '--title', 'install hangs', '--json'])
    expect((JSON.parse(res.out) as { data: { title: string } }).data.title).toBe('install hangs')
  })

  it('--last with nothing recorded is a usage error', async () => {
    const res = await cli(['report', '--last'], { cacheDir: tmp('skill-set-cache-') })
    expect(res.code).toBe(2)
    expect(res.err).toContain('No failed run is recorded')
  })

  it('--security prints the private advisory link and builds no issue URL', async () => {
    const res = await cli(['report', '--security'])
    expect(res.code).toBe(0)
    expect(res.out).toContain(SECURITY_ADVISORY_URL)
    expect(res.out).not.toContain('issues/new')
    const json = JSON.parse((await cli(['report', '--security', '--json'])).out) as { data: { url: string } }
    expect(json.data.url).toBe(SECURITY_ADVISORY_URL)
  })

  it('--security rejects --last and --title, and positionals are usage errors', async () => {
    expect((await cli(['report', '--security', '--last'])).code).toBe(2)
    expect((await cli(['report', 'extra'])).code).toBe(2)
  })
})
