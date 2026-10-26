import { describe, expect, it } from 'vitest'
import { redact, redactUrl, truncateBytes } from '../src/redact.ts'

// Annotated vectors: [why, input, expected]. home=/home/ada, cwd=/home/ada/proj.
const opts = { home: '/home/ada', cwd: '/home/ada/proj' }

const VECTORS: Array<[string, string, string]> = [
  // Paths
  ['cwd becomes .', 'Cannot read /home/ada/proj/.agents/skills/x', 'Cannot read ./.agents/skills/x'],
  ['cwd itself becomes .', 'in /home/ada/proj', 'in .'],
  ['home becomes ~', 'wrote /home/ada/notes/a.md', 'wrote ~/notes/a.md'],
  ['a sibling of cwd sharing its prefix is not cwd', 'see /home/ada/project2/x', 'see ~/project2/x'],
  ['other absolute paths become <path>', 'ENOENT: open "/etc/secret/thing"', 'ENOENT: open "<path>"'],
  ['paths after = and ( are caught', 'file=/var/x (/tmp/y)', 'file=<path> (<path>)'],
  ['windows drive paths become <path>', 'at C:\\Users\\ada\\x.json', 'at <path>'],
  ['relative and bare slashes are kept', 'owner/repo and a / b', 'owner/repo and a / b'],
  // URLs
  ['URLs keep scheme and host', 'fetch https://example.com/private/set.json?x=1#f', 'fetch https://example.com'],
  ['credentials and port handling', 'https://user:pw@host.dev:8443/p', 'https://host.dev:8443'],
  ['public directory set path survives', 'https://skill-sets.md/sets/frontend/frontend.skill-set.json', 'https://skill-sets.md/sets/frontend/frontend.skill-set.json'],
  ['directory set page survives, query dropped', 'https://skill-sets.md/sets/frontend?ref=x', 'https://skill-sets.md/sets/frontend'],
  ['other skill-sets.md paths are stripped', 'https://skill-sets.md/admin/users', 'https://skill-sets.md'],
  ['lookalike hosts do not get the exception', 'https://skill-sets.md.evil.dev/sets/frontend', 'https://skill-sets.md.evil.dev'],
  ['trailing punctuation stays outside the URL', 'see https://example.com/a.', 'see https://example.com.'],
  ['scp-style git remotes are removed', 'remote git@github.com:acme/private.git failed', 'remote <remote> failed'],
  // Tokens
  ['ghp_ classic token', 'token ghp_abcdefghijklmnop1234', 'token ghp_***'],
  ['gho_ oauth token', 'gho_ABCDEF123456', 'gho_***'],
  ['github_pat_ fine-grained token', 'github_pat_11ABC_def456', 'github_pat_***'],
  ['glpat- gitlab token', 'glpat-xyz_123-abc', 'glpat-***'],
  ['xoxb- slack token', 'xoxb-123-456-abc', 'xoxb-***'],
  ['xoxp- slack token', 'xoxp-999-abc', 'xoxp-***'],
  ['sk- api key', 'OPENAI sk-proj-abcdefgh12345', 'OPENAI sk-***'],
  ['short sk- words are not keys', 'task-sk-1', 'task-sk-1'],
  ['Bearer header', 'Authorization: Bearer eyJhbGciOi.abc.def', 'Authorization: Bearer ***'],
  ['key= value', 'api_key=hunter2 next', 'api_key=*** next'],
  ['token= value', 'TOKEN=abc123', 'TOKEN=***'],
  ['secret= and password= values', 'secret=s3 password=p4', 'secret=*** password=***'],
  ['tokens inside URLs are masked before the URL is cut', 'https://x.dev/?token=abc', 'https://x.dev'],
]

describe('redact — vectors', () => {
  it.each(VECTORS)('%s', (_why, input, expected) => {
    expect(redact(input, opts)).toBe(expected)
  })

  it('scrubs args after -- wherever they appear', () => {
    expect(redact('npx skills add x --agent my-private-agent', { ...opts, secrets: ['my-private-agent'] })).toBe(
      'npx skills add x --agent <arg>',
    )
  })

  it('is stable when applied twice (cache write, then report)', () => {
    for (const [, input] of VECTORS) expect(redact(redact(input, opts), opts)).toBe(redact(input, opts))
  })

  it('an unparseable URL collapses to <url>', () => {
    expect(redactUrl('http://[bad')).toBe('<url>')
  })
})

describe('truncateBytes', () => {
  it('leaves text within the cap alone', () => {
    expect(truncateBytes('short', 4096)).toBe('short')
  })

  it('caps at the byte budget and marks the cut', () => {
    const out = truncateBytes('x'.repeat(5000), 4096)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096)
    expect(out.endsWith('\n[truncated]')).toBe(true)
  })

  it('never splits a multi-byte character', () => {
    const out = truncateBytes('é'.repeat(3000), 4096)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096)
    expect(out).not.toContain('\uFFFD')
  })
})
