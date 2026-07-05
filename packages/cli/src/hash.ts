import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

type FileEntry = { rel: string; bytes: Buffer }

const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

function collectFiles(dir: string, base: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    // Some filesystems (FUSE/NFS) report unknown dirent types; classify those via lstat.
    const kind =
      entry.isSymbolicLink() || entry.isDirectory() || entry.isFile() ? entry : lstatSync(full)
    if (kind.isSymbolicLink()) continue
    if (kind.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      out.push(...collectFiles(full, base))
    } else if (kind.isFile()) {
      out.push({ rel: relative(base, full).split('\\').join('/'), bytes: readFileSync(full) })
    }
  }
  return out
}

/** The normative spec hash (spec §6): NFC paths, UTF-8-byte-order sort, NUL framing, locale-independent. */
export function specFolderHash(dir: string): string {
  // NFC per spec §6 — APFS reports decomposed (NFD) filenames, Linux stores them as written.
  const files = collectFiles(dir, dir).map((f) => ({ ...f, rel: f.rel.normalize('NFC') }))
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
 * interoperate with skills-lock.json. Locale-sensitive by upstream design; not the spec hash.
 * Matches upstream lock entries only for disk-based installs, computed over the SOURCE folder
 * (the installer strips metadata.json from the copy). GitHub blob-path installs record a
 * server-side snapshot hash instead, which no local bytes reproduce (see CHANGELOG).
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
