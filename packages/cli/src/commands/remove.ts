import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { parseSkillsLock } from '../lock.ts'
import { listSetNames, loadManifest, setPaths, writeIndex } from '../project.ts'
import { buildRemoveInvocation, locateMember, parseLocator } from '../resolver.ts'
import { runCommand } from '../spawn.ts'
import { formatInvocation, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const REMOVE_USAGE = 'skill-set remove <set> [--skills]'

interface KeptSkill {
  skill?: string
  member?: string
  reason: string
}

export async function cmdRemove(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, ['--skills'], REMOVE_USAGE)
  if (!split.ok) return split
  const { flags, positionals } = split.data
  const [name, ...extra] = positionals
  if (name === undefined || extra.length > 0) return usageError('remove takes exactly one set name', REMOVE_USAGE)
  const removeSkills = flags.has('--skills')

  const manifest = loadManifest(ctx.cwd, name)
  if (!manifest.ok) return manifest

  if (!ctx.dryRun) {
    const confirmed = await ctx.ui.confirm(
      removeSkills
        ? `Remove set ${JSON.stringify(name)} and its member skill folders not shared with other sets?`
        : `Remove set ${JSON.stringify(name)} (definition, lock, and generated files)?`,
    )
    if (!confirmed.ok) return confirmed
    if (!confirmed.data) {
      ctx.ui.out('Aborted — nothing removed.')
      return { ok: true, data: { name, removed: false } }
    }
  }

  let removable: string[] = []
  const skillsKept: KeptSkill[] = []
  if (removeSkills) {
    const counted = referenceCount(ctx, name, manifest.data.skills)
    if (!counted.ok) return counted
    removable = counted.data.removable
    skillsKept.push(...counted.data.kept)
  }

  if (ctx.dryRun) {
    ctx.ui.out(`would remove: set ${JSON.stringify(name)} (definition, lock, and generated files)`)
    if (removable.length > 0) {
      ctx.ui.out(ctx.ui.style('dim', `would run: ${formatInvocation(buildRemoveInvocation(removable), ctx.passthrough)}`))
    }
    for (const kept of skillsKept) ctx.ui.out(ctx.ui.style('dim', `  would keep ${kept.skill ?? kept.member}: ${kept.reason}`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — nothing removed`)
    return { ok: true, data: { name, dryRun: true, wouldRemoveSkills: removable, skillsKept } }
  }

  if (removable.length > 0) {
    // Delegated to the upstream CLI so skills-lock.json stays consistent with the folders.
    const invocation = buildRemoveInvocation(removable)
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
          `Removing skills failed: the skills CLI exited with code ${run.data.exitCode}. The set definition was not removed.`,
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
  }

  rmSync(setPaths(ctx.cwd, name).dir, { recursive: true, force: true })
  const index = writeIndex(ctx.cwd)
  if (!index.ok) return index

  ctx.ui.out(`${ctx.ui.style('green', '✓')} Removed set ${JSON.stringify(name)}`)
  for (const kept of skillsKept) ctx.ui.out(ctx.ui.style('dim', `  kept ${kept.skill ?? kept.member}: ${kept.reason}`))
  if (removable.length > 0) ctx.ui.out(ctx.ui.style('dim', `  removed skills: ${removable.join(', ')}`))
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
