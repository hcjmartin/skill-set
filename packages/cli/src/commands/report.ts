import { spawn } from 'node:child_process'
import ci from 'ci-info'
import pkg from '../../package.json' with { type: 'json' }
import { ErrorCodes, SkillSetError } from '../errors.ts'
import { readLastError, type LastError } from '../last-error.ts'
import { redact, truncateBytes } from '../redact.ts'
import { SKILLS_PIN } from '../resolver.ts'
import { splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const REPORT_USAGE = 'skill-set report [--last] [--title <t>] [--security]'

export const REPORT_REPO = 'hcjmartin/skill-set'
export const REPORT_TEMPLATE = 'bug_report.yml'
/** Field ids from .github/ISSUE_TEMPLATE/bug_report.yml. */
export const REPORT_FIELDS = { what: 'what', expected: 'expected', versions: 'versions' } as const
/** contact_links[0].url in .github/ISSUE_TEMPLATE/config.yml. */
export const SECURITY_ADVISORY_URL = `https://github.com/${REPORT_REPO}/security/advisories/new`
export const MAX_BODY_BYTES = 4096
// GitHub and common proxies start rejecting or cutting request lines around 8 KB.
export const MAX_URL_LENGTH = 8000
const MAX_TITLE_LENGTH = 200

export interface IssueReport {
  url: string
  title: string
  body: string
  repo: string
  template: string
  consentRequired: true
}

export interface ReportInput {
  last?: LastError
  title?: string
  cwd: string
  version?: string
}

export function versionLine(version: string = pkg.version): string {
  const nodeMajor = process.versions.node.split('.')[0]
  return `skill-set/${version}, Node ${nodeMajor}, ${process.platform}-${process.arch}, skills@${SKILLS_PIN}`
}

function whatSection(last: LastError | undefined, version: string): string {
  if (last === undefined) return 'Describe the command you ran and what it printed.'
  const command = ['skill-set', last.command ?? '<command>', ...last.flags].join(' ')
  const lines = [
    `Command: \`${command}\``,
    `Error: ${last.code} (exit ${last.exitCode})`,
    ...(last.at === '' ? [] : [`When: ${last.at}`]),
    ...(last.cli === `skill-set/${version}` ? [] : [`Recorded by: ${last.cli}`]),
    '',
    '```text',
    last.message,
    ...(last.hint === undefined ? [] : [last.hint]),
    '```',
  ]
  return lines.join('\n')
}

export function buildIssueUrl(fields: { title: string; what: string; expected: string; versions: string }): string {
  const params: Array<[string, string]> = [
    ['template', REPORT_TEMPLATE],
    ['title', fields.title],
    [REPORT_FIELDS.what, fields.what],
    ...(fields.expected === '' ? [] : [[REPORT_FIELDS.expected, fields.expected] as [string, string]]),
    [REPORT_FIELDS.versions, fields.versions],
  ]
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `https://github.com/${REPORT_REPO}/issues/new?${query}`
}

/** Builds the redacted title, markdown body, and prefilled issue-form URL. Pure: nothing is sent or opened. */
export function buildReport(input: ReportInput): IssueReport {
  const version = input.version ?? pkg.version
  const opts = { cwd: input.cwd }
  const defaultTitle = input.last === undefined
    ? 'skill-set: <short summary>'
    : `skill-set ${input.last.command ?? ''} fails with ${input.last.code}`.replace(/\s+/g, ' ')
  const title = redact(input.title ?? defaultTitle, opts).slice(0, MAX_TITLE_LENGTH)
  const versions = versionLine(version)
  let what = truncateBytes(redact(whatSection(input.last, version), opts), MAX_BODY_BYTES)
  const body = truncateBytes(
    ['### What happened', '', what, '', '### What you expected', '', '_Describe what you expected._', '', '### Versions', '', versions].join('\n'),
    MAX_BODY_BYTES,
  )

  // Percent-encoding can triple the size, so trim the free-text field until the URL fits.
  let url = buildIssueUrl({ title, what, expected: '', versions })
  while (url.length > MAX_URL_LENGTH) {
    const budget = Buffer.byteLength(what, 'utf8') - Math.ceil((url.length - MAX_URL_LENGTH) / 3) - 16
    what = truncateBytes(what, Math.max(budget, 0))
    url = buildIssueUrl({ title, what, expected: '', versions })
  }
  return { url, title, body, repo: REPORT_REPO, template: REPORT_TEMPLATE, consentRequired: true }
}

/** Hands the URL to the platform opener; resolves false when none could be started. */
export function openInBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]]
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

export async function cmdReport(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, ['--last', '--security'], REPORT_USAGE, ['--title'])
  if (!split.ok) return split
  const { flags, values, positionals } = split.data
  if (positionals.length > 0) return usageError('report takes no positional arguments', REPORT_USAGE)

  if (flags.has('--security')) {
    if (flags.has('--last') || values.has('--title')) {
      return usageError('--security cannot be combined with --last or --title', REPORT_USAGE)
    }
    ctx.ui.out('Report security vulnerabilities privately, never in a public issue:')
    ctx.ui.out(`  ${SECURITY_ADVISORY_URL}`)
    return { ok: true, data: { url: SECURITY_ADVISORY_URL, repo: REPORT_REPO, security: true } }
  }

  let last: LastError | undefined
  if (flags.has('--last')) {
    last = readLastError(ctx.cacheDir)
    if (last === undefined) {
      return {
        ok: false,
        error: new SkillSetError(ErrorCodes.USAGE, 'No failed run is recorded to report', {
          hint: 'Run "skill-set report" without --last and describe the problem in the issue.',
        }),
      }
    }
  }

  const report = buildReport({ last, title: values.get('--title'), cwd: ctx.cwd })
  const { ui } = ctx
  ui.out(`Issue report for ${REPORT_REPO}. Review it; nothing has been sent:`)
  ui.out()
  for (const line of report.body.split('\n')) ui.out(`  ${line}`)
  ui.out()

  // Consent is a human at a terminal: CI, pipes, and --json never open anything.
  const canOpen = ui.interactive && !ui.json && !(ctx.ci ?? ci.isCI)
  if (canOpen) {
    const answer = await ui.confirm('Open a prefilled GitHub issue in your browser?', { optional: true })
    if (answer.ok && answer.data) {
      const opened = await (ctx.opener ?? openInBrowser)(report.url)
      if (opened) {
        ui.out(`${ui.style('green', '✓')} Opened the issue form. Nothing is filed until you submit it there.`)
        return { ok: true, data: report }
      }
      ui.warn('Could not open a browser.')
    }
  }
  ui.out('To file it, open:')
  ui.out(report.url)
  return { ok: true, data: report }
}
