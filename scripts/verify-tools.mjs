#!/usr/bin/env node
/** Lab smoke: hit every ainvestor_* backend path the plugin wraps. */

const base = process.env.AINVESTOR_API_URL ?? 'http://127.0.0.1:8766'
const symbol = process.argv[2] ?? '600519'

const checks = [
  ['live', '/live'],
  ['snapshot', `/api/stocks/${symbol}/snapshot`],
  ['chan', `/chan/${symbol}`],
  ['analysis', `/analysis/${symbol}`],
  ['financials', `/financials/${symbol}`],
  ['bars', `/bars/${symbol}?n=5`],
  ['dupont', `/analysis/${symbol}/dupont`],
  ['fscore', `/analysis/${symbol}/fscore`],
  ['valuation', `/analysis/${symbol}/valuation`],
  ['volume-price', `/analysis/${symbol}/volume-price`],
  ['knowledge', `/api/knowledge/search?q=${encodeURIComponent('中枢是什么')}&top_k=2`],
]

let failed = 0
for (const [name, path] of checks) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) })
    const body = await response.text()
    const ok = response.ok && !body.includes('"error"')
    const preview = body.replace(/\s+/g, ' ').slice(0, 120)
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${response.status} ${preview}`)
    if (!ok) failed += 1
  } catch (error) {
    console.log(`FAIL ${name} ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}
process.exit(failed === 0 ? 0 : 1)
