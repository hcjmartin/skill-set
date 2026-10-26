import { homedir } from 'node:os'

export interface RedactOptions {
  /** Replaced with `~`; defaults to os.homedir(). */
  home?: string
  /** Replaced with `.`; defaults to process.cwd(). */
  cwd?: string
  /** Values (e.g. args after `--`) that must never appear, replaced with `<arg>`. */
  secrets?: readonly string[]
}

// Same classes the skill-sets.md site logger scrubs; prefixes stay visible so a report still shows what leaked.
const TOKEN_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bgithub_pat_[A-Za-z0-9_]+/g, 'github_pat_***'],
  [/\b(gh[pousr])_[A-Za-z0-9]+/g, '$1_***'],
  [/\bglpat-[A-Za-z0-9_-]+/g, 'glpat-***'],
  [/\b(xox[bap])-[A-Za-z0-9-]+/g, '$1-***'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***'],
  [/\b([A-Za-z0-9_-]*(?:key|token|secret|password))=[^\s&"'`]+/gi, '$1=***'],
]

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{}]+/gi
// scp-style git remotes (git@host:owner/repo.git) never appear in a report.
const SCP_REMOTE_PATTERN = /\b[\w.-]+@[\w.-]+:[\w./~-]+/g
const PUBLIC_SET_PATH = /^\/sets\/([a-z0-9][a-z0-9-]*)(?:\/\1\.skill-set(?:\.lock)?\.json)?\/?$/
const ABSOLUTE_PATH = /(^|[\s"'`(=,:[])(\/[^\s"'`)\],]+|[A-Za-z]:\\[^\s"'`)\],]*)/g

export function redactUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '<url>'
  }
  if (url.host === '') return '<url>'
  const origin = `${url.protocol}//${url.host}`
  const trailing = /[.,;:!?]+$/.exec(url.pathname)?.[0] ?? ''
  const pathname = url.pathname.slice(0, url.pathname.length - trailing.length)
  if (url.hostname === 'skill-sets.md' && PUBLIC_SET_PATH.test(pathname)) return `${origin}${pathname}${trailing}`
  return `${origin}${trailing}`
}

/**
 * Scrubs free text for a public issue: tokens, URL paths/queries/credentials, git remotes,
 * and machine paths. Placeholders shield redacted URLs from the path pass.
 */
export function redact(text: string, opts: RedactOptions = {}): string {
  const home = trimSlash(opts.home ?? homedir())
  const cwd = trimSlash(opts.cwd ?? process.cwd())
  let out = text
  for (const secret of opts.secrets ?? []) {
    if (secret.length >= 2) out = out.split(secret).join('<arg>')
  }
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement)

  const kept: string[] = []
  const shield = (value: string): string => `\uE000${kept.push(value) - 1}\uE000`
  out = out.replace(URL_PATTERN, (match) => shield(redactUrl(match)))
  out = out.replace(SCP_REMOTE_PATTERN, () => shield('<remote>'))

  // Longest prefix first, so a cwd inside home becomes `.` rather than `~/…`.
  const roots: Array<[string, string]> = [
    [cwd, '.'],
    [home, '~'],
  ]
  roots.sort((a, b) => b[0].length - a[0].length)
  for (const [root, replacement] of roots) {
    if (root.length > 1) out = replaceRoot(out, root, replacement)
  }
  out = out.replace(ABSOLUTE_PATH, (_match, lead: string) => `${lead}<path>`)

  return out.replace(/\uE000(\d+)\uE000/g, (_match, i: string) => kept[Number(i)]!)
}

/** Caps text at `maxBytes` of UTF-8, marking the cut with `[truncated]`. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = '\n[truncated]'
  const budget = Math.max(maxBytes - Buffer.byteLength(marker, 'utf8'), 0)
  let cut = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8')
  // A split multi-byte character decodes as U+FFFD; drop it rather than ship a broken glyph.
  if (cut.endsWith('�')) cut = cut.slice(0, -1)
  return `${cut}${marker}`
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/[/\\]+$/, '') : path
}

function replaceRoot(text: string, root: string, replacement: string): string {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`${escaped}(?=[/\\\\]|$|[^\\w.-])`, 'g'), replacement)
}
