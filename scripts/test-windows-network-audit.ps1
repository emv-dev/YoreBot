#Requires -Version 7.2

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

. (Join-Path $PSScriptRoot 'windows-network-audit.ps1')

$auditGuid = '{0CCE9226-69AE-11D9-BED3-505054503030}'
$workRoot = Join-Path $env:RUNNER_TEMP "yorebot-network-audit-$([guid]::NewGuid().ToString('N'))"
$audit = $null
$watchedProcess = $null
$beforePolicy = ''
$expectedFailure = $false

function Get-OpaqueAuditPolicy {
    $output = (& auditpol.exe /get "/subcategory:$auditGuid" /r 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Cannot read audit policy: $output" }
    return $output
}

try {
    New-Item -ItemType Directory -Path $workRoot | Out-Null
    foreach ($loopback in @('127.0.0.1', '127.255.255.255', '::1')) {
        if (-not (Test-YoreBotLoopbackAddress -Address $loopback)) {
            throw "Loopback boundary rejected $loopback"
        }
    }
    foreach ($nonLoopback in @('0.0.0.0', '126.255.255.255', '128.0.0.0', '192.0.2.1', '::2')) {
        if (Test-YoreBotLoopbackAddress -Address $nonLoopback) {
            throw "Non-loopback boundary accepted $nonLoopback"
        }
    }
    $beforePolicy = Get-OpaqueAuditPolicy
    $audit = Start-YoreBotNetworkAudit -WorkRoot $workRoot -Name 'YoreBot network regression'

    $watchedRoot = Join-Path $workRoot 'YoreBot'
    $siblingRoot = Join-Path $workRoot 'YoreBotTools'
    New-Item -ItemType Directory -Path $watchedRoot, $siblingRoot | Out-Null
    $curlPath = Join-Path $env:SystemRoot 'System32/curl.exe'
    if (-not (Test-Path -LiteralPath $curlPath -PathType Leaf)) {
        throw "Windows system curl is missing: $curlPath"
    }
    $watchedPath = Join-Path $watchedRoot 'agent-acceptance.exe'
    $siblingPath = Join-Path $siblingRoot 'agent-acceptance.exe'
    Copy-Item -LiteralPath $curlPath -Destination $watchedPath
    Copy-Item -LiteralPath $curlPath -Destination $siblingPath

    $program = Add-YoreBotNetworkAuditProgram `
        -State $audit `
        -Path $watchedPath `
        -Role 'agent-acceptance'
    $rule = Get-NetFirewallRule `
        -DisplayName $program.RuleName `
        -PolicyStore ActiveStore `
        -ErrorAction Stop
    $application = Get-NetFirewallApplicationFilter `
        -AssociatedNetFirewallRule $rule `
        -ErrorAction Stop
    if ([System.IO.Path]::GetFullPath([string]$application.Program) -ine $watchedPath -or
        [System.IO.Path]::GetFullPath([string]$application.Program) -ieq $siblingPath) {
        throw 'Network audit did not preserve the exact executable boundary'
    }

    $watchedStdout = Join-Path $workRoot 'watched.stdout.log'
    $watchedStderr = Join-Path $workRoot 'watched.stderr.log'
    $watchedProcess = Start-Process `
        -FilePath $watchedPath `
        -ArgumentList @(
            '--connect-timeout', '2',
            '--max-time', '10',
            '--retry', '5',
            '--retry-all-errors',
            '--retry-delay', '1',
            '--noproxy', '*',
            '--silent',
            '--show-error',
            'http://192.0.2.1/'
        ) `
        -RedirectStandardOutput $watchedStdout `
        -RedirectStandardError $watchedStderr `
        -PassThru
    Watch-YoreBotNetworkProcess `
        -State $audit `
        -Process $watchedProcess `
        -Path $watchedPath `
        -Role 'agent-acceptance'
    if (-not $watchedProcess.WaitForExit(15000)) {
        Stop-Process -Id $watchedProcess.Id -Force -ErrorAction SilentlyContinue
        throw 'Watched network regression process did not terminate'
    }

    try {
        Assert-YoreBotNetworkAudit -State $audit
    } catch {
        if (-not $_.Exception.Message.Contains('Non-loopback network attempt detected')) {
            throw
        }
        $expectedFailure = $true
        Write-Host 'Windows network audit caught expected non-loopback attempt.'
    }
    if (-not $expectedFailure) {
        throw 'Windows network audit accepted a non-loopback attempt'
    }
    if (-not (Test-Path -LiteralPath $siblingPath -PathType Leaf)) {
        throw 'Network audit touched a sibling executable'
    }
    # Simulate an external/idempotent cleanup before the shared finally path.
    Remove-NetFirewallRule `
        -DisplayName $program.RuleName `
        -PolicyStore ActiveStore `
        -ErrorAction Stop
} finally {
    if ($null -ne $watchedProcess -and -not $watchedProcess.HasExited) {
        Stop-Process -Id $watchedProcess.Id -Force -ErrorAction SilentlyContinue
        $watchedProcess.WaitForExit(10000) | Out-Null
    }
    if ($null -ne $audit) {
        Stop-YoreBotNetworkAudit -State $audit
        # Cleanup must remain safe after a rule disappeared or a caller retries.
        Stop-YoreBotNetworkAudit -State $audit
    }
    if (-not [string]::IsNullOrWhiteSpace($beforePolicy)) {
        $afterPolicy = Get-OpaqueAuditPolicy
        if ($afterPolicy -cne $beforePolicy) {
            throw 'Windows audit policy was not restored'
        }
    }
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
    }
}

Write-Host 'YoreBot Windows network-audit regression passed.'
