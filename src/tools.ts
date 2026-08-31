/**
 * Thin agent tools over the AiInvestor backend HTTP API.
 *
 * Every tool is a read-path wrapper: no writes, no LLM calls in the backend.
 * Tool results render as compact JSON; oversized arrays (Chan structures)
 * are trimmed to their tail with an explicit *_total marker so the model
 * knows truncation happened.
 */

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): { type: 'text'; text: string }[]
  }
  execute(args: Record<string, unknown>): Promise<unknown>
}

const renderJson = {
  schema: { type: 'object' } as Record<string, unknown>,
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
}

async function getJson(baseUrl: string, path: string, timeoutMs = 60_000): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { error: `AiInvestor backend unreachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return { error: `backend returned ${response.status} for ${path}`, detail: body.slice(0, 500) }
  }
  return response.json()
}

/** Trim every top-level array to its last `keep` items, marking totals. */
function trimArrays(value: unknown, keep: number): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(entry) && entry.length > keep) {
      out[`${key}_total`] = entry.length
      out[key] = entry.slice(-keep)
    } else {
      out[key] = entry
    }
  }
  return out
}

const symbolParam = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'A股6位代码，不带交易所前缀，如 "600519"、"000001"' },
  },
  required: ['symbol'],
}

export function createTools(baseUrl: string): ToolDefinition[] {
  return [
    {
      name: 'ainvestor_stock_snapshot',
      description:
        '获取个股实时快照：现价/涨跌/成交、52周区间、近期技术信号、四维复合评分（趋势/动量/量能/结构，' +
        '0-100，附 BUILD/HOLD/WATCH/EXIT 立场）。分析任何个股时先调用此工具建立全景。' +
        '支持 A股（6位代码）。',
      parameters: {
        type: 'object',
        properties: {
          ticker: { type: 'string', description: '股票代码，A股6位数字，如 "600519"' },
        },
        required: ['ticker'],
      },
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/api/stocks/${encodeURIComponent(String(args.ticker))}/snapshot`)
      },
    },
    {
      name: 'ainvestor_chan',
      description:
        '获取个股缠论（缠中说禅）结构：笔(bi)、线段(seg)、中枢(zs)、买卖点(bsp)，由确定性缠论引擎计算。' +
        '用于判断当前走势结构、中枢位置与潜在买卖点。返回最近的结构单元（长列表已截尾，*_total 为完整数量）。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        const raw = await getJson(baseUrl, `/chan/${encodeURIComponent(String(args.symbol))}`)
        return trimArrays(raw, 15)
      },
    },
    {
      name: 'ainvestor_analysis_card',
      description:
        '获取个股启发式评分卡：基本面/技术面/风险/综合 0-100 分，附信号、优势、弱点列表。' +
        '纯确定性规则计算（无LLM），适合快速体检和横向比较。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/analysis/${encodeURIComponent(String(args.symbol))}`)
      },
    },
    {
      name: 'ainvestor_financials',
      description:
        '获取个股最新财务数据：归母净利润、营业总收入、净资产、ROE、EPS 等财报指标（东财/同花顺多源）。' +
        '做基本面或估值分析时调用。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/financials/${encodeURIComponent(String(args.symbol))}`)
      },
    },
    {
      name: 'ainvestor_bars',
      description:
        '获取个股日K线（OHLCV + 涨跌幅），按日期倒序。用于查看近期走势细节；' +
        '缠论结构判断请优先用 ainvestor_chan。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'A股6位代码，如 "600519"' },
          n: { type: 'number', description: '返回的K线根数，默认 30，最大 120' },
        },
        required: ['symbol'],
      },
      output: renderJson,
      async execute(args) {
        const n = Math.min(Math.max(Number(args.n ?? 30) || 30, 1), 120)
        return getJson(baseUrl, `/bars/${encodeURIComponent(String(args.symbol))}?n=${n}`)
      },
    },
    {
      name: 'ainvestor_dupont',
      description:
        '杜邦分析：ROE = 净利率 × 总资产周转率 × 权益乘数。返回当前三因子、多期趋势、ROE 主驱动（margin/turnover/leverage）。做盈利质量/杠杆结构分析时调用。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/analysis/${encodeURIComponent(String(args.symbol))}/dupont`)
      },
    },
    {
      name: 'ainvestor_fscore',
      description:
        'Piotroski F-Score（0-9）：盈利能力、财务杠杆、经营效率九维打分，附健康等级。做财务健康体检时调用。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/analysis/${encodeURIComponent(String(args.symbol))}/fscore`, 90_000)
      },
    },
    {
      name: 'ainvestor_valuation',
      description:
        '估值摘要：PE_TTM、PEG、行业分位、估值水平（低估/合理/高估）。不做买卖建议。行业对比数据缺失时会明确标明，不得自行用绝对 PE 阈值顶替。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/analysis/${encodeURIComponent(String(args.symbol))}/valuation`, 90_000)
      },
    },
    {
      name: 'ainvestor_volume_price',
      description:
        '量价背离检测：价涨量缩、价跌量增、突破放量、异常量比。用于辅助判断量能是否支持价格方向。',
      parameters: symbolParam,
      output: renderJson,
      async execute(args) {
        return getJson(baseUrl, `/analysis/${encodeURIComponent(String(args.symbol))}/volume-price`)
      },
    },
    {
      name: 'ainvestor_search_knowledge',
      description:
        '检索本地投资知识库（RAG）：缠论原文与释义（分型/笔/线段/中枢/买卖点）、估值方法论、' +
        '投资术语、监管文件。当用户问缠论概念、估值框架、投资方法论时优先用此工具，而非凭通用知识回答。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言检索词（中文），如 "中枢是什么"、"PEG 估值方法"' },
          top_k: { type: 'number', description: '返回条数，默认 5，最大 20' },
        },
        required: ['query'],
      },
      output: renderJson,
      async execute(args) {
        const topK = Math.min(Math.max(Number(args.top_k ?? 5) || 5, 1), 20)
        return getJson(
          baseUrl,
          `/api/knowledge/search?q=${encodeURIComponent(String(args.query))}&top_k=${topK}`,
        )
      },
    },
    {
      name: 'ainvestor_data_health',
      description:
        '查询市场数据水位：各市场日K/财务/横截面的覆盖率、最新日期、相对 SLA 的滞后、最近采集任务成败，以及补数建议。' +
        '当用户问数据新不新、缺不缺、港美股有没有时优先调用。',
      parameters: { type: 'object', properties: {} },
      output: renderJson,
      async execute() {
        return getJson(baseUrl, '/api/data/health')
      },
    },
    {
      name: 'ainvestor_factor_profile',
      description:
        '查询单票四风格因子分位（质量/价值/动量/低波动，各自 0-100，不合成总分）以及申万一级行业内估值分位。' +
        '用户问「茅台因子画像」、某港股/美股动量波动分位时调用。market 取 A/H/US。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '股票代码，如 600519、00700、NVDA' },
          market: { type: 'string', description: '市场：A / H / US，默认 A' },
        },
        required: ['symbol'],
      },
      output: renderJson,
      async execute(args) {
        const market = encodeURIComponent(String(args.market ?? 'A'))
        const symbol = encodeURIComponent(String(args.symbol))
        return getJson(baseUrl, `/api/market/cross-section/${symbol}?market=${market}`)
      },
    },
    {
      name: 'ainvestor_screen',
      description:
        '按独立风格分位筛选股票，例如「质量>90 且价值<40 前 50 只」。价值用 PE 分位越低越便宜。' +
        '港美股仅覆盖指数成分宇宙（恒生综指 / S&P500 / NDX）。',
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string', description: 'A / H / US，默认 A' },
          quality_min: { type: 'number', description: '质量分位下限 0-100' },
          value_max: { type: 'number', description: '估值分位上限（越低越便宜）' },
          momentum_min: { type: 'number', description: '12-1 动量分位下限' },
          vol_max: { type: 'number', description: '低波动：波动分位上限' },
          industry: { type: 'string', description: '可选申万一级行业名' },
          limit: { type: 'number', description: '返回条数，默认 50，最大 200' },
        },
      },
      output: renderJson,
      async execute(args) {
        const params = new URLSearchParams()
        params.set('market', String(args.market ?? 'A'))
        if (args.quality_min != null) params.set('quality_min', String(args.quality_min))
        if (args.value_max != null) params.set('value_max', String(args.value_max))
        if (args.momentum_min != null) params.set('momentum_min', String(args.momentum_min))
        if (args.vol_max != null) params.set('vol_max', String(args.vol_max))
        if (args.industry) params.set('industry', String(args.industry))
        if (args.limit != null) params.set('limit', String(args.limit))
        return getJson(baseUrl, `/api/market/screen?${params.toString()}`)
      },
    },
  ]
}
