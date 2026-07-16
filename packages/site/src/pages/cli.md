---
layout: ../layouts/Doc.astro
title: CLI reference
description: Every skill-set command, the global flags, exit codes, and JSON output — the complete reference for the @skill-set/cli package.
lede: The CLI ships as @skill-set/cli with a single bin, skill-set. Run it without installing via npx.
---

```shellscript
npx @skill-set/cli <command> [args] [flags] [-- <args for the skills CLI>]
```

Resolution and installation of individual skills are delegated to the upstream [skills CLI](https://skills.sh), pinned to `skills@1.5.14`. `skill-set --version` prints both versions:

```
skill-set/<version> (wraps skills@1.5.14, pinned)
```

## Commands

| Command | Usage | Does |
| --- | --- | --- |
| [`init`](#init) | `init <set> <locator> [locators...]` | Scaffold a new set manifest |
| [`add`](#add) | `add <url\|path>` | Fetch a shared set manifest, then install it |
| [`install`](#install) | `install <set>` | Install members, skipping ones the lock already satisfies |
| [`build`](#build) | `build [<set>] [--lock]` | Regenerate SKILL-SET.md files and the skill-sets.json index |
| [`lock`](#lock) | `lock <set>` | Record each member's installed content in a set-lock |
| [`share`](#share) | `share [<set>] [--manifest <path>] [--output <dir>]` | Export a shareable manifest and lock |
| [`verify`](#verify) | `verify [<set>] [--frozen]` | Verify installed content against each set lock (frozen: require the lock) |
| [`update`](#update) | `update <set>` | Update members via the skills CLI, then re-lock |
| [`remove`](#remove) | `remove <set>` | Remove a set definition, optionally remove skills not otherwise in use |

### init

```shellscript
skill-set init <set> <locator> [locators...]
```

Scaffolds `.agents/skills/skill-sets/<set>/<set>.skill-set.json` at version `0.1.0` with the given members, then offers to install them and generate the set files. At least one locator is required — a skill-set cannot be empty. Set names are lowercase alphanumerics with single hyphens, at most 64 characters. If a set of that name already exists, `init` fails; it never overwrites a set definition.

### add

```shellscript
skill-set add <url|path>
```

Acquires a shared set: fetches the manifest (HTTPS only; at most 5 redirects; 1 MiB response cap) or reads a local path, validates it against the schema and rules, prints the set summary with every member and its source, then asks for confirmation before writing anything. The fetched bytes are written verbatim as `<name>.skill-set.json` — the filename comes from the manifest's `name` — and the normal install flow runs.

Hosts other than recognised skill-set providers prompt for confirmation before any bytes are fetched, and redirects may not hop to a new host. An existing set with the same name is an error, never a silent overwrite.

![Terminal recording: adding a shared skill-set and installing its members.](/demo-add.gif)

### install

```shellscript
skill-set install <set>
```

Before anything installs, every set in the project is checked for members pinned to conflicting refs — a conflict aborts with exit code 4 (see the [FAQ](/faq/#what-happens-when-two-sets-want-the-same-skill)). Members whose locked content is already on disk byte-for-byte are skipped; the rest resolve one at a time through `npx skills@1.5.14 add <locator>`. The summary reports installed, skipped, and failed counts, and any member failure makes the whole command fail after attempting the rest.

### build

```shellscript
skill-set build [<set>] [--lock]
```

Regenerates the derived files for one set, or for all sets when no name is given: a `SKILL-SET.md` discovery page per set (frontmatter, member table, install and provenance sections) and the project-wide `skill-sets.json` index. Output is deterministic — identical inputs produce identical bytes. `--lock` also records the set-lock, exactly as `lock` does.

### lock

```shellscript
skill-set lock <set>
```

Writes `<set>.skill-set.lock.json`: for every member, the installed skill name, its content hash (SHA-256 over the skill folder, as defined by [the spec](/spec/#6-member-content-hash)), and the resolver-reported source and ref, plus a rollup `setHash` for the whole set. Every member must be installed first; missing members are reported all at once.

### share

```shellscript
skill-set share [<set>] [--manifest <path>] [--output <dir>]
```

Prepares a set for distribution. It takes a local set by name or a hand-written manifest (`--manifest`), and offers to fill in any missing description, author, and homepage. Every member is re-fetched into a throwaway clean project and hashed there, so the exported set-lock records the content the locators actually deliver — not your local, possibly-edited skill folders. A notice names any installed skill that differs from the fetched content, and members with local-only sources cannot be shared and are reported.

The manifest and lock are written to `.agents/skills/skill-sets/_share/<set>/` (or `--output <dir>`). Publish the two together so a recipient's `add` finds the sidecar lock, or hand out a validating install command carrying the `#sha256=<setHash>` fragment.

### verify

```shellscript
skill-set verify [<set>] [--frozen]
```

Recomputes every member's content hash and validates it against the set-lock (identical in CI). Reports drifted members with expected and actual hashes, missing folders, and membership differences; exits `3` on drift. Called without a `<set>`, verifies every set in the project.

For per-skill staleness against upstream sources, use `npx skills check`.

When a set has no lock, verify falls back to checking that every member is present, says explicitly that content was not verified, and hints to create a lock with `skill-set lock <set>`. `--frozen` turns that fallback into a failure: any targeted set without a lock is a precondition error (exit 2). See [verifying in CI](/faq/#how-do-i-verify-a-set-in-ci).

![Terminal recording: skill-set verify --frozen catching drift against the lock.](/demo-verify-drift.gif)

### update

```shellscript
skill-set update <set>
```

Updates every member through `npx skills@1.5.14 update <skills...> -p --yes`, then re-locks the set if a lock existed and regenerates the derived files. All members must be installed before anything updates.

### remove

```shellscript
skill-set remove <set>
```

Removes the set definition — manifest, lock, and generated page — after confirmation, and refreshes the index. It then offers to also remove the set's member skills, keeping any skill still referenced by another set (reference-counted, including by shared source). Skill removal is delegated to `npx skills remove` so the upstream lock stays consistent.

## Global flags

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output: exactly one JSON object on stdout |
| `--yes`, `-y` | Assume yes for prompts (required where a prompt would block CI) |
| `--dry-run` | Print what would run or be written; change nothing, spawn nothing |
| `--help`, `-h` | Show help |
| `--version`, `-v` | Show the skill-set version and the pinned skills version |

Arguments after `--` pass through to the skills CLI verbatim, for example:

```shellscript
skill-set install demo -- --agent claude-code cursor
```

installs the set's skills for those agents only. See `npx skills --help` for what the upstream accepts.

### JSON output

With `--json`, every run — including crashes — emits exactly one JSON envelope on stdout:

```json
{ "ok": true, "command": "verify", "data": { "name": "frontend", "mode": "lock", "checked": 4 } }
```

```json
{
  "ok": false,
  "command": "install",
  "error": {
    "code": "ERR_SKILLSET_CONFLICT",
    "message": "…",
    "hint": "…",
    "data": {}
  }
}
```

`error.code` is a stable machine-readable code; `hint` and `data` appear when available.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Error — anything not covered below |
| `2` | Usage — bad arguments, a prompt blocked without `--yes`, or `verify --frozen` without a set-lock |
| `3` | Drift — verify found installed content that does not match the set-lock |
| `4` | Conflict — a member source pinned to different refs across sets |
