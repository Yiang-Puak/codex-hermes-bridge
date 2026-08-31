---
name: hermes-team
description: Use when Codex should delegate a planned implementation, refactor, debug, test, or independent task to a configured Hermes Worker/Team through the local MCP bridge.
---

# Hermes Team Execution

The operating split is:

```text
Sol/Codex plans and decomposes -> Hermes executes -> Sol checks Git/test evidence
```

Use Hermes when specialist context or bounded execution materially helps. Keep
tiny edits and obvious read-only questions native to Codex. Do not treat a
worker summary as proof of completion.

## Single worker

1. Inspect enough repository context to define a focused contract.
2. Unless the user explicitly names another worker, model, or provider, use
   worker `quick` (Qwen3.8-Flash through Alibaba Model Studio), including for
   broad tasks. Use worker `coder` (DeepSeek-V4-Flash through the official
   DeepSeek API) only when the user explicitly requests that route. Otherwise
   call `hermes_team_route` with `team`, `role`, and capabilities.
3. Call `hermes_worker_run` with `cwd` and a complete Task Contract:

```text
id
objective
context
requirements
scope.allowedPaths / scope.forbiddenPaths
acceptanceCriteria
validation
```

Keep each contract to a cohesive module-sized change (typically 2–4 related
implementation/test edits), not one tiny test. Set explicit file ownership,
one focused validation command, a 3–5 minute `timeoutMs`, and a suitable
`maxTurns`. On the first non-obvious validation failure, return the partial
result to Sol rather than spending many turns on broad retries.

4. Read `status`, resolved profile/provider/model, actual changed files, Git
   before/after evidence, validation output, warnings, and errors.
5. Inspect the real diff and run or verify the acceptance criteria yourself.
   Create a narrow correction task if needed.

## Parallel team

Default to one `quick` worker. Use a parallel team only when there are at least
two genuinely independent ownership scopes and parallelism is likely to save
meaningful wall time. Sol decomposes only independent tasks. Call `hermes_team_run` with
`mode=parallel`, unique IDs, explicit workers, ownership/scope, acceptance
criteria, and validation. The bridge bounds concurrency, keeps all results with
`Promise.allSettled`-style behavior, and uses a separate worktree for
write-capable workers by default. It never auto-merges; Sol decides how to
integrate branches.

Add an integration worker only when the parallel outputs have cross-module
interfaces or behavior that require semantic reconciliation. Disjoint file
changes do not automatically require another model call. Give an integration
worker worktree paths and concise Git evidence, not full worker transcripts.

## Routing and model policy

- Explicit worker selection wins over team role and capability filtering.
- Unspecified requests resolve to the configured `routing.defaultWorker`
  (`quick` in the public configuration); do not switch models based only on
  task complexity.
- A different worker/model/provider requires an explicit user request.
- Registry model references resolve to explicit Hermes `--provider` and
  `--model` values.
- `modelOverride` accepts either a registry reference or one unique configured
  provider-facing model name. Prefer `worker: quick` for the configured
  Qwen3.8-Flash route.
- A missing or disabled model/provider is a routing failure.
- Do not silently fall back to a paid or unrelated model. Ask Sol/user to
  choose another configured route.
- Credentials remain in Hermes configuration/environment, never in registry or
  task output.

## Task prompt discipline

The bridge sends ROLE, OBJECTIVE, CONTEXT, CURRENT STATE, SCOPE/OWNERSHIP,
REQUIREMENTS, CONSTRAINTS, EXECUTION PROCEDURE, ACCEPTANCE CRITERIA,
VALIDATION, and a final evidence contract. Do not use vague worker requests
such as “fix it” as the formal task.

The bridge sends compact current state, not the repository contents. Start
inside `allowedPaths`; do not recursively search unrelated directories. On a
dirty workspace, treat `evidence.changedFiles` as the task's before/after
incremental change set, then inspect its real diff. For Windows-only tooling,
use a worker configured with `runtime: direct`; leave WSL workers to run
portable checks. On timeout or `budget_exhausted`, inspect the retained tail
report and incremental files before resuming instead of starting over.

## Safety

Side-effect policy is a prompt guardrail plus deterministic post-run checking,
not an OS sandbox. Do not enable hooks, destructive Git operations, commits, or
external side effects unless the contract explicitly permits them. Preserve
pre-existing user changes. Check out-of-scope files and `HEAD` changes.

`hermes-review` is a separate legacy compatibility pipeline. Use it only when
the user explicitly asks for an independent review/panel; it is not the normal
execution path.
