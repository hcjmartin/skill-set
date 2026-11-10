---
"@skill-set/cli": minor
---

Add `--progress`: live NDJSON progress events on stderr, one object per line, shaped `{"v":1,"at":"<ISO timestamp>","event":"<name>", ...fields}`. `add` and `install` report the manifest fetch, the author-lock check, each member's start, captured `skills` output, result or skip, verification, and the lock and page writes; `update` and `remove` report per-member results; every command ends with `done {ok, code?}` mirroring the `--json` envelope. stdout is untouched, so `--json --progress` still yields exactly one JSON object there, and without the flag nothing changes. Events are emitted through `ui.progress()`, a no-op unless the flag is set, and the event union is a zod schema in `src/progress.ts`. Chosen over streaming on stdout so existing `--json` consumers keep a single parseable document. See `docs/embedding.md` for the event list.
