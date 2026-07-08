# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting on this repository: <https://github.com/hcjmartin/skill-set/security/advisories/new>. 

Do not open a public issue or PR for a security problem.

You should receive an acknowledgement within a few days. Please include reproduction steps and the affected version.

## Scope

This policy covers the `@skill-set/cli` package and the skill-set format specification in this repository. The CLI shells out to the pinned upstream `skills` CLI: a vulnerability in that tool itself belongs upstream at [vercel-labs/skills](https://github.com/vercel-labs/skills); a vulnerability in how this CLI invokes it, or in what it does with the results, belongs here.

Spawned children (the upstream CLI via `npx`) deliberately inherit the full parent environment: they run the user's own npm toolchain, which needs PATH managers, proxy settings, and registry auth to function. Treat anything in your environment as visible to the pinned upstream tool.

## Supported versions

Pre-1.0, only the latest published release receives fixes.
