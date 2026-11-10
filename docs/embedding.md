# Embedding the CLI in your app

By default, skill-set installs individual skills by running the upstream [`skills`](https://github.com/vercel-labs/skills) CLI through `npx -y skills@<pin>`. That needs npm on the user's machine and downloads the installer on first use. If your app already bundles `@skill-set/cli`, you can bundle `skills` alongside it and point the CLI at it with:

```sh
SKILL_SET_UPSTREAM_SKILLS_BIN=./node_modules/skills/bin/cli.mjs
```

The bundled `skills` must match the version pinned by this CLI. Any other version fails with `ERR_SKILLSET_UPSTREAM_MISMATCH`.

## Progress events

`--json` prints one result object on stdout when the command ends. Add `--progress` to follow the run as it happens: the CLI writes one JSON event per line (NDJSON) to **stderr**, and stdout is unchanged.

```sh
skill-set add my-set --yes --json --progress
```

```json
{"v":1,"at":"2026-11-10T09:40:21.512Z","event":"manifest:fetched","name":"my-set","version":"1.0.0","members":2}
{"v":1,"at":"2026-11-10T09:40:21.530Z","event":"member:start","locator":"owner/repo@alpha","index":1,"total":2}
{"v":1,"at":"2026-11-10T09:40:23.904Z","event":"member:done","locator":"owner/repo@alpha","skill":"alpha","computedHash":"3f5a…"}
```

Every event carries `v` (the stream version, `1`), `at` (an ISO 8601 UTC timestamp) and `event`; the remaining fields depend on the event:

| Event | Fields | Emitted when |
| --- | --- | --- |
| `manifest:fetching` | `source` | `add` is about to read the manifest |
| `manifest:fetched` | `name`, `version`, `members` (count) | the manifest was read and validated |
| `lock:checking` | `url` | `add` looks for the author's lock next to the manifest |
| `lock:found` | `url` | an author lock is published there |
| `lock:absent` | — | none is published there |
| `set:written` | `path` | the set manifest was written (`add`, `init`) |
| `member:start` | `locator`, `index`, `total` | work on a member begins |
| `member:done` | `locator`, `skill`, `computedHash` | the member finished |
| `member:failed` | `locator`, `code`, `message` | the member failed; `code` is an `ERR_SKILLSET_*` code |
| `member:skipped` | `locator` | the member needed no work |
| `upstream:output` | `locator`, `text` | the `skills` CLI finished for that member |
| `verify:start` | — | `add` begins verifying what it installed |
| `verify:done` | `verifiedAgainst` | verification passed: `hash`, `sidecar`, `both`, or `null` when there was no pin or author lock to check against |
| `lock:written` | `path` | a set lock was written (`add`, `update`, `lock`) |
| `pages:built` | — | `SKILL-SET.md` and the index were regenerated |
| `done` | `ok`, `code` (on failure) | always last; mirrors the `--json` envelope's `ok` and `error.code` |

Notes for consumers:

- Paths are relative to the project root. `index` is the member's 1-based position in the manifest and `total` the manifest's member count, so a skipped member leaves a gap in the `index` sequence.
- `upstream:output.text` is the diagnostic output captured from the `skills` CLI, with terminal escape sequences removed and cut to its last 4 KB. It arrives before that member's `member:done` or `member:failed`.
- A failed verification emits no `verify:done`; the reason is the `code` on `done`.
- `add` and `install` emit `member:*` one member at a time. `update` and `remove` run the `skills` CLI once for all members, so every `member:start` precedes the results; under `remove`, a member whose skill is kept is `member:skipped` and `computedHash` is the hash of the content that was removed.
- `--dry-run` emits no `member:*` events.
- `--progress` also works without `--json`: the human output stays on stdout. Stderr can then carry other text (warnings, the error message, and under `update`/`remove` the `skills` CLI's own output), so parse only lines that begin with `{"v":`.
- New events and new fields may be added within `v: 1`; ignore what you do not recognise.

The event union is defined as a zod schema, `progressEventSchema`, in [`packages/cli/src/progress.ts`](../packages/cli/src/progress.ts).

## Dry-run payload

`skill-set add <source> --dry-run --json` fetches and validates the manifest, then stops: nothing is written, no skill is installed and the author lock is not fetched. The `data` of the result describes what a real `add` would do:

```json
{
  "name": "my-set",
  "version": "1.0.0",
  "description": "Skills for reviewing pull requests.",
  "author": { "name": "Ada Example", "url": "https://example.com/ada" },
  "homepage": "https://example.com/my-set",
  "dryRun": true,
  "wouldInstall": ["owner/repo@alpha", "owner/tools#v1.2.0"],
  "members": [
    { "locator": "owner/repo@alpha", "source": "owner/repo", "skill": "alpha" },
    { "locator": "owner/tools#v1.2.0", "source": "owner/tools", "ref": "v1.2.0" }
  ],
  "wouldVerify": { "hash": "3f5a…", "authorLock": "https://skill-sets.md/sets/my-set/my-set.skill-set.lock.json" },
  "verification": { "hash": "3f5a…", "authorLock": "https://skill-sets.md/sets/my-set/my-set.skill-set.lock.json", "plan": "both" },
  "trust": { "state": "allowlisted", "host": "skill-sets.md" }
}
```

| Field | Present | Meaning |
| --- | --- | --- |
| `name`, `version` | always | from the manifest |
| `description`, `author`, `homepage` | when the manifest has them | from the manifest; `author` is `{ name, url?, organization?, uri? }` |
| `dryRun` | always | `true` |
| `wouldInstall` | always | the member locators, in manifest order |
| `members` | always | each locator split into `source`, `skill` (when it names one) and `ref` (when it pins one), in manifest order |
| `verification` | always | `plan` plus the `hash` and `authorLock` it refers to |
| `wouldVerify` | unless `plan` is `none` | the same `hash` and `authorLock`, kept for older consumers |
| `trust` | always | how the manifest source is trusted |

`verification.plan` is what a real `add` would verify the installed content against:

| `plan` | Meaning |
| --- | --- |
| `hash` | the pinned sha256 (`--hash` or a `#sha256=` fragment) |
| `sidecar` | the author lock at `authorLock`, if one is published there |
| `both` | the pinned hash and, if published, the author lock |
| `none` | nothing: no pin, and the source has no author lock location |

`trust.state` describes the manifest source:

| `state` | Meaning |
| --- | --- |
| `allowlisted` | `host` is a recognised skill-set provider |
| `confirmed` | `host` is not recognised and the user accepted it, at the prompt or with `--yes` |
| `local` | the source is a filesystem path; there is no `host` |

`trust.owner` is set only for a GitHub host (`github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`) and is the first path segment of the URL.

Notes for consumers:

- The manifest is untrusted remote text. Escape `description`, `author`, `homepage` and the member fields before showing them.
- A dry run does not fetch the author lock, so `sidecar` and `both` say where the lock is looked for, not that one exists. The real `add` reports the outcome as `verified` in its result and as `verify:done.verifiedAgainst` in the progress stream.
- An unrecognised host needs confirmation before anything is fetched. Under `--json` without `--yes`, the command fails with `ERR_SKILLSET_CONFIRM_REQUIRED` and `error.data.host` names the host; re-run with `--yes` once the user accepts it.
- New fields may be added; ignore what you do not recognise.
