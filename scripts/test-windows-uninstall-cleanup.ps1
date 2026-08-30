#Requires -Version 7.2

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$projectRoot = Split-Path $PSScriptRoot
$cleanupScript = Join-Path $projectRoot 'src-tauri/windows/stop-yorebot-owned-processes.ps1'
$fixtureRoot = Join-Path $env:RUNNER_TEMP "yorebot-uninstall-cleanup-$([guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $fixtureRoot 'YoreBot'
$dataRoot = Join-Path $fixtureRoot 'Roaming/YoreBot'
$installSibling = Join-Path $fixtureRoot 'YoreBotTools'
$dataSibling = Join-Path $fixtureRoot 'Roaming/YoreBotBackup'
$unrelatedRoot = Join-Path $fixtureRoot 'OtherApp'
$owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$protected = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Start-Sentinel {
    param(
        [Parameter(Mandatory)] [string] $Directory,
        [Parameter(Mandatory)] [string] $Name
    )

    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $path = Join-Path $Directory "$Name.exe"
    Copy-Item -LiteralPath $env:ComSpec -Destination $path
    $process = Start-Process -FilePath $path -ArgumentList @(
        '/d', '/q', '/c', 'ping.exe -n 600 127.0.0.1 > nul'
    ) -PassThru
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "$Name sentinel exited early" }
    $live = Get-Process -Id $process.Id -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath($live.Path) -ine [System.IO.Path]::GetFullPath($path)) {
        throw "$Name sentinel did not start from its exact fixture path"
    }
    return $process
}

try {
    $owned.Add((Start-Sentinel -Directory $dataRoot -Name 'llama-server'))
    $owned.Add((Start-Sentinel -Directory $installRoot -Name 'bun'))
    $owned.Add((Start-Sentinel -Directory (Join-Path $installRoot 'resources') -Name 'uv'))

    $protected.Add((Start-Sentinel -Directory $installSibling -Name 'llama-server'))
    $protected.Add((Start-Sentinel -Directory $dataSibling -Name 'bun'))
    $protected.Add((Start-Sentinel -Directory $unrelatedRoot -Name 'uv'))

    & $cleanupScript -InstallRoot $installRoot -DataRoot $dataRoot

    foreach ($process in $owned) {
        $process.Refresh()
        if (-not $process.HasExited) {
            throw "Owned helper survived uninstall cleanup: PID $($process.Id)"
        }
    }

    # Model an upgrade from a version whose uninstaller left its backend alive.
    $upgradeOrphan = Start-Sentinel -Directory $dataRoot -Name 'llama-server'
    $owned.Add($upgradeOrphan)
    & $cleanupScript -InstallRoot $installRoot -DataRoot $dataRoot
    $upgradeOrphan.Refresh()
    if (-not $upgradeOrphan.HasExited) {
        throw "Older-version orphan survived reinstall cleanup: PID $($upgradeOrphan.Id)"
    }

    foreach ($process in $protected) {
        $process.Refresh()
        if ($process.HasExited) {
            throw "Cleanup terminated a sibling or unrelated helper: PID $($process.Id)"
        }
    }

    Write-Host 'YoreBot scoped uninstall cleanup regression passed.'
} finally {
    foreach ($process in @($owned) + @($protected)) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            $process.WaitForExit(15000) | Out-Null
        }
    }
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
