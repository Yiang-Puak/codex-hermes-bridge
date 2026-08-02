param(
    [ValidateSet("delegate", "paper", "paper-deep", "code", "code-deep")]
    [string]$Preset = "code",

    [string[]]$Path = @(),
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$Prompt = "",
    [string[]]$Models = @(),

    # Compatibility with the v0.2 invocation shape.  Define these names
    # explicitly so PowerShell never treats -Mode as the -Models abbreviation.
    [ValidateSet("", "auto", "flash")]
    [string]$Mode = "",
    [string]$Flow = "",
    [switch]$Lite,
    [switch]$PathOnly,
    [ValidateSet("", "code", "paper")]
    [string]$TaskType = "",
    [string]$ExtraPrompt = "",

    [ValidateRange(1, 20)]
    [int]$MaxFindings = 8,

    [ValidateRange(30, 1800)]
    [int]$TimeoutSec = 240,

    [ValidateRange(1, 5)]
    [int]$Concurrency = 2,

    [ValidateSet("off", "shared")]
    [string]$Vision = "off",

    [switch]$AllowImageUpload,
    [switch]$AllowSensitiveInput,
    [switch]$KeepReport,
    [string]$OutputPath = "",
    [switch]$KeepTemp,
    [switch]$NoRun,
    [string]$WslDistro = "Ubuntu-24.04"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$SkillRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $SkillRoot "config\profiles.json"
$VisionScriptPath = Join-Path $PSScriptRoot "vision.py"
$ImageExtensions = @(".png", ".jpg", ".jpeg", ".webp")
$MaxTextFileBytes = 2MB

function Write-Utf8File {
    param([string]$Target, [string]$Text)
    [System.IO.File]::WriteAllText($Target, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Read-JsonFile {
    param([string]$Target)
    if (-not (Test-Path -LiteralPath $Target)) {
        throw "Missing configuration: $Target"
    }
    return (Get-Content -LiteralPath $Target -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-ObjectProperty {
    param([object]$Object, [string]$Name, [object]$Default = $null)
    if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) {
        return $Object.PSObject.Properties[$Name].Value
    }
    return $Default
}

function ConvertTo-WslPath {
    param([string]$WindowsPath)
    $fullPath = (Resolve-Path -LiteralPath $WindowsPath).Path
    if ($fullPath -match "^([A-Za-z]):\\(.*)$") {
        return "/mnt/$($Matches[1].ToLowerInvariant())/$($Matches[2] -replace '\\', '/')"
    }
    throw "Only Windows drive paths are supported: $fullPath"
}

function Quote-Bash {
    param([string]$Value)
    return "'" + $Value.Replace("'", "'\''") + "'"
}

function Get-Sha256Bytes {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return (-join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }))
    } finally {
        $sha.Dispose()
    }
}

function Get-Sha256Text {
    param([string]$Text)
    return Get-Sha256Bytes ([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Test-GitRepository {
    param([string]$Root)
    $value = & git -C $Root rev-parse --is-inside-work-tree 2>$null
    return ($LASTEXITCODE -eq 0 -and $value -eq "true")
}

function Resolve-ExplicitFiles {
    param([string[]]$Items, [string]$Root)
    $files = @()
    foreach ($item in $Items) {
        foreach ($part in ($item -split ",")) {
            $clean = $part.Trim().Trim('"').Trim("'")
            if (-not $clean) { continue }
            $candidate = if ([System.IO.Path]::IsPathRooted($clean)) { $clean } else { Join-Path $Root $clean }
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw "Input file is missing or is not a file: $clean"
            }
            $files += (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return @($files | Sort-Object -Unique)
}

function Get-GitSelection {
    param([string]$Root)
    $names = @()
    $names += & git -c core.quotepath=false -C $Root diff --name-only --cached -- . 2>$null
    $names += & git -c core.quotepath=false -C $Root diff --name-only -- . 2>$null
    $names += & git -c core.quotepath=false -C $Root ls-files --others --exclude-standard -- . 2>$null
    $names = @($names | Where-Object { $_ } | Sort-Object -Unique)

    $files = @()
    $missing = @()
    foreach ($name in $names) {
        $candidate = Join-Path $Root $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $files += (Resolve-Path -LiteralPath $candidate).Path
        } else {
            $missing += $name
        }
    }

    $staged = (& git -c core.quotepath=false -C $Root diff --cached --no-ext-diff -- . 2>$null) -join "`n"
    $unstaged = (& git -c core.quotepath=false -C $Root diff --no-ext-diff -- . 2>$null) -join "`n"
    $diffParts = @()
    if ($staged) { $diffParts += "## STAGED DIFF`n`n$staged" }
    if ($unstaged) { $diffParts += "## UNSTAGED DIFF`n`n$unstaged" }

    return [pscustomobject]@{
        Files = @($files | Sort-Object -Unique)
        Missing = @($missing)
        Diff = ($diffParts -join "`n`n")
        Names = @($names)
    }
}

function Test-BinaryBytes {
    param([byte[]]$Bytes)
    $limit = [Math]::Min($Bytes.Length, 8192)
    for ($index = 0; $index -lt $limit; $index++) {
        if ($Bytes[$index] -eq 0) { return $true }
    }
    return $false
}

function Test-SensitiveText {
    param([string]$Text)
    $patterns = @(
        '-----BEGIN [A-Z ]*PRIVATE KEY-----',
        '(?i)authorization\s*:\s*bearer\s+[A-Za-z0-9._~-]{12,}',
        '(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'']?[A-Za-z0-9_./+~-]{16,}',
        '(?i)(postgres|mysql|mongodb(?:\+srv)?)://[^\s:@]+:[^\s@]+@'
    )
    foreach ($pattern in $patterns) {
        if ([regex]::IsMatch($Text, $pattern)) { return $true }
    }
    return $false
}

function New-MaterialBundle {
    param(
        [string[]]$Files,
        [string[]]$Missing,
        [string]$GitDiff,
        [string]$TempBase,
        [string]$VisionMode,
        [switch]$ImageUploadAllowed
    )

    $parts = @("# IMMUTABLE REVIEW BUNDLE", "")
    $manifest = @()
    $imageSnapshots = @()
    $temporaryPaths = @()
    $incomplete = $false
    $readFailed = $false
    $readableMaterial = $false

    if ($GitDiff) {
        $parts += $GitDiff
        $parts += ""
        $readableMaterial = $true
    }

    foreach ($missingPath in $Missing) {
        $manifest += [pscustomobject]@{ path = $missingPath; status = "deleted-diff"; bytes = 0; sha256 = "" }
    }

    $imageIndex = 0
    foreach ($file in $Files) {
        $item = Get-Item -LiteralPath $file
        $extension = $item.Extension.ToLowerInvariant()
        if ($ImageExtensions -contains $extension) {
            $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
            $hash = Get-Sha256Bytes $bytes
            if ($VisionMode -eq "shared" -and $ImageUploadAllowed) {
                $snapshotPath = "$TempBase.image-$imageIndex$extension"
                [System.IO.File]::WriteAllBytes($snapshotPath, $bytes)
                $temporaryPaths += $snapshotPath
                $imageSnapshots += $snapshotPath
                $parts += "## IMAGE SNAPSHOT"
                $parts += "- Original: $($item.FullName)"
                $parts += "- Snapshot SHA-256: $hash"
                $parts += ""
                $manifest += [pscustomobject]@{ path = $item.FullName; status = "image-snapshot"; bytes = $bytes.Length; sha256 = $hash }
                $readableMaterial = $true
            } else {
                $manifest += [pscustomobject]@{ path = $item.FullName; status = "image-blocked"; bytes = $bytes.Length; sha256 = $hash }
                $incomplete = $true
            }
            $imageIndex++
            continue
        }

        if ($item.Length -gt $MaxTextFileBytes) {
            $manifest += [pscustomobject]@{ path = $item.FullName; status = "oversized-skipped"; bytes = $item.Length; sha256 = "" }
            $incomplete = $true
            continue
        }

        try {
            $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
            if (Test-BinaryBytes $bytes) {
                $manifest += [pscustomobject]@{ path = $item.FullName; status = "binary-skipped"; bytes = $bytes.Length; sha256 = (Get-Sha256Bytes $bytes) }
                $incomplete = $true
                continue
            }
            $decoder = [System.Text.UTF8Encoding]::new($false, $true)
            $text = $decoder.GetString($bytes)
            $hash = Get-Sha256Bytes $bytes
            $parts += "## FILE: $($item.FullName)"
            $parts += ""
            $parts += '```'
            $parts += $text
            $parts += '```'
            $parts += ""
            $manifest += [pscustomobject]@{ path = $item.FullName; status = "included"; bytes = $bytes.Length; sha256 = $hash }
            $readableMaterial = $true
        } catch {
            $manifest += [pscustomobject]@{ path = $item.FullName; status = "read-failed"; bytes = $item.Length; sha256 = "" }
            $incomplete = $true
            $readFailed = $true
        }
    }

    $text = $parts -join "`n"
    $coverage = if ($readFailed -and -not $readableMaterial) { "read-failed" } elseif ($incomplete) { "incomplete" } elseif (-not $readableMaterial) { "read-failed" } else { "complete" }
    return [pscustomobject]@{
        Text = $text
        Id = "sha256:$(Get-Sha256Text $text)"
        Coverage = $coverage
        Manifest = @($manifest)
        ImageSnapshots = @($imageSnapshots)
        TemporaryPaths = @($temporaryPaths)
    }
}

function Resolve-Assignments {
    param([object]$Configuration, [string]$PresetName, [string[]]$RequestedModels)
    $presetDefinition = $Configuration.presets.PSObject.Properties[$PresetName].Value
    if ($null -eq $presetDefinition) { throw "Unknown preset: $PresetName" }

    $requested = @()
    if (@($RequestedModels).Count -gt 0) {
        foreach ($item in $RequestedModels) {
            foreach ($part in ($item -split ",")) {
                $name = $part.Trim()
                if ($name) {
                    $requested += [pscustomobject]@{ model = $name; role = if ($PresetName -eq "delegate") { "delegate" } else { "holistic" } }
                }
            }
        }
    } else {
        $requested = @($presetDefinition.reviewers)
    }

    $assignments = @()
    foreach ($reviewer in $requested) {
        $name = [string]$reviewer.model
        $definition = Get-ObjectProperty -Object $Configuration.models -Name $name
        if ($null -eq $definition) { throw "Model '$name' is not defined in profiles.json." }
        $provider = [string](Get-ObjectProperty -Object $definition -Name "provider" "")
        $class = [string](Get-ObjectProperty -Object $definition -Name "class" "")
        if (-not $provider -or -not $class) { throw "Model '$name' has an incomplete profile definition." }
        $assignments += [pscustomobject]@{
            Model = $name
            Provider = $provider
            Class = $class
            Role = [string]$reviewer.role
        }
    }
    return [pscustomobject]@{ Kind = [string]$presetDefinition.kind; Assignments = @($assignments) }
}

function New-ReviewerPrompt {
    param(
        [string]$Kind,
        [object]$Assignment,
        [string]$BundlePath,
        [string]$SnapshotId,
        [string]$Coverage,
        [int]$FindingLimit,
        [string]$ExtraPrompt,
        [int]$PanelSize
    )

    $contract = switch ($Kind) {
        "paper" {
@"
You are an independent holistic manuscript reviewer. Review the entire supplied package yourself. Do not assume another reviewer covers any section, citation, table, figure, supplement, or limitation. Other reviewer identities and outputs are unavailable.

Cover the research question, logic, methods, results, numerical consistency, claim strength, evidence boundaries, citations, reproducibility, terminology, writing, and likely reviewer objections.
"@
        }
        "code" {
@"
You are an independent code reviewer with role '$($Assignment.Role)'. Inspect the complete bundle. A specialist role means deeper attention, not permission to ignore substantiated CRITICAL or HIGH issues elsewhere. Check correctness, regressions, edge cases, API contracts, dependencies, security, tests, and user-visible behavior.
Prefer the smallest change that satisfies the stated goal. Flag one-off abstractions, duplicate implementations, speculative configuration, and unrelated refactors when they add complexity without evidence.
"@
        }
        default {
@"
Complete the bounded delegate check directly. Inspect only what the request requires, but do not infer unreadable content.
"@
        }
    }

    return @"
$contract

Review metadata:
- Reviewer model: $($Assignment.Model)
- Provider: $($Assignment.Provider)
- Panel size: $PanelSize
- Material snapshot: $SnapshotId
- Coverage: $Coverage
- Immutable bundle: $BundlePath

Read the immutable bundle before reaching conclusions. If coverage is incomplete, say what could not be reviewed. Return no more than $FindingLimit material findings.

Additional request:
$ExtraPrompt

Return exactly this sentinel-wrapped JSON and no Markdown fences or commentary:
HERMES_JSON_BEGIN
{
  "coverage": "complete|incomplete|read-failed",
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "string",
      "summary": "string",
      "principle": "string",
      "evidence": "specific file/line/quote/command observation",
      "confidence": 0.0,
      "action": "one concrete action"
    }
  ],
  "residualRisks": ["string"]
}
HERMES_JSON_END
"@
}

function Resolve-ReportPath {
    param([string]$Root, [string]$Requested, [switch]$Persist, [string]$Fallback)
    if ($Requested) {
        $target = if ([System.IO.Path]::IsPathRooted($Requested)) { $Requested } else { Join-Path $Root $Requested }
        return [System.IO.Path]::ChangeExtension($target, ".json")
    }
    if ($Persist) {
        $directory = Join-Path $Root ".codex-hermes-reviews"
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        return Join-Path $directory ("review-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".json")
    }
    return $Fallback
}

function Test-ReviewerPayload {
    param([object]$Payload, [string]$ReviewerModel, [int]$FindingLimit)
    if ($null -eq $Payload) { throw "Reviewer returned an empty JSON payload." }
    $coverage = [string](Get-ObjectProperty $Payload "coverage" "")
    if (@("complete", "incomplete", "read-failed") -notcontains $coverage) { throw "Reviewer returned invalid coverage." }
    if ($null -eq $Payload.PSObject.Properties["findings"]) { throw "Missing findings array." }
    $findings = @($Payload.findings)
    if ($findings.Count -gt $FindingLimit) { throw "Reviewer returned more than $FindingLimit findings." }
    $normalized = @()
    foreach ($finding in $findings) {
        $severity = ([string](Get-ObjectProperty $finding "severity" "")).ToUpperInvariant()
        if (@("CRITICAL", "HIGH", "MEDIUM", "LOW") -notcontains $severity) { throw "Invalid finding severity." }
        $category = [string](Get-ObjectProperty $finding "category" "")
        $summary = [string](Get-ObjectProperty $finding "summary" "")
        $principle = [string](Get-ObjectProperty $finding "principle" "")
        $evidence = [string](Get-ObjectProperty $finding "evidence" "")
        $action = [string](Get-ObjectProperty $finding "action" "")
        if (-not $category -or -not $summary -or -not $principle -or -not $evidence -or -not $action) { throw "Finding is missing a required string field." }
        try { $confidence = [double](Get-ObjectProperty $finding "confidence" $null) } catch { throw "Invalid finding confidence." }
        if ($confidence -lt 0 -or $confidence -gt 1) { throw "Finding confidence must be between 0 and 1." }
        $normalized += [pscustomobject][ordered]@{
            reviewer = $ReviewerModel
            severity = $severity
            category = $category
            summary = $summary
            principle = $principle
            evidence = $evidence
            confidence = $confidence
            action = $action
        }
    }
    return [pscustomobject]@{
        Findings = @($normalized)
        ResidualRisks = @((Get-ObjectProperty $Payload "residualRisks" @()) | ForEach-Object { [string]$_ })
    }
}

function Get-ReviewerJsonText {
    param([string]$RawText)
    $clean = $RawText.Trim()
    if ($clean -match '(?s)HERMES_JSON_BEGIN\s*(\{.*\})\s*HERMES_JSON_END') {
        return $Matches[1].Trim()
    }
    if ($clean -match '(?s)^```(?:json)?\s*(.*?)\s*```$') {
        return $Matches[1].Trim()
    }
    $start = $clean.IndexOf("{")
    $end = $clean.LastIndexOf("}")
    if ($start -ge 0 -and $end -gt $start) {
        return $clean.Substring($start, $end - $start + 1)
    }
    return $clean
}

function Remove-TemporaryFiles {
    param([string[]]$Targets)
    foreach ($target in @($Targets | Where-Object { $_ } | Sort-Object -Unique)) {
        Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-WslCommand {
    param(
        [string[]]$Arguments,
        [string[]]$ProgressStatusFiles = @(),
        [string[]]$ProgressModels = @()
    )
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "wsl.exe"
    $startInfo.Arguments = (@($Arguments | ForEach-Object {
        $value = [string]$_
        if ($value -notmatch '[\s"]') { $value } else { '"' + $value.Replace('"', '\"') + '"' }
    }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::Unicode
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Could not start wsl.exe." }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $lastStatuses = @{}
    $nextHeartbeat = (Get-Date).AddSeconds(20)
    while (-not $process.HasExited) {
        for ($index = 0; $index -lt @($ProgressStatusFiles).Count; $index++) {
            $statusFile = $ProgressStatusFiles[$index]
            if (-not (Test-Path -LiteralPath $statusFile)) { continue }
            $statusText = ""
            try { $statusText = (Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8).Trim() } catch { continue }
            if ($statusText -notmatch '^\d+\|\d+\|\d+$') { continue }
            $previousStatus = if ($lastStatuses.ContainsKey($index)) { [string]$lastStatuses[$index] } else { "" }
            if (-not $statusText -or $previousStatus -eq $statusText) { continue }
            $lastStatuses[$index] = $statusText
            $model = if ($index -lt @($ProgressModels).Count) { $ProgressModels[$index] } else { "reviewer-$index" }
            $exitPart = ($statusText -split '\|')[0]
            Write-Host "Reviewer completed: $model (exit $exitPart)"
        }
        if ((Get-Date) -ge $nextHeartbeat) {
            $completed = @($lastStatuses.Keys).Count
            Write-Host "Hermes still running; completed reviewers: $completed/$(@($ProgressStatusFiles).Count)."
            $nextHeartbeat = (Get-Date).AddSeconds(20)
        }
        Start-Sleep -Milliseconds 500
    }
    $process.WaitForExit()
    for ($index = 0; $index -lt @($ProgressStatusFiles).Count; $index++) {
        $statusFile = $ProgressStatusFiles[$index]
        if (-not (Test-Path -LiteralPath $statusFile)) { continue }
        $statusText = ""
        try { $statusText = (Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8).Trim() } catch { continue }
        if ($statusText -notmatch '^\d+\|\d+\|\d+$') { continue }
        $previousStatus = if ($lastStatuses.ContainsKey($index)) { [string]$lastStatuses[$index] } else { "" }
        if ($statusText -and $previousStatus -ne $statusText) {
            $lastStatuses[$index] = $statusText
            $model = if ($index -lt @($ProgressModels).Count) { $ProgressModels[$index] } else { "reviewer-$index" }
            $exitPart = ($statusText -split '\|')[0]
            Write-Host "Reviewer completed: $model (exit $exitPart)"
        }
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout.Result.Trim(); Stderr = $stderr.Result.Trim() }
}

function Get-DiagnosticSummary {
    param([string]$Text)
    $summary = (($Text -replace [char]0, '' -replace '\s+', ' ').Trim())
    if ($summary -match 'WSL_E_[A-Z_]+') { return "WSL error: $($Matches[0])" }
    if ($summary.Length -gt 1200) { return $summary.Substring(0, 1200) + "..." }
    return $summary
}

$presetWasExplicit = $PSBoundParameters.ContainsKey("Preset")
if ($Flow) {
    $legacyFlowPresets = @{ "delegate" = "delegate"; "paper-independent" = "paper"; "code-global" = "code"; "code-hybrid" = "code-deep" }
    if (-not $legacyFlowPresets.ContainsKey($Flow)) {
        throw "Unsupported legacy -Flow '$Flow'. Use -Preset delegate, paper, paper-deep, code, or code-deep."
    }
    $legacyPreset = $legacyFlowPresets[$Flow]
    if ($presetWasExplicit -and $Preset -ne $legacyPreset) {
        throw "-Flow '$Flow' conflicts with -Preset '$Preset'. Use only -Preset."
    }
    $Preset = $legacyPreset
} elseif (-not $presetWasExplicit) {
    if ($Mode -eq "flash" -or $Lite) {
        $Preset = "delegate"
    } elseif ($TaskType -eq "paper") {
        $Preset = "paper"
    }
}
if (-not $PSBoundParameters.ContainsKey("Concurrency") -and $Preset -like "paper*") { $Concurrency = 3 }
if ($ExtraPrompt) {
    $promptParts = @()
    if ($Prompt) { $promptParts += $Prompt }
    $promptParts += $ExtraPrompt
    $Prompt = $promptParts -join "`n`n"
}

$Configuration = Read-JsonFile $ConfigPath
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$profile = Resolve-Assignments -Configuration $Configuration -PresetName $Preset -RequestedModels $Models
$assignments = @($profile.Assignments)
if ($assignments.Count -eq 0) { throw "Preset resolved no reviewers." }

$explicitFiles = @(Resolve-ExplicitFiles -Items $Path -Root $resolvedRoot)
$missingFiles = @()
$gitDiff = ""
if ($Preset -like "paper*" -and $explicitFiles.Count -eq 0) {
    throw "Paper presets require explicit -Path files for a complete shared snapshot."
}
if ($explicitFiles.Count -eq 0) {
    if (-not (Test-GitRepository $resolvedRoot)) {
        throw "No explicit files were provided and ProjectRoot is not a git repository."
    }
    $selection = Get-GitSelection $resolvedRoot
    $explicitFiles = @($selection.Files)
    $missingFiles = @($selection.Missing)
    $gitDiff = $selection.Diff
    if ($selection.Names.Count -eq 0) { throw "No staged, unstaged, deleted, or untracked files were found." }
}

if ($Vision -eq "shared" -and -not $AllowImageUpload) {
    $containsImage = @($explicitFiles | Where-Object { $ImageExtensions -contains ([System.IO.Path]::GetExtension($_).ToLowerInvariant()) }).Count -gt 0
    if ($containsImage) { throw "Image upload requires -AllowImageUpload." }
}

$tempBase = Join-Path $env:TEMP ("hermes-review-" + [guid]::NewGuid().ToString("N"))
$bundleFile = "$tempBase.bundle.md"
$runnerFile = "$tempBase.runner.sh"
$visionManifestFile = "$tempBase.images.json"
$visionPromptFile = "$tempBase.vision-prompt.md"
$visionResultFile = "$tempBase.vision-result.md"
$temporaryFiles = @($bundleFile, $runnerFile, $visionManifestFile, $visionPromptFile, $visionResultFile)

$bundle = New-MaterialBundle -Files $explicitFiles -Missing $missingFiles -GitDiff $gitDiff -TempBase $tempBase -VisionMode $Vision -ImageUploadAllowed:$AllowImageUpload
$temporaryFiles += @($bundle.TemporaryPaths)
if ((Test-SensitiveText $bundle.Text) -and -not $AllowSensitiveInput) {
    Remove-TemporaryFiles $temporaryFiles
    throw "High-confidence sensitive content was detected. Review locally or pass -AllowSensitiveInput after verifying the external data scope."
}
Write-Utf8File $bundleFile $bundle.Text

$reportPersistent = ($KeepReport -or $OutputPath)
$reportPath = Resolve-ReportPath -Root $resolvedRoot -Requested $OutputPath -Persist:$KeepReport -Fallback "$tempBase.result.json"
$reportParent = Split-Path -Parent $reportPath
if ($reportParent) { [System.IO.Directory]::CreateDirectory($reportParent) | Out-Null }

$wslBundle = ConvertTo-WslPath $bundleFile
$promptFiles = @()
$outputFiles = @()
$statusFiles = @()
for ($index = 0; $index -lt $assignments.Count; $index++) {
    $promptFile = "$tempBase.reviewer-$index.prompt.md"
    $outputFile = "$tempBase.reviewer-$index.output.json"
    $statusFile = "$tempBase.reviewer-$index.status"
    $reviewerPrompt = New-ReviewerPrompt -Kind $profile.Kind -Assignment $assignments[$index] -BundlePath $wslBundle -SnapshotId $bundle.Id -Coverage $bundle.Coverage -FindingLimit $MaxFindings -ExtraPrompt $Prompt -PanelSize $assignments.Count
    Write-Utf8File $promptFile $reviewerPrompt
    Write-Utf8File $outputFile ""
    Write-Utf8File $statusFile ""
    $promptFiles += $promptFile
    $outputFiles += $outputFile
    $statusFiles += $statusFile
}
$temporaryFiles += $promptFiles + $outputFiles + $statusFiles

$visionEnabled = ($Vision -eq "shared" -and @($bundle.ImageSnapshots).Count -gt 0)
if ($visionEnabled) {
    if (-not (Test-Path -LiteralPath $VisionScriptPath)) { throw "Missing vision sidecar: $VisionScriptPath" }
    $visionImages = @($bundle.ImageSnapshots | ForEach-Object { [pscustomobject]@{ path = ConvertTo-WslPath $_ } })
    Write-Utf8File $visionManifestFile ([pscustomobject]@{ images = $visionImages } | ConvertTo-Json -Depth 4)
    Write-Utf8File $visionPromptFile "Review every image in snapshot $($bundle.Id). $Prompt"
    Write-Utf8File $visionResultFile ""
}

$reviewerRecords = foreach ($assignment in $assignments) {
    [ordered]@{
        model = $assignment.Model
        provider = $assignment.Provider
        role = $assignment.Role
        status = "prepared"
        durationSec = 0
        findings = @()
        residualRisks = @()
        error = ""
    }
}
$report = [ordered]@{
    schemaVersion = "2.1"
    runStatus = "prepared"
    preset = $Preset
    snapshot = [ordered]@{
        id = $bundle.Id
        coverage = $bundle.Coverage
        files = @($bundle.Manifest)
    }
    material = [ordered]@{
        characters = $bundle.Text.Length
        approximateTokensPerReviewer = [Math]::Ceiling($bundle.Text.Length / 4.0)
        reviewerCount = $assignments.Count
    }
    transport = [ordered]@{
        preflightExitCode = $null
        runnerExitCode = $null
        nonFatalDiagnostics = @()
        failureDiagnostic = ""
    }
    reviewers = @($reviewerRecords)
}
Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)

Write-Host "Hermes review prepared; reviewers have not run yet. Do not treat this as a result."
Write-Host "Preset: $Preset"
Write-Host "Snapshot: $($bundle.Id)"
Write-Host "Coverage: $($bundle.Coverage)"
Write-Host "Files: $(@($bundle.Manifest).Count)"
Write-Host "Material chars: $($bundle.Text.Length)"
Write-Host "Approx tokens/reviewer: ~$([Math]::Ceiling($bundle.Text.Length / 4.0))"
Write-Host "Reviewers: $(($assignments | ForEach-Object { "$($_.Model)($($_.Provider);$($_.Role))" }) -join ', ')"
Write-Host "Timeout: $TimeoutSec seconds; concurrency: $Concurrency"
Write-Host "Vision: $(if ($visionEnabled) { 'shared' } elseif (@($bundle.ImageSnapshots).Count -gt 0) { 'blocked' } else { 'off' })"
Write-Host "Report: $reportPath$(if (-not $reportPersistent) { ' (temporary)' })"

$wslPromptFiles = @($promptFiles | ForEach-Object { ConvertTo-WslPath $_ })
$wslOutputFiles = @($outputFiles | ForEach-Object { ConvertTo-WslPath $_ })
$wslStatusFiles = @($statusFiles | ForEach-Object { ConvertTo-WslPath $_ })
$runnerLines = @(
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'export PATH="$HOME/.local/bin:$PATH"',
    'trap ''for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done'' INT TERM EXIT',
    "cd $(Quote-Bash (ConvertTo-WslPath $resolvedRoot))",
    "reviewer_timeout=$TimeoutSec",
    "status=0",
    'shared_vision_result=""'
)

if ($visionEnabled) {
    $visionDefinition = $Configuration.vision
    $runnerLines += "shared_vision_result=$(Quote-Bash (ConvertTo-WslPath $visionResultFile))"
    $runnerLines += ('python3 ' + (Quote-Bash (ConvertTo-WslPath $VisionScriptPath)) + ' --manifest ' + (Quote-Bash (ConvertTo-WslPath $visionManifestFile)) + ' --prompt ' + (Quote-Bash (ConvertTo-WslPath $visionPromptFile)) + ' --model ' + (Quote-Bash ([string]$visionDefinition.model)) + ' --env-file ' + (Quote-Bash ([string]$visionDefinition.envFile)) + ' --max-image-bytes ' + ([int]$visionDefinition.maxImageMb * 1MB) + ' > "$shared_vision_result" 2>&1')
    $runnerLines += 'vision_exit=$?; if [ "$vision_exit" -ne 0 ]; then status="$vision_exit"; fi'
}

$liteArgument = if ($Preset -eq "delegate") { " --ignore-rules" } else { "" }
$runnerLines += @(
    'run_reviewer() {',
    '  local model="$1" provider="$2" prompt_path="$3" output_path="$4" status_path="$5"',
    '  local prompt exit_code started ended',
    '  prompt="$(cat "$prompt_path")"',
    '  if [ -n "$shared_vision_result" ] && [ -s "$shared_vision_result" ]; then prompt="$(printf "%s\n\n## Shared visual evidence\n\n%s" "$prompt" "$(cat "$shared_vision_result")")"; fi',
    '  started=$(date +%s)',
    ('  timeout --kill-after=10s "$reviewer_timeout" hermes' + $liteArgument + ' --provider "$provider" -m "$model" -z "$prompt" > "$output_path" 2>&1'),
    '  exit_code=$?',
    '  ended=$(date +%s)',
    '  printf "%s|%s|%s" "$exit_code" "$started" "$ended" > "$status_path"',
    '  return 0',
    '}'
)

$calls = @()
for ($index = 0; $index -lt $assignments.Count; $index++) {
    $calls += "run_reviewer $(Quote-Bash $assignments[$index].Model) $(Quote-Bash $assignments[$index].Provider) $(Quote-Bash $wslPromptFiles[$index]) $(Quote-Bash $wslOutputFiles[$index]) $(Quote-Bash $wslStatusFiles[$index])"
}
for ($start = 0; $start -lt $calls.Count; $start += $Concurrency) {
    $end = [Math]::Min($start + $Concurrency, $calls.Count)
    for ($index = $start; $index -lt $end; $index++) { $runnerLines += "$($calls[$index]) &" }
    $runnerLines += 'wait || true'
}
for ($index = 0; $index -lt $statusFiles.Count; $index++) {
    $runnerLines += ('reviewer_exit=$(cut -d''|'' -f1 ' + (Quote-Bash $wslStatusFiles[$index]) + '); if [ -z "$reviewer_exit" ]; then reviewer_exit=1; fi; if [ "$reviewer_exit" -ne 0 ] && [ "$status" -eq 0 ]; then status="$reviewer_exit"; fi')
}
$runnerLines += 'trap - INT TERM EXIT'
$runnerLines += 'exit "$status"'
Write-Utf8File $runnerFile (($runnerLines -join "`n") + "`n")

if ($NoRun) {
    Write-Host "NoRun set; Hermes was not called."
    if ($KeepTemp) { Write-Host "Temporary files kept at prefix: $tempBase" }
    if (-not $KeepTemp) { Remove-TemporaryFiles $temporaryFiles }
    if (-not $reportPersistent -and -not $KeepTemp) { Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue }
    exit 0
}

$report.runStatus = "preflight"
Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)
$preflight = Invoke-WslCommand -Arguments @("-d", $WslDistro, "--", "bash", "-lc", 'export PATH="\$HOME/.local/bin:\$PATH"; command -v hermes >/dev/null')
$report.transport.preflightExitCode = $preflight.ExitCode
if ($preflight.ExitCode -ne 0) {
    $report.runStatus = "failed"
    $report.transport.failureDiagnostic = Get-DiagnosticSummary $(if ($preflight.Stderr) { $preflight.Stderr } else { $preflight.Stdout })
    if (-not $report.transport.failureDiagnostic) { $report.transport.failureDiagnostic = "WSL preflight exited with code $($preflight.ExitCode)." }
    Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)
    Write-Host "Preflight diagnostics retained at: $reportPath"
    throw "Hermes CLI was not found in WSL distro '$WslDistro'. $($report.transport.failureDiagnostic)"
}
if ($preflight.Stderr) {
    $report.transport.nonFatalDiagnostics += "WSL emitted startup diagnostics, but the Hermes preflight succeeded."
    Write-Host "WSL preflight succeeded with non-fatal startup diagnostics."
}
if ($visionEnabled) {
    $visionPreflight = Invoke-WslCommand -Arguments @("-d", $WslDistro, "--", "bash", "-lc", 'command -v python3 >/dev/null')
    if ($visionPreflight.ExitCode -ne 0) {
        $report.runStatus = "failed"
        $report.transport.failureDiagnostic = "python3 is required for shared vision review."
        Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)
        throw $report.transport.failureDiagnostic
    }
    if ($visionPreflight.Stderr) { $report.transport.nonFatalDiagnostics += "WSL emitted startup diagnostics during vision preflight." }
}

Write-Host "Running Hermes..."
$report.runStatus = "running"
Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)
Write-Host "Reviewer queue: $($assignments.Count); concurrency: $Concurrency."
$runner = Invoke-WslCommand -Arguments @("-d", $WslDistro, "--", "bash", (ConvertTo-WslPath $runnerFile)) -ProgressStatusFiles $statusFiles -ProgressModels @($assignments | ForEach-Object { $_.Model })
$runnerExit = $runner.ExitCode
$report.transport.runnerExitCode = $runnerExit
if ($runnerExit -eq 0 -and $runner.Stderr) {
    $report.transport.nonFatalDiagnostics += "WSL emitted non-fatal runtime diagnostics; reviewer completion states are authoritative."
    Write-Host "WSL runner completed with non-fatal diagnostics; inspecting reviewer states."
} elseif ($runnerExit -ne 0) {
    $report.transport.failureDiagnostic = Get-DiagnosticSummary $(if ($runner.Stderr) { $runner.Stderr } else { $runner.Stdout })
    if (-not $report.transport.failureDiagnostic) { $report.transport.failureDiagnostic = "WSL runner exited with code $runnerExit." }
}
$report.runStatus = "collecting"
Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)
$parseFailure = $false

for ($index = 0; $index -lt $assignments.Count; $index++) {
    $record = $report.reviewers[$index]
    $statusText = ""
    try {
        if (Test-Path -LiteralPath $statusFiles[$index]) { $statusText = (Get-Content -LiteralPath $statusFiles[$index] -Raw -Encoding UTF8).Trim() }
    } catch {
        $statusText = ""
    }
    if ($statusText -notmatch '^\d+\|\d+\|\d+$') {
        $record.status = "failed"
        $record.error = "Reviewer status file was missing or malformed."
        continue
    }
    $statusParts = @($statusText -split '\|')
    $exitCode = if ($statusParts.Count -ge 1 -and $statusParts[0] -match '^\d+$') { [int]$statusParts[0] } else { 1 }
    $record.durationSec = [Math]::Max(0, ([long]$statusParts[2] - [long]$statusParts[1]))
    if ($exitCode -eq 124) {
        $record.status = "timed-out"
        $record.error = "Reviewer exceeded $TimeoutSec seconds."
        continue
    }
    if ($exitCode -ne 0) {
        $record.status = "failed"
        $record.error = "Hermes exited with code $exitCode."
        continue
    }

    $raw = ""
    try {
        if (Test-Path -LiteralPath $outputFiles[$index]) { $raw = Get-Content -LiteralPath $outputFiles[$index] -Raw -Encoding UTF8 }
    } catch {
        $record.status = "invalid-output"
        $record.error = "Reviewer output could not be read as UTF-8."
        $parseFailure = $true
        continue
    }
    $jsonText = Get-ReviewerJsonText $raw
    try {
        $payload = $jsonText | ConvertFrom-Json
        $validated = Test-ReviewerPayload -Payload $payload -ReviewerModel $assignments[$index].Model -FindingLimit $MaxFindings
        $record.status = "completed"
        $record.findings = @($validated.Findings)
        $record.residualRisks = @($validated.ResidualRisks)
    } catch {
        $record.status = "invalid-output"
        $record.error = $_.Exception.Message
        $parseFailure = $true
    }
}

$incompleteReviewers = @($report.reviewers | Where-Object { $_.status -ne "completed" }).Count -gt 0
$report.runStatus = if ($runnerExit -ne 0 -or $parseFailure -or $incompleteReviewers) { "failed" } else { "completed" }
Write-Utf8File $reportPath ($report | ConvertTo-Json -Depth 12)
Write-Host "Hermes review finished."
Write-Host "Reviewer states: $(($report.reviewers | ForEach-Object { "$($_.model)=$($_.status)" }) -join ', ')"
$preserveFailureReport = ($report.runStatus -ne "completed")
if ($preserveFailureReport -and -not $reportPersistent) {
    Write-Host "Failure diagnostics retained at: $reportPath"
}
Write-Output (Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8)

if (-not $KeepTemp) { Remove-TemporaryFiles $temporaryFiles }
if (-not $reportPersistent -and -not $preserveFailureReport) { Remove-Item -LiteralPath $reportPath -Force -ErrorAction SilentlyContinue }
if ($runnerExit -ne 0) { exit $runnerExit }
if ($parseFailure) { exit 1 }
exit 0
