# Codex Hermes Bridge Development Rules

Use Chinese for user-facing discussion in this workspace. Keep repository files public-friendly unless the user explicitly asks for private notes.

## Scope

This project packages a local Codex -> Hermes workflow:

- PowerShell wrapper in `tools/hermes-review.ps1`
- self-contained Codex Skill in `skills/hermes-review/`
- reusable `AGENTS.md` templates in `examples/`
- no-token smoke tests in `tests/`

## Rules

1. Do not commit API keys, provider config, real manuscript content, private paths, or local logs.
2. Keep `tools/hermes-review.ps1` and `skills/hermes-review/scripts/hermes-review.ps1` synchronized.
3. Use `tests/smoke-no-run.ps1` after wrapper, Skill, or example-template changes.
4. Keep the Skill concise. Put human-facing explanation in `README.md`, not in `SKILL.md`.
5. Preserve the default behavior that Markdown reports are temporary unless `-KeepReport` or `-OutputPath` is explicitly used.
6. Prefer `Hermes-first flash + PathOnly + Lite` for simple checks and `Codex-led + Hermes pro review` for complex changes.
