# Hash vectors

Golden vectors for the two hash recipes: [`folder-hash-vectors.json`](./folder-hash-vectors.json) for the member content hash (§6, `skill-set/folder-v1`) and [`set-hash-vectors.json`](./set-hash-vectors.json) for the `setHash` rollup (§5, `skill-set/set-v1`). A conforming implementation reproduces every `expected` digest exactly.

The vectors are JSON, not on-disk folders, deliberately: checked-out fixture folders would not survive the round trip — filesystems disagree on filename normalization (APFS decomposes) and git filters can rewrite content bytes — which is exactly the class of divergence the recipes are designed to erase. The JSON gives each implementation identical `(path, bytes)` inputs; enumerating a real folder into such pairs is the platform-specific part left to the implementation.

## Folder vector format

Each vector lists a skill folder's files:

- `path` — relative path, `/`-separated. Given as enumerated, which may be a non-NFC form (`nfd-path-normalizes-to-nfc` gives `e` + combining U+0301); the implementation normalizes to NFC per §6.2.
- `contentUtf8` **or** `contentBase64` — exactly one. `contentUtf8` is the file's bytes as a UTF-8 string (escapes decoded, no newline translation); `contentBase64` is raw bytes, for content that is not valid UTF-8.
- `expected` — the lowercase hex digest per §6.

## Set vector format

Each vector gives `members` (locator → `computedHash`) and the `expected` rollup per §5. Locators are hashed as given — no normalization applies to them.

Failing `byte-order-not-locale-order` or `utf8-byte-sort-not-utf16` indicates sorting with locale collation or UTF-16 code units instead of UTF-8 bytes; failing `nfd-path-normalizes-to-nfc` indicates missing NFC path normalization.
