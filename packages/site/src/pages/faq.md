---
layout: ../layouts/Doc.astro
title: FAQ
description: Where skill-set files live in a project, how cross-set pin conflicts are handled, and how to verify sets byte-exactly in CI.
---

## Where do skill-set files live in my project?

Everything is project-scoped, under the agent-neutral `.agents/` tree:

```
.agents/skills/
  skill-sets/
    skill-sets.json                    # generated index of all sets
    frontend/
      frontend.skill-set.json          # authored — the only hand-edited file per set
      frontend.skill-set.lock.json     # generated set-lock (optional, committable)
      SKILL-SET.md                     # generated discovery page
  <skill-name>/                        # each member, installed as an ordinary skill
    SKILL.md
```

Member skills are not wrapped or relocated — they install as flat siblings at `.agents/skills/<skill-name>/`, exactly where the skills CLI puts them, so any skills-compatible agent picks them up as usual. Global scope (`~/.agents/`) is not implemented; the CLI operates on the current project only.

## What happens when two sets want the same skill?

Overlap is fine: two sets referencing the same source at the same ref (or unpinned) share the installed member, and `remove` reference-counts across sets so a shared skill is never deleted while another set still uses it.

Two sets pinning the same source to *different* refs is unresolvable — there is only one `.agents/skills/<skill-name>/` folder to install into. `install` detects this across every set in the project before installing anything, reports which sets pin which refs, and exits with code 4. It never resolves the conflict silently by letting the last write win. Align the pins across the named sets, then install again.

## How do I verify a set in CI?

Commit the set-lock (create it with `skill-set lock <set>`), then run verify in your pipeline:

```yaml
- run: npx @skill-set/cli verify frontend --frozen
```

Frozen verify recomputes every member's content hash from the bytes on disk and compares it to the lock. On mismatch it exits with code 3 and reports **all** problems in one pass — each drifted member with its expected and actual hash, missing folders, and any manifest/lock membership differences — so one run shows the full repair size.

In CI environments, frozen is already the default whenever a set-lock exists, so `npx @skill-set/cli verify frontend` behaves the same there; the explicit flag also makes the intent clear to readers. The `--frozen` flag is the strict path anywhere else too: the default (non-frozen) verify only checks presence and delegates a staleness check to `npx skills check`.

Two related exit codes matter for pipelines: `2` means the verify could not run as asked (for example `--frozen` with no committed lock), `3` means it ran and found drift. Use `--json` for machine-readable results.

## Should I commit the lock?

Yes, if you want reproducibility or frozen verify — that is its purpose. The lock is deterministic (sorted keys, no timestamps; identical inputs produce identical bytes), so diffs are small and merges stay clean. Without a lock, `install` still works from the manifest alone; you just lose byte-exact verification and idempotent skips.

## How does skill-set relate to the skills CLI?

It is a companion, not a fork. The skills CLI resolves and installs individual skills; skill-set adds the set layer — named manifests, sharing by URL, locks, and verification. Every member resolution shells out to the pinned upstream (`npx skills@1.5`), and arguments after `--` pass through to it verbatim. Locators in a manifest are whatever `npx skills add` accepts.

## Is this the `skillset`, `skillsets`, or `skills-set` package on npm?

No. Those are unrelated projects by other authors. This project's canonical package is [`@skill-set/cli`](https://www.npmjs.com/package/@skill-set/cli), invoked as `npx @skill-set/cli`; this project also holds the `skills-sets` npm name, which exists only to point users at the canonical CLI.
