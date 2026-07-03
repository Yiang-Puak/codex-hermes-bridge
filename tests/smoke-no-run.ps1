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

Write-Host ""
Write-Host "Smoke 3: delegate auto respects explicit model"
$explicitModelOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -Flow delegate `
    -Lite `
    -PathOnly `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Path $Tool `
    -Model "deepseek-flash" `
    -ExtraPrompt "Smoke test only. Confirm explicit model override is wired." `
    -NoRun 2>&1
$explicitModelExit = $LASTEXITCODE
$explicitModelText = ($explicitModelOutput -join "`n")
Write-Host $explicitModelText
if ($explicitModelExit -ne 0) {
    throw "Explicit-model dry run failed with exit code $explicitModelExit"
}
if ($explicitModelText -notmatch "Model\(s\): deepseek-v4-flash" -or $explicitModelText -match "delegate flow default flash mode") {
    throw "Delegate auto did not respect explicit -Model."
}
if ($explicitModelText -notmatch "Routes: deepseek-v4-flash\(deepseek\)") {
    throw "Explicit DeepSeek model did not route to the deepseek provider."
}

Write-Host ""
Write-Host "Smoke 4: explicit model list dry run"
$explicitModelsOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -Flow delegate `
    -Lite `
    -PathOnly `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Path $Tool `
    -Models "deepseek-flash","qwen-flash" `
    -ExtraPrompt "Smoke test only. Confirm explicit model list is wired." `
    -NoRun 2>&1
$explicitModelsExit = $LASTEXITCODE
$explicitModelsText = ($explicitModelsOutput -join "`n")
Write-Host $explicitModelsText
if ($explicitModelsExit -ne 0) {
    throw "Explicit-model-list dry run failed with exit code $explicitModelsExit"
}
if ($explicitModelsText -notmatch "Model\(s\): deepseek-v4-flash, qwen3\.6-flash") {
    throw "Explicit -Models list did not preserve the requested model order."
}
if ($explicitModelsText -notmatch "Routes: deepseek-v4-flash\(deepseek\), qwen3\.6-flash\(alibaba\)") {
    throw "Explicit -Models list did not route providers as expected."
}

Write-Host ""
Write-Host "Smoke 5: OpinionCount 5 dry run"
$opinionOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -Flow delegate `
    -Lite `
    -Mode flash `
    -PathOnly `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Path $Tool `
    -OpinionCount 5 `
    -ExtraPrompt "Smoke test only. Confirm OpinionCount model roster is wired." `
    -NoRun 2>&1
$opinionExit = $LASTEXITCODE
$opinionText = ($opinionOutput -join "`n")
Write-Host $opinionText
if ($opinionExit -ne 0) {
    throw "OpinionCount dry run failed with exit code $opinionExit"
}
if ($opinionText -notmatch "Model\(s\): qwen3\.6-flash, qwen3\.7-plus, deepseek-v4-flash, glm-5\.2, deepseek-v4-pro") {
    throw "OpinionCount 5 did not select the expected model roster."
}

Write-Host ""
Write-Host "Smoke 6: -Model and -Models conflict fails"
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $conflictOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
        -Flow delegate `
        -Lite `
        -PathOnly `
        -ProjectRoot $RepoRoot `
        -TaskType code `
        -Path $Tool `
        -Model "qwen-flash" `
        -Models "deepseek-flash","qwen-flash" `
        -ExtraPrompt "Smoke test only. This should fail before Hermes is called." `
        -NoRun 2>&1
    $conflictExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
$conflictText = ($conflictOutput -join "`n")
Write-Host $conflictText
if ($conflictExit -eq 0) {
    throw "Conflicting -Model and -Models parameters should fail."
}
if ($conflictText -notmatch "Use either -Model") {
    throw "Conflicting -Model and -Models parameters did not produce the expected error."
}

Write-Host ""
Write-Host "Smoke 7: directory path is rejected"
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $directoryOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
        -Flow delegate `
        -Lite `
        -PathOnly `
        -ProjectRoot $RepoRoot `
        -TaskType code `
        -Path $RepoRoot `
        -ExtraPrompt "Smoke test only. This should reject directory paths." `
        -NoRun 2>&1
    $directoryExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
$directoryText = ($directoryOutput -join "`n")
Write-Host $directoryText
if ($directoryExit -eq 0) {
    throw "Directory path should fail in wrapper file-list mode."
}
if ($directoryText -notmatch "Skipping directory path" -or $directoryText -notmatch "requires readable") {
    throw "Directory path did not produce the expected warning and error."
}

$repoReportDir = Join-Path $RepoRoot ".codex-hermes-reviews"
if (Test-Path -LiteralPath $repoReportDir) {
    throw "Smoke test should not create persistent report directory: $repoReportDir"
}

Write-Host ""
Write-Host "Smoke tests passed. Hermes was not called."
