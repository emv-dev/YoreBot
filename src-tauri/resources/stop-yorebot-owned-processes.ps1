#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $InstallRoot,

    [Parameter(Mandatory)]
    [string] $DataRoot,

    [Parameter(Mandatory)]
    [string] $MainExecutable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class YoreBotProcessImage
{
    private const uint ProcessQueryLimitedInformation = 0x1000;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(
        uint desiredAccess,
        bool inheritHandle,
        int processId
    );

    [DllImport(
        "kernel32.dll",
        EntryPoint = "QueryFullProcessImageNameW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(
        IntPtr process,
        uint flags,
        StringBuilder executablePath,
        ref int size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    public static string GetPath(int processId)
    {
        IntPtr process = OpenProcess(
            ProcessQueryLimitedInformation,
            false,
            processId
        );
        if (process == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            var path = new StringBuilder(32768);
            int size = path.Capacity;
            return QueryFullProcessImageName(process, 0, path, ref size)
                ? path.ToString()
                : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }
}
'@

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

    return [YoreBotProcessImage]::GetPath($Process.Id)
}

$install = Resolve-ScopedRoot -Path $InstallRoot
$data = Resolve-ScopedRoot -Path $DataRoot
$mainExecutable = [System.IO.Path]::GetFullPath($MainExecutable)
if (-not (Test-EqualOrChild -Candidate $mainExecutable -Root $install)) {
    throw 'Main executable must be inside the exact install root'
}
$mainProcessName = [System.IO.Path]::GetFileNameWithoutExtension($mainExecutable)
if ([string]::IsNullOrWhiteSpace($mainProcessName)) {
    throw 'Main executable has no process name'
}

function Get-YoreBotMainProcesses {
    return @(
        Get-Process -Name $mainProcessName -ErrorAction SilentlyContinue |
            Where-Object {
                $path = Get-ExecutablePath -Process $_
                $null -ne $path -and
                    [System.IO.Path]::GetFullPath($path) -ieq $mainExecutable
            }
    )
}

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

function Stop-ProcessSet {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [System.Diagnostics.Process[]] $Processes,
        [Parameter(Mandatory)] [string] $Kind
    )

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    foreach ($process in $Processes) {
        try {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
        } catch {
            if ($null -ne (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) {
                throw "Could not stop YoreBot $Kind PID $($process.Id)"
            }
        }
    }

    foreach ($process in $Processes) {
        $remainingMilliseconds = [Math]::Max(
            0,
            [int] ($deadline - [DateTime]::UtcNow).TotalMilliseconds
        )
        if (-not $process.WaitForExit($remainingMilliseconds)) {
            throw "YoreBot $Kind PID $($process.Id) did not exit"
        }
    }
}

$mainVictims = @(Get-YoreBotMainProcesses)
Stop-ProcessSet -Processes $mainVictims -Kind 'main process'
$remainingMain = @(Get-YoreBotMainProcesses)
if ($remainingMain.Count -ne 0) {
    throw "YoreBot still owns $($remainingMain.Count) main process(es)"
}

$helperVictims = @(Get-YoreBotOwnedProcesses)
Stop-ProcessSet -Processes $helperVictims -Kind 'helper'
$remainingHelpers = @(Get-YoreBotOwnedProcesses)
if ($remainingHelpers.Count -ne 0) {
    throw "YoreBot still owns $($remainingHelpers.Count) helper process(es)"
}

Write-Output "YoreBot cleanup complete: engine_bits=$([IntPtr]::Size * 8) main_stopped=$($mainVictims.Count) helpers_stopped=$($helperVictims.Count) remaining=0"
