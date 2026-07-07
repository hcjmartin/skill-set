import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'
import { createSetLock, type SetLock, type SetLockMember } from './lock.ts'
import type { Manifest } from './manifest.ts'
import { SETS_DIR } from './project.ts'
import { buildAddInvocation, locateMember, resolveMember, type CommandRunner, type SkillsInvocation } from './resolver.ts'
import { plural } from './text.ts'
import type { Ui } from './ui.ts'

const STAGING_DIR = `${SETS_DIR}/.staging`
const STAGING_PREFIX = 'skill-set-staging-'

export interface StagedManifest {
  lock: SetLock
  staging: string
}

export async function stageManifestMembers(
  manifest: Manifest,
  opts: {
    cwd: string
    runner?: CommandRunner
    extraArgs?: readonly string[]
    capture?: boolean
    label: string
    locators?: readonly string[]
    onStage?: (locator: string, invocation: SkillsInvocation) => void
  },
): Promise<Result<StagedManifest>> {
  const staging = createStagingProject(opts.cwd)
  if (!staging.ok) return staging
  const members: Record<string, SetLockMember> = {}
  const failed: Array<{ locator: string; code: string; message: string }> = []
  const locators = opts.locators ?? manifest.skills
  try {
    for (const locator of locators) {
      opts.onStage?.(locator, buildAddInvocation(locator))
      const resolved = await resolveMember(locator, {
        cwd: staging.data,
        runner: opts.runner,
        extraArgs: opts.extraArgs,
        capture: opts.capture,
      })
      if (resolved.ok) members[locator] = resolved.data
      else failed.push({ locator, code: resolved.error.code, message: resolved.error.message })
    }
    if (failed.length > 0) {
      removeStagingProject(opts.cwd, staging.data)
      return {
        ok: false,
        error: new SkillSetError(
          ErrorCodes.INSTALL_FAILED,
          `Cannot ${opts.label} — ${failed.length} of ${plural(locators.length, 'member skill')} failed to resolve in a clean staging project:\n  - ${failed.map((f) => `${f.locator}: ${f.message}`).join('\n  - ')}`,
          { hint: 'Fix the failing remote skill locators and try again.', data: { name: manifest.name, failed } },
        ),
      }
    }
  } catch (cause) {
    removeStagingProject(opts.cwd, staging.data)
    return {
      ok: false,
      error: new SkillSetError(ErrorCodes.UNEXPECTED, `Unexpected failure while staging ${manifest.name}: ${(cause as Error).message}`, {
        cause,
      }),
    }
  }
  return { ok: true, data: { lock: createSetLock(manifest.name, manifest.version, members), staging: staging.data } }
}

export function createStagingProject(cwd: string): Result<string> {
  try {
    return { ok: true, data: mkdtempSync(join(tmpdir(), STAGING_PREFIX)) }
  } catch (cause) {
    try {
      const fallbackRoot = join(cwd, STAGING_DIR, '.tmp')
      mkdirSync(fallbackRoot, { recursive: true })
      return { ok: true, data: mkdtempSync(join(fallbackRoot, STAGING_PREFIX)) }
    } catch (fallbackCause) {
      return {
        ok: false,
        error: new SkillSetError(ErrorCodes.UNEXPECTED, 'Could not create a staging project', {
          hint: `Ensure the system temp directory is writable, or that ${STAGING_DIR}/.tmp can be created in this project.`,
          data: {
            tempError: cause instanceof Error ? cause.message : String(cause),
            fallbackError: fallbackCause instanceof Error ? fallbackCause.message : String(fallbackCause),
          },
        }),
      }
    }
  }
}

export function removeStagingProject(cwd: string, staging: string): void {
  rmSync(staging, { recursive: true, force: true })
  const fallbackRoot = join(cwd, STAGING_DIR, '.tmp')
  if (staging === fallbackRoot || !staging.startsWith(`${fallbackRoot}${sep}`)) return
  removeIfEmpty(fallbackRoot)
  removeIfEmpty(join(cwd, STAGING_DIR))
}

export function localContentMismatches(
  cwd: string,
  manifest: Manifest,
  lock: SetLock,
): Array<{ locator: string; skill: string }> {
  const mismatches: Array<{ locator: string; skill: string }> = []
  for (const locator of manifest.skills) {
    const staged = lock.skills[locator]
    if (staged === undefined) continue
    const local = locateMember(locator, { cwd })
    if (!local.ok) continue
    if (local.data.computedHash !== staged.computedHash) mismatches.push({ locator, skill: local.data.skill })
  }
  return mismatches
}

/** The local-vs-remote drift notice shared by add and share after a staged verification. */
export function reportLocalDrift(
  ui: Ui,
  mismatches: ReadonlyArray<{ locator: string; skill: string }>,
  opts: { source: string; followUp: string },
): void {
  if (mismatches.length === 0) return
  ui.out(
    ui.style(
      'yellow',
      `Notice: ${plural(mismatches.length, 'installed local skill')} ${mismatches.length === 1 ? 'differs' : 'differ'} from ${opts.source}:`,
    ),
  )
  for (const mismatch of mismatches) ui.out(`  - ${mismatch.locator} (skill ${mismatch.skill})`)
  ui.out(ui.style('dim', opts.followUp))
}

function removeIfEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup only; the staging project itself has already been removed.
  }
}
