Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Tool = Join-Path $RepoRoot "tools\hermes-review.ps1"
$Canonical = Join-Path $RepoRoot "skills\hermes-review\scripts\hermes-review.ps1"
$Profiles = Join-Path $RepoRoot "skills\hermes-review\config\profiles.json"
$Schema = Join-Path $RepoRoot "skills\hermes-review\schemas\review.schema.json"

function Invoke-NoRun {
    param([string[]]$Arguments)
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool @Arguments -NoRun -KeepTemp 2>&1
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
}

function Get-PrefixFromOutput {
    param([string]$Text)
    $line = @($Text -split "`n" | Where-Object { $_ -like "Report:*" } | Select-Object -First 1)
    if ($line.Count -eq 0) { throw "No report path was printed." }
    $report = ($line[0].Substring("Report: ".Length).Trim()) -replace " \(temporary\)$", ""
    return $report -replace "\.result\.json$", ""
}

function Remove-RunFiles {
    param([string]$Prefix)
    $parent = Split-Path -Parent $Prefix
    $leaf = Split-Path -Leaf $Prefix
    Get-ChildItem -LiteralPath $parent -Filter "$leaf*" -File -ErrorAction SilentlyContinue | Remove-Item -Force
}

foreach ($required in @($Tool, $Canonical, $Profiles, $Schema)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required file: $required" }
}
if ((Get-Content -LiteralPath $Tool -Encoding UTF8).Count -gt 10) {
    throw "Top-level wrapper must remain a thin canonical-script shim."
}

Write-Host "Smoke 1: paper panel order, shared snapshot, isolation, and UTF-8"
$paper = Invoke-NoRun @(
    "-Preset", "paper",
    "-ProjectRoot", $RepoRoot,
    "-Path", ((Join-Path $RepoRoot "README.md") + "," + (Join-Path $RepoRoot "CHANGELOG.md")),
    "-Prompt", "Independent paper smoke."
)
Write-Host $paper.Text
if ($paper.ExitCode -ne 0) { throw "Paper NoRun failed." }
$route = "deepseek-v4-pro\(deepseek;holistic\), deepseek-v4-flash\(deepseek;holistic\), qwen3\.7-plus\(alibaba;holistic\)"
if ($paper.Text -notmatch $route) { throw "Paper reviewer order is incorrect." }
if ($paper.Text -notmatch "Timeout: 240 seconds; concurrency: 3") { throw "Paper preset did not select safe three-reviewer concurrency." }
$paperPrefix = Get-PrefixFromOutput $paper.Text
try {
    $prompt0 = Get-Content -LiteralPath "$paperPrefix.reviewer-0.prompt.md" -Raw -Encoding UTF8
    $prompt1 = Get-Content -LiteralPath "$paperPrefix.reviewer-1.prompt.md" -Raw -Encoding UTF8
    $prepared = Get-Content -LiteralPath "$paperPrefix.result.json" -Raw -Encoding UTF8 | ConvertFrom-Json
    $snapshot0 = [regex]::Match($prompt0, "sha256:[a-f0-9]{64}").Value
    $snapshot1 = [regex]::Match($prompt1, "sha256:[a-f0-9]{64}").Value
    if (-not $snapshot0 -or $snapshot0 -ne $snapshot1) { throw "Paper prompts do not share one snapshot." }
    if ($prepared.schemaVersion -ne "2.1" -or $prepared.runStatus -ne "prepared" -or $null -eq $prepared.transport -or $null -ne $prepared.transport.preflightExitCode -or $null -ne $prepared.transport.runnerExitCode -or @($prepared.transport.nonFatalDiagnostics).Count -ne 0 -or $prepared.transport.failureDiagnostic) {
        throw "Prepared transport diagnostics are invalid."
    }
    $assignment0 = $prompt0.Substring($prompt0.IndexOf("Review metadata:"))
    if ($assignment0 -match "deepseek-v4-flash|qwen3\.7-plus") { throw "Paper prompt leaked peer identities." }
    $bytes = [System.IO.File]::ReadAllBytes("$paperPrefix.reviewer-0.prompt.md")
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { throw "Prompt contains a UTF-8 BOM." }
} finally {
    Remove-RunFiles $paperPrefix
}

Write-Host "Smoke 2: code-deep uses strong global and specialist reviewers"
$code = Invoke-NoRun @(
    "-Preset", "code-deep",
    "-ProjectRoot", $RepoRoot,
    "-Path", (Join-Path $RepoRoot "tools\hermes-review.ps1")
)
Write-Host $code.Text
if ($code.ExitCode -ne 0) { throw "Code NoRun failed." }
if ($code.Text -notmatch "glm-5\.2\(alibaba;holistic\), qwen3\.7-plus\(alibaba;security\), deepseek-v4-pro\(deepseek;correctness-tests\)") {
    throw "code-deep assignments are incorrect."
}
$codePrefix = Get-PrefixFromOutput $code.Text
try {
    $codePrompt = Get-Content -LiteralPath "$codePrefix.reviewer-0.prompt.md" -Raw -Encoding UTF8
    if ($codePrompt -notmatch "smallest change" -or $codePrompt -notmatch "one-off abstractions") {
        throw "Code reviewer prompt is missing the minimal-change guardrail."
    }
} finally {
    Remove-RunFiles $codePrefix
}

Write-Host "Smoke 3: legacy mode names do not bind as models and relative paths use ProjectRoot"
$legacyAuto = Invoke-NoRun @("-ProjectRoot", $RepoRoot, "-TaskType", "code", "-Path", "README.md", "-Mode", "auto")
Write-Host $legacyAuto.Text
if ($legacyAuto.ExitCode -ne 0 -or $legacyAuto.Text -notmatch "Preset: code" -or $legacyAuto.Text -notmatch "glm-5\.2\(alibaba;holistic\)") {
    throw "Legacy auto invocation did not resolve to the code preset."
}
Remove-RunFiles (Get-PrefixFromOutput $legacyAuto.Text)

$legacyFlash = Invoke-NoRun @("-Flow", "delegate", "-Lite", "-Mode", "flash", "-PathOnly", "-ProjectRoot", $RepoRoot, "-TaskType", "code", "-Path", "README.md", "-ExtraPrompt", "Legacy compatibility smoke.")
Write-Host $legacyFlash.Text
if ($legacyFlash.ExitCode -ne 0 -or $legacyFlash.Text -notmatch "Preset: delegate" -or $legacyFlash.Text -notmatch "qwen3\.6-flash\(alibaba;delegate\)") {
    throw "Legacy flash invocation did not resolve to the delegate preset."
}
Remove-RunFiles (Get-PrefixFromOutput $legacyFlash.Text)

Write-Host "Smoke 4: git bundle includes modified, deleted, and untracked material"
$fixture = Join-Path $env:TEMP ("hermes-git-smoke-" + [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($fixture) | Out-Null
try {
    & git -C $fixture init -q
    & git -C $fixture config user.email "smoke@example.invalid"
    & git -C $fixture config user.name "Smoke"
    [System.IO.File]::WriteAllText((Join-Path $fixture "modified.txt"), "before", [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $fixture "deleted.txt"), "deleted content", [System.Text.UTF8Encoding]::new($false))
    & git -C $fixture add .
    & git -C $fixture commit -qm "fixture"
    [System.IO.File]::WriteAllText((Join-Path $fixture "modified.txt"), "after", [System.Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath (Join-Path $fixture "deleted.txt") -Force
    [System.IO.File]::WriteAllText((Join-Path $fixture "untracked.txt"), "untracked evidence", [System.Text.UTF8Encoding]::new($false))

    $gitRun = Invoke-NoRun @("-Preset", "code", "-ProjectRoot", $fixture)
    Write-Host $gitRun.Text
    if ($gitRun.ExitCode -ne 0) { throw "Git bundle NoRun failed." }
    $gitPrefix = Get-PrefixFromOutput $gitRun.Text
    try {
        $bundle = Get-Content -LiteralPath "$gitPrefix.bundle.md" -Raw -Encoding UTF8
        $result = Get-Content -LiteralPath "$gitPrefix.result.json" -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($bundle -notmatch "untracked evidence" -or $bundle -notmatch "deleted content" -or $bundle -notmatch "after") {
            throw "Git bundle omitted modified, deleted, or untracked material."
        }
        if ($result.schemaVersion -ne "2.1" -or $result.runStatus -ne "prepared" -or $result.snapshot.coverage -ne "complete") { throw "Prepared result metadata is invalid." }
    } finally {
        Remove-RunFiles $gitPrefix
    }
} finally {
    $resolvedFixture = if (Test-Path -LiteralPath $fixture) { (Resolve-Path -LiteralPath $fixture).Path } else { "" }
    if ($resolvedFixture -and $resolvedFixture.StartsWith((Resolve-Path $env:TEMP).Path + "\", [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
}

Write-Host "Smoke 5: images without upload produce incomplete coverage"
$imagePath = Join-Path $env:TEMP ("hermes-image-smoke-" + [guid]::NewGuid().ToString("N") + ".png")
[System.IO.File]::WriteAllBytes($imagePath, [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A))
try {
    $imageRun = Invoke-NoRun @("-Preset", "paper", "-ProjectRoot", $RepoRoot, "-Path", $imagePath, "-Vision", "off")
    Write-Host $imageRun.Text
    if ($imageRun.ExitCode -ne 0 -or $imageRun.Text -notmatch "Coverage: incomplete") { throw "Blocked image was not marked incomplete." }
    Remove-RunFiles (Get-PrefixFromOutput $imageRun.Text)
} finally {
    Remove-Item -LiteralPath $imagePath -Force -ErrorAction SilentlyContinue
}

Write-Host "Smoke 6: high-confidence sensitive content is rejected"
$secretPath = Join-Path $env:TEMP ("hermes-secret-smoke-" + [guid]::NewGuid().ToString("N") + ".txt")
[System.IO.File]::WriteAllText($secretPath, 'api_key="abcdefghijklmnopqrstuvwxyz123456"', [System.Text.UTF8Encoding]::new($false))
try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $secretOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $Tool -Preset paper -ProjectRoot $RepoRoot -Path $secretPath -NoRun 2>&1
        $secretExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($secretExit -eq 0 -or ($secretOutput -join "`n") -notmatch "sensitive content") { throw "Sensitive content was not rejected." }
} finally {
    Remove-Item -LiteralPath $secretPath -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath (Join-Path $RepoRoot ".codex-hermes-reviews")) {
    throw "Smoke test created a persistent report directory."
}

Write-Host "Smoke tests passed. Hermes was not called."
