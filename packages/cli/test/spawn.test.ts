import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../src/errors.ts'
import { runCommand } from '../src/spawn.ts'

describe('runCommand', () => {
  it('captures stdout and propagates the exit code', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'console.log("out"); console.error("err"); process.exit(3)'],
      // NODE_OPTIONS cleared so inspector flags from a parent process can't pollute stderr.
      { capture: true, env: { NODE_OPTIONS: '' } },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.stdout.trim()).toBe('out')
      expect(result.data.stderr.trim()).toBe('err')
      expect(result.data.exitCode).toBe(3)
    }
  })

  it('merges provided env over the parent environment', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.SKILLSET_TEST_VAR ?? "unset")'],
      { capture: true, env: { SKILLSET_TEST_VAR: 'value' } },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.stdout).toBe('value')
  })

  it('maps a signal death to the conventional 128+signal exit code', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.kill(process.pid, "SIGTERM")'],
      { capture: true, env: { NODE_OPTIONS: '' } },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.exitCode).toBe(143)
  })

  it('fails with SPAWN_FAILED when the binary does not exist', async () => {
    const result = await runCommand('skill-set-no-such-binary', [], { capture: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe(ErrorCodes.SPAWN_FAILED)
  })
})
