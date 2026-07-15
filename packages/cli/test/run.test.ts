import { describe, expect, it } from 'vitest'
import { run, VERSION } from '../src/run.ts'
import type { Writer } from '../src/ui.ts'

function writers(): { stdout: Writer; stderr: Writer; text(): { out: string; err: string } } {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    text: () => ({ out, err }),
  }
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const w = writers()
  const code = await run(argv, { stdout: w.stdout, stderr: w.stderr, interactive: false, ci: false })
  return { code, ...w.text() }
}

describe('run — dispatch and meta-flags', () => {
  it('prints help and exits 0 with --help', async () => {
    const { code, out } = await cli(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('Usage: skill-set <command>')
    // The passthrough hint names the real upstream agent-selection flag.
    expect(out).toContain('skill-set install demo -- --agent claude-code cursor')
    expect(out).toContain('Exit codes: 0 ok · 1 error · 2 usage · 3 drift · 4 conflict')
  })

  it('prints help and exits 0 with no args', async () => {
    const { code, out } = await cli([])
    expect(code).toBe(0)
    expect(out).toContain('Commands:')
    expect(out).toContain('--dry-run')
  })

  it('intercepts --help before any command dispatch', async () => {
    // The upstream foot-gun this design forbids: `update --help` must never execute.
    const { code, out, err } = await cli(['update', '--help'])
    expect(code).toBe(0)
    expect(out).toContain('Usage: skill-set <command>')
    expect(err).toBe('')
  })

  it('reports both our version and the upstream pin with --version', async () => {
    const { code, out } = await cli(['--version'])
    expect(code).toBe(0)
    expect(out).toContain(`skill-set/${VERSION}`)
    expect(out).toContain('skills@1.5.14')
  })

  it('intercepts --version after a verb before any dispatch', async () => {
    // Same foot-gun class as `update --help`: a meta-flag after a verb must never run the verb.
    const { code, out, err } = await cli(['update', '--version'])
    expect(code).toBe(0)
    expect(out).toContain(`skill-set/${VERSION}`)
    expect(err).toBe('')
  })

  it('intercepts the short meta-flags -h and -v after a verb', async () => {
    const help = await cli(['update', '-h'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: skill-set <command>')
    expect(help.err).toBe('')
    const version = await cli(['update', '-v'])
    expect(version.code).toBe(0)
    expect(version.out).toContain(`skill-set/${VERSION}`)
    expect(version.err).toBe('')
  })

  it('a --help after the passthrough sentinel is not a meta-flag', async () => {
    // `-- --help` belongs to the wrapped CLI; the command itself still dispatches (usage error here).
    const { code } = await cli(['nonsense', '--', '--help'])
    expect(code).toBe(2)
  })

  it('a --version after the passthrough sentinel is not a meta-flag', async () => {
    const { code, out } = await cli(['nonsense', '--', '--version'])
    expect(code).toBe(2)
    expect(out).not.toContain(`skill-set/${VERSION}`)
  })

  it('a flags-only invocation is a usage error, never a dispatch', async () => {
    // Our mode flags without a verb name no command; nothing may run or forward.
    const { code, err } = await cli(['--dry-run'])
    expect(code).toBe(2)
    expect(err).toContain('Unknown command ""')
    expect(err).toContain('skill-set --help')
  })

  it('--json alone still yields the single usage-error envelope', async () => {
    const { code, out } = await cli(['--json'])
    expect(code).toBe(2)
    const lines = out.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0]!) as { ok: boolean; error: { code: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_USAGE')
  })

  it('exits 2 for an unknown command, with the help hint on stderr', async () => {
    const { code, err } = await cli(['banana'])
    expect(code).toBe(2)
    expect(err).toContain('Unknown command "banana"')
    expect(err).toContain('skill-set --help')
  })

  it('--json wraps even a usage error in a single parseable envelope', async () => {
    const w = writers()
    const code = await run(['banana', '--json'], { stdout: w.stdout, stderr: w.stderr, interactive: false })
    expect(code).toBe(2)
    const lines = w.text().out.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(1)
    const envelope = JSON.parse(lines[0]!) as { ok: boolean; error: { code: string } }
    expect(envelope.ok).toBe(false)
    expect(envelope.error.code).toBe('ERR_SKILLSET_USAGE')
  })

  it('VERSION matches package.json', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } })
    expect(VERSION).toBe(pkg.default.version)
  })
})

describe('run — intro line', () => {
  it('prints the branded line on stderr, keeping stdout clean', async () => {
    const w = writers()
    await run(['banana'], { stdout: w.stdout, stderr: w.stderr, interactive: false, ci: false, intro: true })
    const { out, err } = w.text()
    expect(err).toContain(`{skill-set} v${VERSION} — define, share`)
    expect(out).not.toContain('{skill-set}')
  })

  it('is suppressed with injected streams unless forced (pipes/CI/tests see nothing)', async () => {
    const { err } = await cli(['banana'])
    expect(err).not.toContain('{skill-set}')
  })

  it('--json wins even when the intro is forced on', async () => {
    const w = writers()
    await run(['banana', '--json'], { stdout: w.stdout, stderr: w.stderr, interactive: false, intro: true })
    expect(w.text().err).not.toContain('{skill-set}')
  })
})
