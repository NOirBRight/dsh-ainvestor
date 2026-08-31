/**
 * AiInvestor backend lifecycle: attach to a running instance, or spawn one
 * from the AiInvestor-dsh fork checkout and wait until it answers /live.
 *
 * The backend is a Python FastAPI service (uvicorn). The fork runs on its own
 * port (default 8766) so it never collides with the production Electron app's
 * backend on 8765. Both share ~/.aiinvestor/data — the spike only registers
 * read-path tools, so concurrent access is safe.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BackendConfig {
  /** Base URL of the backend, e.g. http://127.0.0.1:8766 */
  readonly baseUrl: string
  /** AiInvestor-dsh backend directory (contains main.py and .venv). */
  readonly backendDir: string
  /** Port passed to uvicorn when spawning. */
  readonly port: number
}

export interface BackendHandle {
  readonly mode: 'attached' | 'spawned'
  readonly pid?: number
  dispose(): void
}

export function resolveBackendConfig(config: Partial<BackendConfig> | undefined): BackendConfig {
  const port = config?.port ?? Number(process.env.AINVESTOR_API_PORT ?? '8766')
  return {
    port,
    baseUrl: config?.baseUrl ?? process.env.AINVESTOR_API_URL ?? `http://127.0.0.1:${port}`,
    backendDir:
      config?.backendDir ??
      process.env.AINVESTOR_BACKEND_DIR ??
      join(homedir(), 'Workstation', 'AiInvestor-dsh', 'backend'),
  }
}

export async function probeLive(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/live`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

function backendLogFile(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dir = join(home, 'ainvestor')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'backend.log')
}

/**
 * Attach if the backend already answers /live, otherwise spawn uvicorn from
 * the fork checkout and poll /live until ready (startup runs Alembic
 * migrations and vault warmup, typically 10-20s).
 */
export async function ensureBackend(
  config: BackendConfig,
  log: (line: string) => void,
): Promise<BackendHandle> {
  if (await probeLive(config.baseUrl)) {
    log(`attached to running backend at ${config.baseUrl}`)
    return { mode: 'attached', dispose: () => undefined }
  }

  const uvicorn = join(config.backendDir, '.venv', 'bin', 'uvicorn')
  const logFd = openSync(backendLogFile(), 'a')
  let child: ChildProcess
  try {
    child = spawn(uvicorn, ['main:app', '--host', '127.0.0.1', '--port', String(config.port)], {
      cwd: config.backendDir,
      env: { ...process.env, AIINVESTOR_API_PORT: String(config.port) },
      stdio: ['ignore', logFd, logFd],
    })
  } catch (error) {
    throw new Error(`could not spawn ${uvicorn}: ${error instanceof Error ? error.message : String(error)}`)
  }
  log(`spawned backend pid=${child.pid ?? '?'} port=${config.port} (log: ${backendLogFile()})`)

  let exited = false
  child.on('exit', (code) => {
    exited = true
    log(`backend exited code=${code ?? '?'}`)
  })

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (exited) throw new Error('backend process exited during startup — see backend.log')
    if (await probeLive(config.baseUrl)) {
      log(`backend live at ${config.baseUrl}`)
      return {
        mode: 'spawned',
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        dispose: () => {
          if (!exited) child.kill('SIGTERM')
        },
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  child.kill('SIGTERM')
  throw new Error(`backend did not answer ${config.baseUrl}/live within 90s — see backend.log`)
}
