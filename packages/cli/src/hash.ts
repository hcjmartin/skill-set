import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  compatFolderHashInput,
  folderHashInput,
  setHashInput,
  type SkillFile,
} from '@skill-set/core'

// Canonical framing lives in @skill-set/core; this module is the filesystem
// adapter (enumeration per spec §6.1) plus a synchronous node:crypto digest.

const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

function collectFiles(dir: string, base: string): SkillFile[] {
  const out: SkillFile[] = []
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
      out.push({ path: relative(base, full).split('\\').join('/'), bytes: readFileSync(full) })
    }
  }
  return out
}

function digest(chunks: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(chunk)
  return hash.digest('hex')
}

/** The normative spec hash (spec §6, `skill-set/folder-v1`): NFC paths, UTF-8-byte-order sort, NUL framing. */
export function specFolderHash(dir: string): string {
  return digest(folderHashInput(collectFiles(dir, dir)))
}

/**
 * Byte-compatible with vercel-labs/skills computeSkillFolderHash (v1.5.x) — used ONLY to
 * interoperate with skills-lock.json. Locale-sensitive by upstream design; not the spec hash.
 * Matches upstream lock entries only for disk-based installs, computed over the SOURCE folder
 * (the installer strips metadata.json from the copy). GitHub blob-path installs record a
 * server-side snapshot hash instead, which no local bytes reproduce (see test/compat.test.ts).
 */
export function compatFolderHash(dir: string): string {
  return digest(compatFolderHashInput(collectFiles(dir, dir)))
}

/** The set-lock rollup (spec §5, `skill-set/set-v1`): sorted locators, `<locator>\n<computedHash>\n` per member. */
export function setHash(members: Record<string, string>): string {
  return digest(setHashInput(members))
}
