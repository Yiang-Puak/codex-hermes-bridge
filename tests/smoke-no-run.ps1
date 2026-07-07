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

Write-Host ""
Write-Host "Smoke 8: image path enables vision in dry run"
$samplePng = Join-Path ([IO.Path]::GetTempPath()) ("hermes-vision-smoke-" + [guid]::NewGuid().ToString("N") + ".png")
[IO.File]::WriteAllBytes($samplePng, [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))
try {
    $visionOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
        -Flow delegate `
        -Lite `
        -PathOnly `
        -ProjectRoot $RepoRoot `
        -TaskType code `
        -Path $samplePng `
        -Model "qwen-flash" `
        -ExtraPrompt "Smoke test only. Confirm vision dry-run routing is wired." `
        -NoRun 2>&1
    $visionExit = $LASTEXITCODE
    $visionText = ($visionOutput -join "`n")
    Write-Host $visionText
    if ($visionExit -ne 0) {
        throw "Vision dry run failed with exit code $visionExit"
    }
    if ($visionText -notmatch "Images: 1" -or $visionText -notmatch "Vision: enabled: qwen3\.7-plus via alibaba vision API") {
        throw "Image path did not enable the expected vision route."
    }

    Write-Host ""
    Write-Host "Smoke 9: image path honors -Vision off"
    $visionOffOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
        -Flow delegate `
        -Lite `
        -PathOnly `
        -ProjectRoot $RepoRoot `
        -TaskType code `
        -Path $samplePng `
        -Vision off `
        -ExtraPrompt "Smoke test only. Confirm vision can be disabled." `
        -NoRun 2>&1
    $visionOffExit = $LASTEXITCODE
    $visionOffText = ($visionOffOutput -join "`n")
    Write-Host $visionOffText
    if ($visionOffExit -ne 0) {
        throw "Vision-off dry run failed with exit code $visionOffExit"
    }
    if ($visionOffText -notmatch "Images: 1" -or $visionOffText -notmatch "Vision: off: image files were detected") {
        throw "-Vision off did not disable the vision route as expected."
    }
} finally {
    Remove-Item -LiteralPath $samplePng -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Smoke 10: -Vision on without images warns but does not fail"
$visionOnOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -Flow delegate `
    -Lite `
    -PathOnly `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Path $Tool `
    -Vision on `
    -ExtraPrompt "Smoke test only. Confirm explicit vision-on warns without images." `
    -NoRun 2>&1
$visionOnExit = $LASTEXITCODE
$visionOnText = ($visionOnOutput -join "`n")
Write-Host $visionOnText
if ($visionOnExit -ne 0) {
    throw "Vision-on without images dry run failed with exit code $visionOnExit"
}
if ($visionOnText -notmatch "Vision was set to 'on'" -or $visionOnText -notmatch "Images: 0") {
    throw "-Vision on without images did not produce the expected warning/state."
}

Write-Host ""
Write-Host "Smoke 11: path-only prompt forbids fake file reads"
$pathOnlyPromptOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
    -Flow delegate `
    -Lite `
    -PathOnly `
    -ProjectRoot $RepoRoot `
    -TaskType code `
    -Path $Tool `
    -ExtraPrompt "Smoke test only. Confirm path-only prompt safety wording." `
    -KeepTemp `
    -NoRun 2>&1
$pathOnlyPromptExit = $LASTEXITCODE
$pathOnlyPromptText = ($pathOnlyPromptOutput -join "`n")
Write-Host $pathOnlyPromptText
if ($pathOnlyPromptExit -ne 0) {
    throw "Path-only prompt dry run failed with exit code $pathOnlyPromptExit"
}
$pathOnlyPromptLine = @($pathOnlyPromptText -split "`n" | Where-Object { $_ -like "Prompt:*" } | Select-Object -First 1)
if ($pathOnlyPromptLine.Count -eq 0) {
    throw "Path-only dry run did not print a prompt path."
}
$pathOnlyPromptPath = $pathOnlyPromptLine[0].Substring("Prompt: ".Length).Trim()
try {
    $pathOnlyPromptContent = Get-Content -LiteralPath $pathOnlyPromptPath -Raw -Encoding UTF8
    if ($pathOnlyPromptContent -notmatch "READ_FAILED" -or $pathOnlyPromptContent -notmatch "do not infer content from the filename") {
        throw "Path-only prompt did not include the expected anti-fake-read instruction."
    }
} finally {
    $prefix = $pathOnlyPromptPath -replace "\.prompt\.md$", ""
    Remove-Item -LiteralPath "$prefix.input.md", "$prefix.prompt.md", "$prefix.runner.sh", "$prefix.report.md", "$prefix.vision.py", "$prefix.images.json", "$prefix.vision-result.md" -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Smoke 12: git diff review includes hybrid full-context paths"
$hybridRepo = Join-Path ([IO.Path]::GetTempPath()) ("hermes-hybrid-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $hybridRepo | Out-Null
try {
    & git -C $hybridRepo init -q
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to initialize temporary git repo."
    }
    $hybridFile = Join-Path $hybridRepo "sample.txt"
    Set-Content -LiteralPath $hybridFile -Value "hello hybrid review" -Encoding UTF8
    & git -C $hybridRepo add sample.txt
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stage temporary file."
    }
    $hybridOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool `
        -ProjectRoot $hybridRepo `
        -TaskType code `
        -Mode flash `
        -ExtraPrompt "Smoke test only. Confirm hybrid git diff context." `
        -KeepTemp `
        -NoRun 2>&1
    $hybridExit = $LASTEXITCODE
    $hybridText = ($hybridOutput -join "`n")
    Write-Host $hybridText
    if ($hybridExit -ne 0) {
        throw "Hybrid git diff dry run failed with exit code $hybridExit"
    }
    if ($hybridText -notmatch "Source: git diff hybrid" -or $hybridText -notmatch "Material: hybrid git diff plus changed file paths") {
        throw "Hybrid git diff dry run did not print the expected source/material mode."
    }
    $hybridPromptLine = @($hybridText -split "`n" | Where-Object { $_ -like "Prompt:*" } | Select-Object -First 1)
    if ($hybridPromptLine.Count -eq 0) {
        throw "Hybrid dry run did not print a prompt path."
    }
    $hybridPromptPath = $hybridPromptLine[0].Substring("Prompt: ".Length).Trim()
    try {
        $hybridPromptContent = Get-Content -LiteralPath $hybridPromptPath -Raw -Encoding UTF8
        if ($hybridPromptContent -notmatch "CHANGED FILES AVAILABLE FOR FULL-CONTEXT INSPECTION" -or $hybridPromptContent -notmatch "READ_FAILED") {
            throw "Hybrid prompt did not include changed-file paths and anti-fake-read wording."
        }
    } finally {
        $prefix = $hybridPromptPath -replace "\.prompt\.md$", ""
        Remove-Item -LiteralPath "$prefix.input.md", "$prefix.prompt.md", "$prefix.runner.sh", "$prefix.report.md", "$prefix.vision.py", "$prefix.images.json", "$prefix.vision-result.md" -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -LiteralPath $hybridRepo -Recurse -Force -ErrorAction SilentlyContinue
}

$repoReportDir = Join-Path $RepoRoot ".codex-hermes-reviews"
if (Test-Path -LiteralPath $repoReportDir) {
    throw "Smoke test should not create persistent report directory: $repoReportDir"
}

Write-Host ""
Write-Host "Smoke tests passed. Hermes was not called."
