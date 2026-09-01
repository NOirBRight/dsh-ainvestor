/**
 * Explicit backend ownership configuration for the AiInvestor plugin.
 *
 * @module dsh-ainvestor/config
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'

/** Reserved child environment key used for authenticated backend readiness. */
export const INSTANCE_TOKEN_ENV = 'DSH_AINVESTOR_INSTANCE_TOKEN'

/** Attach to a running backend. The plugin never starts or kills a process. */
export interface AttachSpec {
  readonly mode: 'attach'
  /** Backend origin, for example http://127.0.0.1:8766. */
  readonly baseUrl: string
  /** HTTP request and response limits. */
  readonly http?: HttpConfig
  /** Maximum duration of one readiness probe in milliseconds. */
  readonly probeTimeoutMs?: number
}

/** Spawn and own one backend process from start through termination. */
export interface SpawnSpec {
  readonly mode: 'spawn'
  /** Backend origin used for readiness and tool requests. */
  readonly baseUrl: string
  /** Explicit working directory for the child process. */
  readonly cwd: string
  /** Explicit executable or command name. */
  readonly command: string
  /** Explicit argument vector; an empty vector is valid. */
  readonly args: readonly string[]
  /** Optional configured environment; only safe launcher variables are forwarded and ambient variables are never inherited. */
  readonly env?: Readonly<Record<string, string>>
  /** Maximum readiness wait in milliseconds. */
  readonly startupTimeoutMs?: number
  /** Delay between readiness probes in milliseconds. */
  readonly probeIntervalMs?: number
  /** Maximum duration of one readiness probe in milliseconds. */
  readonly probeTimeoutMs?: number
  /** Grace period after SIGTERM in milliseconds. */
  readonly terminationGraceMs?: number
  /** Maximum wait after SIGKILL in milliseconds. */
  readonly forceTerminationWaitMs?: number
  /** Explicit log path; relative paths resolve from cwd. */
  readonly logPath: string
  /** HTTP request and response limits. */
  readonly http?: HttpConfig
}

/** Validated HTTP limits for backend requests. */
export interface HttpConfig {
  /** Maximum duration of one backend request in milliseconds. */
  readonly requestTimeoutMs?: number
  /** Maximum backend response body size in bytes. */
  readonly maxResponseBytes?: number
  /** Maximum time spent awaiting response-body cancellation in milliseconds. */
  readonly responseCancelTimeoutMs?: number
}

/** Normalized HTTP limits used by every tool request. */
export interface ResolvedHttpConfig {
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly responseCancelTimeoutMs: number
}

/** Validated backend lifecycle ownership choice. */
export type BackendSpec = AttachSpec | SpawnSpec

/** Backend specification with normalized origin and resolved lifecycle limits. */
export type ResolvedBackendSpec = (Omit<AttachSpec, 'baseUrl' | 'http' | 'probeTimeoutMs'> & {
  readonly baseUrl: string
  readonly http: ResolvedHttpConfig
  readonly probeTimeoutMs: number
})
  | (Omit<SpawnSpec, 'baseUrl' | 'http' | 'startupTimeoutMs' | 'probeIntervalMs' | 'probeTimeoutMs' | 'terminationGraceMs' | 'forceTerminationWaitMs' | 'logPath'> & {
    readonly baseUrl: string
    readonly http: ResolvedHttpConfig
    readonly startupTimeoutMs: number
    readonly probeIntervalMs: number
    readonly probeTimeoutMs: number
    readonly terminationGraceMs: number
    readonly forceTerminationWaitMs: number
    readonly logPath: string
  })

/** Explicit default lifecycle limits used when config omits them. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
const DEFAULT_PROBE_INTERVAL_MS = 1_000
const DEFAULT_TERMINATION_GRACE_MS = 5_000
const DEFAULT_FORCE_TERMINATION_WAIT_MS = 2_000
const MAX_LIFECYCLE_TIMEOUT_MS = 10 * 60 * 1_000

/** Explicit default HTTP limits used when config omits the HTTP object. */
export const DEFAULT_HTTP_CONFIG: ResolvedHttpConfig = Object.freeze({
  requestTimeoutMs: 60_000,
  maxResponseBytes: 5 * 1024 * 1024,
  responseCancelTimeoutMs: 2_000,
})

/**
 * Standard Schema consumed by the official Cordis loader before plugin setup.
 * Programmatic callers should use resolveBackendSpec for the same check.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-ainvestor',
    validate(value: unknown): StandardSchemaV1.Result<BackendSpec> {
      try {
        return { value: resolveBackendSpec(value) }
      } catch (error) {
        return {
          issues: [{
            message: error instanceof Error ? error.message : String(error),
            path: [],
          }],
        }
      }
    },
  },
} satisfies StandardSchemaV1<unknown, BackendSpec>

/** The resolved plugin configuration type. */
export type Config = BackendSpec

const ATTACH_KEYS = new Set(['mode', 'baseUrl', 'http', 'probeTimeoutMs'])
const SPAWN_KEYS = new Set([
  'mode',
  'baseUrl',
  'cwd',
  'command',
  'args',
  'env',
  'startupTimeoutMs',
  'probeIntervalMs',
  'probeTimeoutMs',
  'terminationGraceMs',
  'forceTerminationWaitMs',
  'logPath',
  'http',
])

/**
 * Validate and normalize raw plugin configuration.
 *
 * @param raw - Raw loader or programmatic configuration.
 * @returns A normalized explicit backend specification.
 * @throws {TypeError} If the mode, required fields, or field values are invalid.
 */
export function resolveBackendSpec(raw: unknown): ResolvedBackendSpec {
  if (raw === undefined || raw === null) {
    throw new TypeError('dsh-ainvestor: config is required; provide an explicit attach or spawn specification')
  }
  if (!isPlainRecord(raw)) {
    throw new TypeError('dsh-ainvestor: config must be a plain object with explicit mode')
  }
  const cfg = raw
  const mode = cfg.mode
  if (mode !== 'attach' && mode !== 'spawn') {
    throw new TypeError('dsh-ainvestor: config.mode must be "attach" or "spawn"')
  }

  const keys = mode === 'attach' ? ATTACH_KEYS : SPAWN_KEYS
  for (const key of Object.keys(cfg)) {
    if (!keys.has(key)) {
      throw new TypeError('dsh-ainvestor: config field "' + key + '" is not supported for ' + mode + ' mode')
    }
  }

  const baseUrl = normalizeBaseUrl(requireNonEmptyString(cfg.baseUrl, 'baseUrl'))
  const http = resolveHttpConfig(cfg.http)
  const probeTimeoutMs = resolveTimeout(cfg.probeTimeoutMs, 'probeTimeoutMs', DEFAULT_PROBE_TIMEOUT_MS)
  if (mode === 'attach') return { mode, baseUrl, http, probeTimeoutMs }

  const cwd = requireNonEmptyString(cfg.cwd, 'spawn mode requires explicit cwd')
  const command = requireNonEmptyString(cfg.command, 'spawn mode requires explicit command')
  if (cfg.args === undefined || !Array.isArray(cfg.args) || !cfg.args.every(value => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('dsh-ainvestor: spawn mode requires explicit args as an array of non-empty strings')
  }
  const args = cfg.args.map(value => validateSpawnString(value, 'args entry'))

  const env = cfg.env === undefined ? undefined : validateEnvironment(cfg.env)
  const startupTimeoutMs = resolveTimeout(cfg.startupTimeoutMs, 'startupTimeoutMs', DEFAULT_STARTUP_TIMEOUT_MS)
  const probeIntervalMs = resolveTimeout(cfg.probeIntervalMs, 'probeIntervalMs', DEFAULT_PROBE_INTERVAL_MS)
  const terminationGraceMs = resolveTimeout(cfg.terminationGraceMs, 'terminationGraceMs', DEFAULT_TERMINATION_GRACE_MS)
  const forceTerminationWaitMs = resolveTimeout(cfg.forceTerminationWaitMs, 'forceTerminationWaitMs', DEFAULT_FORCE_TERMINATION_WAIT_MS)
  const logPath = validateSpawnString(requireNonEmptyString(cfg.logPath, 'spawn mode requires explicit logPath'), 'logPath')

  return {
    mode,
    baseUrl,
    cwd: validateSpawnString(cwd, 'cwd'),
    command: validateSpawnString(command, 'command'),
    args,
    ...(env === undefined ? {} : { env }),
    startupTimeoutMs,
    probeIntervalMs,
    probeTimeoutMs,
    terminationGraceMs,
    forceTerminationWaitMs,
    logPath,
    http,
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('dsh-ainvestor: ' + field + ' is required and must be a non-empty string')
  }
  return value.trim()
}

function validateSpawnString(value: string, field: string): string {
  if (value.includes('\0')) throw new TypeError('dsh-ainvestor: ' + field + ' must not contain NUL')
  if (/[\u0001-\u001f\u007f-\u009f]/.test(value)) throw new TypeError('dsh-ainvestor: ' + field + ' must not contain control characters')
  return value
}

function validateEnvironment(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) throw new TypeError('dsh-ainvestor: env must be a plain record of strings')
  let keys: readonly (string | symbol)[]
  let entries: [string, unknown][]
  try {
    keys = Reflect.ownKeys(value)
    entries = Object.entries(value)
  } catch (environmentReadError) {
    // Configuration accessors and proxies are untrusted input at load time.
    void environmentReadError
    throw new TypeError('dsh-ainvestor: env must be a readable record of strings')
  }
  if (keys.some(key => typeof key === 'symbol')) throw new TypeError('dsh-ainvestor: env keys must be strings')
  const env: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.includes('\0')) throw new TypeError('dsh-ainvestor: env keys must be non-empty and must not contain NUL')
    if (key.includes('=')) throw new TypeError('dsh-ainvestor: env keys must not contain an equals sign')
    if (/[\u0001-\u001f\u007f-\u009f]/.test(key)) throw new TypeError('dsh-ainvestor: env keys must not contain control characters')
    if (key.toUpperCase() === INSTANCE_TOKEN_ENV) throw new TypeError('dsh-ainvestor: env.' + INSTANCE_TOKEN_ENV + ' is reserved for authenticated spawn readiness')
    if (typeof entry !== 'string' || entry.includes('\0')) throw new TypeError('dsh-ainvestor: env[' + JSON.stringify(key) + '] must be a NUL-free string')
    if (/[\u0001-\u001f\u007f-\u009f]/.test(entry)) throw new TypeError('dsh-ainvestor: env[' + JSON.stringify(key) + '] must not contain control characters')
    Object.defineProperty(env, key, { configurable: true, enumerable: true, value: entry, writable: true })
  }
  return env
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch (prototypeReadError) {
    // Proxies that hide their prototype are not configuration records.
    void prototypeReadError
    return false
  }
}

function resolveHttpConfig(value: unknown): ResolvedHttpConfig {
  if (value === undefined) return DEFAULT_HTTP_CONFIG
  if (!isPlainRecord(value)) throw new TypeError('dsh-ainvestor: http must be a plain object')
  const http = value
  for (const key of Object.keys(http)) {
    if (key !== 'requestTimeoutMs' && key !== 'maxResponseBytes' && key !== 'responseCancelTimeoutMs') {
      throw new TypeError('dsh-ainvestor: http field "' + key + '" is not supported')
    }
  }
  const requestTimeoutMs = http.requestTimeoutMs === undefined
    ? DEFAULT_HTTP_CONFIG.requestTimeoutMs
    : validateIntegerInRange(http.requestTimeoutMs, 'http.requestTimeoutMs', 1, 10 * 60 * 1000)
  const maxResponseBytes = http.maxResponseBytes === undefined
    ? DEFAULT_HTTP_CONFIG.maxResponseBytes
    : validateIntegerInRange(http.maxResponseBytes, 'http.maxResponseBytes', 1024, 50 * 1024 * 1024)
  const responseCancelTimeoutMs = http.responseCancelTimeoutMs === undefined
    ? DEFAULT_HTTP_CONFIG.responseCancelTimeoutMs
    : validateIntegerInRange(http.responseCancelTimeoutMs, 'http.responseCancelTimeoutMs', 1, 10 * 60 * 1000)
  return { requestTimeoutMs, maxResponseBytes, responseCancelTimeoutMs }
}

function resolveTimeout(value: unknown, field: string, defaultValue: number): number {
  return value === undefined
    ? defaultValue
    : validateIntegerInRange(value, field, 1, MAX_LIFECYCLE_TIMEOUT_MS)
}

function validateIntegerInRange(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError('dsh-ainvestor: ' + field + ' must be an integer from ' + minimum + ' through ' + maximum)
  }
  return value
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (urlParseError) {
    // Invalid URLs cannot designate an HTTP backend origin.
    void urlParseError
    throw new TypeError('dsh-ainvestor: baseUrl must be a valid URL, got ' + JSON.stringify(value))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('dsh-ainvestor: baseUrl must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('dsh-ainvestor: baseUrl must not contain credentials')
  }
  if (value.includes('?') || value.includes('#') || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('dsh-ainvestor: baseUrl must be an origin without a path, query, or hash')
  }
  return url.origin
}
