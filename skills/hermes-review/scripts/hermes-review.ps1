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

    [string]$HermesEnvPath = "/root/.hermes/.env",

    [string]$Provider = "",

    [string]$Model = "",

    [string[]]$Models = @(),

    [string]$OutputPath = "",

    [ValidateSet("auto", "on", "off")]
    [string]$Vision = "auto",

    [string]$VisionModel = "qwen3.7-plus",

    [ValidateRange(1, 50)]
    [int]$MaxImageMb = 10,

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
$ImageExtensions = @(".png", ".jpg", ".jpeg", ".webp")
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

function Resolve-WslConfigPath {
    param([string]$PathValue)

    $clean = $PathValue.Trim()
    if ($clean.Length -eq 0) {
        return "/root/.hermes/.env"
    }

    if ($clean -match "^([A-Za-z]):\\(.*)$") {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2] -replace "\\", "/"
        return "/mnt/$drive/$rest"
    }

    return $clean
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

function Test-ImageFile {
    param([string]$File)
    $extension = [IO.Path]::GetExtension($File).ToLowerInvariant()
    return ($ImageExtensions -contains $extension)
}

function Get-GitReviewContent {
    param([string]$Root)

    $staged = & git -C $Root diff --cached --no-ext-diff -- . 2>$null
    $unstaged = & git -C $Root diff --no-ext-diff -- . 2>$null
    $names = & git -C $Root diff --name-only --cached -- . 2>$null
    $names += & git -C $Root diff --name-only -- . 2>$null
    $uniqueNames = @($names | Where-Object { $_ } | Sort-Object -Unique)
    $imageFiles = @()
    foreach ($name in $uniqueNames) {
        $candidate = Join-Path $Root $name
        if ((Test-Path -LiteralPath $candidate) -and (Test-ImageFile $candidate)) {
            $imageFiles += (Get-Item -LiteralPath $candidate).FullName
        }
    }

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
        ImageFiles = @($imageFiles | Sort-Object -Unique)
    }
}

function Resolve-InputPaths {
    param(
        [string[]]$Items,
        [switch]$AllowDirectories
    )

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
            $pathItem = Get-Item -LiteralPath $item
            if ($pathItem.PSIsContainer -and -not $AllowDirectories) {
                Write-Warning "Skipping directory path in content-review mode: $($pathItem.FullName)"
                continue
            }
            $resolved += $pathItem.FullName
            continue
        }

        $matches = @(Resolve-Path -Path $item -ErrorAction SilentlyContinue)
        foreach ($match in $matches) {
            $pathItem = Get-Item -LiteralPath $match.Path
            if ($pathItem.PSIsContainer -and -not $AllowDirectories) {
                Write-Warning "Skipping directory path in content-review mode: $($pathItem.FullName)"
                continue
            }
            $resolved += $pathItem.FullName
        }
    }

    return @($resolved | Sort-Object -Unique)
}

function Get-FileReviewContent {
    param([string[]]$Files)

    $binaryExtensions = @(
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".gif", ".zip", ".7z", ".rar",
        ".vhdx", ".exe", ".dll"
    )

    $parts = @()
    $skipped = @()
    $imageFiles = @()

    foreach ($file in $Files) {
        $extension = [IO.Path]::GetExtension($file).ToLowerInvariant()
        if (Test-ImageFile $file) {
            $imageFiles += $file
            continue
        }

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

    if ($imageFiles.Count -gt 0) {
        $parts += "## IMAGE FILES AVAILABLE FOR VISION REVIEW"
        foreach ($file in $imageFiles) {
            $parts += "- WSL: $(ConvertTo-WslPath $file)"
            $parts += "  Windows: $file"
        }
        $parts += ""
        $parts += "These images are not inlined as text. When vision is enabled, the wrapper sends them to the configured vision model."
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
        ImageFiles = @($imageFiles | Sort-Object -Unique)
    }
}

function Get-PathOnlyReviewContent {
    param([string[]]$Files)

    $parts = @()
    $imageFiles = @($Files | Where-Object { (Test-Path -LiteralPath $_) -and (Test-ImageFile $_) } | Sort-Object -Unique)
    $parts += "## FILE PATHS FOR HERMES INSPECTION"
    $parts += ""
    $parts += "Read only the parts of these files needed for the requested task."
    $parts += "Use the WSL paths when invoking tools from Hermes."
    $parts += ""

    foreach ($file in $Files) {
        $parts += "- WSL: $(ConvertTo-WslPath $file)"
        $parts += "  Windows: $file"
    }

    if ($imageFiles.Count -gt 0) {
        $parts += ""
        $parts += "## IMAGE FILES AVAILABLE FOR VISION REVIEW"
        foreach ($file in $imageFiles) {
            $parts += "- WSL: $(ConvertTo-WslPath $file)"
            $parts += "  Windows: $file"
        }
        $parts += ""
        $parts += "When vision is enabled, these images are sent to the configured vision model before later text-model passes."
    }

    return [pscustomobject]@{
        Source = "file paths only"
        Text = ($parts -join "`n")
        FileCount = $Files.Count
        Files = $Files
        ImageFiles = @($imageFiles)
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
        return [pscustomobject]@{ Model = (Resolve-ModelAlias $Model); Reason = "explicit model override" }
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

function Resolve-ModelAlias {
    param([string]$Name)

    $normalized = $Name.Trim().ToLowerInvariant() -replace "\s+", "-"
    switch ($normalized) {
        "qwen-flash" { return $FlashModel }
        "qwen3-flash" { return $FlashModel }
        "qwen3.6-flash" { return $FlashModel }
        "qwen-pro" { return $ProModel }
        "qwen-plus" { return $ProModel }
        "qwen3-pro" { return $ProModel }
        "qwen3.7-plus" { return $ProModel }
        "deepseek-flash" { return $DeepSeekFlashOpinionModel }
        "deepseek-v4-flash" { return $DeepSeekFlashOpinionModel }
        "deepseek-pro" { return $DeepSeekProOpinionModel }
        "deepseek-v4-pro" { return $DeepSeekProOpinionModel }
        "glm" { return $CodeProModel }
        "glm-pro" { return $CodeProModel }
        "glm-code" { return $CodeProModel }
        "glm-5.2" { return $CodeProModel }
        default { return $Name.Trim() }
    }
}

function Resolve-ModelList {
    param([string[]]$Items)

    $resolved = @()
    foreach ($item in $Items) {
        foreach ($part in ($item -split ",")) {
            $clean = $part.Trim().Trim('"').Trim("'")
            if ($clean.Length -gt 0) {
                $modelName = Resolve-ModelAlias $clean
                if (-not ($resolved -contains $modelName)) {
                    $resolved += $modelName
                }
            }
        }
    }

    return @($resolved)
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

function Get-ModelRouteSummary {
    param(
        [string[]]$ModelNames,
        [string]$RequestedProvider
    )

    $routes = foreach ($modelName in $ModelNames) {
        $providerName = Select-HermesProvider -ModelName $modelName -RequestedProvider $RequestedProvider
        "$modelName($providerName)"
    }

    return ($routes -join ", ")
}

function Write-VisionRunnerScript {
    param([string]$Path)

    $script = @'
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request


KNOWN_IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def load_env(path):
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_text(path):
    with open(path, "r", encoding="utf-8-sig") as handle:
        return handle.read()


def validate_image_bytes(path, data):
    ext = os.path.splitext(path)[1].lower()
    if ext not in KNOWN_IMAGE_TYPES:
        raise ValueError(f"unsupported image extension: {ext}")
    if ext == ".png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("file does not look like a PNG image")
    if ext in (".jpg", ".jpeg") and not data.startswith(b"\xff\xd8\xff"):
        raise ValueError("file does not look like a JPEG image")
    if ext == ".webp" and not (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        raise ValueError("file does not look like a WEBP image")
    return KNOWN_IMAGE_TYPES[ext]


def image_part(path):
    with open(path, "rb") as handle:
        data = handle.read()
    mime = validate_image_bytes(path, data)
    encoded = base64.b64encode(data).decode("ascii")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{encoded}"},
    }


def extract_text(data):
    choice = data.get("choices", [{}])[0]
    message = choice.get("message", {})
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for item in content:
            if isinstance(item, dict):
                if "text" in item:
                    chunks.append(str(item["text"]))
                elif item.get("type") == "text" and "content" in item:
                    chunks.append(str(item["content"]))
            else:
                chunks.append(str(item))
        return "\n".join(chunks)
    return str(content)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--max-image-bytes", type=int, required=True)
    parser.add_argument("--env-file", default=os.environ.get("HERMES_ENV_PATH", "/root/.hermes/.env"))
    args = parser.parse_args()

    env = load_env(args.env_file)
    key = os.environ.get("DASHSCOPE_API_KEY") or env.get("DASHSCOPE_API_KEY")
    if not key:
        print(f"DASHSCOPE_API_KEY is not set in {args.env_file} or the process environment.", file=sys.stderr)
        return 2

    base_url = os.environ.get("DASHSCOPE_BASE_URL") or env.get("DASHSCOPE_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1"
    endpoint = base_url.rstrip("/") + "/chat/completions"

    with open(args.manifest, "r", encoding="utf-8-sig") as handle:
        manifest = json.load(handle)

    prompt_text = read_text(args.prompt)
    images = manifest.get("images", [])
    vision_preamble = (
        f"You are the vision sidecar running model {args.model}. "
        "The review prompt below may mention separate Hermes text-pass models; do not report those as the vision model. "
        "Inspect the attached image files directly and mention concrete visual evidence. "
        "Do not claim an image was inspected if it was skipped."
    )
    content = [{"type": "text", "text": vision_preamble + "\n\n" + prompt_text}]

    attached = 0
    skipped = []
    for image in images:
        path = image["wsl"]
        size = int(image.get("bytes", 0))
        if size > args.max_image_bytes:
            skipped.append(f"{path} ({size} bytes > limit {args.max_image_bytes})")
            continue
        try:
            part = image_part(path)
        except Exception as exc:
            skipped.append(f"{path} ({exc})")
            continue
        content.append({"type": "text", "text": f"Image file: {path}"})
        content.append(part)
        attached += 1

    if skipped:
        content.append({"type": "text", "text": "Skipped oversized images:\n" + "\n".join(skipped)})

    if attached == 0:
        print("No image files were attached to the vision request.", file=sys.stderr)
        return 1

    body = {
        "model": args.model,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.2,
    }

    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"Vision API HTTP {exc.code}: {detail}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Vision API request failed: {exc}", file=sys.stderr)
        return 1

    print(extract_text(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
'@

    [System.IO.File]::WriteAllText($Path, $script, [System.Text.UTF8Encoding]::new($false))
}

$resolvedRoot = Resolve-ProjectRoot $ProjectRoot
$gitReview = $null
$usePathOnly = ($PathOnly -or $Flow -eq "delegate")
$explicitModels = @(Resolve-ModelList $Models)

if ($explicitModels.Count -gt 0 -and $Model.Trim().Length -gt 0) {
    throw "Use either -Model for one explicit model or -Models for an explicit model list, not both."
}

if ($usePathOnly) {
    $resolvedFiles = @(Resolve-InputPaths -Items $Path)
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
        $resolvedFiles = @(Resolve-InputPaths -Items $Path)
        if ($resolvedFiles.Count -eq 0) {
            Write-Error "No git diff was found and no readable -Path files were provided. Pass changed files with -Path, or run this inside a git repo with changes."
        }
        $review = Get-FileReviewContent $resolvedFiles
    }
}

if ($explicitModels.Count -gt 0) {
    $selection = [pscustomobject]@{ Model = $explicitModels[0]; Reason = "explicit model list override" }
} elseif ($Flow -eq "delegate" -and $Mode -eq "auto" -and $Model.Trim().Length -eq 0) {
    $selection = [pscustomobject]@{ Model = $FlashModel; Reason = "delegate flow default flash mode" }
} else {
    $selection = Select-HermesModel -ModeValue $Mode -TaskTypeValue $TaskType -Text $review.Text -FileCount $review.FileCount -Files $review.Files
}
$model = $selection.Model
$models = if ($explicitModels.Count -gt 0) { $explicitModels } else { @(Select-OpinionModels -PrimaryModel $model -Count $OpinionCount) }
$modelSummary = ($models -join ", ")
$selectionReason = $selection.Reason
if ($explicitModels.Count -gt 0) {
    $selectionReason = "explicit model list override"
} elseif ($OpinionCount -ge 3) {
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
$routeSummary = Get-ModelRouteSummary -ModelNames $models -RequestedProvider $Provider
$imageFiles = @($review.ImageFiles)
$resolvedVisionModel = Resolve-ModelAlias $VisionModel
$resolvedHermesEnvPath = Resolve-WslConfigPath $HermesEnvPath
$visionEnabled = ($Vision -ne "off" -and $imageFiles.Count -gt 0)
$visionStatus = if ($visionEnabled) {
    "enabled: $resolvedVisionModel via alibaba vision API"
} elseif ($imageFiles.Count -gt 0) {
    "off: image files were detected but will not be sent to a vision model"
} elseif ($Vision -eq "on") {
    "requested but no image files were detected"
} else {
    "not needed: no image files detected"
}
if ($Vision -eq "on" -and $imageFiles.Count -eq 0) {
    Write-Warning "Vision was set to 'on', but no image files were detected in -Path or git diff."
}

$tempBase = Join-Path ([IO.Path]::GetTempPath()) ("hermes-review-" + [guid]::NewGuid().ToString("N"))
$inputFile = "$tempBase.input.md"
$promptFile = "$tempBase.prompt.md"
$runnerFile = "$tempBase.runner.sh"
$visionScriptFile = "$tempBase.vision.py"
$visionManifestFile = "$tempBase.images.json"
$visionResultFile = "$tempBase.vision-result.md"
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
- Route(s): $routeSummary
- Image files: $($imageFiles.Count)
- Vision: $visionStatus
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
- Route(s): $routeSummary
- Image files: $($imageFiles.Count)
- Vision: $visionStatus
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
Write-Host "Routes: $routeSummary"
Write-Host "Images: $($imageFiles.Count)"
Write-Host "Vision: $visionStatus"
if ($visionEnabled) {
    Write-Host "Vision env: $resolvedHermesEnvPath"
}
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

if ($visionEnabled) {
    $visionEntries = foreach ($imageFile in $imageFiles) {
        $item = Get-Item -LiteralPath $imageFile
        [pscustomobject]@{
            windows = $item.FullName
            wsl = ConvertTo-WslPath $item.FullName
            bytes = $item.Length
        }
    }
    $visionManifest = [pscustomobject]@{
        images = @($visionEntries)
    }
    [System.IO.File]::WriteAllText($visionManifestFile, ($visionManifest | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText($visionResultFile, "", [System.Text.UTF8Encoding]::new($false))
    Write-VisionRunnerScript -Path $visionScriptFile
}

if ($NoRun) {
    Write-Host "NoRun set; Hermes was not called."
    if (-not $KeepTemp) {
        Remove-Item -LiteralPath $inputFile, $promptFile, $runnerFile, $visionScriptFile, $visionManifestFile, $visionResultFile -Force -ErrorAction SilentlyContinue
    }
    if (-not $reportShouldPersist) {
        Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

$wslProject = ConvertTo-WslPath $resolvedRoot
$wslPrompt = ConvertTo-WslPath $promptFile
$wslOutput = ConvertTo-WslPath $resolvedOutputPath
$wslVisionScript = if ($visionEnabled) { ConvertTo-WslPath $visionScriptFile } else { "" }
$wslVisionManifest = if ($visionEnabled) { ConvertTo-WslPath $visionManifestFile } else { "" }
$wslVisionResult = if ($visionEnabled) { ConvertTo-WslPath $visionResultFile } else { "" }
$wslHermesEnv = if ($visionEnabled) { $resolvedHermesEnvPath } else { "" }

& wsl.exe -d $WslDistro -- bash -lc 'export PATH="$HOME/.local/bin:$PATH"; command -v hermes >/dev/null'
if ($LASTEXITCODE -ne 0) {
    Write-Error "Hermes CLI was not found in WSL distro '$WslDistro'. Confirm the distro name with 'wsl -l -v' and make sure 'hermes' is on PATH inside WSL."
}

if ($visionEnabled) {
    & wsl.exe -d $WslDistro -- bash -lc 'export PATH="$HOME/.local/bin:$PATH"; command -v python3 >/dev/null'
    if ($LASTEXITCODE -ne 0) {
        Write-Error "python3 was not found in WSL distro '$WslDistro'. Vision review requires Python 3 inside WSL."
    }
}

$liteArgs = ""
if ($Lite) {
    $liteArgs = " --ignore-rules"
}

$cdLine = "cd $(Quote-Bash $wslProject)"
$promptLine = "prompt=`$(cat $(Quote-Bash $wslPrompt))"
$runLines = @("status=0")
if ($visionEnabled) {
    $quotedVisionModel = Quote-Bash $resolvedVisionModel
    $quotedVisionScript = Quote-Bash $wslVisionScript
    $quotedVisionManifest = Quote-Bash $wslVisionManifest
    $quotedVisionPrompt = Quote-Bash $wslPrompt
    $quotedVisionOutput = Quote-Bash $wslOutput
    $quotedVisionResult = Quote-Bash $wslVisionResult
    $quotedHermesEnv = Quote-Bash $wslHermesEnv
    $maxImageBytes = $MaxImageMb * 1MB
    $runLines += "printf '\n\n---\n\n## Hermes vision pass: %s (alibaba)\n\n' $quotedVisionModel | tee -a $quotedVisionOutput"
    $runLines += "python3 $quotedVisionScript --manifest $quotedVisionManifest --prompt $quotedVisionPrompt --model $quotedVisionModel --max-image-bytes $maxImageBytes --env-file $quotedHermesEnv 2>&1 | tee $quotedVisionResult | tee -a $quotedVisionOutput"
    $runLines += 'cmd_status=${PIPESTATUS[0]}; if [ "$cmd_status" -ne 0 ] && [ "$status" -eq 0 ]; then status="$cmd_status"; fi'
    $runLines += 'if [ -s ' + $quotedVisionResult + ' ]; then'
    $runLines += '  prompt="$(printf "%s\n\n## Vision sidecar result\n\n%s" "$prompt" "$(cat ' + $quotedVisionResult + ')")"'
    $runLines += 'fi'
}
foreach ($runModel in $models) {
    $quotedModel = Quote-Bash $runModel
    $runProvider = Select-HermesProvider -ModelName $runModel -RequestedProvider $Provider
    $quotedProvider = Quote-Bash $runProvider
    $quotedOutput = Quote-Bash $wslOutput
    $runLines += "printf '\n\n---\n\n## Hermes pass: %s (%s)\n\n' $quotedModel $quotedProvider | tee -a $quotedOutput"
    $runLines += "hermes$liteArgs --provider $quotedProvider -m $quotedModel -z `"`$prompt`" 2>&1 | tee -a $quotedOutput"
    $runLines += 'cmd_status=${PIPESTATUS[0]}; if [ "$cmd_status" -ne 0 ] && [ "$status" -eq 0 ]; then status="$cmd_status"; fi'
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
    Remove-Item -LiteralPath $inputFile, $promptFile, $runnerFile, $visionScriptFile, $visionManifestFile, $visionResultFile -Force -ErrorAction SilentlyContinue
}

if (-not $reportShouldPersist) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force -ErrorAction SilentlyContinue
}

exit $hermesExitCode
