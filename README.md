# dsh-ainvestor

AiInvestor analysis copilot for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Host-only plugin: it connects to (or starts) the AiInvestor-dsh backend and registers A-share analysis tools plus an investment-methodology prompt section.

This is a **spike**. The production Electron app in `AiInvestor` is unchanged. The fork checkout `AiInvestor-dsh` runs on port **8766** so it never collides with the production backend on 8765. Both share `~/.aiinvestor/data`. All spike tools are read-only.

## What it registers

| Tool | Backend route | Purpose |
|------|---------------|---------|
| `ainvestor_stock_snapshot` | `GET /api/stocks/{ticker}/snapshot` | Price, signals, 4-dim composite score |
| `ainvestor_chan` | `GET /chan/{symbol}` | Chan theory structure (bi / seg / zs / bsp) |
| `ainvestor_analysis_card` | `GET /analysis/{symbol}` | Heuristic 0–100 score card |
| `ainvestor_financials` | `GET /financials/{symbol}` | Latest financials |
| `ainvestor_bars` | `GET /bars/{symbol}` | Daily OHLCV |
| `ainvestor_dupont` | `GET /analysis/{symbol}/dupont` | DuPont three-factor ROE decomposition |
| `ainvestor_fscore` | `GET /analysis/{symbol}/fscore` | Piotroski F-Score 0–9 |
| `ainvestor_valuation` | `GET /analysis/{symbol}/valuation` | PE / PEG / industry percentile |
| `ainvestor_volume_price` | `GET /analysis/{symbol}/volume-price` | Volume-price divergence |
| `ainvestor_search_knowledge` | `GET /api/knowledge/search` | Local RAG (Chan, valuation, methodology) |

Plus a `systemPrompt` section (`ainvestor-methodology`, order 150) distilled from the original skills DAG and weekly methodology constraints (D-16..D-19). Hard rules: no buy/sell advice, no fabricated numbers, evidence-first, risk-first.

## Prerequisites

- Python 3.11+ venv already installed in `~/Workstation/AiInvestor-dsh/backend/.venv` (`uv pip install -e .`)
- `backend/.env` present (copied from the production checkout)
- DSH lab plane: `DSH_HOME=~/.dsh-lab`, web UI on port **3082**

## Lab install

```sh
cd ~/Workstation/dsh-ainvestor
pnpm install
pnpm run build

DSH_HOME=~/.dsh-lab dsh plugin --profile web add link:$(pwd)
# restart 3082 after the host plugin is added
```

Ask in a 3082 session: `帮我分析 600519`. The agent should call `ainvestor_stock_snapshot` (and typically `ainvestor_chan` / `ainvestor_analysis_card`).

## Config (optional)

| Env | Default | Meaning |
|-----|---------|---------|
| `AINVESTOR_API_PORT` | `8766` | Backend port |
| `AINVESTOR_API_URL` | `http://127.0.0.1:8766` | Base URL |
| `AINVESTOR_BACKEND_DIR` | `~/Workstation/AiInvestor-dsh/backend` | uvicorn cwd |

If `/live` already answers, the plugin attaches and will **not** kill that process on unload. If not, it spawns uvicorn and kills it when the plugin fiber disposes.

## Out of scope (spike)

- Client UI (Chan chart, scanner panel)
- Write-path tools (notes, watchlist)
- Replacing the ~13k LOC ReAct/DAG agent in the fork
- Data-pipeline debt (US/HK coverage)
