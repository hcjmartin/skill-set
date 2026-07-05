import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchManifest } from '../src/commands/add.ts'

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
})
