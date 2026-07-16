import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError } from '../errors.ts'
import { specFolderHash } from '../hash.ts'
import { LOCK_SUFFIX, type SetLock } from '../lock.ts'
import type { Manifest } from '../manifest.ts'
import { listSetNames, loadLockIfPresent, loadManifest } from '../project.ts'
import { locateMember, SKILLS_DIR } from '../resolver.ts'
import { plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const VERIFY_USAGE = 'skill-set verify [<set>] [--frozen]'

export async function cmdVerify(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, ['--frozen'], VERIFY_USAGE)
  if (!split.ok) return split
  const { flags, positionals } = split.data
  if (positionals.length > 1) return usageError('verify takes at most one set name', VERIFY_USAGE)
  const frozen = flags.has('--frozen')

  const single = positionals.length === 1
  const names = single ? [positionals[0]!] : listSetNames(ctx.cwd)
  if (names.length === 0) {
    ctx.ui.out('No sets found — nothing to verify.')
    ctx.ui.out(ctx.ui.style('dim', 'Create one with "skill-set init <name>".'))
    return { ok: true, data: { sets: [] } }
  }

  ctx.ui.out(
    single
      ? `Verifying installed skill-set ${JSON.stringify(names[0])} — validating contents against the set lock...`
      : `Verifying ${plural(names.length, 'installed skill-set')} — validating contents against the set locks...`,
  )

  const sets: unknown[] = []
  const failures: SkillSetError[] = []
  for (const name of names) {
    const manifest = loadManifest(ctx.cwd, name)
    if (!manifest.ok) return manifest
    const lock = loadLockIfPresent(ctx.cwd, name)
    if (!lock.ok) return lock
    const result =
      lock.data !== undefined
        ? verifyAgainstLock(ctx, name, manifest.data, lock.data)
        : frozen
          ? missingLock(name)
          : verifyPresence(ctx, name, manifest.data)
    if (result.ok) {
      sets.push(result.data)
    } else {
      failures.push(result.error)
      sets.push({ ...(result.error.data as Record<string, unknown>), error: result.error.code })
      ctx.ui.out(`${ctx.ui.style('red', '✗')} ${name}: ${failureLabel(result.error.code)}`)
    }
  }

  if (failures.length === 0) return { ok: true, data: single ? sets[0] : { sets } }
  if (single) return { ok: false, error: failures[0]! }

  // Aggregate severity: any drift means the project does not match its locks (exit 3);
  // otherwise a frozen run missing a lock is precondition-shaped (exit 2).
  const code =
    failures.find((f) => f.code === ErrorCodes.DRIFT)?.code ??
    failures.find((f) => f.code === ErrorCodes.FROZEN_NO_LOCK)?.code ??
    failures[0]!.code
  return {
    ok: false,
    error: new SkillSetError(
      code,
      `${failures.length} of ${plural(names.length, 'set')} failed verification:\n\n${failures.map((f) => f.message).join('\n\n')}`,
      {
        hint: 'Reinstall from manifests ("skill-set install <set>"), or accept the current state ("skill-set lock <set>").',
        data: { sets },
      },
    ),
  }
}

function failureLabel(code: string): string {
  if (code === ErrorCodes.DRIFT) return 'does not match its lock'
  if (code === ErrorCodes.FROZEN_NO_LOCK) return 'no set lock (--frozen requires one)'
  return 'skills missing'
}

function missingLock(name: string): CommandResult {
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.FROZEN_NO_LOCK, `Missing skill-set lock file for ${JSON.stringify(name)} — frozen verify needs ${name}${LOCK_SUFFIX}`, {
      hint: `Create one with "skill-set lock ${name}" and commit it.`,
      data: { name, expected: `${name}${LOCK_SUFFIX}` },
    }),
  }
}

/** Byte-exact verification: recompute every member's content hash against the set-lock. */
function verifyAgainstLock(
  ctx: CommandContext,
  name: string,
  manifest: Manifest,
  lock: SetLock,
): CommandResult {
  const manifestMembers = new Set(manifest.skills)
  const added = manifest.skills.filter((locator) => !(locator in lock.skills))
  const removed = Object.keys(lock.skills).filter((locator) => !manifestMembers.has(locator))
  const missing: Array<{ locator: string; skill: string }> = []
  const drifted: Array<{ locator: string; skill: string; expected: string; actual: string }> = []
  let checked = 0

  for (const [locator, entry] of Object.entries(lock.skills)) {
    if (!manifestMembers.has(locator)) continue
    checked++
    const folder = join(ctx.cwd, SKILLS_DIR, entry.skill)
    if (!existsSync(folder)) {
      missing.push({ locator, skill: entry.skill })
      continue
    }
    const actual = specFolderHash(folder)
    if (actual !== entry.computedHash) {
      drifted.push({ locator, skill: entry.skill, expected: entry.computedHash, actual })
    }
  }

  const problems = drifted.length + missing.length + added.length + removed.length
  if (problems === 0) {
    ctx.ui.out(`${ctx.ui.style('green', '✓')} ${name}: all set skills match the set lock (${checked}/${checked})`)
    return { ok: true, data: { name, mode: 'lock', checked } }
  }

  // Every problem in one report — a partial drift list hides the real repair size.
  const lines = [
    ...drifted.map((d) => `${d.locator} (skill ${d.skill}): content drifted — expected ${d.expected}, got ${d.actual}`),
    ...missing.map((m) => `${m.locator}: skill folder missing (${SKILLS_DIR}/${m.skill})`),
    ...added.map((locator) => `${locator}: in the manifest but not in the set-lock`),
    ...removed.map((locator) => `${locator}: in the set-lock but no longer in the manifest`),
  ]
  return {
    ok: false,
    error: new SkillSetError(
      ErrorCodes.DRIFT,
      `Set ${JSON.stringify(name)} does not match its lock — ${plural(problems, 'problem')}:\n  - ${lines.join('\n  - ')}`,
      {
        hint: `Reinstall from manifest ("skill-set install ${name}"), or accept the current state ("skill-set lock ${name}").`,
        data: { name, mode: 'lock', checked, drifted, missing, added, removed },
      },
    ),
  }
}

/** No lock to verify against: presence check only, with an explicit content-not-verified note. */
function verifyPresence(ctx: CommandContext, name: string, manifest: Manifest): CommandResult {
  const present: string[] = []
  const missing: Array<{ locator: string; message: string }> = []
  for (const locator of manifest.skills) {
    const located = locateMember(locator, { cwd: ctx.cwd })
    if (located.ok) present.push(locator)
    else missing.push({ locator, message: located.error.message })
  }

  if (missing.length > 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.MEMBER_NOT_INSTALLED,
        `${missing.length} of ${manifest.skills.length} skills of ${JSON.stringify(name)} are not installed:\n  - ${missing.map((m) => `${m.locator}: ${m.message}`).join('\n  - ')}`,
        { hint: `Install with "skill-set install ${name}".`, data: { name, mode: 'presence', present, missing } },
      ),
    }
  }
  ctx.ui.out(`${ctx.ui.style('green', '✓')} ${name}: all set skills present (${present.length}/${manifest.skills.length})`)
  ctx.ui.warn(`${JSON.stringify(name)} has no set lock — content was not verified. Create one with "skill-set lock ${name}".`)
  return { ok: true, data: { name, mode: 'presence', present, missing: [] } }
}
