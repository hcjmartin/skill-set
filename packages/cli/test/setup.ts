import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Failing runs record last-error.json; keep every test's writes out of the real ~/.cache.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'skill-set-cache-'))
