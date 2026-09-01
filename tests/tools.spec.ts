import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTools } from '../src/tools.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DEFAULT_HTTP_CONFIG } from '../src/config.ts'

type ToolExecutor = {
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

type JsonObject = Record<string, unknown>

function executor(tool: ToolDefinition): ToolExecutor {
  return tool as unknown as ToolExecutor
}

function runTool(tool: ToolDefinition, args: JsonObject, signal = new AbortController().signal): Promise<unknown> {
  return executor(tool).execute(args, { signal })
}

function resultError(result: unknown): string {
  if (typeof result !== 'object' || result === null || typeof (result as JsonObject).error !== 'string') {
    throw new Error('expected tool error result')
  }
  return (result as JsonObject).error as string
}

function jsonResponse(value: unknown, ok = true, status = 200, body: BodyInit | null = null): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    body,
    text: async () => JSON.stringify(value),
  } as unknown as Response
}

function validResponse(name: string): JsonObject {
  switch (name) {
    case 'ainvestor_stock_snapshot': return { price: 10, ticker: '600519' }
    case 'ainvestor_chan': return { bi: [], seg: [] }
    case 'ainvestor_analysis_card': return { symbol: '600519', scores: { overall: 80 } }
    case 'ainvestor_financials': return { symbol: '600519', data: { revenue: 100, roe: 12 } }
    case 'ainvestor_bars': return { data: [{ date: '2024-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }] }
    case 'ainvestor_dupont': return { symbol: '600519', data: { net_margin: 0.2, asset_turnover: 1, equity_multiplier: 2 } }
    case 'ainvestor_fscore': return { symbol: '600519', data: { score: 7 } }
    case 'ainvestor_valuation': return { symbol: '600519', data: { pe: 20 } }
    case 'ainvestor_volume_price': return { symbol: '600519', data: { signals: [], ratio: 1 } }
    case 'ainvestor_search_knowledge': return { chunks: [{ text: '中枢是价格重叠区间' }] }
    case 'ainvestor_data_health': return { source: 'fixture', overall_ok: true }
    case 'ainvestor_factor_profile': return { data: { quality: 90, value: 30, momentum: 70 } }
    case 'ainvestor_screen': return { results: [{ symbol: '600519', quality: 90 }] }
    default: throw new Error('missing fixture for ' + name)
  }
}

describe('tools: strict JSON validation, cancellation, and sanitization', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('preserves baseline tool inventory exactly (13)', () => {
    const definitions = createTools('http://127.0.0.1:8766')
    expect(definitions.map(tool => tool.name).sort()).toEqual([
      'ainvestor_analysis_card',
      'ainvestor_bars',
      'ainvestor_chan',
      'ainvestor_data_health',
      'ainvestor_dupont',
      'ainvestor_factor_profile',
      'ainvestor_financials',
      'ainvestor_fscore',
      'ainvestor_screen',
      'ainvestor_search_knowledge',
      'ainvestor_stock_snapshot',
      'ainvestor_valuation',
      'ainvestor_volume_price',
    ].sort())
    expect(definitions).toHaveLength(13)
  })

  it('validates ticker, market, query, and numeric inputs before fetch', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ price: 10, ticker: '600519' })) as unknown as typeof fetch
    globalThis.fetch = fetchSpy
    const definitions = createTools('http://127.0.0.1:8766')
    const snapshot = definitions.find(tool => tool.name === 'ainvestor_stock_snapshot')!
    const chan = definitions.find(tool => tool.name === 'ainvestor_chan')!
    const knowledge = definitions.find(tool => tool.name === 'ainvestor_search_knowledge')!
    const bars = definitions.find(tool => tool.name === 'ainvestor_bars')!
    expect(resultError(await runTool(snapshot, { ticker: 'bad' }))).toMatch(/invalid ticker/)
    expect(resultError(await runTool(chan, { symbol: 'bad' }))).toMatch(/invalid symbol/)
    expect(resultError(await runTool(knowledge, { query: '   ' }))).toMatch(/invalid query/)
    expect(resultError(await runTool(bars, { symbol: '600519', n: 1.5 }))).toMatch(/invalid n/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts hyphenated US symbols and rejects unsafe free strings', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: { quality: 80, value: 40, momentum: 60 } })) as unknown as typeof fetch
    globalThis.fetch = fetchSpy
    const definitions = createTools('http://127.0.0.1:8766')
    const factor = definitions.find(tool => tool.name === 'ainvestor_factor_profile')!
    const screen = definitions.find(tool => tool.name === 'ainvestor_screen')!
    const accepted = await runTool(factor, { symbol: 'BRK-B', market: 'US' })
    expect(accepted).toEqual({ data: { quality: 80, value: 40, momentum: 60 } })
    const rejected = await runTool(screen, { industry: 'bad\u0000value' })
    expect(resultError(rejected)).toMatch(/invalid industry/)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('applies configured request timeout, caller cancellation, and response limits', async () => {
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const snapshot = createTools('http://127.0.0.1:8766', { ...DEFAULT_HTTP_CONFIG, requestTimeoutMs: 15, maxResponseBytes: 128, responseCancelTimeoutMs: 10 }).find(tool => tool.name === 'ainvestor_stock_snapshot')!
    const timedOut = await runTool(snapshot, { ticker: '600519' })
    expect(resultError(timedOut)).toMatch(/timed out/)
    expect(requestSignal?.aborted).toBe(true)

    requestSignal = undefined
    const controller = new AbortController()
    const cancelledPromise = runTool(snapshot, { ticker: '600519' }, controller.signal)
    setTimeout(() => controller.abort(), 5)
    const cancelled = await cancelledPromise
    expect(resultError(cancelled)).toMatch(/cancelled/)
    expect(resultError(cancelled)).not.toMatch(/timed out/)
    expect(requestSignal?.aborted).toBe(true)
  })

  it('bounds cancellation of a response body that never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const reader = {
      read: vi.fn(() => new Promise<never>(() => undefined)),
      cancel,
      releaseLock: vi.fn(),
    }
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>
    globalThis.fetch = vi.fn(async () => jsonResponse({ price: 10, ticker: '600519' }, true, 200, body as unknown as BodyInit)) as unknown as typeof fetch
    const snapshot = createTools('http://127.0.0.1:8766', { ...DEFAULT_HTTP_CONFIG, requestTimeoutMs: 15, responseCancelTimeoutMs: 10 }).find(tool => tool.name === 'ainvestor_stock_snapshot')!
    const started = Date.now()
    const result = await runTool(snapshot, { ticker: '600519' })
    expect(resultError(result)).toMatch(/timed out/)
    expect(cancel).toHaveBeenCalled()
    expect(reader.releaseLock).toHaveBeenCalled()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('strictly validates every endpoint response', async () => {
    const definitions = createTools('http://127.0.0.1:8766')
    const argumentsByTool: Record<string, JsonObject> = {
      ainvestor_stock_snapshot: { ticker: '600519' },
      ainvestor_chan: { symbol: '600519' },
      ainvestor_analysis_card: { symbol: '600519' },
      ainvestor_financials: { symbol: '600519' },
      ainvestor_bars: { symbol: '600519' },
      ainvestor_dupont: { symbol: '600519' },
      ainvestor_fscore: { symbol: '600519' },
      ainvestor_valuation: { symbol: '600519' },
      ainvestor_volume_price: { symbol: '600519' },
      ainvestor_search_knowledge: { query: '中枢' },
      ainvestor_data_health: {},
      ainvestor_factor_profile: { symbol: '600519' },
      ainvestor_screen: {},
    }
    for (const tool of definitions) {
      globalThis.fetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
      const result = await runTool(tool, argumentsByTool[tool.name]!)
      expect(resultError(result), tool.name).toMatch(/malformed/)
    }
  })

  it('accepts the documented response fields for all endpoints', async () => {
    const definitions = createTools('http://127.0.0.1:8766')
    for (const tool of definitions) {
      globalThis.fetch = vi.fn(async () => jsonResponse(validResponse(tool.name))) as unknown as typeof fetch
      const args = tool.name === 'ainvestor_stock_snapshot'
        ? { ticker: '600519' }
        : tool.name === 'ainvestor_search_knowledge'
          ? { query: '中枢' }
          : tool.name === 'ainvestor_factor_profile'
            ? { symbol: '600519' }
            : tool.name === 'ainvestor_chan' || tool.name !== 'ainvestor_data_health' && tool.name !== 'ainvestor_screen'
              ? { symbol: '600519' }
              : {}
      await expect(runTool(tool, args)).resolves.toEqual(validResponse(tool.name))
    }
  })

  it('accepts real backend response envelopes', async () => {
    const definitions = createTools('http://127.0.0.1:8766')
    const cases: Record<string, { readonly args: JsonObject; readonly body: unknown }> = {
      ainvestor_bars: {
        args: { symbol: '600519' },
        body: [{ trade_date: '2024-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
      },
      ainvestor_factor_profile: {
        args: { symbol: '600519' },
        body: { symbol: '600519', quality_percentile: 90, pe_percentile: 25, momentum_percentile: 70 },
      },
      ainvestor_screen: {
        args: {},
        body: { rows: [{ symbol: '600519', quality: 90, value: 25, momentum: 70 }], total: 1 },
      },
      ainvestor_dupont: {
        args: { symbol: '600519' },
        body: { symbol: '600519', dupont: { factors: { net_profit_margin: 0.2, asset_turnover: 1, equity_multiplier: 2 } } },
      },
      ainvestor_fscore: {
        args: { symbol: '600519' },
        body: { symbol: '600519', fscore: { f_score: { total_score: 7 } } },
      },
      ainvestor_financials: {
        args: { symbol: '600519' },
        body: { symbol: '600519', financials: { revenue: null, net_income: 100, roe: null } },
      },
      ainvestor_valuation: {
        args: { symbol: '600519' },
        body: { symbol: '600519', valuation: { peg: null, industry_percentile: null, valuation_level: null } },
      },
    }
    for (const [name, fixture] of Object.entries(cases)) {
      const tool = definitions.find(item => item.name === name)
      if (tool === undefined) throw new Error('missing tool ' + name)
      globalThis.fetch = vi.fn(async () => jsonResponse(fixture.body)) as unknown as typeof fetch
      await expect(runTool(tool, fixture.args)).resolves.toEqual(fixture.body)
    }
  })

  it('accepts null financial table slots and null factor percentiles', async () => {
    const definitions = createTools('http://127.0.0.1:8766')
    const cases = [
      {
        name: 'ainvestor_financials',
        args: { symbol: '600519' },
        body: { symbol: '600519', indicators: null, balance_sheet: null, income_statement: null, cash_flow: null },
      },
      {
        name: 'ainvestor_factor_profile',
        args: { symbol: '600519' },
        body: { symbol: '600519', quality_percentile: null, pe_percentile: null, momentum_percentile: null },
      },
    ] as const
    for (const fixture of cases) {
      const tool = definitions.find(item => item.name === fixture.name)
      if (tool === undefined) throw new Error('missing tool ' + fixture.name)
      globalThis.fetch = vi.fn(async () => jsonResponse(fixture.body)) as unknown as typeof fetch
      await expect(runTool(tool, fixture.args)).resolves.toEqual(fixture.body)
    }
  })

  it('validates response status and sanitizes backend stack traces and credentials', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ detail: 'Error: token=secret\n    at backend (/srv/app.ts:1:2)' }, false, 503, JSON.stringify({ detail: 'Error: token=secret\n    at backend (/srv/app.ts:1:2)' }))) as unknown as typeof fetch
    const tool = createTools('http://127.0.0.1:8766').find(item => item.name === 'ainvestor_stock_snapshot')!
    const statusResult = await runTool(tool, { ticker: '600519' })
    expect(resultError(statusResult)).toMatch(/503/)
    expect(JSON.stringify(statusResult)).not.toContain('secret')

    globalThis.fetch = vi.fn(async () => jsonResponse({ error: 'Bearer abc123 token=secret', code: 'E_BACKEND' })) as unknown as typeof fetch
    const backendResult = await runTool(tool, { ticker: '600519' })
    expect(resultError(backendResult)).toContain('Bearer [redacted]')
    expect(JSON.stringify(backendResult)).not.toContain('abc123')
    expect(JSON.stringify(backendResult)).not.toContain('secret')
  })

  it('trims validated chan arrays without changing the tool inventory', async () => {
    const bi = Array.from({ length: 20 }, (_, index) => ({ index }))
    globalThis.fetch = vi.fn(async () => jsonResponse({ bi, seg: [] })) as unknown as typeof fetch
    const tool = createTools('http://127.0.0.1:8766').find(item => item.name === 'ainvestor_chan')!
    const result = await runTool(tool, { symbol: '600519' }) as JsonObject
    expect(result.bi_total).toBe(20)
    expect((result.bi as unknown[]).length).toBe(15)
  })

  it('rejects empty and malformed strict health and volume signals', async () => {
    const health = createTools('http://127.0.0.1:8766').find(tool => tool.name === 'ainvestor_data_health')!
    const volume = createTools('http://127.0.0.1:8766').find(tool => tool.name === 'ainvestor_volume_price')!
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: {} })) as unknown as typeof fetch
    expect(resultError(await runTool(health, {}))).toMatch(/malformed/)
    globalThis.fetch = vi.fn(async () => jsonResponse({ symbol: '600519', data: { divergence: 42 } })) as unknown as typeof fetch
    expect(resultError(await runTool(volume, { symbol: '600519' }))).toMatch(/malformed/)
  })

  it('rejects empty bar dates and closes throwing response bodies safely', async () => {
    const bars = createTools('http://127.0.0.1:8766').find(tool => tool.name === 'ainvestor_bars')!
    globalThis.fetch = vi.fn(async () => jsonResponse({ data: [{ date: '', open: 1, high: 2, low: 0, close: 1, volume: 1 }] })) as unknown as typeof fetch
    expect(resultError(await runTool(bars, { symbol: '600519' }))).toMatch(/malformed/)

    const responseWithThrowingBody = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      get body(): ReadableStream<Uint8Array> { throw new Error('body getter failed') },
      text: async () => JSON.stringify({ data: [] }),
    } as unknown as Response
    globalThis.fetch = vi.fn(async () => responseWithThrowingBody) as unknown as typeof fetch
    const result = await runTool(bars, { symbol: '600519' })
    expect(resultError(result)).toMatch(/failed to read backend response|malformed/)
  })
})
