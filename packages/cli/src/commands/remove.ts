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

  if (ctx.dryRun) {
    const counted = referenceCount(ctx, name, manifest.data.skills)
    if (!counted.ok) return counted
    const { removable, kept } = counted.data
    ctx.ui.out(`would remove: set ${JSON.stringify(name)} (from ${source}) — definition, lock, and generated files`)
    if (removable.length > 0) {
      ctx.ui.out(`would offer to also remove its skills (${removable.join(', ')})`)
      ctx.ui.out(ctx.ui.style('dim', `  would run on yes: ${formatInvocation(buildRemoveInvocation(removable), ctx.passthrough)}`))
    }
    for (const k of kept) ctx.ui.out(ctx.ui.style('dim', `  would keep ${k.skill ?? k.member}: ${k.reason}`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed, no skills removed`)
    return { ok: true, data: { name, dryRun: true, wouldRemoveSkills: removable, skillsKept: kept } }
  }

  // Prompt 1: a required gate. Declining leaves everything untouched.
  const confirmed = await ctx.ui.confirm(`Are you sure you want to remove the skill-set ${JSON.stringify(name)}?`)
  if (!confirmed.ok) return confirmed
  if (!confirmed.data) {
    ctx.ui.out('Aborted — nothing removed.')
    return { ok: true, data: { name, removed: false } }
  }

  // Act at once on the confirmed step: drop this set's own files and refresh the index.
  const paths = setPaths(ctx.cwd, name)
  rmSync(paths.manifest, { force: true })
  rmSync(paths.lock, { force: true })
  rmSync(paths.page, { force: true })
  if (existsSync(paths.dir) && readdirSync(paths.dir).length === 0) rmSync(paths.dir, { recursive: true, force: true })
  const index = writeIndex(ctx.cwd)
  if (!index.ok) return index
  ctx.ui.out(`${ctx.ui.style('green', '✓')} Skill-set ${JSON.stringify(name)} (from ${source}) was successfully removed`)

  // With this set gone, count its member skills against the sets that remain.
  const counted = referenceCount(ctx, name, manifest.data.skills)
  if (!counted.ok) return counted
  const { removable, kept: skillsKept } = counted.data
  for (const kept of skillsKept) ctx.ui.out(ctx.ui.style('dim', `  kept ${kept.skill ?? kept.member}: ${kept.reason}`))
  if (removable.length === 0) return { ok: true, data: { name, removed: true, skillsRemoved: [], skillsKept } }

  // Prompt 2: a convenience offer, not a gate — silently declined when no prompt is possible.
  const alsoRemove = await ctx.ui.confirm(`Also remove its skills (${removable.join(', ')})?`, { optional: true })
  if (!alsoRemove.ok) return alsoRemove
  if (!alsoRemove.data) return { ok: true, data: { name, removed: true, skillsRemoved: [], skillsKept } }

  // Delegated to the upstream CLI so skills-lock.json stays consistent with the folders.
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
  if (!run.ok) return run
  if (run.data.exitCode !== 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.RESOLVE_FAILED,
        `Removing skills failed: the skills CLI exited with code ${run.data.exitCode}. The set ${JSON.stringify(name)} was already removed. Skill files were left in place.`,
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

  ctx.ui.out(ctx.ui.style('dim', `  removed skills: ${removable.join(', ')}`))
  return { ok: true, data: { name, removed: true, skillsRemoved: removable, skillsKept } }
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
