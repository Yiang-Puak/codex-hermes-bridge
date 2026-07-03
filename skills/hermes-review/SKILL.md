---
name: hermes-review
description: Use when Codex should delegate a lightweight check or run an independent review through a local Hermes CLI wrapper, especially for Hermes-first Qwen flash checks, Qwen pro paper review, GLM coding review, mixed Qwen/DeepSeek/GLM multi-opinion review, path-only/token-saving inspection, non-persistent Markdown reports, or Codex-plus-Hermes workflows for papers and coding projects.
---

# Hermes Review

Use this skill to let Codex coordinate with a local Hermes CLI reviewer/delegate through `hermes-review.ps1`.

## Wrapper

Find the wrapper in this order:

1. Project-local `tools/hermes-review.ps1`.
2. This skill's bundled `scripts/hermes-review.ps1`.
3. A user-provided wrapper path.

If no wrapper is available, ask the user for the path instead of inventing one.

## Workflow

Classify the task before calling Hermes:

- Use **Hermes-first flash** for simple checks that can save Codex context: citation counts, formatting scans, file lists, obvious consistency checks, error summaries, spelling scans, and narrow grep-like audits.
- Use **Codex-led then Hermes review** for paper logic, claim strength, scientific evidence boundaries, figure/table consistency, code implementation, architecture/API/database/auth/dependency changes, complex debugging, and final handoff checks.
- Skip Hermes for simple explanations, brainstorming, or tasks where no files changed and no independent check is useful.

Run local deterministic checks first when available, such as tests, lint, builds, LaTeX compilation, or file-existence checks. Then call Hermes for model-based review.

## Commands

For a lightweight delegate check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" `
  -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 `
  -ProjectRoot "<project-root>" -TaskType code `
  -Path "<file>" -ExtraPrompt "<specific check>"
```

For a paper delegate check, use `-TaskType paper`.

For an independent review after Codex changes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" `
  -Mode auto -TaskType code -ProjectRoot "<project-root>" `
  -Path "<changed-file>"
```

Use `-Mode pro` when the review involves paper logic, claim strength, result interpretation, final submission checks, or high-risk non-code changes. For high-risk code work, `-Mode auto -TaskType code` selects GLM. Use `-Mode flash` for ordinary language, format, and small single-file checks. Use `-OpinionCount 3` for Qwen flash, Qwen pro, and DeepSeek flash; `-OpinionCount 4` adds GLM; `-OpinionCount 5` adds DeepSeek pro.

For exact parameter behavior, read `references/commands.md`.

## Reporting

Relay Hermes output to the user instead of saving long-lived reports. Include:

- model used
- material findings
- what Codex accepted or rejected after verification
- remaining risk or skipped validation

The wrapper deletes its temporary Markdown report by default. Use `-KeepReport` or `-OutputPath` only when the user explicitly asks for an artifact.

Keep Hermes prompts narrow. Prefer `-PathOnly`, `-Lite`, and `-MaxFindings` for token control when the task is simple.
