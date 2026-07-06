# skill-set

Define, share, and install named, versioned sets of agent skills.

A **skill-set** is a single JSON manifest — `<name>.skill-set.json` — listing member skills by source locator. 

This repo ships the open format (a normative convention plus JSON Schemas), reference CLI [`@skill-set/cli`](https://www.npmjs.com/package/@skill-set/cli) (command: `skill-set`), and an optional content-hash lock that makes a set's skill contents byte-exactly verifiable on another machine.

The CLI wraps the [`skills`](https://github.com/vercel-labs/skills) CLI (rolling pinned version) for resolving and installing individual skills.

**Status: pre-release.** The format is in draft and the CLI is pre-1.0; both may still change.

## Quickstart

Run from a project root. `npx @skill-set/cli` resolves the `skill-set` bin directly; installing globally gives you the plain `skill-set` command.

A set is shared as a URL to its manifest — any HTTPS location works, no registry required:

```sh
npx @skill-set/cli add https://example.com/frontend.skill-set.json
```

Creating a skill-set and validating a set's pulled contents can also be done via the cli:

```sh
# Define a set — scaffolds .agents/skills/skill-sets/frontend/frontend.skill-set.json
npx @skill-set/cli init frontend vercel-labs/agent-skills@web-design-guidelines hcjmartin/skills-repo@skill-creator

# Install its members through the pinned skills CLI (idempotent: satisfied members are skipped)
npx @skill-set/cli install frontend

# Record exactly which bytes each member resolved to, in frontend.skill-set.lock.json
npx @skill-set/cli lock frontend

# Check the installation; --frozen recomputes every member's content hash against the lock
npx @skill-set/cli verify frontend --frozen
```

See `skill-set --help` for other commands (`build`, `update`, `remove`), flags `--json`/`--yes`/`--dry-run`, passthrough to the wrapped npx skills with `--`.

## Common questions

**Where do skill-set's install?** 

Project scope only (for now) 
Set definitions are nested under `.agents/skills/skill-sets/<set>/`, member skills installed as ordinary skills under `.agents/skills/`.

A global scope is designed but not yet implemented.

**What if two sets pin the same skill to different refs?** 

That is an unresolvable conflict and a hard error (exit 4) before anything installs.

**How do I verify in CI?** 

`skill-set verify <set> --frozen` re-hashes every installed member against the set lock, reports drifted skill content, and exits 3 on drift. 

In CI, frozen is already the default whenever a lock exists.

## The format

The normative convention — manifest fields, validation rules, sharing semantics, the lock format, and the content-hash recipe lives at [spec/draft/README.md](spec/draft/README.md), written so a set can be authored, resolved, and verified without this CLI. 

Documentation will live at [skill-set.md](https://skill-set.md) once the site is up.

## Naming

The npm package is `@skill-set/cli` and the installed command is `skill-set`. 

The unscoped [`skills-sets`](https://www.npmjs.com/package/skills-sets) npm name is a redirect alias for people guessing at the name. 

This project is not affiliated with the `skills`, `skillset`, `skillsets`, or `skills-set` npm packages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

MIT © [Harry Martin](https://github.com/hcjmartin)
