import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { LOCK_SUFFIX, parseSetLock, serializeSetLock, type SetLock } from '../lock.ts'
import { MANIFEST_SUFFIX, parseManifest, type Manifest } from '../manifest.ts'
import { loadLockIfPresent, SETS_DIR, setPaths, writeIndex, writeSetPage } from '../project.ts'
import { parseLocator, SKILLS_DIR } from '../resolver.ts'
import { localContentMismatches, stageManifestMembers } from '../staging.ts'
import { installSet } from './install.ts'
import { formatInvocation, plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const ADD_USAGE = 'skill-set add <url|path> [--hash sha256:<hex>]'

/** Spec §3 fetch bounds: at most five redirects, at most 1 MiB of manifest. */
const MAX_REDIRECTS = 5
const MAX_BYTES = 1024 * 1024

const HEX64 = /^[a-f0-9]{64}$/

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
  const split = splitFlags(args, [], ADD_USAGE, ['--hash'])
  if (!split.ok) return split
  const [rawSource, ...extra] = split.data.positionals
  if (rawSource === undefined || extra.length > 0) return usageError('add takes exactly one manifest URL or path', ADD_USAGE)

  // The pinned hash comes from --hash and/or a #sha256= URL fragment; the fragment is a
  // trust anchor, not part of the location, so it is stripped before any fetch or record.
  const pin = resolvePinnedHash(rawSource, split.data.values.get('--hash'))
  if (!pin.ok) return pin
  const { source, hash } = pin.data

  ctx.ui.out(`Adding skill-set from ${source}...`)
  if (hash !== undefined) ctx.ui.out(ctx.ui.style('dim', 'content will be verified against the provided sha256 hash'))

  // Unrecognised hosts are confirmed before any bytes are fetched; a declined or
  // unanswerable prompt aborts with nothing fetched.
  const host = httpsHost(source)
  if (host !== undefined && !isAllowedHost(host)) {
    const proceed = await ctx.ui.confirm(`${JSON.stringify(host)} is not a recognised skill-set provider. Fetch from it anyway?`)
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

  // Where the author's set-lock would sit: the manifest location with its suffix swapped,
  // mirroring the on-disk sidecar naming — same host, so no second host confirmation.
  const sidecarAt = source.endsWith(MANIFEST_SUFFIX)
    ? `${source.slice(0, -MANIFEST_SUFFIX.length)}${LOCK_SUFFIX}`
    : undefined

  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would write: ${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX}`))
    ctx.ui.out(ctx.ui.style('dim', `would install: ${manifest.data.skills.join(', ')}`))
    if (hash !== undefined) ctx.ui.out(ctx.ui.style('dim', `would verify: set hash against sha256:${hash}`))
    if (sidecarAt !== undefined) ctx.ui.out(ctx.ui.style('dim', `would verify: remote content against the author lock at ${sidecarAt}, if published`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed, no skills installed`)
    return {
      ok: true,
      data: {
        name,
        dryRun: true,
        wouldInstall: manifest.data.skills,
        ...(hash === undefined && sidecarAt === undefined
          ? {}
          : { wouldVerify: { ...(hash === undefined ? {} : { hash }), ...(sidecarAt === undefined ? {} : { authorLock: sidecarAt }) } }),
      },
    }
  }

  const sidecar = await loadSidecar(sidecarAt, name, ctx)
  if (!sidecar.ok) return sidecar
  if (sidecarAt !== undefined) {
    ctx.ui.out(
      ctx.ui.style(
        'dim',
        sidecar.data === undefined
          ? 'no author lock published for this set'
          : 'author lock found — remote content will be verified against it',
      ),
    )
  }

  // A published lock that disagrees with the out-of-band hash is itself suspect: refuse it
  // before trusting its per-member values, and before anything is installed or written.
  if (sidecar.data !== undefined && hash !== undefined) {
    if (sidecar.data.lock.setHash !== hash) {
      return {
        ok: false,
        error: new SkillSetError(
          ErrorCodes.RECEIPT_MISMATCH,
          `The published lock for ${JSON.stringify(name)} does not match the provided hash — the lock records set hash ${sidecar.data.lock.setHash}, but sha256:${hash} was provided. Nothing was installed, no files changed.`,
          {
            hint: 'Re-check the share link and the pinned hash with the set author.',
            data: { name, verifiedAgainst: 'both', pinned: hash, lockSetHash: sidecar.data.lock.setHash },
          },
        ),
      }
    }
    ctx.ui.out(ctx.ui.style('dim', 'author lock matches the pinned sha256 hash'))
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

  // Snapshot for verify-then-rollback: a rollback removes only folders absent here.
  const preFolders = listSkillFolders(ctx.cwd)

  const install = await installSet(ctx, name)
  if (!install.ok) return install

  let verified: 'sidecar' | 'hash' | 'both' | null = null
  if (sidecar.data !== undefined || hash !== undefined) {
    const outcome = await verifyReceipt(ctx, manifest.data, sidecar.data, hash, preFolders)
    if (!outcome.ok) return outcome
    verified = outcome.data
  }

  const lock = loadLockIfPresent(ctx.cwd, name)
  if (!lock.ok) return lock
  writeSetPage(ctx.cwd, manifest.data, lock.data)
  // Only a fetched HTTPS origin is recorded; sets added from a local path carry no source.
  const origin = /^https:\/\//i.test(source) ? { [name]: source } : {}
  const index = writeIndex(ctx.cwd, origin)
  if (!index.ok) return index

  return { ok: true, data: { name, added: true, verified, install: install.data } }
}

/**
 * Receipt verification: resolve every member again in a clean staging project, compare that
 * remote-delivered content against the author lock and/or pinned rollup, and either adopt/write
 * the set-lock or roll this add back entirely. Returns which trust source verified.
 */
async function verifyReceipt(
  ctx: CommandContext,
  manifest: Manifest,
  sidecar: { lock: SetLock; text: string } | undefined,
  hash: string | undefined,
  preFolders: ReadonlySet<string>,
): Promise<Result<'sidecar' | 'hash' | 'both'>> {
  const name = manifest.name
  const members = manifest.skills
  const staged = await stageManifestMembers(manifest, {
    cwd: ctx.cwd,
    runner: ctx.runner,
    extraArgs: ctx.passthrough,
    capture: ctx.ui.json,
    label: `verify receipt for set ${JSON.stringify(name)}`,
    onStage: (_locator, invocation) => {
      ctx.ui.out(ctx.ui.style('dim', `verifying remote content: ${formatInvocation(invocation, ctx.passthrough)}`))
    },
  })
  if (!staged.ok) {
    // Verification was promised but cannot run — keep nothing rather than keep unverified content.
    rollbackAdd(ctx.cwd, name, preFolders)
    return staged
  }
  const computed = staged.data.lock

  try {
    const lines: string[] = []
    const mismatches: Array<Record<string, unknown>> = []
    if (sidecar !== undefined) {
      for (const locator of members) {
        const actual = computed.skills[locator]!
        const expected = sidecar.lock.skills[locator]
        if (expected === undefined) {
          lines.push(`${locator} (skill ${actual.skill}): not recorded in the author lock`)
          mismatches.push({ locator, skill: actual.skill, computed: actual.computedHash })
        } else if (expected.computedHash !== actual.computedHash) {
          lines.push(`${locator} (skill ${actual.skill}): expected ${expected.computedHash}, computed ${actual.computedHash}`)
          mismatches.push({ locator, skill: actual.skill, expected: expected.computedHash, computed: actual.computedHash })
        }
      }
      // Locator keys in the author lock are remote content — surplus entries are counted, not echoed.
      const surplus = Object.keys(sidecar.lock.skills).filter((locator) => !members.includes(locator)).length
      if (surplus > 0) {
        lines.push(`the author lock records ${plural(surplus, 'member')} this manifest does not list`)
        mismatches.push({ surplusLockMembers: surplus })
      }
    } else if (computed.setHash !== hash) {
      lines.push(`set hash: expected ${hash!}, computed ${computed.setHash}`)
      mismatches.push({ expected: hash, computed: computed.setHash })
    }

    const verifiedAgainst = sidecar !== undefined ? (hash !== undefined ? 'both' : 'sidecar') : 'hash'
    if (lines.length > 0) {
      const removed = rollbackAdd(ctx.cwd, name, preFolders)
      return {
        ok: false,
        error: new SkillSetError(
          ErrorCodes.RECEIPT_MISMATCH,
          `Remote content for set ${JSON.stringify(name)} does not match what the share promised — ${plural(lines.length, 'mismatch')}:\n  - ${lines.join('\n  - ')}\nNothing was kept: the set's files and the ${plural(removed.length, 'skill folder')} this add installed were removed.`,
          {
            hint: 'The source content may have changed since the share was published. Re-check the link with the set author before retrying.',
            data: { name, verifiedAgainst, mismatches, removedSkills: removed },
          },
        ),
      }
    }

    const localMismatches = localContentMismatches(ctx.cwd, manifest, computed)
    if (localMismatches.length > 0) {
      ctx.ui.out(
        ctx.ui.style(
          'yellow',
          `Notice: ${plural(localMismatches.length, 'installed local skill')} ${localMismatches.length === 1 ? 'differs' : 'differ'} from the verified remote content for this set:`,
        ),
      )
      for (const mismatch of localMismatches) ctx.ui.out(`  - ${mismatch.locator} (skill ${mismatch.skill})`)
      ctx.ui.out(ctx.ui.style('dim', 'The set lock records the verified remote content. Use verify --frozen to check local on-disk drift.'))
    }

    const lockPath = `${SETS_DIR}/${name}/${name}${LOCK_SUFFIX}`
    if (sidecar !== undefined) {
      // Adopt the author's lock verbatim, like the manifest: the bytes that verified are what land.
      writeFileSync(setPaths(ctx.cwd, name).lock, sidecar.text)
      ctx.ui.out(`${ctx.ui.style('green', '✓')} Verified ${members.length}/${members.length} member skills against the author lock — adopted ${lockPath}`)
    } else {
      writeFileSync(setPaths(ctx.cwd, name).lock, serializeSetLock(computed))
      ctx.ui.out(`${ctx.ui.style('green', '✓')} Verified: set hash matches the pinned sha256 — wrote ${lockPath}`)
    }
    return { ok: true, data: verifiedAgainst }
  } finally {
    rmSync(staged.data.staging, { recursive: true, force: true })
  }
}

/**
 * Undoes this add invocation: skill folders that did not pre-exist, their skills-lock.json
 * entries, and the set's own files. Direct file operations on purpose — a rollback must not
 * depend on a network-fetched CLI succeeding. Returns the removed skill folder names.
 */
function rollbackAdd(cwd: string, name: string, preFolders: ReadonlySet<string>): string[] {
  const removed: string[] = []
  for (const folder of listSkillFolders(cwd)) {
    if (preFolders.has(folder)) continue
    rmSync(join(cwd, SKILLS_DIR, folder), { recursive: true, force: true })
    removed.push(folder)
  }
  removed.sort()
  dropSkillsLockEntries(cwd, removed)
  const paths = setPaths(cwd, name)
  rmSync(paths.manifest, { force: true })
  rmSync(paths.lock, { force: true })
  rmSync(paths.page, { force: true })
  if (existsSync(paths.dir) && readdirSync(paths.dir).length === 0) rmSync(paths.dir, { recursive: true, force: true })
  writeIndex(cwd)
  return removed
}

/** Installed skill folder names; the sets directory lives inside the skills dir and is never a skill. */
function listSkillFolders(cwd: string): Set<string> {
  const root = join(cwd, SKILLS_DIR)
  if (!existsSync(root)) return new Set()
  const setsFolder = SETS_DIR.slice(SKILLS_DIR.length + 1)
  return new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== setsFolder)
      .map((d) => d.name),
  )
}

/** Drops rolled-back skills from the upstream lock so it stays consistent with the folders. */
function dropSkillsLockEntries(cwd: string, skills: readonly string[]): void {
  if (skills.length === 0) return
  const path = join(cwd, 'skills-lock.json')
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { skills?: Record<string, unknown> }
    if (typeof raw.skills !== 'object' || raw.skills === null) return
    for (const skill of skills) delete raw.skills[skill]
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
  } catch {
    // An unreadable upstream lock is left as found; the folders themselves are already gone.
  }
}

/** The author's set-lock at its derived location, or undefined when none is published there. */
async function loadSidecar(
  location: string | undefined,
  name: string,
  ctx: CommandContext,
): Promise<Result<{ lock: SetLock; text: string } | undefined>> {
  if (location === undefined) return { ok: true, data: undefined }
  let text: string | undefined
  if (/^https:\/\//i.test(location)) {
    const fetched = await (ctx.fetcher ?? fetchManifest)(location)
    text = fetched.ok ? fetched.data : undefined
  } else if (existsSync(location)) {
    text = readFileSync(location, 'utf8')
  }
  if (text === undefined) return { ok: true, data: undefined }
  // Attacker-controlled remote bytes: parsed strictly, errors stay structural, and the
  // filename check pins the lock's declared name to the manifest's.
  const parsed = parseSetLock(text, { filename: `${name}${LOCK_SUFFIX}` })
  if (!parsed.ok) return parsed
  return { ok: true, data: { lock: parsed.data, text } }
}

/** Splits the pinned hash out of --hash and/or a URL fragment; both given must agree. */
function resolvePinnedHash(rawSource: string, flag: string | undefined): Result<{ source: string; hash: string | undefined }> {
  let source = rawSource
  let fragment: string | undefined
  if (/^https:\/\//i.test(rawSource)) {
    const at = rawSource.indexOf('#')
    if (at !== -1) {
      const parsed = parsePin(rawSource.slice(at + 1), '=', 'the URL fragment')
      if (!parsed.ok) return parsed
      fragment = parsed.data
      source = rawSource.slice(0, at)
    }
  }
  let flagged: string | undefined
  if (flag !== undefined) {
    const parsed = parsePin(flag, ':', '--hash')
    if (!parsed.ok) return parsed
    flagged = parsed.data
  }
  if (flagged !== undefined && fragment !== undefined && flagged !== fragment) {
    return pinUsage("the provided --hash value and the URL's embedded hash do not match")
  }
  return { ok: true, data: { source, hash: flagged ?? fragment } }
}

/** `sha256<sep><64-hex>` with a mandatory algorithm prefix; anything else is a usage mistake. */
function parsePin(value: string, sep: ':' | '=', label: string): Result<string> {
  const at = value.indexOf(sep)
  if (at === -1 || value.slice(0, at) !== 'sha256') {
    return pinUsage(`${label} must name its hash algorithm as sha256, e.g. sha256${sep}<64-hex>`)
  }
  const hex = value.slice(at + 1)
  if (!HEX64.test(hex)) {
    return pinUsage(`${label} must carry a 64-character lowercase hex sha256 digest after "sha256${sep}"`)
  }
  return { ok: true, data: hex }
}

function pinUsage(message: string): Result<never> {
  return { ok: false, error: new SkillSetError(ErrorCodes.USAGE, message, { hint: `Usage: ${ADD_USAGE}` }) }
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
