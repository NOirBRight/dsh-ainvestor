# 插件维护边界

完整的 production / lab 约定见 `/home/noirbright/Workstation/AGENTS.md`。

## Core 边界

本项目只维护插件：官方 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 及其本地 checkout 是只读依赖。实现、兼容 Adapter、测试和构建配置留在本项目；禁止修改、携带或要求 DSH core patch。缺少公开 Interface、slot 或 RPC 时，记录缺失 seam 与上游提案，并让插件在干净的官方 tag 上降级或关闭该能力。

## LAB-only / private / local Git provenance

- 本插件是自有的 LAB-only 插件，`package.json` 为 `private: true`，在 provenance/release 另行批准前不得发布、打 tag、push 或作为 `github:` specifier 进入 production (`~/.dsh`)。唯一试验面为 `DSH_HOME=~/.dsh-lab` 的 3082。
- 本目录是本地 Git 仓库，基线为一次提交 `chore: capture dsh-ainvestor spike baseline` (SHA `e9aa2dd5fa2fc6af78c11e7afaa5b5580d0f2eea`)；后续实现保持为从该基线起的未提交 worktree diff（`git diff` / `git diff --stat`），供 review。不要创建 remote、不要 push/tag/release。
- 不要在文档或脚本中指示用户去拷贝 production `.env` 或假定 `~/Workstation/AiInvestor-dsh` 兄弟 checkout 存在。所有路径与归属必须显式配置。

## Explicit backend config

- 后端配置为显式 discriminated union（`BackendSpec`），在 `resolveBackendSpec` 中一次性校验，`Config` 的 `~standard` 在加载前失败，失败即插件加载失败，不产生副作用。
- `attach`: 必填 `baseUrl`；probe/validate `/live`；不可用则加载失败；永不启动或 kill 进程。
- `spawn`: 必填 `baseUrl` + 显式 `cwd`/`command`/`args`（或等价显式校验字段）；插件从 spawn 到 termination 完全拥有子进程；早期退出/超时则 kill 已拥有进程并加载失败；不会因为别的服务碰巧回答 `/live` 就 attach。
- 禁止任何 `Workstation`/`home`/`backendDir`/`port`/`environment` fallback 来决定归属或路径。缺省即校验失败。

## Lifecycle / Cordis

- 使用官方 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-system-prompt` 的 alpha.* 类型与 augmentations，并以 `@deepseek-ai/cordis` 的 `ctx.effect` / disposer 作为唯一生命周期机制；禁止重建 `ToolsService`/`SystemPromptService` 或 `effect`/`on` fallback。
- 整个 setup 归属于一个可取消的、teardown-safe 的 effect（或等价 Cordis lifecycle）：若 unload 与 startup 竞态，abort probes、终止已拥有子进程、绝不注册 tools。
- Tool + methodology 注册是原子的：捕获每一个 `register`/`section` disposer；任一失败则逆序 dispose 已有贡献并释放已拥有后端；不允许 3/10 的部分状态，且不允许 log-FATAL-return 半插件。
- Dispose 幂等：spawned 进程先 bounded graceful `SIGTERM` (5s) 再仅当仍存活时升级为 `SIGKILL`；attached 永远不 kill；所有成功/失败路径上关闭 log 文件描述符与定时器。
