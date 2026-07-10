# Hermes Wrapper Command Reference

Use this reference only when exact wrapper parameters are needed.

## Main Parameters

- `-Flow review|delegate`: `delegate` asks Hermes to complete a small check directly; `review` asks Hermes to audit Codex output.
- `-Mode auto|flash|pro`: `flash` is cheaper and faster; `pro` is for complex or high-risk review; `auto` selects based on task scope.
- `-Model "<model>"`: explicit model override.
- `-Models "<model1>","<model2>"`: exact model roster override. This bypasses `-OpinionCount` and preserves the requested order.
- `-Provider "<provider>"`: force every selected model through one provider. Omit it to route Qwen/GLM to `alibaba` and DeepSeek models to `deepseek`.
- `-TaskType auto|paper|code`: adjusts review criteria.
- `-Path "<file>"`: one or more files to inspect. Use `-Path "file1","file2"` for multiple files in PowerShell.
- `-ProjectRoot "<dir>"`: project root used for git diff and WSL working directory.
- `-ExtraPrompt "<request>"`: narrow task instruction.
- `-PathOnly`: pass paths instead of inlining file contents.
- `-Lite`: call Hermes with `--ignore-rules` for lightweight checks.
- `-MaxFindings N`: cap review output.
- `-Vision auto|on|off`: add a Bailian vision sidecar for image files. `auto` sends detected images; `off` leaves image files as path/text context only.
- `-VisionModel "<model>"`: model used by the vision sidecar. Default is `qwen3.7-plus`.
- `-MaxImageMb N`: per-image size cap for the vision sidecar. Default is `10`.
- `-HermesEnvPath "<wsl-path>"`: WSL env file read by the vision sidecar. Default is `/root/.hermes/.env`.
- `-OpinionCount 1..5`: run one to five independent model passes. `3` uses Qwen flash, Qwen pro, and DeepSeek flash; `4` adds GLM; `5` adds DeepSeek pro.
- `-KeepReport` or `-OutputPath "<file>"`: persist the Markdown report. Omit both for temporary output.
- `-KeepTemp`: keep temporary prompt/input/runner files for debugging. With vision enabled, this also keeps the Python sidecar, image manifest, and vision-result Markdown file.
- `-NoRun`: prepare the prompt and validate wrapper plumbing without calling Hermes.
- `-WslDistro "<name>"`: WSL distribution used to run Hermes. The wrapper default is `Ubuntu-24.04`; use `wsl -l -v` to check local names.

## Recommended Patterns

Default post-change review is hybrid: the wrapper sends the current git diff and also includes changed-file WSL/Windows paths so Hermes can inspect full files when the diff lacks context. The prompt tells Hermes to return `READ_FAILED` instead of guessing if a needed file cannot be read.

Simple Hermes-first check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 8 -ProjectRoot "<project-root>" -TaskType paper -Path "<file>" -ExtraPrompt "<specific check>"
```

Post-change review:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" -Mode auto -ProjectRoot "<project-root>" -TaskType code -Path "<changed-file>"
```

Dry-run smoke test:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" -Flow delegate -Lite -Mode flash -PathOnly -MaxFindings 3 -ProjectRoot "<project-root>" -TaskType code -Path "<file>" -ExtraPrompt "Smoke test only." -NoRun
```

Explicit mixed-provider model roster:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" -Flow delegate -Lite -PathOnly -ProjectRoot "<project-root>" -TaskType code -Path "<file>" -Models "deepseek-flash","qwen-flash" -ExtraPrompt "<specific check>"
```

Image or screenshot review:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<wrapper>" -Flow delegate -Lite -PathOnly -ProjectRoot "<project-root>" -TaskType paper -Path "<figure.png>" -Vision auto -VisionModel qwen3.7-plus -ExtraPrompt "<visual check>"
```

## Model Notes

Default provider is `alibaba`.
With no explicit `-Provider`, DeepSeek model names are routed to provider `deepseek`; Qwen and GLM model names are routed to provider `alibaba`. Pass `-Provider alibaba` to force all models through Bailian.

- `qwen3.6-flash`: simple and cheap Hermes-first checks.
- `qwen3.7-plus`: Hermes pro for paper/general review.
- `deepseek-v4-flash`: cheap third opinion for three-or-more independent opinions.
- `glm-5.2`: high-risk coding review selected by `-Mode auto -TaskType code` when size or risk signals are present.
- `deepseek-v4-pro`: fifth opinion when `-OpinionCount 5` is requested.
- Aliases accepted by `-Model` and `-Models`: `qwen-flash`, `qwen-pro`, `deepseek-flash`, `deepseek-pro`, `glm`.

In `-Flow delegate`, `-Mode auto` intentionally starts from `qwen3.6-flash`. Delegate mode is optimized for small Hermes-first checks. Use `-Mode pro` explicitly when a delegated task still needs the larger model.

## Material Preview

Before calling Hermes, the wrapper prints the material mode, delivery mode, material character count, prompt character count, CJK character count, approximate input tokens per text pass, approximate total input tokens across text passes, and text pass count. The token preview is a rough mixed CJK/code heuristic, not a provider billing tokenizer; provider-side tokens, output tokens, and appended vision-result text can still differ. Runs with three or more text models print a non-blocking budget warning.

Hermes findings should be evidence-based and reasoned from first principles: objective or invariant, concrete evidence, why it matters, and a concrete action. Treat findings without evidence as leads to verify, not facts to accept.

## Vision Notes

The Hermes CLI text route does not inline image bytes. The wrapper detects `.png`, `.jpg`, `.jpeg`, and `.webp` files and, unless `-Vision off` is set, sends them to the Alibaba Bailian OpenAI-compatible vision API with `image_url` content. The default vision model is `qwen3.7-plus`. The vision pass is appended to the same terminal/report output and to the prompt used by later text Hermes passes.

Very tiny images may be rejected by provider image-size rules. Use ordinary screenshots, manuscript figures, or UI captures for practical review.

The sidecar checks `DASHSCOPE_API_KEY` in the WSL process environment first, then in `-HermesEnvPath`.

`-NoRun` does not call the vision API, so it validates detection and routing only. Vision-result prompt enrichment appears only in live runs.
