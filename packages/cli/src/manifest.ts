import { basename } from 'node:path'
import * as z from 'zod'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { parseStrictJson } from './json.ts'

export const MANIFEST_SUFFIX = '.skill-set.json'
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
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    return fail(ErrorCodes.INVALID_MANIFEST, `${context} does not match the skill-set schema:\n  - ${issues.join('\n  - ')}`, {
      hint: 'The schema is served at https://skill-set.md/schema/draft/skill-set.schema.json.',
      data: parsed.error.issues,
    })
  }
  const manifest = parsed.data

  const seen = new Set<string>()
  for (const locator of manifest.skills) {
    if (seen.has(locator)) {
      return fail(ErrorCodes.DUPLICATE_MEMBER, `${context} lists member ${JSON.stringify(locator)} more than once`, {
        hint: 'Duplicate skills[] entries are invalid (spec §2.4) — remove the repeated locator.',
        data: { locator },
      })
    }
    seen.add(locator)
  }

  if (manifest.$schema !== undefined) {
    const segment = /\/schema\/(draft|v\d+)\//.exec(manifest.$schema)?.[1]
    if (segment === undefined || !SUPPORTED_SCHEMA_VERSIONS.has(segment)) {
      return fail(
        ErrorCodes.SCHEMA_VERSION,
        `${context} declares schema version ${segment ?? JSON.stringify(manifest.$schema)}, which this implementation does not support`,
        {
          hint: `Supported versions: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}. Consumers must reject unknown versions rather than best-effort parse (spec §2.5).`,
          data: { $schema: manifest.$schema },
        },
      )
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
