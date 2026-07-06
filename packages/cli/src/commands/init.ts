import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { ErrorCodes, SkillSetError } from '../errors.ts'
import { SKILL_SET_MD_FILENAME } from '../generate.ts'
import { DRAFT_SCHEMA_URL, MANIFEST_SUFFIX, NAME_PATTERN } from '../manifest.ts'
import { loadLockIfPresent, SETS_DIR, setPaths, writeIndex, writeSetPage } from '../project.ts'
import { installSet } from './install.ts'
import { plural, splitFlags, usageError, type CommandContext, type CommandResult } from './context.ts'

export const INIT_USAGE = 'skill-set init <set> <locator> [locators...]'

export async function cmdInit(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const split = splitFlags(args, [], INIT_USAGE)
  if (!split.ok) return split
  const [name, ...locators] = split.data.positionals
  if (name === undefined) return usageError('init needs a set name', INIT_USAGE)
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    return usageError(
      `${JSON.stringify(name)} is not a valid set name (lowercase alphanumerics and single hyphens, max 64 chars)`,
      INIT_USAGE,
    )
  }
  if (locators.length === 0) {
    // The schema requires at least one member, so an empty scaffold would be invalid on arrival.
    return usageError(
      'init needs at least one member locator — a skill-set cannot be empty',
      `${INIT_USAGE}, e.g. skill-set init ${name} vercel-labs/agent-skills@find-skills`,
    )
  }

  const paths = setPaths(ctx.cwd, name)
  const relative = `${SETS_DIR}/${name}/${name}${MANIFEST_SUFFIX}`
  if (existsSync(paths.manifest)) {
    return {
      ok: false,
      error: new SkillSetError(ErrorCodes.SET_EXISTS, `Set ${JSON.stringify(name)} already exists at ${relative}`, {
        hint: 'Edit the existing manifest instead; skill-set never overwrites a set definition.',
        data: { name, manifest: relative },
      }),
    }
  }

  ctx.ui.out(`Creating skill-set ${JSON.stringify(name)}...`)

  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would write: ${relative} (${plural(locators.length, 'skill')})`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — no files changed`)
    return { ok: true, data: { name, dryRun: true, manifest: relative, members: locators.length } }
  }

  mkdirSync(paths.dir, { recursive: true })
  const manifest = { $schema: DRAFT_SCHEMA_URL, name, version: '0.1.0', skills: locators }
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  ctx.ui.out(`${ctx.ui.style('green', '✓')} Created skill-set ${JSON.stringify(name)} — ${relative} (${plural(locators.length, 'skill')})`)

  // A convenience offer, not a gate: silently declined when no prompt is possible.
  const proceed = await ctx.ui.confirm(`Install the skills and generate the set files now?`, { optional: true })
  if (!proceed.ok) return proceed
  if (proceed.data) {
    const install = await installSet(ctx, name)
    if (!install.ok) return install
    const lock = loadLockIfPresent(ctx.cwd, name)
    if (!lock.ok) return lock
    const page = writeSetPage(ctx.cwd, manifest, lock.data)
    const index = writeIndex(ctx.cwd)
    if (!index.ok) return index
    ctx.ui.out(`${ctx.ui.style('green', '✓')} Generated ${page} and ${index.data}`)
    return { ok: true, data: { name, manifest: relative, members: locators.length, install: install.data, page, index: index.data } }
  }

  ctx.ui.out(ctx.ui.style('dim', 'Next:'))
  ctx.ui.out(ctx.ui.style('dim', `  install the set's skills with "skill-set install ${name}"`))
  ctx.ui.out(ctx.ui.style('dim', `  generate ${SKILL_SET_MD_FILENAME} and the index with "skill-set build" after installing`))
  return { ok: true, data: { name, manifest: relative, members: locators.length } }
}
