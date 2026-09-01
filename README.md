# dsh-ainvestor

AiInvestor analysis copilot for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Public Host-only plugin: it connects to or spawns the AiInvestor backend and registers A-share analysis tools plus an investment-methodology prompt section.

This release preserves all 13 read-only analysis tools and methodology semantics, and enforces explicit backend ownership.

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
| `ainvestor_data_health` | `GET /api/data/health` | Data coverage and freshness |
| `ainvestor_factor_profile` | `GET /api/market/cross-section/{symbol}` | Factor exposures |
| `ainvestor_screen` | `GET /api/market/screen` | Style-factor screening |

Plus a `systemPrompt` section (`ainvestor-methodology`, order 150) distilled from the original skills DAG and weekly research methodology. Hard rules: no buy/sell advice, no fabricated numbers, evidence-first, risk-first.

All tools validate backend HTTP status, timeout/abort, response size (5 MiB by default), and endpoint-specific JSON fields and numeric ranges before returning model-visible output; validators accept the backend envelopes for top-level bars arrays, nullable factor percentiles, screen rows, nested DuPont/F-Score values, and nullable financial indicator tables with optional `pe_ttm`; credentials and backend stack traces are never included.

## Explicit backend modes (no fallback)

Only explicit attach or spawn configuration selects backend ownership; the plugin does not read environment or home-directory defaults. Configuration is a validated discriminated union.

### attach mode
```json
{
  "mode": "attach",
  "baseUrl": "http://127.0.0.1:8766",
  "probeTimeoutMs": 2000
}
```
- `baseUrl` is required and must be a valid http(s) origin without credentials, path, query, or hash; a trailing slash is normalized away.
- Plugin probes `GET {baseUrl}/live`; a successful HTTP response is sufficient for attachment.
- `probeTimeoutMs` bounds each readiness probe and response-body cancellation in milliseconds; it defaults to 2000 and accepts integers from 1 through 600000.
- Plugin never starts or kills the process.

### spawn mode
```json
{
  "mode": "spawn",
  "baseUrl": "http://127.0.0.1:8766",
  "cwd": "/absolute/path/to/backend",
  "command": "./.venv/bin/uvicorn",
  "args": ["main:app", "--host", "127.0.0.1", "--port", "8766"],
  "logPath": "/absolute/path/to/backend.log",
  "env": { "LANG": "C.UTF-8" },
  "startupTimeoutMs": 90000,
  "probeIntervalMs": 1000,
  "probeTimeoutMs": 2000,
  "terminationGraceMs": 5000,
  "forceTerminationWaitMs": 2000
}
```
- `baseUrl`, `cwd`, `command`, an explicit `args` array, and an explicit `logPath` are required; `env` is optional. Relative `logPath` values resolve from `cwd`; the plugin never creates an implicit `backend.log` or other deployment path.
- Spawn mode always starts the configured child, even when another process already answers the same `baseUrl`; the plugin owns only the child it starts.
- Each spawn receives a cryptographically random `DSH_AINVESTOR_INSTANCE_TOKEN` environment value. Only `PATH`, `HOME`, `USER`, `LANG`, `TMP`, `TEMP`, `CI`, and Windows launcher roots are forwarded from `env`; arbitrary and sensitive keys containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL`, or `AUTH` are dropped. Environment keys cannot contain `=`; the token key is reserved case-insensitively and rejected in user-provided `env`.
- Readiness requires HTTP success from `GET {baseUrl}/live` plus an exact `x-dsh-ainvestor-instance-token` response-header echo. Missing or wrong echoes fail startup and trigger owned cleanup; the token is never included in URLs, logs, or diagnostics.
- The handshake authenticates only a cooperating backend that received the child environment. An occupied or concurrently reused port remains a deployment limitation: the child must bind the configured port and implement the handshake; the plugin does not claim cryptographic identity for unsupported backends.
- If the child exits before authenticated readiness—including while another responder becomes live—or readiness does not arrive within `startupTimeoutMs`, the plugin kills the owned process and **load fails**. Post-probe exit checks prevent readiness from being accepted after an observed child exit.
- `logPath` is required and is the only child log destination; stdout and stderr pass through a token-redacting writer, including when output splits the token across chunks. Relative values resolve from `cwd`. Listener registries close before child termination; `terminationGraceMs` and `forceTerminationWaitMs` default to 5000 and 2000 milliseconds; each accepts a safe integer from 1 through 600000. Unload is idempotent: the spawned child gets bounded graceful `SIGTERM`, then escalation to `SIGKILL` only if still alive; attached backends are never killed. Log file descriptors and timers are closed on every success/failure path.
- Startup is cancellable: if unload races startup, probes are aborted, owned child is terminated, and tools are never registered.
- Both modes accept an optional `http` object: `requestTimeoutMs` (1–600000), `maxResponseBytes` (1024–52428800), and `responseCancelTimeoutMs` (1–600000). Defaults are 60000 ms, 5 MiB, and 2000 ms; the 4 KiB error diagnostic cap remains fixed.

## Development and lab verification

Production `~/.dsh` is not used. All verification runs on the lab plane (`DSH_HOME=~/.dsh-lab`, web UI on port 3082).

```sh
cd ~/Workstation/dsh-ainvestor
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test

DSH_HOME=~/.dsh-lab dsh plugin --profile web add link:$(pwd)
# restart lab web (3082) after the host plugin is added
DSH_HOME=~/.dsh-lab dsh web --port 3082
```

Ask in a 3082 session: `帮我分析 600519`. The agent should call `ainvestor_stock_snapshot` (and typically `ainvestor_chan` / `ainvestor_analysis_card`).

This package is a public release. Production installation must use the signed GitHub Release tarball and the explicit backend configuration above.

## Configuration

The plugin ignores `AINVESTOR_API_URL`, `AINVESTOR_BACKEND_DIR`, and ambient process settings. Use an explicit backend specification.

Attach configuration:
```yaml
# cordis.yml for plugin config
plugins:
  - name: ainvestor
    config:
      mode: attach
      baseUrl: http://127.0.0.1:8766
      probeTimeoutMs: 2000
```

Spawn configuration:
```yaml
plugins:
  - name: ainvestor
    config:
      mode: spawn
      baseUrl: http://127.0.0.1:8766
      cwd: /home/user/work/backend   # explicit, no ~/Workstation fallback
      command: ./.venv/bin/uvicorn
      args: ["main:app", "--host", "127.0.0.1", "--port", "8766"]
      logPath: /home/user/work/backend/backend.log
      startupTimeoutMs: 90000
      probeIntervalMs: 1000
      probeTimeoutMs: 2000
      terminationGraceMs: 5000
      forceTerminationWaitMs: 2000
```

Any missing required field or unknown mode is rejected before any probe or spawn; asynchronous backend and registration failures reject the startup promise after cleanup.

## Local Git provenance

The directory is a local Git repo with a single baseline commit and a reviewable worktree diff:

- Baseline: `chore: capture dsh-ainvestor spike baseline` — SHA `e9aa2dd5fa2fc6af78c11e7afaa5b5580d0f2eea`
- Current implementation remains as uncommitted diff from that baseline (`git diff`, `git diff --cached`). No remote, push, tag, or release is created until provenance is approved.

```sh
git -C ~/Workstation/dsh-ainvestor log --oneline -1
git -C ~/Workstation/dsh-ainvestor status
git -C ~/Workstation/dsh-ainvestor diff --stat
git -C ~/Workstation/dsh-ainvestor diff --check
```

## Verification

```sh
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run pack:check   # hard gate: 87 exact alpha.1/registry fixtures, fresh invalid-registry offline pnpm, Host apply/invariants, and plugin tgz SHA
```

## Backend API / version provenance gap

- The backend at `{baseUrl}` (AiInvestor-dsh FastAPI on `/live` etc.) is still an out-of-tree Python service without a pinned API version or schema file in this repo. Spawn mode additionally requires it to read `DSH_AINVESTOR_INSTANCE_TOKEN` and echo the exact value in `x-dsh-ainvestor-instance-token` on successful `/live`; attach mode uses ordinary `/live`. Tool response validation checks status/size/JSON fields, but there is no checked-in OpenAPI spec or version gate.
- No `AiInvestor-dsh` commit or build artifact is vendored here; the plugin assumes the backend implements the 13 routes and spawn handshake listed above. Pinning that backend's commit and adding an out-of-tree contract test fixture remains open.
- DSH Tool and System Prompt types are imported from the official alpha.1 package artifacts: `@deepseek-ai/dsh-tools@0.1.2-alpha.1` and `@deepseek-ai/dsh-system-prompt@0.1.2-alpha.1`. Their complete published runtime/type closure plus the recursive registry closure (87 real tarballs total) is recorded under `fixtures/alpha1/tarballs/` and checked by `pnpm run pack:check`.

## Out of scope

- Client UI (Chan chart, scanner panel)
- Write-path tools (notes, watchlist)
- Replacing the ~13k LOC ReAct/DAG agent in the fork
- Data-pipeline debt (US/HK coverage)
- Backend implementation and its market-data licensing remain outside this package.


## Release installation (Latest)

Host-only A-share analysis tools and methodology prompt; the backend is explicitly attached or spawned by configuration. The release artifact targets DeepSeek Harness 0.1.2-alpha.1 and contains built Host/Client files only; it has no sibling-repository source, workstation path, link:, or workspace: dependency.

Latest installation (the URL never contains a version):

~~~sh
dsh plugin --profile web add --force \
  https://github.com/NOirBRight/dsh-ainvestor/releases/latest/download/dsh-ainvestor.tgz
~~~

Fixed-version installation:

~~~sh
dsh plugin --profile web add --force \
  https://github.com/NOirBRight/dsh-ainvestor/releases/download/v0.1.0/dsh-ainvestor.tgz
~~~

Update, uninstall, and verify:

~~~sh
# Update to the latest Release
dsh plugin --profile web add --force \
  https://github.com/NOirBRight/dsh-ainvestor/releases/latest/download/dsh-ainvestor.tgz
# Verify the loaded version
dsh plugin --profile web list
dsh plugin --profile web doctor
# Uninstall only this plugin
dsh plugin --profile web remove dsh-ainvestor
~~~

Configuration: use the plugin section in Settings for Web UI plugins, or the profile dsh.profile.bundles entry for Host-only plugins. Start with this README's minimal YAML/JSON example and provide credentials/backend addresses explicitly.

Rollback: rerun the fixed v0.1.0 command, verify the profile list, then restart the Web service once. Inspect journalctl --user -u dsh-web.service and dsh plugin --profile web doctor; never put a source checkout in the production profile.

Release and integrity: [v0.1.0](https://github.com/NOirBRight/dsh-ainvestor/releases/tag/v0.1.0) · [SHA256SUMS](https://github.com/NOirBRight/dsh-ainvestor/releases/download/v0.1.0/SHA256SUMS).
