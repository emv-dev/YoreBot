#Requires -Version 7.2

[CmdletBinding()]
param(
    [string] $WorkRoot = '',

    [switch] $ValidateManifestOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path $PSScriptRoot
$modelManifestPath = Join-Path $projectRoot 'web-app/src/constants/yorebot-models.ts'
$backendManifestPath = Join-Path $projectRoot 'extensions/llamacpp-upstream-extension/src/backend.ts'
$firewallRuleName = "YoreBot pinned model smoke $([guid]::NewGuid())"
$serverProcess = $null
$createdWorkRoot = $false

function Get-StringField {
    param([string] $Block, [string] $Name)
    $match = [regex]::Match($Block, "(?m)\b$([regex]::Escape($Name))\s*:\s*'([^']+)'")
    if (-not $match.Success) { throw "Missing string field '$Name' in source manifest" }
    return $match.Groups[1].Value
}

function Get-IntegerField {
    param([string] $Block, [string] $Name)
    $match = [regex]::Match($Block, "(?m)\b$([regex]::Escape($Name))\s*:\s*([0-9_]+)")
    if (-not $match.Success) { throw "Missing integer field '$Name' in source manifest" }
    return [int64]($match.Groups[1].Value.Replace('_', ''))
}

function Invoke-PinnedDownload {
    param([string] $Url, [string] $Destination)
    & curl.exe --fail --location --silent --show-error --retry 3 --retry-all-errors `
        --output $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}

function Assert-PinnedFile {
    param([string] $Path, [int64] $Size, [string] $Sha256)
    $actualSize = (Get-Item -LiteralPath $Path).Length
    if ($actualSize -ne $Size) {
        throw "Pinned size mismatch for $Path (expected $Size, got $actualSize)"
    }
    $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $Sha256.ToLowerInvariant()) {
        throw "Pinned SHA-256 mismatch for $Path"
    }
}

$modelSource = Get-Content $modelManifestPath -Raw
$modelMatch = [regex]::Match(
    $modelSource,
    "(?s)pinnedModel\(\{\s*id:\s*'Qwen3\.5-9B-Q4_K_M',(?<body>.*?)\}\)"
)
if (-not $modelMatch.Success) { throw 'Pinned Qwen3.5-9B model is missing from source manifest' }
$modelBlock = $modelMatch.Groups['body'].Value
$model = [pscustomobject]@{
    Id = 'Qwen3.5-9B-Q4_K_M'
    Repository = Get-StringField $modelBlock 'repository'
    Revision = Get-StringField $modelBlock 'revision'
    Filename = Get-StringField $modelBlock 'filename'
    Size = Get-IntegerField $modelBlock 'sizeBytes'
    Sha256 = Get-StringField $modelBlock 'sha256'
}
$modelUrl = "https://huggingface.co/$($model.Repository)/resolve/$($model.Revision)/$($model.Filename)"

$backendSource = Get-Content $backendManifestPath -Raw
$backendMatch = [regex]::Match(
    $backendSource,
    "(?ms)^[ \t]*\{[ \t]*\r?\n[ \t]*version:\s*'b10431',\s*backend:\s*'win-cpu-x64',(?<body>.*?^[ \t]*sha256:\s*'[0-9a-f]{64}',[ \t]*\r?\n)[ \t]*\},[ \t]*$"
)
if (-not $backendMatch.Success) { throw 'Pinned b10431 CPU backend is missing from source manifest' }
$backendBlock = $backendMatch.Groups['body'].Value
$backend = [pscustomobject]@{
    Version = 'b10431'
    Variant = 'win-cpu-x64'
    Filename = Get-StringField $backendBlock 'filename'
    Size = Get-IntegerField $backendBlock 'size'
    Sha256 = Get-StringField $backendBlock 'sha256'
}
$backendUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$($backend.Version)/$($backend.Filename)"

if ($model.Repository -ne 'unsloth/Qwen3.5-9B-GGUF' -or
    $model.Filename -ne 'Qwen3.5-9B-Q4_K_M.gguf') {
    throw 'The ordinary-laptop source pin changed; review this acceptance ritual explicitly'
}
if ($backend.Filename -ne 'llama-b10431-bin-win-cpu-x64.zip') {
    throw 'The Windows CPU source pin changed; review this acceptance ritual explicitly'
}
if ($ValidateManifestOnly) {
    Write-Host 'Pinned model and runtime manifests parsed successfully.'
    return
}
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    throw 'WorkRoot is required unless ValidateManifestOnly is set'
}

$workRootFull = [System.IO.Path]::GetFullPath($WorkRoot)
if (Test-Path -LiteralPath $workRootFull) {
    throw "Acceptance root must be fresh: $workRootFull"
}
New-Item -ItemType Directory -Path $workRootFull | Out-Null
$createdWorkRoot = $true

$modelPath = Join-Path $workRootFull $model.Filename
$backendArchive = Join-Path $workRootFull $backend.Filename
$runtimeRoot = Join-Path $workRootFull 'runtime'
$stdoutPath = Join-Path $workRootFull 'llama-server.stdout.log'
$stderrPath = Join-Path $workRootFull 'llama-server.stderr.log'

try {
    Invoke-PinnedDownload -Url $backendUrl -Destination $backendArchive
    Assert-PinnedFile -Path $backendArchive -Size $backend.Size -Sha256 $backend.Sha256
    Invoke-PinnedDownload -Url $modelUrl -Destination $modelPath
    Assert-PinnedFile -Path $modelPath -Size $model.Size -Sha256 $model.Sha256

    New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
    Expand-Archive -LiteralPath $backendArchive -DestinationPath $runtimeRoot
    $servers = @(Get-ChildItem -LiteralPath $runtimeRoot -Filter 'llama-server.exe' -File -Recurse)
    if ($servers.Count -ne 1) { throw "Expected one llama-server.exe, found $($servers.Count)" }
    $serverPath = $servers[0].FullName

    # Downloads and integrity checks are complete. From this point onward the
    # exact server executable is denied outbound network access.
    New-NetFirewallRule `
        -DisplayName $firewallRuleName `
        -Direction Outbound `
        -Action Block `
        -Program $serverPath `
        -Profile Any | Out-Null
    $rule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction Stop
    if ($rule.Enabled.ToString() -ne 'True' -or
        $rule.Direction.ToString() -ne 'Outbound' -or
        $rule.Action.ToString() -ne 'Block') {
        throw 'Outbound firewall rule is not active for llama-server'
    }

    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $port = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
    $portProbe.Stop()

    $serverProcess = Start-Process -FilePath $serverPath -ArgumentList @(
        '--model', "`"$modelPath`"",
        '--host', '127.0.0.1',
        '--port', "$port",
        '--ctx-size', '512',
        '--threads', '2',
        '--parallel', '1',
        '--gpu-layers', '0'
    ) -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

    $healthUrl = "http://127.0.0.1:$port/health"
    $deadline = [DateTime]::UtcNow.AddMinutes(20)
    $healthy = $false
    do {
        if ($serverProcess.HasExited) {
            throw "llama-server exited during model load with code $($serverProcess.ExitCode)"
        }
        try {
            $health = Invoke-RestMethod -Uri $healthUrl -Method Get -NoProxy -TimeoutSec 5
            if ($health.status -eq 'ok') { $healthy = $true }
        } catch {
            Start-Sleep -Seconds 2
        }
    } while (-not $healthy -and [DateTime]::UtcNow -lt $deadline)
    if (-not $healthy) { throw 'llama-server did not become healthy before the deadline' }

    $listeners = @(Get-NetTCPConnection -OwningProcess $serverProcess.Id -State Listen)
    if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }).Count -ne 0) {
        throw 'llama-server must listen only on 127.0.0.1'
    }

    $request = @{
        model = $model.Id
        messages = @(@{ role = 'user'; content = 'Reply with OK.' })
        max_tokens = 32
        temperature = 0
        stream = $false
    } | ConvertTo-Json -Depth 5
    $response = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$port/v1/chat/completions" `
        -Method Post `
        -ContentType 'application/json' `
        -Body $request `
        -NoProxy `
        -TimeoutSec 900
    $message = $response.choices[0].message
    $contentProperty = $message.PSObject.Properties['content']
    $reasoningProperty = $message.PSObject.Properties['reasoning_content']
    $content = if ($null -ne $contentProperty) { [string]$contentProperty.Value } else { '' }
    $reasoning = if ($null -ne $reasoningProperty) { [string]$reasoningProperty.Value } else { '' }
    $responseText = "$content$reasoning".Trim()
    if ([string]::IsNullOrWhiteSpace($responseText)) {
        throw 'Pinned model returned an empty response'
    }

    Stop-Process -Id $serverProcess.Id -Force -ErrorAction Stop
    if (-not $serverProcess.WaitForExit(30000)) { throw 'llama-server did not stop' }
    Write-Host 'Pinned Qwen3.5-9B response smoke passed on loopback.'
} catch {
    if (Test-Path -LiteralPath $stderrPath) {
        Write-Host 'llama-server stderr tail:'
        Get-Content -LiteralPath $stderrPath -Tail 80
    }
    throw
} finally {
    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(30000) | Out-Null
    }
    Remove-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
    if ($createdWorkRoot -and (Test-Path -LiteralPath $workRootFull)) {
        Remove-Item -LiteralPath $workRootFull -Recurse -Force
    }
}
