import { describe, expect, it } from 'vitest'
import { parseUpstreamAddResults, securityFindings, selectInstalledResult } from '../src/upstream-add.ts'

describe('skills add JSON adapter', () => {
  it('accepts the released contract and ignores additive fields', () => {
    const parsed = parseUpstreamAddResults(JSON.stringify([
      {
        name: 'find-skills',
        status: 'installed',
        source: 'vercel-labs/skills',
        ref: 'main',
        security: { gen: 'safe', socket: '0 alerts', snyk: 'medium', details: 'https://skills.sh/example' },
        futureField: true,
      },
    ]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const selected = selectInstalledResult(parsed.data, 'find-skills')
    expect(selected.ok).toBe(true)
    if (selected.ok) expect(selected.data.security?.snyk).toBe('medium')
  })

  it.each(['not json', '{}', '[{"status":"new-status"}]'])('rejects unsupported output: %s', (stdout) => {
    expect(parseUpstreamAddResults(stdout).ok).toBe(false)
  })

  it('preserves upstream failure and skip reasons', () => {
    const failed = selectInstalledResult([{ name: 'bad', status: 'failed', error: 'download failed' }])
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.message).toContain('download failed')

    const skipped = selectInstalledResult([{ name: 'missing', status: 'skipped', reason: 'No matching skill found' }])
    expect(skipped.ok).toBe(false)
    if (!skipped.ok) expect(skipped.error.message).toContain('No matching skill found')
  })

  it('classifies passes, warnings, and issues without changing provider text', () => {
    expect(securityFindings({ gen: 'safe', socket: '2 alerts', snyk: 'high' })).toEqual([
      { provider: 'Gen', value: 'safe', level: 'pass' },
      { provider: 'Socket', value: '2 alerts', level: 'warning' },
      { provider: 'Snyk', value: 'high', level: 'issue' },
    ])
    expect(securityFindings(null)).toEqual([
      { provider: 'Audit', value: 'no findings returned', level: 'none' },
    ])
  })
})
