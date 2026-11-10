---
"@skill-set/cli": minor
---

`add --dry-run --json` returns a richer payload. Beside the existing `name`, `dryRun`, `wouldInstall` and `wouldVerify`, it now carries the manifest's `version`, `description`, `author` and `homepage` (each only when present), `members` (each locator split into `{ locator, source, skill?, ref? }`, in manifest order), `verification` (`{ hash?, authorLock?, plan }`, where `plan` is `hash`, `sidecar`, `both` or `none`) and `trust` (`{ state, host?, owner? }`, where `state` is `allowlisted`, `confirmed` or `local`, and `owner` is set for a GitHub host). Existing fields are unchanged. `ERR_SKILLSET_CONFIRM_REQUIRED` for an unrecognised host now includes `data.host`; when it is raised is unchanged. The human dry-run output says so when nothing would be verified. See `docs/embedding.md` for the payload.
