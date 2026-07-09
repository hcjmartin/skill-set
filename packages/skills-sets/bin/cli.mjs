#!/usr/bin/env node
// skills-sets is a reserved-name alias for @skill-set/cli. It re-executes the canonical
// CLI so `npx skills-sets <args>` behaves exactly like `npx @skill-set/cli <args>`.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const cliDir = dirname(require.resolve('@skill-set/cli/package.json'))
await import(pathToFileURL(join(cliDir, 'dist', 'cli.mjs')).href)
