import { ErrorCodes, SkillSetError } from './errors.ts'
import { compareUtf8 } from './json.ts'
import { LOCK_SUFFIX, type SetLock } from './lock.ts'
import { MANIFEST_SUFFIX, type Manifest } from './manifest.ts'

export const SKILL_SET_MD_FILENAME = 'SKILL-SET.md'
export const INDEX_FILENAME = 'skill-sets.json'
export const INDEX_VERSION = 1

/** Caller-gathered facts about one member, keyed by its manifest locator. */
export interface MemberDetails {
  /** Installed skill name (the folder under the skills root). */
  skill?: string
  /** The member's own trigger description, reused verbatim. */
  description?: string
}

export interface GenerateOptions {
  /** Per-locator details read from installed skills; members without one render as pending. */
  members?: Record<string, MemberDetails>
  /** The set's lock, when one exists — supplies resolved skill names, refs, and provenance. */
  lock?: SetLock
  /** One-line license notice for the frontmatter, e.g. "Complete terms in LICENSE.txt". */
  license?: string
}

/**
 * Generates the SKILL-SET.md discovery page for one set. Frontmatter includes
 * descriptions, skill member table reusing each skill's own trigger description,
 * then installation/usage/provenance. Pure and deterministic. Identical inputs
 * produce identical bytes — file IO and member-detail gathering belong to the caller.
 */
export function generateSkillSetMd(manifest: Manifest, opts: GenerateOptions = {}): string {
  const { lock } = opts
  if (lock !== undefined && lock.name !== manifest.name) {
    throw new SkillSetError(
      ErrorCodes.INVALID_LOCK,
      `Cannot generate ${SKILL_SET_MD_FILENAME} for set ${JSON.stringify(manifest.name)} from a lock that belongs to ${JSON.stringify(lock.name)}`,
      { hint: `Pass ${manifest.name}${LOCK_SUFFIX}, or omit the lock.`, data: { manifest: manifest.name, lock: lock.name } },
    )
  }

  const n = manifest.skills.length
  const plural = n === 1 ? 'skill' : 'skills'
  const trigger = `A set of ${n} agent ${plural}. Use when installing, verifying, or updating the "${manifest.name}" skill set.`
  const description = manifest.description === undefined ? trigger : `${manifest.description} ${trigger}`

  // Every scalar is JSON-quoted: valid set names like "no" or "123" would otherwise
  // parse as YAML boolean/int, and JSON strings are valid YAML double-quoted scalars.
  const lines: string[] = ['---', `name: ${JSON.stringify(manifest.name)}`, `description: ${JSON.stringify(description)}`]
  if (opts.license !== undefined) lines.push(`license: ${JSON.stringify(opts.license)}`)
  lines.push('---', '', `# ${manifest.name}`, '', '## Overview', '')
  if (manifest.description !== undefined) lines.push(manifest.description, '')
  lines.push(
    `This set bundles ${n} ${plural}. It is generated from \`${manifest.name}${MANIFEST_SUFFIX}\`. Updates should be made to the manifest, not this file.`,
    '',
    '## Skills in this set',
    '',
    '| Skill | Description | Source |',
    '| --- | --- | --- |',
  )

  for (const locator of [...manifest.skills].sort(compareUtf8)) {
    const details = opts.members?.[locator]
    const entry = lock?.skills[locator]
    const skill = details?.skill ?? entry?.skill
    const skillCell = skill === undefined ? '(not installed)' : `\`${skill}\``
    const descriptionCell = details?.description ?? '(none recorded)'
    const sourceCell = entry?.ref === undefined ? `\`${locator}\`` : `\`${locator}\` (locked to \`${entry.ref}\`)`
    lines.push(`| ${cell(skillCell)} | ${cell(descriptionCell)} | ${cell(sourceCell)} |`)
  }

  lines.push(
    '',
    '## Installation',
    '',
    '```',
    `npx @skill-set/cli install ${manifest.name}`,
    '```',
    '',
    '## Usage',
    '',
    'Members install as ordinary skills under `.agents/skills/<skill>/`; once installed, agents discover and invoke them like any other skill.',
    '',
    '## Provenance',
    '',
  )
  if (lock === undefined) {
    lines.push(
      `No lock is recorded for this set. Capture the resolved content of every member with \`npx @skill-set/cli lock ${manifest.name}\`.`,
    )
  } else {
    lines.push(
      `Locked at set version ${lock.setVersion}. Every member's resolved content is recorded in \`${lock.name}${LOCK_SUFFIX}\` (setHash \`${lock.setHash}\`).`,
    )
    if (lock.setVersion !== manifest.version) {
      lines.push(
        '',
        `Note: the manifest is now at version ${manifest.version} — regenerate the lock with \`npx @skill-set/cli lock ${manifest.name}\`.`,
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

// Markdown table cells cannot hold raw newlines or pipes; backslashes escape first so
// existing "\|" sequences in content cannot reassemble into an unescaped pipe.
function cell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll(/\r?\n/g, ' ').replaceAll('|', '\\|')
}

/**
 * Generates the skill-sets.json index over every set in a project. Deterministic (spec §7):
 * set names and each set's members serialize in UTF-8-byte-order regardless of input order.
 */
export function generateIndex(manifests: Manifest[]): string {
  const byName = new Map<string, Manifest>()
  for (const manifest of manifests) {
    if (byName.has(manifest.name)) {
      throw new SkillSetError(
        ErrorCodes.DUPLICATE_SET,
        `Two sets declare the name ${JSON.stringify(manifest.name)}`,
        { hint: 'Set names are unique within a project — rename one of the manifests.', data: { name: manifest.name } },
      )
    }
    byName.set(manifest.name, manifest)
  }

  const sets: Record<string, unknown> = {}
  for (const name of [...byName.keys()].sort(compareUtf8)) {
    const manifest = byName.get(name)!
    sets[name] = {
      version: manifest.version,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      skills: [...manifest.skills].sort(compareUtf8),
    }
  }
  return `${JSON.stringify({ version: INDEX_VERSION, sets }, null, 2)}\n`
}
