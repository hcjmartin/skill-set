# Contributing

Thanks for your interest in improving skill-set. 

Issues and pull requests are welcome; for anything larger than a fix, open an issue first so the approach can be agreed before you invest time.

## Setup

Node 20 or newer, and pnpm via corepack (pnpm version is pinned in packageManager):

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Making a change

- Work on a feature branch and open a PR against `main`.
- `pnpm -w run check` must pass: it runs build, typecheck, lint, and the vitest suites in order. Run a single package's tests with `pnpm --filter @skill-set/cli test`.
- Add a changeset (`pnpm changeset`) for any change visible to users of the published package.
- New behaviour needs tests in the existing style: table-driven where possible, hermetic (the upstream `skills` CLI is faked, never hit over the network in PR CI).
- Comments are one-liners, and only where the code alone would mislead; the reasoning behind non-obvious choices goes in the change's changeset entry (it becomes the published CHANGELOG).

## Dependency rules

The workspace enforces a supply-chain posture; PRs that break it fail install or review:

- `minimumReleaseAge: 10080` — a dependency version must be at least 7 days old. pnpm hard-fails when no in-range version clears the cutoff, so set version floors to a release that does, not the true latest.
- Dependency postinstall/build scripts are blocked (`onlyBuiltDependencies: []`). Do not add packages that require them.
- Runtime dependencies stay lean and deliberate; prefer the standard library, and bundle small helpers over adding a package.
- GitHub Actions are pinned to commit SHAs.

## Security issues

Do not open public issues or PRs for vulnerabilities — see [SECURITY.md](SECURITY.md).
