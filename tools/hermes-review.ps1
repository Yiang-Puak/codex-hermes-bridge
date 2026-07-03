param(
    [ValidateSet("review", "delegate")]
    [string]$Flow = "review",

    [ValidateSet("auto", "flash", "pro")]
    [string]$Mode = "auto",

    [ValidateSet("auto", "paper", "code")]
    [string]$TaskType = "auto",

    [string[]]$Path = @(),

    [string]$ProjectRoot = (Get-Location).Path,

    [string]$ExtraPrompt = "",

    [string]$WslDistro = "Ubuntu-24.04",

    [string]$Provider = "",

    [string]$Model = "",

    [string]$OutputPath = "",

    [ValidateRange(1, 5)]
    [int]$OpinionCount = 1,

    [ValidateRange(1, 50)]
    [int]$MaxFindings = 8,

    [switch]$Lite,

    [switch]$PathOnly,

    [switch]$KeepReport,

    [switch]$KeepTemp,

    [switch]$NoRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$DefaultProvider = "alibaba"
$DeepSeekProvider = "deepseek"
$FlashModel = "qwen3.6-flash"
$ProModel = "qwen3.7-plus"
$DeepSeekFlashOpinionModel = "deepseek-v4-flash"
$CodeProModel = "glm-5.2"
$DeepSeekProOpinionModel = "deepseek-v4-pro"
$InlineContentLimit = 60000

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-ProjectRoot {
    param([string]$Root)
    return (Resolve-Path -LiteralPath $Root).Path
}

function Resolve-ReviewOutputPath {
    param(
        [string]$Root,
        [string]$RequestedPath,
        [string]$FallbackPath,
        [bool]$UseProjectDefault
    )

    if ($RequestedPath.Trim().Length -gt 0) {
        if ([IO.Path]::IsPathRooted($RequestedPath)) {
            $target = $RequestedPath
        } else {
            $target = Join-Path $Root $RequestedPath
        }
    } elseif ($UseProjectDefault) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $target = Join-Path $Root ".codex-hermes-reviews\hermes-review-$stamp.md"
    } else {
        $target = $FallbackPath
    }

    $parent = Split-Path -Parent $target
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    return $target
}

function ConvertTo-WslPath {
    param([string]$WindowsPath)

    $fullPath = (Resolve-Path -LiteralPath $WindowsPath).Path
    if ($fullPath -match "^([A-Za-z]):\\(.*)$") {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2] -replace "\\", "/"
        return "/mnt/$drive/$rest"
    }

    throw "Only Windows drive paths are supported: $fullPath"
}

function Quote-Bash {
    param([string]$Value)
    $escaped = $Value.Replace("'", "'\''")
    return "'" + $escaped + "'"
}

function Test-GitRepo {
    param([string]$Root)
    try {
        $result = & git -C $Root rev-parse --is-inside-work-tree 2>$null
        return ($LASTEXITCODE -eq 0 -and $result -eq "true")
    } catch {
        return $false
    }
}

function Get-GitReviewContent {
    param([string]$Root)

    $staged = & git -C $Root diff --cached --no-ext-diff -- . 2>$null
    $unstaged = & git -C $Root diff --no-ext-diff -- . 2>$null
    $names = & git -C $Root diff --name-only --cached -- . 2>$null
    $names += & git -C $Root diff --name-only -- . 2>$null
    $uniqueNames = @($names | Where-Object { $_ } | Sort-Object -Unique)

    $parts = @()
    if ($staged) {
        $parts += "## STAGED DIFF"
        $parts += ""
        $parts += $staged
    }
    if ($unstaged) {
        $parts += "## UNSTAGED DIFF"
        $parts += ""
        $parts += $unstaged
    }

    return [pscustomobject]@{
        Source = "git diff"
        Text = ($parts -join "`n")
        FileCount = $uniqueNames.Count
        Files = $uniqueNames
    }
}

function Resolve-InputPaths {
    param([string[]]$Items)

    $resolved = @()
    $expandedItems = @()
    foreach ($item in $Items) {
        foreach ($part in ($item -split ",")) {
            $clean = $part.Trim().Trim('"').Trim("'")
            if ($clean.Length -gt 0) {
                $expandedItems += $clean
            }
        }
    }

    foreach ($item in $expandedItems) {
        if (Test-Path -LiteralPath $item) {
            $resolved += (Resolve-Path -LiteralPath $item).Path
            continue
        }

        $matches = @(Resolve-Path -Path $item -ErrorAction SilentlyContinue)
        foreach ($match in $matches) {
            $resolved += $match.Path
        }
    }

    return @($resolved | Sort-Object -Unique)
}

function Get-FileReviewContent {
    param([string[]]$Files)

    $binaryExtensions = @(
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".7z", ".rar",
        ".vhdx", ".exe", ".dll"
    )

    $parts = @()
    $skipped = @()

    foreach ($file in $Files) {
        $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
        if ($binaryExtensions -contains $extension) {
            $skipped += $file
            continue
        }

        $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
        $parts += "## FILE: $file"
        $parts += ""
        $parts += '```'
        $parts += $text
        $parts += '```'
        $parts += ""
    }

    if ($skipped.Count -gt 0) {
        $parts += "## SKIPPED BINARY OR RICH-DOCUMENT FILES"
        foreach ($file in $skipped) {
            $parts += "- $file"
        }
        $parts += ""
        $parts += "These files were listed but not inlined. Ask Codex to render or extract them before relying on this review."
    }

    return [pscustomobject]@{
        Source = "explicit file content"
        Text = ($parts -join "`n")
        FileCount = $Files.Count
        Files = $Files
    }
}

function Get-PathOnlyReviewContent {
    param([string[]]$Files)

    $parts = @()
    $parts += "## FILE PATHS FOR HERMES INSPECTION"
    $parts += ""
    $parts += "Read only the parts of these files needed for the requested task."
    $parts += "Use the WSL paths when invoking tools from Hermes."
    $parts += ""

    foreach ($file in $Files) {
        $parts += "- WSL: $(ConvertTo-WslPath $file)"
        $parts += "  Windows: $file"
    }

    return [pscustomobject]@{
        Source = "file paths only"
        Text = ($parts -join "`n")
        FileCount = $Files.Count
        Files = $Files
    }
}

function Select-HermesModel {
    param(
        [string]$ModeValue,
        [string]$TaskTypeValue,
        [string]$Text,
        [int]$FileCount,
        [string[]]$Files
    )

    if ($Model.Trim().Length -gt 0) {
        return [pscustomobject]@{ Model = $Model.Trim(); Reason = "explicit model override" }
    }

    if ($ModeValue -eq "flash") {
        return [pscustomobject]@{ Model = $FlashModel; Reason = "manual flash mode" }
    }
    if ($ModeValue -eq "pro") {
        return [pscustomobject]@{ Model = $ProModel; Reason = "manual pro mode" }
    }

    $charCount = $Text.Length
    $joinedFiles = ($Files -join "`n").ToLowerInvariant()
    $paperSignal = (($TaskTypeValue -eq "paper") -or ($joinedFiles -match "\.tex|manuscript|supplementary|response_to_reviewers|paper|论文|稿件"))
    $codeSignal = (($TaskTypeValue -eq "code") -or ($joinedFiles -match "\.py|\.js|\.ts|\.tsx|\.jsx|\.java|\.go|\.rs|package\.json|requirements|dockerfile"))
    $riskSignal = ($Text -match "Results|Discussion|Methods|baseline|metric|experiment|schema|migration|auth|database|security|payment|concurrency")

    if ($paperSignal -and ($charCount -gt 8000 -or $riskSignal -or $FileCount -gt 1)) {
        return [pscustomobject]@{ Model = $ProModel; Reason = "paper review with enough size or claim risk" }
    }

    if ($codeSignal -and ($charCount -gt 12000 -or $FileCount -ge 4 -or $riskSignal)) {
        return [pscustomobject]@{ Model = $CodeProModel; Reason = "code review with size, multiple files, or risk signals" }
    }

    if ($charCount -gt 18000 -or $FileCount -ge 5) {
        return [pscustomobject]@{ Model = $ProModel; Reason = "large review payload" }
    }

    return [pscustomobject]@{ Model = $FlashModel; Reason = "small or routine review payload" }
}

function Select-OpinionModels {
    param(
        [string]$PrimaryModel,
        [int]$Count
    )

    if ($Count -le 1) {
        return @($PrimaryModel)
    }

    $opinionModels = @($FlashModel, $ProModel, $DeepSeekFlashOpinionModel, $CodeProModel, $DeepSeekProOpinionModel)

    if ($Count -ge 3) {
        return @($opinionModels | Select-Object -First $Count)
    }

    $candidates = @()
    if ($PrimaryModel -eq $CodeProModel -or $PrimaryModel -eq $DeepSeekProOpinionModel) {
        $candidates += $PrimaryModel
        $candidates += $ProModel
    } else {
        $candidates += $PrimaryModel
        $candidates += $CodeProModel
    }

    $unique = @()
    foreach ($candidate in $candidates) {
        if ($candidate -and -not ($unique -contains $candidate)) {
            $unique += $candidate
        }
    }

    return @($unique | Select-Object -First $Count)
}

function Select-HermesProvider {
    param(
        [string]$ModelName,
        [string]$RequestedProvider
    )

    if ($RequestedProvider.Trim().Length -gt 0) {
        return $RequestedProvider.Trim()
    }

    if ($ModelName -match "^(deepseek|vanchin/deepseek|siliconflow/deepseek)") {
        return $DeepSeekProvider
    }

    return $DefaultProvider
}

$resolvedRoot = Resolve-ProjectRoot $ProjectRoot
$gitReview = $null
$usePathOnly = ($PathOnly -or $Flow -eq "delegate")

if ($usePathOnly) {
    $resolvedFiles = @(Resolve-InputPaths $Path)
    if ($resolvedFiles.Count -eq 0) {
        Write-Error "Path-only or delegate flow requires readable -Path files."
    }
    $review = Get-PathOnlyReviewContent $resolvedFiles
} else {
    if (Test-GitRepo $resolvedRoot) {
        $gitReview = Get-GitReviewContent $resolvedRoot
    }

    if ($gitReview -and $gitReview.Text.Trim().Length -gt 0) {
        $review = $gitReview
    } else {
        $resolvedFiles = @(Resolve-InputPaths $Path)
        if ($resolvedFiles.Count -eq 0) {
            Write-Error "No git diff was found and no readable -Path files were provided. Pass changed files with -Path, or run this inside a git repo with changes."
        }
        $review = Get-FileReviewContent $resolvedFiles
    }
}

if ($Flow -eq "delegate" -and $Mode -eq "auto") {
    $selection = [pscustomobject]@{ Model = $FlashModel; Reason = "delegate flow default flash mode" }
} else {
    $selection = Select-HermesModel -ModeValue $Mode -TaskTypeValue $TaskType -Text $review.Text -FileCount $review.FileCount -Files $review.Files
}
$model = $selection.Model
$models = @(Select-OpinionModels -PrimaryModel $model -Count $OpinionCount)
$modelSummary = ($models -join ", ")
$selectionReason = $selection.Reason
if ($OpinionCount -ge 3) {
    if ($OpinionCount -eq 3) {
        $selectionReason = "three independent opinions requested; using Qwen flash, Qwen pro, and DeepSeek flash"
    } elseif ($OpinionCount -eq 4) {
        $selectionReason = "four independent opinions requested; adding GLM to Qwen and DeepSeek flash opinions"
    } else {
        $selectionReason = "five independent opinions requested; adding DeepSeek pro to Qwen, DeepSeek flash, and GLM opinions"
    }
} elseif ($OpinionCount -gt 1) {
    $selectionReason = "two independent opinions requested"
}
$selectedProvider = if ($Provider.Trim().Length -gt 0) { $Provider.Trim() } else { "auto" }

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("hermes-review-" + [guid]::NewGuid().ToString("N"))
$inputFile = "$tempBase.input.md"
$promptFile = "$tempBase.prompt.md"
$runnerFile = "$tempBase.runner.sh"
$defaultReportFile = "$tempBase.report.md"
$reportShouldPersist = ($KeepReport -or $OutputPath.Trim().Length -gt 0)
$resolvedOutputPath = Resolve-ReviewOutputPath -Root $resolvedRoot -RequestedPath $OutputPath -FallbackPath $defaultReportFile -UseProjectDefault $KeepReport

if ($Flow -eq "delegate") {
    $roleLine = "You are a lightweight Hermes-first delegate. Complete the requested check directly, using the provided file paths when relevant."
    $flowInstructions = @"
1. Do the requested task directly and inspect only the necessary parts of the provided files.
2. Prefer concise, concrete findings over broad review commentary.
3. Do not rewrite files unless explicitly requested.
4. Return at most $MaxFindings findings. If there are more, list the most important ones and say how many remain.
5. Use this format:
   - Model used
   - Findings
   - Residual risks
   - Suggested next action
"@
} else {
    $roleLine = "You are an independent reviewer for Codex output."
    $flowInstructions = @"
1. Focus on concrete problems only: bugs, regressions, unsupported scientific claims, evidence mismatch, missing tests, broken formatting, reproducibility risk, and maintainability issues.
2. For paper work, check logic, claim strength, terminology consistency, figure/table/text consistency, citation/evidence boundaries, and whether any new statement needs user confirmation.
3. For code work, check correctness, edge cases, tests, API contracts, dependencies, security-sensitive behavior, and user-facing regressions.
4. Do not rewrite the whole work. Return findings ordered by severity.
5. If there are no material issues, say so clearly and mention residual risk or missing validation.
6. Return at most $MaxFindings findings. If there are more, list the most important ones and say how many remain.
7. Use this format:
   - Model used
   - Findings
   - Residual risks
   - Suggested next action
"@
}

$header = @"
$roleLine

Review scope:
- Flow: $Flow
- Project root: $resolvedRoot
- Source: $($review.Source)
- Task type: $TaskType
- Selected model(s): $modelSummary
- Selection reason: $selectionReason
- Provider: $selectedProvider
- Lite mode: $Lite
- Max findings: $MaxFindings
- Opinion count: $OpinionCount

Review instructions:
$flowInstructions

Extra request from Codex:
$ExtraPrompt
"@

Set-Content -LiteralPath $inputFile -Value $review.Text -Encoding UTF8

if ($review.Text.Length -le $InlineContentLimit) {
    $prompt = @"
$header

Review material:

$($review.Text)
"@
} else {
    $wslInputForPrompt = ConvertTo-WslPath $inputFile
    $prompt = @"
$header

The review material is large and has been written to this file:
$wslInputForPrompt

Read that file before reviewing.
"@
}

Set-Content -LiteralPath $promptFile -Value $prompt -Encoding UTF8

$reportHeader = @"
# Hermes Review Report

- Project: $resolvedRoot
- Source: $($review.Source)
- Files: $($review.FileCount)
- Characters: $($review.Text.Length)
- Model(s): $modelSummary
- Selection reason: $selectionReason
- Provider: $selectedProvider
- Task type: $TaskType
- Created: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

## Hermes Output

"@
Set-Content -LiteralPath $resolvedOutputPath -Value $reportHeader -Encoding UTF8

Write-Host "Hermes review prepared."
Write-Host "Project: $resolvedRoot"
Write-Host "Flow: $Flow"
Write-Host "Source: $($review.Source)"
Write-Host "Files: $($review.FileCount)"
Write-Host "Chars: $($review.Text.Length)"
Write-Host "Provider: $selectedProvider"
Write-Host "Model(s): $modelSummary ($selectionReason)"
Write-Host "Lite: $Lite"
Write-Host "PathOnly: $usePathOnly"
Write-Host "MaxFindings: $MaxFindings"
Write-Host "OpinionCount: $OpinionCount"
Write-Host "Prompt: $promptFile"
if ($reportShouldPersist) {
    Write-Host "Report: $resolvedOutputPath"
} else {
    Write-Host "Report: $resolvedOutputPath (temporary; deleted after run)"
}
if ($KeepTemp) {
    Write-Host "Temporary files will be kept after Hermes exits."
}

if ($NoRun) {
    Write-Host "NoRun set; Hermes was not called."
    if (-not $KeepTemp) {
        Remove-Item -LiteralPath $inputFile, $promptFile, $runnerFile -Force -ErrorAction SilentlyContinue
    }
    if (-not $reportShouldPersist) {
        Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

$wslProject = ConvertTo-WslPath $resolvedRoot
$wslPrompt = ConvertTo-WslPath $promptFile
$wslOutput = ConvertTo-WslPath $resolvedOutputPath

$liteArgs = ""
if ($Lite) {
    $liteArgs = " --ignore-rules"
}

$cdLine = "cd $(Quote-Bash $wslProject)"
$promptLine = "prompt=`$(cat $(Quote-Bash $wslPrompt))"
$runLines = @("status=0")
foreach ($runModel in $models) {
    $quotedModel = Quote-Bash $runModel
    $runProvider = Select-HermesProvider -ModelName $runModel -RequestedProvider $Provider
    $quotedProvider = Quote-Bash $runProvider
    $quotedOutput = Quote-Bash $wslOutput
    $runLines += "printf '\n\n---\n\n## Hermes pass: %s (%s)\n\n' $quotedModel $quotedProvider | tee -a $quotedOutput"
    $runLines += "hermes$liteArgs --provider $quotedProvider -m $quotedModel -z `"`$prompt`" 2>&1 | tee -a $quotedOutput"
    $runLines += 'cmd_status=${PIPESTATUS[0]}; if [ "$cmd_status" -ne 0 ]; then status="$cmd_status"; fi'
}
$runnerLines = @(
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'export PATH="$HOME/.local/bin:$PATH"',
    $cdLine,
    $promptLine
) + $runLines + @(
    'exit "$status"'
)
$runnerText = ($runnerLines -join "`n") + "`n"
[System.IO.File]::WriteAllText($runnerFile, $runnerText, [System.Text.UTF8Encoding]::new($false))
$wslRunner = ConvertTo-WslPath $runnerFile

Write-Host ""
Write-Host "Running Hermes..."
& wsl.exe -d $WslDistro -- bash $wslRunner
$hermesExitCode = $LASTEXITCODE

if (-not $KeepTemp) {
    Remove-Item -LiteralPath $inputFile, $promptFile, $runnerFile -Force -ErrorAction SilentlyContinue
}

if (-not $reportShouldPersist) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
}

exit $hermesExitCode
