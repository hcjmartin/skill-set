import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

type FileEntry = { rel: string; bytes: Buffer }

const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

function collectFiles(dir: string, base: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      out.push(...collectFiles(full, base))
    } else if (entry.isFile()) {
      out.push({ rel: relative(base, full).split('\\').join('/'), bytes: readFileSync(full) })
    }
  }
  return out
}

/** The normative spec hash (spec §6): UTF-8-byte-order sort, NUL framing, locale-independent. */
export function specFolderHash(dir: string): string {
  const files = collectFiles(dir, dir)
  files.sort((a, b) => Buffer.compare(Buffer.from(a.rel, 'utf8'), Buffer.from(b.rel, 'utf8')))
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(f.rel, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(f.bytes)
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

/**
 * Byte-compatible with vercel-labs/skills computeSkillFolderHash (v1.5.x) — used ONLY to
 * interoperate with skills-lock.json (D18). Locale-sensitive by upstream design; not the spec hash.
 */
export function compatFolderHash(dir: string): string {
  const files = collectFiles(dir, dir)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(f.rel)
    hash.update(f.bytes)
  }
  return hash.digest('hex')
}

/** The set-lock rollup (spec §5): sorted locators, `<locator>\n<computedHash>\n` per member. */
export function setHash(members: Record<string, string>): string {
  const locators = Object.keys(members).sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  )
  const hash = createHash('sha256')
  for (const locator of locators) {
    hash.update(`${locator}\n${members[locator]}\n`, 'utf8')
  }
  return hash.digest('hex')
}
