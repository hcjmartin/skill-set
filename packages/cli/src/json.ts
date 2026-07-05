import { ErrorCodes, SkillSetError, type Result } from './errors.ts'

/** Lexicographic comparison of UTF-8 byte sequences — the spec's deterministic order (§2.3/§7). */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Parse per spec §2.1: valid RFC 8259 JSON with duplicate object keys rejected. */
export function parseStrictJson(text: string, context?: string): Result<unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    // The V8 parse message (RFC 8259 grammar violations) quotes the offending bytes; for
    // attacker-supplied manifests that would echo remote content, so the message stays
    // structural and the detail rides on `cause`.
    return {
      ok: false,
      error: new SkillSetError(ErrorCodes.INVALID_JSON, `${context ?? 'Input'} is not valid JSON`, { cause }),
    }
  }
  const dup = findDuplicateKey(text)
  if (dup !== undefined) {
    // The duplicated key is remote-controlled text, so it is not named in the error (spec §2.1).
    return {
      ok: false,
      error: new SkillSetError(
        ErrorCodes.INVALID_JSON,
        `${context ?? 'Input'} contains a duplicate object key`,
        { hint: 'Skill-set files forbid duplicate keys — remove one of the entries.' },
      ),
    }
  }
  return { ok: true, data: value }
}

// text is known-valid JSON at this point; a string is a key if we are inside an
// object and the next non-whitespace character after it is ':'.
function findDuplicateKey(text: string): string | undefined {
  const stack: Array<Set<string> | null> = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const end = scanStringEnd(text, i)
      const top = stack[stack.length - 1]
      if (top instanceof Set) {
        let j = end
        while (j < text.length && ' \t\n\r'.includes(text[j]!)) j++
        if (text[j] === ':') {
          const key = JSON.parse(text.slice(i, end)) as string
          if (top.has(key)) return key
          top.add(key)
        }
      }
      i = end
    } else if (c === '{') {
      stack.push(new Set())
      i++
    } else if (c === '[') {
      stack.push(null)
      i++
    } else if (c === '}' || c === ']') {
      stack.pop()
      i++
    } else {
      i++
    }
  }
  return undefined
}

function scanStringEnd(text: string, openQuote: number): number {
  let i = openQuote + 1
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') i += 2
    else if (c === '"') return i + 1
    else i++
  }
  return i
}
