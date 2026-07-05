// Zod issue text and `keys`/`values`/`input` fields can echo the offending value —
// including remote-controlled object keys (unrecognized_keys) and literals. Manifests are
// attacker-controlled and read by agents, so validation errors describe the problem by
// position (field path) and expected shape only, never quoting the received value.

interface RawIssue {
  code: string
  path: PropertyKey[]
  expected?: unknown
  format?: unknown
}

export interface StructuralIssue {
  path: string
  code: string
  expected?: string
  format?: string
}

function at(path: PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join('.') : '(root)'
}

function reason(issue: RawIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return typeof issue.expected === 'string' ? `expected ${issue.expected}` : 'wrong type'
    case 'invalid_format':
      return typeof issue.format === 'string' ? `invalid ${issue.format} format` : 'invalid format'
    case 'unrecognized_keys':
      return 'unrecognised property'
    case 'too_small':
      return 'below the allowed minimum'
    case 'too_big':
      return 'above the allowed maximum'
    case 'invalid_value':
    case 'invalid_union':
      return 'not an allowed value'
    default:
      return 'invalid'
  }
}

/** Structural summary of Zod issues: field paths and expected shapes, no received values. */
export function structuralIssues(issues: readonly RawIssue[]): { lines: string[]; data: StructuralIssue[] } {
  const lines = issues.map((i) => `${at(i.path)}: ${reason(i)}`)
  const data = issues.map((i) => ({
    path: at(i.path),
    code: i.code,
    ...(typeof i.expected === 'string' ? { expected: i.expected } : {}),
    ...(typeof i.format === 'string' ? { format: i.format } : {}),
  }))
  return { lines, data }
}
