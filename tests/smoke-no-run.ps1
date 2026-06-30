Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Tool = Join-Path $RepoRoot "tools\hermes-review.ps1"
$SkillTool = Join-Path $RepoRoot "skills\hermes-review\scripts\hermes-review.ps1"

if (-not (Test-Path -LiteralPath $Tool)) {
    throw "Missing wrapper: $Tool"
}

if (-not (Test-Path -LiteralPath $SkillTool)) {
    throw "Missing skill wrapper copy: $SkillTool"
}

$toolHash = (Get-FileHash -LiteralPath $Tool -Algorithm SHA256).Hash
$skillHash = (Get-FileHash -LiteralPath $SkillTool -Algorithm SHA256).Hash
if ($toolHash -ne $skillHash) {
    throw "Wrapper copies differ. Sync tools\hermes-review.ps1 and skills\hermes-review\scripts\hermes-review.ps1."
}

Write-Host "Smoke 1: review flow dry run"
& powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Mode flash `
    -Path $Tool `
    -NoRun
if ($LASTEXITCODE -ne 0) {
    throw "Review-flow dry run failed with exit code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Smoke 2: delegate path-only dry run"
& powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -Flow delegate `
    -Lite `
    -Mode flash `
    -PathOnly `
    -MaxFindings 3 `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Path $Tool `
    -ExtraPrompt "Smoke test only. Confirm the delegate/path-only/lite parameters are wired." `
    -NoRun
if ($LASTEXITCODE -ne 0) {
    throw "Delegate-flow dry run failed with exit code $LASTEXITCODE"
}

$repoReportDir = Join-Path $RepoRoot ".codex-hermes-reviews"
if (Test-Path -LiteralPath $repoReportDir) {
    throw "Smoke test should not create persistent report directory: $repoReportDir"
}

Write-Host ""
Write-Host "Smoke tests passed. Hermes was not called."
