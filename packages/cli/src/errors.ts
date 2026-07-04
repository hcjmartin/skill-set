export const ErrorCodes = {
  INVALID_JSON: 'ERR_SKILLSET_INVALID_JSON',
  INVALID_MANIFEST: 'ERR_SKILLSET_INVALID_MANIFEST',
  NAME_MISMATCH: 'ERR_SKILLSET_NAME_MISMATCH',
  DUPLICATE_MEMBER: 'ERR_SKILLSET_DUPLICATE_MEMBER',
  SCHEMA_VERSION: 'ERR_SKILLSET_SCHEMA_VERSION',
  INVALID_LOCK: 'ERR_SKILLSET_INVALID_LOCK',
  LOCK_VERSION: 'ERR_SKILLSET_LOCK_VERSION',
  SPAWN_FAILED: 'ERR_SKILLSET_SPAWN_FAILED',
  RESOLVE_FAILED: 'ERR_SKILLSET_RESOLVE_FAILED',
  RESOLVE_AMBIGUOUS: 'ERR_SKILLSET_RESOLVE_AMBIGUOUS',
  RESOLVE_UNMATCHED: 'ERR_SKILLSET_RESOLVE_UNMATCHED',
  RESOLVE_NO_LOCK_ENTRY: 'ERR_SKILLSET_RESOLVE_NO_LOCK_ENTRY',
  RESOLVE_FOLDER_MISSING: 'ERR_SKILLSET_RESOLVE_FOLDER_MISSING',
} as const

export type SkillSetErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

// Consumers match on `code` (+ data shape), never `instanceof` — class identity breaks across bundled copies.
export class SkillSetError extends Error {
  readonly code: SkillSetErrorCode
  readonly hint: string | undefined
  readonly data: unknown

  constructor(
    code: SkillSetErrorCode,
    message: string,
    options?: { hint?: string; data?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SkillSetError'
    this.code = code
    this.hint = options?.hint
    this.data = options?.data
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: SkillSetError }
