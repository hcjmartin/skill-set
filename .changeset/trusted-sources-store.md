---
'@skill-set/cli': minor
---

Trusted sources. `skill-set trust <source>` records a host, or a host and owner on GitHub, in a user-level `trusted-sources.json`; `add` then fetches from it without asking, and follows redirects to it. `trust --list` and `trust --remove <source>` manage the entries.

Behaviour change: `add --dry-run` on an unrecognised host no longer prompts or fails with `ERR_SKILLSET_CONFIRM_REQUIRED`. It reads the manifest and reports `trust.state: "untrusted"`. A real `add` is unchanged and still needs the confirmation or `--yes`.

The dry-run `trust` payload gains the states `trusted` (with `scope`, the matched entry) and `untrusted`.
