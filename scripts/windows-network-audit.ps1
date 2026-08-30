#Requires -Version 7.2

Set-StrictMode -Version Latest

$script:YoreBotWfpConnectionAuditGuid = '{0CCE9226-69AE-11D9-BED3-505054503030}'
$script:YoreBotNonLoopbackRemoteAddresses = @(
    '0.0.0.0-126.255.255.255',
    '128.0.0.0-255.255.255.255',
    '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'
)

if ($null -eq ([System.Management.Automation.PSTypeName]'YoreBotNetworkAuditNativeMethods').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class YoreBotNetworkAuditNativeMethods
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint QueryDosDeviceW(
        string lpDeviceName,
        StringBuilder lpTargetPath,
        int ucchMax
    );
}
'@ | Out-Null
}

function Get-YoreBotLatestSecurityRecordId {
    $latest = Get-WinEvent -LogName Security -MaxEvents 1 -ErrorAction Stop
    if ($null -eq $latest) { return [int64]0 }
    return [int64]$latest.RecordId
}

function ConvertTo-YoreBotDevicePath {
    param([Parameter(Mandatory)][string] $Path)

    $canonicalPath = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($canonicalPath)
    if ([string]::IsNullOrWhiteSpace($root) -or $root.Length -lt 2 -or $root[1] -ne ':') {
        throw "Network audit requires a local drive path: $canonicalPath"
    }
    $drive = $root.Substring(0, 2)
    $buffer = [System.Text.StringBuilder]::new(32768)
    $length = [YoreBotNetworkAuditNativeMethods]::QueryDosDeviceW(
        $drive,
        $buffer,
        $buffer.Capacity
    )
    if ($length -eq 0) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "QueryDosDeviceW failed for $drive with Win32 error $errorCode"
    }
    $deviceRoot = $buffer.ToString().Split([char]0)[0].TrimEnd([char]92)
    return $deviceRoot + $canonicalPath.Substring(2)
}

function Test-YoreBotLoopbackAddress {
    param([string] $Address)

    [System.Net.IPAddress] $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) {
        return $false
    }
    return [System.Net.IPAddress]::IsLoopback($parsed)
}

function ConvertFrom-YoreBotWfpEvent {
    param([Parameter(Mandatory)] $Event)

    [xml]$xml = $Event.ToXml()
    $fields = @{}
    foreach ($node in @($xml.Event.EventData.Data)) {
        $fields[[string]$node.GetAttribute('Name')] = [string]$node.InnerText
    }
    [int64]$processId = 0
    [void][int64]::TryParse([string]$fields['ProcessID'], [ref]$processId)
    return [pscustomobject]@{
        RecordId = [int64]$Event.RecordId
        EventId = [int]$Event.Id
        ProcessId = $processId
        Application = [string]$fields['Application']
        Direction = [string]$fields['Direction']
        DestAddress = [string]$fields['DestAddress']
        DestPort = [string]$fields['DestPort']
        Protocol = [string]$fields['Protocol']
    }
}

function Get-YoreBotWfpEvents {
    param([Parameter(Mandatory)] $State)

    try {
        $events = @(
            Get-WinEvent -FilterHashtable @{
                LogName = 'Security'
                Id = 5157
                StartTime = $State.StartedAt.AddSeconds(-1)
            } -ErrorAction Stop |
                Where-Object { [int64]$_.RecordId -gt [int64]$State.BaselineRecordId } |
                Sort-Object RecordId
        )
    } catch [System.Exception] {
        if ($_.Exception.Message -like '*No events were found*') { return @() }
        throw
    }
    return @($events | ForEach-Object { ConvertFrom-YoreBotWfpEvent -Event $_ })
}

function Format-YoreBotWfpEvent {
    param([Parameter(Mandatory)] $Event, [string] $Role = '<unknown>')

    $application = [string]$Event.Application
    if ($application.Length -gt 260) { $application = $application.Substring(0, 260) }
    return "event=$($Event.EventId) record=$($Event.RecordId) role=$Role pid=$($Event.ProcessId) destination=$($Event.DestAddress):$($Event.DestPort) protocol=$($Event.Protocol) application=$application"
}

function Add-YoreBotNetworkAuditProgram {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Role
    )

    if (-not $State.Active) { throw 'Network audit is not active' }
    $canonicalPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
        throw "Network-audited executable does not exist: $canonicalPath"
    }
    $existing = @($State.Programs | Where-Object { $_.Path -ieq $canonicalPath })
    if ($existing.Count -gt 0) { return $existing[0] }

    $ruleName = "$($State.RulePrefix) $Role $([guid]::NewGuid().ToString('N'))"
    New-NetFirewallRule `
        -DisplayName $ruleName `
        -Direction Outbound `
        -Action Block `
        -Program $canonicalPath `
        -RemoteAddress $script:YoreBotNonLoopbackRemoteAddresses `
        -Profile Any `
        -PolicyStore ActiveStore | Out-Null
    $State.RuleNames.Add($ruleName)

    $rule = Get-NetFirewallRule `
        -DisplayName $ruleName `
        -PolicyStore ActiveStore `
        -ErrorAction Stop
    $application = Get-NetFirewallApplicationFilter `
        -AssociatedNetFirewallRule $rule `
        -ErrorAction Stop
    $addresses = Get-NetFirewallAddressFilter `
        -AssociatedNetFirewallRule $rule `
        -ErrorAction Stop
    if ($rule.Enabled.ToString() -ne 'True' -or
        $rule.Direction.ToString() -ne 'Outbound' -or
        $rule.Action.ToString() -ne 'Block' -or
        [System.IO.Path]::GetFullPath([string]$application.Program) -ine $canonicalPath) {
        throw "Network-audit firewall rule is not exact for $Role"
    }
    $actualRemoteAddresses = @($addresses.RemoteAddress | ForEach-Object { [string]$_ })
    foreach ($expected in $script:YoreBotNonLoopbackRemoteAddresses) {
        if (-not @($actualRemoteAddresses | Where-Object { $_ -ieq $expected })) {
            throw "Network-audit firewall rule omits non-loopback range $expected"
        }
    }
    if ($actualRemoteAddresses.Count -ne $script:YoreBotNonLoopbackRemoteAddresses.Count) {
        throw "Network-audit firewall rule has an unexpected remote-address scope: $($actualRemoteAddresses -join ',')"
    }

    $program = [pscustomobject]@{
        Role = $Role
        Path = $canonicalPath
        DevicePath = ConvertTo-YoreBotDevicePath -Path $canonicalPath
        RuleName = $ruleName
    }
    $State.Programs.Add($program)
    return $program
}

function Add-YoreBotWatchedProcessRecord {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][int] $ProcessId,
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Role
    )

    $canonicalPath = [System.IO.Path]::GetFullPath($Path)
    if (-not @($State.Processes | Where-Object {
        $_.ProcessId -eq $ProcessId -and $_.Path -ieq $canonicalPath
    })) {
        $State.Processes.Add([pscustomobject]@{
            Role = $Role
            ProcessId = $ProcessId
            Path = $canonicalPath
            DevicePath = ConvertTo-YoreBotDevicePath -Path $canonicalPath
        })
    }
}

function Watch-YoreBotNetworkProcess {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][System.Diagnostics.Process] $Process,
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Role,
        [string] $DiagnosticContext = ''
    )

    $Process.Refresh()
    if ($Process.HasExited) { throw "Network-audited $Role process exited before observation" }
    $canonicalPath = [System.IO.Path]::GetFullPath($Path)
    $live = Get-Process -Id $Process.Id -ErrorAction Stop
    $livePath = [System.IO.Path]::GetFullPath($live.Path)
    if ($livePath -ine $canonicalPath) {
        throw "Network-audited $Role process path mismatch: $livePath"
    }
    if (-not @($State.Programs | Where-Object { $_.Path -ieq $canonicalPath })) {
        throw "Network-audited $Role process has no exact firewall rule"
    }
    $existing = @(
        Get-NetTCPConnection -OwningProcess $Process.Id -State Established -ErrorAction SilentlyContinue |
            Where-Object { -not (Test-YoreBotLoopbackAddress -Address $_.RemoteAddress) } |
            Select-Object -First 20
    )
    if ($existing.Count -gt 0) {
        $destinations = @($existing | ForEach-Object {
            "$($_.RemoteAddress):$($_.RemotePort)"
        }) -join ','
        $boundedContext = [regex]::Replace($DiagnosticContext, '[\x00-\x1f\x7f]', '?')
        if ($boundedContext.Length -gt 1200) {
            $boundedContext = $boundedContext.Substring(0, 1200)
        }
        $contextSuffix = if ([string]::IsNullOrWhiteSpace($boundedContext)) {
            ''
        } else {
            " context=[$boundedContext]"
        }
        throw "Network-audited $Role already has a non-loopback connection: pid=$($Process.Id) path=$canonicalPath destinations=[$destinations]$contextSuffix"
    }
    Add-YoreBotWatchedProcessRecord `
        -State $State `
        -ProcessId $Process.Id `
        -Path $canonicalPath `
        -Role $Role
}

function Remove-YoreBotNetworkAuditProgram {
    param([Parameter(Mandatory)] $State, [Parameter(Mandatory)] $Program)

    Remove-NetFirewallRule `
        -DisplayName $Program.RuleName `
        -PolicyStore ActiveStore `
        -ErrorAction Stop
    [void]$State.RuleNames.Remove([string]$Program.RuleName)
    [void]$State.Programs.Remove($Program)
}

function Start-YoreBotNetworkAudit {
    param(
        [Parameter(Mandatory)][string] $WorkRoot,
        [Parameter(Mandatory)][string] $Name
    )

    $canonicalRoot = [System.IO.Path]::GetFullPath($WorkRoot)
    if (-not (Test-Path -LiteralPath $canonicalRoot -PathType Container)) {
        throw "Network-audit work root does not exist: $canonicalRoot"
    }
    $backupPath = Join-Path $canonicalRoot "audit-policy-$([guid]::NewGuid().ToString('N')).csv"
    $state = [pscustomobject]@{
        Name = $Name
        RulePrefix = "YoreBot network audit $([guid]::NewGuid().ToString('N'))"
        WorkRoot = $canonicalRoot
        BackupPath = $backupPath
        StartedAt = [DateTime]::UtcNow
        BaselineRecordId = [int64]0
        RuleNames = [System.Collections.Generic.List[string]]::new()
        Programs = [System.Collections.Generic.List[object]]::new()
        Processes = [System.Collections.Generic.List[object]]::new()
        Active = $false
    }

    try {
        $backupOutput = (& auditpol.exe /backup "/file:$backupPath" 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
            throw "auditpol backup failed: $backupOutput"
        }
        # Once a restorable backup exists, cleanup owns policy restoration even
        # if enabling the one required failure subcategory reports an error.
        $state.Active = $true
        $state.StartedAt = [DateTime]::UtcNow
        $setOutput = (& auditpol.exe /set "/subcategory:$script:YoreBotWfpConnectionAuditGuid" /failure:enable 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "auditpol set failed: $setOutput" }
        $state.BaselineRecordId = Get-YoreBotLatestSecurityRecordId

        # Prove this runner records a blocked, process-attributed WFP event
        # before accepting a zero-event product result.
        $curlPath = Join-Path $env:SystemRoot 'System32/curl.exe'
        if (-not (Test-Path -LiteralPath $curlPath -PathType Leaf)) {
            throw "Windows system curl is missing: $curlPath"
        }
        $probePath = Join-Path $canonicalRoot "yorebot-wfp-probe-$([guid]::NewGuid().ToString('N')).exe"
        $probeErrorPath = "$probePath.stderr.log"
        Copy-Item -LiteralPath $curlPath -Destination $probePath
        $probeProgram = Add-YoreBotNetworkAuditProgram `
            -State $state `
            -Path $probePath `
            -Role 'audit-probe'
        $probe = Start-Process `
            -FilePath $probePath `
            -ArgumentList @(
                '--connect-timeout', '2',
                '--max-time', '3',
                '--noproxy', '*',
                '--silent',
                '--show-error',
                '--output', 'NUL',
                'http://192.0.2.1/'
            ) `
            -RedirectStandardError $probeErrorPath `
            -PassThru
        Add-YoreBotWatchedProcessRecord `
            -State $state `
            -ProcessId $probe.Id `
            -Path $probePath `
            -Role 'audit-probe'
        if (-not $probe.WaitForExit(10000)) {
            Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue
            throw 'WFP audit probe did not terminate'
        }

        $probeEvent = $null
        $probeDeadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $probeEvent = @(
                Get-YoreBotWfpEvents -State $state |
                    Where-Object {
                        $_.EventId -eq 5157 -and
                        $_.ProcessId -eq $probe.Id -and
                        $_.Direction -eq '%%14593' -and
                        $_.Application -ieq $probeProgram.DevicePath -and
                        -not (Test-YoreBotLoopbackAddress -Address $_.DestAddress)
                    } |
                    Select-Object -First 1
            )
            if ($probeEvent.Count -eq 1) { break }
            Start-Sleep -Milliseconds 250
        } while ([DateTime]::UtcNow -lt $probeDeadline)
        if ($probeEvent.Count -ne 1) {
            foreach ($event in @(Get-YoreBotWfpEvents -State $state | Select-Object -First 20)) {
                Write-Host "WFP probe diagnostic: $(Format-YoreBotWfpEvent -Event $event -Role 'audit-probe')"
            }
            throw 'Windows did not record the exact blocked WFP audit probe'
        }
        Remove-YoreBotNetworkAuditProgram -State $state -Program $probeProgram
        $state.Processes.Clear()
        $state.BaselineRecordId = Get-YoreBotLatestSecurityRecordId
        Remove-Item -LiteralPath $probePath, $probeErrorPath -Force -ErrorAction SilentlyContinue
        Write-Host 'Windows process-attributed WFP audit probe passed.'
        return $state
    } catch {
        if ($state.Active) {
            try { Stop-YoreBotNetworkAudit -State $state } catch {
                Write-Host "Network-audit restore diagnostic: $($_.Exception.Message)"
            }
        }
        throw
    }
}

function Assert-YoreBotNetworkAudit {
    param([Parameter(Mandatory)] $State)

    if (-not $State.Active) { throw 'Network audit ended before assertion' }
    if ($State.Programs.Count -eq 0 -or $State.Processes.Count -eq 0) {
        throw 'Network audit has no exact program/process attribution'
    }
    foreach ($program in $State.Programs) {
        if (-not @($State.Processes | Where-Object {
            $_.DevicePath -ieq $program.DevicePath
        })) {
            throw "Network-audited program has no observed exact-path process: $($program.Role)"
        }
    }
    Start-Sleep -Seconds 2
    $attempts = [System.Collections.Generic.List[object]]::new()
    foreach ($event in @(Get-YoreBotWfpEvents -State $State)) {
        if ($event.Direction -ne '%%14593' -or
            (Test-YoreBotLoopbackAddress -Address $event.DestAddress)) {
            continue
        }
        $program = @($State.Programs | Where-Object {
            $_.DevicePath -ieq $event.Application
        } | Select-Object -First 1)
        $process = @($State.Processes | Where-Object {
            $_.ProcessId -eq $event.ProcessId -and
                $_.DevicePath -ieq $event.Application
        } | Select-Object -First 1)
        if ($program.Count -eq 1) {
            $role = if ($process.Count -eq 1) { $process[0].Role } else { $program[0].Role }
            $attempts.Add([pscustomobject]@{ Event = $event; Role = $role })
        }
    }
    if ($attempts.Count -gt 0) {
        foreach ($attempt in @($attempts | Select-Object -First 20)) {
            Write-Host "Network-audit violation: $(Format-YoreBotWfpEvent -Event $attempt.Event -Role $attempt.Role)"
        }
        throw "Non-loopback network attempt detected for $($attempts.Count) audited event(s)"
    }
    Write-Host "YoreBot process-attributed network audit passed: programs=$($State.Programs.Count) processes=$($State.Processes.Count) non_loopback_attempts=0 result=pass"
}

function Stop-YoreBotNetworkAudit {
    param([Parameter(Mandatory)] $State)

    if (-not $State.Active) { return }
    $errors = [System.Collections.Generic.List[string]]::new()
    foreach ($ruleName in @($State.RuleNames)) {
        Remove-NetFirewallRule `
            -DisplayName $ruleName `
            -PolicyStore ActiveStore `
            -ErrorAction SilentlyContinue
    }
    $State.RuleNames.Clear()
    try {
        $remainingRules = @(
            Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop |
                Where-Object {
                    $_.DisplayName.StartsWith(
                        $State.RulePrefix + ' ',
                        [System.StringComparison]::Ordinal
                    )
                } |
                Select-Object -First 20
        )
        if ($remainingRules.Count -gt 0) {
            $errors.Add("$($remainingRules.Count) generated firewall rule(s) remain")
        }
    } catch {
        $errors.Add("firewall cleanup verification: $($_.Exception.Message)")
    }
    if (Test-Path -LiteralPath $State.BackupPath -PathType Leaf) {
        $restoreOutput = (& auditpol.exe /restore "/file:$($State.BackupPath)" 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            $errors.Add("auditpol restore: $restoreOutput")
        } else {
            Remove-Item -LiteralPath $State.BackupPath -Force -ErrorAction SilentlyContinue
        }
    } else {
        $errors.Add('audit policy backup disappeared before restore')
    }
    $State.Active = $false
    if ($errors.Count -gt 0) {
        throw "Network-audit cleanup failed: $($errors -join '; ')"
    }
}
