/**
 * Explicit backend attachment and child-process ownership.
 *
 * @module dsh-ainvestor/backend
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Readable } from 'node:stream'

import { INSTANCE_TOKEN_ENV, type ResolvedBackendSpec } from './config.ts'

const INSTANCE_TOKEN_HEADER = 'x-dsh-ainvestor-instance-token'
const INSTANCE_TOKEN_BYTES = 32
const PIDLESS_SPAWN_ERROR_WAIT_MS = 100
const SAFE_CHILD_ENVIRONMENT_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'TMP', 'TEMP', 'CI',
  'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA',
])
const SENSITIVE_CHILD_ENVIRONMENT_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== 'object' || timer === null) return
  const candidate = timer as unknown as { readonly unref?: () => void }
  candidate.unref?.()
}

/** Startup ended because the owning lifecycle explicitly cancelled setup. */
export class StartupCancellationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartupCancellationError'
  }
}

/** A backend handle whose disposer reaches process quiescence. */
export interface BackendHandle {
  readonly mode: 'attached' | 'spawned'
  readonly pid?: number
  dispose(): Promise<void>
}

/**
 * Probe one backend health endpoint with caller cancellation and a local timeout.
 * When an expected token is provided, readiness also requires an exact response
 * header echo from the backend.
 *
 * @param baseUrl - Backend origin.
 * @param signal - Optional caller cancellation signal.
 * @param timeoutMs - Maximum probe duration and body-cancellation bound.
 * @param expectedToken - Optional per-spawn token required in the response.
 * @returns Whether the endpoint returned an HTTP success and token echo.
 */
export async function probeLive(
  baseUrl: string,
  signal?: AbortSignal,
  timeoutMs = 2_000,
  expectedToken?: string,
): Promise<boolean> {
  if (signal?.aborted) return false
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  let cancelled = false
  const cancelledPromise = new Promise<undefined>(resolveCancel => {
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      controller.abort()
      resolveCancel(undefined)
    }
    timeout = setTimeout(cancel, Math.max(0, timeoutMs))
    unrefTimer(timeout)
    if (signal !== undefined) {
      const onAbort = (): void => cancel()
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = (): void => signal.removeEventListener('abort', onAbort)
      if (signal.aborted) cancel()
    }
  })
  let responseCleanup: Promise<void> | undefined
  let responseSettled = false
  try {
    const responsePromise = fetch(joinUrl(baseUrl, '/live'), { signal: controller.signal })
    responseCleanup = responsePromise.then(
      response => {
        responseSettled = true
        return cancelProbeBody(response, Math.max(0, deadline - Date.now()))
      },
      networkOrCancellationError => {
        responseSettled = true
        // A network failure or fetch cancellation leaves no response body to consume.
        void networkOrCancellationError
      },
    ).catch(bodyCancellationError => {
      // Body cancellation is best effort; its timer still bounds this cleanup.
      void bodyCancellationError
    })
    const result = await Promise.race([responsePromise, cancelledPromise])
    if (result === undefined) return false
    if (!result.ok) return false
    if (expectedToken !== undefined && !hasExactToken(result.headers.get(INSTANCE_TOKEN_HEADER), expectedToken)) return false
    return true
  } catch (networkOrCancellationError) {
    // Fetch and response-header failures are non-ready network/cancellation outcomes.
    void networkOrCancellationError
    return false
  } finally {
    controller.abort()
    if (timeout !== undefined) clearTimeout(timeout)
    removeAbort?.()
    // Do not hold a cancelled probe open for a response that ignores its abort signal.
    if (responseCleanup !== undefined && responseSettled) {
      await waitForProbeCleanup(responseCleanup, Math.max(0, deadline - Date.now()))
    }
  }
}

async function cancelProbeBody(response: Response, timeoutMs: number): Promise<void> {
  let body: ReadableStream<Uint8Array> | null | undefined
  try {
    body = response.body
  } catch (bodyAccessError) {
    // A body getter failure leaves no cancellable stream to consume.
    void bodyAccessError
    return
  }
  if (body === null || body === undefined) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => body?.cancel()).catch(bodyCancellationError => {
        // A rejected body cancellation cannot make readiness true and is already bounded.
        void bodyCancellationError
      }),
      new Promise<void>(resolveTimeout => {
        timer = setTimeout(resolveTimeout, Math.max(0, timeoutMs))
        unrefTimer(timer)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function waitForProbeCleanup(cleanup: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanup,
      new Promise<void>(resolveTimeout => {
        timer = setTimeout(resolveTimeout, timeoutMs)
        unrefTimer(timer)
      }),
    ])
  } catch (cleanupError) {
    // Cleanup failures cannot change the probe result and must not escape cancellation.
    void cleanupError
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function hasExactToken(actualToken: string | null, expectedToken: string): boolean {
  if (actualToken === null) return false
  const actualBytes = Buffer.from(actualToken)
  const expectedBytes = Buffer.from(expectedToken)
  const width = Math.max(actualBytes.length, expectedBytes.length)
  const paddedActual = Buffer.alloc(width)
  const paddedExpected = Buffer.alloc(width)
  actualBytes.copy(paddedActual)
  expectedBytes.copy(paddedExpected)
  const equal = timingSafeEqual(paddedActual, paddedExpected)
  return actualBytes.length === expectedBytes.length && equal
}

/** Build a child environment without forwarding ambient or arbitrary config values. */
function childEnvironment(configured: Readonly<Record<string, string>> | undefined, instanceToken: string): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(configured ?? {})) {
    const normalizedName = name.toUpperCase()
    if (normalizedName === INSTANCE_TOKEN_ENV || SENSITIVE_CHILD_ENVIRONMENT_NAME.test(name) || !SAFE_CHILD_ENVIRONMENT_NAMES.has(normalizedName)) continue
    environment[normalizedName] = value
  }
  environment[INSTANCE_TOKEN_ENV] = instanceToken
  return environment
}

/**
 * Ensure the requested backend is reachable or owned by this plugin.
 * Spawn mode always creates one owned child and accepts readiness only after
 * the child echoes its private instance token.
 *
 * @param spec - Explicit attachment or spawn specification.
 * @param log - Lifecycle diagnostic sink.
 * @param signal - Setup cancellation signal.
 * @returns A handle with mode-specific ownership semantics.
 * @throws {Error} If attachment fails or an owned process cannot become ready.
 */
export async function ensureBackend(spec: ResolvedBackendSpec, log: (line: string) => void, signal?: AbortSignal): Promise<BackendHandle> {
  if (spec.mode === 'attach') return ensureAttach(spec, log, signal)
  return ensureSpawn(spec, log, signal)
}

async function ensureAttach(
  spec: Extract<ResolvedBackendSpec, { mode: 'attach' }>,
  log: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<BackendHandle> {
  if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: attach probe aborted before it started')
  const live = await probeLive(spec.baseUrl, signal, spec.probeTimeoutMs)
  if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: attach probe aborted during startup')
  if (!live) {
    throw new Error('dsh-ainvestor: attach mode requires a reachable ' + joinUrl(spec.baseUrl, '/live') + '; no process was started')
  }
  log('attached to running backend at ' + spec.baseUrl)
  return {
    mode: 'attached',
    async dispose(): Promise<void> {
      return undefined
    },
  }
}

async function ensureSpawn(
  spec: Extract<ResolvedBackendSpec, { mode: 'spawn' }>,
  log: (line: string) => void,
  signal: AbortSignal | undefined,
): Promise<BackendHandle> {
  if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: spawn aborted before it started')
  if (spec.env !== undefined && Object.keys(spec.env).some(key => key.toUpperCase() === INSTANCE_TOKEN_ENV)) {
    throw new Error('dsh-ainvestor: env.' + INSTANCE_TOKEN_ENV + ' is reserved for authenticated spawn readiness')
  }
  const token = randomBytes(INSTANCE_TOKEN_BYTES).toString('base64url')
  const logFile = resolveLogFile(spec)
  let logFd: number | undefined
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    logFd = openSync(logFile, 'a', 0o600)
  } catch (error) {
    const errors = [new Error('dsh-ainvestor: could not open log file ' + logFile + ': ' + errorMessage(error, token))]
    const closeError = closeLog(logFd)
    if (closeError !== undefined) errors.push(safeError(closeError, token))
    throw aggregateErrors(errors, 'dsh-ainvestor: log file setup failed')
  }

  let child: ChildProcess
  try {
    child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: childEnvironment(spec.env, token),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const errors = [new Error('dsh-ainvestor: could not spawn ' + spec.command + ': ' + errorMessage(error, token))]
    const closeError = closeLog(logFd)
    if (closeError !== undefined) errors.push(safeError(closeError, token))
    throw aggregateErrors(errors, 'dsh-ainvestor: process setup failed')
  }
  let pid: number | undefined
  let pidReadError: Error | undefined
  try {
    const candidate = child.pid
    if (candidate !== undefined && typeof candidate !== 'number') {
      pidReadError = new Error('dsh-ainvestor: spawned process exposed an invalid pid')
    } else {
      pid = candidate
    }
  } catch (error) {
    pidReadError = safeError(error, token)
  }
  if (logFd === undefined) throw new Error('dsh-ainvestor: spawned process log descriptor was not initialized')
  const state = createSpawnState(child, log, token, pid, pidReadError !== undefined, logFd)
  logFd = undefined
  try {
    installSpawnListeners(state)
    state.installOutputListeners()
    if (pidReadError !== undefined) {
      const childError = await consumePidlessSpawnError(state)
      const primaryError = childError === undefined
        ? pidReadError
        : new Error(pidReadError.message + '; child reported: ' + childError.message)
      throw primaryError
    }
    if (pid === undefined) {
      const childError = await consumePidlessSpawnError(state)
      if (childError !== undefined) {
        const pidError = new Error('dsh-ainvestor: spawned process reported an error before exposing a pid: ' + childError.message)
        throw pidError
      }
      throw new Error('dsh-ainvestor: spawned process did not expose a pid')
    }
    state.report('spawned backend pid=' + pid + ' cwd=' + spec.cwd + ' command=' + spec.command + ' (log: ' + logFile + ')')
    assertSpawnHealthy(state, logFile)
    return await waitForReady(spec, signal, token, logFile, state, pid)
  } catch (error) {
    const teardownErrors = await teardownOwned(state, spec.terminationGraceMs, spec.forceTerminationWaitMs)
    const errors = [safeError(error, token)]
    appendUnique(errors, state.failures.filter(failure => failure !== error))
    appendUnique(errors, teardownErrors)
    throw aggregateErrors(errors, 'dsh-ainvestor: startup teardown failed: ' + safeError(error, token).message)
  }
}

async function waitForReady(
  spec: Extract<ResolvedBackendSpec, { mode: 'spawn' }>,
  signal: AbortSignal | undefined,
  token: string,
  logFile: string,
  state: SpawnState,
  pid: number,
): Promise<BackendHandle> {
  const deadline = Date.now() + spec.startupTimeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: backend startup probe aborted')
    assertSpawnHealthy(state, logFile)
    const remaining = deadline - Date.now()
    const live = await Promise.race([
      probeLive(spec.baseUrl, signal, Math.min(spec.probeTimeoutMs, remaining), token),
      state.failure.then(error => { throw error }),
    ])
    if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: backend startup probe aborted')
    assertSpawnHealthy(state, logFile)
    if (live) {
      state.report('backend live at ' + spec.baseUrl)
      assertSpawnHealthy(state, logFile)
      return createSpawnedHandle(state, pid, spec)
    }
    const waitMs = Math.min(spec.probeIntervalMs, Math.max(1, deadline - Date.now()))
    await Promise.race([
      waitForDelay(waitMs, signal),
      state.failure.then(error => { throw error }),
    ])
  }
  if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: backend startup probe aborted')
  throw new Error('dsh-ainvestor: backend did not provide authenticated readiness at ' + joinUrl(spec.baseUrl, '/live') + ' within ' + spec.startupTimeoutMs + 'ms; expected ' + INSTANCE_TOKEN_ENV + ' echo; see ' + logFile)
}

interface TokenLogWriter {
  append(value: unknown): void
  flush(): void
}

function createTokenLogWriter(fd: number, instanceToken: string): TokenLogWriter {
  const tokenBytes = Buffer.from(instanceToken)
  const replacement = Buffer.from('[redacted]')
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let closed = false
  const writeAll = (value: Buffer): void => {
    let offset = 0
    while (offset < value.length) {
      const written = writeSync(fd, value, offset, value.length - offset)
      if (written <= 0) throw new Error('dsh-ainvestor: log write made no progress')
      offset += written
    }
  }
  const appendBytes = (value: Buffer, final: boolean): void => {
    const data = pending.length === 0 ? value : Buffer.concat([pending, value])
    const holdback = final ? 0 : Math.max(0, tokenBytes.length - 1)
    const processEnd = Math.max(0, data.length - holdback)
    const output: Buffer[] = []
    let cursor = 0
    let retainedFrom = processEnd
    while (true) {
      const tokenAt = data.indexOf(tokenBytes, cursor)
      if (tokenAt < 0 || tokenAt >= processEnd) break
      if (tokenAt > cursor) output.push(data.subarray(cursor, tokenAt))
      output.push(replacement)
      cursor = tokenAt + tokenBytes.length
      retainedFrom = Math.max(retainedFrom, cursor)
    }
    if (cursor < processEnd) output.push(data.subarray(cursor, processEnd))
    if (output.length > 0) writeAll(Buffer.concat(output))
    pending = data.subarray(retainedFrom)
  }
  return {
    append(value: unknown): void {
      if (closed) return
      const bytes = typeof value === 'string'
        ? Buffer.from(value)
        : value instanceof Uint8Array
          ? Buffer.from(value)
          : Buffer.from(String(value))
      appendBytes(bytes, false)
    },
    flush(): void {
      if (closed) return
      try {
        appendBytes(Buffer.alloc(0), true)
      } finally {
        closed = true
      }
    },
  }
}

interface OutputDataListener {
  readonly stream: Readable
  readonly listener: (chunk: Buffer | string) => void
}

interface OutputErrorListener {
  readonly stream: Readable
  readonly listener: (error: Error) => void
}

interface SpawnState {
  readonly child: ChildProcess
  readonly pid: number | undefined
  readonly pidReadFailed: boolean
  readonly instanceToken: string
  readonly exit: Promise<void>
  readonly failure: Promise<Error>
  readonly failures: Error[]
  exited: boolean
  exitCode: number | null | undefined
  exitSignal: NodeJS.Signals | null | undefined
  childError: Error | undefined
  report(line: string): void
  installOutputListeners(): void
  removeListeners(): void
  closeLog(): Error | undefined
  onExit(code: number | null, signal: NodeJS.Signals | null): void
  onError(error: Error): void
  exitListenerInstalled: boolean
  errorListenerInstalled: boolean
}

function createSpawnState(
  child: ChildProcess,
  log: (line: string) => void,
  instanceToken: string,
  pid: number | undefined,
  pidReadFailed: boolean,
  logFd: number,
): SpawnState {
  let resolveExit!: () => void
  let resolveFailure!: (error: Error) => void
  let state!: SpawnState
  let ownedLogFd: number | undefined = logFd
  let outputFailureRecorded = false
  const outputDataListeners: OutputDataListener[] = []
  const outputErrorListeners: OutputErrorListener[] = []
  const logWriter = createTokenLogWriter(logFd, instanceToken)
  const exit = new Promise<void>(resolvePromise => { resolveExit = resolvePromise })
  const failure = new Promise<Error>(resolvePromise => { resolveFailure = resolvePromise })
  const recordFailure = (value: unknown): Error => {
    const error = safeError(value, instanceToken)
    if (!state.failures.includes(error)) state.failures.push(error)
    if (state.failures.length === 1) resolveFailure(error)
    return error
  }
  const recordOutputFailure = (value: unknown): void => {
    if (outputFailureRecorded) return
    outputFailureRecorded = true
    recordFailure(value)
  }
  const report = (line: string): void => {
    try {
      log(redactText(line, instanceToken))
    } catch (error) {
      recordFailure(error)
    }
  }
  const installOutputListeners = (): void => {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null || stream === undefined) continue
      const onData = (chunk: Buffer | string): void => {
        try {
          logWriter.append(chunk)
        } catch (error) {
          recordOutputFailure(error)
        }
      }
      const onError = (error: Error): void => {
        recordOutputFailure(error)
      }
      try {
        stream.on('data', onData)
        outputDataListeners.push({ stream, listener: onData })
      } catch (error) {
        recordOutputFailure(error)
      }
      try {
        stream.on('error', onError)
        outputErrorListeners.push({ stream, listener: onError })
      } catch (error) {
        recordOutputFailure(error)
      }
    }
  }
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (state.exited) return
    state.exited = true
    state.exitCode = code
    state.exitSignal = signal
    resolveExit()
    state.report('backend exited code=' + (code ?? '?') + ' signal=' + (signal ?? '?'))
    try {
      state.removeListeners()
    } catch (error) {
      recordFailure(error)
    }
  }
  const onError = (error: Error): void => {
    const childError = safeError(error, instanceToken)
    state.childError ??= childError
    recordFailure(childError)
    state.report('backend process error: ' + childError.message)
  }
  const removeListeners = (): void => {
    const errors: Error[] = []
    const removeListener = child.removeListener
    if (typeof removeListener !== 'function') {
      state.exitListenerInstalled = false
      state.errorListenerInstalled = false
    } else {
      if (state.exitListenerInstalled) {
        try {
          removeListener.call(child, 'exit', onExit)
          state.exitListenerInstalled = false
        } catch (error) {
          errors.push(safeError(error, instanceToken))
        }
      }
      if (state.errorListenerInstalled) {
        try {
          removeListener.call(child, 'error', onError)
          state.errorListenerInstalled = false
        } catch (error) {
          errors.push(safeError(error, instanceToken))
        }
      }
    }
    for (let index = outputDataListeners.length - 1; index >= 0; index -= 1) {
      const listener = outputDataListeners[index]
      if (listener === undefined) continue
      try {
        listener.stream.removeListener('data', listener.listener)
        outputDataListeners.splice(index, 1)
      } catch (error) {
        errors.push(safeError(error, instanceToken))
      }
    }
    for (let index = outputErrorListeners.length - 1; index >= 0; index -= 1) {
      const listener = outputErrorListeners[index]
      if (listener === undefined) continue
      try {
        listener.stream.removeListener('error', listener.listener)
        outputErrorListeners.splice(index, 1)
      } catch (error) {
        errors.push(safeError(error, instanceToken))
      }
    }
    try {
      logWriter.flush()
    } catch (error) {
      errors.push(safeError(error, instanceToken))
    }
    if (errors.length > 0) throw aggregateErrors(errors, 'dsh-ainvestor: backend listener cleanup failed')
  }
  const closeLogFile = (): Error | undefined => {
    const descriptor = ownedLogFd
    ownedLogFd = undefined
    return closeLog(descriptor)
  }
  state = {
    child,
    pid,
    pidReadFailed,
    instanceToken,
    exit,
    failure,
    failures: [],
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
    childError: undefined,
    report,
    installOutputListeners,
    removeListeners,
    closeLog: closeLogFile,
    onExit,
    onError,
    exitListenerInstalled: false,
    errorListenerInstalled: false,
  }
  return state
}

function installSpawnListeners(state: SpawnState): void {
  state.exitListenerInstalled = true
  try {
    state.child.on('exit', state.onExit)
  } catch (error) {
    // Keep the flag set so teardown attempts to remove a partially installed listener.
    throw error
  }
  state.errorListenerInstalled = true
  try {
    state.child.on('error', state.onError)
  } catch (error) {
    // Keep the flag set so teardown attempts to remove a partially installed listener.
    throw error
  }
}

/** Consume Node's asynchronous spawn error before removing the error listener. */
async function consumePidlessSpawnError(state: SpawnState): Promise<Error | undefined> {
  if (state.childError !== undefined) return state.childError
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      state.failure.then(() => undefined),
      new Promise<void>(resolveTimeout => {
        timer = setTimeout(resolveTimeout, PIDLESS_SPAWN_ERROR_WAIT_MS)
        unrefTimer(timer)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return state.childError
}

function assertSpawnHealthy(state: SpawnState, logFile: string): void {
  const errors: Error[] = []
  if (state.exited) errors.push(startupExitError(state, logFile))
  appendUnique(errors, state.failures)
  if (errors.length > 0) throw aggregateErrors(errors, 'dsh-ainvestor: backend startup failed')
}

function createSpawnedHandle(
  state: SpawnState,
  pid: number,
  spec: Extract<ResolvedBackendSpec, { mode: 'spawn' }>,
): BackendHandle {
  let disposal: Promise<void> | undefined
  return {
    mode: 'spawned',
    pid,
    dispose(): Promise<void> {
      disposal ??= disposeOwned(state, spec.terminationGraceMs, spec.forceTerminationWaitMs)
      return disposal
    },
  }
}

async function disposeOwned(state: SpawnState, terminationGraceMs: number, forceTerminationWaitMs: number): Promise<void> {
  const teardownErrors = await teardownOwned(state, terminationGraceMs, forceTerminationWaitMs)
  const errors = [...state.failures]
  appendUnique(errors, teardownErrors)
  if (errors.length > 0) throw aggregateErrors(errors, 'dsh-ainvestor: backend disposal failed')
}

interface ExitWaiter {
  readonly exit: Promise<void>
  cleanup(): void
}

function installExitWaiter(state: SpawnState): ExitWaiter {
  let resolveExit!: () => void
  let installed = false
  const exit = new Promise<void>(resolvePromise => { resolveExit = resolvePromise })
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!state.exited) {
      state.exited = true
      state.exitCode = code
      state.exitSignal = signal
    }
    resolveExit()
  }
  if (state.exited) {
    resolveExit()
  } else {
    const exitCode = state.child.exitCode
    const exitSignal = state.child.signalCode
    if ((exitCode !== null && exitCode !== undefined) || (exitSignal !== null && exitSignal !== undefined)) {
      onExit(exitCode ?? null, exitSignal ?? null)
    } else {
      state.child.on('exit', onExit)
      installed = true
    }
  }
  return {
    exit,
    cleanup(): void {
      if (!installed) return
      installed = false
      state.child.removeListener('exit', onExit)
    },
  }
}

async function teardownOwned(state: SpawnState, terminationGraceMs: number, forceTerminationWaitMs: number): Promise<Error[]> {
  const errors: Error[] = []
  try {
    state.removeListeners()
  } catch (error) {
    errors.push(safeError(error, state.instanceToken))
  }
  let exitWaiter: ExitWaiter | undefined
  if (!state.exited) {
    try {
      exitWaiter = installExitWaiter(state)
    } catch (error) {
      errors.push(safeError(error, state.instanceToken))
    }
  }
  try {
    await terminateChild(state, terminationGraceMs, forceTerminationWaitMs, exitWaiter?.exit)
  } catch (error) {
    errors.push(safeError(error, state.instanceToken))
  }
  if (exitWaiter !== undefined) {
    try {
      exitWaiter.cleanup()
    } catch (error) {
      errors.push(safeError(error, state.instanceToken))
    }
  }
  const closeError = state.closeLog()
  if (closeError !== undefined) errors.push(safeError(closeError, state.instanceToken))
  return errors
}

async function terminateChild(
  state: SpawnState,
  terminationGraceMs: number,
  forceTerminationWaitMs: number,
  exit: Promise<void> | undefined = state.exit,
): Promise<void> {
  if (state.exited || (state.pid === undefined && !state.pidReadFailed)) return
  const errors: Error[] = []
  let gracefulRefused = false
  try {
    if (!state.exited) gracefulRefused = state.child.kill('SIGTERM') === false
  } catch (error) {
    if (!state.exited) errors.push(new Error('dsh-ainvestor: SIGTERM failed: ' + errorMessage(error, state.instanceToken)))
  }
  if (!state.exited) {
    const stopped = await waitForExit(exit, terminationGraceMs, () => state.exited)
    if (!stopped && gracefulRefused) errors.push(new Error('dsh-ainvestor: SIGTERM failed: process refused SIGTERM'))
  }
  if (!state.exited) {
    let forceRefused = false
    try {
      forceRefused = state.child.kill('SIGKILL') === false
    } catch (error) {
      if (!state.exited) errors.push(new Error('dsh-ainvestor: SIGKILL failed: ' + errorMessage(error, state.instanceToken)))
    }
    const stopped = await waitForExit(exit, forceTerminationWaitMs, () => state.exited)
    if (!stopped) {
      if (forceRefused) errors.push(new Error('dsh-ainvestor: SIGKILL failed: process refused SIGKILL'))
      errors.push(new Error('dsh-ainvestor: owned backend remained alive after SIGKILL'))
    }
  }
  if (errors.length > 0) throw aggregateErrors(errors, 'dsh-ainvestor: owned backend termination failed')
}

async function waitForExit(exit: Promise<void>, timeoutMs: number, isExited: () => boolean): Promise<boolean> {
  if (isExited()) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      exit.then(() => true),
      new Promise<false>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
        unrefTimer(timer)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return isExited()
}

async function waitForDelay(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new StartupCancellationError('dsh-ainvestor: backend startup probe aborted')
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    if (signal === undefined) return
    const onAbort = (): void => reject(new StartupCancellationError('dsh-ainvestor: backend startup probe aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = (): void => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([
      new Promise<void>(resolveDelay => {
        timer = setTimeout(resolveDelay, timeoutMs)
        unrefTimer(timer)
      }),
      aborted,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbort?.()
  }
}

function resolveLogFile(spec: Extract<ResolvedBackendSpec, { mode: 'spawn' }>): string {
  return resolve(spec.cwd, spec.logPath)
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path
}

function startupExitError(state: SpawnState, logFile: string): Error {
  const reason = state.childError?.message ?? 'code=' + (state.exitCode ?? '?') + ' signal=' + (state.exitSignal ?? '?')
  return new Error('dsh-ainvestor: backend process exited during startup (' + reason + '); see ' + logFile)
}

function closeLog(fd: number | undefined): Error | undefined {
  if (fd === undefined) return undefined
  try {
    closeSync(fd)
    return undefined
  } catch (error) {
    return asError(error)
  }
}

type ErrorWithCause = Error & { readonly cause?: unknown }

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorMessage(error: unknown, instanceToken?: string): string {
  return instanceToken === undefined ? asError(error).message : safeError(error, instanceToken).message
}

function safeError(error: unknown, instanceToken: string): Error {
  const normalized = asError(error)
  if (!containsToken(normalized, instanceToken)) return normalized
  const sanitized = redactUnknown(normalized, instanceToken, new WeakMap<object, unknown>())
  return sanitized instanceof Error ? sanitized : new Error(redactText(String(sanitized), instanceToken))
}

const ERROR_STANDARD_FIELDS = new Set(['name', 'message', 'stack', 'cause', 'errors'])
type OwnField = { readonly key: string | symbol; readonly value: unknown; readonly enumerable: boolean }

function ownFields(value: object): OwnField[] {
  const fields: OwnField[] = []
  let keys: (string | symbol)[]
  try {
    keys = Reflect.ownKeys(value)
  } catch (fieldKeysError) {
    // An exotic error object cannot expose fields safely.
    void fieldKeysError
    return fields
  }
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch (fieldDescriptorError) {
      // Ignore one unreadable field while preserving the remaining diagnostics.
      void fieldDescriptorError
      continue
    }
    if (descriptor === undefined) continue
    try {
      const fieldValue = 'value' in descriptor ? descriptor.value : Reflect.get(value, key, value)
      fields.push({ key, value: fieldValue, enumerable: descriptor.enumerable === true })
    } catch (fieldReadError) {
      // A throwing diagnostic getter cannot provide a value to redact.
      void fieldReadError
    }
  }
  return fields
}

function errorFields(error: Error): OwnField[] {
  return ownFields(error).filter(field => typeof field.key !== 'string' || !ERROR_STANDARD_FIELDS.has(field.key))
}

function containsToken(value: unknown, instanceToken: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return value.includes(instanceToken)
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (value instanceof Error) {
    if (containsToken(value.name, instanceToken, seen) || containsToken(value.message, instanceToken, seen)) return true
    if (value.stack !== undefined && containsToken(value.stack, instanceToken, seen)) return true
    if (hasCause(value) && containsToken(value.cause, instanceToken, seen)) return true
    if (value instanceof AggregateError && value.errors.some(error => containsToken(error, instanceToken, seen))) return true
    return errorFields(value).some(field => containsToken(field.key, instanceToken, seen) || containsToken(field.value, instanceToken, seen))
  }
  return ownFields(value).some(field => containsToken(field.key, instanceToken, seen) || containsToken(field.value, instanceToken, seen))
}

function redactUnknown(value: unknown, instanceToken: string, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return redactText(value, instanceToken)
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return redactError(value, instanceToken, seen)
  const existing = seen.get(value)
  if (existing !== undefined) return existing
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const entry of value) copy.push(redactUnknown(entry, instanceToken, seen))
    return copy
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  seen.set(value, copy)
  for (const field of ownFields(value)) {
    const key = typeof field.key === 'string' ? redactText(field.key, instanceToken) : field.key
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: field.enumerable,
      value: redactUnknown(field.value, instanceToken, seen),
      writable: true,
    })
  }
  return copy
}

function redactErrorFields(error: Error, copy: Error, instanceToken: string, seen: WeakMap<object, unknown>): void {
  for (const field of errorFields(error)) {
    const key = typeof field.key === 'string' ? redactText(field.key, instanceToken) : field.key
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: field.enumerable,
      value: redactUnknown(field.value, instanceToken, seen),
      writable: true,
    })
  }
}

function redactError(error: Error, instanceToken: string, seen: WeakMap<object, unknown>): Error {
  const existing = seen.get(error)
  if (existing instanceof Error) return existing
  if (error instanceof AggregateError) {
    const copy = new AggregateError([], redactText(error.message, instanceToken))
    seen.set(error, copy)
    copy.name = redactText(error.name, instanceToken)
    if (error.stack !== undefined) copy.stack = redactText(error.stack, instanceToken)
    redactErrorFields(error, copy, instanceToken, seen)
    if (hasCause(error)) setCause(copy, redactUnknown(error.cause, instanceToken, seen))
    const entries = copy.errors as unknown as unknown[]
    for (const entry of error.errors) entries.push(redactUnknown(entry, instanceToken, seen))
    return copy
  }
  const copy = error instanceof StartupCancellationError
    ? new StartupCancellationError(redactText(error.message, instanceToken))
    : new Error(redactText(error.message, instanceToken))
  seen.set(error, copy)
  copy.name = redactText(error.name, instanceToken)
  if (error.stack !== undefined) copy.stack = redactText(error.stack, instanceToken)
  redactErrorFields(error, copy, instanceToken, seen)
  if (hasCause(error)) setCause(copy, redactUnknown(error.cause, instanceToken, seen))
  return copy
}

function hasCause(error: Error): error is ErrorWithCause {
  return 'cause' in error
}

function setCause(error: Error, cause: unknown): void {
  Object.defineProperty(error, 'cause', { configurable: true, enumerable: false, value: cause, writable: true })
}

function redactText(value: string, instanceToken: string): string {
  return value.split(instanceToken).join('[redacted]')
}

function aggregateErrors(errors: Error[], message: string): Error {
  if (errors.length === 1) return errors[0]!
  return new AggregateError(errors, message)
}

function appendUnique(target: Error[], values: readonly Error[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value)
  }
}
