# @skill-set/core

Runtime-agnostic primitives for the [skill-set format](https://github.com/hcjmartin/skill-set/blob/main/spec/draft/README.md): content hashes, algorithm identifiers, and lock-file types.

Built for servers, edge runtimes and registries outside of [`@skill-set/cli`](https://www.npmjs.com/package/@skill-set/cli), so you don't have to port. Inputs are `(path, bytes)` pairs rather than directories, and digests use WebCrypto, so the same code runs on Node ≥20, Cloudflare Workers, Deno, Bun, and browsers etc. 

Zero dependencies.

```sh
npm install @skill-set/core
```

## Usage

```ts
import {
  FOLDER_HASH_ALGORITHM, // 'skill-set/folder-v1'
  SET_HASH_ALGORITHM,    // 'skill-set/set-v1'
  specFolderHash,
  skillMarkdownFolderHash,
  setHash,
  type SkillSetLock,
} from '@skill-set/core'

// Member content hash (spec §6) over in-memory file bytes — e.g. an upload or DB row.
const computedHash = await specFolderHash([
  { path: 'SKILL.md', bytes: skillMd },
  { path: 'reference/notes.md', bytes: notes },
])

// The common single-file case.
const hash = await skillMarkdownFolderHash(markdown)

// Set-lock rollup — directly comparable to a `.skill-set.lock.json`.
const lock: SkillSetLock = JSON.parse(lockJson)
const verified = (await setHash(
  Object.fromEntries(Object.entries(lock.skills).map(([loc, m]) => [loc, m.computedHash])),
)) === lock.setHash
```

Hashes are byte-identical to the reference CLI's and to any conforming implementation. Recipes are locale-independent by construction (NFC paths, UTF-8-byte-order sort, NUL framing), and this package's test suite is pinned to the spec's [golden vectors](https://github.com/hcjmartin/skill-set/tree/main/spec/draft/examples/hash).

## API

| Export | What it is |
| --- | --- |
| `specFolderHash(files)` | Member content hash (spec §6), lowercase hex. `files` is `{ path, bytes }[]`; enumeration (skipping `.git`/`node_modules`/symlinks) is the caller's platform-specific part. |
| `skillMarkdownFolderHash(content)` | Folder hash of a lone `SKILL.md` — the common authoring case. |
| `setHash(members)` | Set-lock rollup (spec §5) over `{ locator: computedHash }`. |
| `folderHashInput(files)` / `setHashInput(members)` | The exact canonical byte sequences the recipes digest, for synchronous or streaming hashers (the CLI feeds these to `node:crypto`). |
| `FOLDER_HASH_ALGORITHM` / `SET_HASH_ALGORITHM` | Spec lgorithm identifiers, for storing or transmitting digests with provenance. |
| `SkillSetLock` / `SkillSetLockMember` | Typed shape of `<name>.skill-set.lock.json` (types only — schema validation stays the reader's responsibility). |
| `compatFolderHash(files)` / `compatFolderHashInput(files)` | **Not a spec algorithm.** Byte-compatible with `vercel-labs/skills` `computeSkillFolderHash` (v1.5.x), for `skills-lock.json` interop only; locale-sensitive by upstream design. |

## License

MIT
