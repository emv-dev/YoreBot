#Requires -Version 7.2

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $InstallerPath,

    [Parameter(Mandatory)]
    [string] $WorkRoot,

    [string] $ExpectedSignerSubject = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
$firewallRuleName = "YoreBot installer smoke $([guid]::NewGuid())"
$ownedSentinels = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$createdWorkRoot = $false
$installed = $false

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

function Stop-ExactProcesses {
    param([string] $Path)

    foreach ($process in @(Get-ProcessesAtExactPath -Path $Path)) {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
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

function Write-LaunchDiagnostics {
    param(
        [datetime] $StartedAt,
        [System.Diagnostics.Process] $Process,
        [string] $StdoutPath,
        [string] $StderrPath
    )

    $Process.Refresh()
    $exitCode = if ($Process.HasExited) { $Process.ExitCode } else { 'still running' }
    Write-Host "YoreBot startup diagnostic exit code: $exitCode"

    foreach ($stream in @($StdoutPath, $StderrPath)) {
        if (Test-Path -LiteralPath $stream -PathType Leaf) {
            Write-Host "YoreBot process output: $stream"
            Get-Content -LiteralPath $stream -Tail 120 -ErrorAction SilentlyContinue
        }
    }

    $logRoot = Join-Path $env:APPDATA 'YoreBot/logs'
    if (Test-Path -LiteralPath $logRoot -PathType Container) {
        foreach ($log in @(
            Get-ChildItem -LiteralPath $logRoot -File -Recurse |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 3
        )) {
            Write-Host "YoreBot log tail: $($log.FullName)"
            Get-Content -LiteralPath $log.FullName -Tail 80 -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host "No YoreBot app log directory found at $logRoot"
    }

    try {
        $events = @(
            Get-WinEvent -FilterHashtable @{
                LogName = 'Application'
                StartTime = $StartedAt
            } -MaxEvents 100 -ErrorAction Stop |
                Where-Object {
                    $_.Level -eq 2 -and
                    $_.Message -match 'YoreBot|Atomic-Chat|WebView2'
                } |
                Select-Object -First 10
        )
        if ($events.Count -eq 0) {
            Write-Host 'No matching Windows Application error events found.'
        }
        foreach ($event in $events) {
            Write-Host "Windows Application error: $($event.TimeCreated) $($event.ProviderName)"
            Write-Host $event.Message
        }
    } catch {
        Write-Host "Could not read Windows Application events: $($_.Exception.Message)"
    }
}

function Assert-AuthenticodeSignature {
    param([Parameter(Mandatory)][string] $Path)

    if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject)) { return }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid') {
        throw "Authenticode signature is not valid for $Path (status: $($signature.Status))"
    }
    if ($null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -cne $ExpectedSignerSubject) {
        $actualSubject = if ($null -eq $signature.SignerCertificate) {
            '<missing>'
        } else {
            $signature.SignerCertificate.Subject
        }
        throw "Unexpected Authenticode signer for $Path (expected '$ExpectedSignerSubject', got '$actualSubject')"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Authenticode signature has no trusted timestamp for $Path"
    }
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
if ($installRoot -match '\s') {
    throw 'NSIS smoke work path must not contain whitespace because /D must be the final raw argument'
}
Assert-AuthenticodeSignature -Path $installer

try {
    New-Item -ItemType Directory -Path $workRootFull | Out-Null
    $createdWorkRoot = $true

    # The custom NSIS template launches the app after a silent install. Block
    # only that future executable so this lightweight smoke cannot download a
    # model or send application data while checking startup stability.
    New-NetFirewallRule `
        -DisplayName $firewallRuleName `
        -Direction Outbound `
        -Action Block `
        -Program $appPath `
        -Profile Any | Out-Null

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
    Assert-AuthenticodeSignature -Path $appPath
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.DisplayName -ne 'YoreBot' -or
        $registration.InstallLocation.Trim('"') -ine $installRoot) {
        throw 'YoreBot uninstall registration does not match the isolated install'
    }

    # Do not mistake the installer's optional auto-launch for the process under
    # test. Stop only that exact installed path, then observe one owned launch.
    Stop-ExactProcesses -Path $appPath
    $launchStartedAt = Get-Date
    $appStdoutPath = Join-Path $workRootFull 'YoreBot.stdout.log'
    $appStderrPath = Join-Path $workRootFull 'YoreBot.stderr.log'
    $launchedApp = Start-Process `
        -FilePath $appPath `
        -WorkingDirectory $installRoot `
        -RedirectStandardOutput $appStdoutPath `
        -RedirectStandardError $appStderrPath `
        -PassThru
    Start-Sleep -Seconds 8
    $launchedApp.Refresh()
    if ($launchedApp.HasExited) {
        Write-LaunchDiagnostics `
            -StartedAt $launchStartedAt `
            -Process $launchedApp `
            -StdoutPath $appStdoutPath `
            -StderrPath $appStderrPath
        throw "YoreBot exited during startup with exit code $($launchedApp.ExitCode)"
    }
    $liveApp = Get-Process -Id $launchedApp.Id -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath($liveApp.Path) -ine $appPath) {
        throw 'Observed YoreBot process did not run from the installed path'
    }
    $backendReady = 'Bundled llama.cpp backend ready during startup: b10431/win-cpu-x64'
    $backendReadyDeadline = (Get-Date).AddSeconds(60)
    $backendReadyObserved = $false
    do {
        $launchedApp.Refresh()
        if ($launchedApp.HasExited) {
            Write-LaunchDiagnostics `
                -StartedAt $launchStartedAt `
                -Process $launchedApp `
                -StdoutPath $appStdoutPath `
                -StderrPath $appStderrPath
            throw "YoreBot exited while waiting for its bundled backend with exit code $($launchedApp.ExitCode)"
        }
        $startupOutput = @($appStdoutPath, $appStderrPath) |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            ForEach-Object { Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue }
        if (($startupOutput -join "`n") -like "*$backendReady*") {
            $backendReadyObserved = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $backendReadyDeadline)
    if (-not $backendReadyObserved) {
        Write-LaunchDiagnostics `
            -StartedAt $launchStartedAt `
            -Process $launchedApp `
            -StdoutPath $appStdoutPath `
            -StderrPath $appStderrPath
        throw "YoreBot did not report its exact bundled backend ready: $backendReady"
    }

    New-Item -ItemType Directory -Path $installSibling, $dataSibling -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $installSibling 'keep.txt') -Value 'keep' -NoNewline -Force
    Set-Content -LiteralPath (Join-Path $dataSibling 'keep.txt') -Value 'keep' -NoNewline -Force
    Start-SiblingSentinel -Directory $installSibling -Name 'llama-server'
    Start-SiblingSentinel -Directory $dataSibling -Name 'bun'
    Start-SiblingSentinel -Directory $dataSibling -Name 'uv'

    # Stop only the app installed at this exact path; never stop by process name.
    Stop-ExactProcesses -Path $appPath
    if (@(Get-ProcessesAtExactPath -Path $appPath).Count -ne 0) {
        throw 'Installed YoreBot process did not stop before uninstall'
    }

    $uninstall = Start-Process -FilePath $uninstallerPath -ArgumentList '/S' -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
    $installed = $false

    if (Test-Path -LiteralPath $installRoot) {
        throw "Uninstaller left the install root behind: $installRoot"
    }
    if (Test-Path -LiteralPath $uninstallKey) {
        throw 'Uninstaller left YoreBot registered'
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

    Write-Host 'YoreBot NSIS install/start/uninstall smoke passed.'
} finally {
    Stop-ExactProcesses -Path $appPath
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
}
