# Phase 0 Baseline Freeze

Recorded: 2026-08-26 (Asia/Shanghai)

## Scope

The pre-v2 target was a plugin/review repository with a PowerShell Hermes
review pipeline. It had no TypeScript package, MCP server, runtime registry, or
worker execution layer. The current `hermes-exec.ps1` files were pre-existing
user work and are preserved as migration input, not treated as the v2 core.

## Pre-existing working-tree changes

Before the v2 implementation began, the target contained these user-owned
changes:

```text
M  AGENTS.md
M  README.md
?? skills/hermes-review/scripts/hermes-exec.ps1
?? tools/hermes-exec.ps1
```

The review implementation and its test assets were not rewritten for this
baseline. New v2 files must avoid overwriting these changes.

## Baseline tree

```text
.codex-plugin/plugin.json
examples/AGENTS.code.md
examples/AGENTS.paper.md
skills/hermes-review/{SKILL.md,agents,config,schemas,scripts}
tests/smoke-no-run.ps1
tools/hermes-review.ps1
tools/hermes-exec.ps1
```

There was no `package.json`, `tsconfig.json`, or `src/` implementation at this
point.

## Baseline validation

Command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\smoke-no-run.ps1
```

Result: PASS. All six no-run smoke groups passed, including paper reviewer
isolation/order, code-deep assignment, legacy invocation compatibility, Git
modified/deleted/untracked collection, blocked-image coverage, and sensitive
content rejection. The output explicitly confirmed: `Hermes was not called.`

This is the migration guard. It must continue to pass after every phase that
touches the legacy review assets and before final delivery.
