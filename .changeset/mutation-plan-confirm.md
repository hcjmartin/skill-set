---
'@skill-set/cli': minor
---

`remove` and `update` now plan before they mutate. `remove` prints the full removal plan (set artifacts, removable and kept skills, the upstream cleanup command) and collects both confirmations up front; accepted skill cleanup runs before the set definition is deleted, so a failed cleanup leaves the set installed for a retry. `update` prints the update plan and the upstream mutation boundary, and asks one confirmation before spawning; `--yes`, `--json`, and non-interactive runs are unaffected, and `--dry-run` now lists the members while spawning nothing.
