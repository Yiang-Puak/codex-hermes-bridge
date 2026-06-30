# Hermes Wrapper Command Reference

Use this reference only when exact wrapper parameters are needed.

## Main Parameters

- `-Flow review|delegate`: `delegate` asks Hermes to complete a small check directly; `review` asks Hermes to audit Codex output.
- `-Mode auto|flash|pro`: `flash` is cheaper and faster; `pro` is for complex or high-risk review; `auto` selects based on task scope.
- `-TaskType auto|paper|code`: adjusts review criteria.
- `-Path "<file>"`: one or more files to inspect. Use `-Path "file1","file2"` for multiple files in PowerShell.
- `-ProjectRoot "<dir>"`: project root used for git diff and WSL working directory.
- `-ExtraPrompt "<request>"`: narrow task instruction.
- `-PathOnly`: pass paths instead of inlining file contents.
- `-Lite`: call Hermes with `--ignore-rules` for lightweight checks.
- `-MaxFindings N`: cap review output.
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

In `-Flow delegate`, `-Mode auto` intentionally defaults to `deepseek-v4-flash`. Delegate mode is optimized for small Hermes-first checks. Use `-Mode pro` explicitly when a delegated task still needs the larger model.
