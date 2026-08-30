#Requires -Version 7.2

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $InstallerPath,

    [Parameter(Mandatory)]
    [string] $WorkRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$installer = [System.IO.Path]::GetFullPath($InstallerPath)
$workRootFull = [System.IO.Path]::GetFullPath($WorkRoot)
$projectRoot = Split-Path $PSScriptRoot
$cargoManifest = Get-Content (Join-Path $projectRoot 'src-tauri/Cargo.toml') -Raw
$defaultRun = [regex]::Match($cargoManifest, '(?m)^default-run\s*=\s*"([^"]+)"\s*$')
if (-not $defaultRun.Success) { throw 'Cargo default-run is missing' }

$installRoot = Join-Path $workRootFull 'YoreBot'
$installSibling = Join-Path $workRootFull 'YoreBotTools'
$dataSibling = Join-Path $env:APPDATA "YoreBotTools-$([guid]::NewGuid().ToString('N'))"
$appPath = Join-Path $installRoot "$($defaultRun.Groups[1].Value).exe"
$uninstallerPath = Join-Path $installRoot 'uninstall.exe'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\YoreBot'
$dataRoot = Join-Path $env:APPDATA 'YoreBot/data'
$configRoot = Join-Path $env:APPDATA 'app.yorebot.desktop'
$webViewRoot = Join-Path $env:LOCALAPPDATA 'app.yorebot.desktop'
$modelId = 'Qwen3.5-9B-Q4_K_M'
$modelRevision = '3885219b6810b007914f3a7950a8d1b469d598a5'
$modelSize = [int64]5680522464
$modelSha256 = '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'
$modelSource = Get-Content (Join-Path $projectRoot 'web-app/src/constants/yorebot-models.ts') -Raw
$firewallRuleName = "YoreBot first-use llama-server $([guid]::NewGuid())"
$ownedSentinels = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$appProcess = $null
$serverProcess = $null
$cdpSocket = $null
$appStdoutPath = ''
$appStderrPath = ''
$cdpPort = 9229
$createdWorkRoot = $false
$installed = $false
$passed = $false

function Test-EqualOrChild {
    param([string] $Candidate, [string] $Root)

    $canonicalCandidate = [System.IO.Path]::GetFullPath($Candidate)
    $canonicalRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char]92)
    return ($canonicalCandidate -ieq $canonicalRoot) -or
        $canonicalCandidate.StartsWith(
            $canonicalRoot + [char]92,
            [System.StringComparison]::OrdinalIgnoreCase
        )
}

function Get-ProcessesAtExactPath {
    param([string] $Path)

    $canonical = [System.IO.Path]::GetFullPath($Path)
    return @(
        Get-Process -ErrorAction SilentlyContinue | Where-Object {
            try {
                [System.IO.Path]::GetFullPath($_.Path) -ieq $canonical
            } catch {
                $false
            }
        }
    )
}

function Get-ProcessesUnderRoot {
    param([string] $Name, [string] $Root)

    return @(
        Get-Process -Name $Name -ErrorAction SilentlyContinue | Where-Object {
            try {
                Test-EqualOrChild -Candidate $_.Path -Root $Root
            } catch {
                $false
            }
        }
    )
}

function Stop-ExactProcesses {
    param([string] $Path)

    foreach ($process in @(Get-ProcessesAtExactPath -Path $Path)) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        $process.WaitForExit(15000) | Out-Null
    }
}

function Stop-ProcessesUnderRoot {
    param([string] $Name, [string] $Root)

    foreach ($process in @(Get-ProcessesUnderRoot -Name $Name -Root $Root)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(15000) | Out-Null
    }
}

function Start-SiblingSentinel {
    param([string] $Directory, [string] $Name)

    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $path = Join-Path $Directory "$Name.exe"
    Copy-Item -LiteralPath $env:ComSpec -Destination $path
    $process = Start-Process -FilePath $path -ArgumentList @(
        '/d', '/q', '/c', 'ping.exe -n 600 127.0.0.1 > nul'
    ) -PassThru
    Start-Sleep -Milliseconds 750
    if ($process.HasExited) { throw "$Name sibling sentinel exited early" }
    $live = Get-Process -Id $process.Id -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath($live.Path) -ine [System.IO.Path]::GetFullPath($path)) {
        throw "$Name sibling sentinel did not start from its exact fixture path"
    }
    $ownedSentinels.Add($process)
}

function Assert-LoopbackPortAvailable {
    param([int] $Port)

    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        $Port
    )
    try {
        $listener.Start()
    } catch {
        throw "Test-only WebView2 loopback port is unavailable: $Port"
    } finally {
        $listener.Stop()
    }
}

function Read-BoundedFileTail {
    param([string] $Path, [int] $Lines = 120)

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        Write-Host "Diagnostic tail: $Path"
        Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue
    }
}

function Write-WebViewDiagnostics {
    param([int] $Port, [System.Diagnostics.Process] $Process)

    Write-Host "WebView2 diagnostics: expected_port=$Port app_pid=$($Process.Id)"
    $webViewProcesses = @(
        Get-CimInstance Win32_Process `
            -Filter "Name = 'msedgewebview2.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $commandProperty = $_.PSObject.Properties['CommandLine']
                $parentProperty = $_.PSObject.Properties['ParentProcessId']
                $commandLine = if ($null -ne $commandProperty) {
                    [string]$commandProperty.Value
                } else {
                    ''
                }
                ($null -ne $parentProperty -and
                    [int]$parentProperty.Value -eq $Process.Id) -or
                    $commandLine.IndexOf(
                        $webViewRoot,
                        [System.StringComparison]::OrdinalIgnoreCase
                    ) -ge 0 -or
                    $commandLine.IndexOf(
                        'app.yorebot.desktop',
                        [System.StringComparison]::OrdinalIgnoreCase
                    ) -ge 0
            } |
            Select-Object -First 20
    )
    $webViewProcessIds = [System.Collections.Generic.List[int]]::new()
    foreach ($candidate in $webViewProcesses) {
        $idProperty = $candidate.PSObject.Properties['ProcessId']
        $parentProperty = $candidate.PSObject.Properties['ParentProcessId']
        $commandProperty = $candidate.PSObject.Properties['CommandLine']
        if ($null -eq $idProperty) { continue }
        $processId = [int]$idProperty.Value
        $webViewProcessIds.Add($processId)
        $parentId = if ($null -ne $parentProperty) {
            [int]$parentProperty.Value
        } else {
            0
        }
        $commandLine = if ($null -ne $commandProperty) {
            [string]$commandProperty.Value
        } else {
            ''
        }
        if ($commandLine.Length -gt 1200) {
            $commandLine = $commandLine.Substring(0, 1200)
        }
        Write-Host "WebView2 process diagnostic: pid=$processId parent=$parentId command_line=$commandLine"
    }

    foreach ($listener in @(
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object {
                $_.LocalPort -eq $Port -or
                    $webViewProcessIds.Contains([int]$_.OwningProcess)
            } |
            Select-Object -First 20
    )) {
        Write-Host "WebView2 listener diagnostic: address=$($listener.LocalAddress) port=$($listener.LocalPort) pid=$($listener.OwningProcess)"
    }

    foreach ($activePort in @(
        Get-ChildItem `
            -LiteralPath $webViewRoot `
            -Filter 'DevToolsActivePort' `
            -File `
            -Recurse `
            -ErrorAction SilentlyContinue |
            Select-Object -First 5
    )) {
        $value = @(Get-Content -LiteralPath $activePort.FullName -TotalCount 2)
        Write-Host "DevToolsActivePort diagnostic: path=$($activePort.FullName) value=$($value -join '|')"
    }
}

function Write-FirstUseDiagnostics {
    param([string] $StdoutPath, [string] $StderrPath)

    Read-BoundedFileTail -Path $StdoutPath
    Read-BoundedFileTail -Path $StderrPath
    $logRoot = Join-Path $env:APPDATA 'YoreBot/logs'
    if (Test-Path -LiteralPath $logRoot -PathType Container) {
        foreach ($log in @(
            Get-ChildItem -LiteralPath $logRoot -File -Recurse |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 3
        )) {
            Read-BoundedFileTail -Path $log.FullName -Lines 100
        }
    }
}

function Receive-CdpMessage {
    param(
        [System.Net.WebSockets.ClientWebSocket] $Socket,
        [int] $ExpectedId,
        [int] $TimeoutSeconds = 30
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $buffer = [byte[]]::new(65536)
        $stream = [System.IO.MemoryStream]::new()
        do {
            $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds)
            $cts = [System.Threading.CancellationTokenSource]::new(
                [TimeSpan]::FromSeconds($remaining)
            )
            try {
                $segment = [System.ArraySegment[byte]]::new($buffer)
                $received = $Socket.ReceiveAsync($segment, $cts.Token).GetAwaiter().GetResult()
            } finally {
                $cts.Dispose()
            }
            if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                throw 'The WebView2 debugging socket closed unexpectedly'
            }
            $stream.Write($buffer, 0, $received.Count)
        } while (-not $received.EndOfMessage)

        $json = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
        $message = $json | ConvertFrom-Json -Depth 30
        $idProperty = $message.PSObject.Properties['id']
        if ($null -ne $idProperty -and [int]$idProperty.Value -eq $ExpectedId) {
            $errorProperty = $message.PSObject.Properties['error']
            if ($null -ne $errorProperty) {
                $errorJson = $errorProperty.Value | ConvertTo-Json -Depth 10 -Compress
                throw "CDP command failed: $errorJson"
            }
            $resultProperty = $message.PSObject.Properties['result']
            if ($null -eq $resultProperty) {
                throw "CDP command $ExpectedId returned no result"
            }
            return $resultProperty.Value
        }
    }
    throw "CDP command $ExpectedId timed out"
}

function Invoke-CdpCommand {
    param(
        [System.Net.WebSockets.ClientWebSocket] $Socket,
        [string] $Method,
        [hashtable] $Params = @{},
        [int] $TimeoutSeconds = 30
    )

    $script:CdpCommandId += 1
    $id = $script:CdpCommandId
    $json = @{
        id = $id
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 30 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $segment = [System.ArraySegment[byte]]::new($bytes)
    $Socket.SendAsync(
        $segment,
        [System.Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()
    return Receive-CdpMessage -Socket $Socket -ExpectedId $id -TimeoutSeconds $TimeoutSeconds
}

function Invoke-CdpExpression {
    param(
        [System.Net.WebSockets.ClientWebSocket] $Socket,
        [string] $Expression
    )

    $result = Invoke-CdpCommand -Socket $Socket -Method 'Runtime.evaluate' -Params @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = $true
    }
    $exceptionProperty = $result.PSObject.Properties['exceptionDetails']
    if ($null -ne $exceptionProperty) {
        $exceptionJson = $exceptionProperty.Value | ConvertTo-Json -Depth 10 -Compress
        throw "WebView expression failed: $exceptionJson"
    }
    $remoteObjectProperty = $result.PSObject.Properties['result']
    if ($null -eq $remoteObjectProperty) {
        throw 'WebView expression returned no remote object'
    }
    $valueProperty = $remoteObjectProperty.Value.PSObject.Properties['value']
    if ($null -eq $valueProperty) { return $null }
    return $valueProperty.Value
}

function Connect-YoreBotWebView {
    param([int] $Port, [System.Diagnostics.Process] $Process)

    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $lastEndpointError = ''
    $firstSocketError = ''
    $lastTargetDiagnostic = ''
    do {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "YoreBot exited before WebView2 debugging became ready: $($Process.ExitCode)"
        }

        $targets = @()
        try {
            $targets = @(
                Invoke-RestMethod `
                    -Uri "http://127.0.0.1:$Port/json/list" `
                    -NoProxy `
                    -TimeoutSec 3
            )
        } catch {
            $lastEndpointError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
            continue
        }

        $pageTargets = @($targets | Where-Object {
            $typeProperty = $_.PSObject.Properties['type']
            $socketProperty = $_.PSObject.Properties['webSocketDebuggerUrl']
            $null -ne $typeProperty -and
                $typeProperty.Value -eq 'page' -and
                $null -ne $socketProperty -and
                -not [string]::IsNullOrWhiteSpace($socketProperty.Value)
        })
        $lastTargetDiagnostic = "target_count=$($targets.Count) page_target_count=$($pageTargets.Count)"
        $target = $pageTargets | Select-Object -First 1
        if ($null -eq $target) {
            Start-Sleep -Milliseconds 500
            continue
        }

        try {
            $reportedUri = [Uri]($target.PSObject.Properties['webSocketDebuggerUrl'].Value)
            $addresses = @([System.Net.Dns]::GetHostAddresses($reportedUri.Host))
            if ($reportedUri.Scheme -ne 'ws' -or $reportedUri.Port -ne $Port -or
                -not [string]::IsNullOrEmpty($reportedUri.UserInfo) -or
                -not [string]::IsNullOrEmpty($reportedUri.Query) -or
                -not [string]::IsNullOrEmpty($reportedUri.Fragment) -or
                $reportedUri.AbsolutePath -notmatch '^/devtools/page/[^/?#]+$' -or
                $addresses.Count -eq 0 -or @(
                    $addresses | Where-Object {
                        -not [System.Net.IPAddress]::IsLoopback($_)
                    }
                ).Count -ne 0) {
                throw 'WebView2 debugging endpoint is not loopback-only'
            }
            $lastTargetDiagnostic = "$lastTargetDiagnostic reported_host=$($reportedUri.Host) reported_port=$($reportedUri.Port) reported_path=$($reportedUri.AbsolutePath)"
            $uriBuilder = [System.UriBuilder]::new($reportedUri)
            $uriBuilder.Host = '127.0.0.1'
            $uriBuilder.Port = $Port
            $uri = $uriBuilder.Uri
        } catch {
            $lastEndpointError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
            continue
        }

        $socket = [System.Net.WebSockets.ClientWebSocket]::new()
        try {
            $socket.ConnectAsync(
                $uri,
                [System.Threading.CancellationToken]::None
            ).GetAwaiter().GetResult()
            return $socket
        } catch {
            $socketError = $_.Exception.ToString()
            if ([string]::IsNullOrWhiteSpace($firstSocketError)) {
                $firstSocketError = $socketError
            }
            $lastEndpointError = $_.Exception.Message
            $socket.Dispose()
            Start-Sleep -Milliseconds 500
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not [string]::IsNullOrWhiteSpace($firstSocketError)) {
        if ($firstSocketError.Length -gt 600) {
            $firstSocketError = $firstSocketError.Substring(0, 600)
        }
        Write-Host "WebView2 first WebSocket diagnostic: $firstSocketError"
    }
    if (-not [string]::IsNullOrWhiteSpace($lastEndpointError)) {
        if ($lastEndpointError.Length -gt 600) {
            $lastEndpointError = $lastEndpointError.Substring(0, 600)
        }
        Write-Host "WebView2 endpoint diagnostic: $lastEndpointError"
    }
    if (-not [string]::IsNullOrWhiteSpace($lastTargetDiagnostic)) {
        if ($lastTargetDiagnostic.Length -gt 600) {
            $lastTargetDiagnostic = $lastTargetDiagnostic.Substring(0, 600)
        }
        Write-Host "WebView2 target diagnostic: $lastTargetDiagnostic"
    }
    Write-WebViewDiagnostics -Port $Port -Process $Process
    throw 'YoreBot WebView2 debugging endpoint did not become ready'
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer does not exist: $installer"
}
if (Test-Path -LiteralPath $workRootFull) {
    throw "Acceptance root must be fresh: $workRootFull"
}
if (Test-Path -LiteralPath $uninstallKey) {
    throw 'A YoreBot uninstall registration already exists; use a fresh Windows runner'
}
foreach ($path in @($dataRoot, $configRoot, $webViewRoot)) {
    if (Test-Path -LiteralPath $path) {
        throw "YoreBot first-use data already exists; use a fresh Windows runner: $path"
    }
}
if ($installRoot -match '\s') {
    throw 'NSIS smoke work path must not contain whitespace because /D must be the final raw argument'
}
foreach ($value in @(
    $modelId,
    $modelRevision,
    'sizeBytes: 5_680_522_464',
    $modelSha256
)) {
    if (-not $modelSource.Contains($value)) {
        throw "The ordinary product model manifest changed: $value"
    }
}

try {
    New-Item -ItemType Directory -Path $workRootFull | Out-Null
    $createdWorkRoot = $true

    # The manual-only installer embeds this loopback debugging port through a
    # temporary Tauri build overlay. Fail before install if it is unavailable.
    Assert-LoopbackPortAvailable -Port $cdpPort

    $install = Start-Process -FilePath $installer -ArgumentList @(
        '/S', "/D=$installRoot"
    ) -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
    $installed = $true
    foreach ($required in @($appPath, $uninstallerPath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Installer did not create required file: $required"
        }
    }
    if (-not (Test-Path -LiteralPath $uninstallKey)) {
        throw 'YoreBot uninstall registration is missing'
    }

    # Do not attach to an optional installer auto-launch: terminate only the
    # exact installed executable and launch one owned process with loopback CDP.
    Stop-ExactProcesses -Path $appPath
    $appStdoutPath = Join-Path $workRootFull 'YoreBot.stdout.log'
    $appStderrPath = Join-Path $workRootFull 'YoreBot.stderr.log'
    $appProcess = Start-Process `
        -FilePath $appPath `
        -WorkingDirectory $installRoot `
        -RedirectStandardOutput $appStdoutPath `
        -RedirectStandardError $appStderrPath `
        -PassThru
    Start-Sleep -Seconds 8
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
        throw "YoreBot exited during first-use startup: $($appProcess.ExitCode)"
    }
    $liveApp = Get-Process -Id $appProcess.Id -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath($liveApp.Path) -ine $appPath) {
        throw 'Observed YoreBot process did not run from the installed path'
    }

    $script:CdpCommandId = 0
    $cdpSocket = Connect-YoreBotWebView -Port $cdpPort -Process $appProcess
    Invoke-CdpCommand -Socket $cdpSocket -Method 'Runtime.enable' | Out-Null

    $setupObserved = $false
    $chatReady = $false
    $setupDeadline = [DateTime]::UtcNow.AddMinutes(35)
    do {
        $appProcess.Refresh()
        if ($appProcess.HasExited) {
            throw "YoreBot exited during automatic setup: $($appProcess.ExitCode)"
        }
        $stateJson = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
JSON.stringify((() => {
  const setup = document.querySelector('[aria-label="YoreBot setup"]');
  const chat = document.querySelector('[data-testid="chat-input"]');
  return {
    setup: Boolean(setup),
    phase: setup?.getAttribute('data-setup-phase') ?? '',
    choices: setup?.querySelectorAll('select,[role="listbox"],input[type="radio"]').length ?? 0,
    text: (setup?.innerText ?? '').slice(0, 1200),
    chat: Boolean(chat),
  };
})())
'@
        $state = $stateJson | ConvertFrom-Json
        if ($state.setup) {
            $setupObserved = $true
            if ([int]$state.choices -ne 0) {
                throw 'Automatic setup exposed a model, runtime, or hardware choice'
            }
            if ($state.phase -in @('unsupported', 'error')) {
                throw "Automatic setup failed closed: phase=$($state.phase) text=$($state.text)"
            }
        }
        if ($state.chat) {
            $chatReady = $true
            break
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $setupDeadline)
    if (-not $setupObserved) { throw 'The installed app never rendered automatic setup' }
    if (-not $chatReady) { throw 'Automatic setup did not reach Chat before the deadline' }

    $localStateJson = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
JSON.stringify({
  setup: localStorage.getItem('setup-completed'),
  model: localStorage.getItem('yorebot-pinned-model'),
  last: localStorage.getItem('last-used-model'),
})
'@
    $localState = $localStateJson | ConvertFrom-Json
    if ($localState.setup -ne 'true' -or $localState.model -ne $modelId) {
        throw "Automatic setup recorded unexpected state: $localStateJson"
    }
    $lastModel = $localState.last | ConvertFrom-Json
    if ($lastModel.provider -ne 'llamacpp-upstream' -or $lastModel.model -ne $modelId) {
        throw "Automatic setup recorded an unexpected provider/model: $($localState.last)"
    }

    $modelDir = Join-Path $dataRoot "llamacpp/models/$modelId"
    $modelPath = Join-Path $modelDir 'model.gguf'
    $modelConfig = Join-Path $modelDir 'model.yml'
    foreach ($required in @($modelPath, $modelConfig)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "Automatic setup did not install the exact model artifact: $required"
        }
    }
    if ((Get-Item -LiteralPath $modelPath).Length -ne $modelSize) {
        throw 'Installed model size does not match the exact product pin'
    }
    $actualModelHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualModelHash -ne $modelSha256) {
        throw 'Installed model SHA-256 does not match the exact product pin'
    }
    $config = Get-Content -LiteralPath $modelConfig -Raw
    foreach ($value in @($modelId, "$modelSize", $modelSha256)) {
        if (-not $config.Contains($value)) {
            throw "Installed model configuration omits exact pin evidence: $value"
        }
    }

    $startupOutput = @($appStdoutPath, $appStderrPath) |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        ForEach-Object { Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue }
    $backendReady = 'Bundled llama.cpp backend ready during startup: b10431/win-cpu-x64'
    if (($startupOutput -join "`n") -notlike "*$backendReady*") {
        throw "YoreBot did not report its exact bundled backend ready: $backendReady"
    }

    $servers = @(Get-ProcessesUnderRoot -Name 'llama-server' -Root $dataRoot)
    if ($servers.Count -ne 1) {
        throw "Expected one YoreBot llama-server process, found $($servers.Count)"
    }
    $serverProcess = $servers[0]
    $serverPath = [System.IO.Path]::GetFullPath($serverProcess.Path)
    $activeRuntimeRoots = @(
        (Join-Path $dataRoot 'llamacpp-upstream/backends/b10431/win-cpu-x64'),
        (Join-Path $dataRoot 'llamacpp-upstream/backends/b10431/win-vulkan-x64')
    )
    if (-not @(
        $activeRuntimeRoots | Where-Object {
            Test-EqualOrChild -Candidate $serverPath -Root $_
        }
    )) {
        throw "Active Chat runtime is outside the exact pinned b10431 roots: $serverPath"
    }
    $listeners = @(Get-NetTCPConnection -OwningProcess $serverProcess.Id -State Listen)
    if ($listeners.Count -eq 0 -or @(
        $listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' }
    ).Count -ne 0) {
        throw 'Installed llama-server must listen only on 127.0.0.1'
    }
    Push-Location (Split-Path $serverPath)
    try {
        $serverVersionOutput = (& $serverPath --version 2>&1 | Out-String).Trim()
        $serverVersionExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($serverVersionExitCode -ne 0 -or
        $serverVersionOutput -notmatch '(?m)(?:version:\s+b?10431(?:-|\s)|\(build\s+10431,)') {
        throw "Active Chat runtime did not report exact build 10431: exit=$serverVersionExitCode output=$serverVersionOutput"
    }
    New-NetFirewallRule `
        -DisplayName $firewallRuleName `
        -Direction Outbound `
        -Action Block `
        -Program $serverPath `
        -Profile Any | Out-Null
    $firewallRule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction Stop
    if ($firewallRule.Enabled.ToString() -ne 'True' -or
        $firewallRule.Direction.ToString() -ne 'Outbound' -or
        $firewallRule.Action.ToString() -ne 'Block') {
        throw 'Outbound firewall rule is not active for the exact Chat runtime'
    }

    $baselineReplyValue = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
document.querySelectorAll('[aria-label="YoreBot response"]').length
'@
    $baselineReplyCount = [int]$baselineReplyValue

    $promptValue = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
(() => {
  const input = document.querySelector('[data-testid="chat-input"]');
  if (!(input instanceof HTMLTextAreaElement)) return '';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, 'Reply with exactly YOREBOT_CHAT_OK.');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()
'@
    if ($promptValue -ne 'Reply with exactly YOREBOT_CHAT_OK.') {
        throw 'The actual Chat input did not accept the tiny prompt'
    }
    $sendReadyDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $sendReady = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
(() => {
  const button = document.querySelector('[aria-label="Send message"]');
  return button instanceof HTMLButtonElement && !button.disabled;
})()
'@
        if ($sendReady) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $sendReadyDeadline)
    if (-not $sendReady) { throw 'The actual Chat send control did not become ready' }
    $clicked = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
(() => {
  const button = document.querySelector('[aria-label="Send message"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()
'@
    if (-not $clicked) { throw 'The actual Chat send control could not be invoked' }

    $userMessageObserved = $false
    $userMessageDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $userMessageObserved = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
[...document.querySelectorAll('[aria-label="Your message"]')]
  .some((message) => message.innerText.includes('Reply with exactly YOREBOT_CHAT_OK.'))
'@
        if ($userMessageObserved) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $userMessageDeadline)
    if (-not $userMessageObserved) {
        throw 'The tiny prompt did not render in the actual Chat UI'
    }

    $chatCompleted = $false
    $replyDeadline = [DateTime]::UtcNow.AddMinutes(15)
    do {
        $appProcess.Refresh()
        $serverProcess.Refresh()
        if ($appProcess.HasExited -or $serverProcess.HasExited) {
            throw 'YoreBot or its exact local model exited while answering Chat'
        }
        $chatStateExpression = @"
(() => {
  const replies = [...document.querySelectorAll('[aria-label="YoreBot response"]')];
  const reply = replies.length > $baselineReplyCount
    ? (replies.at(-1)?.innerText ?? '')
    : '';
  return JSON.stringify({
    marker: reply.includes('YOREBOT_CHAT_OK'),
    complete: document.querySelector('[aria-label="Send message"]') instanceof HTMLButtonElement,
    error: Boolean(document.querySelector('[aria-label="Chat generation error"]')?.innerText.trim()),
  });
})()
"@
        $chatStateJson = Invoke-CdpExpression `
            -Socket $cdpSocket `
            -Expression $chatStateExpression
        $chatState = $chatStateJson | ConvertFrom-Json
        if ($chatState.error) {
            throw 'Actual Chat UI reported an error after the local response began'
        }
        if ($chatState.marker -and $chatState.complete) {
            $chatCompleted = $true
            break
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $replyDeadline)
    if (-not $chatCompleted) {
        throw 'Actual Chat UI did not complete with the expected local response marker'
    }

    $cdpSocket.Dispose()
    $cdpSocket = $null
    Stop-ExactProcesses -Path $appPath

    New-Item -ItemType Directory -Path $installSibling, $dataSibling -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $installSibling 'keep.txt') -Value 'keep' -NoNewline
    Set-Content -LiteralPath (Join-Path $dataSibling 'keep.txt') -Value 'keep' -NoNewline
    Start-SiblingSentinel -Directory $installSibling -Name 'llama-server'
    Start-SiblingSentinel -Directory $dataSibling -Name 'bun'
    Start-SiblingSentinel -Directory $dataSibling -Name 'uv'

    $uninstall = Start-Process -FilePath $uninstallerPath -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
    $installed = $false
    if (Test-Path -LiteralPath $installRoot) {
        throw "Uninstaller left the install root behind: $installRoot"
    }
    if (Test-Path -LiteralPath $uninstallKey) {
        throw 'Uninstaller left YoreBot registered'
    }
    $serverExitDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $serverExitDeadline)
    if (-not $serverProcess.HasExited -or
        @(Get-ProcessesUnderRoot -Name 'llama-server' -Root $dataRoot).Count -ne 0) {
        throw 'YoreBot llama-server survived uninstall'
    }
    foreach ($marker in @(
        (Join-Path $installSibling 'keep.txt'),
        (Join-Path $dataSibling 'keep.txt')
    )) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
            throw "Uninstaller touched sibling sentinel: $marker"
        }
    }
    foreach ($sentinel in $ownedSentinels) {
        if ($sentinel.HasExited) {
            throw "Uninstaller terminated sibling sentinel PID $($sentinel.Id)"
        }
    }

    $passed = $true
    Write-Host "YoreBot installed first-use Chat acceptance passed: model_id=$modelId model_revision=$modelRevision model_size_bytes=$modelSize model_sha256=$modelSha256 bundled_runtime=b10431/win-cpu-x64 active_runtime_build=10431 response_marker=present result=pass"
} catch {
    if ($null -ne $appProcess) {
        Write-FirstUseDiagnostics -StdoutPath $appStdoutPath -StderrPath $appStderrPath
    }
    throw
} finally {
    if ($null -ne $cdpSocket) { $cdpSocket.Dispose() }
    Stop-ExactProcesses -Path $appPath
    Stop-ProcessesUnderRoot -Name 'llama-server' -Root $dataRoot
    foreach ($sentinel in $ownedSentinels) {
        if (-not $sentinel.HasExited) {
            Stop-Process -Id $sentinel.Id -Force -ErrorAction SilentlyContinue
            $sentinel.WaitForExit(15000) | Out-Null
        }
    }
    if ($installed -and (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        Start-Process -FilePath $uninstallerPath -ArgumentList '/S' -Wait | Out-Null
    }
    Remove-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
    if ($createdWorkRoot -and (Test-Path -LiteralPath $workRootFull)) {
        Remove-Item -LiteralPath $workRootFull -Recurse -Force
    }
    if (Test-Path -LiteralPath $dataSibling) {
        Remove-Item -LiteralPath $dataSibling -Recurse -Force
    }
    if (-not $passed) {
        Write-Host 'YoreBot installed first-use Chat acceptance failed.'
    }
}
