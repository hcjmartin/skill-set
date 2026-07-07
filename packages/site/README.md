# @skill-set/site

The documentation site for skill-set, served at [skill-set.md](https://skill-set.md). A static Astro site deployed to Cloudflare Workers (static assets, no worker script, no client JS).

## Content flows from the repo

Nothing on the site is hand-duplicated from the spec:

- The [spec page](https://skill-set.md/spec/) imports `spec/draft/README.md` directly (`src/pages/spec.astro`), so the document renders from the repo at build time. Relative links inside it (`./skill-set.schema.json`, `./examples/…`) are rewritten to their served/GitHub locations by a rehype plugin in `astro.config.mjs`.
- The schemas are copied byte-identically from `spec/<version>/*.schema.json` into `public/schema/<version>/` by the `sync-spec-schemas` integration on every dev/build startup, so the built site serves:
  - `/schema/draft/skill-set.schema.json`
  - `/schema/draft/skill-set.lock.schema.json`

  `public/schema/` is gitignored — the spec directory is the only source of truth. When `spec/v1/` lands at spec freeze, `/schema/v1/…` is served automatically with no site change.

## Workspace notes

- Astro's dependency tree includes two packages with install-time build scripts, `esbuild` and `sharp`. pnpm requires them to be reviewed in `pnpm-workspace.yaml`; both ship prebuilt binaries as optional dependencies, so the right review is to keep their scripts off:

  ```yaml
  allowBuilds:
    esbuild: false
    sharp: false
  ```

  Until that is set, `pnpm install` exits non-zero (`ERR_PNPM_IGNORED_BUILDS`).
- Astro regenerates a `.astro/` codegen directory on every run; the `clean-codegen` integration removes it after builds and dev-server shutdown so the repo-root `eslint .` never sees the generated `.d.ts` files. Run `pnpm --filter @skill-set/site exec astro sync` if you want editor types while editing the site (the next build cleans them up again).

## Local commands

From the repo root (or in this directory without the `--filter`):

```sh
pnpm install
pnpm --filter @skill-set/site dev       # dev server at localhost:4321
pnpm --filter @skill-set/site build     # static build into packages/site/dist/
pnpm --filter @skill-set/site preview   # serve the built output locally
pnpm --filter @skill-set/site deploy    # build + wrangler deploy (needs a Cloudflare login)
```

For a manual deploy, `wrangler` prompts for browser login, or reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. Pushes to `main` that touch `packages/site/` or `spec/` deploy automatically via `.github/workflows/deploy-site.yml`, which skips cleanly until the Cloudflare secrets are set.

## Structure

```
astro.config.mjs        # site config, schema sync + codegen cleanup, spec-link rewriting, heading anchors
src/layouts/Base.astro  # head, nav, footer, all styles
src/layouts/Doc.astro   # layout for markdown pages (cli, faq)
src/pages/index.astro   # landing: what it is, manifest, quickstart, sharing
src/pages/cli.md        # command reference, global flags, exit codes, --json envelope
src/pages/spec.astro    # imports and renders spec/draft/README.md with a table of contents
src/pages/faq.md        # project layout, cross-set conflicts, CI verification
src/pages/404.astro
wrangler.jsonc          # Cloudflare static-assets config
```
