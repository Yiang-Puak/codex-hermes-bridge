# codex-hermes-bridge

本项目是一个本地、stdio-only 的 Codex/Sol → Hermes Worker/Team 执行桥。

Codex/Sol 负责理解需求、规划、拆解任务、选择 worker 和最终验收；MCP bridge 负责确定性路由、runtime 适配、并发、工作区隔离和 Git 证据；Hermes 负责实际执行。Provider、model、profile 和 WSL distro 都来自配置，仓库不保存 API key，也不启动 daemon、数据库或 HTTP 服务。

默认工作流是 `hermes-team` 执行 Skill。原有 `hermes-review` immutable-bundle 审查流水线继续保留，但只有用户明确要求独立审查时才使用。

## 工作流

```text
User -> Codex/Sol plan -> MCP bridge route -> Hermes profile/model
     -> worker edits/tests -> structured Git evidence -> Codex/Sol acceptance
```

并行写任务默认使用独立 Git worktree；bridge 不自动 merge、不回滚用户改动、不替 Codex 判断代码是否正确。

## 快速开始

前置条件：Node.js 20+、已安装并可从目标 runtime 调用的 Hermes CLI，以及至少一个已经配置好的 Hermes profile/provider credential。

在仓库根目录执行：

```powershell
npm ci
npm run build
node ./dist/index.js init-config
node ./dist/index.js doctor
```

`init-config` 默认生成 `%USERPROFILE%/.codex-hermes-bridge/team.yaml`。也可以通过 `CODEX_HERMES_BRIDGE_CONFIG` 指定配置文件。

把 [examples/team.yaml](examples/team.yaml) 复制到用户配置目录后，按本机的 profile、provider、model 和 runtime 修改。公开示例和默认本机配置将未指定模型的请求固定路由到 `quick`（DeepSeek 官方 API `deepseek-v4.1-flash`）；只有用户明确指定其他 worker、model 或 provider 时才切换到其他路由。旧的 `deepseek-v4-flash` 和 Qwen 路由仍可显式配置使用。

在 Codex 配置中添加 MCP server：

```toml
[mcp_servers.hermes]
command = "node"
args = ["C:/path/to/codex-hermes-bridge/dist/index.js"]

[mcp_servers.hermes.env]
CODEX_HERMES_BRIDGE_CONFIG = "C:/Users/you/.codex-hermes-bridge/team.yaml"
```

也可以执行 `npm link` 后使用包名；完整模板见 [examples/codex-config.example.toml](examples/codex-config.example.toml)。重启 Codex 后，bridge 通过 stdio 提供 MCP tools。

## MCP tools

- `hermes_bridge_health`：检查 runtime、Hermes 版本和 registry 计数，不调用模型。
- `hermes_team_list`：列出公开的 Team/Worker/Model/Provider metadata 和 Hermes profiles，不返回 secret。
- `hermes_team_route`：按 team、role、worker、capability 和 cost preference 做确定性路由。
- `hermes_worker_run`：执行一个完整 Task Contract，并返回本次执行的 Git 增量证据、阶段进度、exit code 和经过长度上限处理的 worker 报告；可按次覆盖 `timeoutMs`、`maxTurns`。
- `hermes_team_run`：并发执行 Codex 已经拆好的独立任务；并发上限受全局、Team 和本次请求三层限制。
- `hermes_panel_run`：可选的只读/advice panel，必须在配置中启用；bridge 只返回独立结果，不做语义综合。

默认优先使用一个 `quick` worker。只有存在至少两个真正独立的 ownership scope，且并行能明显节约时间时，才使用 `hermes_team_run`。只有并行输出存在跨模块接口或行为需要语义整合时，才额外调用整合 worker；互不冲突的文件修改不应机械增加一次模型调用。bridge 不自动猜测“谁负责整合”，也不自动 merge，整合责任仍由 Codex/Sol 控制。

Kanban durable-task tools 当前未实现，也不会在关闭时注册。独立 review 仍走兼容的 `hermes-review` Skill，不会被普通 worker 调用隐式触发。

## 优化基准

在同一个事件溯源 Python job queue 任务上，默认单 `qwen3.8-flash` worker
相较于旧的 3 workers + 1 integrator 配置，将 Hermes/Qwen token 从
2,627,930 降到 488,198（减少 81.4%），API calls 从 74 降到 15，同时保持
20/20 测试通过。完整方法、限制和对照数据见
[docs/optimized-benchmark.md](docs/optimized-benchmark.md)。该数据不包含协调 Codex
会话的 token，因此不作为完整系统成本承诺。

## Task Contract

每个执行任务至少包含 `id`、`objective`、`context`、`requirements`、`scope`、`acceptanceCriteria` 和 `validation`。scope 使用 `allowedPaths` / `forbiddenPaths`；可选字段包括 `dependsOn`、`ownership`、`knownRisks`、`constraints` 和 `expectedOutput`。

bridge 不会把整个仓库打包进 prompt。它发送合同、Git HEAD、脏路径总数及任务范围内的既有脏路径；worker 必须先读取 `allowedPaths`，只有命名依赖确有需要才读取其他文件。合同仍会包含 `ROLE`、`OBJECTIVE`、`CONTEXT`、`CURRENT STATE`、`SCOPE / OWNERSHIP`、`REQUIREMENTS`、`CONSTRAINTS`、`EXECUTION PROCEDURE`、`ACCEPTANCE CRITERIA`、`VALIDATION` 和 `FINAL RESPONSE CONTRACT`。Sol 必须检查实际 diff 和测试结果，不能只相信 Hermes 的文字总结。

实践上不要把“新增一条测试”单独派给 Hermes。将同一模块内 2–4 个相互关联的实现与测试组合成一个边界清楚的合同；给出最多一次的验证命令，并在第一次明确失败后交回 Codex。这样避免 agent 为极小改动重复重建工作区上下文。

## Registry 与模型替换

配置关系是 `Team role -> Worker -> profile + modelRef -> Provider + model`。显式 `worker` 优先于 role；没有显式 worker/role 时使用 `routing.defaultWorker`；显式 `modelOverride` 只有在 `routing.allowModelOverride` 开启时生效。`modelOverride` 可使用 registry 引用（如 `qwen-flash`）或唯一的真实模型名（如 `qwen3.8-flash`）；名称映射到多个 registry 项时 bridge 拒绝猜测。model 缺失、disabled、provider 缺失或 route 不可用都会返回结构化失败；默认不会静默切换到付费模型或其他 provider。

当前示例中 `routing.defaultWorker: quick`，所以未指定路由时使用 `provider: deepseek` 的 `deepseek-v4.1-flash`。调用时只有明确传 `worker`、对应 `role` 或 `modelOverride` 才切换到其他配置路由；bridge 不根据自然语言猜任务复杂度，也不会在模型之间静默 fallback。

Provider credential 由 Hermes 自己管理或从环境读取。不要把 `sk-...`、`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY` 或任何其他 secret 写入本仓库、Task Contract、MCP 参数或 worker 输出。

## Hermes CLI 兼容性

`hermes.queryMode` 默认是 `auto`。bridge 会检查 `hermes chat --help`：当前 Hermes v0.13.0 如果没有 `--query-file`，使用 argv `--query`；支持它的版本使用 `--query-file -`，通过 stdin 传递完整 prompt。两条路径都不依赖自定义 profile alias，也不把 task body 拼进 shell command。

因此，不需要仅因为 `--query-file` 而立即升级 Hermes。若要使用新 CLI 的其他功能，再单独升级并重新运行 `doctor`、单元测试和一次 disposable smoke。

## Runtime 与安全边界

- `direct` runtime 直接启动配置中的 Hermes command；`wsl` runtime 使用配置中的 distro、cwd 和 command。每个 worker 都可用 `runtime`、`command`、`distro` 覆盖全局设置。因此可让一般任务继续走 WSL，同时为需要 `flutter.bat` 等 Windows-only 工具的 worker 配置 `runtime: direct` 和原生 Windows Hermes command，不通过 `cmd.exe /c` 包装。
- child process 使用 argv 数组，不经过 shell；超时先请求结束，5 秒仍未退出才强制结束，并返回 `timed_out`、已落盘的增量证据与末尾 worker 报告，便于从中间结果继续。
- worker 可配置 `maxTurns`，本次调用也可覆盖 `maxTurns`；bridge 会传递 Hermes `--max-turns`，并将明确的迭代预算耗尽标记为 `budget_exhausted`。简单任务建议保持 30；需要更长执行时显式提高，超过 50 时优先拆分。
- MCP 调用带 progress token 时，bridge 会在路由、执行前后证据、完成/超时阶段发送进度，并每 30 秒发送 heartbeat。
- Hermes quiet-mode 返回 session ID 时，bridge 通过公开的 `sessions export` 接口采集 token、API call 和成本状态，team result 会汇总各 worker 用量；不读取 Hermes 私有数据库，采集失败也不会改变执行结果。
- `safety.allowedWorkspaceRoots` 可限制 bridge 接受的 workspace 根目录。
- `acceptHooks` 和 `allowWorkerCommits` 默认关闭；外部副作用必须由配置和任务合同明确允许。
- Git evidence 是确定性证据，不是 sandbox；它会对任务前后每个脏路径比较状态与内容指纹，只报告本次净变更，并在允许提交时加上本次 HEAD 范围内的 commit diff。既有脏文件未被 worker 改动不会混入 `changedFiles`；已有脏文件被再次修改会被正确报告。并行 worktree 位于系统临时目录，不污染目标仓库；bridge 不会自动删除、回滚或覆盖用户已有修改。

## 旧 PowerShell 入口

`tools/hermes-exec.ps1` 及其 canonical script 现在只是 deprecated compatibility entry，不是默认入口，也不再绑定某个模型。若暂时使用它，必须显式传入 `-WslDistro`、`-Profile`、`-Provider` 和 `-Model`；长远使用请迁移到 `hermes_worker_run`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "./tools/hermes-exec.ps1" `
  -ProjectRoot "D:/path/to/project" `
  -TaskFile "D:/path/to/task.md" `
  -WslDistro "Ubuntu-24.04" `
  -Profile "default" -Provider "alibaba" `
  -Model "qwen3.8-flash" -Toolsets hermes-cli
```

旧 `hermes-review` wrapper 仍保持兼容，且只有显式审查请求才使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "./tools/hermes-review.ps1" `
  -Preset code -ProjectRoot "D:/path/to/project" `
  -Prompt "明确要求的独立代码审查。" -NoRun
```

immutable bundle、staged/unstaged/deleted/untracked 收集、敏感内容拦截和 reviewer 隔离都继续保留。

## Plugin / Skill

- `skills/hermes-team/` 是默认执行 Skill：Sol 规划，Hermes 执行，Sol 验收。
- `skills/hermes-review/` 是显式请求时使用的独立审查兼容 Skill。
- `.codex-plugin/plugin.json` 提供 plugin manifest；复制 plugin 时保留两个 Skill 目录。

## 开发验证

```powershell
npm test -- --run
npm run typecheck
npm run build
git diff --check
powershell -NoProfile -ExecutionPolicy Bypass -File ./tests/smoke-no-run.ps1
```

最后一个 smoke 测试只验证旧 review pipeline，不调用模型；带 `CHB_REAL_PROFILE`、`CHB_REAL_PROVIDER` 和 `CHB_REAL_MODEL` 环境变量时，`tests/real-hermes-smoke.test.ts` 才会执行一次 disposable Git fixture 的真实 runtime smoke。

参考源码研究与迁移决策记录在 [docs/reference-analysis.md](docs/reference-analysis.md)，Phase 0 基线记录在 [docs/baseline-freeze.md](docs/baseline-freeze.md)。
