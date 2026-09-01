/**
 * dsh-ainvestor — AiInvestor analysis copilot for DeepSeek Harness.
 *
 * LAB-only plugin with explicit attach/spawn backend ownership.
 *
 * @module dsh-ainvestor
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { ensureBackend, StartupCancellationError, type BackendHandle } from './backend.ts'
import { Config as ConfigSchema, resolveBackendSpec } from './config.ts'
import type { BackendSpec } from './config.ts'
import { METHODOLOGY_SECTION } from './methodology.ts'
import { createTools } from './tools.ts'

/** Cordis loader name. */
export const name = 'dsh-ainvestor'

/** Services required by this host-only plugin. */
export const inject = ['tools', 'systemPrompt'] as const

/** Standard Schema consumed by the official Cordis loader. */
export const Config = ConfigSchema

/** Resolved plugin configuration. */
export type Config = BackendSpec

function log(line: string): void {
  process.stderr.write('[dsh-ainvestor] ' + line + '\n')
}

/**
 * Register the backend-owned tools and methodology section with Cordis.
 * Startup is cancellable, and a startup failure rejects after reverse rollback
 * of every contribution acquired before the failure.
 *
 * @param ctx - Official Cordis plugin context.
 * @param rawConfig - Loader-resolved or programmatic plugin configuration.
 * @returns A promise that settles after backend startup and registration.
 * @throws {Error} If configuration, backend startup, registration, or rollback fails.
 */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const spec = resolveBackendSpec(rawConfig)
  let startup: Promise<void> | undefined

  ctx.effect(() => {
    const controller = new AbortController()
    let backend: BackendHandle | undefined
    const contributions: Array<() => void | Promise<void>> = []
    let cleanupPromise: Promise<void> | undefined

    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async (): Promise<void> => {
        controller.abort()
        const errors: unknown[] = []
        for (let index = contributions.length - 1; index >= 0; index -= 1) {
          const dispose = contributions[index]
          if (dispose === undefined) continue
          try {
            await dispose()
          } catch (error) {
            errors.push(error)
          }
        }
        contributions.length = 0
        if (backend !== undefined) {
          const ownedBackend = backend
          backend = undefined
          try {
            await ownedBackend.dispose()
          } catch (error) {
            errors.push(error)
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'dsh-ainvestor: lifecycle cleanup failed')
      })()
      return cleanupPromise
    }

    startup = (async (): Promise<void> => {
      try {
        const acquiredBackend = await ensureBackend(spec, log, controller.signal)
        backend = acquiredBackend
        if (controller.signal.aborted) {
          await cleanup()
          return
        }
        const definitions = createTools(spec.baseUrl, spec.http)
        for (const definition of definitions) {
          if (controller.signal.aborted) {
            await cleanup()
            return
          }
          contributions.push(ctx.tools.register(definition))
        }
        if (controller.signal.aborted) {
          await cleanup()
          return
        }
        contributions.push(ctx.systemPrompt.section(METHODOLOGY_SECTION))
        if (controller.signal.aborted) {
          await cleanup()
          return
        }
        log('ready mode=' + backend.mode + ' baseUrl=' + spec.baseUrl + ' tools=' + definitions.length)
      } catch (error) {
        let cleanupFailed = false
        let cleanupError: unknown
        try {
          await cleanup()
        } catch (errorDuringCleanup) {
          cleanupFailed = true
          cleanupError = errorDuringCleanup
        }
        if (cleanupFailed) {
          const errors = error instanceof StartupCancellationError ? [cleanupError] : [error, cleanupError]
          throw new AggregateError(errors, 'dsh-ainvestor: startup and cleanup failed')
        }
        if (!(error instanceof StartupCancellationError)) throw error
      }
    })()

    return async (): Promise<void> => {
      controller.abort()
      if (startup === undefined) throw new Error('dsh-ainvestor: lifecycle startup was not initialized')
      await startup
      await cleanup()
    }
  }, 'dsh-ainvestor.lifecycle')

  if (startup === undefined) throw new Error('dsh-ainvestor: lifecycle startup was not initialized')
  return startup
}
