import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveBackendSpec } from '../src/config.ts'

describe('config: BackendSpec validation', () => {
  it('rejects undefined/null/missing config', () => {
    expect(() => resolveBackendSpec(undefined)).toThrow(/config is required/)
    expect(() => resolveBackendSpec(null)).toThrow(/config is required/)
    expect(() => resolveBackendSpec({})).toThrow(/mode must be/)
  })

  it('rejects unknown mode', () => {
    expect(() => resolveBackendSpec({ mode: 'auto', baseUrl: 'http://127.0.0.1:8766' })).toThrow(/mode must be/)
  })

  it('rejects missing baseUrl', () => {
    expect(() => resolveBackendSpec({ mode: 'attach' })).toThrow(/baseUrl is required/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: '' })).toThrow(/baseUrl is required/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: '', cwd: '/tmp', command: 'cmd' })).toThrow(/baseUrl is required/)
  })

  it('rejects invalid baseUrl', () => {
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'not-a-url' })).toThrow(/valid URL/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'ftp://example.com' })).toThrow(/http or https/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://user:pass@127.0.0.1:8766' })).toThrow(/must not contain credentials/)
  })

  it('rejects no defaults: does not read env or homedir', async () => {
    const prev = process.env.AINVESTOR_API_URL
    process.env.AINVESTOR_API_URL = 'http://evil:9999'
    try {
      expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })).not.toThrow()
      expect(() => resolveBackendSpec({ mode: 'attach' })).toThrow(/baseUrl/)
      expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '', command: 'uvicorn' })).toThrow(/explicit cwd/)
    } finally {
      if (prev === undefined) delete process.env.AINVESTOR_API_URL
      else process.env.AINVESTOR_API_URL = prev
    }
  })

  it('accepts valid attach spec and trims baseUrl', () => {
    const spec = resolveBackendSpec({ mode: 'attach', baseUrl: ' http://127.0.0.1:8766 ' })
    expect(spec).toEqual({
      mode: 'attach',
      baseUrl: 'http://127.0.0.1:8766',
      probeTimeoutMs: 2000,
      http: { requestTimeoutMs: 60000, maxResponseBytes: 5 * 1024 * 1024, responseCancelTimeoutMs: 2000 },
    })
  })

  it('canonicalizes an origin and rejects path, query, and hash', () => {
    expect(resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766/' }).baseUrl).toBe('http://127.0.0.1:8766')
    for (const baseUrl of [
      'http://127.0.0.1:8766/api',
      'http://127.0.0.1:8766//',
      'http://127.0.0.1:8766?query=1',
      'http://127.0.0.1:8766#fragment',
      'http://127.0.0.1:8766?',
      'http://127.0.0.1:8766#',
    ]) {
      expect(() => resolveBackendSpec({ mode: 'attach', baseUrl })).toThrow(/origin without a path/)
    }
  })

  it('validates and resolves configurable HTTP limits', () => {
    const spec = resolveBackendSpec({
      mode: 'attach',
      baseUrl: 'http://127.0.0.1:8766',
      http: { requestTimeoutMs: 2500, maxResponseBytes: 8192, responseCancelTimeoutMs: 75 },
    })
    expect(spec.http).toEqual({ requestTimeoutMs: 2500, maxResponseBytes: 8192, responseCancelTimeoutMs: 75 })
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', http: { requestTimeoutMs: 0 } })).toThrow(/requestTimeoutMs/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', http: { maxResponseBytes: 512 } })).toThrow(/maxResponseBytes/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', http: { requestTimeoutMs: 1.5 } })).toThrow(/requestTimeoutMs/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', http: { responseCancelTimeoutMs: 0 } })).toThrow(/responseCancelTimeoutMs/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', http: { unknown: 1 } })).toThrow(/not supported/)
  })

  it('rejects attach with spawn-only keys', () => {
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp' })).toThrow(/not supported for attach/)
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', command: 'cmd' })).toThrow(/not supported for attach/)
  })

  it('rejects spawn without cwd/command', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp' })).toThrow(/explicit command/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', command: 'cmd' })).toThrow(/explicit cwd/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: ' ', command: 'cmd' })).toThrow(/explicit cwd/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: ' ' })).toThrow(/explicit command/)
  })

  it('accepts valid spawn spec with all fields', () => {
    const spec = resolveBackendSpec({
      mode: 'spawn',
      baseUrl: 'http://127.0.0.1:8766',
      cwd: '/tmp/work',
      command: 'uvicorn',
      args: ['main:app', '--port', '8766'],
      logPath: '/tmp/backend.log',
      env: { FOO: 'bar' },
      startupTimeoutMs: 5000,
      probeIntervalMs: 100,
    })
    expect(spec).toEqual({
      mode: 'spawn',
      baseUrl: 'http://127.0.0.1:8766',
      cwd: '/tmp/work',
      command: 'uvicorn',
      args: ['main:app', '--port', '8766'],
      logPath: '/tmp/backend.log',
      env: { FOO: 'bar' },
      startupTimeoutMs: 5000,
      probeIntervalMs: 100,
      probeTimeoutMs: 2000,
      terminationGraceMs: 5000,
      forceTerminationWaitMs: 2000,
      http: { requestTimeoutMs: 60000, maxResponseBytes: 5 * 1024 * 1024, responseCancelTimeoutMs: 2000 },
    })
  })

  it('rejects the reserved instance token environment key case-insensitively', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: { DSH_AINVESTOR_INSTANCE_TOKEN: 'caller' } })).toThrow(/reserved/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: { dsh_ainvestor_instance_token: 'caller' } })).toThrow(/reserved/)
  })

  it('rejects equals signs in environment keys before load', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: { 'BAD=KEY': 'value' } })).toThrow(/must not contain an equals sign/)
  })

  it('validates spawn args and env shapes', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: 'not-array' })).toThrow(/explicit args/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [123] })).toThrow(/explicit args/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: 'not-object' })).toThrow(/env must be/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: { k: 123 } })).toThrow(/NUL-free string/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp\nworker', command: 'cmd', args: [], logPath: '/tmp/backend.log' })).toThrow(/control characters/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: ['--name\tvalue'] })).toThrow(/control characters/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: { k: 'value\n' } })).toThrow(/control characters/)
  })

  it('rejects non-plain, symbol-keyed, and accessor-hostile environments', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: new Map() })).toThrow(/plain record/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: new Date() })).toThrow(/plain record/)
    const symbolEnv = { FOO: 'bar', [Symbol('secret')]: 'value' }
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: symbolEnv })).toThrow(/keys must be strings/)
    const getterEnv = Object.defineProperty({}, 'FOO', { enumerable: true, get: () => { throw new Error('getter failed') } })
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], env: getterEnv })).toThrow(/readable record/)
    const protoEnv = JSON.parse('{"__proto__":"safe","FOO":"bar"}') as Record<string, string>
    const resolved = resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], logPath: '/tmp/backend.log', env: protoEnv })
    expect(Object.getPrototypeOf(resolved.env)).toBeNull()
    expect(resolved.env?.__proto__).toBe('safe')
  })

  it('resolves explicit lifecycle timing values for both modes', () => {
    expect(resolveBackendSpec({
      mode: 'attach',
      baseUrl: 'http://127.0.0.1:8766',
      probeTimeoutMs: 321,
    })).toMatchObject({ probeTimeoutMs: 321 })
    expect(resolveBackendSpec({
      mode: 'spawn',
      baseUrl: 'http://127.0.0.1:8766',
      cwd: '/tmp',
      command: 'cmd',
      args: [],
      logPath: '/tmp/backend.log',
      startupTimeoutMs: 600000,
      probeIntervalMs: 321,
      probeTimeoutMs: 654,
      terminationGraceMs: 987,
      forceTerminationWaitMs: 123456,
    })).toMatchObject({
      startupTimeoutMs: 600000,
      probeIntervalMs: 321,
      probeTimeoutMs: 654,
      terminationGraceMs: 987,
      forceTerminationWaitMs: 123456,
    })
  })

  it('rejects lifecycle timings outside the bounded safe-integer range', () => {
    const fields = ['startupTimeoutMs', 'probeIntervalMs', 'probeTimeoutMs', 'terminationGraceMs', 'forceTerminationWaitMs']
    for (const field of fields) {
      for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 600001]) {
        expect(() => resolveBackendSpec({
          mode: 'spawn',
          baseUrl: 'http://127.0.0.1:8766',
          cwd: '/tmp',
          command: 'cmd',
          args: [],
          logPath: '/tmp/backend.log',
          [field]: value,
        }), field + '=' + String(value)).toThrow(new RegExp(field))
      }
    }
    expect(() => resolveBackendSpec({
      mode: 'attach',
      baseUrl: 'http://127.0.0.1:8766',
      probeTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow(/probeTimeoutMs/)
  })

  it('requires and validates an explicit spawn logPath', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [] })).toThrow(/explicit logPath/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], logPath: '' })).toThrow(/logPath/)
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], logPath: 123 })).toThrow(/logPath/)
    expect(resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8766', cwd: '/tmp', command: 'cmd', args: [], logPath: '/tmp/custom.log' })).toMatchObject({ logPath: '/tmp/custom.log' })
  })

  it('rejects logPath in attach mode', () => {
    expect(() => resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766', logPath: '/tmp/x' })).toThrow(/not supported for attach/)
  })

  it('Config StandardSchema validates before side effects', async () => {
    const { Config } = await import('../src/config.ts')
    const schema = Config as unknown as { '~standard': { validate(v: unknown): { value?: unknown; issues?: { message: string }[] } } }
    const ok = schema['~standard'].validate({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    expect(ok.issues).toBeUndefined()
    expect((ok).value).toMatchObject({ mode: 'attach' })
    const bad = schema['~standard'].validate({ mode: 'attach' })
    expect(bad.issues?.[0]?.message).toMatch(/baseUrl/)
  })
})
