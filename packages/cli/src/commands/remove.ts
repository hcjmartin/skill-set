import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { parseSkillsLock } from '../lock.ts'
import { MANIFEST_SUFFIX } from '../manifest.ts'
import { listSetNames, loadManifest, readSetSource, SETS_DIR, setPaths, writeIndex } from '../project.ts'
import {
  buildRemoveInvocation,
  locateMember,
  parseLocator,
  restoreSetsDir,
  SETS_DIR_RESTORED_NOTICE,
  snapshotSetsDir,
} from '../resolver.ts'
import { runCommand } from '../spawn.ts'
import { formatInvocation, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const REMOVE_USAGE = 'skill-set remove <set>'

interface KeptSkill {
  skill?: string
  member?: string
  reason: string
}

export async function cmdRemove(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], REMOVE_USAGE)
  if (!split.ok) return split
  const [name, ...extra] = split.data.positionals
  if (name === undefined || extra.length > 0) return usageError('remove takes exactly one set name', REMOVE_USAGE)

  const manifest = loadManifest(ctx.cwd, name)
  if (!manifest.ok) return manifest

  // The set's recorded origin, read before removal; sets authored locally fall back to their manifest path.
  const source = readSetSource(ctx.cwd, name) ?? `${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX}`

  ctx.ui.out(`Removing skill-set ${JSON.stringify(name)}...`)

  // Plan the whole operation before prompting or mutating. Besides making the preview truthful,
  // this ensures a broken sibling manifest or lock cannot strand a half-removed set.
  const counted = referenceCount(ctx, name, manifest.data.skills)
  if (!counted.ok) return counted
  const { removable, kept: skillsKept } = counted.data
  printRemovalPlan(ctx, name, source, removable, skillsKept)

  if (ctx.dryRun) {
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed, no skills removed`)
    return { ok: true, data: { name, dryRun: true, wouldRemoveSkills: removable, skillsKept } }
  }

  // Prompt 1: a required gate. Declining leaves everything untouched.
  const confirmed = await ctx.ui.confirm(`Are you sure you want to remove the skill-set ${JSON.stringify(name)}?`)
  if (!confirmed.ok) return confirmed
  if (!confirmed.data) {
    ctx.ui.out('Aborted — nothing removed.')
    return { ok: true, data: { name, removed: false } }
  }

  // Prompt 2 is collected before either operation begins. It remains an optional convenience
  // offer, so non-interactive callers preserve the old set-only behavior unless they pass --yes.
  let removeSkills = false
  if (removable.length > 0) {
    const alsoRemove = await ctx.ui.confirm(`Also remove its skills (${removable.join(', ')})?`, { optional: true })
    if (!alsoRemove.ok) return alsoRemove
    removeSkills = alsoRemove.data
  }

  if (removeSkills) {
    // Cleanup runs first so a failed or partially completed upstream removal cannot also erase the
    // set definition needed to understand and retry the operation.
    const invocation = buildRemoveInvocation(removable)
    ctx.ui.out(ctx.ui.style('dim', `running: ${formatInvocation(invocation, ctx.passthrough)}`))
    const invocationArgs = ctx.passthrough.length === 0 ? invocation.args : [...invocation.args, ...ctx.passthrough]
    // Set definitions live inside the skills dir; every upstream spawn is bracketed so they survive.
    const guard = snapshotSetsDir(ctx.cwd)
    const run = await (ctx.runner ?? runCommand)(invocation.command, invocationArgs, {
      cwd: ctx.cwd,
      env: invocation.env,
      capture: ctx.ui.json,
    })
    if (restoreSetsDir(ctx.cwd, guard)) ctx.ui.out(ctx.ui.style('yellow', SETS_DIR_RESTORED_NOTICE))
    if (!run.ok) {
      return {
        ok: false,
        error: new SkillSetError(
          run.error.code,
          `Removing skills failed before the set was removed: ${run.error.message}. The set ${JSON.stringify(name)} remains installed, but skill cleanup may have partially completed.`,
          {
            hint: 'Inspect the installed skills, then retry removal. The set definition is still available as the source of truth.',
            data: { name, attemptedSkills: removable, setRemoved: false, possiblePartialCleanup: true },
            cause: run.error,
          },
        ),
      }
    }
    if (run.data.exitCode !== 0) {
      return {
        ok: false,
        error: new SkillSetError(
          ErrorCodes.RESOLVE_FAILED,
          `Removing skills failed: the skills CLI exited with code ${run.data.exitCode}. The set ${JSON.stringify(name)} remains installed, but skill cleanup may have partially completed.`,
          {
            hint: ctx.ui.json
              ? 'Inspect data.stderr and the installed skills, then retry removal; the set definition remains available.'
              : 'Inspect the skills output and installed skills, then retry removal; the set definition remains available.',
            data: {
              name,
              attemptedSkills: removable,
              exitCode: run.data.exitCode,
              setRemoved: false,
              possiblePartialCleanup: true,
              ...(ctx.ui.json ? { stderr: run.data.stderr.slice(-2000) } : {}),
            },
          },
        ),
      }
    }

    ctx.ui.out(ctx.ui.style('dim', `  removed skills: ${removable.join(', ')}`))
  }

  // Only after all selected cleanup succeeds may the set artifacts and index be mutated.
  const paths = setPaths(ctx.cwd, name)
  rmSync(paths.manifest, { force: true })
  rmSync(paths.lock, { force: true })
  rmSync(paths.page, { force: true })
  if (existsSync(paths.dir) && readdirSync(paths.dir).length === 0) rmSync(paths.dir, { recursive: true, force: true })
  const index = writeIndex(ctx.cwd)
  if (!index.ok) return index
  ctx.ui.out(`${ctx.ui.style('green', '✓')} Skill-set ${JSON.stringify(name)} (from ${source}) was successfully removed`)

  return { ok: true, data: { name, removed: true, skillsRemoved: removeSkills ? removable : [], skillsKept } }
}

/** Prints the same complete, reference-counted plan for both real and dry-run removal. */
function printRemovalPlan(
  ctx: CommandContext,
  name: string,
  source: string,
  removable: readonly string[],
  kept: readonly KeptSkill[],
): void {
  ctx.ui.out(`Removal plan for ${JSON.stringify(name)} (from ${source}):`)
  ctx.ui.out('  remove set: definition, lock, and generated files')
  if (removable.length > 0) {
    ctx.ui.out(`  optionally remove unshared skills: ${removable.join(', ')}`)
    ctx.ui.out(
      ctx.ui.style('dim', `    cleanup command on approval: ${formatInvocation(buildRemoveInvocation(removable), ctx.passthrough)}`),
    )
  } else {
    ctx.ui.out(ctx.ui.style('dim', '  no unshared skills are eligible for removal'))
  }
  for (const skill of kept) ctx.ui.out(ctx.ui.style('dim', `  kept ${skill.skill ?? skill.member}: ${skill.reason}`))
}

/**
 * Splits this set's member skills into removable and kept. A skill is kept when any other
 * set claims it — by a locatable member, an explicit @skill name, or a byte-equal source
 * (the fallback that protects a sibling whose member is momentarily unlocatable).
 */
function referenceCount(
  ctx: CommandContext,
  name: string,
  members: readonly string[],
): Result<{ removable: string[]; kept: KeptSkill[] }> {
  const kept: KeptSkill[] = []
  const mine = new Map<string, string>()
  for (const locator of members) {
    const located = locateMember(locator, { cwd: ctx.cwd })
    if (located.ok) mine.set(located.data.skill, locator)
    else kept.push({ member: locator, reason: `not locatable (${located.error.code}) — left untouched` })
  }

  // Each of my skills' recorded upstream source, for the source-level sharing fallback.
  const sourceOf = new Map<string, string>()
  const lockPath = join(ctx.cwd, 'skills-lock.json')
  if (existsSync(lockPath)) {
    const upstream = parseSkillsLock(readFileSync(lockPath, 'utf8'), { filename: 'skills-lock.json' })
    if (!upstream.ok) return upstream
    for (const skill of mine.keys()) {
      const entry = upstream.data.skills[skill]
      if (entry !== undefined) sourceOf.set(skill, entry.source)
    }
  }

  const shared = new Map<string, string>()
  for (const other of listSetNames(ctx.cwd)) {
    if (other === name) continue
    const otherManifest = loadManifest(ctx.cwd, other)
    if (!otherManifest.ok) return otherManifest
    for (const locator of otherManifest.data.skills) {
      const parsed = parseLocator(locator)
      if (parsed.skill !== undefined && mine.has(parsed.skill)) shared.set(parsed.skill, 'shared with another set')
      const located = locateMember(locator, { cwd: ctx.cwd })
      if (located.ok && mine.has(located.data.skill)) shared.set(located.data.skill, 'shared with another set')
      for (const [skill, source] of sourceOf) {
        if (source === parsed.source) shared.set(skill, 'shared with another set (same source)')
      }
    }
  }

  for (const [skill, reason] of shared) kept.push({ skill, reason })
  return { ok: true, data: { removable: [...mine.keys()].filter((s) => !shared.has(s)), kept } }
}
