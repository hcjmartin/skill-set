import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import * as z from 'zod'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { structuralIssues } from './zod-issues.ts'

export const TRUST_STORE_FILENAME = 'trusted-sources.json'
export const TRUST_STORE_VERSION = 1
/** Overrides the directory holding the trust store. */
export const CONFIG_DIR_ENV = 'SKILL_SET_CONFIG_DIR'

/** Hosts whose first path segment is the owning account. */
export const GITHUB_HOSTS: readonly string[] = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com']

const sourceSchema = z.strictObject({
  host: z.string().min(1),
  owner: z.string().min(1).optional(),
  addedAt: z.string().min(1),
})

const storeSchema = z.strictObject({
  version: z.literal(TRUST_STORE_VERSION),
  sources: z.array(sourceSchema),
})

export type TrustedSource = z.infer<typeof sourceSchema>
export type TrustStore = z.infer<typeof storeSchema>

export function emptyTrustStore(): TrustStore {
  return { version: TRUST_STORE_VERSION, sources: [] }
}

/** `$SKILL_SET_CONFIG_DIR`, else `$XDG_CONFIG_HOME/skill-set`, else `~/.config/skill-set` — on every platform. */
export function trustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_DIR_ENV]
  if (override !== undefined && override !== '') return join(override, TRUST_STORE_FILENAME)
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config')
  return join(base, 'skill-set', TRUST_STORE_FILENAME)
}

/** A missing file is an empty store; a malformed one fails and is left untouched. */
export function loadTrustStore(path: string = trustStorePath()): Result<TrustStore> {
  if (!existsSync(path)) return { ok: true, data: emptyTrustStore() }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    return invalid(path, 'it could not be read as JSON', { cause })
  }
  const parsed = storeSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = structuralIssues(parsed.error.issues)
    return invalid(path, `\n  - ${issues.lines.join('\n  - ')}`, { data: issues.data })
  }
  return { ok: true, data: parsed.data }
}

function invalid(path: string, detail: string, extra: { cause?: unknown; data?: unknown }): Result<never> {
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.INVALID_TRUST_STORE, `The trusted sources file at ${path} is not valid: ${detail}`, {
      hint: 'Fix or delete the file, then re-add entries with "skill-set trust <source>". The file was left untouched.',
      data: { path, ...(extra.data === undefined ? {} : { issues: extra.data }) },
      ...(extra.cause === undefined ? {} : { cause: extra.cause }),
    }),
  }
}

/** Atomic: written beside the target, then renamed over it. */
export function saveTrustStore(store: TrustStore, path: string = trustStorePath()): Result<string> {
  const temp = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`)
    renameSync(temp, path)
  } catch (cause) {
    rmSync(temp, { force: true })
    return {
      ok: false,
      error: new SkillSetError(ErrorCodes.UNEXPECTED, `Could not write the trusted sources file at ${path}: ${(cause as Error).message}`, {
        cause,
        data: { path },
      }),
    }
  }
  return { ok: true, data: path }
}

export function isGithubHost(host: string): boolean {
  return GITHUB_HOSTS.includes(host.toLowerCase())
}

/** First non-empty path segment: the owning account on a GitHub host. */
export function urlOwner(url: URL): string | undefined {
  return url.pathname.split('/').find((segment) => segment !== '')
}

/** `host` or `host/owner`, as reported in `trust.scope` and printed by `skill-set trust`. */
export function sourceScope(source: Pick<TrustedSource, 'host' | 'owner'>): string {
  return source.owner === undefined ? source.host : `${source.host}/${source.owner}`
}

export function sameSource(a: Pick<TrustedSource, 'host' | 'owner'>, b: Pick<TrustedSource, 'host' | 'owner'>): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.owner?.toLowerCase() === b.owner?.toLowerCase()
}

/**
 * The store entry that trusts an https URL, if any. Hosts compare exactly (port included) and
 * case-insensitively. An entry with an owner applies only on a GitHub host, to URLs whose
 * first path segment is that owner; on any other host it matches nothing.
 */
export function findTrustedSource(url: string, store: TrustStore): TrustedSource | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  const host = parsed.host.toLowerCase()
  const owner = urlOwner(parsed)?.toLowerCase()
  return store.sources.find((entry) => {
    if (entry.host.toLowerCase() !== host) return false
    if (entry.owner === undefined) return true
    return isGithubHost(host) && owner !== undefined && entry.owner.toLowerCase() === owner
  })
}

export function isTrustedSource(url: string, store: TrustStore): boolean {
  return findTrustedSource(url, store) !== undefined
}
