---
name: skill-sets
description: Installs, shares, locks, verifies, and updates skill sets (named, versioned groups of agent skills). Use for any multi-skill, manifest (.skill-set.json), or set-lock operation. Not for authoring or installing one skill, or for npm and pip.
license: MIT
---

# Skill sets

A skill set is a named, versioned bundle of agent skills, defined by a small JSON manifest and installed as a group. This skill drives the `skill-set` CLI, which wraps `npx skills` to resolve each member. Full docs: https://skill-set.md.

## Quick start

Install a shared set from a URL, verifying it matches what the author published:

    npx @skill-set/cli add https://skill-sets.md/sets/<name>/<name>.skill-set.json

Or define your own set from remote skills, then install it:

    npx @skill-set/cli init <name> <owner/repo@skill> [<owner/repo@skill> ...]
    npx @skill-set/cli install <name>

## Core concepts

- **Manifest** — `<name>.skill-set.json`: the set's name, version, and member skill locators. The shareable definition.
- **Set-lock** — `<name>.skill-set.lock.json`: each member skill's resolved content hash plus a rollup `setHash`, for byte-exact verification.
- **SKILL-SET.md** — a generated discovery page per set. Do not hand-edit; run `build`.
- Sets live under `.agents/skills/skill-sets/<name>/`; member skills install as ordinary skills under `.agents/skills/`.

## Common tasks

Every command takes a set name. Global flags: `--json` (machine output), `--yes` (CI),
`--dry-run` (preview, changes nothing). Full reference: https://skill-set.md/cli.

- **Create a set** — `init <name> <locators...>`
- **Install / sync** — `install <name>` (skips members the lock already satisfies)
- **Generate lock of local contents** — `lock <name>`
- **Regenerate pages + index** — `build [<name>] [--lock]`
- **Verify installed content** — `verify <name> [--frozen]` (frozen re-hashes vs the lock; the CI default)
- **Update members** — `update <name>` (re-resolves via `npx skills`, then re-locks)
- **Remove a set** — `remove <name>` (optionally removes skills no other set uses)

## Sharing a set

`share` re-fetches every member into a clean staging area and records the hash of the *delivered* content — never your local, possibly-edited folders:

    npx @skill-set/cli share <name>

Publish the emitted `<name>.skill-set.json` and `<name>.skill-set.lock.json` together. A recipient verifies at install time:

    npx @skill-set/cli add <url>                  # auto-discovers and checks the sidecar lock
    npx @skill-set/cli add <url>#sha256=<setHash>  # or pin the rollup hash out-of-band

If verification fails, nothing is kept and the command exits 3 — see https://skill-set.md/faq for what gets verified and when.

## Caveats

- **Set definitions live inside this skill's folder.** Removing this skill with `npx skills remove skill-sets` removes it like any other skill — and takes the nested set definitions with it. To remove a single set instead, use `skill-set remove <name>`.
- **Local member locators work locally but aren't shareable.** You can `init`, `install`, and `lock` a set that references local skill paths, but `share` rejects them — a shared set must resolve from remote sources on another machine.

## Reference

- Manifest + set-lock format — https://skill-set.md/spec
- Full CLI reference (commands, flags, exit codes) — https://skill-set.md/cli
- Trust model, what is verified and when — https://skill-set.md/faq
