---
'@skill-set/cli': minor
---

`verify` now checks installed content against the set lock by default, everywhere — the previous `--frozen` semantics, with no CI/local divergence. With no set name it verifies every set in the project, with per-set results and an aggregate exit code (`3` if any set drifts). `--frozen` now means "require the lock": any targeted set without a lock exits `2`; `--no-frozen` is removed. When a set has no lock and `--frozen` is not given, verify falls back to a presence check and says explicitly that content was not verified. The delegated `npx skills check` staleness check is removed — verify never spawns the wrapped CLI; run `npx skills check` directly for per-skill staleness.
