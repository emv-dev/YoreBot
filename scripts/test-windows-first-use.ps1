#Requires -Version 7.2

[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [string] $InstallerPath,

    [Parameter(Mandatory, ParameterSetName = 'Run')]
    [string] $WorkRoot,

    [Parameter(Mandatory, ParameterSetName = 'PlanContract')]
    [switch] $ValidateDownloadsPlanContractOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

function Assert-DownloadsPlanProposal {
    param([Parameter(Mandatory)][string] $Value)

    $normalized = [regex]::Replace($Value.Replace('\', '/'), '\s+', ' ').Trim()
    $semantic = [regex]::Replace(
        $normalized,
        '(?i)\bquarterly-report\.pdf\b',
        'quarterly-report_pdf'
    )
    $semantic = [regex]::Replace(
        $semantic,
        '(?i)\bmystery\.download\b',
        'mystery_download'
    )
    $negatesReportMove = [regex]::IsMatch(
        $semantic,
        '(?i)\b(?:not|never|don.t)\b[^.;!?]{0,30}\bmove(?:s|d|ing)?\b[^.;!?]{0,60}\bquarterly-report_pdf\b'
    ) -or [regex]::IsMatch(
        $semantic,
        '(?i)\bmove(?:s|d|ing)?\b[^.;!?]{0,60}\bquarterly-report_pdf\b[^.;!?]{0,30}\b(?:not|never|nowhere|don.t)\b'
    )
    $negatesUntouchedFile = [regex]::IsMatch(
        $semantic,
        '(?i)\b(?:not|never|don.t)\b[^.;!?]{0,30}\b(?:leave|keep)\b[^.;!?]{0,60}\bmystery_download\b'
    )
    $mysteryMoveScan = [regex]::Replace(
        $semantic,
        '(?i)\b(?:do\s+not|don.t|never|not)\s+move(?:s|d|ing)?\b[^.;!?]{0,60}\bmystery_download\b',
        ''
    )
    $proposesMysteryMove = [regex]::IsMatch(
        $mysteryMoveScan,
        '(?i)\bmove(?:s|d|ing)?\b[^.;!?]{0,60}\bmystery_download\b|\bmove\s+it\s+(?:also|later|too)\b'
    )
    if ($negatesReportMove -or $negatesUntouchedFile -or $proposesMysteryMove) {
        throw "Downloads plan contradicted the required proposal: $Value"
    }
    $movesSourceToDocuments = [regex]::IsMatch(
        $semantic,
        '(?i)\bmove(?:s|d|ing)?\b[^.;!?]{0,60}\bquarterly-report_pdf\b(?:\s+file)?\s+\b(?:to|into|under)\b\s+(?:the\s+)?\bDocuments\b(?:\s+folder)?(?:/quarterly-report_pdf)?'
    )
    $movesSourceByExactArrow = [regex]::IsMatch(
        $semantic,
        '(?i)\bmove(?:s|d|ing)?\b[^.;!?]{0,60}\bquarterly-report_pdf\b\s*(?:→|->)\s*\bDocuments/quarterly-report_pdf\b'
    )
    $createsDocumentsThenMovesThere = [regex]::IsMatch(
        $semantic,
        '(?i)\b(?:create|make)\b[^.;!?]{0,50}\bDocuments\b(?:\s+folder)?[^.;!?]{0,80}\bmove(?:s|d|ing)?\b[^.;!?]{0,50}\bquarterly-report_pdf\b(?:\s+file)?\s+there\b'
    )
    if (-not (
        $movesSourceToDocuments -or
        $movesSourceByExactArrow -or
        $createsDocumentsThenMovesThere
    )) {
        throw "Downloads plan did not propose moving quarterly-report.pdf into Documents: $Value"
    }
    if (-not [regex]::IsMatch(
        $semantic,
        '(?i)\b(?:leave|keep)\b\s+(?:the\s+)?\bmystery_download\b(?:\s+file)?\s+(?:in place|untouched)\b'
    )) {
        throw "Downloads plan did not explicitly leave mystery.download untouched: $Value"
    }
    if ([regex]::IsMatch(
        $normalized,
        '(?i)\b(?:Archives|Images|Audio|Video|Installers)\b'
    )) {
        throw "Downloads plan proposed an unexpected destination category: $Value"
    }
}

function Test-IsPathTokenCharacter {
    param([Parameter(Mandatory)][char] $Value)

    return [char]::IsLetterOrDigit($Value) -or '/\_.-:'.Contains([string] $Value)
}

function Test-TextContainsExactPath {
    param(
        [Parameter(Mandatory)][string] $Value,
        [Parameter(Mandatory)][string] $Path
    )

    $normalized = $Value.Replace('\', '/')
    $candidate = $Path.Replace('\', '/')
    $start = 0
    while ($start -le ($normalized.Length - $candidate.Length)) {
        $index = $normalized.IndexOf(
            $candidate,
            $start,
            [System.StringComparison]::OrdinalIgnoreCase
        )
        if ($index -lt 0) { return $false }
        $afterIndex = $index + $candidate.Length
        $beforeIsPath = $index -gt 0 -and
            (Test-IsPathTokenCharacter -Value $normalized[$index - 1])
        $afterIsPath = $afterIndex -lt $normalized.Length -and
            (Test-IsPathTokenCharacter -Value $normalized[$afterIndex])
        if (-not $beforeIsPath -and -not $afterIsPath) { return $true }
        $start = $index + 1
    }
    return $false
}

function Assert-TextContainsExactPaths {
    param(
        [Parameter(Mandatory)][string] $Value,
        [Parameter(Mandatory)][string[]] $Expected,
        [Parameter(Mandatory)][string] $Description
    )

    foreach ($path in $Expected) {
        if (-not (Test-TextContainsExactPath -Value $Value -Path $path)) {
            throw "$Description omitted exact path [$path]: $Value"
        }
    }
}

function Assert-DownloadsUndoSummary {
    param([Parameter(Mandatory)][string] $Value)

    Assert-TextContainsExactPaths -Value $Value -Expected @(
        'Documents/quarterly-report.pdf',
        'quarterly-report.pdf',
        'mystery.download'
    ) -Description 'Downloads undo summary'
    $normalized = [regex]::Replace($Value.Replace('\', '/'), '\s+', ' ').Trim()
    if ([regex]::IsMatch(
        $normalized,
        '(?i)\b(?:not|never|don.t|didn.t)\b[^.;!?]{0,24}\b(?:move(?:s|d|ing)?|restore(?:s|d|ing)?)\b'
    )) {
        throw "Downloads undo summary negated the reverse move: $Value"
    }
    if ([regex]::IsMatch(
        $normalized,
        '(?i)(?<![A-Za-z0-9/\\_.:-])quarterly-report\.pdf\s*(?:→|->)\s*Documents/quarterly-report\.pdf(?![A-Za-z0-9/\\_.:-])'
    )) {
        throw "Downloads undo summary reversed the required direction: $Value"
    }
    if ([regex]::IsMatch(
        $normalized,
        '(?i)(?<![A-Za-z0-9/\\_.:-])Documents/quarterly-report\.pdf\s*(?:→|->)\s*(?!quarterly-report\.pdf(?![A-Za-z0-9/\\_.:-]))'
    )) {
        throw "Downloads undo summary used the wrong restored destination: $Value"
    }
    if ([regex]::IsMatch(
        $normalized,
        '(?i)(?<![A-Za-z0-9/\\_.:-])Documents/quarterly-report\.pdf\s*(?:→|->)\s*quarterly-report\.pdf(?![A-Za-z0-9/\\_.:-])'
    )) { return }
    if ([regex]::IsMatch(
        $normalized,
        '(?i)\b(?:move(?:s|d|ing)?|restore(?:s|d|ing)?)\b[^.;!?]{0,40}\bDocuments/quarterly-report\.pdf\b\s*(?:back\s+)?(?:to|into)\s+(?:the\s+)?(?:root\s+(?:as\s+)?)?\bquarterly-report\.pdf\b'
    )) { return }
    throw "Downloads undo summary omitted the exact reverse-move relation: $Value"
}

if ($ValidateDownloadsPlanContractOnly) {
    foreach ($accepted in @(
        "I found 2 files. Proposed plan: Create 'Documents' folder and move quarterly-report.pdf there. Leave mystery.download in place.",
        'Move quarterly-report.pdf into Documents. Keep mystery.download untouched.',
        'Move quarterly-report.pdf into Documents. Do not move mystery.download; keep mystery.download untouched.',
        'Move quarterly-report.pdf → Documents/quarterly-report.pdf. Keep mystery.download untouched.'
    )) {
        Assert-DownloadsPlanProposal -Value $accepted
    }
    foreach ($rejected in @(
        'Move quarterly-report.pdf into Archives. Keep mystery.download untouched.',
        'Move quarterly-report.pdf into Documents. Review mystery.download later.',
        'Keep mystery.download untouched. Decide where quarterly-report.pdf belongs later.',
        'Do not move quarterly-report.pdf into Documents. Keep mystery.download untouched.',
        'Move quarterly-report.pdf nowhere; Documents is not appropriate. Leave mystery.download in place.',
        'Move quarterly-report.pdf into Documents. Do not keep mystery.download untouched; move it too.',
        'Move quarterly-report.pdf and mystery.download into Documents, but keep mystery.download untouched.',
        'Create Documents and move quarterly-report.pdf and mystery.download there. Keep mystery.download untouched.',
        'Move quarterly-report.pdf to Trash. Documents remains empty. Keep mystery.download untouched.',
        'Create Documents for later. Move quarterly-report.pdf to Trash and leave it there. Keep mystery.download untouched.',
        'Move quarterly-report.pdf to Trash and create Documents. Keep mystery.download untouched.',
        'Create Documents for later, then move quarterly-report.pdf to Trash and leave it there. Keep mystery.download untouched.'
    )) {
        $failedClosed = $false
        try {
            Assert-DownloadsPlanProposal -Value $rejected
        } catch {
            $failedClosed = $true
        }
        if (-not $failedClosed) {
            throw "Downloads plan contract accepted an unsafe fixture: $rejected"
        }
    }
    foreach ($acceptedUndo in @(
        'Moved Documents/quarterly-report.pdf back to root as quarterly-report.pdf; mystery.download untouched.',
        'Documents/quarterly-report.pdf → quarterly-report.pdf, mystery.download',
        'Moved Documents/quarterly-report.pdf to quarterly-report.pdf; mystery.download unchanged.',
        'Restored Documents/quarterly-report.pdf to quarterly-report.pdf; mystery.download unchanged.'
    )) {
        Assert-DownloadsUndoSummary -Value $acceptedUndo
    }
    foreach ($rejectedUndo in @(
        'Documents/quarterly-report.pdf, mystery.download',
        'Documents/quarterly-report.pdf and quarterly-report.pdf, mystery.download',
        'quarterly-report.pdf → Documents/quarterly-report.pdf, mystery.download',
        'Documents/quarterly-report.pdf → quarterly-report.pdf.bak, quarterly-report.pdf, mystery.download',
        'Restored quarterly-report.pdf → Documents/quarterly-report.pdf; Documents/quarterly-report.pdf, mystery.download',
        'Restored Documents/quarterly-report.pdf → quarterly-report.pdf.bak; quarterly-report.pdf, mystery.download',
        'Documents/quarterly-report.pdf is not back at quarterly-report.pdf; mystery.download',
        'Did not move Documents/quarterly-report.pdf to quarterly-report.pdf; mystery.download'
    )) {
        $failedClosed = $false
        try {
            Assert-DownloadsUndoSummary -Value $rejectedUndo
        } catch {
            $failedClosed = $true
        }
        if (-not $failedClosed) {
            throw "Downloads undo-summary contract accepted an unsafe fixture: $rejectedUndo"
        }
    }
    Write-Host 'Downloads plan semantic contract passed.'
    exit 0
}

. (Join-Path $PSScriptRoot 'windows-network-audit.ps1')

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
$cleanupHelperPath = Join-Path $installRoot 'resources/stop-yorebot-owned-processes.ps1'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\YoreBot'
$downloadsKnownFolderId = '{374DE290-123F-4565-9164-39C4925E467B}'
$downloadsUserShellFoldersSubKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
$dataRoot = Join-Path $env:APPDATA 'YoreBot/data'
$configRoot = Join-Path $env:APPDATA 'app.yorebot.desktop'
$webViewRoot = Join-Path $env:LOCALAPPDATA 'app.yorebot.desktop'
$modelId = 'Qwen3.5-9B-Q4_K_M'
$modelRevision = '3885219b6810b007914f3a7950a8d1b469d598a5'
$modelSize = [int64]5680522464
$modelSha256 = '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'
$modelSource = Get-Content (Join-Path $projectRoot 'web-app/src/constants/yorebot-models.ts') -Raw
$ownedSentinels = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$appProcess = $null
$serverProcess = $null
$cdpSocket = $null
$networkAudit = $null
$appStdoutPath = ''
$appStderrPath = ''
$cdpPort = 9229
$createdWorkRoot = $false
$installed = $false
$passed = $false
$downloadsRoot = ''
$createdDownloadsRoot = $false
$downloadsRegistration = $null
$downloadsRegistrationRedirected = $false
$downloadsRestoreError = $null
$downloadsFixtureActive = $false
$script:CaptureCdpNetwork = $false
$script:CdpNetworkEvents = [System.Collections.Generic.List[object]]::new()

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

function Get-ComparableWindowsPath {
    param([Parameter(Mandatory)][string] $Value)

    $path = [System.IO.Path]::GetFullPath($Value)
    if ($path.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $path = '\\' + $path.Substring(8)
    } elseif ($path.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $path = $path.Substring(4)
    }
    return $path.TrimEnd([char]92)
}

function Get-WindowsDownloadsPath {
    $userShellFolders = "HKCU:\$downloadsUserShellFoldersSubKey"
    $raw = Get-ItemPropertyValue `
        -LiteralPath $userShellFolders `
        -Name $downloadsKnownFolderId `
        -ErrorAction Stop
    $expanded = [Environment]::ExpandEnvironmentVariables([string]$raw)
    if ([string]::IsNullOrWhiteSpace($expanded)) {
        throw 'The operating system Downloads folder is unavailable'
    }
    return [System.IO.Path]::GetFullPath($expanded).TrimEnd([char]92)
}

function Get-WindowsDownloadsRegistration {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
        $downloadsUserShellFoldersSubKey,
        $false
    )
    if ($null -eq $key) {
        throw 'The operating system Downloads registration is unavailable'
    }
    try {
        $value = $key.GetValue(
            $downloadsKnownFolderId,
            $null,
            [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
        )
        if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
            throw 'The operating system Downloads registration is unavailable'
        }
        $kind = $key.GetValueKind($downloadsKnownFolderId)
        if ($kind -notin @(
            [Microsoft.Win32.RegistryValueKind]::String,
            [Microsoft.Win32.RegistryValueKind]::ExpandString
        )) {
            throw "The operating system Downloads registration has unsupported type: $kind"
        }
        return [pscustomobject]@{
            Value = [string]$value
            Kind = $kind
        }
    } finally {
        $key.Dispose()
    }
}

function Set-WindowsDownloadsRegistration {
    param(
        [Parameter(Mandatory)][string] $Value,
        [Parameter(Mandatory)][Microsoft.Win32.RegistryValueKind] $Kind
    )

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
        $downloadsUserShellFoldersSubKey,
        $true
    )
    if ($null -eq $key) {
        throw 'The operating system Downloads registration is unavailable'
    }
    try {
        $key.SetValue($downloadsKnownFolderId, $Value, $Kind)
    } finally {
        $key.Dispose()
    }
}

function Get-DownloadsSnapshot {
    param([Parameter(Mandatory)][string] $Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "Downloads snapshot root is missing: $Root"
    }
    $entries = @(
        Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop |
            Sort-Object FullName |
            ForEach-Object {
                if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Downloads fixture contains an unsupported reparse point: $($_.FullName)"
                }
                $relative = [System.IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
                if ($_.PSIsContainer) {
                    [ordered]@{ path = $relative; kind = 'directory' }
                } else {
                    [ordered]@{
                        path = $relative
                        kind = 'file'
                        size = [int64]$_.Length
                        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                    }
                }
            }
    )
    if ($entries.Count -gt 16) {
        throw "Downloads fixture exceeded the bounded 16-entry acceptance inventory: $($entries.Count)"
    }
    return ConvertTo-Json -InputObject @($entries) -Depth 4 -Compress
}

function Assert-ExactDownloadsPaths {
    param(
        [Parameter(Mandatory)][string] $Root,
        [Parameter(Mandatory)][string[]] $Expected
    )

    $actual = @(
        Get-ChildItem -LiteralPath $Root -Force -Recurse -ErrorAction Stop |
            ForEach-Object {
                [System.IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')
            } |
            Sort-Object
    )
    $expectedSorted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($expectedSorted -join "`n")) {
        throw "Downloads disk state changed: expected=[$($expectedSorted -join ',')] actual=[$($actual -join ',')]"
    }
}

function Assert-DownloadsSentinel {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)][string] $Value)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Downloads sentinel is missing: $Path"
    }
    if ((Get-Content -LiteralPath $Path -Raw) -cne $Value) {
        throw "Downloads sentinel content changed: $Path"
    }
}

function Assert-TextContainsAny {
    param(
        [Parameter(Mandatory)][string] $Value,
        [Parameter(Mandatory)][string[]] $Expected,
        [Parameter(Mandatory)][string] $Description
    )

    $normalized = $Value.Replace('\', '/')
    foreach ($term in $Expected) {
        if ($normalized.IndexOf($term, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return
        }
    }
    throw "$Description omitted every required outcome term [$($Expected -join ',')]: $Value"
}

function Remove-DownloadsFixture {
    param([Parameter(Mandatory)][string] $Root)

    foreach ($path in @(
        (Join-Path $Root 'quarterly-report.pdf'),
        (Join-Path $Root 'mystery.download'),
        (Join-Path $Root 'Documents/quarterly-report.pdf')
    )) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
        }
    }
    $documents = Join-Path $Root 'Documents'
    if (Test-Path -LiteralPath $documents -PathType Container) {
        $remaining = @(Get-ChildItem -LiteralPath $documents -Force -ErrorAction Stop)
        if ($remaining.Count -ne 0) {
            throw 'Refusing to remove a nonempty Downloads/Documents fixture folder'
        }
        Remove-Item -LiteralPath $documents -Force
    }
    if ((Get-DownloadsSnapshot -Root $Root) -cne '[]') {
        throw 'Downloads did not return to its empty pre-test state'
    }
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

function Get-YoreBotWebViewProcesses {
    param([System.Diagnostics.Process] $Process)

    $all = @(
        Get-CimInstance Win32_Process `
            -Filter "Name = 'msedgewebview2.exe'" `
            -ErrorAction Stop
    )
    $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($candidate in $all) {
        $idProperty = $candidate.PSObject.Properties['ProcessId']
        $parentProperty = $candidate.PSObject.Properties['ParentProcessId']
        $commandProperty = $candidate.PSObject.Properties['CommandLine']
        if ($null -eq $idProperty) { continue }
        $commandLine = if ($null -ne $commandProperty) {
            [string]$commandProperty.Value
        } else {
            ''
        }
        if (($null -ne $parentProperty -and [int]$parentProperty.Value -eq $Process.Id) -or
            $commandLine.IndexOf(
                $webViewRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0 -or
            $commandLine.IndexOf(
                'app.yorebot.desktop',
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0) {
            [void]$ownedIds.Add([int]$idProperty.Value)
        }
    }
    do {
        $changed = $false
        foreach ($candidate in $all) {
            $idProperty = $candidate.PSObject.Properties['ProcessId']
            $parentProperty = $candidate.PSObject.Properties['ParentProcessId']
            if ($null -eq $idProperty -or $null -eq $parentProperty) { continue }
            if ($ownedIds.Contains([int]$parentProperty.Value) -and
                $ownedIds.Add([int]$idProperty.Value)) {
                $changed = $true
            }
        }
    } while ($changed)
    return @($all | Where-Object {
        $idProperty = $_.PSObject.Properties['ProcessId']
        $null -ne $idProperty -and $ownedIds.Contains([int]$idProperty.Value)
    })
}

function Write-WebViewDiagnostics {
    param([int] $Port, [System.Diagnostics.Process] $Process)

    Write-Host "WebView2 diagnostics: expected_port=$Port app_pid=$($Process.Id)"
    $webViewProcesses = @(Get-YoreBotWebViewProcesses -Process $Process | Select-Object -First 20)
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

function Add-CdpNetworkEvent {
    param([Parameter(Mandatory)] $Message)

    if (-not $script:CaptureCdpNetwork) { return }
    $methodProperty = $Message.PSObject.Properties['method']
    $paramsProperty = $Message.PSObject.Properties['params']
    if ($null -eq $methodProperty -or $null -eq $paramsProperty) { return }
    $method = [string]$methodProperty.Value
    if ($method -notin @(
        'Network.requestWillBeSent',
        'Network.webSocketCreated',
        'Network.webTransportCreated'
    )) {
        return
    }
    $params = $paramsProperty.Value
    $url = $null
    if ($method -eq 'Network.requestWillBeSent') {
        $requestProperty = $params.PSObject.Properties['request']
        if ($null -ne $requestProperty) {
            $urlProperty = $requestProperty.Value.PSObject.Properties['url']
            if ($null -ne $urlProperty) { $url = $urlProperty.Value }
        }
    } else {
        $urlProperty = $params.PSObject.Properties['url']
        if ($null -ne $urlProperty) { $url = $urlProperty.Value }
    }
    $script:CdpNetworkEvents.Add([pscustomobject]@{
        Method = $method
        Url = if ($null -eq $url) { '' } else { [string]$url }
    })
}

function Test-CdpNetworkUrlIsLocal {
    param([string] $Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    try { $uri = [Uri]$Value } catch { return $false }
    if (-not $uri.IsAbsoluteUri) { return $false }
    if ($uri.Scheme -eq 'file') {
        return -not $uri.IsUnc
    }
    if ($uri.Scheme -in @('data', 'blob', 'about', 'tauri', 'asset')) {
        return $true
    }
    if ($uri.Scheme -notin @('http', 'https', 'ws', 'wss')) { return $false }
    if ($uri.Host -ieq 'ipc.localhost') {
        return $uri.Scheme -eq 'http' -and $uri.Port -eq 80
    }
    if ($uri.Host -iin @('localhost', 'tauri.localhost', 'asset.localhost')) {
        return $true
    }
    [System.Net.IPAddress] $address = $null
    return [System.Net.IPAddress]::TryParse($uri.Host, [ref]$address) -and
        [System.Net.IPAddress]::IsLoopback($address)
}

function Get-CdpNetworkUriDiagnostic {
    param([object] $Value)

    try {
        $uri = [Uri]([string]$Value)
        if (-not $uri.IsAbsoluteUri) { return '<invalid>' }
        return Get-BoundedCdpText -Value "$($uri.Scheme)://$($uri.Host):$($uri.Port)"
    } catch {
        return '<invalid>'
    }
}

function Assert-CdpNetworkAudit {
    if (-not $script:CaptureCdpNetwork) {
        throw 'WebView2 network observation ended before assertion'
    }
    $healthRequests = @(
        $script:CdpNetworkEvents | Where-Object {
            if ($_.Method -ne 'Network.requestWillBeSent') { return $false }
            try { $uri = [Uri]$_.Url } catch { return $false }
            if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'http' -or
                $uri.AbsolutePath -cne '/health') {
                return $false
            }
            return $uri.Host -ieq 'localhost' -or
                (Test-YoreBotLoopbackAddress -Address $uri.Host)
        }
    )
    if ($healthRequests.Count -eq 0) {
        throw 'WebView2 Network sensor did not observe the expected loopback health request'
    }
    $violations = @(
        $script:CdpNetworkEvents |
            Where-Object { -not (Test-CdpNetworkUrlIsLocal -Value $_.Url) }
    )
    if ($violations.Count -gt 0) {
        foreach ($violation in @($violations | Select-Object -First 20)) {
            Write-Host "WebView2 network-audit violation: method=$($violation.Method) destination=$(Get-CdpNetworkUriDiagnostic -Value $violation.Url)"
        }
        throw "Non-loopback WebView2 content attempt detected for $($violations.Count) request(s)"
    }
    Write-Host "YoreBot WebView2 network audit passed: observed_requests=$($script:CdpNetworkEvents.Count) non_loopback_attempts=0 result=pass"
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
        Add-CdpNetworkEvent -Message $message
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
    [void] $Socket.SendAsync(
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

function Get-BoundedCdpText {
    param([object] $Value, [int] $Limit = 120)

    if ($null -eq $Value) { return '<missing>' }
    $text = [regex]::Replace([string]$Value, '[\x00-\x1f\x7f]', '?')
    if ($text.Length -gt $Limit) { return $text.Substring(0, $Limit) }
    return $text
}

function Get-CdpUriDiagnostic {
    param([object] $Value)

    try {
        $uri = [Uri]([string]$Value)
        return Get-BoundedCdpText -Value "$($uri.Scheme)://$($uri.Host):$($uri.Port)$($uri.AbsolutePath)"
    } catch {
        return '<invalid>'
    }
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
            $response = Invoke-RestMethod `
                -Uri "http://127.0.0.1:$Port/json/list" `
                -NoProxy `
                -TimeoutSec 3
            $targets = @(
                foreach ($entry in $response) { $entry }
            )
        } catch {
            $lastEndpointError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
            continue
        }

        $targetDescriptions = @($targets | ForEach-Object {
            $typeProperty = $_.PSObject.Properties['type']
            $titleProperty = $_.PSObject.Properties['title']
            $urlProperty = $_.PSObject.Properties['url']
            $socketProperty = $_.PSObject.Properties['webSocketDebuggerUrl']
            $typeValue = if ($null -eq $typeProperty) { $null } else { $typeProperty.Value }
            $titleValue = if ($null -eq $titleProperty) { $null } else { $titleProperty.Value }
            $urlValue = if ($null -eq $urlProperty) { $null } else { $urlProperty.Value }
            $socketValue = if ($null -eq $socketProperty) { $null } else { $socketProperty.Value }
            "type=$(Get-BoundedCdpText -Value $typeValue),title=$(Get-BoundedCdpText -Value $titleValue),url=$(Get-CdpUriDiagnostic -Value $urlValue),websocket=$(Get-CdpUriDiagnostic -Value $socketValue)"
        })
        $lastTargetDiagnostic = "target_count=$($targets.Count) targets=[$($targetDescriptions -join '|')]"

        $eligibleTargets = @($targets | Where-Object {
            $typeProperty = $_.PSObject.Properties['type']
            $titleProperty = $_.PSObject.Properties['title']
            $urlProperty = $_.PSObject.Properties['url']
            $socketProperty = $_.PSObject.Properties['webSocketDebuggerUrl']
            $isExpectedType = $null -ne $typeProperty -and
                @('page', 'webview') -contains $typeProperty.Value
            $isYoreBotTitle = $null -ne $titleProperty -and
                $titleProperty.Value -ceq 'YoreBot'
            if ($null -eq $typeProperty -or
                $null -eq $titleProperty -or
                $null -eq $urlProperty -or
                $null -eq $socketProperty -or
                -not $isExpectedType -or
                -not $isYoreBotTitle -or
                [string]::IsNullOrWhiteSpace($urlProperty.Value) -or
                [string]::IsNullOrWhiteSpace($socketProperty.Value)) {
                return $false
            }
            try {
                $documentUri = [Uri]([string]$urlProperty.Value)
                $isTauriOrigin = (
                    $documentUri.Scheme -eq 'tauri' -and
                    $documentUri.Host -ieq 'localhost' -and
                    $documentUri.IsDefaultPort
                ) -or (
                    $documentUri.Scheme -eq 'http' -and
                    $documentUri.IsDefaultPort -and (
                        $documentUri.Host -ieq 'tauri.localhost' -or
                        $documentUri.Host -ieq 'asset.localhost'
                    )
                )
                return $isTauriOrigin -and [string]::IsNullOrEmpty($documentUri.UserInfo)
            } catch {
                return $false
            }
        })
        $target = $eligibleTargets | Select-Object -First 1
        if ($eligibleTargets.Count -ne 1) {
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
            [void] $socket.ConnectAsync(
                $uri,
                [System.Threading.CancellationToken]::None
            ).GetAwaiter().GetResult()
            Write-Host "WebView2 selected target: $lastTargetDiagnostic"
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

function Invoke-YoreBotAgentTurn {
    param(
        [Parameter(Mandatory)][System.Net.WebSockets.ClientWebSocket] $Socket,
        [Parameter(Mandatory)][System.Diagnostics.Process] $AppProcess,
        [Parameter(Mandatory)][System.Diagnostics.Process] $ServerProcess,
        [Parameter(Mandatory)][string] $Prompt,
        [string[]] $ExpectedApprovalPreviews = @(),
        [string[]] $ApprovalDecisions = @(),
        [switch] $UseExistingPrompt,
        [int] $TimeoutMinutes = 20
    )

    if ($ExpectedApprovalPreviews.Count -ne $ApprovalDecisions.Count) {
        throw 'Every expected approval preview needs one decision'
    }
    foreach ($decision in $ApprovalDecisions) {
        if ($decision -notin @('Approve once', 'Deny')) {
            throw "Unsupported UI approval decision: $decision"
        }
    }

    $promptJson = ConvertTo-Json -InputObject $Prompt -Compress
    $baselineJson = Invoke-CdpExpression -Socket $Socket -Expression @'
JSON.stringify({
  users: document.querySelectorAll('[aria-label="Your message"]').length,
  replies: document.querySelectorAll('[aria-label="YoreBot response"]').length,
})
'@
    $baseline = $baselineJson | ConvertFrom-Json

    if ($UseExistingPrompt) {
        $actualPrompt = Invoke-CdpExpression -Socket $Socket -Expression @'
document.querySelector('[data-testid="chat-input"]')?.value ?? ''
'@
        if ($actualPrompt -cne $Prompt) {
            throw 'The actual Downloads suggestion did not fill its product prompt'
        }
    } else {
        $actualPrompt = Invoke-CdpExpression -Socket $Socket -Expression @"
(() => {
  const input = document.querySelector('[data-testid="chat-input"]');
  if (!(input instanceof HTMLTextAreaElement)) return '';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, $promptJson);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value;
})()
"@
        if ($actualPrompt -cne $Prompt) {
            throw 'The actual Agent input did not accept the required prompt'
        }
    }

    $sendReadyDeadline = [DateTime]::UtcNow.AddSeconds(30)
    $sendReady = $false
    do {
        $sendReady = Invoke-CdpExpression -Socket $Socket -Expression @'
(() => {
  const button = document.querySelector('[aria-label="Send message"]');
  return button instanceof HTMLButtonElement && !button.disabled;
})()
'@
        if ($sendReady) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $sendReadyDeadline)
    if (-not $sendReady) { throw 'The actual Agent send control did not become ready' }

    $clicked = Invoke-CdpExpression -Socket $Socket -Expression @'
(() => {
  const button = document.querySelector('[aria-label="Send message"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()
'@
    if (-not $clicked) { throw 'The actual Agent send control could not be invoked' }

    $approvalIndex = 0
    $deadline = [DateTime]::UtcNow.AddMinutes($TimeoutMinutes)
    do {
        $AppProcess.Refresh()
        $ServerProcess.Refresh()
        if ($AppProcess.HasExited -or $ServerProcess.HasExited) {
            throw 'YoreBot or its exact local model exited during the Downloads task'
        }

        $stateJson = Invoke-CdpExpression -Socket $Socket -Expression @"
JSON.stringify((() => {
  const users = [...document.querySelectorAll('[aria-label="Your message"]')];
  const replies = [...document.querySelectorAll('[aria-label="YoreBot response"]')];
  const newest = replies.length > $([int]$baseline.replies) ? replies.at(-1) : null;
  const dialog = [...document.querySelectorAll('[role="dialog"]')]
    .find((candidate) => candidate.innerText.includes('Agent approval required')) ?? null;
  const buttons = dialog ? [...dialog.querySelectorAll('button')] : [];
  return {
    userObserved: users.length > $([int]$baseline.users) &&
      users.slice($([int]$baseline.users)).some((message) => message.innerText.includes($promptJson)),
    replyCount: replies.length,
    reply: newest
      ? [...newest.querySelectorAll('[aria-label="YoreBot reply text"]')]
          .map((part) => part.innerText).join('\n')
      : '',
    complete: document.querySelector('[aria-label="Send message"]') instanceof HTMLButtonElement,
    error: Boolean(newest?.querySelector('[aria-label="Agent run error"]')?.innerText.trim()) ||
      Boolean(document.querySelector('[aria-label="Chat generation error"]')?.innerText.trim()),
    approval: Boolean(dialog),
    preview: dialog?.querySelector('pre')?.innerText.trim() ?? '',
    approveOnce: buttons.some((button) => button.innerText.trim() === 'Approve once' && !button.disabled),
    deny: buttons.some((button) => button.innerText.trim() === 'Deny' && !button.disabled),
  };
})())
"@
        $state = $stateJson | ConvertFrom-Json
        if ($state.error) {
            throw 'Actual Agent UI reported an error during the Downloads task'
        }
        if ($state.approval) {
            if (-not $state.userObserved) {
                throw 'An Agent approval appeared before the user request rendered'
            }
            if ($approvalIndex -ge $ExpectedApprovalPreviews.Count) {
                throw "Unexpected extra Agent approval: $($state.preview)"
            }
            $expectedPreview = $ExpectedApprovalPreviews[$approvalIndex]
            if ([string]$state.preview -cne $expectedPreview) {
                throw "Agent approval preview changed: expected=[$expectedPreview] actual=[$($state.preview)]"
            }
            $decision = $ApprovalDecisions[$approvalIndex]
            if (($decision -eq 'Approve once' -and -not $state.approveOnce) -or
                ($decision -eq 'Deny' -and -not $state.deny)) {
                throw "Agent approval did not expose the required visible decision: $decision"
            }
            $decisionJson = ConvertTo-Json -InputObject $decision -Compress
            $decisionClicked = Invoke-CdpExpression -Socket $Socket -Expression @"
(() => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')]
    .find((candidate) => candidate.innerText.includes('Agent approval required'));
  if (!dialog) return false;
  const buttons = [...dialog.querySelectorAll('button')]
    .filter((button) => button.innerText.trim() === $decisionJson && !button.disabled);
  if (buttons.length !== 1) return false;
  buttons[0].click();
  return true;
})()
"@
            if (-not $decisionClicked) {
                throw "Could not invoke the visible Agent decision: $decision"
            }
            $approvalIndex += 1
            $approvalChangeDeadline = [DateTime]::UtcNow.AddSeconds(30)
            do {
                Start-Sleep -Milliseconds 250
                $currentPreview = Invoke-CdpExpression -Socket $Socket -Expression @'
([...document.querySelectorAll('[role="dialog"]')]
  .find((candidate) => candidate.innerText.includes('Agent approval required'))
  ?.querySelector('pre')?.innerText.trim()) ?? ''
'@
                if ($currentPreview -cne $expectedPreview) { break }
            } while ([DateTime]::UtcNow -lt $approvalChangeDeadline)
            if ($currentPreview -ceq $expectedPreview) {
                throw 'Agent approval did not resolve after the visible decision'
            }
            continue
        }
        if ($state.userObserved -and
            [int]$state.replyCount -gt [int]$baseline.replies -and
            $state.complete -and
            -not [string]::IsNullOrWhiteSpace([string]$state.reply)) {
            if ($approvalIndex -ne $ExpectedApprovalPreviews.Count) {
                throw "Agent completed after $approvalIndex of $($ExpectedApprovalPreviews.Count) required approvals"
            }
            return [string]$state.reply
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Actual Agent UI did not complete the Downloads task before the deadline'
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

    # The UI task must bind the operating system Downloads known folder. Point
    # that registration at an empty test-owned root before app startup, without
    # inspecting or mutating the runner's original Downloads contents.
    $downloadsRegistration = Get-WindowsDownloadsRegistration
    $downloadsRoot = Join-Path $workRootFull 'Downloads'
    New-Item -ItemType Directory -Path $downloadsRoot | Out-Null
    $createdDownloadsRoot = $true
    $downloadsRegistrationRedirected = $true
    Set-WindowsDownloadsRegistration `
        -Value $downloadsRoot `
        -Kind ([Microsoft.Win32.RegistryValueKind]::String)
    if ((Get-ComparableWindowsPath -Value (Get-WindowsDownloadsPath)) -ine
        (Get-ComparableWindowsPath -Value $downloadsRoot)) {
        throw 'The isolated Downloads registration did not resolve to the test-owned root'
    }

    # The manual-only installer embeds this loopback debugging port through a
    # temporary Tauri build overlay. Fail before install if it is unavailable.
    Assert-LoopbackPortAvailable -Port $cdpPort

    $install = Start-Process -FilePath $installer -ArgumentList @(
        '/S', "/D=$installRoot"
    ) -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
    $installed = $true
    foreach ($required in @($appPath, $uninstallerPath, $cleanupHelperPath)) {
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

    # All declared model/runtime downloads and exact integrity checks are now
    # complete. Audit and block every non-loopback product path before user
    # content enters Chat.
    $networkAudit = Start-YoreBotNetworkAudit `
        -WorkRoot $workRootFull `
        -Name 'YoreBot installed Chat privacy'
    Add-YoreBotNetworkAuditProgram `
        -State $networkAudit `
        -Path $appPath `
        -Role 'installed-app' | Out-Null
    Add-YoreBotNetworkAuditProgram `
        -State $networkAudit `
        -Path $serverPath `
        -Role 'owned-llama-server' | Out-Null
    Watch-YoreBotNetworkProcess `
        -State $networkAudit `
        -Process $appProcess `
        -Path $appPath `
        -Role 'installed-app'
    Watch-YoreBotNetworkProcess `
        -State $networkAudit `
        -Process $serverProcess `
        -Path $serverPath `
        -Role 'owned-llama-server'

    $webViewProcesses = @(Get-YoreBotWebViewProcesses -Process $appProcess)
    if ($webViewProcesses.Count -eq 0) {
        throw 'No YoreBot-owned WebView2 process exists for the network audit'
    }
    $ownedWebViewIds = @($webViewProcesses | ForEach-Object {
        [int]$_.PSObject.Properties['ProcessId'].Value
    })
    $webViewPaths = @($webViewProcesses | ForEach-Object {
        $pathProperty = $_.PSObject.Properties['ExecutablePath']
        if ($null -eq $pathProperty -or [string]::IsNullOrWhiteSpace($pathProperty.Value)) {
            throw 'YoreBot-owned WebView2 process has no executable path'
        }
        [System.IO.Path]::GetFullPath([string]$pathProperty.Value)
    } | Sort-Object -Unique)
    foreach ($webViewPath in $webViewPaths) {
        $unownedSamePath = @(
            Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction Stop |
                Where-Object {
                    $idProperty = $_.PSObject.Properties['ProcessId']
                    $pathProperty = $_.PSObject.Properties['ExecutablePath']
                    $null -ne $idProperty -and
                        $null -ne $pathProperty -and
                        [System.IO.Path]::GetFullPath([string]$pathProperty.Value) -ieq $webViewPath -and
                        $ownedWebViewIds -notcontains [int]$idProperty.Value
                }
        )
        if ($unownedSamePath.Count -gt 0) {
            throw 'Refusing to firewall a shared WebView2 executable with unrelated live processes'
        }
        Add-YoreBotNetworkAuditProgram `
            -State $networkAudit `
            -Path $webViewPath `
            -Role 'yorebot-webview2' | Out-Null
    }
    foreach ($candidate in $webViewProcesses) {
        $processId = [int]$candidate.PSObject.Properties['ProcessId'].Value
        $parentProperty = $candidate.PSObject.Properties['ParentProcessId']
        $commandProperty = $candidate.PSObject.Properties['CommandLine']
        $parentId = if ($null -eq $parentProperty) { 0 } else { [int]$parentProperty.Value }
        $commandLine = if ($null -eq $commandProperty) { '<missing>' } else {
            Get-BoundedCdpText -Value $commandProperty.Value -Limit 1200
        }
        $path = [System.IO.Path]::GetFullPath(
            [string]$candidate.PSObject.Properties['ExecutablePath'].Value
        )
        $process = Get-Process -Id $processId -ErrorAction Stop
        Watch-YoreBotNetworkProcess `
            -State $networkAudit `
            -Process $process `
            -Path $path `
            -Role 'yorebot-webview2' `
            -DiagnosticContext "parent=$parentId command_line=$commandLine"
    }
    $script:CdpNetworkEvents.Clear()
    $script:CaptureCdpNetwork = $true
    Invoke-CdpCommand -Socket $cdpSocket -Method 'Network.enable' | Out-Null

    $healthPort = [int]$listeners[0].LocalPort
    $webViewHealthOk = Invoke-CdpExpression -Socket $cdpSocket -Expression @"
fetch('http://127.0.0.1:$healthPort/health')
  .then((response) => response.ok)
  .catch(() => false)
"@
    if (-not $webViewHealthOk) {
        throw 'WebView2 loopback health calibration failed'
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

    $newChatClicked = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
(() => {
  const matches = [...document.querySelectorAll('button')]
    .filter((button) => button.innerText.trim() === 'New Chat');
  if (matches.length !== 1) return false;
  matches[0].click();
  return true;
})()
'@
    if (-not $newChatClicked) {
        throw 'The installed Chat did not expose its actual New Chat control'
    }
    $homeReady = $false
    $homeDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $homeReady = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
location.pathname === '/' &&
  document.querySelector('[data-testid="chat-input"]') instanceof HTMLTextAreaElement
'@
        if ($homeReady) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $homeDeadline)
    if (-not $homeReady) {
        throw 'The actual New Chat control did not return to the Home route'
    }

    Set-Content `
        -LiteralPath (Join-Path $downloadsRoot 'quarterly-report.pdf') `
        -Value 'REPORT_SENTINEL_481' `
        -NoNewline
    Set-Content `
        -LiteralPath (Join-Path $downloadsRoot 'mystery.download') `
        -Value 'UNCERTAIN_SENTINEL_927' `
        -NoNewline
    $downloadsFixtureActive = $true
    Assert-ExactDownloadsPaths -Root $downloadsRoot -Expected @(
        'mystery.download',
        'quarterly-report.pdf'
    )
    Assert-DownloadsSentinel `
        -Path (Join-Path $downloadsRoot 'quarterly-report.pdf') `
        -Value 'REPORT_SENTINEL_481'
    Assert-DownloadsSentinel `
        -Path (Join-Path $downloadsRoot 'mystery.download') `
        -Value 'UNCERTAIN_SENTINEL_927'
    $planSnapshot = Get-DownloadsSnapshot -Root $downloadsRoot

    $taskReady = $false
    $taskReadyDeadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $taskStateJson = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
JSON.stringify((() => {
  const agent = [...document.querySelectorAll('button')]
    .find((button) => button.innerText.trim() === 'Agent' && button.hasAttribute('aria-pressed'));
  if (agent && agent.getAttribute('aria-pressed') !== 'true' && !agent.disabled) agent.click();
  const task = [...document.querySelectorAll('button')]
    .find((button) => button.innerText.trim() === 'Organize my Downloads');
  return {
    agent: agent?.getAttribute('aria-pressed') === 'true',
    task: Boolean(task),
  };
})())
'@
        $taskState = $taskStateJson | ConvertFrom-Json
        if ($taskState.agent -and $taskState.task) {
            $taskReady = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $taskReadyDeadline)
    if (-not $taskReady) {
        throw 'The actual Agent mode did not expose Organize my Downloads'
    }

    $taskClicked = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
(() => {
  const matches = [...document.querySelectorAll('button')]
    .filter((button) => button.innerText.trim() === 'Organize my Downloads');
  if (matches.length !== 1) return false;
  matches[0].click();
  return true;
})()
'@
    if (-not $taskClicked) {
        throw 'The actual Organize my Downloads suggestion could not be invoked'
    }

    $downloadsPrompt = 'Organize my Downloads folder. First show me exactly what you propose. Move files only after I accept the plan and approve each move. Never delete or overwrite anything.'
    $taskBound = $false
    $taskBoundDeadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $taskBindingJson = Invoke-CdpExpression -Socket $cdpSocket -Expression @'
JSON.stringify((() => {
  let persisted = null;
  try { persisted = JSON.parse(localStorage.getItem('agent-mode') ?? 'null'); } catch {}
  const root = persisted?.state?.workspaces?.['temporary-chat']?.primaryRoot ?? null;
  return {
    prompt: document.querySelector('[data-testid="chat-input"]')?.value ?? '',
    skill: document.querySelector('[data-testid="agent-skill-inline-token"]')?.innerText ?? '',
    root,
  };
})())
'@
        $taskBinding = $taskBindingJson | ConvertFrom-Json
        if ($null -ne $taskBinding.root -and
            $taskBinding.prompt -ceq $downloadsPrompt -and
            $taskBinding.skill -ceq '/downloads-organizer') {
            $taskBound = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $taskBoundDeadline)
    if (-not $taskBound) {
        throw 'The actual Downloads suggestion did not bind its folder, prompt, and bundled skill'
    }
    $boundDownloadsRoot = [string]$taskBinding.root.path
    if ((Get-ComparableWindowsPath -Value $boundDownloadsRoot) -ine
        (Get-ComparableWindowsPath -Value $downloadsRoot)) {
        throw "The Downloads suggestion bound the wrong root: $boundDownloadsRoot"
    }
    if ($taskBinding.root.canEdit -ne $true) {
        throw 'The Downloads suggestion did not grant explicit edit access to its primary root'
    }
    if ([string]$taskBinding.root.name -cne 'Downloads') {
        throw "The Downloads suggestion exposed an unexpected root name: $($taskBinding.root.name)"
    }

    $planReply = Invoke-YoreBotAgentTurn `
        -Socket $cdpSocket `
        -AppProcess $appProcess `
        -ServerProcess $serverProcess `
        -Prompt $downloadsPrompt `
        -UseExistingPrompt
    if ((Get-DownloadsSnapshot -Root $downloadsRoot) -cne $planSnapshot) {
        throw 'The Downloads plan mutated disk before acceptance or approval'
    }
    Assert-DownloadsPlanProposal -Value $planReply

    $documentsPath = Join-Path $boundDownloadsRoot 'Documents'
    $reportPath = Join-Path $boundDownloadsRoot 'quarterly-report.pdf'
    $movedReportPath = Join-Path $documentsPath 'quarterly-report.pdf'
    $applyPrompt = 'I explicitly accept that exact proposal. Use only these relative paths: `quarterly-report.pdf`, `Documents`, and `Documents/quarterly-report.pdf`. Do not announce intentions or call `reply` before executing. Start by calling `os.fs.mkdir` exactly once for `Documents`; after it succeeds, call `os.fs.move` exactly once from `quarterly-report.pdf` to `Documents/quarterly-report.pdf`. Do not move `mystery.download`. After both accepted actions succeed, list `.` and `Documents`, then call `reply` with the exact moved and untouched paths.'
    $applyReply = Invoke-YoreBotAgentTurn `
        -Socket $cdpSocket `
        -AppProcess $appProcess `
        -ServerProcess $serverProcess `
        -Prompt $applyPrompt `
        -ExpectedApprovalPreviews @(
            "Create folder: $documentsPath",
            "Move: $reportPath → $movedReportPath"
        ) `
        -ApprovalDecisions @('Approve once', 'Approve once')
    Assert-ExactDownloadsPaths -Root $downloadsRoot -Expected @(
        'Documents',
        'Documents/quarterly-report.pdf',
        'mystery.download'
    )
    Assert-DownloadsSentinel `
        -Path (Join-Path $downloadsRoot 'Documents/quarterly-report.pdf') `
        -Value 'REPORT_SENTINEL_481'
    Assert-DownloadsSentinel `
        -Path (Join-Path $downloadsRoot 'mystery.download') `
        -Value 'UNCERTAIN_SENTINEL_927'
    Assert-TextContainsExactPaths -Value $applyReply -Expected @(
        'quarterly-report.pdf',
        'Documents/quarterly-report.pdf',
        'mystery.download'
    ) -Description 'Downloads apply summary'

    $undoPrompt = 'Undo the one successful move from this same session using only relative paths: move `Documents/quarterly-report.pdf` back to `quarterly-report.pdf`. Do not remove `Documents` or touch `mystery.download`. After the approved reverse move succeeds, list `.` and `Documents`, then reply with the exact reverse-move source `Documents/quarterly-report.pdf`, restored destination `quarterly-report.pdf`, and untouched path `mystery.download`.'
    $undoReply = Invoke-YoreBotAgentTurn `
        -Socket $cdpSocket `
        -AppProcess $appProcess `
        -ServerProcess $serverProcess `
        -Prompt $undoPrompt `
        -ExpectedApprovalPreviews @(
            "Move: $movedReportPath → $reportPath"
        ) `
        -ApprovalDecisions @('Approve once')
    Assert-ExactDownloadsPaths -Root $downloadsRoot -Expected @(
        'Documents',
        'mystery.download',
        'quarterly-report.pdf'
    )
    Assert-DownloadsSentinel `
        -Path (Join-Path $downloadsRoot 'quarterly-report.pdf') `
        -Value 'REPORT_SENTINEL_481'
    Assert-DownloadsSentinel `
        -Path (Join-Path $downloadsRoot 'mystery.download') `
        -Value 'UNCERTAIN_SENTINEL_927'
    Assert-DownloadsUndoSummary -Value $undoReply

    $deniedSnapshot = Get-DownloadsSnapshot -Root $downloadsRoot
    $denyPrompt = 'This exact plan was already reviewed and I explicitly accept it: move `quarterly-report.pdf` to `Documents/quarterly-report.pdf`. Do not announce intentions or call `reply` before executing. Your first call must be `os.fs.move` exactly once from `quarterly-report.pdf` to `Documents/quarterly-report.pdf`. The approval outcome is unknown. Only after observing the actual tool outcome may you call `reply`; never retry or create anything, and report that the move from `quarterly-report.pdf` to `Documents/quarterly-report.pdf` was denied.'
    $denyReply = Invoke-YoreBotAgentTurn `
        -Socket $cdpSocket `
        -AppProcess $appProcess `
        -ServerProcess $serverProcess `
        -Prompt $denyPrompt `
        -ExpectedApprovalPreviews @(
            "Move: $reportPath → $movedReportPath"
        ) `
        -ApprovalDecisions @('Deny')
    if ((Get-DownloadsSnapshot -Root $downloadsRoot) -cne $deniedSnapshot) {
        throw 'Deny changed the Downloads disk state'
    }
    Assert-TextContainsExactPaths -Value $denyReply -Expected @(
        'quarterly-report.pdf',
        'Documents/quarterly-report.pdf'
    ) -Description 'Downloads denial summary'
    Assert-TextContainsAny -Value $denyReply -Expected @(
        'denied',
        'declined',
        'not approved'
    ) -Description 'Downloads denial summary'

    Remove-DownloadsFixture -Root $downloadsRoot
    $downloadsFixtureActive = $false

    # Flush queued CDP events before closing the observation window.
    Start-Sleep -Seconds 1
    Invoke-CdpExpression -Socket $cdpSocket -Expression 'true' | Out-Null
    Assert-CdpNetworkAudit
    Assert-YoreBotNetworkAudit -State $networkAudit
    $script:CaptureCdpNetwork = $false

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
    $remainingOwnedServers = @(Get-ProcessesUnderRoot -Name 'llama-server' -Root $dataRoot)
    if (-not $serverProcess.HasExited -or $remainingOwnedServers.Count -ne 0) {
        $remainingSummary = @(
            $remainingOwnedServers | ForEach-Object {
                "pid=$($_.Id) path=$([System.IO.Path]::GetFullPath($_.Path))"
            }
        ) -join '; '
        Write-Host "Owned backend uninstall diagnostic: captured_pid=$($serverProcess.Id) captured_path=$serverPath data_root=$dataRoot captured_exited=$($serverProcess.HasExited) remaining=[$remainingSummary]"
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
    Write-Host "YoreBot installed first-use Chat and Downloads UI acceptance passed: model_id=$modelId model_revision=$modelRevision model_size_bytes=$modelSize model_sha256=$modelSha256 bundled_runtime=b10431/win-cpu-x64 active_runtime_build=10431 response_marker=present downloads_plan=unchanged approvals=4 apply=exact undo=exact deny=unchanged result=pass"
} catch {
    if ($null -ne $appProcess) {
        Write-FirstUseDiagnostics -StdoutPath $appStdoutPath -StderrPath $appStderrPath
    }
    throw
} finally {
    if ($downloadsRegistrationRedirected) {
        try {
            Set-WindowsDownloadsRegistration `
                -Value $downloadsRegistration.Value `
                -Kind $downloadsRegistration.Kind
            $restoredDownloadsRegistration = Get-WindowsDownloadsRegistration
            if ($restoredDownloadsRegistration.Value -cne $downloadsRegistration.Value -or
                $restoredDownloadsRegistration.Kind -ne $downloadsRegistration.Kind) {
                throw 'The original Downloads registration was not restored exactly'
            }
            $downloadsRegistrationRedirected = $false
        } catch {
            $downloadsRestoreError = $_
            Write-Warning 'The original Downloads registration could not be restored exactly'
        }
    }
    if ($null -ne $cdpSocket) { $cdpSocket.Dispose() }
    Stop-ExactProcesses -Path $appPath
    Stop-ProcessesUnderRoot -Name 'llama-server' -Root $dataRoot
    if ($null -ne $networkAudit) {
        Stop-YoreBotNetworkAudit -State $networkAudit
    }
    foreach ($sentinel in $ownedSentinels) {
        if (-not $sentinel.HasExited) {
            Stop-Process -Id $sentinel.Id -Force -ErrorAction SilentlyContinue
            $sentinel.WaitForExit(15000) | Out-Null
        }
    }
    if ($installed -and (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
        Start-Process -FilePath $uninstallerPath -ArgumentList '/S' -Wait | Out-Null
    }
    if ($downloadsFixtureActive -and
        -not [string]::IsNullOrWhiteSpace($downloadsRoot) -and
        (Test-Path -LiteralPath $downloadsRoot -PathType Container)) {
        try {
            Remove-DownloadsFixture -Root $downloadsRoot
        } catch {
            Write-Warning "Downloads fixture cleanup failed: $($_.Exception.Message)"
            if ($passed) { throw }
        }
    }
    if ($createdDownloadsRoot -and
        -not [string]::IsNullOrWhiteSpace($downloadsRoot) -and
        (Test-Path -LiteralPath $downloadsRoot -PathType Container)) {
        $remainingDownloads = @(Get-ChildItem -LiteralPath $downloadsRoot -Force)
        if ($remainingDownloads.Count -eq 0) {
            Remove-Item -LiteralPath $downloadsRoot -Force
        } elseif ($passed) {
            throw 'The test-created operating system Downloads folder is not empty after cleanup'
        }
    }
    if ($createdWorkRoot -and (Test-Path -LiteralPath $workRootFull)) {
        Remove-Item -LiteralPath $workRootFull -Recurse -Force
    }
    if (Test-Path -LiteralPath $dataSibling) {
        Remove-Item -LiteralPath $dataSibling -Recurse -Force
    }
    if (-not $passed -or $null -ne $downloadsRestoreError) {
        Write-Host 'YoreBot installed first-use Chat and Downloads UI acceptance failed.'
    }
    if ($null -ne $downloadsRestoreError) {
        throw $downloadsRestoreError.Exception
    }
}
