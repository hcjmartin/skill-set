# @skill-set/cli

Define, share, and install named, versioned sets of agent skills. Ships a single `skill-set` bin, so `npx @skill-set/cli` runs it directly.

```sh
npx @skill-set/cli init frontend vercel-labs/agent-skills@web-design-guidelines anthropics/skills@frontend-design
npx @skill-set/cli install frontend
npx @skill-set/cli lock frontend
npx @skill-set/cli verify frontend --frozen
```

Sets are declared in a `<name>.skill-set.json` manifest and shared as a URL to it (`skill-set add <https-url>`). Skill resolution and installation delegate to the pinned upstream [`skills`](https://github.com/vercel-labs/skills) CLI; sets, content-hash locks, verification, and sharing are what this adds.

Embedders without `npx` on PATH can set `SKILL_SET_UPSTREAM_SKILLS_BIN` to the `bin/cli.mjs` of a vendored `skills` package; it runs under the current Node executable in place of `npx -y skills@<pin>`. The package's nearest `package.json` must name `skills` at the pinned version, or every command fails with `ERR_SKILLSET_UPSTREAM_MISMATCH` before anything runs.

Full documentation, the format specification, and the source live at [github.com/hcjmartin/skill-set](https://github.com/hcjmartin/skill-set) and [skill-set.md](https://skill-set.md).

Not affiliated with the `skills`, `skillset`, `skillsets`, or `skills-set` npm packages.

MIT © [Harry Martin](https://github.com/hcjmartin)
