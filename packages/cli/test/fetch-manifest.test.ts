import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchManifest } from '../src/commands/add.ts'
import type { TrustStore } from '../src/trust.ts'

// The spec §3 fetch boundary, exercised against a stubbed global fetch — no network.

afterEach(() => {
  vi.unstubAllGlobals()
})

function stub(handler: (url: string) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string | URL) => handler(String(url)))
  vi.stubGlobal('fetch', fn)
  return fn
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to } })
}

describe('fetchManifest', () => {
  it('returns the body of a 200 response', async () => {
    stub(() => new Response('{"name":"x"}'))
    const result = await fetchManifest('https://example.test/x.skill-set.json')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe('{"name":"x"}')
  })

  it('follows HTTPS redirects, resolving relative locations', async () => {
    const fetched = stub((url) => (url.endsWith('/moved') ? new Response('ok') : redirect('/moved')))
    const result = await fetchManifest('https://example.test/start')
    expect(result.ok).toBe(true)
    expect(fetched).toHaveBeenCalledTimes(2)
    expect(String(fetched.mock.calls[1]![0])).toBe('https://example.test/moved')
  })

  it('refuses a redirect that downgrades to http', async () => {
    stub(() => redirect('http://example.test/insecure'))
    const result = await fetchManifest('https://example.test/start')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('non-HTTPS')
  })

  it('caps the redirect chain at five', async () => {
    const fetched = stub((url) => redirect(`${url}x`))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('redirects')
    expect(fetched).toHaveBeenCalledTimes(6)
  })

  it('fails on a redirect without a location header', async () => {
    stub(() => new Response(null, { status: 302 }))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('without a location header')
  })

  it('reports non-2xx statuses', async () => {
    stub(() => new Response('missing', { status: 404 }))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('GET returned 404')
  })

  it('wraps network failures in the fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('socket hangup'))))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('socket hangup')
  })

  it('enforces the 1 MiB manifest cap', async () => {
    stub(() => new Response('a'.repeat(1024 * 1024 + 1)))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('MiB manifest cap')
  })

  it('refuses an over-cap declared Content-Length before reading the body', async () => {
    stub(() => new Response('tiny', { headers: { 'content-length': String(2 * 1024 * 1024) } }))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('MiB manifest cap')
  })

  it('reports a hung host as a timeout with the deadline, not a raw abort', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(timeout)))
    const result = await fetchManifest('https://example.test/a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('no response within 30s')
  })

  it('passes an abort deadline to every fetch', async () => {
    let signal: unknown
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        signal = init?.signal
        return new Response('{"name":"x"}')
      }),
    )
    await fetchManifest('https://example.test/a')
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('fails a redirect that crosses to an unrecognised host, naming only the host', async () => {
    stub(() => redirect('https://redirect-target.invalid/payload?QUERY-NOT-ECHOED'))
    const result = await fetchManifest('https://skill-set.md/x.skill-set.json')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The host is named (hosts are not remote content); the attacker-controlled path/query is not.
      expect(result.error.message).toContain('redirect-target.invalid')
      expect(result.error.message).not.toContain('QUERY-NOT-ECHOED')
      expect(result.error.message).not.toContain('payload')
    }
  })

  it('allows a redirect between two allowlisted hosts', async () => {
    const to = 'https://skill-sets.md/x.skill-set.json'
    stub((url) => (url === to ? new Response('{"name":"x"}') : redirect(to)))
    const result = await fetchManifest('https://skill-set.md/x.skill-set.json')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe('{"name":"x"}')
  })

  describe('redirects and the trust store', () => {
    const at = '2026-11-11T00:00:00.000Z'
    const store: TrustStore = {
      version: 1,
      sources: [
        { host: 'cdn.example.test', addedAt: at },
        { host: 'raw.githubusercontent.com', owner: 'hcjmartin', addedAt: at },
      ],
    }

    it('follows a redirect to a trusted host', async () => {
      stub((url) => (url.startsWith('https://cdn.example.test/') ? new Response('ok') : redirect('https://cdn.example.test/x')))
      const result = await fetchManifest('https://example.test/start', store)
      expect(result.ok).toBe(true)
    })

    it('follows a redirect to a trusted GitHub owner, and refuses another owner on that host', async () => {
      stub((url) =>
        url.startsWith('https://raw.githubusercontent.com/') ? new Response('ok') : redirect('https://raw.githubusercontent.com/HCJMartin/sets/x'),
      )
      expect((await fetchManifest('https://example.test/start', store)).ok).toBe(true)

      const fetched = stub(() => redirect('https://raw.githubusercontent.com/someone-else/sets/x'))
      const result = await fetchManifest('https://example.test/start', store)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('redirected to unrecognised host raw.githubusercontent.com')
      expect(fetched).toHaveBeenCalledTimes(1)
    })

    it('refuses a redirect to an untrusted host, with or without a store', async () => {
      const fetched = stub(() => redirect('https://elsewhere.test/x'))
      for (const result of [await fetchManifest('https://example.test/start', store), await fetchManifest('https://example.test/start')]) {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.message).toContain('redirected to unrecognised host elsewhere.test')
      }
      expect(fetched).toHaveBeenCalledTimes(2)
    })
  })
})
