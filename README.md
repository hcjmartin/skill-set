# skill-set

[![npm](https://img.shields.io/npm/v/%40skill-set%2Fcli?label=%40skill-set%2Fcli)](https://www.npmjs.com/package/@skill-set/cli)
[![CI](https://github.com/hcjmartin/skill-set/actions/workflows/ci.yml/badge.svg)](https://github.com/hcjmartin/skill-set/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![skills.sh](https://skills.sh/b/hcjmartin/skill-set)](https://skills.sh/hcjmartin/skill-set)

Define, share, and install named, versioned sets of agent skills.

![Install a shared skill-set from a URL, verified against its lock](docs/demo-add.gif)

The `skill-set` CLI installs a set's declared skills and verifies the installed bytes against its content-hash lock, locally or in CI.

**Status:** the [format spec](spec/draft/README.md) is a draft and the CLI is pre-1.0; minor versions may still include breaking changes until 1.0.

## Why skill-sets?

It takes many skills to do a task well — a skill-set makes grouping and sharing them a first-class, verifiable artifact:

- **Named and versioned** — one manifest defines the set: its name, version, and member skills.
- **Shared as a URL** — any HTTPS location works; no registry, no accounts.
- **Locked to bytes** — an optional content-hash lock records exactly what each member resolved to.
- **Verified in CI** — `verify --frozen` re-hashes every installed member and exits `3` on drift.

The CLI wraps the [`skills`](https://github.com/vercel-labs/skills) CLI (pinned to an exact version, bumped deliberately) for resolving and installing individual skills.

## Quickstart

Run from a project root. `npx @skill-set/cli` resolves the `skill-set` bin directly; installing globally gives you the plain `skill-set` command.

### Install a shared set

A set is shared as a URL to its manifest. This one is real — it installs a working demo set from the [skill-sets.md](https://skill-sets.md) directory:

```sh
npx @skill-set/cli add https://skill-sets.md/sets/hash-demo/hash-demo.skill-set.json
```

### Author your own

```sh
# Define a set — scaffolds .agents/skills/skill-sets/frontend/frontend.skill-set.json
npx @skill-set/cli init frontend vercel-labs/agent-skills@web-design-guidelines hcjmartin/skills-repo@skill-creator

# Install its members through the pinned skills CLI (idempotent: satisfied members are skipped)
npx @skill-set/cli install frontend

# Record exactly which bytes each member resolved to, in frontend.skill-set.lock.json
npx @skill-set/cli lock frontend

# Verify the installation — recomputes every member's content hash against the lock
npx @skill-set/cli verify frontend
```

Publish the manifest and lock anywhere HTTPS-reachable (`share` exports both), and anyone can `add` your set.

## Commands

| Command | What it does |
| --- | --- |
| `init <set> [locators...]` | Scaffold a new set manifest |
| `add <url\|path> [--hash]` | Fetch a shared set manifest, then install it |
| `install <set>` | Install members, skipping ones the lock already satisfies |
| `build [<set>] [--lock]` | Regenerate SKILL-SET.md files and the skill-sets.json index |
| `lock <set>` | Record each member's installed content in a set-lock |
| `share [<set>] [--manifest <path>] [--output <dir>]` | Export a shareable manifest and lock |
| `verify [<set>] [--frozen]` | Verify installed content against each set lock (frozen: require the lock) |
| `update <set>` | Update members via the skills CLI, then re-lock |
| `remove <set>` | Remove a set definition, optionally remove skills not otherwise in use |

Every command takes `--json` (one machine-readable JSON object on stdout), `--yes`, and `--dry-run`. Exit codes: `0` ok · `1` error · `2` usage · `3` drift · `4` conflict.

<details>
<summary>Passing arguments through to the wrapped <code>skills</code> CLI</summary>

Args after `--` pass through verbatim, e.g. `skill-set install demo -- --agent claude-code cursor` installs to those agents only. See `npx skills --help`.

</details>

<details>
<summary>Verified <code>add</code> with an out-of-band hash</summary>

`add <url> --hash sha256:<hex>` keeps the set only if its resolved content matches the given set hash — integrity against the author's published lock, not just TLS. On any mismatch nothing is kept.

</details>

## Verify in CI

`verify` re-hashes every installed member against the set lock, reports drifted content, and exits `3` on drift (identical in CI). Without a set name it verifies every set. `--frozen` adds strictness for pipelines: a set without a committed lock fails with exit `2` instead of falling back to a presence check.

![verify --frozen catches drifted skill content](docs/demo-verify-drift.gif)

```yaml
# .github/workflows/ci.yml
- run: npx @skill-set/cli verify frontend --frozen
  # fails the job on drift (exit 3) or a missing committed lock (exit 2)
```

## Source locators

Members are listed as source-locator strings, optionally pinned with `#<tag-or-commit>`. The reference CLI delegates resolution to `npx skills`, which accepts GitHub shorthands (`owner/repo@skill-name`), git/GitLab URLs, local paths, and well-known HTTPS domains. The format itself treats locators as opaque — see [the spec](spec/draft/README.md) for the exact rules.

## Where things install

Project scope only (for now; a global scope is designed but not yet implemented):

- Set definitions: `.agents/skills/skill-sets/<set>/`
- Member skills: installed as ordinary skills under `.agents/skills/`

## FAQ

**What if two sets pin the same skill to different refs?**

That is an unresolvable conflict and a hard error (exit `4`) before anything installs.

More at [skill-set.md/faq](https://skill-set.md/faq/).

## Documentation

- [skill-set.md](https://skill-set.md) — docs site: CLI reference, FAQ, and the rendered spec
- [The format spec (draft)](spec/draft/README.md) — normative convention for the `<name>.skill-set.json` manifest: fields, validation rules, sharing semantics, the lock format, and the content-hash recipe, written so a set can be authored, resolved, and verified without this CLI
- [JSON Schemas](spec/draft) — `skill-set.schema.json` and `skill-set.lock.schema.json`
- [skill-sets.md](https://skill-sets.md) — a directory of shareable sets

## Naming

The npm package is `@skill-set/cli` and the installed command is `skill-set`.

The unscoped [`skills-sets`](https://www.npmjs.com/package/skills-sets) npm name is a redirect alias for people guessing at the name.

This project is not affiliated with the `skills`, `skillset`, `skillsets`, or `skills-set` npm packages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

MIT © [Harry Martin](https://github.com/hcjmartin)
