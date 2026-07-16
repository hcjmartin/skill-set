import pkg from '../package.json' with { type: 'json' }
import { ErrorCodes, SkillSetError, type Result, type SkillSetErrorCode } from './errors.ts'
import { SKILLS_PIN, type CommandRunner } from './resolver.ts'
import { createUi, type Writer } from './ui.ts'
import { cmdAdd } from './commands/add.ts'
import { cmdBuild } from './commands/build.ts'
import { cmdInit } from './commands/init.ts'
import { cmdInstall } from './commands/install.ts'
import { cmdLock } from './commands/lock.ts'
import { cmdRemove } from './commands/remove.ts'
import { cmdShare } from './commands/share.ts'
import { cmdUpdate } from './commands/update.ts'
import { cmdVerify } from './commands/verify.ts'
import type { CommandContext, CommandResult } from './commands/context.ts'

export const VERSION: string = pkg.version

interface CommandEntry {
  usage: string
  describe: string
  handler: (args: string[], ctx: CommandContext) => Promise<CommandResult>
}

const COMMANDS: Record<string, CommandEntry> = {
  init: { usage: 'init <set> [locators...]', describe: 'Scaffold a new set manifest', handler: cmdInit },
  add: { usage: 'add <url|path> [--hash]', describe: 'Fetch a shared set manifest, then install it', handler: cmdAdd },
  install: { usage: 'install <set>', describe: 'Install members, skipping ones the lock already satisfies', handler: cmdInstall },
  build: { usage: 'build [<set>] [--lock]', describe: 'Regenerate SKILL-SET.md files and the skill-sets.json index', handler: cmdBuild },
  lock: { usage: 'lock <set>', describe: "Record each member's installed content in a set-lock", handler: cmdLock },
  share: { usage: 'share [<set>] [--manifest <path>] [--output <dir>]', describe: 'Export a shareable manifest and lock', handler: cmdShare },
  verify: { usage: 'verify [<set>] [--frozen]', describe: 'Verify installed content against each set lock (frozen: require the lock)', handler: cmdVerify },
  update: { usage: 'update <set>', describe: 'Update members via the skills CLI, then re-lock', handler: cmdUpdate },
  remove: { usage: 'remove <set>', describe: 'Remove a set definition, optionally remove skills not otherwise in use', handler: cmdRemove },
}

const TAGLINE = 'define, share, and install named, versioned sets of agent skills'

const HELP = `skill-set — ${TAGLINE}.

Usage: skill-set <command> [args] [flags] [-- <args for the skills CLI>]

Commands:
${Object.values(COMMANDS)
  .map((c) => `  ${c.usage.padEnd(26)} ${c.describe}`)
  .join('\n')}

Flags:
  --json                Machine-readable output: exactly one JSON object on stdout
  --yes, -y             Assume yes for prompts (required where a prompt would block CI)
  --dry-run             Print what would run or be written; change nothing, spawn nothing
  --hash sha256:<hex>   For add: keep the set only if its content matches this set hash
  --help, -h            Show this help
  --version, -v         Show the skill-set version and the pinned skills version

Args after "--" pass through to the skills CLI verbatim.
  e.g. "skill-set install demo -- --agent claude-code cursor" installs to those agents only.
See npx skills --help.

Exit codes: 0 ok · 1 error · 2 usage · 3 drift · 4 conflict

Docs: https://skill-set.md
Repo: https://github.com/hcjmartin/skill-set
`

export interface RunOverrides {
  cwd?: string
  runner?: CommandRunner
  fetcher?: (url: string) => Promise<Result<string>>
  ci?: boolean
  interactive?: boolean
  /** Overrides the intro-line TTY/stream detection (tests). --json still wins. */
  intro?: boolean
  confirmAnswers?: boolean[]
  promptAnswers?: string[]
  stdout?: Writer
  stderr?: Writer
}

export async function run(argv: readonly string[], overrides: RunOverrides = {}): Promise<number> {
  const stdout = overrides.stdout ?? process.stdout
  const stderr = overrides.stderr ?? process.stderr

  const sentinel = argv.indexOf('--')
  const ours = sentinel === -1 ? [...argv] : [...argv.slice(0, sentinel)]
  const passthrough = sentinel === -1 ? [] : [...argv.slice(sentinel + 1)]

  // Meta-flags are intercepted before any dispatch — upstream runs `update` even when passed
  // `--help` (verified foot-gun); that bug class must be structurally impossible here.
  if (ours.length === 0 || ours.includes('--help') || ours.includes('-h')) {
    stdout.write(HELP)
    return 0
  }
  if (ours.includes('--version') || ours.includes('-v')) {
    stdout.write(`skill-set/${VERSION} (wraps skills@${SKILLS_PIN}, pinned)\n`)
    return 0
  }

  let json = false
  let yes = false
  let dryRun = false
  const rest: string[] = []
  for (const arg of ours) {
    if (arg === '--json') json = true
    else if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--dry-run') dryRun = true
    else rest.push(arg)
  }
  const [verb, ...args] = rest

  const ui = createUi({
    json,
    yes,
    interactive: overrides.interactive,
    confirmAnswers: overrides.confirmAnswers,
    promptAnswers: overrides.promptAnswers,
    // Pass the raw overrides: createUi treats a present stdout as an injected stream and
    // disables colors, so resolving the default here would turn colors off for real TTYs.
    stdout: overrides.stdout,
    stderr: overrides.stderr,
  })
  // One branded line for humans, on stderr so stdout stays clean; pipes, CI, --json,
  // and injected streams (tests) never see it.
  const showIntro =
    !json && (overrides.intro ?? (ui.interactive && overrides.stderr === undefined && process.stderr.isTTY === true))
  if (showIntro) {
    const wordmark = `${ui.accent('{')}${ui.style('bold', 'skill-set')}${ui.accent('}')}`
    stderr.write(`${wordmark} ${ui.style('dim', `v${VERSION} — ${TAGLINE}`)}\n`)
  }

  const ctx: CommandContext = {
    cwd: overrides.cwd ?? process.cwd(),
    ui,
    runner: overrides.runner,
    fetcher: overrides.fetcher,
    ci: overrides.ci,
    passthrough,
    dryRun,
  }

  let result: CommandResult
  const command = verb === undefined ? undefined : COMMANDS[verb]
  if (command === undefined) {
    result = {
      ok: false,
      error: new SkillSetError(ErrorCodes.USAGE, `Unknown command ${JSON.stringify(verb ?? '')}`, {
        hint: 'Run "skill-set --help" for the command list.',
      }),
    }
  } else {
    try {
      result = await command.handler(args, ctx)
    } catch (cause) {
      // Even a crash must yield a parseable error in --json mode, so it lands in `result`.
      result = {
        ok: false,
        error: new SkillSetError(ErrorCodes.UNEXPECTED, `Unexpected failure: ${(cause as Error).message}`, {
          cause,
        }),
      }
    }
  }

  if (json) {
    const envelope = result.ok
      ? { ok: true, command: verb, data: result.data }
      : {
          ok: false,
          command: verb,
          error: {
            code: result.error.code,
            message: result.error.message,
            ...(result.error.hint === undefined ? {} : { hint: result.error.hint }),
            ...(result.error.data === undefined ? {} : { data: result.error.data }),
          },
        }
    stdout.write(`${JSON.stringify(envelope)}\n`)
  } else if (!result.ok) {
    stderr.write(`${ui.style(['red', 'bold'], 'error')} ${result.error.message}\n`)
    if (result.error.hint !== undefined) stderr.write(`${ui.style('dim', result.error.hint)}\n`)
  }
  return result.ok ? 0 : exitCodeFor(result.error.code)
}

// The documented taxonomy: usage mistakes, lock drift, and cross-set conflicts are
// machine-distinguishable; everything else is a plain error. Blocked confirmations and
// a missing lock under --frozen are precondition-shaped, so they land with usage (2).
// A verification mismatch on add is content-not-as-verified, the same class as drift; JSON
// consumers discriminate via error.code.
function exitCodeFor(code: SkillSetErrorCode): number {
  if (code === ErrorCodes.USAGE || code === ErrorCodes.CONFIRM_REQUIRED || code === ErrorCodes.FROZEN_NO_LOCK) return 2
  if (code === ErrorCodes.DRIFT || code === ErrorCodes.RECEIPT_MISMATCH) return 3
  if (code === ErrorCodes.CONFLICT) return 4
  return 1
}
