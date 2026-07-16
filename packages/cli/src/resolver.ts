import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildConfig } from './config.ts'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { specFolderHash } from './hash.ts'
import { parseSkillsLock } from './lock.ts'
import { NAME_PATTERN } from './manifest.ts'
import { runCommand, type SpawnOptions, type SpawnOutcome } from './spawn.ts'

/** Upstream pin, exact: every bump is deliberate (the weekly compat job watches upstream drift). */
export const SKILLS_PIN = '1.5.14'

/** Where resolved skills land, relative to the project root (spec §4; upstream UNIVERSAL_SKILLS_DIR). */
export const SKILLS_DIR = '.agents/skills'

/**
 * Reserved skill name (spec §4): set definitions live at `<SKILLS_DIR>/skill-sets`, inside the
 * skills dir, so a member skill installing under that name would overwrite them. Named locators
 * are refused before any spawn; resolver-determined names are refused after, with the directory
 * restored from its pre-spawn snapshot.
 */
export const RESERVED_SKILL_NAME = 'skill-sets'

const SETS_PATH = `${SKILLS_DIR}/${RESERVED_SKILL_NAME}`

const SKILLS_LOCK_FILE = 'skills-lock.json'

export interface ParsedLocator {
  source: string
  skill?: string
  ref?: string
}

/**
 * Locator grammar (spec §1 examples): `<source>[@<skill>][#<ref>]`. The trailing #ref splits
 * first; the last @ names the skill only when what follows is a valid skill name, so
 * `git@github.com:owner/repo` and other user-info @s stay part of the source.
 */
export function parseLocator(locator: string): ParsedLocator {
  let rest = locator
  let ref: string | undefined
  if (rest.endsWith('#')) rest = rest.slice(0, -1)
  const hashAt = rest.lastIndexOf('#')
  if (hashAt > 0 && hashAt < rest.length - 1) {
    ref = rest.slice(hashAt + 1)
    rest = rest.slice(0, hashAt)
  }
  let skill: string | undefined
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    const candidate = rest.slice(at + 1)
    const before = rest.slice(0, at)
    // A skill split needs a path-like source before the @ — keeps bare `git@host` whole.
    if (NAME_PATTERN.test(candidate) && /[/:]/.test(before)) {
      skill = candidate
      rest = before
    }
  }
  return { source: rest, skill, ref }
}

export interface SkillsInvocation {
  command: string
  args: string[]
  env: Record<string, string>
}

/** Builds the pinned upstream invocation for one member: explicit args + prompt suppression, always. */
export function buildAddInvocation(locator: string, opts?: { global?: boolean }): SkillsInvocation {
  const { source, skill, ref } = parseLocator(locator)
  const sourceArg = ref === undefined ? source : `${source}#${ref}`
  const args = ['-y', `skills@${SKILLS_PIN}`, 'add', sourceArg]
  if (skill !== undefined) args.push('--skill', skill)
  args.push('--yes')
  if (opts?.global === true) args.push('--global')
  // Suppresses upstream telemetry events via its own opt-out; its audit fetch
  // (add-skill.vercel.sh) is separate and not opt-out-able.
  const env: Record<string, string> = {}
  if (buildConfig.suppressUpstreamTelemetry) env.DISABLE_TELEMETRY = '1'
  return { command: 'npx', args, env }
}

/** Builds the pinned upstream no-write discovery invocation for an unnamed member. */
export function buildListInvocation(locator: string): SkillsInvocation {
  const { source, ref } = parseLocator(locator)
  const sourceArg = ref === undefined ? source : `${source}#${ref}`
  return withTelemetryOptOut(['-y', `skills@${SKILLS_PIN}`, 'add', sourceArg, '--list'])
}

/** Builds the pinned upstream check invocation: reports member staleness, changes nothing. */
export function buildCheckInvocation(): SkillsInvocation {
  return withTelemetryOptOut(['-y', `skills@${SKILLS_PIN}`, 'check'])
}

/** Builds the pinned upstream update invocation for installed skills (project scope, prompt-suppressed). */
export function buildUpdateInvocation(skills: readonly string[]): SkillsInvocation {
  return withTelemetryOptOut(['-y', `skills@${SKILLS_PIN}`, 'update', ...skills, '-p', '--yes'])
}

/** Builds the pinned upstream remove invocation (project scope, prompt-suppressed). */
export function buildRemoveInvocation(skills: readonly string[]): SkillsInvocation {
  return withTelemetryOptOut(['-y', `skills@${SKILLS_PIN}`, 'remove', ...skills, '--yes'])
}

function withTelemetryOptOut(args: string[]): SkillsInvocation {
  const env: Record<string, string> = {}
  if (buildConfig.suppressUpstreamTelemetry) env.DISABLE_TELEMETRY = '1'
  return { command: 'npx', args, env }
}

/** Members whose locator explicitly names the reserved skill; installers refuse these before any fetch or spawn. */
export function reservedMembers(skills: readonly string[]): string[] {
  return skills.filter((locator) => parseLocator(locator).skill === RESERVED_SKILL_NAME)
}

export function reservedNameError(locators: readonly string[], resolved = false): SkillSetError {
  const verb = resolved ? 'resolved to' : locators.length === 1 ? 'names' : 'name'
  const subject = locators.length === 1 ? `Member ${JSON.stringify(locators[0])}` : `${locators.length} members`
  const list = locators.length === 1 ? '' : `:\n  - ${locators.join('\n  - ')}`
  return new SkillSetError(
    ErrorCodes.RESERVED_NAME,
    `${subject} ${verb} the skill ${JSON.stringify(RESERVED_SKILL_NAME)}, which is reserved for the set-definitions directory (${SETS_PATH})${resolved ? '. The install was refused and the set definitions were restored' : ''}${list}`,
    {
      hint: 'That directory is CLI-managed and never an installable skill. Point the member at a skill with a different name.',
      data: { reserved: RESERVED_SKILL_NAME, locators: [...locators] },
    },
  )
}

/** Byte snapshot of the set-definitions directory, keyed by relative path (transient `.staging` excluded). */
export type SetsDirSnapshot = Map<string, Buffer>

export function snapshotSetsDir(cwd: string): SetsDirSnapshot {
  const snapshot: SetsDirSnapshot = new Map()
  collectSetFiles(join(cwd, SETS_PATH), '', snapshot)
  return snapshot
}

function collectSetFiles(dir: string, rel: string, out: SetsDirSnapshot): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (rel === '' && entry.name === '.staging') continue
    if (entry.isSymbolicLink()) continue
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) collectSetFiles(join(dir, entry.name), relPath, out)
    else if (entry.isFile()) out.set(relPath, readFileSync(join(dir, entry.name)))
  }
}

/** The user-facing explanation printed whenever a restore fires. */
export const SETS_DIR_RESTORED_NOTICE = `Notice: the skills CLI modified the set-definitions directory (${SETS_PATH}); its contents were restored.`

/**
 * Restores the set-definitions directory to a pre-spawn snapshot, byte-exact. Legitimate member
 * installs never touch it, so a restore fires only when a spawn destroyed or altered set data
 * (e.g. a skill claiming the reserved name). Returns true when anything was put back.
 */
export function restoreSetsDir(cwd: string, snapshot: SetsDirSnapshot): boolean {
  const current = snapshotSetsDir(cwd)
  if (current.size === snapshot.size && [...snapshot].every(([rel, bytes]) => current.get(rel)?.equals(bytes) === true)) {
    return false
  }
  const root = join(cwd, SETS_PATH)
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (entry === '.staging') continue
      rmSync(join(root, entry), { recursive: true, force: true })
    }
    if (snapshot.size === 0 && readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
  }
  for (const [rel, bytes] of snapshot) {
    const path = join(root, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
  }
  return true
}

/** Drops the entry the upstream lock recorded for a refused reserved-name install. */
function dropSkillsLockEntry(cwd: string, skill: string): void {
  const path = join(cwd, SKILLS_LOCK_FILE)
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { skills?: Record<string, unknown> }
    if (typeof raw.skills !== 'object' || raw.skills === null || !(skill in raw.skills)) return
    delete raw.skills[skill]
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
  } catch {
    // An unreadable upstream lock is left as found; the folder itself was already restored.
  }
}

export interface ResolvedMember {
  skill: string
  /** The spec §6 content hash — what a set-lock records. */
  computedHash: string
  sourceType?: string
  ref?: string
}

/**
 * Finds a member's already-installed skill without spawning anything: a named locator maps
 * directly; an unnamed one must match its source byte-for-byte (and ref when pinned) against
 * exactly one skills-lock.json entry. Used by commands that must never install.
 */
export function locateMember(locator: string, opts: { cwd: string }): Result<ResolvedMember> {
  if (locator.trim() === '') {
    return fail(ErrorCodes.RESOLVE_FAILED, "A member skill locator must be a non-empty string")
  }
  const lock = readLockSkills(opts.cwd)
  if (!lock.ok) return lock

  const parsed = parseLocator(locator)
  let skillName: string
  if (parsed.skill !== undefined) {
    skillName = parsed.skill
  } else {
    const candidates = Object.keys(lock.data).filter((k) => {
      const e = lock.data[k]!
      return e.source === parsed.source && (parsed.ref === undefined || e.ref === parsed.ref)
    })
    if (candidates.length > 1) {
      return fail(
        ErrorCodes.RESOLVE_AMBIGUOUS,
        `Member ${JSON.stringify(locator)} matches ${candidates.length} skills in ${SKILLS_LOCK_FILE}: ${candidates.join(', ')}. A set skill must resolve to exactly one skill`,
        { hint: `Name the skill in the set member, e.g. ${JSON.stringify(`${parsed.source}@${candidates[0]!}`)}.`, data: { locator, candidates } },
      )
    }
    if (candidates.length === 0) {
      return fail(
        ErrorCodes.MEMBER_NOT_INSTALLED,
        `Member ${JSON.stringify(locator)} could not be matched to an installed skill in ${SKILLS_LOCK_FILE}`,
        { hint: 'Install the set first ("skill-set install <set>"), or name the skill in the member, e.g. "<source>@<skill-name>".', data: { locator } },
      )
    }
    skillName = candidates[0]!
  }

  if (skillName === RESERVED_SKILL_NAME) {
    return { ok: false, error: reservedNameError([locator]) }
  }

  const folder = join(opts.cwd, SKILLS_DIR, skillName)
  if (!existsSync(folder)) {
    return fail(
      ErrorCodes.MEMBER_NOT_INSTALLED,
      `Member ${JSON.stringify(locator)} is not installed (no folder at ${SKILLS_DIR}/${skillName})`,
      { hint: 'Install the set first: "skill-set install <set>".', data: { locator, skillName } },
    )
  }
  const entry = lock.data[skillName]
  return {
    ok: true,
    data: {
      skill: skillName,
      computedHash: specFolderHash(folder),
      ...(entry?.sourceType === undefined ? {} : { sourceType: entry.sourceType }),
      ...(entry?.ref === undefined ? {} : { ref: entry.ref }),
    },
  }
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts?: SpawnOptions,
) => Promise<Result<SpawnOutcome>>

export interface Resolver {
  resolve(locator: string, opts: { cwd: string }): Promise<Result<ResolvedMember>>
}

/**
 * Sole v1 resolver: shells out to the pinned `npx skills` and reads back its project lock.
 * Skill discovery diffs skills-lock.json around the spawn, so resolves sharing one cwd
 * must run sequentially, never concurrently.
 */
export async function resolveMember(
  locator: string,
  opts: {
    cwd: string
    runner?: CommandRunner
    extraArgs?: readonly string[]
    capture?: boolean
    onSetsDirRestored?: () => void
  },
): Promise<Result<ResolvedMember>> {
  if (locator.trim() === '') {
    return fail(ErrorCodes.RESOLVE_FAILED, 'A member skill locator must be a non-empty string')
  }

  const parsed = parseLocator(locator)
  if (parsed.skill === RESERVED_SKILL_NAME) {
    return { ok: false, error: reservedNameError([locator]) }
  }

  // An explicit @skill already narrows the upstream selection to one. For an unnamed
  // locator, use the pinned CLI's documented --list mode before the mutating add spawn.
  if (parsed.skill === undefined) {
    const probe = await probeMemberCount(locator, opts)
    if (!probe.ok) return probe
    if (probe.data !== 1) return preInstallDiscoveryFailure(locator, parsed.source, probe.data)
  }

  const before = readLockSkills(opts.cwd)
  if (!before.ok) return before

  // The upstream CLI owns `.agents/skills/<name>` folders wholesale, so a skill claiming the
  // reserved name would overwrite the set definitions living inside the skills dir. The name is
  // only known post-spawn for unnamed locators — snapshot around the spawn and restore any damage.
  const guard = snapshotSetsDir(opts.cwd)

  const invocation = buildAddInvocation(locator)
  const args =
    opts.extraArgs === undefined || opts.extraArgs.length === 0
      ? invocation.args
      : [...invocation.args, ...opts.extraArgs]
  const run = await (opts.runner ?? runCommand)(invocation.command, args, {
    cwd: opts.cwd,
    env: invocation.env,
    capture: opts.capture,
  })
  if (restoreSetsDir(opts.cwd, guard)) opts.onSetsDirRestored?.()
  if (!run.ok) return run
  if (run.data.exitCode !== 0) {
    return fail(
      ErrorCodes.RESOLVE_FAILED,
      `Resolving ${JSON.stringify(locator)} failed: the skills CLI exited with code ${run.data.exitCode}`,
      {
        hint: opts.capture === true ? 'The captured skills output is in data.stderr.' : 'See the skills output above for the cause.',
        data: {
          locator,
          exitCode: run.data.exitCode,
          ...(opts.capture === true ? { stderr: run.data.stderr.slice(-2000) } : {}),
        },
      },
    )
  }

  const after = readLockSkills(opts.cwd)
  if (!after.ok) return after

  let skillName: string
  if (parsed.skill !== undefined) {
    skillName = parsed.skill
  } else {
    // Tier 1: a fresh install surfaces as exactly one new lock key.
    const added = Object.keys(after.data).filter((k) => !(k in before.data))
    if (added.length === 1) {
      skillName = added[0]!
    } else if (added.length > 1) {
      return discoveryFailure(locator, parsed.source, added)
    } else {
      // Tier 2 (reinstall: upstream updates the entry in place, no key churn): match the
      // locator's source byte-for-byte against lock entries; a unique owner names the skill.
      const candidates = Object.keys(after.data).filter((k) => {
        const e = after.data[k]!
        return e.source === parsed.source && (parsed.ref === undefined || e.ref === parsed.ref)
      })
      if (candidates.length !== 1) return discoveryFailure(locator, parsed.source, candidates)
      skillName = candidates[0]!
    }
  }

  // An unnamed locator can only be found out post-spawn; the set files are already restored
  // above, so all that remains is refusing the member and dropping its upstream lock entry.
  if (skillName === RESERVED_SKILL_NAME) {
    dropSkillsLockEntry(opts.cwd, skillName)
    return { ok: false, error: reservedNameError([locator], true) }
  }

  const entry = after.data[skillName]
  if (entry === undefined) {
    return fail(
      ErrorCodes.RESOLVE_NO_LOCK_ENTRY,
      `${JSON.stringify(locator)} did not record skill ${JSON.stringify(skillName)} in ${SKILLS_LOCK_FILE}`,
      { data: { locator, skillName } },
    )
  }

  const folder = join(opts.cwd, SKILLS_DIR, skillName)
  if (!existsSync(folder)) {
    return fail(
      ErrorCodes.RESOLVE_FOLDER_MISSING,
      `Skill ${JSON.stringify(skillName)} is locked but its folder is missing at ${SKILLS_DIR}/${skillName}`,
      { data: { locator, skillName, folder } },
    )
  }

  // The upstream lock's computedHash is opaque here: for GitHub blob installs it is a
  // server-side snapshot hash no local bytes can reproduce (verified empirically; see
  // test/compat.test.ts). Our set-lock records the spec §6 hash of the installed folder instead.
  return {
    ok: true,
    data: {
      skill: skillName,
      computedHash: specFolderHash(folder),
      ...(entry.sourceType === undefined ? {} : { sourceType: entry.sourceType }),
      ...(entry.ref === undefined ? {} : { ref: entry.ref }),
    },
  }
}

async function probeMemberCount(
  locator: string,
  opts: {
    cwd: string
    runner?: CommandRunner
    extraArgs?: readonly string[]
    onSetsDirRestored?: () => void
  },
): Promise<Result<number>> {
  const invocation = buildListInvocation(locator)
  const args =
    opts.extraArgs === undefined || opts.extraArgs.length === 0
      ? invocation.args
      : [...invocation.args, ...opts.extraArgs]
  const guard = snapshotSetsDir(opts.cwd)
  const run = await (opts.runner ?? runCommand)(invocation.command, args, {
    cwd: opts.cwd,
    env: invocation.env,
    capture: true,
  })
  if (restoreSetsDir(opts.cwd, guard)) opts.onSetsDirRestored?.()
  if (!run.ok) return run
  if (run.data.exitCode !== 0) {
    return fail(
      ErrorCodes.RESOLVE_FAILED,
      `Probing ${JSON.stringify(locator)} failed: the skills CLI exited with code ${run.data.exitCode}`,
      {
        hint: 'The captured skills output is in data.stderr.',
        data: { locator, exitCode: run.data.exitCode, stderr: run.data.stderr.slice(-2000) },
      },
    )
  }

  const plain = stripTerminalSequences(`${run.data.stdout}\n${run.data.stderr}`)
  const count = plain.match(/\bFound ([1-9]\d*) skills?\b/)?.[1]
  if (count === undefined) {
    return fail(
      ErrorCodes.RESOLVE_FAILED,
      `Probing ${JSON.stringify(locator)} failed: the skills CLI did not report how many skills are available`,
      {
        hint: `This CLI expects the documented --list output from skills@${SKILLS_PIN}; check upstream compatibility.`,
        data: { locator },
      },
    )
  }
  return { ok: true, data: Number.parseInt(count, 10) }
}

/** Removes C0/C1 controls and ANSI CSI sequences from captured upstream status output. */
function stripTerminalSequences(value: string): string {
  let plain = ''
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index)!
    if (codePoint === 0x1b) {
      if (value.codePointAt(index + 1) === 0x5b) {
        index += 2
        while (index < value.length) {
          const final = value.codePointAt(index)!
          if (final >= 0x40 && final <= 0x7e) break
          index++
        }
      }
      continue
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (codePoint === 0x0a) plain += '\n'
      continue
    }
    plain += value[index]!
  }
  return plain
}

function preInstallDiscoveryFailure(locator: string, source: string, count: number): Result<never> {
  return fail(
    ErrorCodes.RESOLVE_AMBIGUOUS,
    `Member ${JSON.stringify(locator)} matches ${count} available skills. A set member must resolve to exactly one skill. Nothing was installed.`,
    {
      hint: `Name the skill in the set member, e.g. ${JSON.stringify(`${source}@<skill-name>`)}.`,
      data: { locator, source, count },
    },
  )
}

/**
 * The factual discovery error (tier 3): states what happened, lists the candidate skills
 * for the member's source, and closes with a copy-paste fix. Written for an installer
 * who did not author the set.
 */
function discoveryFailure(locator: string, source: string, candidates: string[]): Result<never> {
  if (candidates.length > 0) {
    return fail(
      ErrorCodes.RESOLVE_AMBIGUOUS,
      `Member ${JSON.stringify(locator)} was installed, but matches ${candidates.length} skills in ${SKILLS_LOCK_FILE}: ${candidates.join(', ')}. A set member must resolve to exactly one skill.`,
      {
        hint: `Name the skill in the set member, e.g. ${JSON.stringify(`${source}@${candidates[0]!}`)}.`,
        data: { locator, source, candidates },
      },
    )
  }
  return fail(
    ErrorCodes.RESOLVE_UNMATCHED,
    `Member ${JSON.stringify(locator)} was installed, but could not be matched to a skill in ${SKILLS_LOCK_FILE}.`,
    {
      hint: `Name the skill in the set member, e.g. ${JSON.stringify(`${source}@<skill-name>`)}.`,
      data: { locator, source, candidates },
    },
  )
}

type LockSkills = Record<
  string,
  { source: string; computedHash: string; sourceType?: string; ref?: string }
>

function readLockSkills(cwd: string): Result<LockSkills> {
  const path = join(cwd, SKILLS_LOCK_FILE)
  if (!existsSync(path)) return { ok: true, data: {} }
  const parsed = parseSkillsLock(readFileSync(path, 'utf8'), { filename: SKILLS_LOCK_FILE })
  if (!parsed.ok) return parsed
  return { ok: true, data: parsed.data.skills }
}

function fail(
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  options?: { hint?: string; data?: unknown },
): Result<never> {
  return { ok: false, error: new SkillSetError(code, message, options) }
}
