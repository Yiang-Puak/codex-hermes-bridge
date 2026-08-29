param(
    [Parameter(Mandatory)]
    [string]$TaskFile,
    [string]$ProjectRoot = (Get-Location).Path,
    [Parameter(Mandatory)]
    [string]$WslDistro,
    [string]$HermesCommand = "hermes",
    [string]$Profile,
    [string]$Provider,
    [string]$Model,
    [string[]]$Toolsets = @(),
    [ValidateSet("query", "query-file")]
    [string]$QueryMode = "query",
    [string]$Source = "tool",
    [switch]$NoRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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

$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$resolvedTask = (Resolve-Path -LiteralPath $TaskFile).Path
if (-not (Test-Path -LiteralPath $resolvedTask -PathType Leaf)) { throw "Task file is not a file: $TaskFile" }
$insideGit = (& git -C $resolvedRoot rev-parse --is-inside-work-tree 2>$null) -join ""
if ($insideGit -ne "true") { throw "ProjectRoot must be a Git repository: $resolvedRoot" }
if (-not (Get-Content -LiteralPath $resolvedTask -Raw -Encoding UTF8).Trim()) { throw "Task file is empty: $resolvedTask" }

$wslRoot = ConvertTo-WslPath $resolvedRoot
$wslTask = ConvertTo-WslPath $resolvedTask
$execLine = if ($QueryMode -eq "query-file") {
    'exec "${cmd[@]}" < ' + (Quote-Bash $wslTask)
} else {
    'exec "${cmd[@]}"'
}

$commandParts = @((Quote-Bash $HermesCommand))
if ($Profile) { $commandParts += @((Quote-Bash "-p"), (Quote-Bash $Profile)) }
$commandParts += (Quote-Bash "chat")
if ($QueryMode -eq "query-file") {
    $commandParts += @((Quote-Bash "--query-file"), (Quote-Bash "-"))
} else {
    $commandParts += @((Quote-Bash "--query"), ('"$(cat ' + (Quote-Bash $wslTask) + ')"'))
}
if ($Provider) { $commandParts += @((Quote-Bash "--provider"), (Quote-Bash $Provider)) }
if ($Model) { $commandParts += @((Quote-Bash "--model"), (Quote-Bash $Model)) }
if ($Toolsets.Count -gt 0) {
    $commandParts += @((Quote-Bash "--toolsets"), (Quote-Bash ($Toolsets -join ",")))
}
$commandParts += @((Quote-Bash "--source"), (Quote-Bash $Source), (Quote-Bash "--quiet"))

$runnerFile = Join-Path $env:TEMP ("hermes-exec-" + [guid]::NewGuid().ToString("N") + ".sh")
$runner = @(
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'export PATH="$HOME/.local/bin:$PATH"',
    "cd $(Quote-Bash $wslRoot)",
    "cmd=(" + ($commandParts -join " ") + ")",
    $execLine
) -join "`n"
[System.IO.File]::WriteAllText($runnerFile, $runner + "`n", [System.Text.UTF8Encoding]::new($false))

try {
    Write-Host "Hermes executor prepared: command=$HermesCommand profile=$Profile provider=$Provider model=$Model"
    Write-Host "Project root: $resolvedRoot"
    if ($NoRun) {
        Write-Host "NoRun set; Hermes was not called."
        exit 0
    }
    & wsl.exe -d $WslDistro -- bash (ConvertTo-WslPath $runnerFile)
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $runnerFile -Force -ErrorAction SilentlyContinue
}
