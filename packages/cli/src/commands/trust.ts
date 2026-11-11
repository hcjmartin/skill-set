import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import {
  isGithubHost,
  loadTrustStore,
  sameSource,
  saveTrustStore,
  sourceScope,
  trustStorePath,
  urlOwner,
  type TrustedSource,
} from '../trust.ts'
import { ALLOWED_HOSTS } from './add.ts'
import { plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const TRUST_USAGE = 'skill-set trust <source> | --list | --remove <source>   (source: manifest URL, host, or host/owner)'

type Scope = Pick<TrustedSource, 'host' | 'owner'>

/**
 * A manifest URL, a bare host, or `host/owner`. The owner scope exists only where the first
 * path segment is an account (GitHub hosts); a URL on any other host is trusted host-wide.
 */
export function parseTrustSource(raw: string): Result<Scope> {
  const fail = (message: string): Result<never> => ({
    ok: false,
    error: new SkillSetError(ErrorCodes.USAGE, message, { hint: `Usage: ${TRUST_USAGE}` }),
  })
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)
  if (scheme !== null && scheme[1]!.toLowerCase() !== 'https') return fail('a trusted source must be an https:// URL, a host, or host/owner')

  let url: URL
  try {
    url = new URL(scheme === null ? `https://${raw}` : raw)
  } catch {
    return fail(`${JSON.stringify(raw)} is not a URL, a host, or host/owner`)
  }
  if (url.host === '' || url.username !== '' || url.password !== '') return fail(`${JSON.stringify(raw)} is not a URL, a host, or host/owner`)

  const host = url.host.toLowerCase()
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (scheme === null) {
    // Shorthand names exactly a scope: anything past host/owner, a query or a fragment is a mistake.
    if (segments.length > 2 || url.search !== '' || url.hash !== '') return fail(`${JSON.stringify(raw)} is not a host or host/owner; pass a full https:// URL for a manifest`)
    if (segments.length > 0 && !isGithubHost(host)) {
      return fail(`an owner scope is only available on GitHub hosts; trust ${JSON.stringify(host)} as a whole host instead`)
    }
    if (segments.length === 2) return fail(`${JSON.stringify(raw)} is not a host or host/owner; pass a full https:// URL for a manifest`)
  }
  const owner = isGithubHost(host) ? urlOwner(url) : undefined
  return { ok: true, data: { host, ...(owner === undefined ? {} : { owner }) } }
}

export async function cmdTrust(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, ['--list'], TRUST_USAGE, ['--remove'])
  if (!split.ok) return split
  const { flags, values, positionals } = split.data
  const list = flags.has('--list')
  const removing = values.get('--remove')
  const [adding, ...extra] = positionals
  const modes = Number(list) + Number(removing !== undefined) + Number(adding !== undefined)
  if (modes !== 1 || extra.length > 0) return usageError('trust takes exactly one of: a source to add, --list, or --remove <source>', TRUST_USAGE)

  const path = trustStorePath()
  const loaded = loadTrustStore(path)
  if (!loaded.ok) return loaded
  const store = loaded.data

  if (list) {
    for (const host of ALLOWED_HOSTS) ctx.ui.out(`${host} ${ctx.ui.style('dim', '(built-in)')}`)
    for (const entry of store.sources) ctx.ui.out(`${sourceScope(entry)} ${ctx.ui.style('dim', `(added ${entry.addedAt})`)}`)
    ctx.ui.out(ctx.ui.style('dim', `${plural(store.sources.length, 'trusted source')} in ${path}`))
    return {
      ok: true,
      data: { sources: [...ALLOWED_HOSTS.map((host) => ({ host, builtIn: true })), ...store.sources], path },
    }
  }

  const parsed = parseTrustSource((removing ?? adding)!)
  if (!parsed.ok) return parsed
  const scope = parsed.data
  const label = JSON.stringify(sourceScope(scope))
  const builtIn = scope.owner === undefined && ALLOWED_HOSTS.includes(scope.host)
  const existing = store.sources.find((entry) => sameSource(entry, scope))
  const dry = ctx.dryRun ? { dryRun: true } : {}

  if (removing !== undefined) {
    if (builtIn) return usageError(`${label} is a built-in skill-set provider and cannot be removed`, TRUST_USAGE)
    if (existing === undefined) {
      ctx.ui.out(`${label} is not a trusted source — nothing removed`)
      return { ok: true, data: { removed: null, path, ...dry } }
    }
    if (!ctx.dryRun) {
      const saved = saveTrustStore({ ...store, sources: store.sources.filter((entry) => entry !== existing) }, path)
      if (!saved.ok) return saved
    }
    ctx.ui.out(ctx.dryRun ? ctx.ui.style('dim', `would remove: ${label} from ${path}`) : `${ctx.ui.style('green', '✓')} No longer trusting ${label}`)
    return { ok: true, data: { removed: existing, path, ...dry } }
  }

  if (builtIn) {
    ctx.ui.out(`${label} is a built-in skill-set provider — already trusted`)
    return { ok: true, data: { added: null, existing: { host: scope.host, builtIn: true }, path, ...dry } }
  }
  if (existing !== undefined) {
    ctx.ui.out(`${label} is already a trusted source (added ${existing.addedAt})`)
    return { ok: true, data: { added: null, existing, path, ...dry } }
  }
  const entry: TrustedSource = { ...scope, addedAt: new Date().toISOString() }
  if (!ctx.dryRun) {
    const saved = saveTrustStore({ ...store, sources: [...store.sources, entry] }, path)
    if (!saved.ok) return saved
  }
  ctx.ui.out(
    ctx.dryRun
      ? ctx.ui.style('dim', `would trust: ${label} in ${path}`)
      : `${ctx.ui.style('green', '✓')} Trusting ${label} — add fetches manifests from it without asking`,
  )
  if (scope.owner === undefined && isGithubHost(scope.host)) {
    ctx.ui.warn(`${label} is trusted as a whole host: every account on it. Use ${scope.host}/<owner> to trust one account.`)
  }
  return { ok: true, data: { added: entry, path, ...dry } }
}
