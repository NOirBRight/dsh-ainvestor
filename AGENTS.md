# 插件维护边界

完整的 production / lab 约定见 `/home/noirbright/Workstation/AGENTS.md`。

## Core 边界

本项目只维护插件：官方 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 及其本地 checkout 是只读依赖。实现、兼容 Adapter、测试和构建配置留在本项目；禁止修改、携带或要求 DSH core patch。缺少公开 Interface、slot 或 RPC 时，记录缺失 seam 与上游提案，并让插件在干净的官方 tag 上降级或关闭该能力。
