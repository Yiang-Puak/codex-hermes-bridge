---
name: hermes-review
description: Use automatically when the user or project requests Hermes, Codex-Hermes review, independent paper review, post-change code review, citation/figure audits, or multiple Hermes opinions. Runs one immutable bundle through isolated reviewers and leaves semantic synthesis to Codex.
---

# Hermes Review

Use project `tools/hermes-review.ps1` when present; otherwise use this Skill's `scripts/hermes-review.ps1`. Run deterministic tests/builds first. Use `-NoRun` only for plumbing checks.

Choose one preset:

- `delegate`: bounded formatting, inventory, summary, or narrow checks.
- `paper`: DeepSeek Pro, DeepSeek Flash, and Qwen Plus each review the complete explicit paper package independently.
- `paper-deep`: five independent whole-package paper reviews.
- `code`: one strong global GLM review.
- `code-deep`: strong global, security, and correctness/tests reviews; every reviewer sees the complete bundle.

Paper presets require explicit `-Path` files. Never divide a manuscript into model-specific sections or reveal peer identities/outputs. For code presets without `-Path`, the wrapper collects staged, unstaged, deleted, and untracked Git material.

Commands:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" `
  -Preset paper -Concurrency 3 -ProjectRoot "<root>" -Path "<main>","<supplement>" `
  -Prompt "审查完整逻辑、数字、证据边界和可推广性。"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" `
  -Preset code-deep -ProjectRoot "<root>" -Prompt "审查本轮全部改动。"
```

Images remain local unless both `-Vision shared` and `-AllowImageUpload` are supplied. Reports are temporary unless `-KeepReport` or `-OutputPath` is explicit.

For a paper panel, use `-Concurrency 3` so all three independent reviewers launch together. For a real run, keep polling the same terminal session until it prints `Reviewer states:` followed by the JSON result. `Hermes review prepared`, `Running Hermes...`, and WSL non-fatal-diagnostics messages are progress only, not a result; completion is determined by the final reviewer states and runner exit code.

Keep implementation changes surgical: state assumptions, prefer existing files/configuration, avoid speculative abstractions, and define a testable success condition before editing. Treat only `runStatus=completed` with every reviewer `completed` as a valid result.

After all reviewers finish, Codex—not the wrapper—must group semantic consensus, identify disagreements, verify evidence against the bundle, reject unsupported calculations, and report accepted findings plus residual risk.
