# The skill-set format — draft

A **skill-set** is a named, versioned set of agent skills, declared in a single JSON manifest. This document is the normative convention: an implementation that follows it can author, validate, share, resolve, and verify skill-sets without the reference CLI, and two independent implementations following it produce byte-identical locks and hashes.

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119.

## 1. The manifest — `<name>.skill-set.json`

One file per set, named `<name>.skill-set.json`, validating against [`skill-set.schema.json`](./skill-set.schema.json) (JSON Schema draft-07, `$id` = its served URL).

```json
{
  "$schema": "https://skill-set.md/schema/draft/skill-set.schema.json",
  "name": "frontend",
  "version": "1.0.0",
  "description": "Skills for authoring and reviewing frontend-facing work.",
  "author": { "name": "Harry Martin", "url": "https://github.com/hcjmartin" },
  "skills": [
    "hcjmartin/skills-repo@skill-creator",
    "vercel-labs/agent-skills@web-design-guidelines#v2.1.0",
    "https://gitlab.com/acme/agent-skills@review-code#8f7e6d5",
    "https://flocker.md/skills@research-notes"
  ]
}
```

| Field | Req | Meaning |
|---|---|---|
| `$schema` | — | URL of the schema version the manifest conforms to. SHOULD be present. |
| `name` | ✔ | Set identifier: lowercase alphanumerics + single hyphens, ≤64 chars. |
| `version` | ✔ | Semantic version of the set's *contents* (bump when membership or pins change). |
| `description` | — | What the set is for. |
| `author` | — | `{ name, url?, organization?, uri? }` — attribution; `uri` is a stable identity URI. |
| `homepage` | — | Docs or source page for the set. |
| `skills[]` | ✔ | Member skills as **opaque source-locator strings**, optionally pinned with `#<tag-or-commit>`. |

Locators are opaque to this format: their grammar is owned by the resolver an implementation uses (the reference CLI delegates to `npx skills`, which accepts GitHub shorthands, git/GitLab URLs, local paths, and well-known HTTPS domains). The format only requires that a locator is a non-empty string resolving to exactly one skill.

A member's **skill name** is the directory name of its installed folder — `.agents/skills/<skill-name>/` — as determined by the resolver at installation. Skill names are lowercase alphanumerics with single hyphens.

## 2. Validation rules

Beyond schema validation, a conforming implementation MUST enforce:

1. **Strict JSON** (RFC 8259). No comments, no trailing commas, no duplicate keys.
2. **Name ↔ filename**: `name` MUST equal the result of removing the exact suffix `.skill-set.json` from the manifest's filename. The comparison is byte-exact and case-sensitive against the filename as authored: `frontend.skill-set.json` declares `"name": "frontend"`; any mismatch is invalid.
3. **Order is non-semantic**: reordering `skills[]` does not change the set's meaning. Implementations MUST NOT attach meaning to member order, and MUST sort members deterministically wherever order becomes observable (locks, generated files, hashes).
4. **Duplicates are invalid**: two `skills[]` entries that are byte-identical strings are an error. (Two *different* locators resolving to the same skill are a resolution-time conflict, not a manifest error.)
5. **Schema versioning**: the schema URL carries its version as a path segment — `/schema/v<N>/` for releases, `/schema/draft/` pre-release. A consumer MUST reject a manifest declaring a schema version it does not support, rather than best-effort parse. When `$schema` is absent, a consumer SHOULD validate against the newest released version it supports.

## 3. Sharing & acquisition

A skill-set is shareable as **a URL to its manifest** — any HTTPS location serving the JSON file is a valid distribution point; no registry protocol is required. A consuming implementation acquires a shared set by:

1. Fetching the manifest: an HTTPS GET (or reading a local path). Implementations MAY follow redirects (SHOULD cap the chain, e.g. at 5), MUST parse the body as JSON regardless of the response `Content-Type`, and SHOULD enforce a response size cap (1 MiB is suggested).
2. Validating it (schema + the rules above).
3. Writing it into the project as `<name>.skill-set.json`, with the filename derived from the manifest's `name`. If a set file of that name already exists, the implementation MUST fail rather than silently overwrite.
4. Proceeding with normal installation, presenting the member/source summary first.

## 4. Resolution & installation

Installing a set resolves each member locator to an installed skill folder (canonical location: `.agents/skills/<skill-name>/`). Members are installed as ordinary skills — the set does not wrap or relocate them. Requirements:

- **Idempotence**: members already installed and satisfying the lock MUST be skipped.
- **Conflict detection**: before installing anything, implementations MUST detect members shared with other sets but pinned to different refs — an unresolvable conflict that MUST be reported, never resolved silently by overwriting.
- **Removal**: removing a set removes its definition; removing member folders is operator-controlled and MUST be reference-counted across other sets.

## 5. The set-lock — `<name>.skill-set.lock.json`

An optional, generated lock records exactly which bytes each member resolved to. It validates against [`skill-set.lock.schema.json`](./skill-set.lock.schema.json), and the name↔filename rule (§2.2, with suffix `.skill-set.lock.json`) applies.

```json
{
  "version": 1,
  "name": "frontend",
  "setVersion": "1.0.0",
  "setHash": "1f0a…",
  "skills": {
    "hcjmartin/skills-repo@skill-creator": {
      "skill": "skill-creator",
      "sourceType": "github",
      "ref": "a1b2c3d",
      "computedHash": "781b…"
    }
  }
}
```

| Field | Req | Meaning |
|---|---|---|
| `version` | ✔ | Lock format version, an integer (this document defines version `1`). Readers MUST fail loudly on a value they do not recognize, and MUST NOT silently discard or rewrite lock data. |
| `name` | ✔ | The set's name (equals the manifest `name`). |
| `setVersion` | ✔ | The manifest `version` at lock time. |
| `setHash` | ✔ | Rollup hash, defined below. |
| `skills` | ✔ | One entry per member, keyed by the **manifest locator string**, serialized in UTF-8-byte-order sorted keys (§7). |

Per-member entry:

| Field | Req | Meaning |
|---|---|---|
| `skill` | ✔ | The installed skill name (§1). |
| `computedHash` | ✔ | The member content hash (§6), lowercase hex. |
| `sourceType` | — | Resolver-reported source kind (e.g. `github`, `git`, `well-known`). The vocabulary is resolver-defined; implementations MUST NOT reject unknown values. |
| `ref` | — | Resolver-reported resolved ref (tag or commit), when the source has one. |

**`setHash`**: the SHA-256, in lowercase hex, over the concatenation — in UTF-8-byte-order of the locator — of `<locator>\n<computedHash>\n` for every member, all strings encoded as UTF-8.

**Serialized field order** (the §7 "unless a field specifies otherwise" carve-out, for readability): top level `version, name, setVersion, setHash, skills`; member entries `skill, computedHash, sourceType, ref` (absent optionals omitted); `skills` keys in UTF-8-byte-order.

### Verification

- **Default verify**: every locked member MUST be present at its installed location; implementations MAY compare against recorded hashes without recomputation (e.g. using other trusted records) and SHOULD say which checks ran.
- **Frozen verify** (the CI surface): implementations MUST recompute every member's content hash (§6) and compare it to the set-lock, and MUST report **all** drifted members — never only the first — each with expected and actual hash. In CI environments, frozen mode SHOULD be the default when a set-lock exists.

## 6. Member content hash

`computedHash` is a SHA-256 over the installed skill folder, fully defined by this section:

1. **Enumerate** files under the skill folder, recursively. Skip directories named exactly `.git` or `node_modules` (at any depth). Skip symbolic links entirely (do not follow them). Every other **regular file** is included; non-regular files (FIFOs, sockets, device nodes) are excluded.
2. For each file, record its **relative path** from the skill folder — with `/` as the separator on all platforms, normalized to **Unicode NFC** (filesystems disagree on the stored form: APFS reports decomposed names, most others store as written) — and its **raw bytes** (no encoding or newline normalization).
3. **Sort** the file list by lexicographic comparison of the relative paths' **UTF-8 byte sequences** (this is a locale-independent total order; distinct paths never compare equal).
4. **Hash**: feed SHA-256, for each file in sorted order: the relative path as UTF-8 bytes, a single `0x00` byte, the file's content bytes, a single `0x00` byte.
5. A folder that enumerates to zero files hashes to the SHA-256 of empty input.
6. The result is the lowercase hex digest.

> Note: this hash is deliberately self-contained and does **not** byte-match the `skills` ecosystem's internal `computeSkillFolderHash` (whose file ordering is locale-dependent). A reference implementation MAY additionally compute ecosystem-compatible hashes to interoperate with `skills-lock.json`, but that is outside this specification.
>
> Note: content bytes are hashed as stored on disk. Checkout-time filters that rewrite bytes (e.g. git `core.autocrlf` or `.gitattributes` text conversion) change the hash before any implementation runs; skill content that must verify across platforms should pin such filters off.

## 7. Generated artifacts & determinism

Everything an implementation generates from a manifest (the set-lock, any human-readable set summary, any index) MUST be deterministic: identical inputs produce identical bytes. For JSON artifacts, the required serialization is the output of ECMA-262 `JSON.stringify(value, null, 2)` — with object keys inserted in UTF-8-byte-order unless a field specifies otherwise — encoded as UTF-8 with LF line endings and a single trailing LF. No timestamps. Determinism is what makes locks merge-friendly and future signing possible.

## 8. Conformance

The [`examples/`](./examples/) trees are the executable acceptance criteria:

- every manifest under `examples/valid/` MUST validate against the schema and the §2 rules;
- every manifest under `examples/invalid/` MUST fail schema validation for exactly the one violation recorded for it in `examples/invalid/violations.json` (the machine-readable form of "one reason per fixture");
- every manifest under `examples/invalid-rules/` validates against the schema but MUST be rejected under the §2 rules;
- the lock fixtures under `examples/lock/` follow the same valid/invalid contract against the lock schema.

An independent implementation that agrees with every fixture verdict and reproduces §5–§6 hashes byte-for-byte is conforming.
