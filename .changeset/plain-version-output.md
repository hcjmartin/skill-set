---
'@skill-set/cli': patch
---

`--version` prints just `skill-set/<version>`; the `(wraps skills@<pin>, pinned)` suffix is gone. The upstream pin still shows where it acts — every spawned invocation prints as `npx skills@<pin> …`.
