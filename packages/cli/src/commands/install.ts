import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError } from '../errors.ts'
import { specFolderHash } from '../hash.ts'
import type { Manifest } from '../manifest.ts'
import { loadAllManifests, loadLockIfPresent, loadManifest } from '../project.ts'
import {
  buildAddInvocation,
  parseLocator,
  reservedMembers,
  reservedNameError,
  resolveMember,
  SETS_DIR_RESTORED_NOTICE,
  SKILLS_DIR,
} from '../resolver.ts'
import { formatInvocation, plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const INSTALL_USAGE = 'skill-set install <set>'

export async function cmdInstall(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], INSTALL_USAGE)
  if (!split.ok) return split
  const [name, ...extra] = split.data.positionals
  if (name === undefined || extra.length > 0) return usageError('install takes exactly one set name', INSTALL_USAGE)
  return installSet(ctx, name)
}

/** The install flow, shared with `add`: conflict check → satisfied-member skip → resolve. */
export async function installSet(ctx: CommandContext, name: string): Promise<CommandResult> {
  const manifest = loadManifest(ctx.cwd, name)
  if (!manifest.ok) return manifest

  // Members explicitly naming the reserved skill are refused before any spawn.
  const reserved = reservedMembers(manifest.data.skills)
  if (reserved.length > 0) return { ok: false, error: reservedNameError(reserved) }

  ctx.ui.out(`Installing local skill-set ${JSON.stringify(name)}...`)

  // Cross-set pin conflicts abort before anything installs (spec §4).
  const all = loadAllManifests(ctx.cwd)
  if (!all.ok) return all
  const conflicts = findPinConflicts(manifest.data, all.data)
  if (conflicts.length > 0) {
    const lines = conflicts.map((c) => {
      const sets = new Set(c.pins.map((p) => p.set))
      return sets.size === 1
        ? `${c.source}: set ${JSON.stringify([...sets][0]!)} pins it to both ${c.pins.map((p) => p.ref).join(' and ')}`
        : `${c.source}: ${c.pins.map((p) => `${JSON.stringify(p.set)} pins ${p.ref}`).join(', ')}`
    })
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.CONFLICT,
        `Cannot install ${JSON.stringify(name)} — ${plural(conflicts.length, 'skill source')} pinned differently across sets:\n  - ${lines.join('\n  - ')}`,
        {
          hint: 'Align the pins across the named sets before installing; skill-set never overwrites one set\'s pin with another\'s.',
          data: { name, conflicts },
        },
      ),
    }
  }

  const lock = loadLockIfPresent(ctx.cwd, name)
  if (!lock.ok) return lock

  // Plan: a member is satisfied when its locked content is already on disk, byte-exact.
  const plan = manifest.data.skills.map((locator) => {
    const entry = lock.data?.skills[locator]
    if (entry !== undefined) {
      const folder = join(ctx.cwd, SKILLS_DIR, entry.skill)
      if (existsSync(folder) && specFolderHash(folder) === entry.computedHash) {
        return { locator, satisfied: true as const, skill: entry.skill }
      }
    }
    return { locator, satisfied: false as const }
  })
  const pending = plan.filter((p) => !p.satisfied)
  const skipped = plan.filter((p) => p.satisfied).map((p) => p.locator)

  ctx.ui.out(`${plural(manifest.data.skills.length, 'skill')} in set ${JSON.stringify(name)}:`)
  for (const p of plan) {
    const parsed = parseLocator(p.locator)
    const origin = `source ${parsed.source}${parsed.ref === undefined ? '' : `, pinned ${parsed.ref}`}`
    const status = p.satisfied ? 'installed content verified against the lock — skipping' : 'will install'
    ctx.ui.out(`  ${p.locator} ${ctx.ui.style('dim', `(${origin}) ${status}`)}`)
  }

  if (ctx.dryRun) {
    for (const p of pending) {
      ctx.ui.out(ctx.ui.style('dim', `would run: ${formatInvocation(buildAddInvocation(p.locator), ctx.passthrough)}`))
    }
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed, no skills installed`)
    return { ok: true, data: { name, dryRun: true, wouldInstall: pending.map((p) => p.locator), skipped } }
  }

  const installed: Array<{ locator: string; skill: string; computedHash: string }> = []
  const failed: Array<{ locator: string; code: string; message: string }> = []
  // Sequential on purpose: discovery diffs skills-lock.json around each spawn.
  for (const p of pending) {
    ctx.ui.out(ctx.ui.style('dim', `running: ${formatInvocation(buildAddInvocation(p.locator), ctx.passthrough)}`))
    const resolved = await resolveMember(p.locator, {
      cwd: ctx.cwd,
      runner: ctx.runner,
      extraArgs: ctx.passthrough,
      capture: ctx.ui.json,
      onSetsDirRestored: () => ctx.ui.out(ctx.ui.style('yellow', SETS_DIR_RESTORED_NOTICE)),
    })
    if (resolved.ok) {
      installed.push({ locator: p.locator, skill: resolved.data.skill, computedHash: resolved.data.computedHash })
    } else {
      failed.push({ locator: p.locator, code: resolved.error.code, message: resolved.error.message })
    }
  }

  const summary = { name, installed, skipped, failed }
  ctx.ui.out(
    `${failed.length === 0 ? ctx.ui.style('green', '✓') : ctx.ui.style('red', '✗')} ${installed.length} installed, ${skipped.length} skipped, ${failed.length} failed`,
  )

  if (failed.length > 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.INSTALL_FAILED,
        `${failed.length} of ${plural(manifest.data.skills.length, 'member skill')} failed to install:\n  - ${failed.map((f) => `${f.locator}: ${f.message}`).join('\n  - ')}`,
        { hint: 'Fix the failing skills and re-run.', data: summary },
      ),
    }
  }
  return { ok: true, data: summary }
}

interface PinConflict {
  source: string
  pins: Array<{ set: string; ref: string }>
}

/** A member source pinned to two different refs by any two set definitions is unresolvable (spec §4). */
function findPinConflicts(target: Manifest, all: Manifest[]): PinConflict[] {
  const targetSources = new Set(target.skills.map((l) => parseLocator(l).source))
  const pinsBySource = new Map<string, Map<string, string[]>>()
  for (const manifest of all) {
    for (const locator of manifest.skills) {
      const { source, ref } = parseLocator(locator)
      if (ref === undefined || !targetSources.has(source)) continue
      const refs = pinsBySource.get(source) ?? new Map<string, string[]>()
      refs.set(ref, [...(refs.get(ref) ?? []), manifest.name])
      pinsBySource.set(source, refs)
    }
  }
  const conflicts: PinConflict[] = []
  for (const [source, refs] of pinsBySource) {
    if (refs.size < 2) continue
    conflicts.push({
      source,
      pins: [...refs.entries()].flatMap(([ref, sets]) => sets.map((set) => ({ set, ref }))),
    })
  }
  return conflicts
}
