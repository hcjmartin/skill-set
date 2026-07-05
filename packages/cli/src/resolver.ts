import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildConfig } from './config.ts'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { specFolderHash } from './hash.ts'
import { parseSkillsLock } from './lock.ts'
import { NAME_PATTERN } from './manifest.ts'
import { runCommand, type SpawnOptions, type SpawnOutcome } from './spawn.ts'

/** Upstream pin, minor-level: patch releases float in, minor/major bumps are deliberate. */
export const SKILLS_PIN = '1.5'

/** Where resolved skills land, relative to the project root (spec §4; upstream UNIVERSAL_SKILLS_DIR). */
export const SKILLS_DIR = '.agents/skills'

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
  // (add-skill.vercel.sh) is separate and not opt-out-able (see CHANGELOG).
  const env: Record<string, string> = {}
  if (buildConfig.suppressUpstreamTelemetry) env.DISABLE_TELEMETRY = '1'
  return { command: 'npx', args, env }
}

export interface ResolvedMember {
  skill: string
  /** The spec §6 content hash — what a set-lock records. */
  computedHash: string
  sourceType?: string
  ref?: string
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
  opts: { cwd: string; runner?: CommandRunner },
): Promise<Result<ResolvedMember>> {
  if (locator.trim() === '') {
    return fail(ErrorCodes.RESOLVE_FAILED, 'A member locator must be a non-empty string (spec §1)')
  }

  const before = readLockSkills(opts.cwd)
  if (!before.ok) return before

  const invocation = buildAddInvocation(locator)
  const run = await (opts.runner ?? runCommand)(invocation.command, invocation.args, {
    cwd: opts.cwd,
    env: invocation.env,
  })
  if (!run.ok) return run
  if (run.data.exitCode !== 0) {
    return fail(
      ErrorCodes.RESOLVE_FAILED,
      `Resolving ${JSON.stringify(locator)} failed: the skills CLI exited with code ${run.data.exitCode}`,
      { hint: 'See the skills output above for the cause.', data: { locator, exitCode: run.data.exitCode } },
    )
  }

  const after = readLockSkills(opts.cwd)
  if (!after.ok) return after

  const parsed = parseLocator(locator)
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
  // server-side snapshot hash no local bytes can reproduce (see CHANGELOG). Our set-lock
  // records the spec §6 hash of the installed folder instead.
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

/**
 * The factual discovery error (tier 3): states what happened, lists the candidate skills
 * for the member's source, and closes with a copy-paste fix. Written for an installer
 * who did not author the set.
 */
function discoveryFailure(locator: string, source: string, candidates: string[]): Result<never> {
  if (candidates.length > 0) {
    return fail(
      ErrorCodes.RESOLVE_AMBIGUOUS,
      `Member ${JSON.stringify(locator)} was installed, but matches ${candidates.length} skills in ${SKILLS_LOCK_FILE}: ${candidates.join(', ')}. A set member must resolve to exactly one skill (spec §1).`,
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
