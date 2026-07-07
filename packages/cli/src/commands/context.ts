import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import type { CommandRunner, SkillsInvocation } from '../resolver.ts'
import type { Ui } from '../ui.ts'

export { plural } from '../text.ts'

export interface CommandContext {
  cwd: string
  ui: Ui
  /** Injected upstream-CLI runner for hermetic tests; defaults to the real spawn. */
  runner?: CommandRunner
  /** Injected manifest fetcher for `add` tests; defaults to HTTPS fetch. */
  fetcher?: (url: string) => Promise<Result<string>>
  /** CI detection override for tests; defaults to ci-info. */
  ci?: boolean
  /** Args after the `--` sentinel, forwarded verbatim to upstream spawns. */
  passthrough: readonly string[]
  /** Print what would run or be written, change nothing, spawn nothing. */
  dryRun: boolean
}

/** One-line rendering of an upstream invocation, for provenance labels and --dry-run. */
export function formatInvocation(invocation: SkillsInvocation, extraArgs: readonly string[] = []): string {
  return [invocation.command, ...invocation.args, ...extraArgs]
    .map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))
    .join(' ')
}

export type CommandResult = Result<unknown>

export function usageError(message: string, usage: string): CommandResult {
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.USAGE, message, { hint: `Usage: ${usage}` }),
  }
}

/**
 * Splits a command's args into known flags and positionals; unknown flags are usage errors.
 * Flags named in `valued` take a value (`--flag value` or `--flag=value`), collected in `values`.
 */
export function splitFlags(
  args: readonly string[],
  allowed: readonly string[],
  usage: string,
  valued: readonly string[] = [],
): Result<{ flags: Set<string>; values: Map<string, string>; positionals: string[] }> {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const flagName = eq === -1 ? arg : arg.slice(0, eq)
    if (valued.includes(flagName)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1)
      if (value === undefined) {
        return {
          ok: false,
          error: new SkillSetError(ErrorCodes.USAGE, `${flagName} needs a value`, { hint: `Usage: ${usage}` }),
        }
      }
      values.set(flagName, value)
      continue
    }
    if (!allowed.includes(arg)) {
      return {
        ok: false,
        error: new SkillSetError(ErrorCodes.USAGE, `Unknown flag ${JSON.stringify(arg)}`, {
          hint: `Usage: ${usage}. Args for the wrapped skills CLI go after a "--" sentinel.`,
        }),
      }
    }
    flags.add(arg)
  }
  return { ok: true, data: { flags, values, positionals } }
}
