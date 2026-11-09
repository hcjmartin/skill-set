import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCodes } from '../src/errors.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildConfig } from '../src/config.ts'
import {
  buildAddInvocation,
  buildListInvocation,
  parseLocator,
  SKILLS_BIN_ENV,
  SKILLS_PIN,
  skillsUpstream,
  resolveMember,
} from '../src/resolver.ts'

// One row per source kind the upstream resolver accepts, plus grammar edges.
const TABLE: Array<{
  locator: string
  source: string
  skill?: string
  ref?: string
  command: string
}> = [
  {
    locator: 'hcjmartin/skills-repo@skill-creator',
    source: 'hcjmartin/skills-repo',
    skill: 'skill-creator',
    command: `npx -y skills@${SKILLS_PIN} add hcjmartin/skills-repo --skill skill-creator --yes --json`,
  },
  {
    locator: 'vercel-labs/agent-skills@web-design-guidelines#v2.1.0',
    source: 'vercel-labs/agent-skills',
    skill: 'web-design-guidelines',
    ref: 'v2.1.0',
    command: `npx -y skills@${SKILLS_PIN} add vercel-labs/agent-skills#v2.1.0 --skill web-design-guidelines --yes --json`,
  },
  {
    locator: 'https://github.com/hcjmartin/agent-skills@review-code#8f7e6d5',
    source: 'https://github.com/hcjmartin/agent-skills',
    skill: 'review-code',
    ref: '8f7e6d5',
    command: `npx -y skills@${SKILLS_PIN} add https://github.com/hcjmartin/agent-skills#8f7e6d5 --skill review-code --yes --json`,
  },
  {
    locator: 'https://flocker.md/skills@research-notes',
    source: 'https://flocker.md/skills',
    skill: 'research-notes',
    command: `npx -y skills@${SKILLS_PIN} add https://flocker.md/skills --skill research-notes --yes --json`,
  },
  {
    locator: 'git@github.com:hcjmartin/skills-repo@deploy-helper',
    source: 'git@github.com:hcjmartin/skills-repo',
    skill: 'deploy-helper',
    command: `npx -y skills@${SKILLS_PIN} add git@github.com:hcjmartin/skills-repo --skill deploy-helper --yes --json`,
  },
  {
    // The git@ user-info @ is not a skill separator: what follows is not a valid skill name.
    locator: 'git@github.com:hcjmartin/skills-repo',
    source: 'git@github.com:hcjmartin/skills-repo',
    command: `npx -y skills@${SKILLS_PIN} add git@github.com:hcjmartin/skills-repo --yes --json`,
  },
  {
    locator: './vendor/skills@my-skill',
    source: './vendor/skills',
    skill: 'my-skill',
    command: `npx -y skills@${SKILLS_PIN} add ./vendor/skills --skill my-skill --yes --json`,
  },
  {
    locator: 'owner/repo',
    source: 'owner/repo',
    command: `npx -y skills@${SKILLS_PIN} add owner/repo --yes --json`,
  },
  {
    // A trailing empty ref is meaningless and normalized away.
    locator: 'owner/repo#',
    source: 'owner/repo',
    command: `npx -y skills@${SKILLS_PIN} add owner/repo --yes --json`,
  },
  {
    // No path-like source before the @, so this is not a skill split.
    locator: 'git@server',
    source: 'git@server',
    command: `npx -y skills@${SKILLS_PIN} add git@server --yes --json`,
  },
]

describe('parseLocator', () => {
  it.each(TABLE)('$locator', (row) => {
    expect(parseLocator(row.locator)).toEqual({ source: row.source, skill: row.skill, ref: row.ref })
  })
})

describe('buildAddInvocation', () => {
  it.each(TABLE)('$locator', (row) => {
    const inv = buildAddInvocation(row.locator)
    expect([inv.command, ...inv.args].join(' ')).toBe(row.command)
  })

  it('telemetry suppression follows the build config flag', () => {
    expect(buildAddInvocation('owner/repo@x').env).toEqual(
      buildConfig.suppressUpstreamTelemetry ? { DISABLE_TELEMETRY: '1' } : {},
    )
  })

  it('appends --global when requested', () => {
    const inv = buildAddInvocation('owner/repo@x', { global: true })
    expect(inv.args[inv.args.length - 1]).toBe('--global')
  })
})

describe('buildListInvocation', () => {
  it('uses the pinned upstream no-write list mode and preserves a ref', () => {
    const inv = buildListInvocation('owner/repo#v1.2.0')
    expect([inv.command, ...inv.args]).toEqual([
      'npx',
      '-y',
      `skills@${SKILLS_PIN}`,
      'add',
      'owner/repo#v1.2.0',
      '--list',
    ])
  })
})

describe('skillsUpstream', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  /** A fake installed package: <tmp>/node_modules/<name>/{package.json,bin/cli.mjs}; returns the bin path. */
  function vendored(manifest: Record<string, unknown> | null): string {
    const root = mkdtempSync(join(tmpdir(), 'skills-vendored-'))
    dirs.push(root)
    const pkg = join(root, 'node_modules', 'skills')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'bin', 'cli.mjs'), '')
    if (manifest !== null) writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest))
    return join(pkg, 'bin', 'cli.mjs')
  }

  it('defaults to npx with the pinned skills package and passes the check', () => {
    expect(skillsUpstream.command({})).toEqual({ command: 'npx', prefix: ['-y', `skills@${SKILLS_PIN}`] })
    expect(skillsUpstream.check({})).toEqual({ ok: true, data: undefined })
  })

  it(`runs the vendored entry named by ${SKILLS_BIN_ENV} with the current executable`, () => {
    const bin = vendored({ name: 'skills', version: SKILLS_PIN })
    vi.stubEnv(SKILLS_BIN_ENV, bin)
    expect(skillsUpstream.command()).toEqual({ command: process.execPath, prefix: [bin] })
    expect(skillsUpstream.check()).toEqual({ ok: true, data: undefined })
    const inv = buildAddInvocation('owner/repo@x')
    expect(inv.command).toBe(process.execPath)
    expect(inv.args.slice(0, 3)).toEqual([bin, 'add', 'owner/repo'])
    expect(inv.args).not.toContain(`skills@${SKILLS_PIN}`)
  })

  it(`treats a whitespace-only ${SKILLS_BIN_ENV} as unset`, () => {
    vi.stubEnv(SKILLS_BIN_ENV, '   ')
    expect(skillsUpstream.command()).toEqual({ command: 'npx', prefix: ['-y', `skills@${SKILLS_PIN}`] })
    expect(buildAddInvocation('owner/repo@x').command).toBe('npx')
  })

  it('rejects an override whose package is a different version', () => {
    vi.stubEnv(SKILLS_BIN_ENV, vendored({ name: 'skills', version: '0.0.1' }))
    const result = skillsUpstream.check()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(ErrorCodes.UPSTREAM_MISMATCH)
    expect(result.error.message).toContain('skills@0.0.1')
    expect(result.error.message).toContain(`skills@${SKILLS_PIN}`)
  })

  it('rejects an override whose package is not skills', () => {
    vi.stubEnv(SKILLS_BIN_ENV, vendored({ name: 'not-skills', version: SKILLS_PIN }))
    expect(skillsUpstream.check()).toMatchObject({ ok: false, error: { code: ErrorCodes.UPSTREAM_MISMATCH } })
  })

  it('rejects an override with no package.json above it', () => {
    const bin = vendored(null)
    vi.stubEnv(SKILLS_BIN_ENV, bin)
    const result = skillsUpstream.check()
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.UPSTREAM_MISMATCH } })
    if (result.ok) return
    expect(result.error.message).toContain('no package.json')
  })

  it('fails the resolve before any spawn when the override is wrong', async () => {
    vi.stubEnv(SKILLS_BIN_ENV, vendored({ name: 'skills', version: '0.0.1' }))
    const cwd = mkdtempSync(join(tmpdir(), 'skills-cwd-'))
    dirs.push(cwd)
    const runner = vi.fn()
    const result = await resolveMember('owner/repo@x', { cwd, runner })
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCodes.UPSTREAM_MISMATCH } })
    expect(runner).not.toHaveBeenCalled()
  })
})
