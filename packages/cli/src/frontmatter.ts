const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Minimal YAML frontmatter reader for SKILL.md files: extracts the `description` scalar.
 * Covers the forms the skills ecosystem actually uses — plain, single/double-quoted, and
 * block scalars — without taking a YAML dependency. Anything unreadable returns undefined;
 * callers treat a missing description as "none recorded".
 */
export function readSkillDescription(markdown: string): string | undefined {
  const fm = FRONTMATTER.exec(markdown)?.[1]
  if (fm === undefined) return undefined
  const lines = fm.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^description:\s*(.*)$/.exec(lines[i]!)
    if (m === null) continue
    const rest = m[1]!.trim()

    if (rest === '' || /^[|>][+-]?$/.test(rest)) {
      // Block scalar: gather the following indented lines; '|' keeps breaks, '>' folds.
      const block: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!
        if (line.trim() === '') {
          block.push('')
          continue
        }
        if (!/^\s/.test(line)) break
        block.push(line.replace(/^\s+/, ''))
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop()
      const text = rest.startsWith('|') ? block.join('\n') : block.join(' ').replaceAll(/ {2,}/g, ' ').trim()
      return text === '' ? undefined : text
    }
    if (rest.startsWith('"')) {
      // YAML double-quoted scalars are a superset of JSON strings; fall back to a bare strip.
      try {
        return JSON.parse(rest) as string
      } catch {
        return rest.slice(1, rest.endsWith('"') ? -1 : undefined)
      }
    }
    if (rest.startsWith("'")) {
      return rest.slice(1, rest.endsWith("'") ? -1 : undefined).replaceAll("''", "'")
    }
    return rest
  }
  return undefined
}
