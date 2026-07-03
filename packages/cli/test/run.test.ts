import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { run, VERSION } from '../src/run.ts'

let log: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('run', () => {
  it('prints help and exits 0 with --help', () => {
    expect(run(['--help'])).toBe(0)
    expect(log).toHaveBeenCalledOnce()
  })

  it('prints help and exits 0 with no args', () => {
    expect(run([])).toBe(0)
    expect(log).toHaveBeenCalledOnce()
  })

  it('intercepts --help even when a command precedes it', () => {
    expect(run(['update', '--help'])).toBe(0)
    expect(error).not.toHaveBeenCalled()
  })

  it('prints version and exits 0 with --version', () => {
    expect(run(['--version'])).toBe(0)
    expect(log).toHaveBeenCalledWith(VERSION)
  })

  it('exits 1 for unimplemented commands', () => {
    expect(run(['install', 'frontend'])).toBe(1)
    expect(error).toHaveBeenCalledOnce()
  })

  it('VERSION matches package.json', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } })
    expect(VERSION).toBe(pkg.default.version)
  })
})
