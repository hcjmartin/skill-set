import * as z from 'zod'
import { stripTerminalSequences } from './terminal-text.ts'

/** Wire version of the `--progress` event stream (docs/embedding.md). */
export const PROGRESS_VERSION = 1

/** Byte cap on `upstream:output.text`. */
export const UPSTREAM_TAIL_BYTES = 4096

const envelope = { v: z.literal(PROGRESS_VERSION), at: z.iso.datetime() }

function event<Name extends string, Shape extends z.ZodRawShape>(name: Name, shape: Shape) {
  return z.strictObject({ ...envelope, event: z.literal(name), ...shape })
}

const locator = z.string()
const verifiedAgainst = z.enum(['hash', 'sidecar', 'both']).nullable()

export const progressEventSchema = z.discriminatedUnion('event', [
  event('manifest:fetching', { source: z.string() }),
  event('manifest:fetched', { name: z.string(), version: z.string(), members: z.number().int().nonnegative() }),
  event('lock:checking', { url: z.string() }),
  event('lock:found', { url: z.string() }),
  event('lock:absent', {}),
  event('set:written', { path: z.string() }),
  event('member:start', { locator, index: z.number().int().positive(), total: z.number().int().positive() }),
  event('member:done', { locator, skill: z.string(), computedHash: z.string() }),
  event('member:failed', { locator, code: z.string(), message: z.string() }),
  event('member:skipped', { locator }),
  event('upstream:output', { locator, text: z.string() }),
  event('verify:start', {}),
  event('verify:done', { verifiedAgainst }),
  event('lock:written', { path: z.string() }),
  event('pages:built', {}),
  event('done', { ok: z.boolean(), code: z.string().optional() }),
])

export type ProgressEvent = z.infer<typeof progressEventSchema>
export type ProgressEventName = ProgressEvent['event']

type WithoutEnvelope<E> = E extends unknown ? Omit<E, 'v' | 'at'> : never
/** What commands hand to `ui.progress`; the emitter stamps `v` and `at`. */
export type ProgressEventInput = WithoutEnvelope<ProgressEvent>

/** One NDJSON line for an event, envelope fields first. */
export function serializeProgressEvent(input: ProgressEventInput, at: Date = new Date()): string {
  return `${JSON.stringify({ v: PROGRESS_VERSION, at: at.toISOString(), ...input })}\n`
}

/** Captured upstream output as plain text, cut to its last UPSTREAM_TAIL_BYTES on a character boundary. */
export function upstreamTail(output: string): string {
  const bytes = Buffer.from(stripTerminalSequences(output).trim(), 'utf8')
  let start = Math.max(0, bytes.length - UPSTREAM_TAIL_BYTES)
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}
