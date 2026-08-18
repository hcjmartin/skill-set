/**
 * Typed shape of `<name>.skill-set.lock.json` (spec §5, lock format version 1).
 * Mirrors skill-set.lock.schema.json; useful for consumers that already have
 * parsed JSON and want types without a validation dependency. These types
 * assert shape only — schema validation remains the reader's responsibility.
 */

/** Resolution record for one member skill, keyed in the lock by its manifest locator. */
export interface SkillSetLockMember {
  /** The installed skill name (directory name under the skills root). */
  skill: string
  /** Member content hash (spec §6, `skill-set/folder-v1`), lowercase hex. */
  computedHash: string
  /** Resolver-reported source kind (open vocabulary, e.g. `github`, `git`, `well-known`). */
  sourceType?: string
  /** Resolver-reported resolved ref (tag or branch), when the source has one. */
  ref?: string
}

export interface SkillSetLock {
  /** Lock format version; this shape describes version 1. */
  version: 1
  /** The set's name (equals the manifest name and the filename stem). */
  name: string
  /** The manifest version at lock time. */
  setVersion: string
  /** Rollup hash over the members (spec §5, `skill-set/set-v1`), lowercase hex. */
  setHash: string
  /** One entry per member, keyed by the manifest locator string. */
  skills: Record<string, SkillSetLockMember>
}
