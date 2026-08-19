# @skill-set/core

## 0.1.0

### Minor Changes

- ef836b0: Initial release: runtime-agnostic spec primitives for server-side and non-CLI implementations. Exports the spec hash recipes as bytes-in functions (`specFolderHash`, `setHash`, `skillMarkdownFolderHash`, plus the skills-ecosystem interop `compatFolderHash`) digested via WebCrypto, the canonical framing functions (`folderHashInput`, `setHashInput`, `compatFolderHashInput`) for synchronous or streaming hashers, the spec algorithm identifiers (`skill-set/folder-v1`, `skill-set/set-v1`), and typed lock-file shapes (`SkillSetLock`, `SkillSetLockMember`). Zero dependencies; runs on Node ≥20, Cloudflare Workers, Deno, Bun, and browsers. The test suite is pinned to the spec's new golden hash vectors.
