import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { readSkillDescription } from './frontmatter.ts'
import {
  generateIndex,
  generateSkillSetMd,
  INDEX_FILENAME,
  SKILL_SET_MD_FILENAME,
  type MemberDetails,
} from './generate.ts'
import { compareUtf8, parseStrictJson } from './json.ts'
import { LOCK_SUFFIX, parseSetLock, type SetLock } from './lock.ts'
import { MANIFEST_SUFFIX, parseManifest, type Manifest } from './manifest.ts'
import { locateMember, SKILLS_DIR } from './resolver.ts'

/** Where set definitions live, relative to the project root (one folder per set). */
export const SETS_DIR = `${SKILLS_DIR}/skill-sets`

export interface SetPaths {
  dir: string
  manifest: string
  lock: string
  page: string
}

export function setPaths(cwd: string, name: string): SetPaths {
  const dir = join(cwd, SETS_DIR, name)
  return {
    dir,
    manifest: join(dir, `${name}${MANIFEST_SUFFIX}`),
    lock: join(dir, `${name}${LOCK_SUFFIX}`),
    page: join(dir, SKILL_SET_MD_FILENAME),
  }
}

/** Set names present in the project: subdirectories of the sets dir holding their manifest. */
export function listSetNames(cwd: string): string[] {
  const root = join(cwd, SETS_DIR)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, `${d.name}${MANIFEST_SUFFIX}`)))
    .map((d) => d.name)
    .sort(compareUtf8)
}

export function loadManifest(cwd: string, name: string): Result<Manifest> {
  const paths = setPaths(cwd, name)
  if (!existsSync(paths.manifest)) {
    const available = listSetNames(cwd)
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.SET_NOT_FOUND,
        `Set manifest ${JSON.stringify(name)} not found (expected ${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX})`,
        {
          hint:
            available.length > 0
              ? `Available sets: ${available.join(', ')}. Install a shared set from a manifest URL: "skill-set add <https-url>".`
              : 'No sets here. Create a new set with "skill-set init <name>". Add a shared set with "skill-set add <https-url>".',
          data: { name, available },
        },
      ),
    }
  }
  return parseManifest(readFileSync(paths.manifest, 'utf8'), { filename: `${name}${MANIFEST_SUFFIX}` })
}

export function loadLockIfPresent(cwd: string, name: string): Result<SetLock | undefined> {
  const paths = setPaths(cwd, name)
  if (!existsSync(paths.lock)) return { ok: true, data: undefined }
  return parseSetLock(readFileSync(paths.lock, 'utf8'), { filename: `${name}${LOCK_SUFFIX}` })
}

/** Every set's manifest; the first invalid one fails the whole read, naming its set. */
export function loadAllManifests(cwd: string): Result<Manifest[]> {
  const manifests: Manifest[] = []
  for (const name of listSetNames(cwd)) {
    const loaded = loadManifest(cwd, name)
    if (!loaded.ok) return loaded
    manifests.push(loaded.data)
  }
  return { ok: true, data: manifests }
}

/** Regenerates one set's SKILL-SET.md from its manifest, installed members, and lock. */
export function writeSetPage(cwd: string, manifest: Manifest, lock: SetLock | undefined): string {
  const page = generateSkillSetMd(manifest, { members: gatherMemberDetails(cwd, manifest), lock })
  writeFileSync(setPaths(cwd, manifest.name).page, page)
  return `${SETS_DIR}/${manifest.name}/${SKILL_SET_MD_FILENAME}`
}

/**
 * Regenerates the project-wide index over every set. Existing per-set `source` values are read
 * from the current index and carried forward; `newSources` records origins for sets added this
 * pass. Sources for sets that no longer exist drop naturally, since only present sets are written.
 */
export function writeIndex(cwd: string, newSources: Record<string, string> = {}): Result<string> {
  const manifests = loadAllManifests(cwd)
  if (!manifests.ok) return manifests
  const sources = { ...readIndexSources(cwd), ...newSources }
  writeFileSync(join(cwd, SETS_DIR, INDEX_FILENAME), generateIndex(manifests.data, sources))
  return { ok: true, data: `${SETS_DIR}/${INDEX_FILENAME}` }
}

/** The origin URL recorded for a set in the index, if any — informational provenance only. */
export function readSetSource(cwd: string, name: string): string | undefined {
  return readIndexSources(cwd)[name]
}

/** Per-set `source` values from the existing index; empty when it is missing or unparseable. */
function readIndexSources(cwd: string): Record<string, string> {
  const indexPath = join(cwd, SETS_DIR, INDEX_FILENAME)
  if (!existsSync(indexPath)) return {}
  const parsed = parseStrictJson(readFileSync(indexPath, 'utf8'))
  if (!parsed.ok) return {}
  const sets = (parsed.data as { sets?: unknown }).sets
  if (typeof sets !== 'object' || sets === null) return {}
  const sources: Record<string, string> = {}
  for (const [name, entry] of Object.entries(sets as Record<string, unknown>)) {
    const source = (entry as { source?: unknown }).source
    if (typeof source === 'string') sources[name] = source
  }
  return sources
}

/**
 * Best-effort member details for SKILL-SET.md generation: the installed skill name plus its
 * own trigger description from SKILL.md. Members that cannot be located render as pending.
 */
export function gatherMemberDetails(cwd: string, manifest: Manifest): Record<string, MemberDetails> {
  const details: Record<string, MemberDetails> = {}
  for (const locator of manifest.skills) {
    const located = locateMember(locator, { cwd })
    if (!located.ok) continue
    const detail: MemberDetails = { skill: located.data.skill }
    const skillMd = join(cwd, SKILLS_DIR, located.data.skill, 'SKILL.md')
    if (existsSync(skillMd)) {
      const description = readSkillDescription(readFileSync(skillMd, 'utf8'))
      if (description !== undefined) detail.description = description
    }
    details[locator] = detail
  }
  return details
}
