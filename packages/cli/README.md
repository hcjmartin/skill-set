# @skill-set/cli

Define, share, and install named, versioned sets of agent skills. Ships a single `skill-set` bin, so `npx @skill-set/cli` runs it directly.

```sh
npx @skill-set/cli init frontend vercel-labs/agent-skills@web-design-guidelines anthropics/skills@frontend-design
npx @skill-set/cli install frontend
npx @skill-set/cli lock frontend
npx @skill-set/cli verify frontend --frozen
```

Bundling the CLI inside your own app? See the [developer docs](https://github.com/hcjmartin/skill-set/tree/main/docs).

Sets are declared in a `<name>.skill-set.json` manifest and shared as a URL to it (`skill-set add <https-url>`). Skill resolution and installation delegate to the pinned upstream [`skills`](https://github.com/vercel-labs/skills) CLI; sets, content-hash locks, verification, and sharing are what this adds.

`add` asks before fetching from a host it does not recognise. `skill-set trust <host>` (or `<host>/<owner>` on GitHub) records a source you trust so it stops asking; `trust --list` and `trust --remove <source>` manage the entries.

Full documentation, the format specification, and the source live at [github.com/hcjmartin/skill-set](https://github.com/hcjmartin/skill-set) and [skill-set.md](https://skill-set.md).

Not affiliated with the `skills`, `skillset`, `skillsets`, or `skills-set` npm packages.

MIT © [Harry Martin](https://github.com/hcjmartin)
