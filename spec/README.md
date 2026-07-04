# skill-set specification

The skill-set format specification: the `<name>.skill-set.json` manifest, its JSON Schema, the set-lock format, and the conventions a conforming implementation follows.

## Layout & versioning

```
spec/
  draft/        # the ONLY mutable version — all in-flight work lands here
    README.md                 # the convention document (normative spec)
    skill-set.schema.json     # JSON Schema (draft-07)
    examples/
      valid/                  # every fixture MUST validate
      invalid/                # every fixture MUST fail for exactly one reason
  v1/           # created at first freeze — never edited afterwards
```

Rules:

- **`draft/` is mutable; frozen version directories are immutable.** A release copies `draft/` to `v<N>/`, updates the schema `$id` to the frozen URL, and never touches `v<N>/` again. Fixes to a frozen version are a new version.
- **URLs mirror this tree.** The schema is served at `https://skill-set.md/schema/<version>/skill-set.schema.json`, and each schema's `$id` is the exact URL it is served from. Published URLs are never retired; a rename is served as a `$ref` stub to the new location.
- **Breaking change ⇒ new version directory and new URL** (`/v1/` → `/v2/`). Consumers MUST NOT fall back across major versions.
- The `examples/` trees are the conformance suite: they are validated against the schema in CI and double as acceptance criteria for independent implementations.
