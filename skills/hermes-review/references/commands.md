# Hermes Wrapper Command Reference

Use this reference only when exact wrapper parameters are needed.

## Main Parameters

- `-Flow review|delegate`: `delegate` asks Hermes to complete a small check directly; `review` asks Hermes to audit Codex output.
- `-Mode auto|flash|pro`: `flash` is cheaper and faster; `pro` is for complex or high-risk review; `auto` selects based on task scope.
- `-Model "<model>"`: explicit model override.
- `-TaskType auto|paper|code`: adjusts review criteria.
- `-Path "<file>"`: one or more files to inspect. Use `-Path "file1","file2"` for multiple files in PowerShell.
- `-ProjectRoot "<dir>"`: project root used for git diff and WSL working directory.
- `-ExtraPrompt "<request>"`: narrow task instruction.
- `-PathOnly`: pass paths instead of inlining file contents.
- `-Lite`: call Hermes with `--ignore-rules` for lightweight checks.
- `-MaxFindings N`: cap review output.
- `-OpinionCount 1..5`: run one to five independent model passes. `3` uses Qwen flash, Qwen pro, and DeepSeek flash; `4` adds GLM; `5` adds DeepSeek pro.
- `-KeepReport` or `-OutputPath "<file>"`: persist the Markdown report. Omit both for temporary output.
- `-NoRun`: prepare the prompt and validate wrapper plumbing without calling Hermes.
- `-WslDistro "<name>"`: WSL distribution used to run Hermes. The wrapper default is `Ubuntu-24.04`; use `wsl -l -v` to check local names.

## Recommended Patterns

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

## Model Notes

Default provider is `alibaba`.
With no explicit `-Provider`, DeepSeek model names are routed to provider `deepseek`; Qwen and GLM model names are routed to provider `alibaba`. Pass `-Provider alibaba` to force all models through Bailian.

- `qwen3.6-flash`: simple and cheap Hermes-first checks.
- `qwen3.7-plus`: Hermes pro for paper/general review.
- `deepseek-v4-flash`: cheap third opinion for three-or-more independent opinions.
- `glm-5.2`: high-risk coding review selected by `-Mode auto -TaskType code` when size or risk signals are present.
- `deepseek-v4-pro`: fifth opinion when `-OpinionCount 5` is requested.

In `-Flow delegate`, `-Mode auto` intentionally starts from `qwen3.6-flash`. Delegate mode is optimized for small Hermes-first checks. Use `-Mode pro` explicitly when a delegated task still needs the larger model.
