/**
 * The spec hash recipes (spec §5–§6): bytes in, lowercase hex out.
 *
 * Runtime-agnostic by construction — inputs are (path, bytes) pairs rather than
 * a directory, and digests use WebCrypto — so the same code runs on Node ≥20,
 * and browsers. Enumerating a real folder into pairs is the caller's
 * platform-specific part (the reference CLI's filesystem adapter skips
 * `.git`/`node_modules` dirs and symlinks per §6.1).
 *
 * The `*Input` functions expose the exact canonical byte sequence each recipe
 * digests, for callers that need a synchronous or streaming hasher (the CLI
 * feeds them to node:crypto); the async functions are those bytes through
 * WebCrypto SHA-256.
 */

/** Names the §6 member content hash wherever a digest travels with provenance. */
export const FOLDER_HASH_ALGORITHM = 'skill-set/folder-v1'
/** Names the §5 setHash rollup wherever a digest travels with provenance. */
export const SET_HASH_ALGORITHM = 'skill-set/set-v1'

export interface SkillFile {
  /** Path relative to the skill folder root, `/`-separated (any Unicode form; NFC is applied here). */
  path: string
  /** The file's raw bytes, exactly as stored. */
  bytes: Uint8Array
}

const encoder = new TextEncoder()
const NUL = Uint8Array.of(0)

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return a.length - b.length
}

async function sha256Hex(chunks: Uint8Array[]): Promise<string> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The exact byte sequence §6 digests: NFC paths, UTF-8-byte-order sort, NUL framing. */
export function folderHashInput(files: SkillFile[]): Uint8Array[] {
  const entries = files.map((file) => ({
    rel: encoder.encode(file.path.split('\\').join('/').normalize('NFC')),
    bytes: file.bytes,
  }))
  entries.sort((a, b) => compareBytes(a.rel, b.rel))
  return entries.flatMap((entry) => [entry.rel, NUL, entry.bytes, NUL])
}

/** The member content hash (spec §6, `skill-set/folder-v1`), lowercase hex. */
export async function specFolderHash(files: SkillFile[]): Promise<string> {
  return sha256Hex(folderHashInput(files))
}

/** Folder hash of a single-file SKILL.md skill — the common authoring case. */
export async function skillMarkdownFolderHash(content: string): Promise<string> {
  return specFolderHash([{ path: 'SKILL.md', bytes: encoder.encode(content) }])
}

/** The exact byte sequence §5 digests: `<locator>\n<computedHash>\n` in UTF-8-byte-order of the locator. */
export function setHashInput(members: Record<string, string>): Uint8Array[] {
  const locators = Object.keys(members)
    .map((locator) => ({ locator, bytes: encoder.encode(locator) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes))
  return locators.map(({ locator }) => encoder.encode(`${locator}\n${members[locator]}\n`))
}

/** The set-lock rollup hash (spec §5, `skill-set/set-v1`), lowercase hex. */
export async function setHash(members: Record<string, string>): Promise<string> {
  return sha256Hex(setHashInput(members))
}

/**
 * NOT a spec algorithm — the byte sequence vercel-labs/skills computeSkillFolderHash
 * (v1.5.x) digests, for interoperating with `skills-lock.json` only. Locale-sensitive
 * sort by upstream design; paths and bytes go in as given (no NFC, no framing).
 */
export function compatFolderHashInput(files: SkillFile[]): Uint8Array[] {
  const entries = [...files].sort((a, b) => a.path.localeCompare(b.path))
  return entries.flatMap((entry) => [encoder.encode(entry.path), entry.bytes])
}

/** The skills-ecosystem interop hash over `compatFolderHashInput`, lowercase hex. */
export async function compatFolderHash(files: SkillFile[]): Promise<string> {
  return sha256Hex(compatFolderHashInput(files))
}
