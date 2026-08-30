#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $InstallRoot,

    [Parameter(Mandatory)]
    [string] $DataRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ScopedRoot {
    param([Parameter(Mandatory)] [string] $Path)

    $canonical = [System.IO.Path]::GetFullPath($Path).TrimEnd([char]92)
    $volumeRoot = [System.IO.Path]::GetPathRoot($canonical).TrimEnd([char]92)
    if ([string]::IsNullOrWhiteSpace($canonical) -or $canonical -ieq $volumeRoot) {
        throw 'Refusing an empty or volume-wide process root'
    }
    return $canonical
}

function Test-EqualOrChild {
    param(
        [Parameter(Mandatory)] [string] $Candidate,
        [Parameter(Mandatory)] [string] $Root
    )

    $canonicalCandidate = [System.IO.Path]::GetFullPath($Candidate)
    return ($canonicalCandidate -ieq $Root) -or
        $canonicalCandidate.StartsWith(
            $Root + [char]92,
            [System.StringComparison]::OrdinalIgnoreCase
        )
}

function Get-ExecutablePath {
    param([Parameter(Mandatory)] [System.Diagnostics.Process] $Process)

    try {
        $pathProperty = $Process.PSObject.Properties['Path']
        if ($null -ne $pathProperty -and
            -not [string]::IsNullOrWhiteSpace([string] $pathProperty.Value)) {
            return [string] $pathProperty.Value
        }
        if ($null -ne $Process.MainModule -and
            -not [string]::IsNullOrWhiteSpace($Process.MainModule.FileName)) {
            return $Process.MainModule.FileName
        }
    } catch {
        return $null
    }
    return $null
}

$install = Resolve-ScopedRoot -Path $InstallRoot
$data = Resolve-ScopedRoot -Path $DataRoot

function Get-YoreBotOwnedProcesses {
    return @(
        Get-Process -Name llama-server,bun,uv -ErrorAction SilentlyContinue |
            Where-Object {
                $path = Get-ExecutablePath -Process $_
                $null -ne $path -and (
                    (Test-EqualOrChild -Candidate $path -Root $install) -or
                    (Test-EqualOrChild -Candidate $path -Root $data)
                )
            }
    )
}

$victims = @(Get-YoreBotOwnedProcesses)
foreach ($process in $victims) {
    try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
    } catch {
        if ($null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
            throw "Could not stop YoreBot helper PID $($process.Id)"
        }
    }
    if (-not $process.WaitForExit(15000)) {
        throw "YoreBot helper PID $($process.Id) did not exit"
    }
}

$remaining = @(Get-YoreBotOwnedProcesses)
if ($remaining.Count -ne 0) {
    throw "YoreBot still owns $($remaining.Count) helper process(es)"
}

Write-Output "Stopped $($victims.Count) YoreBot helper process(es)."
