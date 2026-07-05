import { ErrorCodes, SkillSetError } from '../errors.ts'
import { loadLockIfPresent, loadManifest, writeIndex, writeSetPage } from '../project.ts'
import { buildUpdateInvocation, locateMember } from '../resolver.ts'
import { runCommand } from '../spawn.ts'
import { lockSet } from './lock.ts'
import { formatInvocation, plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const UPDATE_USAGE = 'skill-set update <set>'

export async function cmdUpdate(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], UPDATE_USAGE)
  if (!split.ok) return split
  const [name, ...extra] = split.data.positionals
  if (name === undefined || extra.length > 0) return usageError('update takes exactly one set name', UPDATE_USAGE)

  const manifest = loadManifest(ctx.cwd, name)
  if (!manifest.ok) return manifest

  // Every member must be locatable before anything updates — aggregate what is not.
  const skills = new Set<string>()
  const problems: string[] = []
  for (const locator of manifest.data.skills) {
    const located = locateMember(locator, { cwd: ctx.cwd })
    if (located.ok) skills.add(located.data.skill)
    else problems.push(`${locator}: ${located.error.message}`)
  }
  if (problems.length > 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.MEMBER_NOT_INSTALLED,
        `Cannot update ${JSON.stringify(name)} — ${problems.length} members are not installed:\n  - ${problems.join('\n  - ')}`,
        { hint: `Install the set first: "skill-set install ${name}".`, data: { name, problems } },
      ),
    }
  }

  const names = [...skills]
  ctx.ui.out(`Updating ${plural(names.length, 'skill')} via the pinned skills CLI: ${names.join(', ')}`)
  const invocation = buildUpdateInvocation(names)
  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would run: ${formatInvocation(invocation, ctx.passthrough)}`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — nothing updated, lock and generated files untouched`)
    return { ok: true, data: { name, dryRun: true, wouldUpdate: names } }
  }
  ctx.ui.out(ctx.ui.style('dim', `running: ${formatInvocation(invocation, ctx.passthrough)}`))
  const invocationArgs = ctx.passthrough.length === 0 ? invocation.args : [...invocation.args, ...ctx.passthrough]
  const run = await (ctx.runner ?? runCommand)(invocation.command, invocationArgs, {
    cwd: ctx.cwd,
    env: invocation.env,
    capture: ctx.ui.json,
  })
  if (!run.ok) return run
  if (run.data.exitCode !== 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.RESOLVE_FAILED,
        `Updating ${JSON.stringify(name)} failed: the skills CLI exited with code ${run.data.exitCode}`,
        {
          hint: ctx.ui.json ? 'The captured skills output is in data.stderr.' : 'See the skills output above for the cause.',
          data: {
            name,
            exitCode: run.data.exitCode,
            ...(ctx.ui.json ? { stderr: run.data.stderr.slice(-2000) } : {}),
          },
        },
      ),
    }
  }

  // Content may have changed: re-lock only if a lock existed, then refresh generated files.
  const existing = loadLockIfPresent(ctx.cwd, name)
  if (!existing.ok) return existing
  let setHash: string | undefined
  if (existing.data !== undefined) {
    const relocked = lockSet(ctx.cwd, name, manifest.data)
    if (!relocked.ok) return relocked
    setHash = relocked.data.setHash
    ctx.ui.out(`${ctx.ui.style('green', '✓')} Re-locked ${name} — setHash ${setHash}`)
  } else {
    ctx.ui.out(ctx.ui.style('dim', `No set-lock to refresh; create one with "skill-set lock ${name}".`))
  }
  const lock = loadLockIfPresent(ctx.cwd, name)
  if (!lock.ok) return lock
  writeSetPage(ctx.cwd, manifest.data, lock.data)
  const index = writeIndex(ctx.cwd)
  if (!index.ok) return index

  return { ok: true, data: { name, updated: names, relocked: setHash !== undefined, setHash } }
}
