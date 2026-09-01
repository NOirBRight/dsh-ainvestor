import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { probeLive, ensureBackend, StartupCancellationError } from '../src/backend.ts'
import { INSTANCE_TOKEN_ENV, resolveBackendSpec, type ResolvedBackendSpec } from '../src/config.ts'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: vi.fn() }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, closeSync: vi.fn(actual.closeSync) }
})

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void
type ErrorListener = (error: Error) => void
type FakeChild = {
  readonly pid: number
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly on: ReturnType<typeof vi.fn>
  readonly removeListener: ReturnType<typeof vi.fn>
  readonly kill: ReturnType<typeof vi.fn>
  emitExit(code: number | null, signal: NodeJS.Signals | null): void
  emitError(error: Error): void
}

type KillMode = 'term-exit' | 'kill-exit' | 'never'

function createFakeChild(pid: number, killMode: KillMode = 'term-exit'): FakeChild {
  let exitListener: ExitListener | undefined
  let errorListener: ErrorListener | undefined
  const child = { stdout: new PassThrough(), stderr: new PassThrough() } as unknown as FakeChild
  child.on = vi.fn((event: string, listener: ExitListener | ErrorListener) => {
    if (event === 'exit') exitListener = listener as ExitListener
    if (event === 'error') errorListener = listener as ErrorListener
    return child
  })
  child.removeListener = vi.fn((event: string, listener: ExitListener | ErrorListener) => {
    if (event === 'exit' && exitListener === listener) exitListener = undefined
    if (event === 'error' && errorListener === listener) errorListener = undefined
    return child
  })
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === 'SIGTERM' && killMode === 'term-exit') exitListener?.(0, signal)
    if (signal === 'SIGKILL' && killMode !== 'never') exitListener?.(null, signal)
    return true
  })
  Object.defineProperty(child, 'pid', { configurable: true, enumerable: true, value: pid })
  child.emitExit = (code, signal): void => exitListener?.(code, signal)
  child.emitError = error => errorListener?.(error)
  return child
}

function response(ok: boolean, token?: string, body: ReadableStream<Uint8Array> | null = null, text = '{}'): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'x-dsh-ainvestor-instance-token' ? token ?? null : null
      },
    },
    body,
    text: async () => text,
  } as unknown as Response
}

function spawnSpec(tmpHome: string, port: number, overrides: Record<string, unknown> = {}): ResolvedBackendSpec {
  return resolveBackendSpec({
    mode: 'spawn',
    baseUrl: 'http://127.0.0.1:' + port,
    cwd: tmpHome,
    command: 'uvicorn',
    args: [],
    logPath: join(tmpHome, 'backend-test.log'),
    startupTimeoutMs: 80,
    probeIntervalMs: 5,
    probeTimeoutMs: 10,
    terminationGraceMs: 10,
    forceTerminationWaitMs: 10,
    ...overrides,
  })
}

function tokenFromSpawn(): string {
  const call = vi.mocked(spawn).mock.calls[0]
  const options = call?.[2] as { env?: Record<string, string> } | undefined
  const token = options?.env?.[INSTANCE_TOKEN_ENV]
  if (token === undefined) throw new Error('test child token was not injected')
  return token
}

function errorDetails(value: unknown, seen = new Set<object>()): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return String(value)
  if (seen.has(value)) return ''
  seen.add(value)
  if (value instanceof AggregateError) {
    const nested = value.errors.map(error => errorDetails(error, seen)).join(' ')
    const cause = 'cause' in value ? errorDetails((value as Error & { readonly cause?: unknown }).cause, seen) : ''
    return [value.name, value.message, value.stack, nested, cause].join(' ')
  }
  if (value instanceof Error) {
    const cause = 'cause' in value ? errorDetails((value as Error & { readonly cause?: unknown }).cause, seen) : ''
    return [value.name, value.message, value.stack, cause].join(' ')
  }
  if (Array.isArray(value)) return value.map(error => errorDetails(error, seen)).join(' ')
  return Object.values(value).map(entry => errorDetails(entry, seen)).join(' ')
}

describe('backend: authenticated ownership and quiescent teardown', () => {
  let originalFetch: typeof fetch
  let originalHome: string | undefined
  let tmpHome: string

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalHome = process.env.DSH_HOME
    tmpHome = mkdtempSync(join(tmpdir(), 'dsh-ainvestor-'))
    process.env.DSH_HOME = tmpHome
    vi.restoreAllMocks()
    vi.mocked(spawn).mockReset()
    vi.mocked(closeSync).mockClear()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    rmSync(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('probeLive accepts ordinary attach readiness and exact token echo only', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response(true, 'expected-token'))
      .mockResolvedValueOnce(response(true, 'other-token'))
      .mockResolvedValueOnce(response(true)) as unknown as typeof fetch
    await expect(probeLive('http://127.0.0.1:8766', undefined, 20)).resolves.toBe(true)
    await expect(probeLive('http://127.0.0.1:8766', undefined, 20, 'expected-token')).resolves.toBe(true)
    await expect(probeLive('http://127.0.0.1:8766', undefined, 20, 'expected-token')).resolves.toBe(false)
    await expect(probeLive('http://127.0.0.1:8766', undefined, 20, 'expected-token')).resolves.toBe(false)
  })

  it('probeLive bounds a response body cancel that never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    globalThis.fetch = vi.fn(async () => response(true, undefined, { cancel } as unknown as ReadableStream<Uint8Array>)) as unknown as typeof fetch
    const started = Date.now()
    await expect(probeLive('http://127.0.0.1:8766', undefined, 10)).resolves.toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('probeLive cancels non-success and wrong-token response bodies', async () => {
    const firstCancel = vi.fn(async () => undefined)
    const secondCancel = vi.fn(async () => undefined)
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(false, undefined, { cancel: firstCancel } as unknown as ReadableStream<Uint8Array>))
      .mockResolvedValueOnce(response(true, 'wrong', { cancel: secondCancel } as unknown as ReadableStream<Uint8Array>)) as unknown as typeof fetch
    await expect(probeLive('http://127.0.0.1:8766', undefined, 20, 'expected')).resolves.toBe(false)
    await expect(probeLive('http://127.0.0.1:8766', undefined, 20, 'expected')).resolves.toBe(false)
    expect(firstCancel).toHaveBeenCalledOnce()
    expect(secondCancel).toHaveBeenCalledOnce()
  })

  it('probeLive consumes a response that arrives after caller cancellation', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(async () => undefined)
    let resolveResponse!: (value: Response) => void
    globalThis.fetch = vi.fn(() => new Promise<Response>(resolve => { resolveResponse = resolve })) as unknown as typeof fetch
    const pending = probeLive('http://127.0.0.1:8766', controller.signal, 100, 'expected')
    controller.abort()
    resolveResponse(response(true, 'wrong', { cancel } as unknown as ReadableStream<Uint8Array>))
    await expect(pending).resolves.toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('attach uses ordinary /live and never spawns or kills', async () => {
    globalThis.fetch = vi.fn(async () => response(true)) as unknown as typeof fetch
    const spec = resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    const handle = await ensureBackend(spec, () => {})
    expect(handle.mode).toBe('attached')
    await handle.dispose()
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('spawn always starts the child and rejects a missing handshake from an existing responder', async () => {
    const fakeChild = createFakeChild(1001)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async () => response(true)) as unknown as typeof fetch
    await expect(ensureBackend(spawnSpec(tmpHome, 8767), () => {})).rejects.toThrow(/authenticated readiness/)
    expect(vi.mocked(spawn)).toHaveBeenCalledOnce()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(tokenFromSpawn()).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('spawn rejects a wrong handshake token and never exposes it in logs', async () => {
    const fakeChild = createFakeChild(1002)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async () => response(true, 'wrong-token')) as unknown as typeof fetch
    const lines: string[] = []
    await expect(ensureBackend(spawnSpec(tmpHome, 8768), line => lines.push(line))).rejects.toThrow(/authenticated readiness/)
    const token = tokenFromSpawn()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(lines.join(' ')).toContain(join(tmpHome, 'backend-test.log'))
    expect(lines.join(' ')).not.toContain(token)
    expect(lines.join(' ')).not.toContain(INSTANCE_TOKEN_ENV)
  })

  it('forwards only safe configured env, injects one token, and keeps it out of logs', async () => {
    const fakeChild = createFakeChild(1003)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    const lines: string[] = []
    process.env.AMBIENT_API_KEY = 'ambient-secret'
    globalThis.fetch = vi.fn(async () => response(true, tokenFromSpawn())) as unknown as typeof fetch
    const handle = await ensureBackend(spawnSpec(tmpHome, 8769, {
      env: { LANG: 'C.UTF-8', SAFE: 'yes', API_KEY: 'secret', ACCESS_TOKEN: 'secret', PASSWORD: 'secret' },
    }), line => lines.push(line))
    delete process.env.AMBIENT_API_KEY
    const token = tokenFromSpawn()
    const call = vi.mocked(spawn).mock.calls[0]
    const options = call?.[2] as { env: Record<string, string>; stdio: readonly unknown[] }
    expect(options.env).toEqual({ LANG: 'C.UTF-8', [INSTANCE_TOKEN_ENV]: token })
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(token.length).toBeGreaterThanOrEqual(40)
    expect(lines.join(' ')).not.toContain(token)
    expect(lines.join(' ')).not.toContain(INSTANCE_TOKEN_ENV)
    await handle.dispose()
    const firstListenerRemoval = fakeChild.removeListener.mock.invocationCallOrder[0]
    const firstKill = fakeChild.kill.mock.invocationCallOrder[0]
    expect(firstListenerRemoval).toBeLessThan(firstKill)
  })

  it('redacts a token split across child stdout and stderr', async () => {
    const fakeChild = createFakeChild(10031)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async () => {
      const token = tokenFromSpawn()
      const split = Math.floor(token.length / 2)
      fakeChild.stdout.write('stdout prefix ' + token.slice(0, split))
      fakeChild.stderr.write(token.slice(split) + ' stdout suffix\n')
      return response(true, token)
    }) as unknown as typeof fetch
    const handle = await ensureBackend(spawnSpec(tmpHome, 8779), () => {})
    const token = tokenFromSpawn()
    await handle.dispose()
    const contents = readFileSync(join(tmpHome, 'backend-test.log'), 'utf8')
    expect(contents).toContain('stdout prefix ')
    expect(contents).toContain('[redacted]')
    expect(contents).toContain(' stdout suffix')
    expect(contents).not.toContain(token)
  })

  it('rejects user attempts to set the reserved token environment key before spawn', () => {
    expect(() => resolveBackendSpec({ mode: 'spawn', baseUrl: 'http://127.0.0.1:8770', cwd: tmpHome, command: 'uvicorn', args: [], env: { [INSTANCE_TOKEN_ENV]: 'caller' } })).toThrow(/reserved/)
    expect(vi.mocked(spawn)).not.toHaveBeenCalled()
  })

  it('fails when the child exits while a concurrent responder is live and cleans owned state', async () => {
    const fakeChild = createFakeChild(1004)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async () => {
      fakeChild.emitExit(1, null)
      return response(true, 'wrong-token')
    }) as unknown as typeof fetch
    await expect(ensureBackend(spawnSpec(tmpHome, 8771), () => {})).rejects.toThrow(/exited during startup/)
    expect(fakeChild.kill).not.toHaveBeenCalled()
    expect(fakeChild.removeListener).toHaveBeenCalled()
  })

  it('treats child error as non-quiescent, then sends SIGTERM and SIGKILL', async () => {
    const fakeChild = createFakeChild(1005, 'kill-exit')
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const lines: string[] = []
    const pending = ensureBackend(spawnSpec(tmpHome, 8772), line => lines.push(line))
    const childToken = tokenFromSpawn()
    setTimeout(() => fakeChild.emitError(new Error('child error token=' + childToken)), 5)
    await expect(pending).rejects.toThrow(/child error/)
    await expect(pending).rejects.not.toThrow(childToken)
    expect(lines.join(' ')).not.toContain(childToken)
    expect(fakeChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(fakeChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('cancellation during authenticated startup terminates the owned child', async () => {
    const fakeChild = createFakeChild(1006)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const controller = new AbortController()
    const pending = ensureBackend(spawnSpec(tmpHome, 8773), () => {}, controller.signal)
    setTimeout(() => controller.abort(), 5)
    await expect(pending).rejects.toThrow(/startup probe aborted/)
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('logger failure after spawn runs owned cleanup instead of leaking the child', async () => {
    const fakeChild = createFakeChild(1007)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn(async () => response(true, tokenFromSpawn())) as unknown as typeof fetch
    await expect(ensureBackend(spawnSpec(tmpHome, 8774), () => { throw new Error('logger failure') })).rejects.toThrow('logger failure')
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('waits after kill(false) and ignores that result when exit arrives during grace', async () => {
    const fakeChild = createFakeChild(1008, 'never')
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    fakeChild.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') setTimeout(() => fakeChild.emitExit(0, signal), 1)
      return false
    })
    globalThis.fetch = vi.fn(async () => response(true, tokenFromSpawn())) as unknown as typeof fetch
    const handle = await ensureBackend(spawnSpec(tmpHome, 8775), () => {})
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(fakeChild.kill).toHaveBeenCalledTimes(1)
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('waits after SIGKILL false and ignores that result when exit arrives during force wait', async () => {
    const fakeChild = createFakeChild(1011, 'never')
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    fakeChild.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') setTimeout(() => fakeChild.emitExit(null, signal), 1)
      return signal === 'SIGTERM'
    })
    globalThis.fetch = vi.fn(async () => response(true, tokenFromSpawn())) as unknown as typeof fetch
    const handle = await ensureBackend(spawnSpec(tmpHome, 8779), () => {})
    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(fakeChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(fakeChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('consumes an asynchronous spawn error when pid is undefined without signaling', async () => {
    let errorListener: ErrorListener | undefined
    const fakeChild = {
      pid: undefined,
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'error' && typeof listener === 'function') {
          errorListener = listener as ErrorListener
          setImmediate(() => errorListener?.(new Error('executable missing')))
        }
        return fakeChild
      }),
      removeListener: vi.fn(),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    const started = Date.now()
    let failure: unknown
    try {
      await ensureBackend(spawnSpec(tmpHome, 8776), () => {})
    } catch (error) {
      failure = error
    }
    expect(errorDetails(failure)).toContain('executable missing')
    expect(Date.now() - started).toBeLessThan(500)
    expect(fakeChild.kill).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(fakeChild.removeListener).toHaveBeenCalled()
  })

  it('waits for a delayed pidless spawn error and surfaces it as the primary failure', async () => {
    const fakeChild = createFakeChild(1012)
    Object.defineProperty(fakeChild, 'pid', { configurable: true, enumerable: true, value: undefined })
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    setTimeout(() => fakeChild.emitError(new Error('executable missing after timer')), 5)
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(ensureBackend(spawnSpec(tmpHome, 8780), () => {})).rejects.toThrow(/executable missing after timer/)
    expect(fakeChild.kill).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('terminates an owned child when reading pid throws', async () => {
    const fakeChild = createFakeChild(1013)
    Object.defineProperty(fakeChild, 'pid', { configurable: true, get: () => { throw new Error('pid getter failed') } })
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(ensureBackend(spawnSpec(tmpHome, 8781), () => {})).rejects.toThrow(/pid getter failed/)
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('redacts tokens recursively from startup errors before logging or surfacing', async () => {
    const fakeChild = createFakeChild(1009, 'kill-exit')
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    const lines: string[] = []
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const pending = ensureBackend(spawnSpec(tmpHome, 8777), line => lines.push(line))
    const token = tokenFromSpawn()
    const nested = new Error('nested cause')
    nested.stack = 'nested stack token=' + token
    const aggregate = new AggregateError([nested], 'aggregate cause', { cause: new Error('aggregate token=' + token) })
    const top = new Error('child error', { cause: aggregate })
    top.stack = 'top stack token=' + token
    setTimeout(() => fakeChild.emitError(top), 5)
    let failure: unknown
    try {
      await pending
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(errorDetails(failure)).not.toContain(token)
    expect(lines.join(' ')).not.toContain(token)
  })

  it('preserves typed cancellation and redacts cyclic custom error fields', async () => {
    const fakeChild = createFakeChild(1009)
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    let typed!: StartupCancellationError & { details?: unknown }
    globalThis.fetch = vi.fn(async () => {
      const token = tokenFromSpawn()
      typed = new StartupCancellationError('startup failed with ' + token) as StartupCancellationError & { details?: unknown }
      const details: { token: string; nested?: unknown } = { token }
      details.nested = typed
      typed.details = details
      queueMicrotask(() => fakeChild.emitError(typed))
      return response(true, token)
    }) as unknown as typeof fetch
    let failure: unknown
    try {
      await ensureBackend(spawnSpec(tmpHome, 8777), () => {})
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StartupCancellationError)
    expect(failure).not.toBe(typed)
    const sanitized = failure as StartupCancellationError & { readonly details?: { readonly token?: string; readonly nested?: unknown } }
    expect(sanitized.message).not.toContain(tokenFromSpawn())
    expect(sanitized.details?.token).toBe('[redacted]')
    expect(sanitized.details?.nested).toBe(sanitized)
  })

  it('preserves close and teardown failures after one log fd close attempt', async () => {
    const fakeChild = createFakeChild(1010, 'never')
    vi.mocked(spawn).mockReturnValue(fakeChild as unknown as ChildProcess)
    vi.mocked(closeSync).mockImplementationOnce(() => { throw new Error('close failed') })
    const failurePromise = ensureBackend(spawnSpec(tmpHome, 8778), () => {})
    let failure: unknown
    try {
      await failurePromise
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect(errorDetails(failure)).toContain('close failed')
    expect(errorDetails(failure)).toContain('remained alive')
    expect(vi.mocked(closeSync)).toHaveBeenCalledOnce()
    expect(fakeChild.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(fakeChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })
})
