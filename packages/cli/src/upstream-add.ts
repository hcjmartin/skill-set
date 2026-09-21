import { z } from 'zod'
import { ErrorCodes, SkillSetError, type Result } from './errors.ts'

const securitySchema = z
  .object({
    gen: z.string().optional(),
    socket: z.string().optional(),
    snyk: z.string().optional(),
    details: z.string().optional(),
  })
  .nullable()

const addResultSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['installed', 'skipped', 'failed']),
  source: z.string().optional(),
  ref: z.string().nullable().optional(),
  hash: z.string().nullable().optional(),
  path: z.string().optional(),
  scope: z.enum(['project', 'global']).optional(),
  agents: z.array(z.string()).optional(),
  mode: z.string().optional(),
  security: securitySchema.optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
})

const addResultsSchema = z.array(addResultSchema)

export type UpstreamSecurity = z.infer<typeof securitySchema>
export type UpstreamAddResult = z.infer<typeof addResultSchema>

export interface UpstreamInstalledResult extends UpstreamAddResult {
  name: string
  status: 'installed'
}

/** Parses the stable `skills add --json` stdout contract. */
export function parseUpstreamAddResults(stdout: string): Result<UpstreamAddResult[]> {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (cause) {
    return invalidOutput('The skills CLI did not return valid JSON', cause)
  }
  const parsed = addResultsSchema.safeParse(value)
  if (!parsed.success) {
    return invalidOutput('The skills CLI returned JSON with an unsupported structure', parsed.error)
  }
  return { ok: true, data: parsed.data }
}

/** Selects the one installed skill that corresponds to a set member. */
export function selectInstalledResult(
  results: readonly UpstreamAddResult[],
  expectedName?: string,
): Result<UpstreamInstalledResult> {
  const failed = results.filter((entry) => entry.status === 'failed')
  if (failed.length > 0) {
    return upstreamFailure(failed.map((entry) => entry.error ?? `${entry.name ?? 'skill'} failed`).join('; '), results)
  }

  const installed = results.filter(
    (entry): entry is UpstreamInstalledResult =>
      entry.status === 'installed' && entry.name !== undefined && (expectedName === undefined || entry.name === expectedName),
  )
  if (installed.length === 1) return { ok: true, data: installed[0]! }

  const skipped = results.filter((entry) => entry.status === 'skipped')
  if (skipped.length > 0) {
    return upstreamFailure(skipped.map((entry) => entry.reason ?? `${entry.name ?? 'skill'} was skipped`).join('; '), results)
  }

  const expectation = expectedName === undefined ? 'one installed skill' : `the installed skill ${JSON.stringify(expectedName)}`
  return invalidOutput(`The skills CLI JSON did not identify ${expectation}`)
}

export type SecurityLevel = 'pass' | 'none' | 'warning' | 'issue'

export interface SecurityFinding {
  provider: 'Audit' | 'Gen' | 'Socket' | 'Snyk'
  value: string
  level: SecurityLevel
}

/** Classifies upstream security labels without discarding the original provider text. */
export function securityFindings(security: UpstreamSecurity | undefined): SecurityFinding[] {
  if (security == null) return [{ provider: 'Audit', value: 'no findings returned', level: 'none' }]
  const values: Array<[SecurityFinding['provider'], string | undefined]> = [
    ['Gen', security.gen],
    ['Socket', security.socket],
    ['Snyk', security.snyk],
  ]
  const findings = values.flatMap(([provider, value]) =>
    value === undefined ? [] : [{ provider, value, level: classifySecurityValue(value) }],
  )
  return findings.length === 0 ? [{ provider: 'Audit', value: 'no findings returned', level: 'none' }] : findings
}

function classifySecurityValue(value: string): SecurityLevel {
  const normalized = value.trim().toLowerCase()
  if (/\b(critical|high|unsafe|malicious|blocked|failed?|danger(?:ous)?)\b/.test(normalized)) return 'issue'
  if (/\b(low|medium|warn(?:ing)?|review|unknown|unavailable|pending)\b/.test(normalized)) return 'warning'
  if (/\b(safe|passed?|clean|none|no (?:alerts?|issues?)|0 alerts?)\b/.test(normalized)) return 'pass'
  return 'warning'
}

function invalidOutput(message: string, cause?: unknown): Result<never> {
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.RESOLVE_FAILED, message, {
      hint: 'The pinned skills CLI changed its add --json contract. Check upstream compatibility.',
      ...(cause === undefined ? {} : { cause }),
    }),
  }
}

function upstreamFailure(message: string, results: readonly UpstreamAddResult[]): Result<never> {
  return {
    ok: false,
    error: new SkillSetError(ErrorCodes.RESOLVE_FAILED, `The skills CLI did not install the member: ${message}`, {
      data: { upstreamResults: results },
    }),
  }
}
