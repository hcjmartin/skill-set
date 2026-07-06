import { createInterface } from 'node:readline/promises'
import { styleText } from 'node:util'
import ci from 'ci-info'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'

export interface Writer {
  write(text: string): unknown
}

export interface UiOptions {
  json: boolean
  yes: boolean
  /** Overrides TTY/CI detection (tests, or a caller that knows better). */
  interactive?: boolean
  /** Scripted confirm answers for tests, consumed in order before the refusal logic. */
  confirmAnswers?: boolean[]
  /** Scripted text prompt answers for tests, consumed in order before the refusal logic. */
  promptAnswers?: string[]
  stdout?: Writer
  stderr?: Writer
}

export interface Ui {
  readonly json: boolean
  readonly yes: boolean
  /** Human progress line on stdout; silent in --json mode so stdout stays one JSON object. */
  out(line?: string): void
  /** Warning line on stderr; never silenced. */
  warn(line: string): void
  /** Terminal styling; identity when colors are off (non-TTY, --json, or injected streams). */
  style(format: Parameters<typeof styleText>[0], text: string): string
  /**
   * Asks a yes/no question. --yes answers true without asking; when no prompt is possible
   * (--json, CI, no TTY) the caller gets a CONFIRM_REQUIRED error instead of a hang —
   * unless the prompt is `optional` (a convenience offer), which then resolves false.
   */
  confirm(question: string, opts?: { optional?: boolean }): Promise<Result<boolean>>
  /**
   * Asks for free text. Required prompts refuse when no prompt is possible; optional prompts
   * resolve undefined in non-interactive modes, so commands can offer metadata without blocking.
   */
  prompt(question: string, opts?: { optional?: boolean; defaultValue?: string }): Promise<Result<string | undefined>>
}

export function createUi(opts: UiOptions): Ui {
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const interactive =
    opts.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true && !ci.isCI)
  const colors = !opts.json && opts.stdout === undefined && process.stdout.isTTY === true
  const scripted = opts.confirmAnswers === undefined ? undefined : [...opts.confirmAnswers]
  const scriptedPrompts = opts.promptAnswers === undefined ? undefined : [...opts.promptAnswers]

  return {
    json: opts.json,
    yes: opts.yes,
    out(line = '') {
      if (!opts.json) stdout.write(`${line}\n`)
    },
    warn(line) {
      stderr.write(`${line}\n`)
    },
    style(format, text) {
      return colors ? styleText(format, text) : text
    },
    async confirm(question, confirmOpts) {
      if (opts.yes) return { ok: true, data: true }
      if (scripted !== undefined && scripted.length > 0) return { ok: true, data: scripted.shift()! }
      if (opts.json || !interactive) {
        if (confirmOpts?.optional === true) return { ok: true, data: false }
        return {
          ok: false,
          error: new SkillSetError(ErrorCodes.CONFIRM_REQUIRED, `Confirmation required: ${question}`, {
            hint: 'Re-run with --yes to confirm non-interactively.',
            data: { question },
          }),
        }
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
        return { ok: true, data: answer === 'y' || answer === 'yes' }
      } finally {
        rl.close()
      }
    },
    async prompt(question, promptOpts) {
      if (scriptedPrompts !== undefined && scriptedPrompts.length > 0) {
        const value = scriptedPrompts.shift()!.trim()
        return { ok: true, data: value === '' ? promptOpts?.defaultValue : value }
      }
      if (opts.yes && promptOpts?.defaultValue !== undefined) return { ok: true, data: promptOpts.defaultValue }
      if (opts.json || !interactive || opts.yes) {
        if (promptOpts?.optional === true) return { ok: true, data: promptOpts.defaultValue }
        return {
          ok: false,
          error: new SkillSetError(ErrorCodes.CONFIRM_REQUIRED, `Input required: ${question}`, {
            hint: 'Pass the value as an argument/flag, or re-run interactively.',
            data: { question },
          }),
        }
      }
      const suffix = promptOpts?.defaultValue === undefined ? '' : ` [${promptOpts.defaultValue}]`
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      try {
        const answer = (await rl.question(`${question}${suffix}: `)).trim()
        if (answer === '') return { ok: true, data: promptOpts?.defaultValue }
        return { ok: true, data: answer }
      } finally {
        rl.close()
      }
    },
  }
}
