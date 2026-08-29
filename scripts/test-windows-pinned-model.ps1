#Requires -Version 7.2

[CmdletBinding()]
param(
    [string] $WorkRoot = '',

    [ValidateSet('ordinary-16gb', 'high-end-32gb', 'unsupported-4gb', 'unknown')]
    [string] $HardwareProfile = 'ordinary-16gb',

    [switch] $ValidateManifestOnly,

    [switch] $RunDownloadsAgentAcceptance
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

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

function Get-ActualPhysicalMemoryBytes {
    $job = Start-Job -ScriptBlock {
        [int64](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory
    }
    try {
        $completed = Wait-Job -Job $job -Timeout 15
        if ($null -eq $completed) { throw 'Windows physical-memory detection timed out' }
        if ($job.State -ne 'Completed') { throw "Windows physical-memory detection failed: $($job.State)" }
        $values = @(Receive-Job -Job $job -ErrorAction Stop)
        $value = [int64]$values[-1]
        if ($value -le 0) { throw 'Windows physical-memory detection returned no usable value' }
        return $value
    } finally {
        if ($job.State -eq 'Running') { Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null }
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}

function Get-AvailableDiskBytes {
    param([string] $Path)
    $driveRoot = [System.IO.Path]::GetPathRoot($Path)
    if ([string]::IsNullOrWhiteSpace($driveRoot)) {
        throw "Cannot resolve drive for acceptance root: $Path"
    }
    return [int64]([System.IO.DriveInfo]::new($driveRoot)).AvailableFreeSpace
}

function Get-PinnedModel {
    param([string] $Source, [string] $Id)
    $escapedId = [regex]::Escape($Id)
    $match = [regex]::Match(
        $Source,
        "(?s)pinnedModel\(\{\s*id:\s*'$escapedId',(?<body>.*?)\}\)"
    )
    if (-not $match.Success) { throw "Pinned model '$Id' is missing from source manifest" }
    $block = $match.Groups['body'].Value
    return [pscustomobject]@{
        Id = $Id
        Repository = Get-StringField $block 'repository'
        Revision = Get-StringField $block 'revision'
        Filename = Get-StringField $block 'filename'
        Size = Get-IntegerField $block 'sizeBytes'
        Sha256 = Get-StringField $block 'sha256'
    }
}

$modelSource = Get-Content $modelManifestPath -Raw
$models = @(
    Get-PinnedModel -Source $modelSource -Id 'Qwen3.5-9B-Q4_K_M'
    Get-PinnedModel -Source $modelSource -Id 'Qwen3.8-27B-Q4_K_M'
)

if ($models[0].Repository -ne 'unsloth/Qwen3.5-9B-GGUF' -or
    $models[0].Filename -ne 'Qwen3.5-9B-Q4_K_M.gguf') {
    throw 'The ordinary-laptop source pin changed; review this acceptance ritual explicitly'
}
if ($models[1].Repository -ne 'ggml-org/Qwen3.8-27B-GGUF' -or
    $models[1].Filename -ne 'Qwen3.8-27B-Q4_K_M.gguf') {
    throw 'The high-end source pin changed; review this acceptance ritual explicitly'
}

$profileMemoryMb = switch ($HardwareProfile) {
    'ordinary-16gb' { 16 * 1024 }
    'high-end-32gb' { 32 * 1024 }
    'unsupported-4gb' { 4 * 1024 }
    'unknown' { 0 }
}
if ($profileMemoryMb -le 0) {
    throw "Hardware profile memory is unknown; refusing model selection for '$HardwareProfile'"
}
$profileMemoryBytes = [int64]$profileMemoryMb * 1MB
$model = @(
    $models |
        Sort-Object -Property Size -Descending |
        Where-Object { $_.Size * 10 -le $profileMemoryBytes * 7 } |
        Select-Object -First 1
)
if ($model.Count -ne 1) {
    throw "No pinned model fits hardware profile '$HardwareProfile'; refusing download"
}
$model = $model[0]
$expectedModelId = switch ($HardwareProfile) {
    'ordinary-16gb' { 'Qwen3.5-9B-Q4_K_M' }
    'high-end-32gb' { 'Qwen3.8-27B-Q4_K_M' }
}
if ($model.Id -ne $expectedModelId) {
    throw "Automatic selection changed for '$HardwareProfile'; expected '$expectedModelId', got '$($model.Id)'"
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

if ($backend.Filename -ne 'llama-b10431-bin-win-cpu-x64.zip') {
    throw 'The Windows CPU source pin changed; review this acceptance ritual explicitly'
}
Write-Host "Pinned acceptance manifest: profile=$HardwareProfile profile_memory_mb=$profileMemoryMb model_id=$($model.Id) model_revision=$($model.Revision) model_filename=$($model.Filename) model_size_bytes=$($model.Size) model_sha256=$($model.Sha256) runtime_version=$($backend.Version) runtime_variant=$($backend.Variant) runtime_filename=$($backend.Filename) runtime_size_bytes=$($backend.Size) runtime_sha256=$($backend.Sha256) result=pass"
if ($ValidateManifestOnly) {
    Write-Host "Pinned manifests and automatic selection passed: profile=$HardwareProfile memory_mb=$profileMemoryMb model_id=$($model.Id) result=pass"
    return
}
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    throw 'WorkRoot is required unless ValidateManifestOnly is set'
}

$workRootFull = [System.IO.Path]::GetFullPath($WorkRoot)
if (Test-Path -LiteralPath $workRootFull) {
    throw "Acceptance root must be fresh: $workRootFull"
}
$actualMemoryBytes = Get-ActualPhysicalMemoryBytes
if ($model.Size * 10 -gt $actualMemoryBytes * 7) {
    throw "The selected pinned model does not fit actual Windows RAM before model download: profile=$HardwareProfile model_bytes=$($model.Size) actual_memory_bytes=$actualMemoryBytes"
}
$workspaceHeadroomBytes = [int64](512MB)
$requiredDiskBytes = [int64]$model.Size + ([int64]$backend.Size * 2) + $workspaceHeadroomBytes
$availableDiskBytes = Get-AvailableDiskBytes -Path $workRootFull
if ($availableDiskBytes -lt $requiredDiskBytes) {
    throw "Windows acceptance does not have enough free disk before model download: profile=$HardwareProfile required_bytes=$requiredDiskBytes available_bytes=$availableDiskBytes"
}
Write-Host "Pinned acceptance environment passed: profile=$HardwareProfile profile_memory_bytes=$profileMemoryBytes actual_memory_bytes=$actualMemoryBytes available_disk_bytes=$availableDiskBytes required_disk_bytes=$requiredDiskBytes result=pass"
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

    if ($RunDownloadsAgentAcceptance) {
        $env:ATOMIC_AGENT_E2E_LLAMA_SERVER = $serverPath
        $env:ATOMIC_AGENT_E2E_MODEL = $modelPath
        $env:ATOMIC_AGENT_E2E_MODEL_ID = $model.Id
        $env:ATOMIC_AGENT_E2E_TIMEOUT_SECS = '900'
        Push-Location $projectRoot
        try {
            & cargo test `
                --manifest-path src-tauri/Cargo.toml `
                --lib `
                --features test-tauri `
                core::agent::model_e2e::downloads_agent_acceptance `
                -- `
                --ignored `
                --nocapture `
                --test-threads=1
        } finally {
            Pop-Location
        }
        Write-Host "Pinned Downloads Agent acceptance passed: profile=$HardwareProfile memory_mb=$profileMemoryMb model_id=$($model.Id) result=pass"
        return
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
    Write-Host "Pinned model response smoke passed on loopback: profile=$HardwareProfile memory_mb=$profileMemoryMb model_id=$($model.Id) result=pass"
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
