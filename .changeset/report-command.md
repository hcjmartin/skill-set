---
"@skill-set/cli": minor
---

Add `skill-set report` to prefill a GitHub bug report. The CLI sends nothing: it prints the redacted body, then asks before opening the issue form in your browser. `--json` returns the URL and body with `consentRequired: true`, so an agent can file the report only after the user agrees.

`--last` fills in the most recent failure from `$XDG_CACHE_HOME/skill-set/last-error.json`. This file is written only when a run fails, is redacted before it is written, and a failed write never affects the command. Redaction turns home and cwd paths into `~` and `.` and other absolute paths into `<path>`. It strips URLs to scheme and host, masks token-shaped values and emails, and leaves out env values, file contents, git remotes, and args after `--`.

Human output for unexpected, spawn, and install failures now ends with `To report this: skill-set report --last`. The `--json` contract is unchanged. `report --security` prints the private advisory link instead.
