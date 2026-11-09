---
"@skill-set/cli": minor
---

Honour `SKILL_SET_UPSTREAM_SKILLS_BIN` to run a vendored `skills` CLI instead of `npx`. Set it to the `bin/cli.mjs` of an installed `skills` package; the nearest `package.json` must match the pinned name and version, otherwise `add` and `install` fail with `ERR_SKILLSET_UPSTREAM_MISMATCH` before anything is fetched, written or spawned. It runs under `process.execPath`, so an Electron-as-Node embedder's child inherits `ELECTRON_RUN_AS_NODE`. Unset, every invocation is unchanged. Upstream launch and checking now live on one `UpstreamSpec` (`skillsUpstream`), the shape a second upstream would implement.
