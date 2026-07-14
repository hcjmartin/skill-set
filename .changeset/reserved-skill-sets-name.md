---
'@skill-set/cli': minor
---

Reserve the `skill-sets` skill name and protect set definitions from upstream installs.

Set definitions live at `.agents/skills/skill-sets/`, inside the skills directory. Installing any skill named `skill-sets` let the upstream CLI overwrite that directory wholesale — destroying every installed set definition and crashing `add` with a raw ENOENT. The first-party skill shipped under that very name; it is now published as `skill-set`.

- Members naming the reserved skill (`…@skill-sets`) are refused before anything is fetched, spawned, or written (`ERR_SKILLSET_RESERVED_NAME`).
- Unnamed members that _resolve_ to the reserved name are refused post-spawn, with the set-definitions directory restored byte-exact from a pre-spawn snapshot and the stray upstream lock entry dropped.
- Every upstream spawn (install, update, remove) is bracketed by that snapshot/restore, with a notice when a restore fires.
- Set-file writes create their parent directory first, so a vanished set dir surfaces as a structured error, never a raw ENOENT.
- Spec §4 now documents the canonical sets directory and the reserved-name rule.

Migrating an existing install of the old skill: delete the stray `SKILL.md` from `.agents/skills/skill-sets/` (keep the set folders), drop the `skill-sets` entry from `skills-lock.json`, then `npx skills add hcjmartin/skill-set@skill-set`. Do **not** run `npx skills remove skill-sets` — it removes the whole directory, set definitions included.
