import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { MANIFEST_SUFFIX, parseManifest } from '../manifest.ts'
import { loadLockIfPresent, SETS_DIR, setPaths, writeIndex, writeSetPage } from '../project.ts'
import { parseLocator } from '../resolver.ts'
import { installSet } from './install.ts'
import { plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const ADD_USAGE = 'skill-set add <url|path>'

/** Spec §3 fetch bounds: at most five redirects, at most 1 MiB of manifest. */
const MAX_REDIRECTS = 5
const MAX_BYTES = 1024 * 1024

/**
 * Hosts that serve skill-set manifests without a pre-fetch warning. Any other host prompts
 * for confirmation before `add` reaches out (an agent may be running unattended). Amend here.
 */
export const ALLOWED_HOSTS: readonly string[] = ['skill-set.md', 'skill-sets.md']

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.includes(host)
}

/** Host of an https URL, or undefined for non-https / unparseable sources (local paths). */
function httpsHost(source: string): string | undefined {
  if (!/^https:\/\//i.test(source)) return undefined
  try {
    return new URL(source).host
  } catch {
    return undefined
  }
}

export async function cmdAdd(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], ADD_USAGE)
  if (!split.ok) return split
  const [source, ...extra] = split.data.positionals
  if (source === undefined || extra.length > 0) return usageError('add takes exactly one manifest URL or path', ADD_USAGE)

  ctx.ui.out(`Adding skill-set from ${source}...`)

  // Unrecognised hosts are confirmed before any bytes are fetched; a declined or
  // unanswerable prompt aborts with nothing fetched.
  const host = httpsHost(source)
  if (host !== undefined && !isAllowedHost(host)) {
    const proceed = await ctx.ui.confirm(`${JSON.stringify(host)} is not a recognised skill-set host. Fetch from it anyway?`)
    if (!proceed.ok) return proceed
    if (!proceed.data) {
      ctx.ui.out('Aborted — nothing fetched.')
      return { ok: true, data: { added: false } }
    }
  }

  const text = await readManifestSource(source, ctx)
  if (!text.ok) return text

  const manifest = parseManifest(text.data)
  if (!manifest.ok) return manifest
  const name = manifest.data.name

  // The provenance summary comes before anything is written or installed (spec §3),
  // and before the already-exists refusal so the user sees what was fetched.
  ctx.ui.out(`Set ${JSON.stringify(name)} v${manifest.data.version}${manifest.data.description === undefined ? '' : ` — ${manifest.data.description}`}`)
  if (manifest.data.author !== undefined) ctx.ui.out(ctx.ui.style('dim', `author: ${manifest.data.author.name}`))
  ctx.ui.out(`${plural(manifest.data.skills.length, 'member skill')}:`)
  for (const locator of manifest.data.skills) {
    const parsed = parseLocator(locator)
    ctx.ui.out(`  ${locator} ${ctx.ui.style('dim', `(source ${parsed.source}${parsed.ref === undefined ? '' : `, pinned ${parsed.ref}`})`)}`)
  }

  const paths = setPaths(ctx.cwd, name)
  if (existsSync(paths.manifest)) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.SET_EXISTS,
        `A set named ${JSON.stringify(name)} already exists at ${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX}`,
        {
          hint: `Remove with "skill-set remove ${name}", or install the existing set with "skill-set install ${name}".`,
          data: { name },
        },
      ),
    }
  }

  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would write: ${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX}`))
    ctx.ui.out(ctx.ui.style('dim', `would install: ${manifest.data.skills.join(', ')}`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed, no skills installed`)
    return { ok: true, data: { name, dryRun: true, wouldInstall: manifest.data.skills } }
  }

  const confirmed = await ctx.ui.confirm(`Add ${JSON.stringify(name)} and install skills?`)
  if (!confirmed.ok) return confirmed
  if (!confirmed.data) {
    ctx.ui.out('Aborted — nothing written.')
    return { ok: true, data: { name, added: false } }
  }

  // Written verbatim: the fetched bytes are what validated, so they are what lands (spec §3).
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.manifest, text.data)
  ctx.ui.out(`${ctx.ui.style('green', '✓')} Wrote ${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX}`)

  const install = await installSet(ctx, name)
  if (!install.ok) return install

  const lock = loadLockIfPresent(ctx.cwd, name)
  if (!lock.ok) return lock
  writeSetPage(ctx.cwd, manifest.data, lock.data)
  // Only a fetched HTTPS origin is recorded; sets added from a local path carry no source.
  const origin = /^https:\/\//i.test(source) ? { [name]: source } : {}
  const index = writeIndex(ctx.cwd, origin)
  if (!index.ok) return index

  return { ok: true, data: { name, added: true, install: install.data } }
}

async function readManifestSource(source: string, ctx: CommandContext): Promise<Result<string>> {
  if (/^https:\/\//i.test(source)) return (ctx.fetcher ?? fetchManifest)(source)
  if (/^http:\/\//i.test(source)) {
    return fetchFail(source, 'manifests are fetched over HTTPS only', 'Serve the manifest at an https:// URL.')
  }
  if (!existsSync(source)) {
    return fetchFail(source, 'no such file', 'Pass an https:// URL or a local path to a .skill-set.json file.')
  }
  return { ok: true, data: readFileSync(source, 'utf8') }
}

export async function fetchManifest(url: string): Promise<Result<string>> {
  // The initial host was already accepted by the command (allowlisted or confirmed); the
  // redirect follower keeps requests on that host or an allowlisted one, never a new host.
  const initialHost = httpsHost(url)
  let current = url
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let response: Response
    try {
      response = await fetch(current, { redirect: 'manual' })
    } catch (cause) {
      return fetchFail(url, (cause as Error).message, 'Check the URL and your network, then retry.')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location === null) return fetchFail(url, `redirect (${response.status}) without a location header`)
      current = new URL(location, current).toString()
      if (!current.startsWith('https://')) return fetchFail(url, 'redirected to a non-HTTPS location')
      const nextHost = new URL(current).host
      if (!isAllowedHost(nextHost) && nextHost !== initialHost) {
        return fetchFail(url, `redirected to unrecognised host ${nextHost}`, 'Redirects must stay on the original or a recognised skill-set host.')
      }
      continue
    }
    if (!response.ok) return fetchFail(url, `GET returned ${response.status}`)
    // Manifests are small; the cap guards against pointing `add` at the wrong thing (spec §3).
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
      return fetchFail(url, `response exceeds the ${MAX_BYTES / 1024 / 1024} MiB manifest cap`)
    }
    return { ok: true, data: text }
  }
  return fetchFail(url, `more than ${MAX_REDIRECTS} redirects`)
}

function fetchFail(url: string, reason: string, hint?: string): Result<never> {
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.FETCH_FAILED, `Could not read manifest from ${url}: ${reason}`, {
      ...(hint === undefined ? {} : { hint }),
      data: { url, reason },
    }),
  }
}
