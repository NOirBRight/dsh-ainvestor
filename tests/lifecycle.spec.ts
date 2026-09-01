import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveBackendSpec } from '../src/config.ts'
import * as backend from '../src/backend.ts'
import { StartupCancellationError } from '../src/backend.ts'
import * as toolModule from '../src/tools.ts'
import * as cp from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: vi.fn() }
})

type Disposer = () => void | Promise<void>
type EffectResult = Disposer | Promise<Disposer>
type ToolStub = { readonly name: string }
type PromptStub = { readonly name: string }
type ToolService = { register(definition: ToolStub): Disposer }
type PromptService = { section(section: PromptStub): Disposer }
type FakeContext = {
  effect(fn: () => EffectResult, label?: string): Disposer
  get(name: string): ToolService | PromptService | undefined
  tools: ToolService
  systemPrompt: PromptService
}
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void

function isDisposer(value: unknown): value is Disposer {
  return typeof value === 'function'
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
}

function createFakeCtx() {
  const outerDisposers: Disposer[] = []
  const ctx = new Context() as unknown as FakeContext
  ctx.effect = (fn: () => EffectResult, _label?: string): Disposer => {
    const result = fn()
    if (isPromiseLike(result)) {
      let innerDispose: Disposer = async () => undefined
      Promise.resolve(result).then(value => {
        if (isDisposer(value)) innerDispose = value
        outerDisposers.push(innerDispose)
      }).catch(() => undefined)
      const outer: Disposer = async () => {
        try { await innerDispose() } catch { /* The test disposer aggregates separately. */ }
      }
      outerDisposers.push(outer)
      return outer
    }
    if (isDisposer(result)) outerDisposers.push(result)
    const outer: Disposer = async () => {
      for (let index = outerDisposers.length - 1; index >= 0; index -= 1) {
        try { await outerDisposers[index]!() } catch { /* The test disposer continues rollback. */ }
      }
      outerDisposers.length = 0
    }
    return outer
  }
  const toolRegistrations: Array<{ name: string; disposeCalls: number }> = []
  const sectionRegistrations: Array<{ name: string; disposeCalls: number }> = []
  let failOnTool: string | undefined
  const toolsService: ToolService = {
    register(definition): Disposer {
      if (failOnTool === definition.name) throw new Error('register fail ' + definition.name)
      const entry = { name: definition.name, disposeCalls: 0 }
      toolRegistrations.push(entry)
      return async () => { entry.disposeCalls += 1 }
    },
  }
  const promptService: PromptService = {
    section(section): Disposer {
      const entry = { name: section.name, disposeCalls: 0 }
      sectionRegistrations.push(entry)
      return async () => { entry.disposeCalls += 1 }
    },
  }
  ctx.get = (name: string): ToolService | PromptService | undefined => {
    if (name === 'tools') return toolsService
    if (name === 'systemPrompt') return promptService
    return undefined
  }
  Object.defineProperty(ctx, 'tools', { get: () => toolsService, configurable: true })
  Object.defineProperty(ctx, 'systemPrompt', { get: () => promptService, configurable: true })
  return {
    ctx,
    toolRegistrations,
    sectionRegistrations,
    setFailOnTool: (name?: string): void => { failOnTool = name },
    getOuterDisposer: (): Disposer | undefined => outerDisposers[outerDisposers.length - 1],
  }
}

function toolStub(name: string): ToolDefinition {
  return { name } as unknown as ToolDefinition
}

describe('lifecycle: single effect ownership, atomic rollback, unload', () => {
  let originalFetch: typeof fetch
  let originalHome: string | undefined
  let tmpHome: string

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalHome = process.env.DSH_HOME
    tmpHome = mkdtempSync(join(tmpdir(), 'dsh-ainvestor-'))
    process.env.DSH_HOME = tmpHome
    vi.restoreAllMocks()
    vi.mocked(cp.spawn).mockReset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    rmSync(tmpHome, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('startup unload race aborts probes, terminates owned child, never registers tools', async () => {
    const controller = new AbortController()
    let probeCount = 0
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      probeCount += 1
      if (probeCount === 1) return { ok: false, status: 503, headers: { get: () => null }, body: null } as unknown as Response
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch
    let exitListener: ExitListener | undefined
    const fakeChild = {
      pid: 999,
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'exit' && typeof listener === 'function') exitListener = listener as ExitListener
        return fakeChild
      }),
      removeListener: vi.fn(),
      kill: vi.fn((signal: NodeJS.Signals) => { exitListener?.(null, signal); return true }),
    }
    vi.mocked(cp.spawn).mockReturnValue(fakeChild as unknown as cp.ChildProcess)
    const spec = resolveBackendSpec({
      mode: 'spawn',
      baseUrl: 'http://127.0.0.1:8888',
      cwd: tmpHome,
      command: 'uvicorn',
       logPath: join(tmpHome, 'lifecycle-backend.log'),
      args: [],
      startupTimeoutMs: 2000,
      probeIntervalMs: 10,
    })
    const pending = backend.ensureBackend(spec, () => {}, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toThrow(/aborted/)
    expect(fakeChild.kill).toHaveBeenCalled()
  })

  it('does not suppress a non-cancellation startup failure after unload aborts', async () => {
    const { ctx, getOuterDisposer } = createFakeCtx()
    let signal: AbortSignal | undefined
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockImplementation(async (_spec, _log, startupSignal) => {
      signal = startupSignal
      await new Promise<void>(resolve => startupSignal?.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('ensure failure after abort')
    })
    const { apply } = await import('../src/index.ts')
    const starting = apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    const outerDispose = getOuterDisposer()
    if (outerDispose === undefined) throw new Error('lifecycle disposer was not registered')
    const disposing = outerDispose()
    expect(signal).toBeDefined()
    await expect(starting).rejects.toThrow('ensure failure after abort')
    await expect(disposing).rejects.toThrow('ensure failure after abort')
    ensureSpy.mockRestore()
  })

  it('suppresses only the explicit startup cancellation error after unload', async () => {
    const { ctx, getOuterDisposer } = createFakeCtx()
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockRejectedValue(new StartupCancellationError('startup cancelled'))
    const { apply } = await import('../src/index.ts')
    const starting = apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    await expect(starting).resolves.toBeUndefined()
    const outerDispose = getOuterDisposer()
    if (outerDispose === undefined) throw new Error('lifecycle disposer was not registered')
    await outerDispose()
    ensureSpy.mockRestore()
  })

  it('does not suppress a register failure merely because unload aborted', async () => {
    const { ctx, getOuterDisposer } = createFakeCtx()
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockResolvedValue({ mode: 'attached', dispose: vi.fn(async () => undefined) })
    const registerSpy = vi.spyOn(ctx.tools, 'register').mockImplementation(() => {
      const outerDispose = getOuterDisposer()
      if (outerDispose === undefined) throw new Error('lifecycle disposer was not registered')
      void outerDispose().catch(() => undefined)
      throw new Error('register failure after abort')
    })
    const { apply } = await import('../src/index.ts')
    await expect(apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })).rejects.toThrow('register failure after abort')
    ensureSpy.mockRestore()
    registerSpy.mockRestore()
  })

  it('disposes a backend acquired after unload wins startup', async () => {
    const { ctx, getOuterDisposer } = createFakeCtx()
    let resolveBackend!: (handle: backend.BackendHandle) => void
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockImplementation(async (_spec, _log, _signal) => new Promise<backend.BackendHandle>(resolve => { resolveBackend = resolve }))
    const { apply } = await import('../src/index.ts')
    const starting = apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    const outerDispose = getOuterDisposer()
    if (outerDispose === undefined) throw new Error('lifecycle disposer was not registered')
    const disposing = outerDispose()
    const backendDispose = vi.fn(async () => undefined)
    resolveBackend({ mode: 'attached', dispose: backendDispose })
    await expect(starting).resolves.toBeUndefined()
    await disposing
    expect(backendDispose).toHaveBeenCalledOnce()
    ensureSpy.mockRestore()
  })

  it('partial registration rollback disposes prior contributions reverse and releases backend', async () => {
    const { ctx, toolRegistrations, setFailOnTool } = createFakeCtx()
    setFailOnTool('ainvestor_analysis_card')
    const backendDispose = vi.fn(async () => undefined)
    const fakeBackend: backend.BackendHandle = { mode: 'spawned', pid: 123, dispose: backendDispose }
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockResolvedValue(fakeBackend)
    const createSpy = vi.spyOn(toolModule, 'createTools').mockReturnValue([
      toolStub('ainvestor_stock_snapshot'),
      toolStub('ainvestor_chan'),
      toolStub('ainvestor_analysis_card'),
    ])
    const { apply } = await import('../src/index.ts')
    await expect(apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })).rejects.toThrow(/register fail/)
    expect(backendDispose).toHaveBeenCalled()
    expect(toolRegistrations.map(registration => registration.disposeCalls)).toEqual([1, 1])
    ensureSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('apply rejects startup failures and preserves cleanup failures', async () => {
    const { ctx, setFailOnTool } = createFakeCtx()
    setFailOnTool('ainvestor_stock_snapshot')
    const backendDispose = vi.fn(async () => { throw new Error('backend cleanup failed') })
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockResolvedValue({ mode: 'spawned', pid: 321, dispose: backendDispose })
    const createSpy = vi.spyOn(toolModule, 'createTools').mockReturnValue([toolStub('ainvestor_stock_snapshot')])
    const { apply } = await import('../src/index.ts')
    let failure: unknown
    try {
      await apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors.some(error => String(error).includes('register fail'))).toBe(true)
    expect(errors.some(error => error instanceof AggregateError && error.errors.some(nested => String(nested).includes('backend cleanup failed')))).toBe(true)
    expect(backendDispose).toHaveBeenCalledOnce()
    ensureSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('surfaces cleanup rejection even when its value is undefined', async () => {
    const { ctx } = createFakeCtx()
    const backendDispose = vi.fn(async () => { throw undefined })
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockResolvedValue({ mode: 'attached', dispose: backendDispose })
    const createSpy = vi.spyOn(toolModule, 'createTools').mockImplementation(() => { throw new Error('startup failure') })
    const { apply } = await import('../src/index.ts')
    let failure: unknown
    try {
      await apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    const errors = (failure as AggregateError).errors
    expect(errors.some(error => error instanceof Error && error.message === 'startup failure')).toBe(true)
    const cleanup = errors.find(error => error instanceof AggregateError && error.message.includes('lifecycle cleanup failed'))
    expect(cleanup).toBeInstanceOf(AggregateError)
    expect((cleanup as AggregateError).errors).toEqual([undefined])
    ensureSpy.mockRestore()
    createSpy.mockRestore()
  })

  it('successful setup registers all tools atomically and methodology, and unload disposes prompt and every tool', async () => {
    const { ctx, toolRegistrations, sectionRegistrations, getOuterDisposer } = createFakeCtx()
    const fakeBackend: backend.BackendHandle = { mode: 'attached', dispose: vi.fn(async () => undefined) }
    const ensureSpy = vi.spyOn(backend, 'ensureBackend').mockResolvedValue(fakeBackend)
    const { apply } = await import('../src/index.ts')
    await apply(ctx as unknown as Context, { mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    expect(toolRegistrations).toHaveLength(13)
    expect(sectionRegistrations).toHaveLength(1)
    const outerDispose = getOuterDisposer()
    if (outerDispose === undefined) throw new Error('lifecycle disposer was not registered')
    await outerDispose()
    for (const registration of toolRegistrations) expect(registration.disposeCalls).toBe(1)
    for (const registration of sectionRegistrations) expect(registration.disposeCalls).toBe(1)
    expect(fakeBackend.dispose).toHaveBeenCalled()
    ensureSpy.mockRestore()
  })

  it('dispose is idempotent, spawned gets bounded SIGTERM then SIGKILL only if still alive', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null }, body: null } as unknown as Response)
      .mockImplementation(async () => {
        const call = vi.mocked(cp.spawn).mock.calls[0]
        const options = call?.[2] as { env?: Record<string, string> } | undefined
        const token = options?.env?.DSH_AINVESTOR_INSTANCE_TOKEN
        return { ok: true, status: 200, headers: { get: (name: string) => name.toLowerCase() === 'x-dsh-ainvestor-instance-token' ? token ?? null : null }, body: null } as unknown as Response
      }) as unknown as typeof fetch
    const killSignals: NodeJS.Signals[] = []
    let exitListener: ExitListener | undefined
    const fakeChild = {
      pid: 777,
      on: vi.fn((event: string, listener: unknown) => {
        if (event === 'exit' && typeof listener === 'function') exitListener = listener as ExitListener
        return fakeChild
      }),
      removeListener: vi.fn(),
      kill: vi.fn((signal: NodeJS.Signals) => { killSignals.push(signal); exitListener?.(0, signal); return true }),
    }
    vi.mocked(cp.spawn).mockReturnValue(fakeChild as unknown as cp.ChildProcess)
    const spec = resolveBackendSpec({
      mode: 'spawn', baseUrl: 'http://127.0.0.1:8778', cwd: tmpHome, command: 'uvicorn', args: [], logPath: join(tmpHome, 'lifecycle-backend.log'), startupTimeoutMs: 1000, probeIntervalMs: 10,
    })
    const handle = await backend.ensureBackend(spec, () => {})
    expect(handle.mode).toBe('spawned')
    await handle.dispose()
    expect(killSignals[0]).toBe('SIGTERM')
    expect(killSignals).toHaveLength(1)
    await handle.dispose()
    expect(killSignals).toHaveLength(1)
  })

  it('attached dispose never kills', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => JSON.stringify({ price: 10 }) } as unknown as Response)) as unknown as typeof fetch
    const spec = resolveBackendSpec({ mode: 'attach', baseUrl: 'http://127.0.0.1:8766' })
    const handle = await backend.ensureBackend(spec, () => {})
    expect(handle.mode).toBe('attached')
    await handle.dispose()
    await handle.dispose()
  })
})
