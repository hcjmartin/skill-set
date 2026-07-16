import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { createSetLock, LOCK_SUFFIX, parseSetLock, serializeSetLock, type SetLock } from '../lock.ts'
import { MANIFEST_SUFFIX, parseManifest, type Manifest } from '../manifest.ts'
import { loadLockIfPresent, SETS_DIR, setPaths, writeIndex, writeSetPage } from '../project.ts'
import { parseLocator, reservedMembers, reservedNameError, SKILLS_DIR } from '../resolver.ts'
import { localContentMismatches, removeStagingProject, reportLocalDrift, stageManifestMembers } from '../staging.ts'
import { installSet } from './install.ts'
import { lockSet } from './lock.ts'
import { formatInvocation, plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const ADD_USAGE = 'skill-set add <url|path> [--hash sha256:<hex>]'

/** Spec §3 fetch bounds: at most five redirects, at most 1 MiB of manifest. */
const MAX_REDIRECTS = 5
const MAX_BYTES = 1024 * 1024
const FETCH_TIMEOUT_MS = 30_000

const HEX64 = /^[a-f0-9]{64}$/

/**
 * Renders valid-but-untrusted manifest text as terminal-safe, visibly quoted data.
 * This is deliberately output-only: the fetched manifest remains byte-for-byte unchanged.
 */
function quotedRemoteText(value: string, maxLength?: number): string {
  const singleLine = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0)!
      return !(
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      )
    })
    .join('')
  const characters = [...singleLine]
  const contained =
    maxLength !== undefined && characters.length > maxLength
      ? `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`
      : singleLine
  return JSON.stringify(contained)
}

type VerifiedAgainst = 'sidecar' | 'hash' | 'both'

interface VerificationDetail {
  stagedFallback: boolean
  stagedMembers: string[]
  localMismatches: Array<{ locator: string; skill: string }>
}

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

  // A member naming the reserved skill is refused here, before anything is written or installed;
  // unnamed locators resolving to it are caught (and undone) per-spawn in the resolver.
  const reserved = reservedMembers(manifest.data.skills)
  if (reserved.length > 0) return { ok: false, error: reservedNameError(reserved) }

  // The provenance summary comes before anything is written or installed (spec §3),
  // and before the already-exists refusal so the user sees what was fetched.
  ctx.ui.out(
    `Set ${JSON.stringify(name)} v${manifest.data.version}${manifest.data.description === undefined ? '' : ` — ${quotedRemoteText(manifest.data.description, 128)}`}`,
  )
  if (manifest.data.author !== undefined) {
    ctx.ui.out(ctx.ui.style('dim', `author: ${quotedRemoteText(manifest.data.author.name, 64)}`))
  }
  ctx.ui.out(`${plural(manifest.data.skills.length, 'member skill')}:`)
  for (const locator of manifest.data.skills) {
    const parsed = parseLocator(locator)
    ctx.ui.out(
      `  ${quotedRemoteText(locator)} ${ctx.ui.style('dim', `(source ${quotedRemoteText(parsed.source)}${parsed.ref === undefined ? '' : `, pinned ${quotedRemoteText(parsed.ref)}`})`)}`,
    )
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

  let verified: VerifiedAgainst | null = null
  let detail: { verification: VerificationDetail } | undefined
  if (sidecar.data !== undefined || hash !== undefined) {
    const outcome = await verifyReceipt(ctx, manifest.data, sidecar.data, hash, preFolders)
    if (!outcome.ok) return outcome
    verified = outcome.data.verifiedAgainst
    detail = { verification: outcome.data.detail }
  }

  const lock = loadLockIfPresent(ctx.cwd, name)
  if (!lock.ok) return lock
  writeSetPage(ctx.cwd, manifest.data, lock.data)
  // Only a fetched HTTPS origin is recorded; sets added from a local path carry no source.
  const origin = /^https:\/\//i.test(source) ? { [name]: source } : {}
  const index = writeIndex(ctx.cwd, origin)
  if (!index.ok) return index

  return { ok: true, data: { name, added: true, verified, install: install.data, ...(detail === undefined ? {} : { detail }) } }
}

/**
 * Verifies the installed result first. If pre-existing local skills caused the mismatch, resolve
 * only those members again in staging and verify against that fetched content instead.
 */
async function verifyReceipt(
  ctx: CommandContext,
  manifest: Manifest,
  sidecar: { lock: SetLock; text: string } | undefined,
  hash: string | undefined,
  preFolders: ReadonlySet<string>,
): Promise<Result<{ verifiedAgainst: VerifiedAgainst; detail: VerificationDetail }>> {
  const name = manifest.name
  const members = manifest.skills

  const computed = lockSet(ctx.cwd, name, manifest, { dryRun: true })
  if (!computed.ok) return verificationCouldNotRun(ctx, name, preFolders, computed.error, 'skill content could not be checked')

  let finalLock = computed.data
  let evaluation = evaluateReceipt(manifest, finalLock, sidecar, hash)
  let stagedMembers: string[] = []

  if (evaluation.lines.length > 0) {
    const preExistingLocators = members.filter((locator) => {
      const skill = computed.data.skills[locator]?.skill
      return skill !== undefined && preFolders.has(skill)
    })

    if (preExistingLocators.length > 0) {
      ctx.ui.out(
        ctx.ui.style(
          'dim',
          `${plural(preExistingLocators.length, 'member skill')} already installed; fetching published content to verify this set without changing your installed copies.`,
        ),
      )
      const staged = await stageManifestMembers(manifest, {
        cwd: ctx.cwd,
        runner: ctx.runner,
        extraArgs: ctx.passthrough,
        capture: ctx.ui.json,
        locators: preExistingLocators,
        label: `verify set ${JSON.stringify(name)}`,
        onStage: (_locator, invocation) => {
          ctx.ui.out(ctx.ui.style('dim', `verifying published content: ${formatInvocation(invocation, ctx.passthrough)}`))
        },
      })
      if (!staged.ok) {
        return verificationCouldNotRun(ctx, name, preFolders, staged.error, 'remote skill content could not be fetched for checking')
      }
      try {
        finalLock = mergeStagedMembers(manifest, computed.data, staged.data.lock, preExistingLocators)
        evaluation = evaluateReceipt(manifest, finalLock, sidecar, hash)
        stagedMembers = preExistingLocators
      } finally {
        removeStagingProject(ctx.cwd, staged.data.staging)
      }
    }
  }

  if (evaluation.lines.length > 0) {
    const removed = rollbackAdd(ctx.cwd, name, preFolders)
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.RECEIPT_MISMATCH,
        `${mismatchMessage(sidecar)} ${plural(evaluation.lines.length, 'mismatch')}:\n  - ${evaluation.lines.join('\n  - ')}\nNothing was kept: the set files were removed.`,
        {
          hint: 'The source content may have changed since the share was published. Re-check the link with the set author before retrying.',
          data: { name, verifiedAgainst: evaluation.verifiedAgainst, mismatches: evaluation.mismatches, removedSkills: removed },
        },
      ),
    }
  }

  const localMismatches = stagedMembers.length === 0 ? [] : localContentMismatches(ctx.cwd, manifest, finalLock)
  reportLocalDrift(ctx.ui, localMismatches, {
    source: 'the verified remote content for this set',
    followUp: 'The set lock records the verified remote content. Use verify --frozen to check local on-disk drift.',
  })

  const lockPath = `${SETS_DIR}/${name}/${name}${LOCK_SUFFIX}`
  const paths = setPaths(ctx.cwd, name)
  mkdirSync(paths.dir, { recursive: true })
  if (sidecar !== undefined) {
    // Adopt the author's lock verbatim, like the manifest: the bytes that verified are what land.
    writeFileSync(paths.lock, sidecar.text)
    ctx.ui.out(`${ctx.ui.style('green', '✓')} Verified ${members.length}/${members.length} member skills against the author lock — adopted ${lockPath}`)
  } else {
    writeFileSync(paths.lock, serializeSetLock(finalLock))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} Verified: set hash matches the pinned sha256 — wrote ${lockPath}`)
  }
  return {
    ok: true,
    data: {
      verifiedAgainst: evaluation.verifiedAgainst,
      detail: { stagedFallback: stagedMembers.length > 0, stagedMembers, localMismatches },
    },
  }
}

function evaluateReceipt(
  manifest: Manifest,
  computed: SetLock,
  sidecar: { lock: SetLock; text: string } | undefined,
  hash: string | undefined,
): { verifiedAgainst: VerifiedAgainst; lines: string[]; mismatches: Array<Record<string, unknown>> } {
  const lines: string[] = []
  const mismatches: Array<Record<string, unknown>> = []
  if (sidecar !== undefined) {
    for (const locator of manifest.skills) {
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
    const surplus = Object.keys(sidecar.lock.skills).filter((locator) => !manifest.skills.includes(locator)).length
    if (surplus > 0) {
      lines.push(`the author lock records ${plural(surplus, 'member')} this manifest does not list`)
      mismatches.push({ surplusLockMembers: surplus })
    }
  } else if (computed.setHash !== hash) {
    lines.push(`set hash: expected ${hash!}, computed ${computed.setHash}`)
    mismatches.push({ expected: hash, computed: computed.setHash })
  }

  return {
    verifiedAgainst: sidecar !== undefined ? (hash !== undefined ? 'both' : 'sidecar') : 'hash',
    lines,
    mismatches,
  }
}

function mergeStagedMembers(
  manifest: Manifest,
  base: SetLock,
  staged: SetLock,
  locators: readonly string[],
): SetLock {
  const skills = { ...base.skills }
  for (const locator of locators) {
    const member = staged.skills[locator]
    if (member !== undefined) skills[locator] = member
  }
  return createSetLock(manifest.name, manifest.version, skills)
}

function verificationCouldNotRun(
  ctx: CommandContext,
  name: string,
  preFolders: ReadonlySet<string>,
  cause: SkillSetError,
  reason: string,
): Result<never> {
  const removed = rollbackAdd(ctx.cwd, name, preFolders)
  return {
    ok: false,
    error: new SkillSetError(
      ErrorCodes.RECEIPT_MISMATCH,
      `The skill set ${JSON.stringify(name)} could not be verified — ${reason}.\nNothing was kept: the set files were removed.`,
      {
        hint: 'Fix the remote skill locators and try again.',
        data: { name, cause: { code: cause.code, message: cause.message }, removedSkills: removed },
      },
    ),
  }
}

function mismatchMessage(sidecar: { lock: SetLock; text: string } | undefined): string {
  return sidecar === undefined
    ? 'The skill set did not match the verification hash.'
    : 'The skill set did not match the published lock.'
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
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        return fetchFail(url, `no response within ${FETCH_TIMEOUT_MS / 1000}s`, 'Check the URL and your network, then retry.')
      }
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
    return readCappedBody(url, response)
  }
  return fetchFail(url, `more than ${MAX_REDIRECTS} redirects`)
}

/**
 * Manifests are small; the cap guards against pointing `add` at the wrong thing (spec §3).
 * Enforced while streaming, so an oversized or unbounded body never buffers past the cap.
 */
async function readCappedBody(url: string, response: Response): Promise<Result<string>> {
  const overCap = `response exceeds the ${MAX_BYTES / 1024 / 1024} MiB manifest cap`
  if (Number(response.headers.get('content-length')) > MAX_BYTES) return fetchFail(url, overCap)
  if (response.body === null) return { ok: true, data: '' }
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (received > MAX_BYTES) return fetchFail(url, overCap)
    chunks.push(chunk)
  }
  return { ok: true, data: Buffer.concat(chunks).toString('utf8') }
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
