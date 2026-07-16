# @skill-set/cli

## 0.3.0

### Minor Changes

- 1e86eeb: `verify` now checks installed content against the set lock by default, everywhere — the previous `--frozen` semantics, with no CI/local divergence. With no set name it verifies every set in the project, with per-set results and an aggregate exit code (`3` if any set drifts). `--frozen` now means "require the lock": any targeted set without a lock exits `2`; `--no-frozen` is removed. When a set has no lock and `--frozen` is not given, verify falls back to a presence check and says explicitly that content was not verified. The delegated `npx skills check` staleness check is removed — verify never spawns the wrapped CLI; run `npx skills check` directly for per-skill staleness.

## 0.2.0

### Minor Changes

- 37eecd2: Add a branded one-line intro (`{skill-set} v<version> — <tagline>`) before commands in interactive TTY sessions. It prints to stderr so stdout stays pipeable, and is suppressed under `--json`, pipes, and CI. Also fixes terminal colors never being emitted on real TTYs (the injected-stream detection in `createUi` always tripped), and adds `Ui.accent()` — the brand accent `#ff5733` as truecolor, degrading to xterm-256 202 and then `redBright` by terminal depth.
- b0b7893: Reserve the `skill-sets` skill name and protect set definitions from upstream installs.

  Set definitions live at `.agents/skills/skill-sets/`, inside the skills directory. Installing any skill named `skill-sets` let the upstream CLI overwrite that directory wholesale — destroying every installed set definition and crashing `add` with a raw ENOENT. The first-party skill shipped under that very name; it is now published as `skill-set`.

  - Members naming the reserved skill (`…@skill-sets`) are refused before anything is fetched, spawned, or written (`ERR_SKILLSET_RESERVED_NAME`).
  - Unnamed members that _resolve_ to the reserved name are refused post-spawn, with the set-definitions directory restored byte-exact from a pre-spawn snapshot and the stray upstream lock entry dropped.
  - Every upstream spawn (install, update, remove) is bracketed by that snapshot/restore, with a notice when a restore fires.
  - Set-file writes create their parent directory first, so a vanished set dir surfaces as a structured error, never a raw ENOENT.
  - Spec §4 now documents the canonical sets directory and the reserved-name rule.

  Migrating an existing install of the old skill: delete the stray `SKILL.md` from `.agents/skills/skill-sets/` (keep the set folders), drop the `skill-sets` entry from `skills-lock.json`, then `npx skills add hcjmartin/skill-set@skill-set`. Do **not** run `npx skills remove skill-sets` — it removes the whole directory, set definitions included.

## 0.1.2

### Patch Changes

- d9e8cf6: Correct the example locator in the `init` usage hint (vercel-labs/skills@find-skills).

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
