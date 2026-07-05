import { listSetNames, loadLockIfPresent, loadManifest, writeIndex, writeSetPage } from '../project.ts'
import { lockSet } from './lock.ts'
import { plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const BUILD_USAGE = 'skill-set build [<set>] [--lock]'

export async function cmdBuild(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, ['--lock'], BUILD_USAGE)
  if (!split.ok) return split
  const { flags, positionals } = split.data
  if (positionals.length > 1) return usageError('build takes at most one set name', BUILD_USAGE)

  ctx.ui.out('Building SKILL-SET.md files and the skill-sets.json index...')

  const names = positionals.length === 1 ? [positionals[0]!] : listSetNames(ctx.cwd)
  if (names.length === 0) {
    ctx.ui.out('No sets found — nothing to build.')
    ctx.ui.out(ctx.ui.style('dim', 'Create one with "skill-set init <name>".'))
    return { ok: true, data: { sets: [], index: undefined } }
  }

  const sets: Array<{ name: string; page: string; members: number; locked: boolean }> = []
  for (const name of names) {
    const manifest = loadManifest(ctx.cwd, name)
    if (!manifest.ok) return manifest
    const lock = loadLockIfPresent(ctx.cwd, name)
    if (!lock.ok) return lock

    let lockUsed = lock.data
    if (flags.has('--lock')) {
      const locked = lockSet(ctx.cwd, name, manifest.data, { dryRun: ctx.dryRun })
      if (!locked.ok) return locked
      lockUsed = locked.data
    }

    if (ctx.dryRun) {
      const page = `${name}/SKILL-SET.md`
      ctx.ui.out(ctx.ui.style('dim', `would write: ${name} page${flags.has('--lock') ? ' and lock' : ''} (${plural(manifest.data.skills.length, 'member skill')})`))
      sets.push({ name, page, members: manifest.data.skills.length, locked: flags.has('--lock') })
      continue
    }

    const page = writeSetPage(ctx.cwd, manifest.data, lockUsed)
    ctx.ui.out(
      `${ctx.ui.style('green', '✓')} ${name} — ${page} (${plural(manifest.data.skills.length, 'member skill')}${flags.has('--lock') ? ', locked' : ''})`,
    )
    sets.push({ name, page, members: manifest.data.skills.length, locked: flags.has('--lock') })
  }

  if (ctx.dryRun) {
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed`)
    return { ok: true, data: { dryRun: true, sets } }
  }
  const index = writeIndex(ctx.cwd)
  if (!index.ok) return index
  ctx.ui.out(`${ctx.ui.style('green', '✓')} ${index.data}`)
  return { ok: true, data: { sets, index: index.data } }
}
