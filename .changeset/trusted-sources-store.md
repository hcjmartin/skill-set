---
'@skill-set/cli': minor
---

Trusted sources. `skill-set trust <source>` records a host, or a host and owner on GitHub, in a user-level `trusted-sources.json`; `add` then fetches from it without asking, and follows redirects to it. `trust --list` and `trust --remove <source>` manage the entries.

The dry-run `trust` payload gains the state `trusted`, with `scope` naming the matched entry. The `ERR_SKILLSET_CONFIRM_REQUIRED` hint now also suggests the `trust` command. Nothing else about `add` changes for a user with no trust store: an unrecognised host is still confirmed before any fetch, dry run or not.
