---
'@skill-set/cli': patch
---

Hashing now delegates its canonical framing to `@skill-set/core`; the CLI keeps the filesystem adapter and a synchronous `node:crypto` digest. No behavior change — outputs are byte-identical, cross-checked in tests.
