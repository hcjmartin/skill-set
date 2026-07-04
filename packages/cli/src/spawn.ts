import { constants } from 'node:os'
import { x } from 'tinyexec'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'

export interface SpawnOutcome {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SpawnOptions {
  cwd?: string
  /** Extra environment entries, merged over process.env. */
  env?: Record<string, string>
  /** Capture stdout/stderr instead of inheriting the terminal (for --json/probe paths). */
  capture?: boolean
}

/** The single spawn site — every child process starts here . */
export async function runCommand(
  command: string,
  args: readonly string[],
  opts?: SpawnOptions,
): Promise<Result<SpawnOutcome>> {
  const child = x(command, args, {
    throwOnError: false,
    nodeOptions: {
      stdio: opts?.capture ? 'pipe' : 'inherit',
      cwd: opts?.cwd,
      env: opts?.env === undefined ? process.env : { ...process.env, ...opts.env },
    },
  })
  const onSigint = () => child.kill('SIGINT')
  process.once('SIGINT', onSigint)
  try {
    const output = await child
    if (output.exitCode === undefined && child.process?.signalCode == null && !child.killed) {
      return spawnFailure(command, args, undefined)
    }
    // A signal-killed child has no exit code; report the conventional 128+signal, never 0.
    const signal = child.process?.signalCode
    const exitCode = output.exitCode ?? (signal == null ? 1 : 128 + (constants.signals[signal] ?? 0))
    return { ok: true, data: { exitCode, stdout: output.stdout, stderr: output.stderr } }
  } catch (cause) {
    return spawnFailure(command, args, cause)
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

function spawnFailure(command: string, args: readonly string[], cause: unknown): Result<never> {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.SPAWN_FAILED, `Failed to run ${command}${detail}`, {
      hint: `Check that ${JSON.stringify(command)} is installed and on your PATH.`,
      data: { command, args: [...args] },
      ...(cause === undefined ? {} : { cause }),
    }),
  }
}
