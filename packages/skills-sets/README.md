# skills-sets

> **Pre-release placeholder.** The `skill-set` CLI is under active development and not yet released. This 0.0.1 stub reserves the package name; running it prints a notice and exits non-zero.

`skill-set` defines a small, open convention for **named, versioned sets of agent skills**:

- a `<name>.skill-set.json` manifest (JSON Schema-validated) listing member skills by source locator
- a content-hash lock for reproducible, verifiable installs (`verify --frozen` in CI)
- a CLI that resolves and installs members via the existing [`skills`](https://www.npmjs.com/package/skills) ecosystem tooling
- sets shareable as plain HTTPS-hosted manifests — `skill-set add <url>`

Follow progress, read the draft spec, and open issues at **https://github.com/hcjmartin/skill-set**.

Not affiliated with the `skills`, `skillset`, `skillsets`, or `skills-set` npm packages.

## License

MIT © Harry Martin
