import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from '../errors.ts'
import { createSetLock, LOCK_SUFFIX, serializeSetLock, type SetLockMember } from '../lock.ts'
import { MANIFEST_SUFFIX, parseManifest, type Manifest } from '../manifest.ts'
import { SETS_DIR, setPaths } from '../project.ts'
import { buildAddInvocation, parseLocator, resolveMember } from '../resolver.ts'
import { formatInvocation, plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const SHARE_USAGE = 'skill-set share [<set>] [--manifest <path>] [--output <dir>]'

const SHARE_DIR = `${SETS_DIR}/_share`

type ShareInput =
  | { kind: 'set'; name: string; path: string; manifest: Manifest }
  | { kind: 'manifest'; path: string; manifest: Manifest }

export async function cmdShare(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], SHARE_USAGE, ['--manifest', '--output'])
  if (!split.ok) return split
  const { positionals, values } = split.data
  if (positionals.length > 1) return usageError('share takes at most one set name', SHARE_USAGE)
  if (positionals.length === 1 && values.has('--manifest')) {
    return usageError('share takes either a set name or --manifest, not both', SHARE_USAGE)
  }

  const input = await resolveInput(ctx, positionals[0], values.get('--manifest'))
  if (!input.ok) return input
  let manifest = input.data.manifest
  const name = manifest.name

  const output = await resolveOutput(ctx, name, values.get('--output'))
  if (!output.ok) return output

  ctx.ui.out(`Preparing shareable skill-set ${JSON.stringify(name)}...`)
  ctx.ui.out(ctx.ui.style('dim', `source manifest: ${displayPath(ctx.cwd, input.data.path)}`))
  ctx.ui.out(ctx.ui.style('dim', `share output: ${displayPath(ctx.cwd, output.data)}`))

  const enriched = await promptForOptionalMetadata(ctx, manifest)
  if (!enriched.ok) return enriched
  manifest = enriched.data

  const unshareable = findUnshareableMembers(ctx.cwd, manifest)
  if (unshareable.length > 0) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.UNSHAREABLE_MEMBERS,
        `Cannot share ${JSON.stringify(name)} — ${plural(unshareable.length, 'member skill')} use local-only or non-portable sources:\n  - ${unshareable.map((m) => `${m.locator}: ${m.reason}`).join('\n  - ')}`,
        {
          hint: `Create the set with remote skill locators, e.g. "skill-set init ${name} <remote-skill-targets>", then run "skill-set share ${name}" again.`,
          data: { name, members: unshareable },
        },
      ),
    }
  }

  if (ctx.dryRun) {
    for (const locator of manifest.skills) {
      ctx.ui.out(ctx.ui.style('dim', `would stage: ${formatInvocation(buildAddInvocation(locator), ctx.passthrough)}`))
    }
    ctx.ui.out(ctx.ui.style('dim', `would write: ${displayPath(ctx.cwd, join(output.data, `${name}${MANIFEST_SUFFIX}`))}`))
    ctx.ui.out(ctx.ui.style('dim', `would write: ${displayPath(ctx.cwd, join(output.data, `${name}${LOCK_SUFFIX}`))}`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed, no skills installed`)
    return { ok: true, data: { name, dryRun: true, output: displayPath(ctx.cwd, output.data), members: manifest.skills.length } }
  }

  const staged = await stageAndLock(ctx, name, manifest)
  if (!staged.ok) return staged

  mkdirSync(output.data, { recursive: true })
  const manifestPath = join(output.data, `${name}${MANIFEST_SUFFIX}`)
  const lockPath = join(output.data, `${name}${LOCK_SUFFIX}`)
  writeFileSync(manifestPath, serializeManifest(manifest))
  writeFileSync(lockPath, serializeSetLock(staged.data))

  ctx.ui.out(
    `${ctx.ui.style('green', '✓')} Created shareable skill-set at ${displayPath(ctx.cwd, output.data)} (${plural(manifest.skills.length, 'skill')})`,
  )
  ctx.ui.out(ctx.ui.style('dim', 'The lock was generated from remote delivered skill content, not local skill folders.'))
  ctx.ui.out(ctx.ui.style('dim', 'Publish the manifest and lock together so add can verify the sidecar lock.'))

  return {
    ok: true,
    data: {
      name,
      output: displayPath(ctx.cwd, output.data),
      manifest: displayPath(ctx.cwd, manifestPath),
      lock: displayPath(ctx.cwd, lockPath),
      setHash: staged.data.setHash,
      members: manifest.skills.length,
    },
  }
}

async function resolveInput(ctx: CommandContext, setName: string | undefined, manifestPath: string | undefined): Promise<Result<ShareInput>> {
  let name = setName
  let path = manifestPath
  if (name === undefined && path === undefined) {
    const answer = await ctx.ui.prompt('Set name or manifest path to share')
    if (!answer.ok) return answer
    const value = answer.data?.trim()
    if (value === undefined || value === '') {
      return {
        ok: false,
        error: new SkillSetError(ErrorCodes.USAGE, 'share needs a set name or --manifest path', {
          hint: `Usage: ${SHARE_USAGE}`,
        }),
      }
    }
    if (looksLikeManifestPath(ctx.cwd, value)) path = value
    else name = value
  }

  if (path !== undefined) {
    path = absoluteFrom(ctx.cwd, path)
    if (!existsSync(path)) {
      return {
        ok: false,
        error: new SkillSetError(ErrorCodes.SET_NOT_FOUND, `Manifest file not found at ${displayPath(ctx.cwd, path)}`, {
          hint: 'Pass an existing manifest path, or share a local set by name.',
          data: { manifest: path },
        }),
      }
    }
    const parsed = parseManifest(readFileSync(path, 'utf8'))
    if (!parsed.ok) return parsed
    return { ok: true, data: { kind: 'manifest', path, manifest: parsed.data } }
  }

  const paths = setPaths(ctx.cwd, name!)
  const loaded = parseLocalSetManifest(ctx.cwd, name!)
  if (!loaded.ok) return loaded
  return { ok: true, data: { kind: 'set', name: name!, path: paths.manifest, manifest: loaded.data } }
}

function parseLocalSetManifest(cwd: string, name: string): Result<Manifest> {
  const paths = setPaths(cwd, name)
  if (!existsSync(paths.manifest)) {
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.SET_NOT_FOUND,
        `Set manifest ${JSON.stringify(name)} not found (expected ${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX})`,
        {
          hint: `Pass --manifest <path> for a hand-written manifest, or create a set with "skill-set init ${name} <remote-skill-targets>".`,
          data: { name },
        },
      ),
    }
  }
  return parseManifest(readFileSync(paths.manifest, 'utf8'), { filename: `${name}${MANIFEST_SUFFIX}` })
}

async function resolveOutput(ctx: CommandContext, name: string, outputArg: string | undefined): Promise<Result<string>> {
  if (outputArg !== undefined) return { ok: true, data: absoluteFrom(ctx.cwd, outputArg) }
  const defaultOutput = join(ctx.cwd, SHARE_DIR, name)
  if (ctx.dryRun) return { ok: true, data: defaultOutput }
  const confirmed = await ctx.ui.confirm(`Write shareable artifacts to ${displayPath(ctx.cwd, defaultOutput)}?`)
  if (!confirmed.ok) return confirmed
  if (!confirmed.data) {
    return {
      ok: false,
      error: new SkillSetError(ErrorCodes.CONFIRM_REQUIRED, 'Share output path was not confirmed', {
        hint: `Pass --output <dir>, or re-run and confirm ${displayPath(ctx.cwd, defaultOutput)}.`,
        data: { output: defaultOutput },
      }),
    }
  }
  return { ok: true, data: defaultOutput }
}

async function promptForOptionalMetadata(ctx: CommandContext, manifest: Manifest): Promise<Result<Manifest>> {
  let next = manifest
  if (next.description === undefined) {
    const description = await ctx.ui.prompt('Description for the share manifest (optional)', { optional: true })
    if (!description.ok) return description
    if (description.data !== undefined && description.data.trim() !== '') next = { ...next, description: description.data.trim() }
  }
  if (next.author === undefined) {
    const authorName = await ctx.ui.prompt('Author name for the share manifest (optional)', { optional: true })
    if (!authorName.ok) return authorName
    if (authorName.data !== undefined && authorName.data.trim() !== '') {
      const authorUrl = await ctx.ui.prompt('Author URL for the share manifest (optional)', { optional: true })
      if (!authorUrl.ok) return authorUrl
      next = {
        ...next,
        author: {
          name: authorName.data.trim(),
          ...(authorUrl.data === undefined || authorUrl.data.trim() === '' ? {} : { url: authorUrl.data.trim() }),
        },
      }
    }
  }
  if (next.homepage === undefined) {
    const homepage = await ctx.ui.prompt('Homepage for the share manifest (optional)', { optional: true })
    if (!homepage.ok) return homepage
    if (homepage.data !== undefined && homepage.data.trim() !== '') next = { ...next, homepage: homepage.data.trim() }
  }
  return parseManifest(serializeManifest(next))
}

async function stageAndLock(ctx: CommandContext, name: string, manifest: Manifest): Promise<Result<ReturnType<typeof createSetLock>>> {
  const staging = createStagingProject(ctx.cwd)
  if (!staging.ok) return staging
  try {
    const members: Record<string, SetLockMember> = {}
    const failed: Array<{ locator: string; code: string; message: string }> = []
    for (const locator of manifest.skills) {
      ctx.ui.out(ctx.ui.style('dim', `staging: ${formatInvocation(buildAddInvocation(locator), ctx.passthrough)}`))
      const resolved = await resolveMember(locator, {
        cwd: staging.data,
        runner: ctx.runner,
        extraArgs: ctx.passthrough,
        capture: ctx.ui.json,
      })
      if (resolved.ok) members[locator] = resolved.data
      else failed.push({ locator, code: resolved.error.code, message: resolved.error.message })
    }
    if (failed.length > 0) {
      return {
        ok: false,
        error: new SkillSetError(
          ErrorCodes.INSTALL_FAILED,
          `Cannot share ${JSON.stringify(name)} — ${failed.length} of ${plural(manifest.skills.length, 'member skill')} failed to resolve in a clean staging project:\n  - ${failed.map((f) => `${f.locator}: ${f.message}`).join('\n  - ')}`,
          { hint: 'Fix the failing remote skill locators and try again.', data: { name, failed } },
        ),
      }
    }
    return { ok: true, data: createSetLock(name, manifest.version, members) }
  } finally {
    rmSync(staging.data, { recursive: true, force: true })
  }
}

function createStagingProject(cwd: string): Result<string> {
  try {
    return { ok: true, data: mkdtempSync(join(tmpdir(), 'skill-set-share-')) }
  } catch (cause) {
    try {
      const fallbackRoot = join(cwd, SHARE_DIR, '.tmp')
      mkdirSync(fallbackRoot, { recursive: true })
      return { ok: true, data: mkdtempSync(join(fallbackRoot, 'skill-set-share-')) }
    } catch (fallbackCause) {
      return {
        ok: false,
        error: new SkillSetError(ErrorCodes.UNEXPECTED, 'Could not create a staging project for share export', {
          hint: `Ensure the system temp directory is writable, or that ${SHARE_DIR}/.tmp can be created in this project.`,
          data: {
            tempError: cause instanceof Error ? cause.message : String(cause),
            fallbackError: fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause),
          },
        }),
      }
    }
  }
}

function findUnshareableMembers(cwd: string, manifest: Manifest): Array<{ locator: string; reason: string }> {
  const out: Array<{ locator: string; reason: string }> = []
  for (const locator of manifest.skills) {
    const { source } = parseLocator(locator)
    if (isLocalSource(cwd, source)) out.push({ locator, reason: 'source is local to this machine' })
  }
  return out
}

function isLocalSource(cwd: string, source: string): boolean {
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~/')) return true
  if (/^file:/i.test(source)) return true
  if (/^[A-Za-z]:[\\/]/.test(source)) return true
  return existsSync(isAbsolute(source) ? source : join(cwd, source))
}

function looksLikeManifestPath(cwd: string, value: string): boolean {
  if (value.endsWith(MANIFEST_SUFFIX)) return true
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('~/')) return true
  return existsSync(isAbsolute(value) ? value : join(cwd, value))
}

function absoluteFrom(cwd: string, path: string): string {
  if (path.startsWith('~/')) return resolve(process.env.HOME ?? cwd, path.slice(2))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function serializeManifest(manifest: Manifest): string {
  const out: Record<string, unknown> = {
    ...(manifest.$schema === undefined ? {} : { $schema: manifest.$schema }),
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.author === undefined ? {} : { author: manifest.author }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    skills: manifest.skills,
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

function displayPath(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(cwd, path).split('\\').join('/')
  return rel === '' || rel.startsWith('..') ? path : rel
}
