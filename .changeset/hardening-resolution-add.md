---
'@skill-set/cli': patch
---

Harden `add` and `install` against untrusted and ambiguous inputs. Remote manifest free text in the `add` provenance summary renders as quoted, control-stripped, length-capped data (description 128 chars, author 64) — output only, fetched bytes untouched. Unnamed member locators are pre-probed with a no-write upstream `--list` before install: a source containing more than one skill fails early (`RESOLVE_AMBIGUOUS`) with nothing written to disk. Docs, schemas, and examples now correctly describe pins as `#<tag-or-branch>` — commit SHAs are not supported by the upstream resolver.
