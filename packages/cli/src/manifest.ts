import { basename } from 'node:path'
import * as z from 'zod'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { parseStrictJson } from './json.ts'
import { structuralIssues } from './zod-issues.ts'

export const MANIFEST_SUFFIX = '.skill-set.json'
export const DRAFT_SCHEMA_URL = 'https://skill-set.md/schema/draft/skill-set.schema.json'
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

const manifestSchema = z.strictObject({
  $schema: z.url().optional(),
  name: z.string().min(1).max(64).regex(NAME_PATTERN),
  version: z.string().regex(SEMVER_PATTERN, 'must be a semantic version'),
  description: z.string().optional(),
  author: z
    .strictObject({
      name: z.string().min(1),
      url: z.url().optional(),
      organization: z.string().optional(),
      uri: z.url().optional(),
    })
    .optional(),
  homepage: z.url().optional(),
  skills: z.array(z.string().min(1)).min(1),
})

export type Manifest = z.infer<typeof manifestSchema>

// Schema versions this implementation can validate (spec §2.5); the URL path segment is the id.
const SUPPORTED_SCHEMA_VERSIONS = new Set(['draft'])

export function parseManifest(text: string, opts?: { filename?: string }): Result<Manifest> {
  const context = opts?.filename ?? 'Manifest'
  const json = parseStrictJson(text, context)
  if (!json.ok) return json

  const parsed = manifestSchema.safeParse(json.data)
  if (!parsed.success) {
    const issues = structuralIssues(parsed.error.issues)
    return fail(ErrorCodes.INVALID_MANIFEST, `${context} does not match the skill-set schema:\n  - ${issues.lines.join('\n  - ')}`, {
      hint: 'The schema is served at https://skill-set.md/schema/draft/skill-set.schema.json.',
      data: issues.data,
    })
  }
  const manifest = parsed.data

  // Positional only: a locator is unconstrained remote text, so the error names its
  // index in skills[] rather than echoing the value (spec §2.4).
  const seen = new Set<string>()
  for (const [index, locator] of manifest.skills.entries()) {
    if (seen.has(locator)) {
      return fail(ErrorCodes.DUPLICATE_MEMBER, `${context} lists a member skill more than once (skills[${index}])`, {
        hint: 'Duplicate skills[] entries are invalid — remove the repeated locator.',
        data: { index },
      })
    }
    seen.add(locator)
  }

  if (manifest.$schema !== undefined) {
    const segment = /\/schema\/(draft|v\d+)\//.exec(manifest.$schema)?.[1]
    if (segment === undefined || !SUPPORTED_SCHEMA_VERSIONS.has(segment)) {
      // The version segment (draft/v9) is a structural token; the raw $schema URL is remote
      // content and is not echoed. When the URL has no recognisable segment, say so structurally (spec §2.5).
      const declared = segment === undefined ? 'a $schema URL with no recognised version segment' : `schema version ${segment}`
      return fail(ErrorCodes.SCHEMA_VERSION, `${context} declares ${declared}, which this implementation does not support`, {
        hint: `Supported versions: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}. Consumers must reject unknown versions rather than best-effort parse.`,
        data: segment === undefined ? {} : { schemaVersion: segment },
      })
    }
  }

  if (opts?.filename !== undefined) {
    const file = basename(opts.filename)
    const expected = `${manifest.name}${MANIFEST_SUFFIX}`
    if (file !== expected) {
      return fail(ErrorCodes.NAME_MISMATCH, `${file} declares name ${JSON.stringify(manifest.name)}, but the filename requires ${JSON.stringify(expected)}`, {
        hint: 'The manifest name must equal the filename minus the .skill-set.json suffix (spec §2.2) — rename the file or change "name".',
        data: { name: manifest.name, filename: file },
      })
    }
  }

  return { ok: true, data: manifest }
}

function fail(
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes],
  message: string,
  options?: { hint?: string; data?: unknown },
): Result<never> {
  return { ok: false, error: new SkillSetError(code, message, options) }
}
