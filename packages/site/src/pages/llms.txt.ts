import type { APIRoute } from 'astro'

const body = `# skill-set

> Named, versioned sets of agent skills, defined in a single JSON manifest. An open format and CLI for sharing, installing, and verifying skill-sets, with deterministic locks and content hashing.

## Agent skill

- [skill-set skill](https://www.skills.sh/hcjmartin/skill-set/skill-set): \`npx skills add hcjmartin/skill-set\` — installs the skill that teaches an agent to create, share, install, and verify skill-sets with this CLI.

## Docs

- [Home](https://skill-set.md/): What a skill-set is, an example manifest, and how the CLI installs, locks, and verifies.
- [CLI](https://skill-set.md/cli/): Commands for authoring, installing, locking, and verifying skill-sets.
- [Specification](https://skill-set.md/spec/): The normative format — manifest, validation, resolution, the set-lock, content hashing, determinism, and conformance.
- [FAQ](https://skill-set.md/faq/): Common questions about the format and CLI.

## Schemas

- [Manifest schema](https://skill-set.md/schema/draft/skill-set.schema.json): JSON Schema (draft-07) for a \`<name>.skill-set.json\` manifest.
- [Set-lock schema](https://skill-set.md/schema/draft/skill-set.lock.schema.json): JSON Schema (draft-07) for the deterministic set-lock.

## Reporting CLI problems

- [skill-set report](https://skill-set.md/cli/#report): \`skill-set report --last --json\` returns a redacted, prefilled GitHub issue (\`url\`, \`title\`, \`body\`) with \`consentRequired: true\`. Show the user the body and file it only after they agree, via the URL or \`gh issue create --repo hcjmartin/skill-set\`.

## Source

- [GitHub](https://github.com/hcjmartin/skill-set): Spec, reference CLI, and schemas.
- [npm: @skill-set/cli](https://www.npmjs.com/package/@skill-set/cli): The reference command-line implementation.

## Optional

- [Full spec](https://skill-set.md/llms-full.txt): The complete specification as a single markdown document.
`

export const GET: APIRoute = () =>
  new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
