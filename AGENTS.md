# Codex Hermes Bridge Development Rules

Use Chinese for user-facing discussion in this workspace. Keep repository files public-friendly unless the user explicitly asks for private notes.

## Scope

This project packages a minimal local Codex -> Hermes workflow. `skills/hermes-review/` is the only implementation source; `tools/hermes-review.ps1` is a compatibility shim.

## Rules

1. Do not commit API keys, provider config, real manuscript content, private paths, or local logs.
2. Keep the top-level wrapper at 10 lines or fewer and never duplicate the canonical implementation.
3. Use `tests/smoke-no-run.ps1` after wrapper, Skill, config, or template changes.
4. Keep the Skill concise. Put the only full human-facing manual in `README.md`.
5. Keep reports temporary unless `-KeepReport` or `-OutputPath` is explicit.
6. Maintain one profile config, one result schema, and one JSON output format.
7. Keep the canonical script under 900 lines and smoke tests under 250 lines.
8. Do not add MCP, daemon, database, queue, Web UI, generated copies, or model-based synthesis inside the wrapper.

## Minimal-change guardrails

- State the root cause and assumptions before changing code; do not silently choose among ambiguous interpretations.
- Prefer an existing file, configuration switch, or built-in capability over a new file or abstraction.
- Do not add speculative flexibility, duplicate implementations, or adjacent cleanup; every changed line must trace to the request.
- Define a testable success condition and run it before declaring the change complete.
