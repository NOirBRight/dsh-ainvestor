/**
 * Read-only model tools backed by the AiInvestor HTTP API.
 *
 * @module dsh-ainvestor/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'

import { DEFAULT_HTTP_CONFIG, type ResolvedHttpConfig } from './config.ts'

const MAX_ERROR_BYTES = 4 * 1024
const MAX_QUERY_LENGTH = 200
const MAX_INDUSTRY_LENGTH = 100
const MAX_SYMBOL_LENGTH = 32

/** The exact read-only tool count present at the authorized baseline. */
const BASELINE_TOOL_COUNT = 13
const BASELINE_TOOL_NAMES = [
  'ainvestor_stock_snapshot',
  'ainvestor_chan',
  'ainvestor_analysis_card',
  'ainvestor_financials',
  'ainvestor_bars',
  'ainvestor_dupont',
  'ainvestor_fscore',
  'ainvestor_valuation',
  'ainvestor_volume_price',
  'ainvestor_search_knowledge',
  'ainvestor_data_health',
  'ainvestor_factor_profile',
  'ainvestor_screen',
] as const

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== 'object' || timer === null) return
  const candidate = timer as unknown as { readonly unref?: () => void }
  candidate.unref?.()
}

const jsonOutput = {
  schema: { type: 'json' } as const,
  render(_args: unknown, value: JsonValue): { type: 'text'; text: string }[] {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) ?? '' }]
  },
}

const symbolParameters = {
  symbol: {
    type: 'string',
    description: 'A股6位代码，不带交易所前缀，如 "600519"、"000001"',
    required: true,
  },
} as const

const stockSnapshotParameters = {
  ticker: {
    type: 'string',
    description: '股票代码，A股6位数字，如 "600519"',
    required: true,
  },
} as const

/**
 * Create a safe short diagnostic without stack frames or credential values.
 *
 * @param detail - Untrusted backend or transport detail.
 * @returns A bounded redacted diagnostic.
 */
function sanitizeDetail(detail: string): string {
  const lines = detail
    .split(/\r?\n/)
    .filter(line => !/^\s*at\s+/.test(line) && !/\bat\s+\S+\s+\(/.test(line))
  return redactSecrets(lines.join(' ').slice(0, 500))
}

function redactSecrets(value: string): string {
  return value
    .replace(/(["']?(?:token|key|secret|password|passwd|authorization|auth|credential)["']?\s*[:=]\s*)["'][^"']*["']/gi, '$1"[redacted]"')
    .replace(/((?:token|key|secret|password|passwd|authorization|auth|credential)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@[redacted]')
}

/**
 * Read a response body while enforcing a byte cap before joining chunks.
 *
 * @param response - HTTP response to read.
 * @param maxBytes - Maximum UTF-8 response bytes.
 * @param signal - Request cancellation signal.
 * @param cancelTimeoutMs - Maximum time spent cancelling the body or reader.
 * @returns The decoded response text.
 * @throws {Error} When the declared or streamed body exceeds maxBytes.
 */
async function readBodyWithCap(response: Response, maxBytes: number, signal: AbortSignal, cancelTimeoutMs: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength.trim())) throw new Error('invalid Content-Length')
    const declaredLength = Number(contentLength)
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new Error('response too large (' + contentLength + ' bytes)')
    }
  }

  if (response.body === null) {
    const text = await readText(response, signal)
    const bytes = new TextEncoder().encode(text).byteLength
    if (bytes > maxBytes) throw new Error('response too large (' + bytes + ' bytes)')
    return text
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let totalBytes = 0
  try {
    while (true) {
      const part = await readChunk(reader, signal)
      if (part.done) break
      totalBytes += part.value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error('response too large (' + totalBytes + ' bytes)')
      }
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } catch (error) {
    await cancelReader(reader, cancelTimeoutMs)
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => reader.cancel()).catch(readerCancellationError => {
        // Reader cancellation is best effort and bounded by the timer below.
        void readerCancellationError
      }),
      new Promise<void>(resolveTimeout => {
        timer = setTimeout(resolveTimeout, timeoutMs)
        unrefTimer(timer)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new DOMException('request aborted', 'AbortError')
  let removeAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new DOMException('request aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = (): void => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([response.text(), aborted])
  } finally {
    removeAbort?.()
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new DOMException('request aborted', 'AbortError')
  let removeAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(new DOMException('request aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = (): void => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    removeAbort?.()
  }
}

function endpointFields(path: string, json: unknown): string | null {
  if (isRecord(json) && Object.hasOwn(json, 'error')) return null
  if (path.includes('/api/stocks/') && path.endsWith('/snapshot')) return validateSnapshot(json)
  if (path.startsWith('/chan/')) return validateChan(json)
  if (path.startsWith('/analysis/') && path.endsWith('/dupont')) return validateDupont(json)
  if (path.startsWith('/analysis/') && path.endsWith('/fscore')) return validateFscore(json)
  if (path.startsWith('/analysis/') && path.endsWith('/valuation')) return validateValuation(json)
  if (path.startsWith('/analysis/') && path.endsWith('/volume-price')) return validateVolumePrice(json)
  if (path.startsWith('/analysis/')) return validateAnalysisCard(json)
  if (path.startsWith('/financials/')) return validateFinancials(json)
  if (path.startsWith('/bars/')) return validateBars(json)
  if (path.includes('/api/knowledge/search')) return validateKnowledge(json)
  if (path.includes('/api/data/health')) return validateHealth(json)
  if (path.includes('/api/market/cross-section/')) return validateFactorProfile(json)
  if (path.includes('/api/market/screen')) return validateScreen(json)
  return null
}

function validateSnapshot(json: unknown): string | null {
  const root = requireObject(json, 'snapshot')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['snapshot', 'data'], 'snapshot')
  if (sourceError !== null) return sourceError
  const source = payloadSource(root, ['snapshot', 'data'])
  const price = firstValue([source, root], ['price', 'last', 'current_price'])
  if (!price.found) return 'missing snapshot price'
  const priceError = numberError(price.value, 'snapshot price', 0, Number.MAX_SAFE_INTEGER)
  if (priceError !== null) return priceError
  const ticker = firstValue([source, root], ['ticker', 'symbol'])
  if (!ticker.found) return 'missing snapshot ticker or symbol'
  if (!isValidTicker(ticker.value)) return 'snapshot ticker or symbol must be a 6-digit string'
  const score = firstValue([source, root], ['score', 'scores'])
  const scoreError = score.found ? scoreContainerError(score.value, 'snapshot score') : null
  if (scoreError !== null) return scoreError
  const optionalError = validateKnownFields([source, root], {
    numbers: ['change', 'change_pct', 'change_percent', 'volume', 'amount', 'market_cap', 'week52_high', 'week52_low'],
    scores: ['trend_score', 'momentum_score', 'volume_score', 'structure_score', 'composite_score', 'overall_score'],
    arrays: ['signals', 'technical_signals', 'fundamental_signals'],
  })
  return optionalError ?? validateNestedValue(root, 'snapshot')
}

function validateChan(json: unknown): string | null {
  const root = requireObject(json, 'chan')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['data'], 'chan')
  if (sourceError !== null) return sourceError
  const source = payloadSource(root, ['data'])
  for (const key of ['bi', 'seg'] as const) {
    const value = firstValue([source, root], [key])
    if (!value.found) return 'missing chan field: ' + key
    const error = recordArrayError(value.value, 'chan.' + key)
    if (error !== null) return error
  }
  for (const key of ['zs', 'bsp'] as const) {
    const value = firstValue([source, root], [key])
    if (value.found) {
      const error = recordArrayError(value.value, 'chan.' + key)
      if (error !== null) return error
    }
  }
  return validateNestedValue(root, 'chan')
}

function validateAnalysisCard(json: unknown): string | null {
  const root = requireObject(json, 'analysis card')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['data'], 'analysis card')
  if (sourceError !== null) return sourceError
  const source = payloadSource(root, ['data'])
  const symbol = firstValue([source, root], ['symbol', 'ticker'])
  if (!symbol.found) return 'missing analysis card symbol'
  if (!isValidTicker(symbol.value)) return 'analysis card symbol must be a 6-digit string'
  const scores = firstValue([source, root], ['scores', 'score', 'overall', 'overall_score', 'card'])
  if (!scores.found) return 'missing analysis card score or scores'
  if (isRecord(scores.value)) {
    const scoreError = scoreContainerError(scores.value, 'analysis card scores')
    if (scoreError !== null) return scoreError
  } else {
    const scoreError = numberError(scores.value, 'analysis card score', 0, 100)
    if (scoreError !== null) return scoreError
  }
  for (const scoreSource of [source, root]) {
    const scoreValue = firstValue([scoreSource], ['score'])
    if (scoreValue.found) {
      const scoreError = scoreContainerError(scoreValue.value, 'analysis card score')
      if (scoreError !== null) return scoreError
    }
  }
  const optionalError = validateKnownFields([source, root], {
    scores: ['overall', 'overall_score', 'trend_score', 'momentum_score', 'risk_score', 'fundamental_score', 'technical_score'],
    arrays: ['signals', 'strengths', 'weaknesses'],
  })
  return optionalError ?? validateNestedValue(root, 'analysis card')
}

function validateFinancials(json: unknown): string | null {
  const root = requireObject(json, 'financials')
  if (typeof root === 'string') return root
  const symbol = firstValue([root, payloadSource(root, ['data'])], ['symbol', 'ticker'])
  if (!symbol.found) return 'missing financials symbol'
  if (!isValidTicker(symbol.value)) return 'financials symbol must be a 6-digit string'
  const payloadKeys = ['financials', 'indicators', 'balance_sheet', 'income_statement', 'cash_flow', 'data']
  const payloadValues = payloadKeys.filter(key => Object.hasOwn(root, key)).map(key => root[key])
  const payload = payloadValues.find(isRecord)
  if (payload === undefined) {
    if (payloadValues.length > 0 && payloadValues.every(value => value === null)) return validateNestedValue(root, 'financials')
    return 'financials data must be an object'
  }
  if (Object.keys(payload).length === 0) return 'financials data must not be empty'
  const knownError = validateKnownFields([payload], {
    nullable: true,
    numbers: ['revenue', 'total_revenue', 'net_income', 'net_profit', 'assets', 'total_assets', 'equity', 'roe', 'roa', 'eps', 'gross_margin', 'operating_margin'],
  })
  return knownError ?? validateNestedValue(root, 'financials')
}

function validateBars(json: unknown): string | null {
  const root = Array.isArray(json) ? undefined : requireObject(json, 'bars')
  if (typeof root === 'string') return root
  const bars = Array.isArray(json) ? { found: true, value: json } : firstValue([root], ['bars', 'ohlcv', 'klines', 'data'])
  if (!bars.found || !Array.isArray(bars.value)) return 'bars data must be an array of OHLCV objects'
  for (let index = 0; index < bars.value.length; index += 1) {
    const row = bars.value[index]
    if (!isRecord(row)) return 'bars[' + index + '] must be an object'
    const date = firstValue([row], ['date', 'trade_date', 'datetime', 'time', 'timestamp'])
    if (!date.found || (typeof date.value === 'string' ? !isSafeFreeText(date.value, 100) : !isFiniteInRange(date.value, 0, Number.MAX_SAFE_INTEGER))) {
      return 'bars[' + index + '] requires a date or timestamp'
    }
    for (const [aliases, label] of [
      [['open'], 'open'], [['high'], 'high'], [['low'], 'low'], [['close'], 'close'], [['volume'], 'volume'],
    ] as const) {
      const value = firstValue([row], aliases)
      if (!value.found) return 'bars[' + index + '] missing ' + label
      const error = numberError(value.value, 'bars.' + label, 0, Number.MAX_SAFE_INTEGER)
      if (error !== null) return error
    }
    const rowError = validateKnownFields([row], { numbers: ['amount', 'pct_chg', 'change', 'turnover'] })
    if (rowError !== null) return rowError
  }
  return validateNestedValue(json, 'bars')
}

function validateDupont(json: unknown): string | null {
  const root = requireObject(json, 'dupont')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['dupont', 'data'], 'dupont')
  if (sourceError !== null) return sourceError
  const outer = payloadSource(root, ['dupont', 'data'])
  const factors = firstValue([outer, root], ['factors'])
  if (factors.found && !isRecord(factors.value)) return 'dupont factors must be an object'
  const source = factors.found ? factors.value as Record<string, unknown> : outer
  const symbol = firstValue([source, outer, root], ['symbol', 'ticker'])
  if (!symbol.found) return 'missing dupont symbol'
  if (!isValidTicker(symbol.value)) return 'dupont symbol must be a 6-digit string'
  const groups: readonly [readonly string[], string, number, number][] = [
    [['net_margin', 'margin', 'net_profit_margin'], 'net margin', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [['asset_turnover', 'total_asset_turnover', 'total_assets_turnover', 'turnover'], 'asset turnover', 0, Number.MAX_SAFE_INTEGER],
    [['equity_multiplier', 'equity_multiplier_ratio', 'leverage'], 'equity multiplier', 0, Number.MAX_SAFE_INTEGER],
  ]
  for (const [aliases, label, minimum, maximum] of groups) {
    const value = firstValue([source, outer, root], aliases)
    if (!value.found) return 'missing dupont ' + label
    const error = numberError(value.value, 'dupont ' + label, minimum, maximum)
    if (error !== null) return error
  }
  return validateNestedValue(root, 'dupont')
}

function validateFscore(json: unknown): string | null {
  const root = requireObject(json, 'fscore')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['data'], 'fscore')
  if (sourceError !== null) return sourceError
  const outer = payloadSource(root, ['fscore', 'f_score', 'data'])
  const nestedScore = firstValue([outer], ['f_score'])
  if (nestedScore.found && !isRecord(nestedScore.value)) return 'fscore f_score must be an object'
  const source = nestedScore.found ? nestedScore.value as Record<string, unknown> : outer
  const symbol = firstValue([source, outer, root], ['symbol', 'ticker'])
  if (!symbol.found) return 'missing fscore symbol'
  if (!isValidTicker(symbol.value)) return 'fscore symbol must be a 6-digit string'
  const score = firstValue([source, outer, root], ['score', 'total_score', 'fscore', 'f_score', 'total', 'points', 'value'])
  if (!score.found) return 'missing fscore score'
  if (isRecord(score.value)) {
    const nested = firstValue([score.value], ['score', 'total_score', 'total'])
    if (!nested.found) return 'fscore score must be a number from 0 through 9'
    return numberError(nested.value, 'fscore score', 0, 9) ?? validateNestedValue(root, 'fscore')
  }
  return numberError(score.value, 'fscore score', 0, 9) ?? validateNestedValue(root, 'fscore')
}

function validateValuation(json: unknown): string | null {
  const root = requireObject(json, 'valuation')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['valuation', 'data'], 'valuation')
  if (sourceError !== null) return sourceError
  const source = payloadSource(root, ['valuation', 'data'])
  const symbol = firstValue([source, root], ['symbol', 'ticker'])
  if (!symbol.found) return 'missing valuation symbol'
  if (!isValidTicker(symbol.value)) return 'valuation symbol must be a 6-digit string'
  const metric = firstValue([source, root], ['pe_ttm', 'pe', 'peg', 'industry_percentile', 'percentile', 'valuation_level', 'level'])
  if (!metric.found) return 'missing valuation metric'
  const knownError = validateKnownFields([source, root], {
    nullable: true,
    numbers: ['pe_ttm', 'pe', 'peg'],
    percentages: ['industry_percentile', 'percentile'],
    strings: ['valuation_level', 'level'],
  })
  return knownError ?? validateNestedValue(root, 'valuation')
}

function validateVolumePrice(json: unknown): string | null {
  const root = requireObject(json, 'volume-price')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['volume_price', 'volume', 'data'], 'volume-price')
  if (sourceError !== null) return sourceError
  const source = payloadSource(root, ['volume_price', 'volume', 'data'])
  const symbol = firstValue([source, root], ['symbol', 'ticker'])
  if (!symbol.found) return 'missing volume-price symbol'
  if (!isValidTicker(symbol.value)) return 'volume-price symbol must be a 6-digit string'
  const signal = firstValue([source, root], ['signals', 'divergence', 'divergences', 'ratio', 'volume_ratio', 'trend', 'price_trend', 'volume_trend'])
  if (!signal.found) return 'missing volume-price signal'
  const divergenceError = validateVolumeDivergence([source, root])
  if (divergenceError !== null) return divergenceError
  const knownError = validateKnownFields([source, root], {
    numbers: ['ratio', 'volume_ratio', 'price_change', 'volume_change'],
    strings: ['trend', 'price_trend', 'volume_trend'],
    arrays: ['signals', 'divergences'],
  })
  return knownError ?? validateNestedValue(root, 'volume-price')
}

function validateVolumeDivergence(sources: readonly (Record<string, unknown> | undefined)[]): string | null {
  for (const source of sources) {
    if (source === undefined || !Object.hasOwn(source, 'divergence')) continue
    const value = source.divergence
    if (typeof value === 'string') return isSafeFreeText(value, 100_000) ? null : 'volume-price divergence must be a non-empty string'
    if (typeof value === 'boolean') return null
    if (Array.isArray(value) || isRecord(value)) {
      return validateNestedValue(value, 'volume-price divergence')
    }
    return 'volume-price divergence must be a string, boolean, array, or object'
  }
  return null
}

function validateKnowledge(json: unknown): string | null {
  const root = requireObject(json, 'knowledge search')
  if (typeof root === 'string') return root
  const chunks = firstValue([root], ['chunks', 'results', 'hits', 'knowledge', 'data'])
  if (!chunks.found || !Array.isArray(chunks.value)) return 'knowledge results must be an array'
  for (let index = 0; index < chunks.value.length; index += 1) {
    const item = chunks.value[index]
    if (!isRecord(item)) return 'knowledge result ' + index + ' must be an object'
    const text = firstValue([item], ['text', 'content', 'document', 'title'])
    if (!text.found || !isSafeFreeText(text.value, 1_000_000)) return 'knowledge result ' + index + ' requires text or content'
  }
  const count = firstValue([root], ['count', 'total'])
  if (count.found) {
    const countError = numberError(count.value, 'knowledge count', 0, Number.MAX_SAFE_INTEGER, true)
    if (countError !== null) return countError
  }
  return validateNestedValue(root, 'knowledge search')
}

function validateHealth(json: unknown): string | null {
  const root = requireObject(json, 'data health')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['health', 'coverage', 'data'], 'data health')
  if (sourceError !== null) return sourceError
  const nested = firstValue([root], ['health', 'coverage', 'data'])
  const nestedSource = nested.found && isRecord(nested.value) ? nested.value : undefined
  if (nestedSource !== undefined && Object.keys(nestedSource).length === 0) return 'data health data must not be empty'
  const source = firstValue([root, nestedSource], ['source'])
  if (source.found && !isSafeFreeText(source.value, 100)) return 'data health source must be a string'
  const overall = firstValue([root, nestedSource], ['overall_ok'])
  if (overall.found && typeof overall.value !== 'boolean') return 'data health overall_ok must be boolean'
  const status = firstValue([root, nestedSource], ['status'])
  if (status.found) {
    if (typeof status.value === 'string') {
      if (!isSafeFreeText(status.value, 100)) return 'data health status must be a non-empty string'
    } else if (isRecord(status.value)) {
      if (Object.keys(status.value).length === 0) return 'data health status must not be empty'
    } else {
      return 'data health status must be string or object'
    }
  }
  if (!source.found && !status.found && !overall.found) return 'missing data health source or health data'
  if (!overall.found && !status.found && !nested.found) return 'missing data health status'
  return validateNestedValue(root, 'data health')
}

function validateFactorProfile(json: unknown): string | null {
  const root = requireObject(json, 'factor profile')
  if (typeof root === 'string') return root
  const sourceError = objectPayloadError(root, ['factor', 'factors', 'profile', 'data'], 'factor profile')
  if (sourceError !== null) return sourceError
  const source = payloadSource(root, ['factor', 'factors', 'profile', 'data'])
  const groups: readonly [readonly string[], string][] = [
    [['quality', 'quality_pct', 'quality_percentile'], 'quality'],
    [['value', 'value_pct', 'pe_percentile'], 'value'],
    [['momentum', 'momentum_pct', 'momentum_percentile'], 'momentum'],
  ]
  for (const [aliases, label] of groups) {
    const value = firstValue([source, root], aliases)
    if (!value.found) return 'missing factor profile ' + label
    if (value.value === null) continue
    const error = numberError(value.value, 'factor profile ' + label, 0, 100)
    if (error !== null) return error
  }
  const knownError = validateKnownFields([source, root], {
    nullable: true,
    percentages: ['quality', 'value', 'momentum', 'low_volatility', 'low_vol', 'quality_pct', 'value_pct', 'momentum_pct', 'quality_percentile', 'pe_percentile', 'momentum_percentile', 'low_vol_pct'],
  })
  return knownError ?? validateNestedValue(root, 'factor profile')
}

function validateScreen(json: unknown): string | null {
  const root = requireObject(json, 'screen')
  if (typeof root === 'string') return root
  const results = firstValue([root], ['results', 'rows', 'stocks', 'list', 'data'])
  if (!results.found || !Array.isArray(results.value)) return 'screen results must be an array of stock objects'
  for (let index = 0; index < results.value.length; index += 1) {
    const item = results.value[index]
    if (!isRecord(item)) return 'screen result ' + index + ' must be an object'
    const symbol = firstValue([item], ['symbol', 'ticker', 'code'])
    if (!symbol.found || !isSafeFreeText(symbol.value, MAX_SYMBOL_LENGTH)) return 'screen result ' + index + ' requires a symbol string'
    const scoreError = validateKnownFields([item], { percentages: ['quality', 'value', 'momentum', 'low_volatility', 'score'] })
    if (scoreError !== null) return scoreError
  }
  const count = firstValue([root], ['count', 'total'])
  if (count.found) {
    const countError = numberError(count.value, 'screen count', 0, Number.MAX_SAFE_INTEGER, true)
    if (countError !== null) return countError
  }
  return validateNestedValue(root, 'screen')
}

type FieldValue = { readonly found: boolean; readonly value: unknown }
type FieldSpec = { readonly nullable?: boolean; readonly numbers?: readonly string[]; readonly scores?: readonly string[]; readonly percentages?: readonly string[]; readonly strings?: readonly string[]; readonly arrays?: readonly string[] }

function requireObject(value: unknown, endpoint: string): Record<string, unknown> | string {
  return isRecord(value) ? value : endpoint + ' response must be an object'
}

function payloadSource(root: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const value = firstValue([root], keys)
  return isRecord(value.value) ? value.value : root
}

function objectPayloadError(root: Record<string, unknown>, keys: readonly string[], endpoint: string): string | null {
  const value = firstValue([root], keys)
  return value.found && !isRecord(value.value) ? endpoint + ' data must be an object' : null
}

function firstValue(sources: readonly (Record<string, unknown> | undefined)[], keys: readonly string[]): FieldValue {
  for (const source of sources) {
    if (source === undefined) continue
    for (const key of keys) {
      if (Object.hasOwn(source, key)) return { found: true, value: source[key] }
    }
  }
  return { found: false, value: undefined }
}

function numberError(value: unknown, label: string, minimum: number, maximum: number, integer = false): string | null {
  const valid = integer ? isIntegerInRange(value, minimum, maximum) : isFiniteInRange(value, minimum, maximum)
  return valid ? null : label + ' must be a finite number from ' + minimum + ' through ' + maximum + (integer ? ' and an integer' : '')
}

function scoreContainerError(value: unknown, label: string): string | null {
  if (!isRecord(value)) return numberError(value, label, 0, 100)
  const textKeys = new Set(['stance', 'label', 'signal', 'status', 'position'])
  let numericScore = false
  for (const [key, entry] of Object.entries(value)) {
    if (textKeys.has(key)) {
      if (!isSafeFreeText(entry, 32)) return label + '.' + key + ' must be a short string'
      continue
    }
    const error = numberError(entry, label + '.' + key, 0, 100)
    if (error !== null) return error
    numericScore = true
  }
  return numericScore ? null : label + ' must contain at least one 0-100 score'
}

function validateKnownFields(sources: readonly Record<string, unknown>[], spec: FieldSpec): string | null {
  for (const source of sources) {
    for (const key of spec.numbers ?? []) {
      if (Object.hasOwn(source, key)) {
        if (spec.nullable === true && source[key] === null) continue
        const error = numberError(source[key], key, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        if (error !== null) return error
      }
    }
    for (const key of spec.scores ?? []) {
      if (Object.hasOwn(source, key)) {
        if (spec.nullable === true && source[key] === null) continue
        const error = numberError(source[key], key, 0, 100)
        if (error !== null) return error
      }
    }
    for (const key of spec.percentages ?? []) {
      if (Object.hasOwn(source, key)) {
        if (spec.nullable === true && source[key] === null) continue
        const error = numberError(source[key], key, 0, 100)
        if (error !== null) return error
      }
    }
    for (const key of spec.strings ?? []) {
      if (Object.hasOwn(source, key) && !(spec.nullable === true && source[key] === null) && !isSafeFreeText(source[key], 1_000_000)) return key + ' must be a non-empty string'
    }
    for (const key of spec.arrays ?? []) {
      if (!Object.hasOwn(source, key) || spec.nullable === true && source[key] === null) continue
      const value = source[key]
      if (!Array.isArray(value)) return key + ' must be an array'
      const error = validateNestedValue(value, key)
      if (error !== null) return error
    }
  }
  return null
}

function recordArrayError(value: unknown, label: string): string | null {
  if (!Array.isArray(value)) return label + ' must be an array of objects'
  for (let index = 0; index < value.length; index += 1) {
    if (!isRecord(value[index])) return label + '[' + index + '] must be an object'
  }
  return null
}

function validateNestedValue(value: unknown, label: string, depth = 0): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : label + ' contains a non-finite number'
  if (depth > 8) return label + ' is nested too deeply'
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateNestedValue(value[index], label + '[' + index + ']', depth + 1)
      if (error !== null) return error
    }
    return null
  }
  if (!isRecord(value)) return label + ' contains an unsupported value'
  for (const [key, entry] of Object.entries(value)) {
    const error = validateNestedValue(entry, label + '.' + key, depth + 1)
    if (error !== null) return error
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isValidTicker(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value)
}

function isValidMarket(value: unknown): value is 'A' | 'H' | 'US' {
  return value === 'A' || value === 'H' || value === 'US'
}

function isValidSymbolForMarket(symbol: unknown, market: 'A' | 'H' | 'US'): symbol is string {
  if (!isSafeFreeText(symbol, MAX_SYMBOL_LENGTH)) return false
  if (market === 'A') return /^\d{6}$/.test(symbol)
  if (market === 'H') return /^\d{1,5}(?:\.HK)?$/i.test(symbol)
  return /^[A-Za-z](?:[A-Za-z0-9]|[.-](?=[A-Za-z0-9])){0,31}$/.test(symbol)
}

function isSafeFreeText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return isFiniteInRange(value, minimum, maximum) && Number.isInteger(value)
}

/**
 * Fetch and validate one JSON API response.
 *
 * @param baseUrl - Backend origin.
 * @param path - Endpoint path and query string.
 * @param http - Validated request timeout and response size limits.
 * @param callerSignal - Official tool execution cancellation signal.
 * @returns A sanitized JSON value or a bounded error value.
 */
async function getJson(baseUrl: string, path: string, http: ResolvedHttpConfig, callerSignal: AbortSignal): Promise<JsonValue> {
  const request = createRequestSignal(callerSignal, http.requestTimeoutMs)
  let response: Response | undefined
  try {
    try {
      response = await fetch(joinUrl(baseUrl, path), { signal: request.signal })
    } catch (error) {
      if (callerSignal.aborted) return { error: 'backend request cancelled for ' + path }
      if (request.timedOut() || (isAbortError(error) && request.signal.aborted)) {
        return { error: 'backend request timed out for ' + path }
      }
      return {
        error: 'AiInvestor backend unreachable for ' + path,
        detail: sanitizeDetail(error instanceof Error ? error.message : String(error)).slice(0, 200),
      }
    }

    if (!response.ok) {
      let detail = ''
      try {
        detail = sanitizeDetail(await readBodyWithCap(response, MAX_ERROR_BYTES, request.signal, http.responseCancelTimeoutMs)).slice(0, 300)
      } catch (error) {
        if (callerSignal.aborted) return { error: 'backend request cancelled for ' + path }
        if (request.timedOut()) return { error: 'backend request timed out for ' + path }
        // A status error remains useful when its diagnostic body is unavailable.
      }
      return {
        error: 'backend returned ' + response.status + ' for ' + path,
        ...(detail === '' ? {} : { detail }),
      }
    }

    let text: string
    try {
      text = await readBodyWithCap(response, http.maxResponseBytes, request.signal, http.responseCancelTimeoutMs)
    } catch (error) {
      const detail = sanitizeDetail(error instanceof Error ? error.message : String(error))
      if (detail.includes('too large')) return { error: 'backend response too large for ' + path }
      if (callerSignal.aborted) return { error: 'backend request cancelled for ' + path }
      if (request.timedOut()) return { error: 'backend request timed out for ' + path }
      return { error: 'failed to read backend response for ' + path, detail: detail.slice(0, 200) }
    }
    if (callerSignal.aborted) return { error: 'backend request cancelled for ' + path }

    let json: unknown
    try {
      json = JSON.parse(text) as unknown
    } catch (jsonParseError) {
      // Invalid JSON cannot be validated or exposed as backend data.
      void jsonParseError
      return { error: 'backend returned invalid JSON for ' + path }
    }

    if (json === null || (typeof json !== 'object' && !Array.isArray(json))) {
      return { error: 'backend returned unexpected JSON shape for ' + path }
    }
    if (isRecord(json) && Object.hasOwn(json, 'error')) {
      const rawError = json.error
      const message = typeof rawError === 'string' ? sanitizeDetail(rawError).slice(0, 300) : 'backend error'
      const result: Record<string, JsonValue> = { error: message }
      if (typeof json.code === 'string') result.code = redactSecrets(json.code).slice(0, 100)
      return result
    }
    const fieldError = endpointFields(path, json)
    if (fieldError !== null) {
      return { error: 'backend returned malformed response for ' + path + ': ' + fieldError }
    }
    if (!isJsonValue(json)) return { error: 'backend returned non-JSON data for ' + path }
    return sanitizeJson(json)
  } finally {
    request.dispose()
    if (response !== undefined) await cancelResponseBody(response, http.responseCancelTimeoutMs)
  }
}

interface RequestSignal {
  readonly signal: AbortSignal
  timedOut(): boolean
  dispose(): void
}

function createRequestSignal(callerSignal: AbortSignal, timeoutMs: number): RequestSignal {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onCallerAbort = (): void => controller.abort(callerSignal.reason)
  if (callerSignal.aborted) {
    controller.abort(callerSignal.reason)
  } else {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('request timed out', 'TimeoutError'))
    }, timeoutMs)
    unrefTimer(timer)
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: (): void => {
      if (timer !== undefined) clearTimeout(timer)
      callerSignal.removeEventListener('abort', onCallerAbort)
    },
  }
}

async function cancelResponseBody(response: Response, timeoutMs: number): Promise<void> {
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
        // Response cancellation is best effort and bounded by the timer below.
        void bodyCancellationError
      }),
      new Promise<void>(resolveTimeout => {
        timer = setTimeout(resolveTimeout, timeoutMs)
        unrefTimer(timer)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

function sanitizeJson(value: JsonValue): JsonValue {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(sanitizeJson)
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:stack|stacktrace|trace|traceback)$/i.test(key)) continue
    if (/(?:token|key|secret|password|passwd|authorization|auth|credential)/i.test(key)) {
      result[key] = '[redacted]'
    } else {
      result[key] = sanitizeJson(entry)
    }
  }
  return result
}

/** Trim top-level arrays to their most recent entries and expose totals. */
function trimArrays(value: JsonValue, keep: number): JsonValue {
  if (!isRecord(value)) return value
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length > keep) {
      result[key + '_total'] = entry.length
      result[key] = entry.slice(-keep)
    } else {
      result[key] = entry
    }
  }
  return result
}

/** Return a validation error without making an HTTP request. */
function invalidInput(message: string): JsonValue {
  return { error: message }
}

/**
 * Build the baseline read-only tool set.
 *
 * @param baseUrl - Validated backend origin.
 * @param http - Validated request timeout and response size limits.
 * @returns Exactly the baseline tool inventory.
 */
export function createTools(baseUrl: string, http: ResolvedHttpConfig = DEFAULT_HTTP_CONFIG): ToolDefinition[] {
  const request = (path: string, signal: AbortSignal): Promise<JsonValue> => getJson(baseUrl, path, http, signal)
  const definitions: ToolDefinition[] = [
    defineTool({
      name: 'ainvestor_stock_snapshot',
      description: '获取个股实时快照：现价/涨跌/成交、52周区间、近期技术信号、四维复合评分（趋势/动量/量能/结构，0-100，附 BUILD/HOLD/WATCH/EXIT 立场）。分析任何个股时先调用此工具建立全景。支持 A股（6位代码）。',
      parameters: stockSnapshotParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.ticker)) return invalidInput('invalid ticker: must be 6-digit A-share code')
        return request('/api/stocks/' + encodeURIComponent(args.ticker) + '/snapshot', exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_chan',
      description: '获取个股缠论（缠中说禅）结构：笔(bi)、线段(seg)、中枢(zs)、买卖点(bsp)，由确定性缠论引擎计算。用于判断当前走势结构、中枢位置与潜在买卖点。返回最近的结构单元（长列表已截尾，*_total 为完整数量）。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        const raw = await request('/chan/' + encodeURIComponent(args.symbol), exec.signal)
        return trimArrays(raw, 15)
      },
    }),
    defineTool({
      name: 'ainvestor_analysis_card',
      description: '获取个股启发式评分卡：基本面/技术面/风险/综合 0-100 分，附信号、优势、弱点列表。纯确定性规则计算（无LLM），适合快速体检和横向比较。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        return request('/analysis/' + encodeURIComponent(args.symbol), exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_financials',
      description: '获取个股最新财务数据：归母净利润、营业总收入、净资产、ROE、EPS 等财报指标（东财/同花顺多源）。做基本面或估值分析时调用。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        return request('/financials/' + encodeURIComponent(args.symbol), exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_bars',
      description: '获取个股日K线（OHLCV + 涨跌幅），按日期倒序。用于查看近期走势细节；缠论结构判断请优先用 ainvestor_chan。',
      parameters: {
        symbol: symbolParameters.symbol,
        n: { type: 'number', description: '返回的K线根数，默认 30，最大 120' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        const n = args.n === undefined ? 30 : args.n
        if (!isIntegerInRange(n, 1, 120)) return invalidInput('invalid n: must be integer 1-120')
        return request('/bars/' + encodeURIComponent(args.symbol) + '?n=' + n, exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_dupont',
      description: '杜邦分析：ROE = 净利率 × 总资产周转率 × 权益乘数。返回当前三因子、多期趋势、ROE 主驱动（margin/turnover/leverage）。做盈利质量/杠杆结构分析时调用。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        return request('/analysis/' + encodeURIComponent(args.symbol) + '/dupont', exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_fscore',
      description: 'Piotroski F-Score（0-9）：盈利能力、财务杠杆、经营效率九维打分，附健康等级。做财务健康体检时调用。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        return request('/analysis/' + encodeURIComponent(args.symbol) + '/fscore', exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_valuation',
      description: '估值摘要：PE_TTM、PEG、行业分位、估值水平（低估/合理/高估）。不做买卖建议。行业对比数据缺失时会明确标明，不得自行用绝对 PE 阈值顶替。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        return request('/analysis/' + encodeURIComponent(args.symbol) + '/valuation', exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_volume_price',
      description: '量价背离检测：价涨量缩、价跌量增、突破放量、异常量比。用于辅助判断量能是否支持价格方向。',
      parameters: symbolParameters,
      output: jsonOutput,
      async execute(args, exec) {
        if (!isValidTicker(args.symbol)) return invalidInput('invalid symbol: must be 6-digit A-share code')
        return request('/analysis/' + encodeURIComponent(args.symbol) + '/volume-price', exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_search_knowledge',
      description: '检索本地投资知识库（RAG）：缠论原文与释义（分型/笔/线段/中枢/买卖点）、估值方法论、投资术语、监管文件。当用户问缠论概念、估值框架、投资方法论时优先用此工具，而非凭通用知识回答。',
      parameters: {
        query: { type: 'string', description: '自然语言检索词（中文），如 "中枢是什么"、"PEG 估值方法"', required: true },
        top_k: { type: 'number', description: '返回条数，默认 5，最大 20' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        if (!isSafeFreeText(args.query, MAX_QUERY_LENGTH)) {
          return invalidInput('invalid query: must be non-empty string up to 200 chars')
        }
        const topK = args.top_k === undefined ? 5 : args.top_k
        if (!isIntegerInRange(topK, 1, 20)) return invalidInput('invalid top_k: must be integer 1-20')
        return request('/api/knowledge/search?q=' + encodeURIComponent(args.query) + '&top_k=' + topK, exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_data_health',
      description: '查询市场数据水位：各市场日K/财务/横截面的覆盖率、最新日期、相对 SLA 的滞后、最近采集任务成败，以及补数建议。当用户问数据新不新、缺不缺、港美股有没有时优先调用。',
      parameters: {},
      output: jsonOutput,
      async execute(_args, exec) {
        return request('/api/data/health', exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_factor_profile',
      description: '查询单票四风格因子分位（质量/价值/动量/低波动，各自 0-100，不合成总分）以及申万一级行业内估值分位。用户问「茅台因子画像」、某港股/美股动量波动分位时调用。market 取 A/H/US。',
      parameters: {
        symbol: { type: 'string', description: '股票代码，如 600519、00700、NVDA', required: true },
        market: { type: 'string', description: '市场：A / H / US，默认 A' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const market = args.market === undefined ? 'A' : args.market
        if (!isValidMarket(market)) return invalidInput('invalid market: must be A, H, or US')
        if (!isValidSymbolForMarket(args.symbol, market)) return invalidInput('invalid symbol for market ' + market)
        return request('/api/market/cross-section/' + encodeURIComponent(args.symbol) + '?market=' + encodeURIComponent(market), exec.signal)
      },
    }),
    defineTool({
      name: 'ainvestor_screen',
      description: '按独立风格分位筛选股票，例如「质量>90 且价值<40 前 50 只」。价值用 PE 分位越低越便宜。港美股仅覆盖指数成分宇宙（恒生综指 / S&P500 / NDX）。',
      parameters: {
        market: { type: 'string', description: 'A / H / US，默认 A' },
        quality_min: { type: 'number', description: '质量分位下限 0-100' },
        value_max: { type: 'number', description: '估值分位上限（越低越便宜）' },
        momentum_min: { type: 'number', description: '12-1 动量分位下限' },
        vol_max: { type: 'number', description: '低波动：波动分位上限' },
        industry: { type: 'string', description: '可选申万一级行业名' },
        limit: { type: 'number', description: '返回条数，默认 50，最大 200' },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const market = args.market === undefined ? 'A' : args.market
        if (!isValidMarket(market)) return invalidInput('invalid market: must be A, H, or US')
        const ranges: readonly [keyof typeof args, string][] = [
          ['quality_min', 'quality_min'],
          ['value_max', 'value_max'],
          ['momentum_min', 'momentum_min'],
          ['vol_max', 'vol_max'],
        ]
        for (const [key, label] of ranges) {
          const value = args[key]
          if (value !== undefined && !isFiniteInRange(value, 0, 100)) return invalidInput('invalid ' + label + ': must be 0-100')
        }
        if (args.limit !== undefined && !isIntegerInRange(args.limit, 1, 200)) {
          return invalidInput('invalid limit: must be integer 1-200')
        }
        if (args.industry !== undefined && !isSafeFreeText(args.industry, MAX_INDUSTRY_LENGTH)) {
          return invalidInput('invalid industry: must be non-empty and at most 100 chars')
        }
        const params = new URLSearchParams({ market })
        if (args.quality_min !== undefined) params.set('quality_min', String(args.quality_min))
        if (args.value_max !== undefined) params.set('value_max', String(args.value_max))
        if (args.momentum_min !== undefined) params.set('momentum_min', String(args.momentum_min))
        if (args.vol_max !== undefined) params.set('vol_max', String(args.vol_max))
        if (args.industry !== undefined) params.set('industry', args.industry)
        if (args.limit !== undefined) params.set('limit', String(args.limit))
        return request('/api/market/screen?' + params.toString(), exec.signal)
      },
    }),
  ]
  const names = new Set(definitions.map(definition => definition.name))
  if (definitions.length !== BASELINE_TOOL_COUNT || names.size !== BASELINE_TOOL_COUNT || BASELINE_TOOL_NAMES.some(name => !names.has(name))) {
    throw new Error('dsh-ainvestor: baseline tool inventory changed: expected the authorized 13-tool name set')
  }
  return definitions
}

/** The default response limit retained for focused module tests. */
export const MAX_BYTES = DEFAULT_HTTP_CONFIG.maxResponseBytes

/**
 * Invoke one backend request for focused module tests.
 *
 * @param baseUrl - Backend origin.
 * @param path - Endpoint path and query string.
 * @param http - Validated request timeout and response limits.
 * @param signal - Caller cancellation signal.
 * @returns A sanitized JSON result.
 */
export function _getJsonForTest(
  baseUrl: string,
  path: string,
  http: ResolvedHttpConfig = DEFAULT_HTTP_CONFIG,
  signal: AbortSignal = new AbortController().signal,
): Promise<JsonValue> {
  return getJson(baseUrl, path, http, signal)
}

export { sanitizeDetail, trimArrays }
