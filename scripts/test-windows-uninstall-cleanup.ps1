#Requires -Version 7.2

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$projectRoot = Split-Path $PSScriptRoot
$cleanupScript = Join-Path $projectRoot 'src-tauri/resources/stop-yorebot-owned-processes.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe'
$fixtureRoot = Join-Path $env:RUNNER_TEMP "yorebot-uninstall-cleanup-$([guid]::NewGuid().ToString('N'))"
$installRoot = Join-Path $fixtureRoot 'YoreBot'
$dataRoot = Join-Path $fixtureRoot 'Roaming/YoreBot'
$mainExecutable = Join-Path $installRoot 'Atomic-Chat.exe'
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
    $source = Join-Path $env:SystemRoot 'System32/ping.exe'
    Copy-Item -LiteralPath $source -Destination $path
    $process = Start-Process -FilePath $path -ArgumentList @(
        '-n', '600', '127.0.0.1'
    ) -PassThru
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw "$Name sentinel exited early" }
    $live = Get-Process -Id $process.Id -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath($live.Path) -ine [System.IO.Path]::GetFullPath($path)) {
        throw "$Name sentinel did not start from its exact fixture path"
    }
    return $process
}

function Invoke-Cleanup {
    param(
        [Parameter(Mandatory)] [int] $ExpectedMain,
        [Parameter(Mandatory)] [int] $ExpectedHelpers
    )

    $output = & $windowsPowerShell `
        -NoLogo `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $cleanupScript `
        -InstallRoot $installRoot `
        -DataRoot $dataRoot `
        -MainExecutable $mainExecutable 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Windows PowerShell cleanup exited $LASTEXITCODE`: $($output -join ' ')"
    }
    $expected = "engine_bits=32 main_stopped=$ExpectedMain helpers_stopped=$ExpectedHelpers remaining=0"
    if (-not ($output -join "`n").Contains($expected)) {
        throw "Windows PowerShell cleanup omitted its exact result: $expected"
    }
    $output | ForEach-Object { Write-Host $_ }
}

try {
    $owned.Add((Start-Sentinel -Directory $installRoot -Name 'Atomic-Chat'))
    $owned.Add((Start-Sentinel -Directory $dataRoot -Name 'llama-server'))
    $owned.Add((Start-Sentinel -Directory $installRoot -Name 'bun'))
    $owned.Add((Start-Sentinel -Directory (Join-Path $installRoot 'resources') -Name 'uv'))

    $protected.Add((Start-Sentinel -Directory $installSibling -Name 'llama-server'))
    $protected.Add((Start-Sentinel -Directory $installSibling -Name 'Atomic-Chat'))
    $protected.Add((Start-Sentinel -Directory $dataSibling -Name 'bun'))
    $protected.Add((Start-Sentinel -Directory $unrelatedRoot -Name 'uv'))

    Invoke-Cleanup -ExpectedMain 1 -ExpectedHelpers 3

    foreach ($process in $owned) {
        $process.Refresh()
        if (-not $process.HasExited) {
            throw "Owned helper survived uninstall cleanup: PID $($process.Id)"
        }
    }

    # Model an upgrade from a version whose uninstaller left its backend alive.
    $upgradeOrphan = Start-Sentinel -Directory $dataRoot -Name 'llama-server'
    $owned.Add($upgradeOrphan)
    Invoke-Cleanup -ExpectedMain 0 -ExpectedHelpers 1
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
