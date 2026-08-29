# v2 Phase Status

Recorded: 2026-08-29 (Asia/Shanghai)

## Completed

- Phase -1: cloned and read the reference repository outside the target,
  recorded commit `ff892ab5238af227981bb3f3bc8ba588bdf0ccd3`, ran its install,
  tests, typecheck, build, and diff checks, and wrote the reuse/reject analysis.
- Phase 0: froze the pre-v2 tree and kept the legacy no-run review smoke as a
  migration guard.
- Phases 1-4: added the TypeScript package, stdio MCP server, YAML/Zod
  registries, deterministic resolver, direct/WSL runtimes, Task Contract,
  worker execution, structured results, and Git evidence.
- Phase 5: ran disposable real-runtime smoke tests through the configured Qwen
  and DeepSeek routes. The retired paid route is no longer used. Credentials
  were not written to the repository or test output.
- Phase 6: made `hermes-team` the execution Skill and updated the plugin
  manifest; kept `hermes-review` as an explicit compatibility Skill.
- Phase 7: added bounded parallel Team execution with isolated worktrees for
  write-capable tasks, all-settled results, and no auto-merge.
- Phase 8: added an optional bounded read-only/advice panel. It is disabled by
  default and returns independent results without semantic synthesis.
- Phase 10: made MCP the documented default, parameterized the deprecated
  PowerShell executor, removed fixed runtime/model values from execution code,
  and updated the changelog.

## Intentionally deferred

- Phase 9 Kanban durable tasks: not implemented, so no Kanban MCP tools are
  registered.
- Automatic merge, task dependency scheduling, durable queues, daemon mode,
  database persistence, HTTP transport, and model-based bridge synthesis are
  outside this local P0/P1 bridge.

## Final checks

The current source passes:

```text
npm test -- --run                 18 passed, 1 environment-gated skipped
npm run typecheck                 passed
npm run build                     passed
tests/smoke-no-run.ps1            passed; Hermes was not called
git diff --check                  passed
doctor with examples/team.yaml   passed against Hermes v0.13.0
```

The real smoke test remains opt-in through `CHB_REAL_PROFILE`,
`CHB_REAL_PROVIDER`, and `CHB_REAL_MODEL`; normal unit tests never call a
model.
