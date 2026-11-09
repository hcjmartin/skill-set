# Embedding the CLI in your app

By default, skill-set installs individual skills by running the upstream [`skills`](https://github.com/vercel-labs/skills) CLI through `npx -y skills@<pin>`. That needs npm on the user's machine and downloads the installer on first use. If your app already bundles `@skill-set/cli`, you can bundle `skills` alongside it and point the CLI at it with:

```sh
SKILL_SET_UPSTREAM_SKILLS_BIN=./node_modules/skills/bin/cli.mjs
```

The bundled `skills` must match the version pinned by this CLI. Any other version fails with `ERR_SKILLSET_UPSTREAM_MISMATCH`.
