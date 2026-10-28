import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { SkillSetError } from './errors.ts'
import { redact } from './redact.ts'

export const LAST_ERROR_FILE = 'last-error.json'

/** Our own flags; anything else a user typed is reported as `<flag>`, never by name. */
export const KNOWN_FLAGS: readonly string[] = [
  '--json',
  '--yes',
  '--dry-run',
  '--hash',
  '--lock',
  '--manifest',
  '--output',
  '--frozen',
  '--last',
  '--title',
  '--security',
]

export interface LastError {
  command: string | null
  flags: string[]
  code: string
  message: string
  hint?: string
  exitCode: number
  cli: string
  at: string
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(homedir(), '.cache')
  return join(base, 'skill-set')
}

/** Flag names only: values are dropped (`--hash=sha256:…` → `--hash`) and unknown flags anonymised. */
export function flagNames(args: readonly string[]): string[] {
  const names: string[] = []
  for (const arg of args) {
    if (!arg.startsWith('-')) continue
    const name = arg === '-y' ? '--yes' : arg.split('=', 1)[0]!
    const shown = KNOWN_FLAGS.includes(name) ? name : '<flag>'
    if (!names.includes(shown)) names.push(shown)
  }
  return names
}

// Flags whose value may be the next arg rather than `=value`.
const VALUED_FLAGS: readonly string[] = ['--hash', '--manifest', '--output', '--title']

/** What the user typed into flags (values, unknown flag names): scrubbed from messages like args after `--`. */
export function typedFlagInput(args: readonly string[]): string[] {
  const typed: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('-') || arg === '-y') continue
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    if (!KNOWN_FLAGS.includes(name)) typed.push(name)
    if (eq !== -1) typed.push(arg.slice(eq + 1))
    else if (VALUED_FLAGS.includes(name) && args[i + 1] !== undefined) typed.push(args[++i]!)
  }
  return typed
}

export interface RecordInput {
  command: string | null
  /** Args before the `--` sentinel. */
  args: readonly string[]
  /** Args after `--`: scrubbed from the message, never stored. */
  passthrough: readonly string[]
  error: SkillSetError
  exitCode: number
  cli: string
  cwd: string
  dir?: string
}

/** Best-effort: a failed write must never change a command's outcome, so every error is swallowed. */
export function recordLastError(input: RecordInput): void {
  try {
    const opts = { cwd: input.cwd, secrets: [...input.passthrough, ...typedFlagInput(input.args)] }
    const entry: LastError = {
      command: input.command,
      flags: flagNames(input.args),
      code: input.error.code,
      message: redact(input.error.message, opts),
      ...(input.error.hint === undefined ? {} : { hint: redact(input.error.hint, opts) }),
      exitCode: input.exitCode,
      cli: input.cli,
      at: new Date().toISOString(),
    }
    const dir = input.dir ?? cacheDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, LAST_ERROR_FILE), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Read-only home, full disk, sandbox: reporting is a convenience, the command's result stands.
  }
}

export function readLastError(dir: string = cacheDir()): LastError | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, LAST_ERROR_FILE), 'utf8')) as Partial<LastError>
    if (typeof value.code !== 'string' || typeof value.message !== 'string') return undefined
    return {
      command: typeof value.command === 'string' ? value.command : null,
      flags: Array.isArray(value.flags) ? value.flags.filter((f): f is string => typeof f === 'string') : [],
      code: value.code,
      message: value.message,
      ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
      exitCode: typeof value.exitCode === 'number' ? value.exitCode : 1,
      cli: typeof value.cli === 'string' ? value.cli : 'unknown',
      at: typeof value.at === 'string' ? value.at : '',
    }
  } catch {
    return undefined
  }
}
