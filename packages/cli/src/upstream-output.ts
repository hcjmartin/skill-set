import type { Ui } from './ui.ts'
import { securityFindings, type UpstreamSecurity } from './upstream-add.ts'
import { stripTerminalSequences } from './terminal-text.ts'

const PANEL_LINES = 5
const PANEL_WIDTH = 76

export interface SecurityResult {
  skill: string
  security?: UpstreamSecurity
}

/** Lets an interactive user request full captured output while installs are running. */
export function watchForUpstreamExpansion(ui: Ui): { expanded(): boolean; close(): void } {
  const input = process.stdin
  if (!ui.interactive || input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return { expanded: () => false, close() {} }
  }

  let expand = false
  const wasRaw = input.isRaw
  const wasFlowing = input.readableFlowing
  const onData = (chunk: Buffer | string) => {
    const text = chunk.toString()
    if (text.toLowerCase().includes('e')) expand = true
    if (text.includes('\u0003')) process.kill(process.pid, 'SIGINT')
  }
  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
  return {
    expanded: () => expand,
    close() {
      input.off('data', onData)
      input.setRawMode(wasRaw)
      if (wasFlowing !== true) input.pause()
    },
  }
}

/** Shows a bounded, plain-text view of captured upstream diagnostics. */
export function renderUpstreamPanel(ui: Ui, skill: string, output: string, expanded: boolean): void {
  if (ui.json || !ui.interactive || output.trim() === '') return
  const lines = cleanLines(output)
  if (lines.length === 0) return
  const shown = expanded ? lines : lines.slice(-PANEL_LINES)
  const hidden = lines.length - shown.length
  const title = ` skills CLI · ${skill} `
  const expandLabel = hidden > 0 ? ' press e to expand ' : ''
  const topFill = Math.max(1, PANEL_WIDTH - title.length - expandLabel.length - 2)
  const top = `┌─${title}${'─'.repeat(topFill)}${expandLabel}┐`
  ui.out(ui.style('dim', top))
  for (const line of shown) ui.out(`${ui.style('dim', '│')} ${truncate(line, PANEL_WIDTH - 3)}`)
  const hiddenLabel = hidden > 0 ? ` ${hidden} earlier lines hidden ` : ''
  const bottomFill = Math.max(1, PANEL_WIDTH - hiddenLabel.length - 2)
  ui.out(ui.style('dim', `└─${hiddenLabel}${'─'.repeat(bottomFill)}┘`))
}

/** Aggregates passes and keeps every warning or issue attached to its skill. */
export function renderSecuritySummary(ui: Ui, results: readonly SecurityResult[]): void {
  if (ui.json || results.length === 0) return
  let passes = 0
  const noFindings: string[] = []
  const exceptions: Array<{ skill: string; provider: string; value: string; level: 'warning' | 'issue' }> = []
  for (const result of results) {
    for (const finding of securityFindings(result.security)) {
      if (finding.level === 'pass') passes++
      else if (finding.level === 'none') noFindings.push(result.skill)
      else {
        exceptions.push({
          skill: result.skill,
          provider: finding.provider,
          value: finding.value,
          level: finding.level,
        })
      }
    }
  }
  if (passes === 0 && noFindings.length === 0 && exceptions.length === 0) return

  const warnings = exceptions.filter((finding) => finding.level === 'warning').length
  const issues = exceptions.filter((finding) => finding.level === 'issue').length
  ui.out('Audit:')
  if (passes > 0) ui.out(`  ${ui.style('green', '✓')} ${passes} ${passes === 1 ? 'check passed' : 'checks passed'}`)
  if (noFindings.length > 0) {
    ui.out(
      `  ${ui.style('green', '✓')} no findings returned for ${noFindings.length} ${noFindings.length === 1 ? 'skill' : 'skills'}`,
    )
  }
  if (warnings > 0) ui.out(`  ${ui.style('yellow', '!')} ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  if (issues > 0) ui.out(`  ${ui.style('red', '✗')} ${issues} ${issues === 1 ? 'issue' : 'issues'}`)
  for (const finding of exceptions) {
    const marker = finding.level === 'issue' ? ui.style('red', '✗') : ui.style('yellow', '!')
    ui.out(`  ${marker} ${finding.skill} — ${finding.provider}: ${finding.value}`)
  }
}

function cleanLines(output: string): string[] {
  return stripTerminalSequences(output)
    .split(/\r?\n/)
    .map(normalizeUpstreamLine)
    .filter((line): line is string => line !== undefined)
}

const BOX_CHARACTERS = new Set('│┃┌┐└┘├┤┬┴┼╭╮╰╯─━ '.split(''))

function normalizeUpstreamLine(value: string): string | undefined {
  let line = value.trim()
  if (line === '' || [...line].every((character) => BOX_CHARACTERS.has(character))) return undefined
  while (line.startsWith('│') || line.startsWith('┃')) line = line.slice(1).trimStart()
  while (line.endsWith('│') || line.endsWith('┃')) line = line.slice(0, -1).trimEnd()
  while (line.endsWith('─') || line.endsWith('━') || line.endsWith('╯') || line.endsWith('╮')) {
    line = line.slice(0, -1).trimEnd()
  }
  return line === '' ? undefined : line
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`
}
