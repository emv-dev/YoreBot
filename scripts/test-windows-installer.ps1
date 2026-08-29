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
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.DisplayName -ne 'YoreBot' -or
        $registration.InstallLocation.Trim('"') -ine $installRoot) {
        throw 'YoreBot uninstall registration does not match the isolated install'
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $appProcesses = @(Get-ProcessesAtExactPath -Path $appPath)
        if ($appProcesses.Count -gt 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($appProcesses.Count -eq 0) {
        Start-Process -FilePath $appPath | Out-Null
        Start-Sleep -Seconds 2
        $appProcesses = @(Get-ProcessesAtExactPath -Path $appPath)
    }
    if ($appProcesses.Count -eq 0) { throw 'YoreBot did not remain running after install' }
    Start-Sleep -Seconds 8
    if (@(Get-ProcessesAtExactPath -Path $appPath).Count -eq 0) {
        throw 'YoreBot exited during the immediate-crash observation window'
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
