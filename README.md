# codex-hermes-bridge

Local bridge for a Codex + Hermes workflow.

The goal is small and practical: let Codex dispatch lightweight checks or independent reviews to a local Hermes CLI, using Alibaba Bailian/DashScope and DeepSeek models as needed, while keeping prompts short and avoiding persistent Markdown report clutter.

## What It Includes

- `tools/hermes-review.ps1`: PowerShell wrapper for Windows -> WSL -> Hermes.
- `skills/hermes-review/`: Codex Skill that teaches Codex when and how to use the wrapper.
- `examples/AGENTS.paper.md`: project rules for paper/manuscript work.
- `examples/AGENTS.code.md`: project rules for coding projects.
- `tests/smoke-no-run.ps1`: no-token smoke test for wrapper wiring.

This is not an MCP server yet. v0.1 is intentionally script-and-skill first.

## Requirements

- Windows PowerShell.
- WSL with Hermes installed and available as `hermes` in WSL, typically via `$HOME/.local/bin`.
- Hermes provider/model configured separately. The default wrapper policy uses Alibaba Bailian/DashScope for Qwen/GLM and DeepSeek official API for DeepSeek models: `qwen3.6-flash`, `qwen3.7-plus`, `deepseek-v4-flash`, `glm-5.2`, and `deepseek-v4-pro`.
- Codex Desktop or Codex CLI if you want the Skill/AGENTS workflow.

No API keys are stored in this repository.

The wrapper defaults to `-WslDistro "Ubuntu-24.04"`. Check your local distro name with:

```powershell
wsl -l -v
```

If your distro has another name, pass it explicitly:

```powershell
-WslDistro "Ubuntu-22.04"
```

## Install The Skill

From the repository root:

```powershell
$dest = Join-Path $env:USERPROFILE ".codex\skills\hermes-review"
Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force ".\skills\hermes-review" $dest
```

Restart Codex after installing a new Skill.

## Use In A Project

Copy one of the templates into your project root as `AGENTS.md`:

```powershell
Copy-Item ".\examples\AGENTS.paper.md" "D:\path\to\paper-project\AGENTS.md"
Copy-Item ".\examples\AGENTS.code.md" "D:\path\to\code-project\AGENTS.md"
```

Then ask Codex with plain language:

```text
Use Hermes-first flash, PathOnly, no persistent report. Check whether any sentence cites more than three references in main.tex, and relay Hermes output to me.
```

You can also ask for explicit model combinations:

```text
Use DeepSeek flash and Qwen flash to review this project independently, then summarize both opinions.
```

For complex work:

```text
Codex should make the edit first, then call Hermes pro for an independent review. Do not keep a Markdown report; summarize Hermes findings and whether you accept them.
```

## Direct Wrapper Examples

Hermes-first lightweight delegate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 `
  -ProjectRoot "D:\path\to\project" -TaskType paper `
  -Path "D:\path\to\project\main.tex" `
  -ExtraPrompt "Check whether any sentence cites more than three references."
```

Independent post-change review:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Mode auto -ProjectRoot "D:\path\to\project" -TaskType code `
  -Path "D:\path\to\project\src\changed-file.ts"
```

Explicit two-model review:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Flow delegate -Lite -PathOnly -ProjectRoot "D:\path\to\project" `
  -TaskType code -Path "D:\path\to\project\README.md" `
  -Models "deepseek-flash","qwen-flash" `
  -ExtraPrompt "Review independently and return concise findings."
```

Image or screenshot review:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\hermes-review.ps1" `
  -Flow delegate -Lite -PathOnly -ProjectRoot "D:\path\to\project" `
  -TaskType paper -Path "D:\path\to\project\figure.png" `
  -Vision auto -VisionModel qwen3.7-plus `
  -ExtraPrompt "Check whether the figure is readable and scientifically consistent."
```

By default the wrapper writes Hermes output to the terminal and deletes the temporary Markdown report after the run. Use `-KeepReport` or `-OutputPath` only when you want a saved artifact.

For a fuller Chinese guide, including standalone Hermes CLI usage, see [docs/HERMES_USAGE.md](docs/HERMES_USAGE.md).

## Smoke Test

Run this before committing changes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\tests\smoke-no-run.ps1"
```

The smoke test uses `-NoRun`, so it does not call Hermes and does not consume model tokens.

## Model Policy

- Default provider: `alibaba`.
- `qwen3.6-flash`: simple checks, small formatting scans, file lists, obvious consistency checks.
- `qwen3.7-plus`: Hermes pro for paper logic, claim strength, result interpretation, figure/table consistency, and final handoff review.
- `deepseek-v4-flash`: cheap third opinion when the user asks for three or more independent opinions.
- `glm-5.2`: high-risk coding review, multi-file code changes, architecture/API/database/auth/dependency review, and complex debugging review.
- `deepseek-v4-pro`: fifth opinion when the user asks for five independent opinions.
- `auto`: use the wrapper's default selection for ordinary post-change review.

For `-Flow delegate`, `-Mode auto` intentionally defaults to flash because delegate mode is meant for lightweight Hermes-first checks. Use `-Mode pro` explicitly when a delegated check still needs the larger model. Use `-OpinionCount 3` for Qwen flash, Qwen pro, and DeepSeek flash; `-OpinionCount 4` adds GLM; `-OpinionCount 5` adds DeepSeek pro. With no explicit `-Provider`, the wrapper routes Qwen/GLM to `alibaba` and DeepSeek models to `deepseek`. Pass `-Provider alibaba` to force all listed models through Bailian instead.

Use `-Models` for exact model rosters. Common aliases are accepted: `qwen-flash`, `qwen-pro`, `deepseek-flash`, `deepseek-pro`, and `glm`.

## Vision Inputs

The normal Hermes CLI route is text-first. When `-Path` includes `.png`, `.jpg`, `.jpeg`, or `.webp`, the wrapper can add a Bailian vision sidecar so the image itself is sent to a multimodal model instead of being listed as skipped binary content.

- `-Vision auto` is the default: image files are sent to `-VisionModel` when present.
- `-VisionModel qwen3.7-plus` is the default high-quality image reviewer.
- `-Vision off` disables image upload and leaves only the text/path review.
- `-MaxImageMb` caps the size of each image sent to the vision API.
- `-HermesEnvPath` points the vision sidecar at the WSL env file to read; the default is `/root/.hermes/.env`.

Vision uses `DASHSCOPE_API_KEY` from `/root/.hermes/.env` or the WSL environment. The sidecar result is appended to later text-model prompts, so DeepSeek, Qwen flash, GLM, and other text passes can reason over the visual summary. Text passes still use the existing Hermes CLI route and provider routing.

Very tiny images may be rejected by the provider's image-size rules. Normal screenshots, manuscript figures, and UI captures are the intended inputs.

When `-KeepTemp` is used with vision, the temporary prompt, runner, vision Python file, image manifest, and vision-result Markdown file are kept for debugging.

`-NoRun` validates image detection and routing only. It does not call the vision API, so vision-result prompt enrichment appears only in live runs.

## Status

v0.1 is for personal and small-team use. Keep it simple until the workflow proves it needs MCP, a persistent daemon, or a full Codex plugin.
