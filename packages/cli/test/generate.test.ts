import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../src/errors.ts'
import { generateIndex, generateSkillSetMd } from '../src/generate.ts'
import { createSetLock } from '../src/lock.ts'
import type { Manifest } from '../src/manifest.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const frontend: Manifest = {
  name: 'frontend',
  version: '1.0.0',
  description: 'Skills for frontend work.',
  skills: [
    'vercel-labs/agent-skills@web-design-guidelines#v2.1.0',
    'hcjmartin/skills-repo@skill-creator',
  ],
}

const lock = createSetLock('frontend', '1.0.0', {
  'hcjmartin/skills-repo@skill-creator': {
    skill: 'skill-creator',
    computedHash: HASH_A,
    sourceType: 'github',
    ref: 'a1b2c3d',
  },
  'vercel-labs/agent-skills@web-design-guidelines#v2.1.0': {
    skill: 'web-design-guidelines',
    computedHash: HASH_B,
  },
})

const members = {
  'hcjmartin/skills-repo@skill-creator': {
    skill: 'skill-creator',
    description: 'Guides creation of agent skills. Use when authoring a skill.',
  },
}

// The full documented output, asserted byte-for-byte — this IS the §7 determinism contract.
const GOLDEN = [
  '---',
  'name: "frontend"',
  'description: "Skills for frontend work. A set of 2 agent skills. Use when installing, verifying, or updating the \\"frontend\\" skill set."',
  '---',
  '',
  '# frontend',
  '',
  '## Overview',
  '',
  'Skills for frontend work.',
  '',
  'This set bundles 2 skills. It is generated from `frontend.skill-set.json`. Updates should be made to the manifest, not this file.',
  '',
  '## Skills in this set',
  '',
  '| Skill | Description | Source |',
  '| --- | --- | --- |',
  '| `skill-creator` | Guides creation of agent skills. Use when authoring a skill. | `hcjmartin/skills-repo@skill-creator` (locked to `a1b2c3d`) |',
  '| `web-design-guidelines` | (none recorded) | `vercel-labs/agent-skills@web-design-guidelines#v2.1.0` |',
  '',
  '## Installation',
  '',
  '```',
  'npx @skill-set/cli install frontend',
  '```',
  '',
  '## Usage',
  '',
  'Members install as ordinary skills under `.agents/skills/<skill>/`; once installed, agents discover and invoke them like any other skill.',
  '',
  '## Provenance',
  '',
  `Locked at set version 1.0.0. Every member's resolved content is recorded in \`frontend.skill-set.lock.json\` (setHash \`${lock.setHash}\`).`,
  '',
].join('\n')

describe('generateSkillSetMd', () => {
  it('produces the documented discovery page byte-for-byte', () => {
    expect(generateSkillSetMd(frontend, { members, lock })).toBe(GOLDEN)
  })

  it('is deterministic and insensitive to input order (spec §2.3/§7)', () => {
    const reordered: Manifest = { ...frontend, skills: [...frontend.skills].reverse() }
    expect(generateSkillSetMd(reordered, { members, lock })).toBe(GOLDEN)
    expect(generateSkillSetMd(reordered, { members, lock })).toBe(GOLDEN)
  })

  it('orders members by UTF-8 bytes, not UTF-16 code units', () => {
    // U+FF61 encodes as EF BD A1; U+10000 as F0 90 80 80 yet sorts first by UTF-16 surrogates.
    const m: Manifest = {
      name: 'x',
      version: '1.0.0',
      skills: ['owner/repo@\u{10000}', 'owner/repo@｡'],
    }
    const out = generateSkillSetMd(m)
    expect(out.indexOf('owner/repo@｡')).toBeLessThan(out.indexOf('owner/repo@\u{10000}'))
  })

  it('escapes backslashes, pipes, and newlines in table cells', () => {
    const m: Manifest = { name: 'x', version: '1.0.0', skills: ['owner/repo@a'] }
    const out = generateSkillSetMd(m, {
      members: { 'owner/repo@a': { skill: 'a', description: 'up | down\nleft \\| back' } },
    })
    expect(out).toContain('| `a` | up \\| down left \\\\\\| back | `owner/repo@a` |')
  })

  it('quotes YAML-ambiguous set names in the frontmatter', () => {
    // "no" and "123" satisfy the name pattern but parse as YAML boolean/int unquoted.
    const out = generateSkillSetMd({ name: 'no', version: '1.0.0', skills: ['owner/repo@a'] })
    expect(out).toContain('name: "no"')
  })

  it('renders unresolved members and the lock-free state with the command that fixes each', () => {
    const out = generateSkillSetMd(frontend, { members })
    expect(out).toContain('(not installed)')
    expect(out).toContain('No lock is recorded for this set.')
    expect(out).toContain('npx @skill-set/cli lock frontend')
  })

  it('adds a license line only when given one', () => {
    const out = generateSkillSetMd(frontend, { license: 'Complete terms in LICENSE.txt' })
    expect(out).toContain('license: "Complete terms in LICENSE.txt"')
    expect(generateSkillSetMd(frontend)).not.toContain('license:')
  })

  it('flags a lock written at a different set version', () => {
    const newer: Manifest = { ...frontend, version: '1.1.0' }
    const out = generateSkillSetMd(newer, { lock })
    expect(out).toContain('Locked at set version 1.0.0.')
    expect(out).toContain('the manifest is now at version 1.1.0')
  })

  it('rejects a lock belonging to a different set', () => {
    let error: unknown
    try {
      generateSkillSetMd({ ...frontend, name: 'backend' }, { lock })
    } catch (e) {
      error = e
    }
    expect((error as { code?: string }).code).toBe(ErrorCodes.INVALID_LOCK)
  })

  it('ends with exactly one trailing newline', () => {
    const out = generateSkillSetMd(frontend)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})

describe('generateIndex', () => {
  const api: Manifest = { name: 'api', version: '2.0.0', skills: ['owner/repo@b', 'owner/repo@a'] }

  const EXPECTED = [
    '{',
    '  "version": 1,',
    '  "sets": {',
    '    "api": {',
    '      "version": "2.0.0",',
    '      "skills": [',
    '        "owner/repo@a",',
    '        "owner/repo@b"',
    '      ]',
    '    },',
    '    "frontend": {',
    '      "version": "1.0.0",',
    '      "description": "Skills for frontend work.",',
    '      "skills": [',
    '        "hcjmartin/skills-repo@skill-creator",',
    '        "vercel-labs/agent-skills@web-design-guidelines#v2.1.0"',
    '      ]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')

  it('produces the documented index byte-for-byte, sets and members byte-sorted', () => {
    expect(generateIndex([frontend, api])).toBe(EXPECTED)
    expect(generateIndex([api, frontend])).toBe(EXPECTED)
  })

  it('rejects two sets declaring the same name', () => {
    let error: unknown
    try {
      generateIndex([api, { ...api }])
    } catch (e) {
      error = e
    }
    expect((error as { code?: string }).code).toBe(ErrorCodes.DUPLICATE_SET)
  })
})
