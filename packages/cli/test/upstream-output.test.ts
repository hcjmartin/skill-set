import { describe, expect, it } from 'vitest'
import { createUi, type Writer } from '../src/ui.ts'
import { renderSecuritySummary, renderUpstreamPanel } from '../src/upstream-output.ts'

function outputUi(): { ui: ReturnType<typeof createUi>; read(): string } {
  let output = ''
  const stdout: Writer = { write: (text) => (output += text) }
  return {
    ui: createUi({ json: false, yes: true, interactive: true, stdout }),
    read: () => output,
  }
}

describe('captured upstream output', () => {
  it('shows the last five lines in a box and names hidden lines', () => {
    const target = outputUi()
    renderUpstreamPanel(target.ui, 'demo', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', false)
    expect(target.read()).toContain('skills CLI · demo')
    expect(target.read()).not.toContain('│ one')
    expect(target.read()).toContain('│ three')
    expect(target.read()).toContain('press e to expand')
    expect(target.read()).toContain('2 earlier lines hidden')
    expect(target.read()).not.toContain('│ …')
  })

  it('shows all captured lines after expansion', () => {
    const target = outputUi()
    renderUpstreamPanel(target.ui, 'demo', 'one\ntwo\nthree\nfour\nfive\nsix\n', true)
    expect(target.read()).toContain('│ one')
    expect(target.read()).not.toContain('earlier lines hidden')
  })

  it('aggregates passes and attributes warnings and issues to skills', () => {
    const target = outputUi()
    renderSecuritySummary(target.ui, [
      { skill: 'safe-skill', security: { gen: 'safe', socket: '0 alerts', snyk: 'no issues' } },
      { skill: 'review-skill', security: { gen: 'safe', socket: '2 alerts', snyk: 'high' } },
    ])
    expect(target.read()).toContain('Audit:')
    expect(target.read()).toContain('✓ 4 checks passed')
    expect(target.read()).toContain('! 1 warning')
    expect(target.read()).toContain('✗ 1 issue')
    expect(target.read()).toContain('review-skill — Socket: 2 alerts')
    expect(target.read()).toContain('review-skill — Snyk: high')
    expect(target.read()).not.toContain('safe-skill —')
  })

  it('treats missing upstream findings as an aggregated non-warning result', () => {
    const target = outputUi()
    renderSecuritySummary(target.ui, [
      { skill: 'one', security: null },
      { skill: 'two', security: null },
    ])
    expect(target.read()).toContain('Audit:')
    expect(target.read()).toContain('✓ no findings returned for 2 skills')
    expect(target.read()).not.toContain('warning')
    expect(target.read()).not.toContain('one — Audit')
  })
})
