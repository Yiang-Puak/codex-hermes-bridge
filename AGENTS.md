# Codex Hermes Bridge Development Rules

Use Chinese for user-facing discussion in this workspace. Keep repository files
public-friendly unless the user explicitly asks for private notes.

## Scope

This project is a local, stdio-only MCP bridge in which Codex/Sol plans,
selects, and verifies work while Hermes profiles execute bounded Worker/Team
tasks. The TypeScript implementation under `src/` is the v2 execution core.
`skills/hermes-team/` teaches the execution workflow. The existing
`skills/hermes-review/` pipeline remains a compatibility feature and is not the
default execution path.

## Rules

1. Never commit API keys, provider credentials, private memory, local logs, or
   private absolute paths.
2. Do not add a daemon, database, queue, HTTP server, background poller, or
   model-based semantic synthesis to the bridge core.
3. Keep provider/model/distro values configuration-driven; never hard-code a
   provider, model, profile alias, or distro in execution code.
4. Keep the WSL distro configuration-driven and invoke the configured Hermes
   command directly.
5. Do not silently fall back to a paid model or another provider. Return a
   structured routing/model failure for Codex to decide.
6. Do not automatically accept hooks or resume a user's latest Hermes session.
7. Sol plans and decomposes; Hermes executes; Sol checks actual Git/test
   evidence and performs final acceptance.
8. Parallel write tasks use isolated worktrees by default. Never auto-merge or
   discard user changes.
9. Preserve the immutable bundle, reviewer independence, staged/unstaged/
   deleted/untracked collection, sensitive guard, strict JSON, and NoRun smoke
   behavior of `hermes-review`.
10. Keep top-level PowerShell wrappers as thin shims (10 lines or fewer) and do
    not duplicate canonical implementations.

## Incremental implementation

- Complete one PRD phase at a time and record its validation before proceeding.
- Read the nearest `AGENTS.md`, relevant README/config/entrypoint, and all
  callers before changing a shared function.
- Prefer the smallest correct implementation and existing dependencies.
- Add a focused test for nontrivial file, process, path, registry, or
  persistence behavior.
- Run `npm test`, `npm run typecheck`, `npm run build`, and the legacy
  `tests/smoke-no-run.ps1` at the relevant phase boundary.
- If the installed Hermes CLI differs from the PRD, inspect
  `hermes --help` and `hermes chat --help` and adapt the runtime/tests to the
  observed flags; do not rely on memory.
