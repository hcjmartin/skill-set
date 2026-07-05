import { describe, expect, it } from 'vitest'
import { buildConfig } from '../src/config.ts'
import { buildAddInvocation, parseLocator, SKILLS_PIN } from '../src/resolver.ts'

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
    command: `npx -y skills@${SKILLS_PIN} add hcjmartin/skills-repo --skill skill-creator --yes`,
  },
  {
    locator: 'vercel-labs/skills@web-design-guidelines#v2.1.0',
    source: 'vercel-labs/skills',
    skill: 'web-design-guidelines',
    ref: 'v2.1.0',
    command: `npx -y skills@${SKILLS_PIN} add vercel-labs/skills#v2.1.0 --skill web-design-guidelines --yes`,
  },
  {
    locator: 'https://github.com/hcjmartin/agent-skills@review-code#8f7e6d5',
    source: 'https://github.com/hcjmartin/agent-skills',
    skill: 'review-code',
    ref: '8f7e6d5',
    command: `npx -y skills@${SKILLS_PIN} add https://github.com/hcjmartin/agent-skills#8f7e6d5 --skill review-code --yes`,
  },
  {
    locator: 'https://flocker.md/skills@research-notes',
    source: 'https://flocker.md/skills',
    skill: 'research-notes',
    command: `npx -y skills@${SKILLS_PIN} add https://flocker.md/skills --skill research-notes --yes`,
  },
  {
    locator: 'git@github.com:hcjmartin/skills-repo@deploy-helper',
    source: 'git@github.com:hcjmartin/skills-repo',
    skill: 'deploy-helper',
    command: `npx -y skills@${SKILLS_PIN} add git@github.com:hcjmartin/skills-repo --skill deploy-helper --yes`,
  },
  {
    // The git@ user-info @ is not a skill separator: what follows is not a valid skill name.
    locator: 'git@github.com:hcjmartin/skills-repo',
    source: 'git@github.com:hcjmartin/skills-repo',
    command: `npx -y skills@${SKILLS_PIN} add git@github.com:hcjmartin/skills-repo --yes`,
  },
  {
    locator: './vendor/skills@my-skill',
    source: './vendor/skills',
    skill: 'my-skill',
    command: `npx -y skills@${SKILLS_PIN} add ./vendor/skills --skill my-skill --yes`,
  },
  {
    locator: 'owner/repo',
    source: 'owner/repo',
    command: `npx -y skills@${SKILLS_PIN} add owner/repo --yes`,
  },
  {
    // A trailing empty ref is meaningless and normalized away.
    locator: 'owner/repo#',
    source: 'owner/repo',
    command: `npx -y skills@${SKILLS_PIN} add owner/repo --yes`,
  },
  {
    // No path-like source before the @, so this is not a skill split.
    locator: 'git@server',
    source: 'git@server',
    command: `npx -y skills@${SKILLS_PIN} add git@server --yes`,
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
