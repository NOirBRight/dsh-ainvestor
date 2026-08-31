/**
 * dsh-ainvestor — AiInvestor analysis copilot for DeepSeek Harness.
 *
 * Host-only plugin (no client bundle). On load it:
 *  1. attaches to (or spawns) the AiInvestor-dsh fork backend on port 8766,
 *  2. registers the ainvestor_* analysis tools (Chan, scoring, financials,
 *     bars, knowledge search) against the backend HTTP API,
 *  3. injects the investment-methodology system prompt section.
 *
 * The backend spawn is disposed with the plugin fiber, so unloading the
 * plugin also stops a backend it started (but never one it merely attached to).
 */

import type { Context } from '@deepseek-ai/cordis'

import { ensureBackend, resolveBackendConfig, type BackendConfig, type BackendHandle } from './backend.ts'
import { createTools, type ToolDefinition } from './tools.ts'
import { METHODOLOGY_SECTION } from './methodology.ts'

export const name = 'dsh-ainvestor'
export const inject = ['tools']

export type Config = Partial<BackendConfig>

interface ToolsService {
  register(definition: ToolDefinition): unknown
}

interface SystemPromptService {
  section(section: { name: string; order: number; text: string }): unknown
}

function log(line: string): void {
  process.stderr.write(`[dsh-ainvestor] ${line}\n`)
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Tie the backend handle to this plugin fiber's lifetime. */
function bindDisposal(ctx: Context, handle: BackendHandle): void {
  const anyCtx = ctx as unknown as {
    effect?: (callback: () => () => void) => unknown
    on: (name: string, listener: () => void) => unknown
  }
  const dispose = (): void => {
    try {
      handle.dispose()
    } catch (error) {
      log(`WARN backend dispose failed: ${errMsg(error)}`)
    }
  }
  if (typeof anyCtx.effect === 'function') {
    anyCtx.effect(() => () => {
      dispose()
    })
  } else {
    anyCtx.on('dispose', dispose)
  }
}

async function run(ctx: Context, config: Config | undefined): Promise<void> {
  const backendConfig = resolveBackendConfig(config)

  let handle: BackendHandle
  try {
    handle = await ensureBackend(backendConfig, log)
  } catch (error) {
    log(`FATAL backend unavailable: ${errMsg(error)} — tools not registered`)
    return
  }
  bindDisposal(ctx, handle)

  const tools = ctx.get('tools') as ToolsService | undefined
  if (tools === undefined) {
    log('FATAL tools service missing — the tree may be tearing down')
    return
  }
  const definitions = createTools(backendConfig.baseUrl)
  let registered = 0
  for (const definition of definitions) {
    try {
      tools.register(definition)
      registered += 1
    } catch (error) {
      log(`WARN could not register ${definition.name}: ${errMsg(error)}`)
    }
  }

  const systemPrompt = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (systemPrompt === undefined) {
    log('WARN systemPrompt service missing — methodology section not injected')
  } else {
    try {
      systemPrompt.section(METHODOLOGY_SECTION)
    } catch (error) {
      log(`WARN methodology section failed: ${errMsg(error)}`)
    }
  }

  log(
    `ready mode=${handle.mode} baseUrl=${backendConfig.baseUrl} ` +
      `tools=${registered}/${definitions.length} methodology=${systemPrompt !== undefined ? 'yes' : 'no'}`,
  )
}

export function apply(ctx: Context, config?: Config): void {
  void run(ctx, config).catch((error) => {
    log(`FATAL ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`)
  })
}
