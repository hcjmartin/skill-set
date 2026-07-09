# skills-sets

Alias for [`@skill-set/cli`](https://www.npmjs.com/package/@skill-set/cli). This package reserves the unscoped `skills-sets` name and re-executes the canonical CLI, so

```sh
npx skills-sets <command>
```

behaves exactly like `npx @skill-set/cli <command>`. For the primary experience, install the canonical package directly.

`skill-set` defines a small, open convention for **named, versioned sets of agent skills** — a `<name>.skill-set.json` manifest, a content-hash lock for reproducible, verifiable installs (`verify --frozen` in CI), and a CLI that resolves members via the existing [`skills`](https://www.npmjs.com/package/skills) ecosystem tooling. Docs and spec: **https://skill-set.md** · source: **https://github.com/hcjmartin/skill-set**.

Not affiliated with the `skills`, `skillset`, `skillsets`, or `skills-set` npm packages.

## License

MIT © Harry Martin
