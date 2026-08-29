$canonical = Join-Path (Split-Path -Parent $PSScriptRoot) "skills\hermes-review\scripts\hermes-exec.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $canonical @args
exit $LASTEXITCODE
