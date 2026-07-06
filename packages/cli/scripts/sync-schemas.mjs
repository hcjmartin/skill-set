// Ships exactly the schema versions this CLI release supports: schema/ is rebuilt from
// spec/<version>/ for each listed version on every pack. VERSIONS must mirror
// SUPPORTED_SCHEMA_VERSIONS in src/manifest.ts
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VERSIONS = ['draft']

const SPEC_ROOT = fileURLToPath(new URL('../../../spec', import.meta.url))
const TARGET_ROOT = fileURLToPath(new URL('../schema', import.meta.url))

rmSync(TARGET_ROOT, { recursive: true, force: true })
for (const version of VERSIONS) {
  const source = join(SPEC_ROOT, version)
  const target = join(TARGET_ROOT, version)
  mkdirSync(target, { recursive: true })
  for (const file of readdirSync(source).filter((f) => f.endsWith('.schema.json'))) {
    copyFileSync(join(source, file), join(target, file))
  }
}
