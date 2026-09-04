---
'@skill-set/cli': minor
---

`add` accepts shorthand sources, expanded to the full manifest URL before anything is fetched: an https URL whose last path segment is a bare set name gains `/<segment>.skill-set.json` (any host), and a bare set name with no matching local file resolves against the skill-sets.md directory — `skill-set add hash-demo` fetches `https://skill-sets.md/sets/hash-demo/hash-demo.skill-set.json`. Both forms still carry a `#sha256=` pin and fetch the sidecar lock when published. Full URLs, local paths, and existing local files behave exactly as before.
