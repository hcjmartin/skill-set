# @skill-set/cli

## 0.1.1

### Patch Changes

- ee76da7: Verify the automated release pipeline (OIDC trusted publishing with provenance)

## 0.1.0

### Minor Changes

- Initial release of the reference skill-set CLI: define, share, and install named, versioned sets of agent skills.

  - `init` — define a set from skill locators in a `<name>.skill-set.json` manifest
  - `install` — resolve and install a set's member skills via `npx skills`, skipping members the lock already satisfies
  - `add` — install a shared set from a URL, verified against its published lock
  - `lock` / `verify --frozen` — byte-exact content hashing of installed members with a rollup `setHash`, for CI verification
  - `share` — export a shareable manifest and lock (`share [<set>] [--manifest <path>] [--output <dir>]`)
  - `update` — re-resolve members and re-lock
  - `build` — generate per-set `SKILL-SET.md` discovery pages and the index
  - `remove` — remove a set, optionally pruning skills no other set uses
  - Global `--json`, `--yes`, and `--dry-run` flags on every command
