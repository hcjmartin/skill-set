import { basename } from 'node:path'
import * as z from 'zod'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { setHash } from './hash.ts'
import { compareUtf8, parseStrictJson } from './json.ts'
import { NAME_PATTERN, SEMVER_PATTERN } from './manifest.ts'
import { structuralIssues } from './zod-issues.ts'

export const LOCK_SUFFIX = '.skill-set.lock.json'
export const SET_LOCK_VERSION = 1
const HEX64 = /^[a-f0-9]{64}$/

const memberSchema = z.strictObject({
  skill: z.string().min(1).regex(NAME_PATTERN),
  computedHash: z.string().regex(HEX64, 'must be a lowercase sha256 hex digest'),
  sourceType: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
})

const setLockSchema = z.strictObject({
  version: z.literal(SET_LOCK_VERSION),
  name: z.string().min(1).max(64).regex(NAME_PATTERN),
  setVersion: z.string().regex(SEMVER_PATTERN, 'must be a semantic version'),
  setHash: z.string().regex(HEX64, 'must be a lowercase sha256 hex digest'),
  skills: z
    .record(z.string().min(1), memberSchema)
    .refine((r) => Object.keys(r).length > 0, 'must record at least one member'),
})

export type SetLock = z.infer<typeof setLockSchema>
export type SetLockMember = z.infer<typeof memberSchema>

export function parseSetLock(text: string, opts?: { filename?: string }): Result<SetLock> {
  const context = opts?.filename ?? 'Set-lock'
  const json = parseStrictJson(text, context)
  if (!json.ok) return json

  // Version gate before shape validation: unknown versions fail loudly and are never
  // discarded or rewritten (spec §5 — the upstream wipe-on-mismatch anti-pattern).
  const raw = json.data as Record<string, unknown> | null
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.version !== SET_LOCK_VERSION) {
    return fail(
      ErrorCodes.LOCK_VERSION,
      `${context} has lock format version ${JSON.stringify(raw.version)}, but this skill-set implementation reads version ${SET_LOCK_VERSION}`,
      {
        hint: 'Align the skill-set version with the one that wrote the lock, or regenerate with "skill-set lock". The file was left untouched.',
        data: { found: raw.version, supported: SET_LOCK_VERSION },
      },
    )
  }

  const parsed = setLockSchema.safeParse(json.data)
  if (!parsed.success) {
    const issues = structuralIssues(parsed.error.issues)
    return fail(ErrorCodes.INVALID_LOCK, `${context} is not a valid set-lock:\n  - ${issues.lines.join('\n  - ')}`, {
      hint: 'Regenerate with "skill-set lock".',
      data: issues.data,
    })
  }
  const lock = parsed.data

  const expected = setHash(
    Object.fromEntries(Object.entries(lock.skills).map(([loc, m]) => [loc, m.computedHash])),
  )
  if (lock.setHash !== expected) {
    return fail(
      ErrorCodes.INVALID_LOCK,
      `${context} setHash ${lock.setHash.slice(0, 12)}… does not match its own members (expected ${expected.slice(0, 12)}…)`,
      { hint: 'The lock is internally inconsistent — regenerate with "skill-set lock".', data: { found: lock.setHash, expected } },
    )
  }

  if (opts?.filename !== undefined) {
    const file = basename(opts.filename)
    const expectedName = `${lock.name}${LOCK_SUFFIX}`
    if (file !== expectedName) {
      return fail(
        ErrorCodes.INVALID_LOCK,
        `${file} declares name ${JSON.stringify(lock.name)}, but the filename requires ${JSON.stringify(expectedName)}`,
        { hint: 'The lock name must equal the filename minus the .skill-set.lock.json suffix (spec §2.2/§5).' },
      )
    }
  }

  return { ok: true, data: lock }
}

export function createSetLock(
  name: string,
  setVersion: string,
  members: Record<string, SetLockMember>,
): SetLock {
  if (Object.keys(members).length === 0) {
    throw new SkillSetError(ErrorCodes.INVALID_LOCK, 'A set-lock must record at least one member', {
      hint: 'Write a lock only after at least one member has resolved.',
    })
  }
  return {
    version: SET_LOCK_VERSION,
    name,
    setVersion,
    setHash: setHash(Object.fromEntries(Object.entries(members).map(([loc, m]) => [loc, m.computedHash]))),
    skills: members,
  }
}

/** Canonical serialization per spec §5/§7: fixed field order, byte-sorted member keys, 2-space, trailing LF. */
export function serializeSetLock(lock: SetLock): string {
  const skills: Record<string, unknown> = {}
  const locators = Object.keys(lock.skills).sort(compareUtf8)
  for (const locator of locators) {
    const m = lock.skills[locator]!
    skills[locator] = {
      skill: m.skill,
      computedHash: m.computedHash,
      ...(m.sourceType !== undefined ? { sourceType: m.sourceType } : {}),
      ...(m.ref !== undefined ? { ref: m.ref } : {}),
    }
  }
  const ordered = {
    version: lock.version,
    name: lock.name,
    setVersion: lock.setVersion,
    setHash: lock.setHash,
    skills,
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

// --- Upstream project lock (skills-lock.json) read adapter -------------------------------------

const SKILLS_LOCK_VERSION = 1

const skillsLockEntrySchema = z.looseObject({
  source: z.string(),
  sourceType: z.string(),
  computedHash: z.string(),
  ref: z.string().optional(),
  skillPath: z.string().optional(),
})

const skillsLockSchema = z.looseObject({
  version: z.number(),
  skills: z.record(z.string(), skillsLockEntrySchema),
})

export type SkillsLock = z.infer<typeof skillsLockSchema>

/** Read-only adapter for the upstream `skills-lock.json` (schema v1). Never wipes on mismatch. */
export function parseSkillsLock(text: string, opts?: { filename?: string }): Result<SkillsLock> {
  const context = opts?.filename ?? 'skills-lock.json'
  const json = parseStrictJson(text, context)
  if (!json.ok) return json

  const raw = json.data as Record<string, unknown> | null
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && raw.version !== SKILLS_LOCK_VERSION) {
    return fail(
      ErrorCodes.LOCK_VERSION,
      `${context} has version ${JSON.stringify(raw.version)}, but this skill-set implementation reads upstream lock version ${SKILLS_LOCK_VERSION}`,
      {
        hint: 'A newer "skills" CLI may have changed its lock format — update skill-set, or re-run the pinned skills version. The file was left untouched.',
        data: { found: raw.version, supported: SKILLS_LOCK_VERSION },
      },
    )
  }

  const parsed = skillsLockSchema.safeParse(json.data)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return fail(ErrorCodes.INVALID_LOCK, `${context} could not be read:\n  - ${issues.join('\n  - ')}`, {
      data: parsed.error.issues,
    })
  }
  return { ok: true, data: parsed.data }
}

function fail(
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  options?: { hint?: string; data?: unknown },
): Result<never> {
  return { ok: false, error: new SkillSetError(code, message, options) }
}
