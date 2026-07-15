import { mkdirSync, writeFileSync } from 'node:fs'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { createSetLock, serializeSetLock, type SetLock, type SetLockMember } from '../lock.ts'
import type { Manifest } from '../manifest.ts'
import { LOCK_SUFFIX } from '../lock.ts'
import { loadManifest, SETS_DIR, setPaths } from '../project.ts'
import { locateMember } from '../resolver.ts'
import { plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const LOCK_USAGE = 'skill-set lock <set>'

export async function cmdLock(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], LOCK_USAGE)
  if (!split.ok) return split
  const [name, ...extra] = split.data.positionals
  if (name === undefined || extra.length > 0) return usageError('lock takes exactly one set name', LOCK_USAGE)

  const manifest = loadManifest(ctx.cwd, name)
  if (!manifest.ok) return manifest

  ctx.ui.out(`Locking skill-set ${JSON.stringify(name)} — recording installed skill content...`)

  const locked = lockSet(ctx.cwd, name, manifest.data, { dryRun: ctx.dryRun })
  if (!locked.ok) return locked

  const relative = `${SETS_DIR}/${name}/${name}${LOCK_SUFFIX}`
  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would write: ${relative} (setHash ${locked.data.setHash})`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed`)
    return { ok: true, data: { name, dryRun: true, lock: relative, setHash: locked.data.setHash } }
  }
  ctx.ui.out(`${ctx.ui.style('green', '✓')} Locked ${name} (${plural(manifest.data.skills.length, 'skill')}) — ${relative}`)
  ctx.ui.out(ctx.ui.style('dim', `setHash ${locked.data.setHash}`))
  return { ok: true, data: { name, lock: relative, setHash: locked.data.setHash, members: manifest.data.skills.length } }
}

/**
 * Records every member's installed content in the set-lock. Members that cannot be located
 * are aggregated into one error — never just the first failure.
 */
export function lockSet(cwd: string, name: string, manifest: Manifest, opts?: { dryRun?: boolean }): Result<SetLock> {
  const members: Record<string, SetLockMember> = {}
  const problems: string[] = []
  for (const locator of manifest.skills) {
    const located = locateMember(locator, { cwd })
    if (!located.ok) {
      problems.push(`${locator}: ${located.error.message}`)
      continue
    }
    members[locator] = located.data
  }
  if (problems.length > 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.MEMBER_NOT_INSTALLED,
        `Cannot lock ${JSON.stringify(name)} — ${problems.length} of ${plural(manifest.skills.length, 'skill')} could not be found:\n  - ${problems.join('\n  - ')}`,
        { hint: `Install the skills first: "skill-set install ${name}".`, data: { name, problems } },
      ),
    }
  }
  const lock = createSetLock(name, manifest.version, members)
  if (opts?.dryRun !== true) {
    const paths = setPaths(cwd, name)
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.lock, serializeSetLock(lock))
  }
  return { ok: true, data: lock }
}
