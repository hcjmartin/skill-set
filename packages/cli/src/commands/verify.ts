import { existsSync } from 'node:fs'
import { join } from 'node:path'
import ci from 'ci-info'
import { ErrorCodes, SkillSetError } from '../errors.ts'
import { specFolderHash } from '../hash.ts'
import type { SetLock } from '../lock.ts'
import type { Manifest } from '../manifest.ts'
import { loadLockIfPresent, loadManifest } from '../project.ts'
import { buildCheckInvocation, locateMember, SKILLS_DIR } from '../resolver.ts'
import { runCommand } from '../spawn.ts'
import { formatInvocation, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const VERIFY_USAGE = 'skill-set verify <set> [--frozen|--no-frozen]'

export async function cmdVerify(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, ['--frozen', '--no-frozen'], VERIFY_USAGE)
  if (!split.ok) return split
  const { flags, positionals } = split.data
  const [name, ...extra] = positionals
  if (name === undefined || extra.length > 0) return usageError('verify takes exactly one set name', VERIFY_USAGE)

  const manifest = loadManifest(ctx.cwd, name)
  if (!manifest.ok) return manifest
  const lock = loadLockIfPresent(ctx.cwd, name)
  if (!lock.ok) return lock

  // In CI, frozen is the default whenever a lock exists (explicit flags always win).
  const inCi = ctx.ci ?? ci.isCI
  const frozen = flags.has('--frozen') ? true : flags.has('--no-frozen') ? false : inCi && lock.data !== undefined

  return frozen ? verifyFrozen(ctx, name, manifest.data, lock.data) : verifyDefault(ctx, name, manifest.data, lock.data)
}

/** Byte-exact verification: recompute every member's content hash against the set-lock. */
function verifyFrozen(
  ctx: CommandContext,
  name: string,
  manifest: Manifest,
  lock: SetLock | undefined,
): CommandResult {
  if (lock === undefined) {
    return {
      ok: false,
      error: new SkillSetError(ErrorCodes.FROZEN_NO_LOCK, `Frozen verify needs a set-lock, and ${JSON.stringify(name)} has none`, {
        hint: `Create one with "skill-set lock ${name}" and commit it.`,
        data: { name },
      }),
    }
  }

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
    ctx.ui.out(`${ctx.ui.style('green', '✓')} ${name}: ${checked} members verified frozen — content matches the set-lock`)
    return { ok: true, data: { name, mode: 'frozen', checked } }
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
      `Set ${JSON.stringify(name)} does not match its lock — ${problems} problem(s):\n  - ${lines.join('\n  - ')}`,
      {
        hint: `Reinstall to match the lock ("skill-set install ${name}"), or accept the current state ("skill-set lock ${name}").`,
        data: { name, mode: 'frozen', checked, drifted, missing, added, removed },
      },
    ),
  }
}

/** Presence verification plus the delegated upstream staleness check; no hashes recomputed. */
async function verifyDefault(
  ctx: CommandContext,
  name: string,
  manifest: Manifest,
  lock: SetLock | undefined,
): Promise<CommandResult> {
  const present: string[] = []
  const missing: Array<{ locator: string; message: string }> = []
  for (const locator of manifest.skills) {
    const entry = lock?.skills[locator]
    if (entry !== undefined) {
      if (existsSync(join(ctx.cwd, SKILLS_DIR, entry.skill))) present.push(locator)
      else missing.push({ locator, message: `skill folder missing (${SKILLS_DIR}/${entry.skill})` })
      continue
    }
    const located = locateMember(locator, { cwd: ctx.cwd })
    if (located.ok) present.push(locator)
    else missing.push({ locator, message: located.error.message })
  }

  // Staleness is delegated to the upstream check; its findings inform, they do not fail verify.
  const invocation = buildCheckInvocation()
  let checkExit: number | undefined
  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would run: ${formatInvocation(invocation, ctx.passthrough)}`))
  } else {
    ctx.ui.out(ctx.ui.style('dim', `running: ${formatInvocation(invocation, ctx.passthrough)}`))
    const args = ctx.passthrough.length === 0 ? invocation.args : [...invocation.args, ...ctx.passthrough]
    const check = await (ctx.runner ?? runCommand)(invocation.command, args, {
      cwd: ctx.cwd,
      env: invocation.env,
      capture: ctx.ui.json,
    })
    checkExit = check.ok ? check.data.exitCode : undefined
    if (checkExit !== 0) {
      ctx.ui.warn(
        check.ok
          ? `upstream "skills check" exited with code ${String(checkExit)} — see its output above`
          : `upstream "skills check" could not run: ${check.ok === false ? check.error.message : ''}`,
      )
    }
  }

  ctx.ui.out(
    `Checks run: member presence (${present.length}/${manifest.skills.length} present) + upstream staleness check. ` +
      `Content hashes were not recomputed — use --frozen for byte-exact verification.`,
  )

  if (missing.length > 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.MEMBER_NOT_INSTALLED,
        `${missing.length} of ${manifest.skills.length} members of ${JSON.stringify(name)} are not installed:\n  - ${missing.map((m) => `${m.locator}: ${m.message}`).join('\n  - ')}`,
        { hint: `Install them with "skill-set install ${name}".`, data: { name, mode: 'default', present, missing } },
      ),
    }
  }
  ctx.ui.out(`${ctx.ui.style('green', '✓')} ${name}: all ${present.length} members present`)
  return { ok: true, data: { name, mode: 'default', present, missing: [], upstreamCheckExit: checkExit } }
}
