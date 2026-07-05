import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { ErrorCodes, SkillSetError } from '../errors.ts'
import { DRAFT_SCHEMA_URL, MANIFEST_SUFFIX, NAME_PATTERN } from '../manifest.ts'
import { SETS_DIR, setPaths } from '../project.ts'
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
      `${INIT_USAGE}, e.g. skill-set init ${name} vercel-labs/skills@find-skills`,
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

  if (ctx.dryRun) {
    ctx.ui.out(ctx.ui.style('dim', `would write: ${relative} (${plural(locators.length, 'member')})`))
    ctx.ui.out(`${ctx.ui.style('green', '✓')} dry run — nothing written`)
    return { ok: true, data: { name, dryRun: true, manifest: relative, members: locators.length } }
  }

  mkdirSync(paths.dir, { recursive: true })
  const manifest = { $schema: DRAFT_SCHEMA_URL, name, version: '0.1.0', skills: locators }
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

  ctx.ui.out(`${ctx.ui.style('green', '✓')} Created ${relative}`)
  ctx.ui.out(ctx.ui.style('dim', `Next: "skill-set install ${name}", then "skill-set build".`))
  return { ok: true, data: { name, manifest: relative, members: locators.length } }
}
